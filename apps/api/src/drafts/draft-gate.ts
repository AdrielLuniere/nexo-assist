import { DraftPayloadSchema } from '@nexo/shared';
import {
  type ConfirmationCheck,
  type ConfirmationGate,
  TicketServiceError,
  draftMatchesCheck,
} from '@nexo/ticket-service';
import type { DraftRepository } from './draft-repository.js';

/**
 * Porta de confirmação do serviço de chamados, lida sobre os rascunhos da API.
 *
 * É a última barreira antes de qualquer escrita: mesmo que uma rota tenha um defeito, o serviço só
 * escreve se existir rascunho CONFIRMED do mesmo funcionário, da mesma conversa, da mesma operação e
 * com exatamente o conteúdo que será gravado.
 */
export function createDraftRepositoryGate(drafts: DraftRepository): ConfirmationGate {
  const refuse = () =>
    new TicketServiceError(
      'CONFIRMATION_REQUIRED',
      'O funcionário precisa confirmar o rascunho antes de criar ou atualizar o chamado.',
    );

  return {
    async assertConfirmed(check: ConfirmationCheck) {
      const draft = await drafts.findById(check.draftId);
      if (
        !draft ||
        draft.status !== 'CONFIRMED' ||
        draft.employeeId !== check.employeeId ||
        draft.conversationOwnerId !== check.employeeId ||
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
