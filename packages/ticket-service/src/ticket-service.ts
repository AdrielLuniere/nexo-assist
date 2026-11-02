import type {
  PriorityAssessment,
  TicketCategory,
  TicketCode,
  TicketDetail,
  TicketFields,
  TicketPriority,
  TicketStatus,
  TicketSummary,
} from '@nexo/shared';

/**
 * Contrato do serviço de chamados simulado (o "sistema legado").
 *
 * Fronteira de segurança: este serviço é o único caminho de escrita em chamados.
 * - `RequesterContext` vem sempre da sessão autenticada, nunca do modelo nem do corpo da requisição.
 * - Leituras retornam apenas chamados do próprio solicitante (regra de privacidade).
 * - Escritas exigem um rascunho confirmado pelo funcionário (`confirmedDraftId`) e aplicam as
 *   regras de duplicidade, reabertura e prazo.
 *
 * Implementação: `default-ticket-service.ts` (P0.2). Persistência pela porta `TicketStore`;
 * confirmação pela porta `ConfirmationGate`.
 */

export interface RequesterContext {
  readonly employeeId: string;
}

export interface TicketListFilter {
  readonly statuses?: readonly TicketStatus[];
  readonly onlyOpen?: boolean;
  readonly text?: string;
}

export interface DuplicateCheckInput {
  readonly category: TicketCategory;
  readonly title: string;
  readonly description: string;
}

/** Comando de escrita: só existe após confirmação explícita do rascunho. */
interface ConfirmedCommand {
  readonly confirmedDraftId: string;
  readonly conversationId: string;
}

export interface CreateTicketCommand extends ConfirmedCommand {
  readonly fields: TicketFields;
  readonly priorityAssessment: PriorityAssessment;
}

export interface AddTicketUpdateCommand extends ConfirmedCommand {
  readonly ticketCode: TicketCode;
  readonly comment: string;
  readonly newPriority?: TicketPriority;
}

export interface ReopenTicketCommand extends ConfirmedCommand {
  readonly ticketCode: TicketCode;
  readonly reason: string;
}

export interface TicketService {
  listForRequester(ctx: RequesterContext, filter?: TicketListFilter): Promise<TicketSummary[]>;
  getForRequester(ctx: RequesterContext, code: TicketCode): Promise<TicketDetail>;
  /** Chamados abertos do solicitante possivelmente sobre o mesmo problema (regra de duplicidade). */
  findPossibleDuplicates(ctx: RequesterContext, input: DuplicateCheckInput): Promise<TicketSummary[]>;
  create(ctx: RequesterContext, command: CreateTicketCommand): Promise<TicketDetail>;
  addUpdate(ctx: RequesterContext, command: AddTicketUpdateCommand): Promise<TicketDetail>;
  reopen(ctx: RequesterContext, command: ReopenTicketCommand): Promise<TicketDetail>;
}

/** Relógio injetável: prazos e janela de reabertura dependem do tempo e precisam ser testáveis. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
