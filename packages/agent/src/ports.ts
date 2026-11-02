import type {
  DraftPayload,
  HandoffReason,
  HelpArticle,
  TicketCategory,
  TicketCode,
  TicketDetail,
  TicketSummary,
} from '@nexo/shared';

/**
 * Portas de LEITURA que o agente usa durante uma resposta. A API cria uma instância por requisição, já
 * vinculada ao funcionário autenticado. Por isso nenhuma operação recebe `employeeId`: o modelo não
 * tem como pedir dados de outro funcionário, nem por texto, nem por argumento de ferramenta.
 *
 * O agente não escreve nada durante a execução. Rascunho e transferência são apenas PLANEJADOS
 * (`PlannedHandoff`, `DraftPayload` no resultado) e a API os grava de uma vez, na mesma transação
 * que publica a resposta. Assim uma falha no meio da execução não deixa efeito pela metade, e uma
 * retentativa não duplica nada.
 *
 * O agente não importa Prisma nem a implementação do serviço de chamados
 * (verificado por `tests/architecture.test.ts`).
 */
export interface AgentReadPorts {
  searchHelpCenter(query: string, limit: number): Promise<HelpArticle[]>;
  listMyTickets(options?: { onlyOpen?: boolean }): Promise<TicketSummary[]>;
  /** `null` quando o chamado não existe OU é de outra pessoa (indistinguíveis de propósito). */
  getMyTicket(code: TicketCode): Promise<TicketDetail | null>;
  /** Chamados abertos do próprio funcionário possivelmente sobre o mesmo problema. */
  findDuplicateTickets(input: { category: TicketCategory; title: string; description: string }): Promise<TicketSummary[]>;
}

/** Transferência decidida na resposta; a API a grava junto com a mensagem do agente. */
export interface PlannedHandoff {
  readonly reason: HandoffReason;
  /** Resumo para o analista não precisar perguntar tudo de novo. */
  readonly summary: string;
  readonly relatedTicketCode: TicketCode | null;
  /** `EMPLOYEE` quando o próprio funcionário pediu; `AGENT` nos demais motivos. */
  readonly requestedBy: 'EMPLOYEE' | 'AGENT';
  /** `true` quando foi a política determinística (e não o modelo) que acionou a transferência. */
  readonly automatic: boolean;
}

/** Rascunho decidido na resposta; a API o grava como PENDING (o funcionário confirma depois). */
export interface PlannedDraft {
  readonly payload: DraftPayload;
}
