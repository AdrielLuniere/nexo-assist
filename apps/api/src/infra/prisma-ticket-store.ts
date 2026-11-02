import {
  type NewTicket,
  type NewTicketEvent,
  StoreConflictError,
  type TicketEventRecord,
  type TicketPatch,
  type TicketRecord,
  TicketServiceError,
  type TicketStore,
  type TicketStoreOps,
} from '@nexo/ticket-service';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { isTransientDatabaseError } from './prisma-errors.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** Traduz erros do Prisma para os do serviço: nunca vaza SQL, string de conexão ou credenciais. */
export function mapPrismaError(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new StoreConflictError('violação de unicidade');
  }
  if (isTransientDatabaseError(error)) {
    return new TicketServiceError('UNAVAILABLE', 'Sistema de chamados indisponível.');
  }
  return error;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw mapPrismaError(error);
  }
}

function toTicket(row: Prisma.TicketGetPayload<object>): TicketRecord {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    title: row.title,
    description: row.description,
    category: row.category,
    priority: row.priority,
    status: row.status,
    affectedScope: row.affectedScope,
    affectedDescription: row.affectedDescription,
    requesterId: row.requesterId,
    slaDueAt: row.slaDueAt,
    firstResponseAt: row.firstResponseAt,
    resolvedAt: row.resolvedAt,
    closedAt: row.closedAt,
    originConversationId: row.originConversationId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEvent(row: Prisma.TicketEventGetPayload<object>): TicketEventRecord {
  return {
    id: row.id,
    ticketId: row.ticketId,
    type: row.type,
    actorType: row.actorType,
    actorId: row.actorId,
    draftId: row.draftId,
    comment: row.comment,
    changes: row.changes,
    createdAt: row.createdAt,
  };
}

function opsOver(db: Db): TicketStoreOps {
  return {
    async lockRequester(requesterId) {
      // Lock de transação (liberado no commit/rollback) que serializa as escritas de um solicitante.
      await guarded(() => db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ticket-requester:${requesterId}`}, 0))`);
    },
    async findByCode(code) {
      const row = await guarded(() => db.ticket.findUnique({ where: { code } }));
      return row ? toTicket(row) : null;
    },
    async findById(id) {
      const row = await guarded(() => db.ticket.findUnique({ where: { id } }));
      return row ? toTicket(row) : null;
    },
    async listByRequester(requesterId, filter) {
      const rows = await guarded(() =>
        db.ticket.findMany({
          where: { requesterId, ...(filter?.statuses ? { status: { in: [...filter.statuses] } } : {}) },
          orderBy: [{ updatedAt: 'desc' }, { code: 'asc' }],
        }),
      );
      return rows.map(toTicket);
    },
    async listEvents(ticketId) {
      const rows = await guarded(() =>
        db.ticketEvent.findMany({ where: { ticketId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      );
      return rows.map(toEvent);
    },
    async findEventByDraft(draftId) {
      const row = await guarded(() => db.ticketEvent.findFirst({ where: { draftId }, orderBy: { createdAt: 'asc' } }));
      return row ? toEvent(row) : null;
    },
    async nextNumber(type) {
      // UPDATE ... SET lastNumber = lastNumber + 1 é atômico: o lock da linha serializa quem concorre.
      const row = await guarded(() =>
        db.ticketSequence.update({ where: { type }, data: { lastNumber: { increment: 1 } } }),
      );
      return row.lastNumber;
    },
    async insertTicket(ticket: NewTicket) {
      const row = await guarded(() => db.ticket.create({ data: ticket }));
      return toTicket(row);
    },
    async updateTicket(id, patch: TicketPatch) {
      const row = await guarded(() => db.ticket.update({ where: { id }, data: patch }));
      return toTicket(row);
    },
    async appendEvent(event: NewTicketEvent) {
      const { changes, ...rest } = event;
      const row = await guarded(() =>
        db.ticketEvent.create({
          data: { ...rest, changes: changes === null || changes === undefined ? Prisma.DbNull : (changes as Prisma.InputJsonValue) },
        }),
      );
      return toEvent(row);
    },
  };
}

/**
 * Persistência do serviço de chamados em PostgreSQL. A transação usa o nível padrão (READ COMMITTED);
 * a consistência vem de três mecanismos combinados: advisory lock por solicitante (duplicidade),
 * incremento atômico da sequência (códigos) e índice único (draftId, type) (idempotência).
 */
export function createPrismaTicketStore(prisma: PrismaClient): TicketStore {
  return {
    ...opsOver(prisma),
    async transaction(work) {
      return guarded(() => prisma.$transaction((tx) => work(opsOver(tx)), { maxWait: 5_000, timeout: 15_000 }));
    },
  };
}
