import type { PrismaClient } from '../generated/prisma/client.js';
import { type SeedData, buildSeedData } from './data.js';

export interface SeedResult {
  users: number;
  helpArticles: number;
  tickets: number;
  events: number;
}

/**
 * Insere os dados de exemplo. Somente insere: linhas que já existem (mesmo id/chave) são mantidas
 * como estão, então rodar de novo não apaga nem sobrescreve nada, e a sequência de códigos nunca recua.
 */
export async function seedDatabase(prisma: PrismaClient, now: Date, data: SeedData = buildSeedData(now)): Promise<SeedResult> {
  return prisma.$transaction(async (tx) => {
    const users = await tx.user.createMany({ data: data.users, skipDuplicates: true });
    const helpArticles = await tx.helpArticle.createMany({ data: data.helpArticles, skipDuplicates: true });
    const tickets = await tx.ticket.createMany({ data: data.tickets, skipDuplicates: true });
    const events = await tx.ticketEvent.createMany({ data: data.events, skipDuplicates: true });
    await tx.ticketSequence.createMany({
      data: [
        { type: 'INC', lastNumber: data.sequences.INC },
        { type: 'REQ', lastNumber: data.sequences.REQ },
      ],
      skipDuplicates: true,
    });
    return { users: users.count, helpArticles: helpArticles.count, tickets: tickets.count, events: events.count };
  });
}
