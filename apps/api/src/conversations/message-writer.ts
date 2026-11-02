import { type AgentDecision, AgentStepSchema, type Message, MessageBlockSchema, confidenceLevelOf } from '@nexo/shared';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';

/**
 * Escrita de mensagens no PostgreSQL. Todo `INSERT` em `messages` passa por aqui, dentro de uma
 * transação que antes trava a linha da conversa (`SELECT ... FOR UPDATE`). Isso serializa as escritas
 * de uma mesma conversa e permite garantir ordenação estável e contadores corretos.
 */

const BlocksSchema = z.array(MessageBlockSchema);
const StepsSchema = z.array(AgentStepSchema);

type Tx = Prisma.TransactionClient;
export type ConversationRow = Prisma.ConversationGetPayload<object>;
type MessageRow = Prisma.MessageGetPayload<{ include: { decision: { select: { id: true } } } }>;
type DecisionRow = Prisma.AgentDecisionGetPayload<object>;

export const MESSAGE_INCLUDE = { decision: { select: { id: true } } } as const;

/** Converte a linha do banco no contrato. Blocos inválidos (dado corrompido) não derrubam a conversa. */
export function toContractMessage(row: Omit<MessageRow, 'clientMessageId'> & { clientMessageId?: string | null }): Message {
  const blocks = BlocksSchema.safeParse(row.blocks);
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    authorId: row.authorId,
    content: row.content,
    blocks: blocks.success ? blocks.data : [],
    decisionId: row.decision?.id ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Converte a decisão do agente no contrato. Passos corrompidos não derrubam o histórico. */
export function toContractDecision(row: DecisionRow): AgentDecision {
  const steps = StepsSchema.safeParse(row.steps);
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    triggerMessageId: row.triggerMessageId,
    intent: row.intent,
    understanding: row.understanding,
    action: row.action,
    confidence: row.confidence,
    confidenceLevel: confidenceLevelOf(row.confidence),
    rationale: row.rationale,
    ruleRefs: row.ruleRefs,
    steps: steps.success ? steps.data : [],
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    latencyMs: row.latencyMs,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Trava a conversa até o fim da transação e devolve seu estado atual. Com `employeeId`, só trava e
 * devolve se ela for desse funcionário; caso contrário `null` (o chamador responde 404).
 */
export async function lockConversation(tx: Tx, conversationId: string, employeeId?: string): Promise<ConversationRow | null> {
  const owner = employeeId === undefined ? Prisma.empty : Prisma.sql`AND "employeeId" = ${employeeId}`;
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM conversations WHERE id = ${conversationId} ${owner} FOR UPDATE`;
  if (locked.length === 0) return null;
  return tx.conversation.findUnique({ where: { id: conversationId } });
}

export interface NewMessage {
  readonly role: 'EMPLOYEE' | 'AGENT' | 'ANALYST' | 'SYSTEM';
  readonly authorId: string | null;
  readonly content: string;
  readonly blocks: unknown[];
  readonly clientMessageId: string | null;
}

/**
 * Insere a mensagem com `createdAt` estritamente crescente dentro da conversa (nunca empata com a
 * anterior), atualiza `lastMessageAt` e aplica `conversationUpdate` (contadores, título). A conversa
 * precisa ter sido travada por `lockConversation` na mesma transação.
 */
export async function insertMessage(
  tx: Tx,
  conversation: Pick<ConversationRow, 'id' | 'lastMessageAt'>,
  message: NewMessage,
  now: Date,
  conversationUpdate: Prisma.ConversationUpdateInput = {},
): Promise<MessageRow> {
  const floor = conversation.lastMessageAt ? conversation.lastMessageAt.getTime() + 1 : 0;
  const createdAt = new Date(Math.max(now.getTime(), floor));
  const row = await tx.message.create({
    data: {
      conversationId: conversation.id,
      role: message.role,
      authorId: message.authorId,
      content: message.content,
      blocks: message.blocks as Prisma.InputJsonValue,
      clientMessageId: message.clientMessageId,
      createdAt,
    },
    include: MESSAGE_INCLUDE,
  });
  await tx.conversation.update({ where: { id: conversation.id }, data: { ...conversationUpdate, lastMessageAt: createdAt } });
  return row;
}
