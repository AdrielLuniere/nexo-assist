import type { ConfirmationGate } from '@nexo/ticket-service';
import { createDraftRepositoryGate } from '../drafts/draft-gate.js';
import { createPrismaDraftRepository } from '../drafts/draft-repository.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { mapPrismaError } from './prisma-ticket-store.js';

/**
 * Confirmação lida da tabela `ticket_drafts` (ver `drafts/draft-gate.ts`). Falhas transitórias do
 * banco viram `UNAVAILABLE`, para o serviço de chamados poder repetir a operação com segurança.
 */
export function createPrismaConfirmationGate(prisma: PrismaClient): ConfirmationGate {
  const gate = createDraftRepositoryGate(createPrismaDraftRepository(prisma));
  return {
    async assertConfirmed(check) {
      try {
        await gate.assertConfirmed(check);
      } catch (error) {
        throw mapPrismaError(error);
      }
    },
  };
}
