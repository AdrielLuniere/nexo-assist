import {
  type DraftConfirmationResponse,
  type DraftPayload,
  DraftPayloadSchema,
  type TicketDetail,
  type TicketDraft,
  type User,
} from '@nexo/shared';
import { type TicketService, TicketServiceError, type TicketServiceErrorCode } from '@nexo/ticket-service';
import { AppError } from '../http/app-error.js';
import type { DraftRecord, DraftRepository } from './draft-repository.js';

/**
 * Confirmação e descarte de rascunhos (Anexo A: o agente propõe; o funcionário confirma).
 *
 * Estados: PENDING → CONFIRMED (confirmou) → resultado gravado. PENDING → DISCARDED (descartou).
 *
 * Garantias:
 * - Propriedade: rascunho, conversa e usuário da sessão precisam coincidir. Qualquer divergência
 *   responde 404, igual a "não existe", para não revelar rascunhos alheios. O funcionário vem da
 *   sessão; nenhum `employeeId` do cliente é lido.
 * - Uma única confirmação vence: a transição PENDING → CONFIRMED é compare-and-swap.
 * - Repetir é seguro: confirmar de novo um rascunho CONFIRMED re-executa a operação, que é
 *   idempotente no serviço de chamados (chave = id do rascunho). Isso cobre a falha entre marcar
 *   CONFIRMED e efetivar (a retentativa conclui o que faltou) e confirmações simultâneas.
 * - Rejeição de negócio (duplicidade, janela de reabertura...) devolve o rascunho a PENDING: nada
 *   foi escrito, então não deve ficar "confirmado". Falha transitória ou desconhecida mantém
 *   CONFIRMED, porque a escrita pode ter ocorrido e a retentativa a reconcilia.
 */

export interface DraftService {
  confirm(user: User, conversationId: string, draftId: string): Promise<DraftConfirmationResponse>;
  discard(user: User, conversationId: string, draftId: string): Promise<{ draft: TicketDraft }>;
}

export interface DraftServiceDeps {
  readonly drafts: DraftRepository;
  readonly tickets: TicketService;
  readonly now?: () => Date;
}

/** Recusas de negócio: a operação falhou sem escrever nada e repetir não ajuda sem mudar o contexto. */
const REVERTING_CODES: ReadonlySet<TicketServiceErrorCode> = new Set([
  'DUPLICATE_OPEN_TICKET',
  'REOPEN_WINDOW_EXPIRED',
  'INVALID_STATUS',
  'INVALID_INPUT',
  'NOT_FOUND',
  'FORBIDDEN',
]);

const notFound = () => new AppError('NOT_FOUND', 'Rascunho não encontrado.');

function toDraft(record: DraftRecord, payload: DraftPayload): TicketDraft {
  return {
    id: record.id,
    conversationId: record.conversationId,
    status: record.status,
    payload,
    resultTicketCode: record.resultTicketCode,
    createdAt: record.createdAt.toISOString(),
    confirmedAt: record.confirmedAt?.toISOString() ?? null,
  };
}

const RESULT_TEXT = {
  CREATE: (detail: TicketDetail) => `Pronto! Abri o chamado ${detail.code}: ${detail.title}.`,
  UPDATE: (detail: TicketDetail) => `Pronto! Atualizei o chamado ${detail.code} com as novas informações.`,
  REOPEN: (detail: TicketDetail) => `Pronto! Reabri o chamado ${detail.code}. Um analista vai retomar o atendimento.`,
} as const;

