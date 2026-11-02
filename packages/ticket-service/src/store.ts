import type {
  ActorType,
  AffectedScope,
  TicketCategory,
  TicketEventType,
  TicketPriority,
  TicketStatus,
  TicketType,
} from '@nexo/shared';

/**
 * Porta de persistência do serviço de chamados. O serviço não conhece Prisma nem SQL:
 * `apps/api` fornece a implementação real (PostgreSQL) e `in-memory.ts` a dos testes unitários.
 *
 * Contrato que as implementações precisam cumprir:
 * - `transaction` é atômica: se o callback lançar, nada do que ele escreveu permanece.
 * - `appendEvent` lança `StoreConflictError` quando já existe evento com o mesmo (draftId, type).
 * - Falhas transitórias de infraestrutura viram `TicketServiceError('UNAVAILABLE')`.
 */

export interface TicketRecord {
  readonly id: string;
  readonly code: string;
  readonly type: TicketType;
  readonly title: string;
  readonly description: string;
  readonly category: TicketCategory;
  readonly priority: TicketPriority;
  readonly status: TicketStatus;
  readonly affectedScope: AffectedScope;
  readonly affectedDescription: string;
  readonly requesterId: string;
  readonly slaDueAt: Date;
  readonly firstResponseAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly closedAt: Date | null;
  readonly originConversationId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TicketEventRecord {
  readonly id: string;
  readonly ticketId: string;
  readonly type: TicketEventType;
  readonly actorType: ActorType;
  readonly actorId: string | null;
  readonly draftId: string | null;
  readonly comment: string | null;
  readonly changes: unknown;
  readonly createdAt: Date;
}

export type NewTicket = Omit<TicketRecord, 'id'>;

export type TicketPatch = Partial<
  Pick<TicketRecord, 'priority' | 'status' | 'slaDueAt' | 'resolvedAt' | 'closedAt'>
> & { readonly updatedAt: Date };

export type NewTicketEvent = Omit<TicketEventRecord, 'id'>;

export interface TicketStoreOps {
  /**
   * Serializa as escritas de um mesmo solicitante dentro da transação corrente
   * (a checagem de duplicidade e a criação precisam ser atômicas).
   */
  lockRequester(requesterId: string): Promise<void>;
  findByCode(code: string): Promise<TicketRecord | null>;
  findById(id: string): Promise<TicketRecord | null>;
  /** Somente chamados do solicitante. */
  listByRequester(requesterId: string, filter?: { statuses?: readonly TicketStatus[] }): Promise<TicketRecord[]>;
  /** Eventos do chamado, do mais antigo ao mais recente. */
  listEvents(ticketId: string): Promise<TicketEventRecord[]>;
  /** Qualquer evento originado pelo rascunho (chave de idempotência). */
  findEventByDraft(draftId: string): Promise<TicketEventRecord | null>;
  /** Próximo número da sequência do tipo, incrementado atomicamente. */
  nextNumber(type: TicketType): Promise<number>;
  insertTicket(ticket: NewTicket): Promise<TicketRecord>;
  updateTicket(id: string, patch: TicketPatch): Promise<TicketRecord>;
  appendEvent(event: NewTicketEvent): Promise<TicketEventRecord>;
}

export interface TicketStore extends TicketStoreOps {
  transaction<T>(work: (tx: TicketStoreOps) => Promise<T>): Promise<T>;
}
