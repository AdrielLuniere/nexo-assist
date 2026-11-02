import type { AgentReadPorts } from '@nexo/agent';
import { type TicketService, TicketServiceError } from '@nexo/ticket-service';
import type { HelpCenter } from './help-center.js';

/**
 * Portas de leitura do agente, vinculadas ao funcionário DA SESSÃO. O `employeeId` vem do servidor e
 * fica preso aqui; nenhuma ferramenta do agente recebe esse dado do modelo.
 *
 * As consultas passam pelo serviço de chamados, que já filtra por solicitante e aplica retentativas
 * contra as quedas curtas do sistema legado.
 */
export function createAgentReadPorts(deps: { employeeId: string; tickets: TicketService; helpCenter: HelpCenter }): AgentReadPorts {
  const ctx = { employeeId: deps.employeeId };
  return {
    searchHelpCenter: (query, limit) => deps.helpCenter.search(query, limit),
    listMyTickets: (options) => deps.tickets.listForRequester(ctx, options?.onlyOpen ? { onlyOpen: true } : {}),
    async getMyTicket(code) {
      try {
        return await deps.tickets.getForRequester(ctx, code);
      } catch (error) {
        // Inexistente e alheio são indistinguíveis também para o modelo.
        if (error instanceof TicketServiceError && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) return null;
        throw error;
      }
    },
    findDuplicateTickets: (input) => deps.tickets.findPossibleDuplicates(ctx, input),
  };
}
