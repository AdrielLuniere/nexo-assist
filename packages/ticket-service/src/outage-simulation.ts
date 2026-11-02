import { TicketServiceError } from './errors.js';
import type { TicketService } from './ticket-service.js';

/**
 * Simula a indisponibilidade do sistema legado (PRD), para testes e demonstração.
 *
 * - `before`: a chamada falha sem executar nada (sistema fora do ar).
 * - `after`: a chamada executa e grava, mas a resposta se perde (o caso perigoso: sem idempotência,
 *   a repetição duplicaria a escrita).
 */
export type OutageMode = 'before' | 'after';

export interface OutagePlan {
  /** Decide, por método e número da chamada (1, 2, 3...), se esta chamada sofre uma queda. */
  readonly outageFor: (call: { method: keyof TicketService; callNumber: number }) => OutageMode | null;
}

const METHODS = [
  'listForRequester',
  'getForRequester',
  'findPossibleDuplicates',
  'create',
  'addUpdate',
  'reopen',
] as const satisfies ReadonlyArray<keyof TicketService>;

export function withSimulatedOutages(service: TicketService, plan: OutagePlan): TicketService {
  const counters = new Map<string, number>();
  const wrapped = {} as Record<(typeof METHODS)[number], (...args: never[]) => Promise<unknown>>;

  for (const method of METHODS) {
    wrapped[method] = async (...args: never[]) => {
      const callNumber = (counters.get(method) ?? 0) + 1;
      counters.set(method, callNumber);
      const mode = plan.outageFor({ method, callNumber });
      if (mode === 'before') throw new TicketServiceError('UNAVAILABLE', 'Sistema de chamados indisponível.');
      const call = service[method] as (...a: never[]) => Promise<unknown>;
      const result = await call.apply(service, args);
      if (mode === 'after') throw new TicketServiceError('UNAVAILABLE', 'Sistema de chamados indisponível.');
      return result;
    };
  }
  return wrapped as unknown as TicketService;
}
