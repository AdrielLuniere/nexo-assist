import { type ConversationStatus, type Handoff, type Message, type User } from '@nexo/shared';
import { toHandoff } from '../console/console-repository.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { AppError } from '../http/app-error.js';
import { writeSlotsFor } from '../infra/write-slots.js';
import type { ConversationRecord, ConversationRepository, InMemoryWorld } from './conversation-repository.js';
import { toRecord } from './conversation-repository.js';
import { lockConversation } from './message-writer.js';
import type { ConversationEventBus } from './conversation-events.js';
import { toSummary } from './conversation-service.js';

/**
 * Pedido direto de analista pelo funcionário (`POST /api/conversations/:id/handoff`), sem passar pelo
 * agente nem pelo modelo. Usa a mesma trava de linha da conversa que mensagens, agente e console, então
 * a decisão e a gravação (transferência `WAITING` + conversa em `WAITING_ANALYST`, versão + 1) são
 * atômicas e serializadas com qualquer resposta do agente em andamento: se o agente publicar primeiro,
 * o pedido encontra a conversa já aguardando e devolve a transferência dele; se o pedido vier primeiro,
 * a versão muda e a publicação do agente é descartada.
 */

export type HandoffRequestOutcome =
  | { readonly kind: 'created' | 'existing'; readonly handoff: Handoff; readonly conversation: ConversationRecord }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid_state'; readonly status: ConversationStatus };

export interface HandoffRequestRepository {
  /** Só cria se a conversa é do funcionário e está `WITH_AGENT`; aguardando analista devolve a existente. */
  request(input: { employeeId: string; conversationId: string; summary: string; now: Date }): Promise<HandoffRequestOutcome>;
}

const TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

export function createPrismaHandoffRequestRepository(prisma: PrismaClient): HandoffRequestRepository {
  const slots = writeSlotsFor(prisma);
  return {
    request({ employeeId, conversationId, summary, now }) {
      return slots.run(() =>
        prisma.$transaction(async (tx): Promise<HandoffRequestOutcome> => {
          const conversation = await lockConversation(tx, conversationId, employeeId);
          if (!conversation) return { kind: 'not_found' };

          if (conversation.status === 'WAITING_ANALYST') {
            const row = await tx.handoff.findFirst({ where: { conversationId, status: 'WAITING' }, orderBy: { createdAt: 'desc' } });
            if (row) {
              const ticket = row.relatedTicketId ? await tx.ticket.findUnique({ where: { id: row.relatedTicketId }, select: { id: true, code: true } }) : null;
              return { kind: 'existing', handoff: toHandoff(row, new Map(ticket ? [[ticket.id, ticket.code]] : [])), conversation: toRecord(conversation) };
            }
          }
          if (conversation.status !== 'WITH_AGENT') return { kind: 'invalid_state', status: conversation.status };

          const row = await tx.handoff.create({
            data: { conversationId, reason: 'EMPLOYEE_REQUEST', requestedBy: 'EMPLOYEE', summary, createdAt: now },
          });
          const updated = await tx.conversation.update({
            where: { id: conversationId },
            data: { status: 'WAITING_ANALYST', version: { increment: 1 } },
          });
          return { kind: 'created', handoff: toHandoff(row, new Map()), conversation: toRecord(updated) };
        }, TX_OPTIONS),
      );
    },
  };
}

export function createInMemoryHandoffRequestRepository(world: InMemoryWorld): HandoffRequestRepository {
  return {
    // Sem `await` entre ler e gravar: equivale à trava de linha.
    async request({ employeeId, conversationId, summary, now }) {
      const conversation = world.conversations.get(conversationId);
      if (!conversation || conversation.employeeId !== employeeId) return { kind: 'not_found' };
      const list = world.handoffs.get(conversationId) ?? [];
      if (conversation.status === 'WAITING_ANALYST') {
        const existing = [...list].reverse().find((h) => h.status === 'WAITING');
        if (existing) return { kind: 'existing', handoff: existing, conversation };
      }
      if (conversation.status !== 'WITH_AGENT') return { kind: 'invalid_state', status: conversation.status };

      const handoff: Handoff = {
        id: world.nextId('hnd'),
        conversationId,
        reason: 'EMPLOYEE_REQUEST',
        status: 'WAITING',
        summary,
        relatedTicketCode: null,
        assumedById: null,
        createdAt: now.toISOString(),
        assumedAt: null,
        endedAt: null,
      };
      world.handoffs.set(conversationId, [...list, handoff]);
      const updated: ConversationRecord = { ...conversation, status: 'WAITING_ANALYST', version: conversation.version + 1, updatedAt: now };
      world.conversations.set(conversationId, updated);
      return { kind: 'created', handoff, conversation: updated };
    },
  };
}

