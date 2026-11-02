import type {
  DraftPayload,
  Handoff,
  HandoffReason,
  HelpArticle,
  TicketCategory,
  TicketCode,
  TicketDetail,
  TicketDraft,
  TicketSummary,
} from '@nexo/shared';

/**
 * Portas que o agente usa para agir. A API cria uma instância por requisição, já vinculada
 * ao funcionário autenticado e à conversa. Por isso nenhuma operação recebe `employeeId`:
 * o modelo não tem como pedir dados de outro funcionário.
 *
 * O agente não importa Prisma nem a implementação do serviço de chamados
 * (verificado por `tests/architecture.test.ts`).
 */
export interface AgentToolPorts {
  searchHelpCenter(query: string, limit?: number): Promise<HelpArticle[]>;
  listMyTickets(options?: { onlyOpen?: boolean }): Promise<TicketSummary[]>;
  getMyTicket(code: TicketCode): Promise<TicketDetail | null>;
  findDuplicateTickets(input: {
    category: TicketCategory;
    title: string;
    description: string;
  }): Promise<TicketSummary[]>;
  /** Registra um rascunho pendente de confirmação. Não escreve no sistema de chamados. */
  proposeTicketDraft(payload: DraftPayload): Promise<TicketDraft>;
  /** Transfere a conversa: a partir daí o agente não responde até ser liberado. */
  requestHandoff(input: {
    reason: HandoffReason;
    summary: string;
    relatedTicketCode?: TicketCode;
  }): Promise<Handoff>;
}
