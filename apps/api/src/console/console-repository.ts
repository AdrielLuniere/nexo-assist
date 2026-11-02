import type { ConversationStatus, Handoff, Message, User } from '@nexo/shared';
import {
  type ConversationRecord,
  type InMemoryWorld,
  appendInMemoryMessage,
  stripClientId,
  toRecord,
} from '../conversations/conversation-repository.js';
import { MESSAGE_INCLUDE, insertMessage, lockConversation, toContractMessage } from '../conversations/message-writer.js';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { writeSlotsFor } from '../infra/write-slots.js';
import { type ConsoleAction, type ConversationState, decidePost, decideTransition } from './console-rules.js';

/**
 * Persistência do console do analista.
 *
 * Visibilidade: o console só enxerga conversas que já tiveram uma transferência (têm ao menos um
 * registro em `handoffs`). Conversas que nunca saíram do agente não existem para o analista (`null` /
 * `not_found`), então ele não consegue ler nem alterar conversas de funcionários que não pediram atendimento humano.
 *
 * Toda alteração acontece numa transação com a conversa travada (`SELECT ... FOR UPDATE`, a mesma
 * trava do funcionário e do agente), então ações do console, mensagens do funcionário e publicação do
 * agente de uma mesma conversa são sempre serializadas.
 */

export interface ConsoleListFilter {
  readonly status?: ConversationStatus;
  /** Trecho do nome ou e-mail do funcionário, ou do título da conversa (sem diferenciar maiúsculas). */
  readonly q?: string;
  /** Posição do último item da página anterior (ordenação: atividade mais recente primeiro). */
  readonly after?: { readonly updatedAt: Date; readonly id: string };
  readonly limit: number;
}

export interface ConsoleListRow {
  readonly conversation: ConversationRecord;
  readonly employee: User;
  /** Transferência ainda em aberto (aguardando ou assumida), se houver. */
  readonly activeHandoff: Handoff | null;
}

export interface ConsoleDetailRow {
  readonly conversation: ConversationRecord;
  readonly employee: User;
  /** Todas as transferências da conversa, da mais antiga à mais recente; nunca são apagadas. */
  readonly handoffs: Handoff[];
}

export type TransitionOutcome =
  | { readonly kind: 'done'; readonly conversation: ConversationRecord; readonly replayed: boolean }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_owner' }
  | { readonly kind: 'stale'; readonly status: ConversationStatus; readonly version: number }
  | { readonly kind: 'invalid_state'; readonly status: ConversationStatus };

export type PostOutcome =
  | { readonly kind: 'posted' | 'replayed'; readonly message: Message; readonly conversation: ConversationRecord }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_owner' }
  | { readonly kind: 'invalid_state'; readonly status: ConversationStatus }
  /** O `clientMessageId` já foi usado por outra mensagem. */
  | { readonly kind: 'id_in_use' };

export interface TransitionInput {
  readonly conversationId: string;
  readonly analystId: string;
  readonly action: ConsoleAction;
  readonly expectedVersion: number;
  readonly now: Date;
}

export interface PostInput {
  readonly conversationId: string;
  readonly analystId: string;
  readonly clientMessageId: string;
  readonly content: string;
  readonly now: Date;
}

export interface ConsoleRepository {
  list(filter: ConsoleListFilter): Promise<{ rows: ConsoleListRow[]; hasMore: boolean }>;
  find(conversationId: string): Promise<ConsoleDetailRow | null>;
  transition(input: TransitionInput): Promise<TransitionOutcome>;
  postMessage(input: PostInput): Promise<PostOutcome>;
}

const TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

type UserRow = Prisma.UserGetPayload<object>;
type HandoffRow = Prisma.HandoffGetPayload<object>;

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  analystLevel: row.analystLevel,
  department: row.department,
});