export function createDraftService(deps: DraftServiceDeps): DraftService {
  const { drafts, tickets } = deps;
  const now = deps.now ?? (() => new Date());

  /** Rascunho do próprio usuário na conversa informada; qualquer outra coisa é "não encontrado". */
  async function loadOwned(user: User, conversationId: string, draftId: string) {
    if (user.role !== 'EMPLOYEE') throw notFound();
    const record = await drafts.findById(draftId);
    if (
      !record ||
      record.employeeId !== user.id ||
      record.conversationOwnerId !== user.id ||
      record.conversationId !== conversationId
    ) {
      throw notFound();
    }
    const parsed = DraftPayloadSchema.safeParse(record.payload);
    if (!parsed.success) throw new AppError('INTERNAL_ERROR', 'Erro interno. Tente novamente em instantes.');
    return { record, payload: parsed.data };
  }

  function execute(user: User, record: DraftRecord, payload: DraftPayload): Promise<TicketDetail> {
    const ctx = { employeeId: user.id };
    const base = { confirmedDraftId: record.id, conversationId: record.conversationId };
    switch (payload.operation) {
      case 'CREATE':
        return tickets.create(ctx, { ...base, fields: payload.fields, priorityAssessment: payload.priorityAssessment });
      case 'UPDATE':
        return tickets.addUpdate(ctx, {
          ...base,
          ticketCode: payload.ticketCode,
          comment: payload.comment,
          ...(payload.priorityAssessment ? { newPriority: payload.priorityAssessment.priority } : {}),
        });
      case 'REOPEN':
        return tickets.reopen(ctx, { ...base, ticketCode: payload.ticketCode, reason: payload.reason });
    }
  }

  return {
    async confirm(user, conversationId, draftId) {
      const { record: initial, payload } = await loadOwned(user, conversationId, draftId);
      if (initial.conversationStatus === 'CLOSED') {
        throw new AppError('INVALID_STATE_TRANSITION', 'A conversa está encerrada.');
      }
      if (initial.status === 'DISCARDED' || initial.status === 'SUPERSEDED') {
        throw new AppError('DRAFT_NOT_PENDING', 'Este rascunho não está mais pendente.');
      }

      let current = initial;
      if (current.status === 'PENDING') {
        const won = await drafts.transition(draftId, 'PENDING', 'CONFIRMED', now());
        if (!won) {
          // Outra requisição mudou o estado primeiro: só seguimos se ela confirmou.
          current = (await drafts.findById(draftId)) ?? current;
          if (current.status !== 'CONFIRMED') {
            throw new AppError('DRAFT_NOT_PENDING', 'Este rascunho não está mais pendente.');
          }
        }
      }

      let detail: TicketDetail;
      try {
        detail = current.resultTicketCode
          ? await tickets.getForRequester({ employeeId: user.id }, current.resultTicketCode)
          : await execute(user, current, payload);
      } catch (error) {
        if (error instanceof TicketServiceError && REVERTING_CODES.has(error.code)) {
          await drafts.revertToPending(draftId);
        }
        throw error;
      }

      await drafts.markExecuted(draftId, detail.code);
      const message = await drafts.recordResultMessage({
        draftId,
        conversationId,
        content: RESULT_TEXT[payload.operation](detail),
        blocks: [
          { type: 'text', text: RESULT_TEXT[payload.operation](detail) },
          {
            type: 'ticket_cards',
            tickets: [
              {
                code: detail.code,
                type: detail.type,
                title: detail.title,
                category: detail.category,
                priority: detail.priority,
                status: detail.status,
                slaDueAt: detail.slaDueAt,
                isOverdue: detail.isOverdue,
                updatedAt: detail.updatedAt,
              },
            ],
          },
        ],
      });

      const final = (await drafts.findById(draftId)) ?? current;
      return { draft: toDraft(final, payload), ticket: detail, message };
    },

    async discard(user, conversationId, draftId) {
      const { record, payload } = await loadOwned(user, conversationId, draftId);
      if (record.status === 'DISCARDED') return { draft: toDraft(record, payload) };
      if (record.status !== 'PENDING') {
        throw new AppError('DRAFT_NOT_PENDING', 'Este rascunho não está mais pendente.');
      }
      const won = await drafts.transition(draftId, 'PENDING', 'DISCARDED', now());
      const after = (await drafts.findById(draftId)) ?? record;
      // Perdeu a corrida para uma confirmação: não descarta o que já foi confirmado.
      if (!won && after.status !== 'DISCARDED') {
        throw new AppError('DRAFT_NOT_PENDING', 'Este rascunho não está mais pendente.');
      }
      return { draft: toDraft(after, payload) };
    },
  };
}
