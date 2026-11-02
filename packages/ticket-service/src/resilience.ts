import { TicketServiceError } from './errors.js';
import type { TicketService } from './ticket-service.js';

/**
 * O sistema de chamados legado "fica indisponível por alguns segundos" (PRD). Este decorador
 * repete a chamada com espera crescente quando o erro é `UNAVAILABLE`.
 *
 * Repetir é seguro porque:
 * - leituras não têm efeito colateral;
 * - escritas são idempotentes pelo id do rascunho confirmado: se a primeira tentativa chegou a
 *   gravar mas a resposta se perdeu, a repetição devolve o resultado já gravado, sem duplicar.
 *
 * Esgotadas as tentativas, o erro `UNAVAILABLE` sobe para a API responder 503 (retryable).
 */

export interface RetryOptions {
  /** Total de tentativas, incluindo a primeira. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRetry?: (info: { method: keyof TicketService; attempt: number; delayMs: number }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const METHODS = [
  'listForRequester',
  'getForRequester',
  'findPossibleDuplicates',
  'create',
  'addUpdate',
  'reopen',
] as const satisfies ReadonlyArray<keyof TicketService>;

export function withRetry(service: TicketService, options: RetryOptions = {}): TicketService {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 2_000;
  const sleep = options.sleep ?? defaultSleep;

  const wrapped = {} as Record<(typeof METHODS)[number], (...args: never[]) => Promise<unknown>>;
  for (const method of METHODS) {
    wrapped[method] = async (...args: never[]) => {
      for (let attempt = 1; ; attempt++) {
        try {
          const call = service[method] as (...a: never[]) => Promise<unknown>;
          return await call.apply(service, args);
        } catch (error) {
          const retryable = error instanceof TicketServiceError && error.retryable;
          if (!retryable || attempt >= maxAttempts) throw error;
          const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
          options.onRetry?.({ method, attempt, delayMs });
          await sleep(delayMs);
        }
      }
    };
  }
  return wrapped as unknown as TicketService;
}
