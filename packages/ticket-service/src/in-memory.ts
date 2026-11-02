import type { DraftPayload } from '@nexo/shared';
import { type ConfirmationCheck, type ConfirmationGate, draftMatchesCheck } from './confirmation.js';
import { StoreConflictError, TicketServiceError } from './errors.js';
import type {
  NewTicket,
  NewTicketEvent,
  TicketEventRecord,
  TicketPatch,
  TicketRecord,
  TicketStore,
  TicketStoreOps,
} from './store.js';

/**
 * Implementações em memória das portas do serviço, para testes unitários rápidos e para
 * desenvolver o agente sem banco. O PostgreSQL real é exercitado pelos testes de integração.
 */

interface State {
  tickets: Map<string, TicketRecord>;
  events: TicketEventRecord[];
  sequences: Map<string, number>;
  nextId: number;
}

export interface InMemoryTicketStoreOptions {
  /** Chamados já existentes (dados de exemplo). */
  readonly tickets?: readonly TicketRecord[];
  /** Último número usado por tipo, ex.: `{ INC: 20311, REQ: 10442 }`. */
  readonly sequences?: Readonly<Record<string, number>>;
}

function cloneState(state: State): State {
  return {
    tickets: new Map(state.tickets),
    events: [...state.events],
    sequences: new Map(state.sequences),
    nextId: state.nextId,
  };
}

export function createInMemoryTicketStore(options: InMemoryTicketStoreOptions = {}): TicketStore {
  let state: State = {
    tickets: new Map((options.tickets ?? []).map((ticket) => [ticket.id, ticket])),
    events: [],
    sequences: new Map(Object.entries(options.sequences ?? {})),
    nextId: 1,
  };
  // Transações são serializadas, como se cada uma segurasse um lock global.
  let queue: Promise<unknown> = Promise.resolve();

  const opsOver = (get: () => State): TicketStoreOps => ({
    async lockRequester() {},
    async findByCode(code) {
      return [...get().tickets.values()].find((ticket) => ticket.code === code) ?? null;
    },
    async findById(id) {
      return get().tickets.get(id) ?? null;
    },
    async listByRequester(requesterId, filter) {
      return [...get().tickets.values()].filter(
        (ticket) =>
          ticket.requesterId === requesterId && (!filter?.statuses || filter.statuses.includes(ticket.status)),
      );
    },
    async listEvents(ticketId) {
      return get()
        .events.filter((event) => event.ticketId === ticketId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    },
    async findEventByDraft(draftId) {
      return get().events.find((event) => event.draftId === draftId) ?? null;
    },
    async nextNumber(type) {
      const next = (get().sequences.get(type) ?? 0) + 1;
      get().sequences.set(type, next);
      return next;
    },
    async insertTicket(ticket: NewTicket) {
      const s = get();
      if ([...s.tickets.values()].some((existing) => existing.code === ticket.code)) {
        throw new StoreConflictError(`código duplicado: ${ticket.code}`);
      }
      const record: TicketRecord = { ...ticket, id: `tkt_${s.nextId++}` };
      s.tickets.set(record.id, record);
      return record;
    },
    async updateTicket(id, patch: TicketPatch) {
      const s = get();
      const current = s.tickets.get(id);
      if (!current) throw new TicketServiceError('NOT_FOUND', 'Chamado não encontrado.');
      const updated: TicketRecord = { ...current, ...patch };
      s.tickets.set(id, updated);
      return updated;
    },
    async appendEvent(event: NewTicketEvent) {
      const s = get();
      if (event.draftId && s.events.some((e) => e.draftId === event.draftId && e.type === event.type)) {
        throw new StoreConflictError('rascunho já originou este tipo de evento');
      }
      const record: TicketEventRecord = { ...event, id: `evt_${s.nextId++}` };
      s.events.push(record);
      return record;
    },
  });

  return {
    ...opsOver(() => state),
    transaction<T>(work: (tx: TicketStoreOps) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        const working = cloneState(state);
        const result = await work(opsOver(() => working));
        state = working; // commit
        return result;
      };
      const result = queue.then(run, run);
      queue = result.catch(() => undefined);
      return result;
    },
  };
}

export interface InMemoryDraft {
  readonly id: string;
  readonly employeeId: string;
  readonly conversationId: string;
  readonly payload: DraftPayload;
  readonly status: 'PENDING' | 'CONFIRMED' | 'DISCARDED' | 'SUPERSEDED';
}

export interface InMemoryConfirmationGate extends ConfirmationGate {
  /** Registra um rascunho (o agente propôs). */
  addDraft(draft: InMemoryDraft): void;
  /** O funcionário confirmou. */
  confirm(draftId: string): void;
}

export function createInMemoryConfirmationGate(): InMemoryConfirmationGate {
  const drafts = new Map<string, InMemoryDraft>();
  return {
    addDraft: (draft) => void drafts.set(draft.id, draft),
    confirm(draftId) {
      const draft = drafts.get(draftId);
      if (draft) drafts.set(draftId, { ...draft, status: 'CONFIRMED' });
    },
    async assertConfirmed(check: ConfirmationCheck) {
      const draft = drafts.get(check.draftId);
      const ok =
        draft !== undefined &&
        draft.status === 'CONFIRMED' &&
        draft.employeeId === check.employeeId &&
        draft.conversationId === check.conversationId &&
        draftMatchesCheck(draft.payload, check);
      if (!ok) {
        throw new TicketServiceError(
          'CONFIRMATION_REQUIRED',
          'O funcionário precisa confirmar o rascunho antes de criar ou atualizar o chamado.',
        );
      }
    },
  };
}
