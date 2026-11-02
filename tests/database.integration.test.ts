import { describe, expect, it } from 'vitest';
import { createDatabaseCheck } from '../apps/api/src/infra/database-health.js';
import { createPrismaClient } from '../apps/api/src/infra/prisma.js';

/**
 * Conexão real com o PostgreSQL local (docker compose). Somente leitura: executa `SELECT 1`.
 * Fora do `npm test` padrão; roda com `npm run test:db` (exige `npm run db:up`).
 */
const databaseUrl = process.env.DATABASE_URL;

describe('PostgreSQL local', () => {
  it('responde à checagem de saúde', async () => {
    if (!databaseUrl) throw new Error('DATABASE_URL não definida');
    const prisma = createPrismaClient(databaseUrl);
    try {
      const result = await createDatabaseCheck(prisma, 5_000)();
      expect(result.status).toBe('up');
    } finally {
      await prisma.$disconnect();
    }
  });

  it('reporta "down" sem vazar credenciais quando o banco não existe', async () => {
    const prisma = createPrismaClient('postgresql://ninguem:senha-secreta@127.0.0.1:1/inexistente');
    try {
      const result = await createDatabaseCheck(prisma, 2_000)();
      expect(result.status).toBe('down');
      expect(JSON.stringify(result)).not.toContain('senha-secreta');
    } finally {
      await prisma.$disconnect();
    }
  });
});
