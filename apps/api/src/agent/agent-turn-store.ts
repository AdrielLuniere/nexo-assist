import type { AgentTurnResult } from '@nexo/agent';
import {
  type AgentDecision,
  type ConversationStatus,
  type Handoff,
  type Message,
  type MessageBlock,
  agentCanRespond,
  confidenceLevelOf,
} from '@nexo/shared';
import { type InMemoryWorld, appendInMemoryMessage, stripClientId } from '../conversations/conversation-repository.js';
import type { InMemoryDraftRepository } from '../drafts/draft-repository.js';
import { type ConversationRow, MESSAGE_INCLUDE, insertMessage, lockConversation, toContractDecision, toContractMessage } from '../conversations/message-writer.js';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { writeSlotsFor } from '../infra/write-slots.js';

/**
 * Persistência das respostas do agente.
 *
 * Publicar é UMA transação, com a conversa travada (mesma trava das mensagens do funcionário):
 * 1. confere dono e se a mensagem já foi respondida (idempotência: `triggerMessageId` é único);
 * 2. REVALIDA o estado: se a conversa saiu de WITH_AGENT durante a execução (transferida, assumida ou
 *    encerrada), ou se passou por qualquer transição desde que o histórico foi lido (a versão mudou: por
 *    exemplo transferida, assumida, devolvida e de novo com o agente), a resposta é descartada; o agente
 *    nunca fala depois da transferência nem responde a um contexto que já não vale;
 * 3. grava, juntos, rascunho (PENDING, substituindo o pendente anterior), transferência (conversa vai
 *    para WAITING_ANALYST), mensagem do agente e decisão.
 *
 * Como nada é gravado durante a execução do modelo, uma falha antes daqui não deixa efeito parcial, e
 * duas execuções da mesma resposta (retentativa, duas abas, dois processos) publicam no máximo uma vez.
 */

export interface TurnContext {
  readonly status: ConversationStatus;
  readonly version: number;
  /** Histórico em ordem, até a mensagem a responder (inclusive). */
  readonly history: Message[];
  /** Já respondida: mensagem e decisão publicadas antes. */
  readonly answered: { readonly message: Message; readonly decision: AgentDecision } | null;
}

export interface PublishInput {
  readonly employeeId: string;
  readonly conversationId: string;
  readonly triggerMessageId: string;
  /** Versão da conversa quando o histórico foi lido (`TurnContext.version`). */
  readonly expectedVersion: number;
  readonly result: AgentTurnResult;
  readonly now: Date;
}

export type PublishResult =
  | {
      readonly kind: 'published' | 'already_published';
      readonly message: Message;
      readonly decision: AgentDecision;
      readonly status: ConversationStatus;
      readonly version: number;
    }
  /** A conversa não está com o agente, ou mudou de estado durante a execução: nada foi gravado. */
  | { readonly kind: 'agent_paused'; readonly status: ConversationStatus; readonly version: number }
  | { readonly kind: 'not_found' };

export interface AgentTurnStore {
  /** `null` se a conversa não é do funcionário ou a mensagem não é dele nessa conversa. */
  load(employeeId: string, conversationId: string, triggerMessageId: string, historyLimit: number): Promise<TurnContext | null>;
  publish(input: PublishInput): Promise<PublishResult>;
}

type Tx = Prisma.TransactionClient;

const TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

/** Chave de idempotência da mensagem do agente (unicidade por conversa já existente). */
export const agentReplyKey = (triggerMessageId: string) => `agent-reply:${triggerMessageId}`;

async function ownTicketId(tx: Tx, employeeId: string, code: string): Promise<string | null> {
  const ticket = await tx.ticket.findFirst({ where: { code, requesterId: employeeId }, select: { id: true } });
  return ticket?.id ?? null;
}

async function findAnswer(tx: Tx | PrismaClient, triggerMessageId: string) {
  const decision = await tx.agentDecision.findUnique({ where: { triggerMessageId } });
  if (!decision?.messageId) return null;
  const message = await tx.message.findUnique({ where: { id: decision.messageId }, include: MESSAGE_INCLUDE });
  return message ? { message: toContractMessage(message), decision: toContractDecision(decision) } : null;
}

