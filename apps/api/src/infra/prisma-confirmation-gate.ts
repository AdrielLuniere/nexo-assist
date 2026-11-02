import {
  type ConfirmationCheck,
  type ConfirmationGate,
  TicketServiceError,
  draftMatchesCheck,
} from '@nexo/ticket-service';
import { DraftPayloadSchema } from '@nexo/shared';
import type { PrismaClient } from '../generated/prisma/client.js';
import { mapPrismaError } from './prisma-ticket-store.js';

/**
 * Confirma, na tabela `ticket_drafts` (propriedade da API), que o funcionário autenticado
 * confirmou este rascunho, nesta conversa, com exatamente o conteúdo que será escrito.
 * A rota de confirmação (planejada) marca o rascunho como CONFIRMED antes de chamar o serviço.
 */
export function createPrismaConfirmationGate(prisma: PrismaClient): ConfirmationGate {
  const refuse = () =>
    new TicketServiceError(
      'CONFIRMATION_REQUIRED',
      'O funcionário precisa confirmar o rascunho antes de criar ou atualizar o chamado.',
    );

  return {
    async assertConfirmed(check: ConfirmationCheck) {
      let draft;
      try {
        draft = await prisma.ticketDraft.findUnique({ where: { id: check.draftId } });
      } catch (error) {
        throw mapPrismaError(error);
      }
      if (
        !draft ||
        draft.status !== 'CONFIRMED' ||
        draft.employeeId !== check.employeeId ||
        draft.conversationId !== check.conversationId ||
        draft.operation !== check.operation
      ) {
        throw refuse();
      }
      const payload = DraftPayloadSchema.safeParse(draft.payload);
      if (!payload.success || !draftMatchesCheck(payload.data, check)) throw refuse();
    },
  };
}
