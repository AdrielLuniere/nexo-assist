/**
 * Erros do serviço de chamados. A API traduz cada código para um `ApiErrorCode`.
 */
export const TICKET_SERVICE_ERROR_CODES = [
  'NOT_FOUND',
  /** Chamado existe, mas pertence a outro funcionário. A API responde 404 para não vazar existência. */
  'FORBIDDEN',
  'DUPLICATE_OPEN_TICKET',
  'REOPEN_WINDOW_EXPIRED',
  'INVALID_STATUS',
  /** Rascunho ausente, de outra conversa ou ainda não confirmado. */
  'CONFIRMATION_REQUIRED',
  /** Sistema legado fora do ar por alguns segundos (PRD). Pode ser repetido. */
  'UNAVAILABLE',
] as const;

export type TicketServiceErrorCode = (typeof TICKET_SERVICE_ERROR_CODES)[number];

export class TicketServiceError extends Error {
  override readonly name = 'TicketServiceError';

  constructor(
    readonly code: TicketServiceErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.code === 'UNAVAILABLE';
  }
}
