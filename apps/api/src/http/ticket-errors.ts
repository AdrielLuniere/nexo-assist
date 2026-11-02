import { TicketServiceError } from '@nexo/ticket-service';
import { AppError } from './app-error.js';

/**
 * Traduz erros do serviço de chamados para o contrato HTTP (docs/api-contracts.md).
 * Mensagens são seguras para o usuário e nunca incluem dados de terceiros.
 */
export function ticketErrorToAppError(error: TicketServiceError): AppError {
  switch (error.code) {
    case 'NOT_FOUND':
    case 'FORBIDDEN':
      // Mesma resposta para "não existe" e "é de outra pessoa": não revela a existência do chamado.
      return new AppError('NOT_FOUND', 'Chamado não encontrado.');
    case 'DUPLICATE_OPEN_TICKET':
      return new AppError('DUPLICATE_TICKET', error.message, error.details);
    case 'REOPEN_WINDOW_EXPIRED':
      return new AppError('REOPEN_WINDOW_EXPIRED', error.message, error.details);
    case 'INVALID_STATUS':
      return new AppError('CONFLICT', error.message, error.details);
    case 'CONFIRMATION_REQUIRED':
      return new AppError('DRAFT_NOT_PENDING', 'O rascunho precisa ser confirmado antes da operação.');
    case 'INVALID_INPUT':
      return new AppError('VALIDATION_ERROR', 'Dados inválidos para o chamado.', error.details);
    case 'UNAVAILABLE':
      return new AppError(
        'TICKET_SERVICE_UNAVAILABLE',
        'O sistema de chamados está indisponível no momento. Tente novamente em instantes.',
      );
  }
}
