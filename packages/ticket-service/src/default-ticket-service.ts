import {
  OPEN_TICKET_STATUSES,
  PriorityAssessmentSchema,
  REOPEN_WINDOW_DAYS,
  ReopenDraftPayloadSchema,
  type TicketCode,
  TicketCodeSchema,
  type TicketDetail,
  type TicketEventType,
  TicketFieldsSchema,
  TicketPrioritySchema,
  type TicketSummary,
  UpdateDraftPayloadSchema,
  priorityScopeConflict,
} from '@nexo/shared';
import type { ConfirmationGate } from './confirmation.js';
import {
  DUPLICATE_BLOCK_THRESHOLD,
  DUPLICATE_CANDIDATE_THRESHOLD,
  similarityScore,
} from './duplicates.js';
import { StoreConflictError, TicketServiceError } from './errors.js';
import { computeSlaDueAt, isOpenStatus, isOverdue } from './sla.js';
import type { TicketEventRecord, TicketRecord, TicketStore, TicketStoreOps } from './store.js';
import {
  type AddTicketUpdateCommand,
  type Clock,
  type CreateTicketCommand,
  type DuplicateCheckInput,
  type ReopenTicketCommand,
  type RequesterContext,
  type TicketListFilter,
  type TicketService,
  systemClock,
} from './ticket-service.js';

export interface TicketServiceDeps {
  readonly store: TicketStore;
  readonly confirmations: ConfirmationGate;
  readonly clock?: Clock;
}

interface SafeParseSchema<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}

function parse<T>(schema: SafeParseSchema<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `${issue.path.map(String).join('.') || label}: ${issue.message}`);
  throw new TicketServiceError('INVALID_INPUT', `Dados inválidos (${label}).`, { problems });
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function assertRequester(ctx: RequesterContext): void {
  if (typeof ctx?.employeeId !== 'string' || ctx.employeeId.trim() === '') {
    throw new TicketServiceError('INVALID_INPUT', 'Contexto do solicitante ausente.');
  }
}

function assertDraftIds(command: { confirmedDraftId: string; conversationId: string }): void {
  if (!command.confirmedDraftId || !command.conversationId) {
    throw new TicketServiceError('CONFIRMATION_REQUIRED', 'A operação exige um rascunho confirmado pelo funcionário.');
  }
}