const ROLE_LABELS: Record<Message['role'], string> = { EMPLOYEE: 'Funcionário', AGENT: 'Agente', ANALYST: 'Analista', SYSTEM: 'Sistema' };
const SNIPPET = 220;
const RECENT_MESSAGES = 6;
const MAX_SUMMARY = 2000;

/** Resumo para o analista a partir do histórico da própria conversa (nunca de dados de terceiros). */
export function buildHandoffSummary(messages: readonly Message[], note?: string): string {
  const clip = (text: string) => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= SNIPPET ? flat : `${flat.slice(0, SNIPPET - 1).trimEnd()}…`;
  };
  const lines = ['O funcionário pediu para falar com um analista.'];
  if (note) lines.push(`Observação do funcionário: ${clip(note)}`);
  const recent = messages.filter((m) => m.role !== 'SYSTEM' && m.content.trim() !== '').slice(-RECENT_MESSAGES);
  if (recent.length === 0) lines.push('A conversa ainda não tem mensagens.');
  else {
    lines.push('Últimas mensagens:');
    for (const m of recent) lines.push(`- ${ROLE_LABELS[m.role]}: ${clip(m.content)}`);
  }
  const ticketCodes = [...new Set(messages.flatMap((m) => m.blocks.flatMap((b) => (b.type === 'ticket_cards' ? b.tickets.map((t) => t.code) : []))))];
  if (ticketCodes.length > 0) lines.push(`Chamados citados na conversa: ${ticketCodes.slice(0, 5).join(', ')}.`);
  return lines.join('\n').slice(0, MAX_SUMMARY);
}

export interface HandoffRequestService {
  request(user: User, conversationId: string, input: { note?: string | undefined }): Promise<{ created: boolean; handoff: Handoff; conversation: ReturnType<typeof toSummary> }>;
}

export function createHandoffRequestService(deps: {
  readonly handoffs: HandoffRequestRepository;
  readonly conversations: ConversationRepository;
  /** Avisa quem acompanha a conversa (outras abas) da mudança de estado. */
  readonly events?: ConversationEventBus;
  readonly now?: () => Date;
}): HandoffRequestService {
  const now = deps.now ?? (() => new Date());
  return {
    async request(user, conversationId, input) {
      // Dono verificado antes de ler o histórico; a decisão final é reconferida sob trava.
      const owned = await deps.conversations.find(user.id, conversationId);
      if (!owned) throw new AppError('NOT_FOUND', 'Conversa não encontrada.');
      const summary = buildHandoffSummary(await deps.conversations.messages(owned.id), input.note);

      const outcome = await deps.handoffs.request({ employeeId: user.id, conversationId, summary, now: now() });
      switch (outcome.kind) {
        case 'not_found':
          throw new AppError('NOT_FOUND', 'Conversa não encontrada.');
        case 'invalid_state':
          throw new AppError(
            'INVALID_STATE_TRANSITION',
            outcome.status === 'CLOSED' ? 'A conversa está encerrada. Inicie uma nova conversa.' : 'Um analista já está atendendo esta conversa.',
            { status: outcome.status },
          );
        default:
          if (outcome.kind === 'created') {
            deps.events?.publish(conversationId, { event: 'conversation.status', data: { status: outcome.conversation.status, version: outcome.conversation.version } });
          }
          return { created: outcome.kind === 'created', handoff: outcome.handoff, conversation: toSummary(outcome.conversation) };
      }
    },
  };
}
