import {
  ApiErrorBodySchema,
  type ChatStreamEvent,
  ChatStreamEventSchema,
  ConsoleConversationDetailSchema,
  type ConsoleConversationFilter,
  ConsoleConversationItemSchema,
  type ConversationEvent,
  ConversationEventSchema,
  ConversationDetailSchema,
  ConversationSummarySchema,
  DraftConfirmationResponseSchema,
  HandoffResponseSchema,
  type HealthResponse,
  HealthResponseSchema,
  LoginResponseSchema,
  MessageSchema,
  TicketDraftSchema,
  TicketSummarySchema,
  UserSchema,
} from '@nexo/shared';
import { z } from 'zod';
import { readSse } from './sse';

/**
 * Cliente da API do Nexo Assist. Toda resposta é validada com os contratos de `@nexo/shared`: a tela
 * só mostra o que a API devolveu, no formato combinado.
 */

/** Erro com o código do contrato (`ApiErrorBody`) ou `NETWORK_ERROR` quando a API nem respondeu. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const isApiError = (error: unknown, code?: string): error is ApiError =>
  error instanceof ApiError && (code === undefined || error.code === code);

/** Mensagem segura para exibir, seja qual for o erro. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Algo deu errado. Tente novamente.';
}

export interface ApiClientOptions {
  /** Origem da API; vazio usa a mesma origem (proxy do Vite em desenvolvimento). */
  readonly baseUrl?: string;
  readonly getToken: () => string | null;
  /** Sessão inválida ou expirada (401 em rota autenticada). */
  readonly onUnauthorized?: (error: ApiError) => void;
}

const ItemsOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });
const PagedOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

type StreamHandler<E> = (event: E) => void;

