import {
  type ConversationDetail,
  type ConversationStatus,
  type ConversationSummary,
  MAX_EMPLOYEE_MESSAGES_PER_SESSION,
  type Message,
  type SendMessageRequest,
  type User,
  agentCanRespond,
} from '@nexo/shared';
import { AppError } from '../http/app-error.js';
import type { ConversationRecord, ConversationRepository } from './conversation-repository.js';

/**
 * Casos de uso das conversas do funcionário. Toda operação recebe o usuário da sessão e só enxerga
 * conversas dele: "não existe" e "é de outra pessoa" respondem o mesmo 404.
 */

export interface SendMessageResult {
  readonly message: Message;
  /** `true` quando o `clientMessageId` já tinha sido gravado (reenvio); nada novo foi escrito. */
  readonly replayed: boolean;
  readonly status: ConversationStatus;
  readonly version: number;
  /**
   * O agente deve responder: conversa com o agente e mensagem ainda sem resposta. Num reenvio isso só
   * acontece se a mensagem continua pendente (ex.: o agente falhou da primeira vez): é a retomada.
   */
  readonly agentShouldRespond: boolean;
  readonly conversation: ConversationRecord;
}

export interface ResumeResult {
  readonly conversation: ConversationRecord;
  /** Mensagem do funcionário à espera de resposta, ou `null` se não há nada a retomar. */
  readonly pending: Message | null;
}

/** Estado atual e mensagens de analista perdidas, para (re)conectar o stream de eventos. */
export interface EventsSnapshot {
  readonly status: ConversationStatus;
  readonly version: number;
  readonly missed: Message[];
}

export interface ConversationService {
  list(user: User): Promise<ConversationSummary[]>;
  start(user: User): Promise<{ conversation: ConversationDetail; created: boolean }>;
  get(user: User, conversationId: string): Promise<ConversationDetail>;
  sendMessage(user: User, conversationId: string, input: SendMessageRequest): Promise<SendMessageResult>;
  /** Localiza a resposta pendente do agente para retomar (`POST .../resume`). */
  resume(user: User, conversationId: string): Promise<ResumeResult>;
  /**
   * Estado atual da conversa e as mensagens de analista posteriores a `after` (ver
   * `ConversationRepository.analystMessagesAfter`); com `after` nulo só o estado. 404 se a conversa
   * não é do funcionário.
   */
  eventsSnapshot(user: User, conversationId: string, after: string | null): Promise<EventsSnapshot>;
}

export interface ConversationServiceDeps {
  readonly conversations: ConversationRepository;
  readonly now?: () => Date;
  readonly messageLimit?: number;
}

/** Teto de conversas devolvidas na listagem (a mais recente primeiro). */
export const LIST_LIMIT = 100;

/** Teto de mensagens recuperadas de uma vez na (re)conexão do stream de eventos. */
export const EVENT_CATCH_UP_LIMIT = 100;

const notFound = () => new AppError('NOT_FOUND', 'Conversa não encontrada.');

export function toSummary(record: ConversationRecord): ConversationSummary {
  return {
    id: record.id,
    employeeId: record.employeeId,
    status: record.status,
    title: record.title,
    assignedAnalystId: record.assignedAnalystId,
    employeeMessageCount: record.employeeMessageCount,
    version: record.version,
    lastMessageAt: record.lastMessageAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function createConversationService(deps: ConversationServiceDeps): ConversationService {
  const { conversations } = deps;
  const now = deps.now ?? (() => new Date());
  const limit = deps.messageLimit ?? MAX_EMPLOYEE_MESSAGES_PER_SESSION;

  const pendingOf = async (record: ConversationRecord) =>
    agentCanRespond(record.status) ? conversations.pendingTrigger(record.id) : null;

  async function detailOf(record: ConversationRecord): Promise<ConversationDetail> {
    const [messages, decisions, pending] = await Promise.all([
      conversations.messages(record.id),
      conversations.decisions(record.id),
      pendingOf(record),
    ]);
    return { ...toSummary(record), messages, decisions, pendingAgentResponse: pending ? { messageId: pending.id } : null };
  }

  return {
    async list(user) {
      return (await conversations.list(user.id, LIST_LIMIT)).map(toSummary);
    },

    async start(user) {
      const { conversation, created } = await conversations.start(user.id, now());
      return { conversation: await detailOf(conversation), created };
    },

    async get(user, conversationId) {
      const record = await conversations.find(user.id, conversationId);
      if (!record) throw notFound();
      return detailOf(record);
    },

    async sendMessage(user, conversationId, input) {
      const result = await conversations.acceptEmployeeMessage({
        employeeId: user.id,
        conversationId,
        clientMessageId: input.clientMessageId,
        content: input.content,
        limit,
        now: now(),
      });

      switch (result.kind) {
        case 'not_found':
          throw notFound();
        case 'closed':
          throw new AppError('INVALID_STATE_TRANSITION', 'A conversa está encerrada. Inicie uma nova conversa.');
        case 'limit_reached':
          throw new AppError(
            'MESSAGE_LIMIT_REACHED',
            `Limite de ${limit} mensagens por sessão atingido. Inicie uma nova conversa.`,
          );
        case 'accepted':
        case 'replayed': {
          const replayed = result.kind === 'replayed';
          // Agente pausado (conversa com analista) nunca responde. Reenvio só aciona o agente se a
          // mensagem ainda for a resposta pendente; se já foi respondida, nada se repete.
          const pending = replayed ? await pendingOf(result.conversation) : null;
          return {
            message: result.message,
            replayed,
            status: result.conversation.status,
            version: result.conversation.version,
            agentShouldRespond: agentCanRespond(result.conversation.status) && (!replayed || pending?.id === result.message.id),
            conversation: result.conversation,
          };
        }
      }
    },

    async resume(user, conversationId) {
      const record = await conversations.find(user.id, conversationId);
      if (!record) throw notFound();
      return { conversation: record, pending: await pendingOf(record) };
    },

    async eventsSnapshot(user, conversationId, after) {
      const record = await conversations.find(user.id, conversationId);
      if (!record) throw notFound();
      // Sem ponto de partida não há o que recuperar: o cliente tem o histórico do GET da conversa.
      const missed = after === null ? [] : await conversations.analystMessagesAfter(record.id, after, EVENT_CATCH_UP_LIMIT);
      // O estado é lido depois das mensagens: se mudar entre as duas leituras, o evento ao vivo
      // (já assinado pelo chamador) cobre a diferença e o cliente descarta o que já viu.
      const current = (await conversations.find(user.id, conversationId)) ?? record;
      return { status: current.status, version: current.version, missed };
    },
  };
}