export function toHandoff(row: HandoffRow, codes: ReadonlyMap<string, string>): Handoff {
  return {
    id: row.id,
    conversationId: row.conversationId,
    reason: row.reason,
    status: row.status,
    summary: row.summary,
    relatedTicketCode: row.relatedTicketId ? (codes.get(row.relatedTicketId) ?? null) : null,
    assumedById: row.assumedById,
    createdAt: row.createdAt.toISOString(),
    assumedAt: row.assumedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

/**
 * O `contains` do Prisma vira `ILIKE '%texto%'` sem escapar curingas: sem isto, buscar "%" ou "_"
 * listaria tudo. A barra invertida é o caractere de escape padrão do LIKE no PostgreSQL.
 */
export const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (char) => `\\${char}`);

export function createPrismaConsoleRepository(prisma: PrismaClient): ConsoleRepository {
  const slots = writeSlotsFor(prisma);

  async function ticketCodes(rows: readonly HandoffRow[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.flatMap((row) => (row.relatedTicketId ? [row.relatedTicketId] : [])))];
    if (ids.length === 0) return new Map();
    const tickets = await prisma.ticket.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } });
    return new Map(tickets.map((ticket) => [ticket.id, ticket.code]));
  }

  const hasHandoff = async (tx: Prisma.TransactionClient, conversationId: string) =>
    (await tx.handoff.findFirst({ where: { conversationId }, select: { id: true } })) !== null;

  return {
    async list(filter) {
      const and: Prisma.ConversationWhereInput[] = [];
      if (filter.q) {
        const q = escapeLike(filter.q);
        and.push({
          OR: [
            { title: { contains: q, mode: 'insensitive' } },
            { employee: { name: { contains: q, mode: 'insensitive' } } },
            { employee: { email: { contains: q, mode: 'insensitive' } } },
          ],
        });
      }
      if (filter.after) {
        and.push({ OR: [{ updatedAt: { lt: filter.after.updatedAt } }, { updatedAt: filter.after.updatedAt, id: { lt: filter.after.id } }] });
      }
      const rows = await prisma.conversation.findMany({
        where: { handoffs: { some: {} }, ...(filter.status ? { status: filter.status } : {}), AND: and },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: filter.limit + 1,
        include: {
          employee: true,
          handoffs: { where: { status: { in: ['WAITING', 'ASSUMED'] } }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
      });
      const page = rows.slice(0, filter.limit);
      const codes = await ticketCodes(page.flatMap((row) => row.handoffs));
      return {
        rows: page.map((row) => ({
          conversation: toRecord(row),
          employee: toUser(row.employee),
          activeHandoff: row.handoffs[0] ? toHandoff(row.handoffs[0], codes) : null,
        })),
        hasMore: rows.length > filter.limit,
      };
    },

    async find(conversationId) {
      const row = await prisma.conversation.findFirst({
        where: { id: conversationId, handoffs: { some: {} } },
        include: { employee: true, handoffs: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
      });
      if (!row) return null;
      const codes = await ticketCodes(row.handoffs);
      return { conversation: toRecord(row), employee: toUser(row.employee), handoffs: row.handoffs.map((handoff) => toHandoff(handoff, codes)) };
    },

    async transition({ conversationId, analystId, action, expectedVersion, now }) {
      return slots.run(() =>
        prisma.$transaction(async (tx): Promise<TransitionOutcome> => {
          const locked = await lockConversation(tx, conversationId);
          if (!locked || !(await hasHandoff(tx, conversationId))) return { kind: 'not_found' };

          const state: ConversationState = { status: locked.status, version: locked.version, assignedAnalystId: locked.assignedAnalystId };
          const decision = decideTransition(state, action, analystId, expectedVersion);
          switch (decision.kind) {
            case 'not_owner':
              return { kind: 'not_owner' };
            case 'stale':
              return { kind: 'stale', status: state.status, version: state.version };
            case 'invalid_state':
              return { kind: 'invalid_state', status: state.status };
            case 'replay':
              return { kind: 'done', conversation: toRecord(locked), replayed: true };
            case 'apply': {
              const ended = decision.to === 'WITH_AGENT' || decision.to === 'CLOSED';
              await tx.handoff.updateMany({
                where: { conversationId, status: { in: [...decision.handoff.from] } },
                data: {
                  status: decision.handoff.to,
                  ...(decision.to === 'WITH_ANALYST' ? { assumedById: analystId, assumedAt: now } : {}),
                  ...(ended ? { endedAt: now } : {}),
                },
              });
              const updated = await tx.conversation.update({
                where: { id: conversationId },
                data: {
                  status: decision.to,
                  assignedAnalystId: decision.assignedAnalystId,
                  version: { increment: 1 },
                  ...(decision.to === 'CLOSED' ? { closedAt: now } : {}),
                },
              });
              return { kind: 'done', conversation: toRecord(updated), replayed: false };
            }
          }
        }, TX_OPTIONS),
      );
    },

    async postMessage({ conversationId, analystId, clientMessageId, content, now }) {
      return slots.run(() =>
        prisma.$transaction(async (tx): Promise<PostOutcome> => {
          const locked = await lockConversation(tx, conversationId);
          if (!locked || !(await hasHandoff(tx, conversationId))) return { kind: 'not_found' };

          const existing = await tx.message.findUnique({
            where: { conversationId_clientMessageId: { conversationId, clientMessageId } },
            include: MESSAGE_INCLUDE,
          });
          if (existing) {
            // Reenvio do próprio analista devolve a mensagem original, mesmo que a conversa já tenha
            // mudado de estado. Qualquer outro uso do identificador é recusado.
            return existing.role === 'ANALYST' && existing.authorId === analystId
              ? { kind: 'replayed', message: toContractMessage(existing), conversation: toRecord(locked) }
              : { kind: 'id_in_use' };
          }

          const decision = decidePost({ status: locked.status, version: locked.version, assignedAnalystId: locked.assignedAnalystId }, analystId);
          if (decision.kind === 'not_owner') return { kind: 'not_owner' };
          if (decision.kind === 'invalid_state') return { kind: 'invalid_state', status: locked.status };

          const row = await insertMessage(tx, locked, { role: 'ANALYST', authorId: analystId, content, blocks: [], clientMessageId }, now);
          const updated = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId } });
          return { kind: 'posted', message: toContractMessage(row), conversation: toRecord(updated) };
        }, TX_OPTIONS),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Em memória (testes HTTP rápidos, sem banco)
// ---------------------------------------------------------------------------

export function createInMemoryConsoleRepository(world: InMemoryWorld, users: readonly User[]): ConsoleRepository {
  const employeeOf = (id: string): User => users.find((user) => user.id === id) ?? { id, email: `${id}@invalido.local`, name: id, role: 'EMPLOYEE', analystLevel: null, department: null };
  const handoffsOf = (id: string) => world.handoffs.get(id) ?? [];
  const visible = (id: string) => handoffsOf(id).length > 0;

  return {
    async list(filter) {
      const q = filter.q?.toLowerCase();
      const matches = [...world.conversations.values()]
        .filter((conversation) => visible(conversation.id))
        .filter((conversation) => !filter.status || conversation.status === filter.status)
        .filter((conversation) => {
          if (!q) return true;
          const employee = employeeOf(conversation.employeeId);
          return [conversation.title ?? '', employee.name, employee.email].some((text) => text.toLowerCase().includes(q));
        })
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id))
        .filter((conversation) => {
          const after = filter.after;
          if (!after) return true;
          const time = conversation.updatedAt.getTime();
          return time < after.updatedAt.getTime() || (time === after.updatedAt.getTime() && conversation.id < after.id);
        });
      return {
        rows: matches.slice(0, filter.limit).map((conversation) => ({
          conversation,
          employee: employeeOf(conversation.employeeId),
          activeHandoff: [...handoffsOf(conversation.id)].reverse().find((h) => h.status === 'WAITING' || h.status === 'ASSUMED') ?? null,
        })),
        hasMore: matches.length > filter.limit,
      };
    },

    async find(conversationId) {
      const conversation = world.conversations.get(conversationId);
      if (!conversation || !visible(conversationId)) return null;
      return { conversation, employee: employeeOf(conversation.employeeId), handoffs: [...handoffsOf(conversationId)] };
    },

    // Sem `await` entre ler e gravar: equivale à trava de linha do PostgreSQL.
    async transition({ conversationId, analystId, action, expectedVersion, now }) {
      const conversation = world.conversations.get(conversationId);
      if (!conversation || !visible(conversationId)) return { kind: 'not_found' };

      const decision = decideTransition(conversation, action, analystId, expectedVersion);
      switch (decision.kind) {
        case 'not_owner':
          return { kind: 'not_owner' };
        case 'stale':
          return { kind: 'stale', status: conversation.status, version: conversation.version };
        case 'invalid_state':
          return { kind: 'invalid_state', status: conversation.status };
        case 'replay':
          return { kind: 'done', conversation, replayed: true };
        case 'apply': {
          const ended = decision.to === 'WITH_AGENT' || decision.to === 'CLOSED';
          world.handoffs.set(
            conversationId,
            handoffsOf(conversationId).map((handoff) =>
              decision.handoff.from.includes(handoff.status)
                ? {
                    ...handoff,
                    status: decision.handoff.to,
                    ...(decision.to === 'WITH_ANALYST' ? { assumedById: analystId, assumedAt: now.toISOString() } : {}),
                    ...(ended ? { endedAt: now.toISOString() } : {}),
                  }
                : handoff,
            ),
          );
          const updated: ConversationRecord = {
            ...conversation,
            status: decision.to,
            assignedAnalystId: decision.assignedAnalystId,
            version: conversation.version + 1,
            updatedAt: now,
          };
          world.conversations.set(conversationId, updated);
          return { kind: 'done', conversation: updated, replayed: false };
        }
      }
    },

    async postMessage({ conversationId, analystId, clientMessageId, content, now }) {
      const conversation = world.conversations.get(conversationId);
      if (!conversation || !visible(conversationId)) return { kind: 'not_found' };

      const existing = (world.messages.get(conversationId) ?? []).find((m) => m.clientMessageId === clientMessageId);
      if (existing) {
        return existing.role === 'ANALYST' && existing.authorId === analystId
          ? { kind: 'replayed', message: stripClientId(existing), conversation }
          : { kind: 'id_in_use' };
      }

      const decision = decidePost(conversation, analystId);
      if (decision.kind === 'not_owner') return { kind: 'not_owner' };
      if (decision.kind === 'invalid_state') return { kind: 'invalid_state', status: conversation.status };

      const { message, at } = appendInMemoryMessage(world, conversation, 'ANALYST', analystId, content, clientMessageId, now);
      const updated: ConversationRecord = { ...conversation, lastMessageAt: at, updatedAt: at };
      world.conversations.set(conversationId, updated);
      return { kind: 'posted', message: stripClientId(message), conversation: updated };
    },
  };
}
