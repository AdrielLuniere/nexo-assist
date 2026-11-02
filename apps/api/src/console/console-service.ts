import type {
  AnalystMessageRequest,
  ConsoleConversationDetail,
  ConsoleConversationFilter,
  ConsoleConversationItem,
  ConversationStatus,
  ConversationSummary,
  Message,
  User,
} from '@nexo/shared';
import { agentCanRespond } from '@nexo/shared';
import type { TicketService } from '@nexo/ticket-service';
import type { ConversationEventBus } from '../conversations/conversation-events.js';
import type { ConversationRepository } from '../conversations/conversation-repository.js';
import { toSummary } from '../conversations/conversation-service.js';
import { AppError } from '../http/app-error.js';
import type { ConsoleAction } from './console-rules.js';
import type { ConsoleRepository } from './console-repository.js';

/**
 * Casos de uso do console do analista. O analista vem sempre da sessão (`User` já autenticado e
 * verificado como analista pela camada HTTP); nenhum identificador de analista chega pelo corpo.
 *
 * Depois de cada alteração confirmada, o evento correspondente vai para o funcionário. A publicação
 * acontece depois da gravação: se o processo cair entre as duas, o funcionário recupera o que perdeu
 * na reconexão (ver `ConversationService.eventsSnapshot`).
 */

export interface ConsolePage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export interface ConsoleService {
  list(filter: ConsoleConversationFilter): Promise<ConsolePage<ConsoleConversationItem>>;
  get(conversationId: string): Promise<ConsoleConversationDetail>;
  assume(analyst: User, conversationId: string, expectedVersion: number): Promise<ConversationSummary>;
  returnToAgent(analyst: User, conversationId: string, expectedVersion: number): Promise<ConversationSummary>;
  close(analyst: User, conversationId: string, expectedVersion: number): Promise<ConversationSummary>;
  sendMessage(analyst: User, conversationId: string, input: AnalystMessageRequest): Promise<{ message: Message; replayed: boolean }>;
}

export interface ConsoleServiceDeps {
  readonly console: ConsoleRepository;
  /** Mensagens, decisões e resposta pendente (as mesmas leituras do funcionário). */
  readonly conversations: ConversationRepository;
  readonly tickets: TicketService;
  readonly events: ConversationEventBus;
  readonly now?: () => Date;
}

const notFound = () => new AppError('NOT_FOUND', 'Conversa não encontrada.');

const INVALID_STATE_MESSAGES: Record<ConsoleAction, string> = {
  assume: 'Só é possível assumir uma conversa que está aguardando atendimento.',
  return: 'Só é possível devolver ao agente uma conversa que você está atendendo.',
  close: 'Só é possível encerrar uma conversa que está aguardando atendimento ou em atendimento por você.',
};

export function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([updatedAt.toISOString(), id])).toString('base64url');
}

export function decodeCursor(cursor: string): { updatedAt: Date; id: string } {
  const invalid = () => new AppError('VALIDATION_ERROR', 'Cursor de paginação inválido.');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw invalid();
    const [time, id] = parsed as unknown[];
    if (typeof time !== 'string' || typeof id !== 'string' || id === '' || id.length > 64) throw invalid();
    const updatedAt = new Date(time);
    if (Number.isNaN(updatedAt.getTime())) throw invalid();
    return { updatedAt, id };
  } catch (error) {
    throw error instanceof AppError ? error : invalid();
  }
}

