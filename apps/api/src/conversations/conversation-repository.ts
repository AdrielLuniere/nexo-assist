import { type AgentDecision, type ConversationStatus, type Message, employeeCanWrite } from '@nexo/shared';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { writeSlotsFor } from '../infra/write-slots.js';
import { MESSAGE_INCLUDE, insertMessage, lockConversation, toContractDecision, toContractMessage } from './message-writer.js';

/**
 * Persistência das conversas do funcionário. Toda consulta recebe o `employeeId` da sessão e filtra por
 * ele; "não existe" e "é de outra pessoa" são indistinguíveis (`null` / `not_found`).
 */

export interface ConversationRecord {
  readonly id: string;
  readonly employeeId: string;
  readonly status: ConversationStatus;
  readonly assignedAnalystId: string | null;
  readonly title: string | null;
  readonly employeeMessageCount: number;
  readonly version: number;
  readonly lastMessageAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AcceptMessageInput {
  readonly employeeId: string;
  readonly conversationId: string;
  readonly clientMessageId: string;
  readonly content: string;
  /** Máximo de mensagens do funcionário na conversa (PRD: 30 por sessão). */
  readonly limit: number;
  readonly now: Date;
}

export type AcceptMessageResult =
  | { readonly kind: 'accepted' | 'replayed'; readonly message: Message; readonly conversation: ConversationRecord }
  | { readonly kind: 'not_found' | 'closed' | 'limit_reached' };

export interface ConversationRepository {
  /** Mais recentes primeiro. */
  list(employeeId: string, limit: number): Promise<ConversationRecord[]>;
  find(employeeId: string, conversationId: string): Promise<ConversationRecord | null>;
  /** Cria uma conversa, ou devolve a conversa vazia que já estava aguardando a primeira mensagem. */
  start(employeeId: string, now: Date): Promise<{ conversation: ConversationRecord; created: boolean }>;
  /** Em ordem de envio. */
  messages(conversationId: string): Promise<Message[]>;
  decisions(conversationId: string): Promise<AgentDecision[]>;
  /**
   * Última mensagem do funcionário que ainda não tem decisão do agente (resposta pendente), ou `null`.
   * Só a última importa: responder a ela leva em conta as anteriores, que estão no histórico.
   */
  pendingTrigger(conversationId: string): Promise<Message | null>;
  /**
   * Grava a mensagem do funcionário de forma atômica e idempotente: confere dono e estado, aplica o
   * limite, grava com ordenação estável e atualiza contador e título. Repetir o mesmo
   * `clientMessageId` devolve a mensagem original (`replayed`) sem consumir o limite.
   */
  acceptEmployeeMessage(input: AcceptMessageInput): Promise<AcceptMessageResult>;
}

/** Título derivado da primeira mensagem (sem IA): primeira linha útil, até 60 caracteres. */
export function titleFrom(content: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  return text.length <= 60 ? text : `${text.slice(0, 59).trimEnd()}…`;
}

function toRecord(row: Prisma.ConversationGetPayload<object>): ConversationRecord {
  return {
    id: row.id,
    employeeId: row.employeeId,
    status: row.status,
    assignedAnalystId: row.assignedAnalystId,
    title: row.title,
    employeeMessageCount: row.employeeMessageCount,
    version: row.version,
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Transações que esperam trava: espera por conexão em memória e prazos explícitos. */
const TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

export function createPrismaConversationRepository(prisma: PrismaClient): ConversationRepository {
  const slots = writeSlotsFor(prisma);
  return {
    async list(employeeId, limit) {
      const rows = await prisma.conversation.findMany({
        where: { employeeId },
        orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      });
      return rows.map(toRecord);
    },

    async find(employeeId, conversationId) {
      const row = await prisma.conversation.findFirst({ where: { id: conversationId, employeeId } });
      return row ? toRecord(row) : null;
    },

    async start(employeeId, now) {
      return slots.run(() => prisma.$transaction(async (tx) => {
        // Duplo clique ou duas abas: serializa por funcionário e reaproveita a conversa ainda vazia.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`conversation-start:${employeeId}`}, 0))`;
        const empty = await tx.conversation.findFirst({
          where: { employeeId, status: 'WITH_AGENT', employeeMessageCount: 0, messages: { none: {} } },
          orderBy: { createdAt: 'desc' },
        });
        if (empty) return { conversation: toRecord(empty), created: false };
        const row = await tx.conversation.create({ data: { employeeId, createdAt: now, updatedAt: now } });
        return { conversation: toRecord(row), created: true };
      }, TX_OPTIONS));
    },

    async messages(conversationId) {
      const rows = await prisma.message.findMany({
        where: { conversationId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: MESSAGE_INCLUDE,
      });
      return rows.map(toContractMessage);
    },

    async decisions(conversationId) {
      const rows = await prisma.agentDecision.findMany({ where: { conversationId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      return rows.map(toContractDecision);
    },

    async pendingTrigger(conversationId) {
      const last = await prisma.message.findFirst({
        where: { conversationId, role: 'EMPLOYEE' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: MESSAGE_INCLUDE,
      });
      if (!last) return null;
      const decided = await prisma.agentDecision.findUnique({ where: { triggerMessageId: last.id }, select: { id: true } });
      return decided ? null : toContractMessage(last);
    },

    async acceptEmployeeMessage(input) {
      return slots.run(() => prisma.$transaction(async (tx) => {
        const conversation = await lockConversation(tx, input.conversationId, input.employeeId);
        if (!conversation) return { kind: 'not_found' } as const;

        const existing = await tx.message.findUnique({
          where: { conversationId_clientMessageId: { conversationId: conversation.id, clientMessageId: input.clientMessageId } },
          include: MESSAGE_INCLUDE,
        });
        if (existing) return { kind: 'replayed', message: toContractMessage(existing), conversation: toRecord(conversation) } as const;

        if (!employeeCanWrite(conversation.status)) return { kind: 'closed' } as const;
        if (conversation.employeeMessageCount >= input.limit) return { kind: 'limit_reached' } as const;

        const row = await insertMessage(
          tx,
          conversation,
          { role: 'EMPLOYEE', authorId: input.employeeId, content: input.content, blocks: [], clientMessageId: input.clientMessageId },
          input.now,
          {
            employeeMessageCount: { increment: 1 },
            ...(conversation.title ? {} : { title: titleFrom(input.content) }),
          },
        );
        const updated = await tx.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
        return { kind: 'accepted', message: toContractMessage(row), conversation: toRecord(updated) } as const;
      }, TX_OPTIONS));
    },
  };
}

export interface InMemoryConversationRepository extends ConversationRepository {
  /** Insere uma conversa pronta (testes). */
  seed(conversation: Partial<ConversationRecord> & Pick<ConversationRecord, 'id' | 'employeeId'>): ConversationRecord;
  setStatus(conversationId: string, status: ConversationStatus): void;
  /** Mensagem do agente ou do analista (testes de ordenação e de leitura). */
  addMessage(conversationId: string, role: Message['role'], content: string, at: Date): Message;
  /** Registra que o agente respondeu a esta mensagem (deixa de estar pendente). */
  markAnswered(messageId: string): void;
}

export function createInMemoryConversationRepository(): InMemoryConversationRepository {
  const conversations = new Map<string, ConversationRecord>();
  const messages = new Map<string, Array<Message & { clientMessageId: string | null }>>();
  const answered = new Set<string>();
  let counter = 0;

  const messagesOf = (id: string) => messages.get(id) ?? [];
  const strip = ({ clientMessageId: _ignored, ...message }: Message & { clientMessageId: string | null }): Message => message;

  function append(conversation: ConversationRecord, role: Message['role'], authorId: string | null, content: string, clientMessageId: string | null, now: Date) {
    const floor = conversation.lastMessageAt ? conversation.lastMessageAt.getTime() + 1 : 0;
    const at = new Date(Math.max(now.getTime(), floor));
    const message = {
      id: `msg_${String(++counter).padStart(6, '0')}`,
      conversationId: conversation.id,
      role,
      authorId,
      content,
      blocks: [],
      decisionId: null,
      createdAt: at.toISOString(),
      clientMessageId,
    };
    messages.set(conversation.id, [...messagesOf(conversation.id), message]);
    return { message, at };
  }

  return {
    seed(partial) {
      const now = new Date();
      const record: ConversationRecord = {
        status: 'WITH_AGENT',
        assignedAnalystId: null,
        title: null,
        employeeMessageCount: 0,
        version: 0,
        lastMessageAt: null,
        createdAt: now,
        updatedAt: now,
        ...partial,
      };
      conversations.set(record.id, record);
      return record;
    },
    setStatus(conversationId, status) {
      const current = conversations.get(conversationId);
      if (current) conversations.set(conversationId, { ...current, status, version: current.version + 1 });
    },
    addMessage(conversationId, role, content, at) {
      const conversation = conversations.get(conversationId);
      if (!conversation) throw new Error('conversa inexistente');
      const { message, at: createdAt } = append(conversation, role, null, content, null, at);
      conversations.set(conversationId, { ...conversation, lastMessageAt: createdAt });
      return strip(message);
    },
    async list(employeeId, limit) {
      return [...conversations.values()]
        .filter((c) => c.employeeId === employeeId)
        .sort((a, b) => (b.lastMessageAt?.getTime() ?? -1) - (a.lastMessageAt?.getTime() ?? -1) || b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
        .slice(0, limit);
    },
    async find(employeeId, conversationId) {
      const found = conversations.get(conversationId);
      return found && found.employeeId === employeeId ? found : null;
    },
    async start(employeeId, now) {
      const empty = [...conversations.values()].find(
        (c) => c.employeeId === employeeId && c.status === 'WITH_AGENT' && c.employeeMessageCount === 0 && messagesOf(c.id).length === 0,
      );
      if (empty) return { conversation: empty, created: false };
      const record: ConversationRecord = {
        id: `conv_${String(++counter).padStart(6, '0')}`,
        employeeId,
        status: 'WITH_AGENT',
        assignedAnalystId: null,
        title: null,
        employeeMessageCount: 0,
        version: 0,
        lastMessageAt: null,
        createdAt: now,
        updatedAt: now,
      };
      conversations.set(record.id, record);
      return { conversation: record, created: true };
    },
    async messages(conversationId) {
      return messagesOf(conversationId).map(strip);
    },
    markAnswered(messageId) {
      answered.add(messageId);
    },
    async decisions() {
      return [];
    },
    async pendingTrigger(conversationId) {
      const last = messagesOf(conversationId).filter((m) => m.role === 'EMPLOYEE').at(-1);
      return last && !answered.has(last.id) ? strip(last) : null;
    },
    async acceptEmployeeMessage(input) {
      // Sem `await` entre a leitura e a escrita: equivale à trava de linha do PostgreSQL.
      const conversation = conversations.get(input.conversationId);
      if (!conversation || conversation.employeeId !== input.employeeId) return { kind: 'not_found' };
      const existing = messagesOf(conversation.id).find((m) => m.clientMessageId === input.clientMessageId);
      if (existing) return { kind: 'replayed', message: strip(existing), conversation };
      if (!employeeCanWrite(conversation.status)) return { kind: 'closed' };
      if (conversation.employeeMessageCount >= input.limit) return { kind: 'limit_reached' };

      const { message, at } = append(conversation, 'EMPLOYEE', input.employeeId, input.content, input.clientMessageId, input.now);
      const updated: ConversationRecord = {
        ...conversation,
        employeeMessageCount: conversation.employeeMessageCount + 1,
        title: conversation.title ?? titleFrom(input.content),
        lastMessageAt: at,
        updatedAt: at,
      };
      conversations.set(conversation.id, updated);
      return { kind: 'accepted', message: strip(message), conversation: updated };
    },
  };
}