export function createApiClient(options: ApiClientOptions) {
  const base = (options.baseUrl ?? '').replace(/\/$/, '');

  async function toError(response: Response): Promise<ApiError> {
    const parsed = ApiErrorBodySchema.safeParse(await response.json().catch(() => null));
    if (parsed.success) {
      const { code, message, retryable, details } = parsed.data.error;
      return new ApiError(code, message, response.status, retryable, details);
    }
    return new ApiError('INTERNAL_ERROR', 'A API respondeu de forma inesperada. Tente novamente.', response.status, response.status >= 500);
  }

  async function send(method: 'GET' | 'POST', path: string, init: { body?: unknown; signal?: AbortSignal; headers?: Record<string, string>; auth?: boolean } = {}) {
    const headers: Record<string, string> = { ...init.headers };
    const token = init.auth === false ? null : options.getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        ...(init.signal ? { signal: init.signal } : {}),
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ApiError('NETWORK_ERROR', 'Sem conexão com o servidor. Verifique sua rede e tente novamente.', 0, true);
    }
    if (!response.ok && !(response.status === 503 && path === '/health')) {
      const error = await toError(response);
      if (response.status === 401 && token) options.onUnauthorized?.(error);
      throw error;
    }
    return response;
  }

  async function json<S extends z.ZodType>(schema: S, method: 'GET' | 'POST', path: string, init: { body?: unknown; signal?: AbortSignal; auth?: boolean } = {}): Promise<z.infer<S>> {
    const response = await send(method, path, init);
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ApiError('INTERNAL_ERROR', 'A API respondeu de forma inesperada. Tente novamente.', response.status, false);
    return parsed.data;
  }

  /** Abre um stream SSE e repassa cada evento válido do contrato; eventos desconhecidos são ignorados. */
  async function stream<E>(
    schema: z.ZodType<E>,
    method: 'GET' | 'POST',
    path: string,
    onEvent: StreamHandler<E & { id?: string | null }>,
    init: { body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {},
  ): Promise<void> {
    const response = await send(method, path, { ...init, headers: { accept: 'text/event-stream', ...init.headers } });
    if (!response.body) return;
    await readSse(
      response.body,
      (message) => {
        let data: unknown;
        try {
          data = JSON.parse(message.data);
        } catch {
          return;
        }
        const parsed = schema.safeParse({ event: message.event, data });
        if (parsed.success) onEvent({ ...(parsed.data as object), id: message.id } as E & { id?: string | null });
      },
      init.signal,
    );
  }

  const enc = encodeURIComponent;

  return {
    health: (signal?: AbortSignal): Promise<HealthResponse> => json(HealthResponseSchema, 'GET', '/health', { auth: false, ...(signal ? { signal } : {}) }),
    login: (email: string, password: string) => json(LoginResponseSchema, 'POST', '/api/auth/login', { body: { email, password }, auth: false }),
    me: async () => (await json(z.object({ user: UserSchema }), 'GET', '/api/auth/me')).user,

    listConversations: async () => (await json(ItemsOf(ConversationSummarySchema), 'GET', '/api/conversations')).items,
    startConversation: async () => (await json(z.object({ conversation: ConversationDetailSchema }), 'POST', '/api/conversations')).conversation,
    getConversation: async (id: string) => (await json(z.object({ conversation: ConversationDetailSchema }), 'GET', `/api/conversations/${enc(id)}`)).conversation,
    sendMessage: (id: string, body: { content: string; clientMessageId: string }, onEvent: StreamHandler<ChatStreamEvent>, signal?: AbortSignal) =>
      stream(ChatStreamEventSchema, 'POST', `/api/conversations/${enc(id)}/messages`, onEvent, { body, ...(signal ? { signal } : {}) }),
    resume: (id: string, onEvent: StreamHandler<ChatStreamEvent>, signal?: AbortSignal) =>
      stream(ChatStreamEventSchema, 'POST', `/api/conversations/${enc(id)}/resume`, onEvent, signal ? { signal } : {}),
    conversationEvents: (id: string, onEvent: StreamHandler<ConversationEvent & { id?: string | null }>, init: { after?: string | null; lastEventId?: string | null; signal?: AbortSignal }) =>
      stream(
        ConversationEventSchema,
        'GET',
        `/api/conversations/${enc(id)}/events${init.after && !init.lastEventId ? `?after=${enc(init.after)}` : ''}`,
        onEvent,
        { ...(init.signal ? { signal: init.signal } : {}), ...(init.lastEventId ? { headers: { 'last-event-id': init.lastEventId } } : {}) },
      ),
    requestHandoff: (id: string, note?: string) => json(HandoffResponseSchema, 'POST', `/api/conversations/${enc(id)}/handoff`, { body: note ? { note } : {} }),
    confirmDraft: (conversationId: string, draftId: string) =>
      json(DraftConfirmationResponseSchema, 'POST', `/api/conversations/${enc(conversationId)}/drafts/${enc(draftId)}/confirm`),
    discardDraft: async (conversationId: string, draftId: string) =>
      (await json(z.object({ draft: TicketDraftSchema }), 'POST', `/api/conversations/${enc(conversationId)}/drafts/${enc(draftId)}/discard`)).draft,
    listTickets: async () => (await json(ItemsOf(TicketSummarySchema), 'GET', '/api/tickets')).items,

    console: {
      list: (filter: Partial<Pick<ConsoleConversationFilter, 'status' | 'q' | 'cursor'>> & { limit?: number } = {}) => {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== '') query.set(key, String(value));
        const qs = query.toString();
        return json(PagedOf(ConsoleConversationItemSchema), 'GET', `/api/console/conversations${qs ? `?${qs}` : ''}`);
      },
      get: async (id: string) => (await json(z.object({ conversation: ConsoleConversationDetailSchema }), 'GET', `/api/console/conversations/${enc(id)}`)).conversation,
      act: async (id: string, action: 'assume' | 'return' | 'close', expectedVersion: number) =>
        (await json(z.object({ conversation: ConversationSummarySchema }), 'POST', `/api/console/conversations/${enc(id)}/${action}`, { body: { expectedVersion } })).conversation,
      sendMessage: async (id: string, body: { content: string; clientMessageId: string }) =>
        (await json(z.object({ message: MessageSchema }), 'POST', `/api/console/conversations/${enc(id)}/messages`, { body })).message,
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
