import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPrismaClient } from '../infra/prisma.js';
import { seedDatabase } from './seed.js';

/**
 * `npm run db:seed -- --confirm`
 *
 * Proteções: exige `--confirm`, só aceita banco local e informa o destino antes de escrever.
 * `SEED_NOW=2026-11-02T13:00:00Z` fixa o instante de referência (dados idênticos entre execuções).
 */
const rootEnvFile = fileURLToPath(new URL('../../../../.env', import.meta.url));
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL não definida.');

  const url = new URL(databaseUrl);
  const target = `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`Recusado: o seed só roda em banco local (destino: ${target}).`);
  }
  if (!process.argv.includes('--confirm')) {
    throw new Error(`Seed não executado. Destino: ${target}. Rode com --confirm para inserir os dados de exemplo.`);
  }

  const now = process.env.SEED_NOW ? new Date(process.env.SEED_NOW) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('SEED_NOW inválido (use ISO 8601).');

  const prisma = createPrismaClient(databaseUrl);
  try {
    console.log(`Inserindo dados de exemplo em ${target} (referência: ${now.toISOString()})`);
    const result = await seedDatabase(prisma, now);
    console.log('Inseridos:', result);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
