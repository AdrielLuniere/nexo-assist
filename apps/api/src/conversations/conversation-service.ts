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
  /** O agente deve responder: conversa com o agente e mensagem nova. */
  readonly agentShouldRespond: boolean;
  readonly conversation: ConversationRecord;
}

export interface ConversationService {
  list(user: User): Promise<ConversationSummary[]>;
  start(user: User): Promise<{ conversation: ConversationDetail; created: boolean }>;
  get(user: User, conversationId: string): Promise<ConversationDetail>;
  sendMessage(user: User, conversationId: string, input: SendMessageRequest): Promise<SendMessageResult>;
}

export interface ConversationServiceDeps {
  readonly conversations: ConversationRepository;
  readonly now?: () => Date;
  readonly messageLimit?: number;
}

/** Teto de conversas devolvidas na listagem (a mais recente primeiro). */
export const LIST_LIMIT = 100;

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

  async function detailOf(record: ConversationRecord): Promise<ConversationDetail> {
    const [messages, decisions] = await Promise.all([conversations.messages(record.id), conversations.decisions(record.id)]);
    return { ...toSummary(record), messages, decisions };
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
          return {
            message: result.message,
            replayed,
            status: result.conversation.status,
            version: result.conversation.version,
            // Agente pausado (conversa com analista) nunca responde; reenvio não dispara nova resposta.
            agentShouldRespond: !replayed && agentCanRespond(result.conversation.status),
            conversation: result.conversation,
          };
        }
      }
    },
  };
}
