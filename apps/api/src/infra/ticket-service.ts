import { type TicketService, createTicketService, withRetry } from '@nexo/ticket-service';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaConfirmationGate } from './prisma-confirmation-gate.js';
import { createPrismaTicketStore } from './prisma-ticket-store.js';

/**
 * Monta o sistema de chamados simulado sobre PostgreSQL, já resiliente a quedas curtas.
 * O agente nunca recebe isto diretamente: a API cria portas por requisição, vinculadas ao funcionário.
 */
export function createLegacyTicketService(prisma: PrismaClient): TicketService {
  return withRetry(
    createTicketService({
      store: createPrismaTicketStore(prisma),
      confirmations: createPrismaConfirmationGate(prisma),
    }),
  );
}