export function createPrismaAgentTurnStore(prisma: PrismaClient): AgentTurnStore {
  const slots = writeSlotsFor(prisma);

  return {
    async load(employeeId, conversationId, triggerMessageId, historyLimit) {
      const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, employeeId }, select: { status: true, version: true } });
      if (!conversation) return null;
      const trigger = await prisma.message.findFirst({ where: { id: triggerMessageId, conversationId, role: 'EMPLOYEE' } });
      if (!trigger) return null;
      const rows = await prisma.message.findMany({
        where: { conversationId, createdAt: { lte: trigger.createdAt } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: historyLimit,
        include: MESSAGE_INCLUDE,
      });
      return {
        status: conversation.status,
        version: conversation.version,
        history: rows.reverse().map(toContractMessage),
        answered: await findAnswer(prisma, triggerMessageId),
      };
    },

    async publish({ employeeId, conversationId, triggerMessageId, expectedVersion, result, now }) {
      return slots.run(() =>
        prisma.$transaction(async (tx): Promise<PublishResult> => {
          const conversation: ConversationRow | null = await lockConversation(tx, conversationId, employeeId);
          if (!conversation) return { kind: 'not_found' };

          const answered = await findAnswer(tx, triggerMessageId);
          if (answered) return { kind: 'already_published', ...answered, status: conversation.status, version: conversation.version };

          if (!agentCanRespond(conversation.status) || conversation.version !== expectedVersion) {
            return { kind: 'agent_paused', status: conversation.status, version: conversation.version };
          }

          const trigger = await tx.message.findFirst({ where: { id: triggerMessageId, conversationId, role: 'EMPLOYEE' }, select: { id: true } });
          if (!trigger) return { kind: 'not_found' };

          const blocks: MessageBlock[] = [...result.reply.blocks];
          const conversationUpdate: Prisma.ConversationUpdateInput = {};
          let status = conversation.status;
          let version = conversation.version;

          if (result.draft) {
            const payload = result.draft;
            // No máximo um rascunho pendente por conversa: o novo reflete o estado atual da conversa.
            await tx.ticketDraft.updateMany({ where: { conversationId, status: 'PENDING' }, data: { status: 'SUPERSEDED' } });
            const draft = await tx.ticketDraft.create({
              data: {
                conversationId,
                employeeId,
                operation: payload.operation,
                targetTicketId: payload.operation === 'CREATE' ? null : await ownTicketId(tx, employeeId, payload.ticketCode),
                payload: payload as unknown as Prisma.InputJsonValue,
                createdAt: now,
              },
            });
            blocks.push({
              type: 'draft',
              draft: {
                id: draft.id,
                conversationId,
                status: 'PENDING',
                payload,
                resultTicketCode: null,
                createdAt: draft.createdAt.toISOString(),
                confirmedAt: null,
              },
            });
          }

          if (result.handoff) {
            const { handoff: planned } = result;
            const handoff = await tx.handoff.create({
              data: {
                conversationId,
                reason: planned.reason,
                requestedBy: planned.requestedBy,
                summary: planned.summary,
                relatedTicketId: planned.relatedTicketCode ? await ownTicketId(tx, employeeId, planned.relatedTicketCode) : null,
                createdAt: now,
              },
            });
            blocks.push({ type: 'handoff_notice', handoffId: handoff.id, reason: planned.reason, relatedTicketCode: planned.relatedTicketCode });
            // A partir daqui o agente não responde mais nesta conversa até um analista devolvê-la.
            Object.assign(conversationUpdate, { status: 'WAITING_ANALYST', version: { increment: 1 } });
            status = 'WAITING_ANALYST';
            version += 1;
          }

          if (result.reply.quickReplies.length > 0) blocks.push({ type: 'quick_replies', options: result.reply.quickReplies });

          const messageRow = await insertMessage(
            tx,
            conversation,
            { role: 'AGENT', authorId: null, content: result.reply.text, blocks, clientMessageId: agentReplyKey(triggerMessageId) },
            now,
            conversationUpdate,
          );
          const { decision, telemetry } = result;
          const decisionRow = await tx.agentDecision.create({
            data: {
              conversationId,
              messageId: messageRow.id,
              triggerMessageId,
              intent: decision.intent,
              understanding: decision.understanding,
              action: decision.action,
              confidence: decision.confidence,
              rationale: decision.rationale,
              ruleRefs: decision.ruleRefs,
              steps: decision.steps as unknown as Prisma.InputJsonValue,
              model: telemetry.model,
              inputTokens: telemetry.inputTokens,
              outputTokens: telemetry.outputTokens,
              latencyMs: telemetry.latencyMs,
              createdAt: messageRow.createdAt,
            },
          });

          return {
            kind: 'published',
            message: toContractMessage({ ...messageRow, decision: { id: decisionRow.id } }),
            decision: toContractDecision(decisionRow),
            status,
            version,
          };
        }, TX_OPTIONS),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Em memória (testes de interface e de API sem banco)
// ---------------------------------------------------------------------------

/**
 * Mesma sequência da publicação no PostgreSQL (dono, já respondida, estado e versão, rascunho que
 * substitui o pendente, transferência, mensagem e decisão), sem `await` entre ler e gravar: equivale
 * à trava de linha. Só para testes; a implementação real é a do Prisma acima.
 */
export function createInMemoryAgentTurnStore(world: InMemoryWorld, drafts: InMemoryDraftRepository): AgentTurnStore {
  const answerOf = (conversationId: string, triggerMessageId: string) => {
    const decision = (world.decisions.get(conversationId) ?? []).find((d) => d.triggerMessageId === triggerMessageId);
    const message = decision ? (world.messages.get(conversationId) ?? []).find((m) => m.id === decision.messageId) : undefined;
    return decision && message ? { message: stripClientId(message), decision } : null;
  };
  const pendingDrafts = new Map<string, string>();

  return {
    async load(employeeId, conversationId, triggerMessageId, historyLimit) {
      const conversation = world.conversations.get(conversationId);
      if (!conversation || conversation.employeeId !== employeeId) return null;
      const all = world.messages.get(conversationId) ?? [];
      const index = all.findIndex((m) => m.id === triggerMessageId && m.role === 'EMPLOYEE');
      if (index < 0) return null;
      return {
        status: conversation.status,
        version: conversation.version,
        history: all.slice(Math.max(0, index + 1 - historyLimit), index + 1).map(stripClientId),
        answered: answerOf(conversationId, triggerMessageId),
      };
    },

    async publish({ employeeId, conversationId, triggerMessageId, expectedVersion, result, now }) {
      const conversation = world.conversations.get(conversationId);
      if (!conversation || conversation.employeeId !== employeeId) return { kind: 'not_found' };
      const answered = answerOf(conversationId, triggerMessageId);
      if (answered) return { kind: 'already_published', ...answered, status: conversation.status, version: conversation.version };
      if (!agentCanRespond(conversation.status) || conversation.version !== expectedVersion) {
        return { kind: 'agent_paused', status: conversation.status, version: conversation.version };
      }
      if (!(world.messages.get(conversationId) ?? []).some((m) => m.id === triggerMessageId && m.role === 'EMPLOYEE')) return { kind: 'not_found' };

      const blocks: MessageBlock[] = [...result.reply.blocks];
      let { status, version } = conversation;

      if (result.draft) {
        const previous = pendingDrafts.get(conversationId);
        if (previous) await drafts.transition(previous, 'PENDING', 'SUPERSEDED', now);
        const id = world.nextId('drf');
        drafts.addDraft({
          id,
          conversationId,
          employeeId,
          operation: result.draft.operation,
          payload: result.draft,
          status: 'PENDING',
          createdAt: now,
          conversationOwnerId: employeeId,
          conversationStatus: conversation.status,
        });
        pendingDrafts.set(conversationId, id);
        blocks.push({
          type: 'draft',
          draft: { id, conversationId, status: 'PENDING', payload: result.draft, resultTicketCode: null, createdAt: now.toISOString(), confirmedAt: null },
        });
      }

      if (result.handoff) {
        const handoff: Handoff = {
          id: world.nextId('hnd'),
          conversationId,
          reason: result.handoff.reason,
          status: 'WAITING',
          summary: result.handoff.summary,
          relatedTicketCode: result.handoff.relatedTicketCode,
          assumedById: null,
          createdAt: now.toISOString(),
          assumedAt: null,
          endedAt: null,
        };
        world.handoffs.set(conversationId, [...(world.handoffs.get(conversationId) ?? []), handoff]);
        blocks.push({ type: 'handoff_notice', handoffId: handoff.id, reason: handoff.reason, relatedTicketCode: handoff.relatedTicketCode });
        status = 'WAITING_ANALYST';
        version += 1;
      }

      if (result.reply.quickReplies.length > 0) blocks.push({ type: 'quick_replies', options: result.reply.quickReplies });

      const decisionId = world.nextId('dec');
      const { message, at } = appendInMemoryMessage(world, conversation, 'AGENT', null, result.reply.text, agentReplyKey(triggerMessageId), now, { blocks, decisionId });
      const { decision: d, telemetry } = result;
      const decision: AgentDecision = {
        id: decisionId,
        conversationId,
        messageId: message.id,
        triggerMessageId,
        intent: d.intent,
        understanding: d.understanding,
        action: d.action,
        confidence: d.confidence,
        confidenceLevel: confidenceLevelOf(d.confidence),
        rationale: d.rationale,
        ruleRefs: d.ruleRefs,
        steps: d.steps,
        model: telemetry.model,
        inputTokens: telemetry.inputTokens,
        outputTokens: telemetry.outputTokens,
        latencyMs: telemetry.latencyMs,
        createdAt: at.toISOString(),
      };
      world.decisions.set(conversationId, [...(world.decisions.get(conversationId) ?? []), decision]);
      world.answered.add(triggerMessageId);
      world.conversations.set(conversationId, { ...conversation, status, version, lastMessageAt: at, updatedAt: at });
      return { kind: 'published', message: stripClientId(message), decision, status, version };
    },
  };
}