export function createConsoleService(deps: ConsoleServiceDeps): ConsoleService {
  const now = deps.now ?? (() => new Date());

  async function act(analyst: User, conversationId: string, expectedVersion: number, action: ConsoleAction): Promise<ConversationSummary> {
    const outcome = await deps.console.transition({ conversationId, analystId: analyst.id, action, expectedVersion, now: now() });
    switch (outcome.kind) {
      case 'not_found':
        throw notFound();
      case 'not_owner':
        throw new AppError('FORBIDDEN', 'Esta conversa está com outro analista.');
      case 'stale':
        throw new AppError('CONFLICT', 'A conversa foi alterada por outra pessoa. Atualize a tela e tente novamente.', {
          status: outcome.status,
          version: outcome.version,
        });
      case 'invalid_state':
        throw new AppError('INVALID_STATE_TRANSITION', INVALID_STATE_MESSAGES[action], { status: outcome.status });
      case 'done': {
        const { conversation } = outcome;
        if (!outcome.replayed) {
          deps.events.publish(conversation.id, { event: 'conversation.status', data: { status: conversation.status, version: conversation.version } });
        }
        return toSummary(conversation);
      }
    }
  }

  return {
    async list(filter) {
      const after = filter.cursor ? decodeCursor(filter.cursor) : undefined;
      const { rows, hasMore } = await deps.console.list({
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.q ? { q: filter.q } : {}),
        ...(after ? { after } : {}),
        limit: filter.limit,
      });
      const last = rows.at(-1);
      return {
        items: rows.map((row) => ({
          ...toSummary(row.conversation),
          employee: { id: row.employee.id, name: row.employee.name, email: row.employee.email, department: row.employee.department },
          activeHandoff: row.activeHandoff,
        })),
        nextCursor: hasMore && last ? encodeCursor(last.conversation.updatedAt, last.conversation.id) : null,
      };
    },

    async get(conversationId) {
      const row = await deps.console.find(conversationId);
      if (!row) throw notFound();
      const { conversation, employee } = row;
      const [messages, decisions, pending, employeeTickets] = await Promise.all([
        deps.conversations.messages(conversation.id),
        deps.conversations.decisions(conversation.id),
        agentCanRespond(conversation.status) ? deps.conversations.pendingTrigger(conversation.id) : Promise.resolve(null),
        // O funcionário vem da própria conversa (dado do servidor), nunca de um parâmetro da requisição.
        deps.tickets.listForRequester({ employeeId: employee.id }),
      ]);
      return {
        ...toSummary(conversation),
        messages,
        decisions,
        pendingAgentResponse: pending ? { messageId: pending.id } : null,
        employee,
        handoffs: row.handoffs,
        employeeTickets,
      };
    },

    assume: (analyst, conversationId, expectedVersion) => act(analyst, conversationId, expectedVersion, 'assume'),
    returnToAgent: (analyst, conversationId, expectedVersion) => act(analyst, conversationId, expectedVersion, 'return'),
    close: (analyst, conversationId, expectedVersion) => act(analyst, conversationId, expectedVersion, 'close'),

    async sendMessage(analyst, conversationId, input) {
      const outcome = await deps.console.postMessage({
        conversationId,
        analystId: analyst.id,
        clientMessageId: input.clientMessageId,
        content: input.content,
        now: now(),
      });
      switch (outcome.kind) {
        case 'not_found':
          throw notFound();
        case 'not_owner':
          throw new AppError('FORBIDDEN', 'Esta conversa está com outro analista.');
        case 'invalid_state':
          throw new AppError('INVALID_STATE_TRANSITION', stateMessage(outcome.status), { status: outcome.status });
        case 'id_in_use':
          throw new AppError('CONFLICT', 'Este identificador de mensagem já foi usado.');
        case 'posted':
          deps.events.publish(conversationId, { event: 'message.created', data: { message: outcome.message } });
          return { message: outcome.message, replayed: false };
        case 'replayed':
          return { message: outcome.message, replayed: true };
      }
    },
  };
}

function stateMessage(status: ConversationStatus): string {
  switch (status) {
    case 'WAITING_ANALYST':
      return 'Assuma a conversa antes de responder.';
    case 'WITH_AGENT':
      return 'A conversa voltou para o agente. Só é possível responder enquanto você a atende.';
    default:
      return 'A conversa está encerrada.';
  }
}
