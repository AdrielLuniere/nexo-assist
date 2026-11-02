import type {
  ConversationStatus,
  DraftOperation,
  DraftStatus,
  Message,
  MessageBlock,
} from '@nexo/shared';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';

/**
 * Persistência dos rascunhos (tabela `ticket_drafts`, propriedade da API) e da mensagem que registra
 * o resultado na conversa. As transições de estado são compare-and-swap: só uma requisição vence.
 */

export interface DraftRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly employeeId: string;
  readonly operation: DraftOperation;
  /** JSON bruto: validado com `DraftPayloadSchema` por quem usa. */
  readonly payload: unknown;
  readonly status: DraftStatus;
  /** Código do chamado criado/atualizado, depois que a operação foi efetivada. */
  readonly resultTicketCode: string | null;
  readonly confirmedAt: Date | null;
  readonly createdAt: Date;
  /** Dono da conversa do rascunho (precisa coincidir com o dono do rascunho). */
  readonly conversationOwnerId: string;
  readonly conversationStatus: ConversationStatus;
}

export interface ResultMessageInput {
  readonly draftId: string;
  readonly conversationId: string;
  readonly content: string;
  readonly blocks: MessageBlock[];
}

export interface DraftRepository {
  findById(id: string): Promise<DraftRecord | null>;
  /** CAS: move `from` para `to` e devolve `true` apenas se este chamador fez a transição. */
  transition(id: string, from: DraftStatus, to: DraftStatus, at: Date): Promise<boolean>;
  /** Registra o chamado resultante (idempotente) em um rascunho CONFIRMED. */
  markExecuted(id: string, ticketCode: string): Promise<void>;
  /** CONFIRMED sem resultado volta a PENDING. `true` se a reversão ocorreu. */
  revertToPending(id: string): Promise<boolean>;
  /** Mensagem do agente com o resultado. Idempotente por rascunho: repetir devolve a mesma mensagem. */
  recordResultMessage(input: ResultMessageInput): Promise<Message>;
}

function toMessage(row: {
  id: string;
  conversationId: string;
  content: string;
  blocks: unknown;
  createdAt: Date;
}): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: 'AGENT',
    authorId: null,
    content: row.content,
    blocks: row.blocks as MessageBlock[],
    decisionId: null,
    createdAt: row.createdAt.toISOString(),
  };
}

const resultMessageKey = (draftId: string) => `draft-result:${draftId}`;

export function createPrismaDraftRepository(prisma: PrismaClient): DraftRepository {
  return {
    async findById(id) {
      const row = await prisma.ticketDraft.findUnique({ where: { id }, include: { conversation: true } });
      if (!row) return null;
      const result = row.resultTicketId
        ? await prisma.ticket.findUnique({ where: { id: row.resultTicketId }, select: { code: true } })
        : null;
      return {
        id: row.id,
        conversationId: row.conversationId,
        employeeId: row.employeeId,
        operation: row.operation,
        payload: row.payload,
        status: row.status,
        resultTicketCode: result?.code ?? null,
        confirmedAt: row.confirmedAt,
        createdAt: row.createdAt,
        conversationOwnerId: row.conversation.employeeId,
        conversationStatus: row.conversation.status,
      };
    },

    async transition(id, from, to, at) {
      const { count } = await prisma.ticketDraft.updateMany({
        where: { id, status: from },
        data: {
          status: to,
          ...(to === 'CONFIRMED' ? { confirmedAt: at } : {}),
          ...(to === 'DISCARDED' ? { discardedAt: at } : {}),
        },
      });
      return count === 1;
    },

    async markExecuted(id, ticketCode) {
      const ticket = await prisma.ticket.findUnique({ where: { code: ticketCode }, select: { id: true } });
      if (!ticket) throw new Error('chamado resultante não encontrado');
      await prisma.ticketDraft.updateMany({ where: { id, status: 'CONFIRMED' }, data: { resultTicketId: ticket.id } });
    },

    async revertToPending(id) {
      const { count } = await prisma.ticketDraft.updateMany({
        where: { id, status: 'CONFIRMED', resultTicketId: null },
        data: { status: 'PENDING', confirmedAt: null },
      });
      return count === 1;
    },

    async recordResultMessage(input) {
      const key = { conversationId_clientMessageId: { conversationId: input.conversationId, clientMessageId: resultMessageKey(input.draftId) } };
      const existing = await prisma.message.findUnique({ where: key });
      if (existing) return toMessage(existing);
      try {
        const row = await prisma.$transaction(async (tx) => {
          const created = await tx.message.create({
            data: {
              conversationId: input.conversationId,
              role: 'AGENT',
              content: input.content,
              blocks: input.blocks as unknown as Prisma.InputJsonValue,
              clientMessageId: resultMessageKey(input.draftId),
            },
          });
          await tx.conversation.update({ where: { id: input.conversationId }, data: { lastMessageAt: created.createdAt } });
          return created;
        });
        return toMessage(row);
      } catch (error) {
        // Outra confirmação concorrente gravou primeiro: devolve a mensagem dela.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const winner = await prisma.message.findUnique({ where: key });
          if (winner) return toMessage(winner);
        }
        throw error;
      }
    },
  };
}

export interface InMemoryDraftRepository extends DraftRepository {
  addDraft(draft: Omit<DraftRecord, 'resultTicketCode' | 'confirmedAt'> & Partial<Pick<DraftRecord, 'resultTicketCode' | 'confirmedAt'>>): void;
  messages(): Message[];
  /** Falha injetada: a próxima chamada de `markExecuted` lança (simula queda entre efetivar e registrar). */
  failNextMarkExecuted(): void;
}

export function createInMemoryDraftRepository(now: () => Date = () => new Date()): InMemoryDraftRepository {
  const drafts = new Map<string, DraftRecord>();
  const messages = new Map<string, Message>();
  let failMark = false;
  let counter = 0;

  return {
    addDraft(draft) {
      drafts.set(draft.id, { resultTicketCode: null, confirmedAt: null, ...draft });
    },
    messages: () => [...messages.values()],
    failNextMarkExecuted() {
      failMark = true;
    },
    async findById(id) {
      return drafts.get(id) ?? null;
    },
    async transition(id, from, to, at) {
      const draft = drafts.get(id);
      if (!draft || draft.status !== from) return false;
      drafts.set(id, { ...draft, status: to, confirmedAt: to === 'CONFIRMED' ? at : draft.confirmedAt });
      return true;
    },
    async markExecuted(id, ticketCode) {
      if (failMark) {
        failMark = false;
        throw new Error('falha injetada ao registrar o resultado');
      }
      const draft = drafts.get(id);
      if (draft?.status === 'CONFIRMED') drafts.set(id, { ...draft, resultTicketCode: ticketCode });
    },
    async revertToPending(id) {
      const draft = drafts.get(id);
      if (!draft || draft.status !== 'CONFIRMED' || draft.resultTicketCode) return false;
      drafts.set(id, { ...draft, status: 'PENDING', confirmedAt: null });
      return true;
    },
    async recordResultMessage(input) {
      const key = resultMessageKey(input.draftId);
      const existing = messages.get(key);
      if (existing) return existing;
      const message: Message = {
        id: `msg_${++counter}`,
        conversationId: input.conversationId,
        role: 'AGENT',
        authorId: null,
        content: input.content,
        blocks: input.blocks,
        decisionId: null,
        createdAt: now().toISOString(),
      };
      messages.set(key, message);
      return message;
    },
  };
}
