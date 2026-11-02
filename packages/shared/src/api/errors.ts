import { z } from 'zod';

/**
 * Erros estruturados da API. Todo erro HTTP responde com `ApiErrorBody`.
 * `retryable` orienta a interface (ex.: sistema de chamados legado indisponível por alguns segundos).
 */
export const API_ERROR_DEFINITIONS = {
  VALIDATION_ERROR: { httpStatus: 400, retryable: false },
  UNAUTHENTICATED: { httpStatus: 401, retryable: false },
  INVALID_CREDENTIALS: { httpStatus: 401, retryable: false },
  FORBIDDEN: { httpStatus: 403, retryable: false },
  NOT_FOUND: { httpStatus: 404, retryable: false },
  CONFLICT: { httpStatus: 409, retryable: false },
  /** Ação incompatível com o estado atual da conversa (ex.: assumir conversa já encerrada). */
  INVALID_STATE_TRANSITION: { httpStatus: 409, retryable: false },
  /** Conversa com analista: o agente não responde. */
  AGENT_PAUSED: { httpStatus: 409, retryable: false },
  /** Rascunho já confirmado, descartado ou substituído. */
  DRAFT_NOT_PENDING: { httpStatus: 409, retryable: false },
  /** Existe chamado aberto sobre o mesmo problema: atualizar em vez de criar. */
  DUPLICATE_TICKET: { httpStatus: 409, retryable: false },
  /** Chamado resolvido há mais de 7 dias não pode ser reaberto. */
  REOPEN_WINDOW_EXPIRED: { httpStatus: 422, retryable: false },
  /** Limite de 30 mensagens por sessão atingido. */
  MESSAGE_LIMIT_REACHED: { httpStatus: 429, retryable: false },
  RATE_LIMITED: { httpStatus: 429, retryable: true },
  TICKET_SERVICE_UNAVAILABLE: { httpStatus: 503, retryable: true },
  AGENT_UNAVAILABLE: { httpStatus: 503, retryable: true },
  DATABASE_UNAVAILABLE: { httpStatus: 503, retryable: true },
  INTERNAL_ERROR: { httpStatus: 500, retryable: false },
} as const satisfies Record<string, { httpStatus: number; retryable: boolean }>;

export type ApiErrorCode = keyof typeof API_ERROR_DEFINITIONS;

export const API_ERROR_CODES = Object.keys(API_ERROR_DEFINITIONS) as [ApiErrorCode, ...ApiErrorCode[]];
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    /** Mensagem segura para exibir ao usuário (pt-BR). Nunca contém stack ou dados de terceiros. */
    message: z.string().min(1),
    retryable: z.boolean(),
    /** Correlaciona com os logs do servidor (header `x-request-id`). */
    requestId: z.string().optional(),
    /** Detalhes estruturados, ex.: campos inválidos. */
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export function httpStatusOf(code: ApiErrorCode): number {
  return API_ERROR_DEFINITIONS[code].httpStatus;
}

export function isRetryable(code: ApiErrorCode): boolean {
  return API_ERROR_DEFINITIONS[code].retryable;
}
