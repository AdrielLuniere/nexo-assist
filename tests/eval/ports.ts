import { DUPLICATE_CANDIDATE_THRESHOLD, similarityScore } from '@nexo/ticket-service';
import { OPEN_TICKET_STATUSES, type TicketSummary } from '@nexo/shared';
import { ANA_TICKETS, fakePorts } from '../../packages/agent/src/agent.fixtures.js';

/**
 * Portas da Ana para a avaliação. A duplicidade usa a MESMA regra do serviço de chamados (mesma
 * categoria, chamado aberto e similaridade acima do limiar), no lugar da heurística de palavras das
 * portas falsas dos testes do pacote, que marcaria qualquer texto com "notebook" como duplicado.
 */
export function evalPorts() {
  const ports = fakePorts();
  ports.findDuplicateTickets.mockImplementation(async (input) =>
    ANA_TICKETS.filter((t) => OPEN_TICKET_STATUSES.includes(t.status) && t.category === input.category)
      .filter((t) => similarityScore(input, t) >= DUPLICATE_CANDIDATE_THRESHOLD)
      .map(({ description: _d, affectedScope: _s, affectedDescription: _a, createdAt: _c, resolvedAt: _r, history: _h, ...summary }): TicketSummary => summary),
  );
  return ports;
}