function toSummary(ticket: TicketRecord, now: Date): TicketSummary {
  return {
    code: ticket.code,
    type: ticket.type,
    title: ticket.title,
    category: ticket.category,
    priority: ticket.priority,
    status: ticket.status,
    slaDueAt: ticket.slaDueAt.toISOString(),
    isOverdue: isOverdue(ticket, now),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

function toDetail(ticket: TicketRecord, events: TicketEventRecord[], now: Date): TicketDetail {
  return {
    ...toSummary(ticket, now),
    description: ticket.description,
    affectedScope: ticket.affectedScope,
    affectedDescription: ticket.affectedDescription,
    createdAt: ticket.createdAt.toISOString(),
    resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
    history: events.map((event) => ({
      id: event.id,
      type: event.type,
      actorType: event.actorType,
      comment: event.comment,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

/**
 * Implementação do sistema de chamados simulado.
 *
 * Invariantes:
 * - o solicitante vem sempre de `RequesterContext` (sessão), nunca do conteúdo do comando;
 * - toda leitura e escrita confere a propriedade do chamado;
 * - toda escrita exige rascunho confirmado e é idempotente pelo id do rascunho;
 * - cada escrita roda numa única transação.
 */
export function createTicketService(deps: TicketServiceDeps): TicketService {
  const { store, confirmations } = deps;
  const clock = deps.clock ?? systemClock;

  async function ownedTicket(ops: TicketStoreOps, ctx: RequesterContext, code: TicketCode): Promise<TicketRecord> {
    const ticket = await ops.findByCode(code);
    if (!ticket) throw new TicketServiceError('NOT_FOUND', 'Chamado não encontrado.');
    // A API responde 404 para os dois casos, para não revelar que o chamado existe.
    if (ticket.requesterId !== ctx.employeeId) {
      throw new TicketServiceError('FORBIDDEN', 'Chamado não encontrado.');
    }
    return ticket;
  }

  async function detailOf(ops: TicketStoreOps, ticketId: string): Promise<TicketDetail> {
    const ticket = await ops.findById(ticketId);
    if (!ticket) throw new TicketServiceError('NOT_FOUND', 'Chamado não encontrado.');
    return toDetail(ticket, await ops.listEvents(ticketId), clock.now());
  }

  /**
   * Se o rascunho já originou uma escrita, devolve o resultado dela em vez de escrever de novo.
   * O rascunho só vale para o mesmo funcionário, tipo de operação e (quando houver) chamado.
   */
  async function replayOf(
    ops: TicketStoreOps,
    ctx: RequesterContext,
    draftId: string,
    expected: { types: readonly TicketEventType[]; ticketCode?: TicketCode },
  ): Promise<TicketDetail | null> {
    const event = await ops.findEventByDraft(draftId);
    if (!event) return null;
    const ticket = await ops.findById(event.ticketId);
    const matches =
      ticket !== null &&
      ticket.requesterId === ctx.employeeId &&
      expected.types.includes(event.type) &&
      (expected.ticketCode === undefined || ticket.code === expected.ticketCode);
    if (!matches) {
      throw new TicketServiceError('CONFIRMATION_REQUIRED', 'Este rascunho já foi usado em outra operação.');
    }
    return detailOf(ops, event.ticketId);
  }

  async function writeOnce(
    ctx: RequesterContext,
    draftId: string,
    expected: { types: readonly TicketEventType[]; ticketCode?: TicketCode },
    work: (tx: TicketStoreOps) => Promise<TicketDetail>,
  ): Promise<TicketDetail> {
    try {
      return await store.transaction(async (tx) => {
        await tx.lockRequester(ctx.employeeId);
        return (await replayOf(tx, ctx, draftId, expected)) ?? (await work(tx));
      });
    } catch (error) {
      // Confirmação concorrente do mesmo rascunho: a outra transação venceu; devolve o resultado dela.
      if (error instanceof StoreConflictError) {
        const replay = await replayOf(store, ctx, draftId, expected);
        if (replay) return replay;
      }
      throw error;
    }
  }

  return {
    async listForRequester(ctx: RequesterContext, filter: TicketListFilter = {}): Promise<TicketSummary[]> {
      assertRequester(ctx);
      const now = clock.now();
      const statuses = filter.onlyOpen ? OPEN_TICKET_STATUSES : filter.statuses;
      let tickets = await store.listByRequester(ctx.employeeId, statuses ? { statuses } : {});
      if (filter.text?.trim()) {
        const words = normalizeText(filter.text).split(/\s+/).filter(Boolean);
        tickets = tickets.filter((ticket) => {
          const haystack = normalizeText(`${ticket.code} ${ticket.title} ${ticket.description}`);
          return words.every((word) => haystack.includes(word));
        });
      }
      return tickets
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.code.localeCompare(b.code))
        .map((ticket) => toSummary(ticket, now));
    },

    async getForRequester(ctx: RequesterContext, code: TicketCode): Promise<TicketDetail> {
      assertRequester(ctx);
      const parsed = parse(TicketCodeSchema, code, 'ticketCode');
      const ticket = await ownedTicket(store, ctx, parsed);
      return toDetail(ticket, await store.listEvents(ticket.id), clock.now());
    },

    async findPossibleDuplicates(ctx: RequesterContext, input: DuplicateCheckInput): Promise<TicketSummary[]> {
      assertRequester(ctx);
      const now = clock.now();
      const open = await store.listByRequester(ctx.employeeId, { statuses: OPEN_TICKET_STATUSES });
      return open
        .filter((ticket) => ticket.category === input.category)
        .map((ticket) => ({ ticket, score: similarityScore(input, ticket) }))
        .filter(({ score }) => score >= DUPLICATE_CANDIDATE_THRESHOLD)
        .sort((a, b) => b.score - a.score || a.ticket.code.localeCompare(b.ticket.code))
        .map(({ ticket }) => toSummary(ticket, now));
    },

    async create(ctx: RequesterContext, command: CreateTicketCommand): Promise<TicketDetail> {
      assertRequester(ctx);
      assertDraftIds(command);
      const fields = parse(TicketFieldsSchema, command.fields, 'fields');
      const assessment = parse(PriorityAssessmentSchema, command.priorityAssessment, 'priorityAssessment');
      if (assessment.priority !== fields.priority) {
        throw new TicketServiceError('INVALID_INPUT', 'A prioridade do rascunho não confere com a avaliação.');
      }
      const conflict = priorityScopeConflict(fields.priority, fields.affectedScope);
      if (conflict) throw new TicketServiceError('INVALID_INPUT', conflict);

      await confirmations.assertConfirmed({
        operation: 'CREATE',
        employeeId: ctx.employeeId,
        conversationId: command.conversationId,
        draftId: command.confirmedDraftId,
        fields,
        priorityAssessment: assessment,
      });

      return writeOnce(ctx, command.confirmedDraftId, { types: ['CREATED'] }, async (tx) => {
        const now = clock.now();
        const open = await tx.listByRequester(ctx.employeeId, { statuses: OPEN_TICKET_STATUSES });
        const duplicate = open
          .filter((ticket) => ticket.category === fields.category)
          .map((ticket) => ({ ticket, score: similarityScore(fields, ticket) }))
          .filter(({ score }) => score >= DUPLICATE_BLOCK_THRESHOLD)
          .sort((a, b) => b.score - a.score)[0];
        if (duplicate) {
          throw new TicketServiceError(
            'DUPLICATE_OPEN_TICKET',
            `Você já tem o chamado ${duplicate.ticket.code} aberto sobre o mesmo problema. Atualize-o em vez de abrir outro.`,
            { ticketCode: duplicate.ticket.code, title: duplicate.ticket.title },
          );
        }

        const number = await tx.nextNumber(fields.type);
        const slaDueAt = computeSlaDueAt(fields.priority, now);
        const ticket = await tx.insertTicket({
          code: `${fields.type}-${number}`,
          ...fields,
          status: 'WAITING_ANALYST',
          requesterId: ctx.employeeId,
          slaDueAt,
          firstResponseAt: null,
          resolvedAt: null,
          closedAt: null,
          originConversationId: command.conversationId,
          createdAt: now,
          updatedAt: now,
        });
        await tx.appendEvent({
          ticketId: ticket.id,
          type: 'CREATED',
          actorType: 'EMPLOYEE',
          actorId: ctx.employeeId,
          draftId: command.confirmedDraftId,
          comment: null,
          changes: { priorityAssessment: assessment, slaDueAt: slaDueAt.toISOString() },
          createdAt: now,
        });
        return detailOf(tx, ticket.id);
      });
    },

    async addUpdate(ctx: RequesterContext, command: AddTicketUpdateCommand): Promise<TicketDetail> {
      assertRequester(ctx);
      assertDraftIds(command);
      const ticketCode = parse(TicketCodeSchema, command.ticketCode, 'ticketCode');
      const comment = parse(UpdateDraftPayloadSchema.shape.comment, command.comment, 'comment');
      const newPriority =
        command.newPriority === undefined
          ? undefined
          : parse(TicketPrioritySchema, command.newPriority, 'newPriority');

      await confirmations.assertConfirmed({
        operation: 'UPDATE',
        employeeId: ctx.employeeId,
        conversationId: command.conversationId,
        draftId: command.confirmedDraftId,
        ticketCode,
        comment,
        ...(newPriority ? { newPriority } : {}),
      });

      return writeOnce(ctx, command.confirmedDraftId, { types: ['COMMENT_ADDED', 'PRIORITY_CHANGED'], ticketCode }, async (tx) => {
        const now = clock.now();
        const ticket = await ownedTicket(tx, ctx, ticketCode);
        if (!isOpenStatus(ticket.status)) {
          throw new TicketServiceError(
            'INVALID_STATUS',
            'Este chamado já foi resolvido ou fechado. Se ainda precisar, ele pode ser reaberto dentro do prazo.',
            { status: ticket.status },
          );
        }

        const priority = newPriority ?? ticket.priority;
        const conflict = priorityScopeConflict(priority, ticket.affectedScope);
        if (conflict) throw new TicketServiceError('INVALID_INPUT', conflict);

        // Cada atualização reinicia o prazo; chamado já vencido mantém o prazo vencido, para a
        // atualização do funcionário não esconder o atraso.
        const priorityChanged = priority !== ticket.priority;
        const slaDueAt = isOverdue(ticket, now) ? ticket.slaDueAt : computeSlaDueAt(priority, now);

        await tx.updateTicket(ticket.id, { priority, slaDueAt, updatedAt: now });
        await tx.appendEvent({
          ticketId: ticket.id,
          type: 'COMMENT_ADDED',
          actorType: 'EMPLOYEE',
          actorId: ctx.employeeId,
          draftId: command.confirmedDraftId,
          comment,
          changes: { slaDueAt: { from: ticket.slaDueAt.toISOString(), to: slaDueAt.toISOString() } },
          createdAt: now,
        });
        if (priorityChanged) {
          await tx.appendEvent({
            ticketId: ticket.id,
            type: 'PRIORITY_CHANGED',
            actorType: 'EMPLOYEE',
            actorId: ctx.employeeId,
            draftId: command.confirmedDraftId,
            comment: null,
            changes: { priority: { from: ticket.priority, to: priority } },
            createdAt: now,
          });
        }
        return detailOf(tx, ticket.id);
      });
    },

    async reopen(ctx: RequesterContext, command: ReopenTicketCommand): Promise<TicketDetail> {
      assertRequester(ctx);
      assertDraftIds(command);
      const ticketCode = parse(TicketCodeSchema, command.ticketCode, 'ticketCode');
      const reason = parse(ReopenDraftPayloadSchema.shape.reason, command.reason, 'reason');

      await confirmations.assertConfirmed({
        operation: 'REOPEN',
        employeeId: ctx.employeeId,
        conversationId: command.conversationId,
        draftId: command.confirmedDraftId,
        ticketCode,
        reason,
      });

      return writeOnce(ctx, command.confirmedDraftId, { types: ['REOPENED'], ticketCode }, async (tx) => {
        const now = clock.now();
        const ticket = await ownedTicket(tx, ctx, ticketCode);
        if (ticket.status !== 'RESOLVED') {
          throw new TicketServiceError(
            'INVALID_STATUS',
            isOpenStatus(ticket.status)
              ? 'Este chamado ainda está aberto. Atualize-o em vez de reabrir.'
              : 'Este chamado foi fechado e não pode ser reaberto.',
            { status: ticket.status },
          );
        }
        const resolvedAt = ticket.resolvedAt ?? ticket.updatedAt;
        const windowMs = REOPEN_WINDOW_DAYS * 24 * 3_600_000;
        if (now.getTime() - resolvedAt.getTime() > windowMs) {
          throw new TicketServiceError(
            'REOPEN_WINDOW_EXPIRED',
            `Chamados só podem ser reabertos até ${REOPEN_WINDOW_DAYS} dias após a resolução.`,
            { resolvedAt: resolvedAt.toISOString() },
          );
        }

        const slaDueAt = computeSlaDueAt(ticket.priority, now);
        await tx.updateTicket(ticket.id, { status: 'WAITING_ANALYST', resolvedAt: null, slaDueAt, updatedAt: now });
        await tx.appendEvent({
          ticketId: ticket.id,
          type: 'REOPENED',
          actorType: 'EMPLOYEE',
          actorId: ctx.employeeId,
          draftId: command.confirmedDraftId,
          comment: reason,
          changes: {
            status: { from: ticket.status, to: 'WAITING_ANALYST' },
            slaDueAt: { from: ticket.slaDueAt.toISOString(), to: slaDueAt.toISOString() },
          },
          createdAt: now,
        });
        return detailOf(tx, ticket.id);
      });
    },
  };
}
