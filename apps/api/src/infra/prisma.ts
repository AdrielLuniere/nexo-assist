import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export type { PrismaClient };

/** Prisma 7 exige driver adapter; usamos `pg` via `@prisma/adapter-pg`. A conexão é preguiçosa. */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}
