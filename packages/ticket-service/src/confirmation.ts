import type { DraftPayload, PriorityAssessment, TicketCode, TicketFields, TicketPriority } from '@nexo/shared';

/**
 * Confirmação obrigatória (Anexo A: "só cria ou atualiza o chamado depois da confirmação").
 *
 * Os rascunhos pertencem à API. O serviço de chamados não os lê: pergunta a uma porta se o
 * funcionário confirmou aquele rascunho com exatamente este conteúdo. Assim a escrita não depende
 * de o chamador ser bem-comportado: sem rascunho confirmado, não há escrita.
 */

interface CheckBase {
  readonly employeeId: string;
  readonly conversationId: string;
  readonly draftId: string;
}

export type ConfirmationCheck =
  | (CheckBase & {
      readonly operation: 'CREATE';
      readonly fields: TicketFields;
      readonly priorityAssessment: PriorityAssessment;
    })
  | (CheckBase & {
      readonly operation: 'UPDATE';
      readonly ticketCode: TicketCode;
      readonly comment: string;
      readonly newPriority?: TicketPriority;
    })
  | (CheckBase & {
      readonly operation: 'REOPEN';
      readonly ticketCode: TicketCode;
      readonly reason: string;
    });

export interface ConfirmationGate {
  /**
   * Resolve se existe rascunho do funcionário, nesta conversa, já confirmado e com o mesmo conteúdo.
   * Caso contrário lança `TicketServiceError('CONFIRMATION_REQUIRED')`.
   */
  assertConfirmed(check: ConfirmationCheck): Promise<void>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** O conteúdo que será escrito é o mesmo que o funcionário viu e confirmou? */
export function draftMatchesCheck(payload: DraftPayload, check: ConfirmationCheck): boolean {
  if (payload.operation !== check.operation) return false;
  switch (check.operation) {
    case 'CREATE': {
      if (payload.operation !== 'CREATE') return false;
      return (
        stableJson(payload.fields) === stableJson(check.fields) &&
        payload.priorityAssessment.priority === check.priorityAssessment.priority
      );
    }
    case 'UPDATE': {
      if (payload.operation !== 'UPDATE') return false;
      return (
        payload.ticketCode === check.ticketCode &&
        payload.comment === check.comment &&
        payload.priorityAssessment?.priority === check.newPriority
      );
    }
    case 'REOPEN': {
      if (payload.operation !== 'REOPEN') return false;
      return payload.ticketCode === check.ticketCode && payload.reason === check.reason;
    }
  }
}
