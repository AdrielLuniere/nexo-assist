import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EnvValidationError, loadEnv } from './config/env.js';
import { createApp } from './http/app.js';
import { createDatabaseCheck } from './infra/database-health.js';
import { createPrismaClient } from './infra/prisma.js';
import { logger } from './infra/logger.js';

// O .env fica na raiz do monorepo. Variáveis já definidas no ambiente têm precedência.
const rootEnvFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

function main(): void {
  const env = loadEnv();
  const prisma = createPrismaClient(env.DATABASE_URL);

  const app = createApp({
    checkDatabase: createDatabaseCheck(prisma, env.HEALTH_DB_TIMEOUT_MS),
    version: process.env.npm_package_version ?? '0.0.0-dev',
    startedAt: new Date(),
    logger,
  });

  const server = app.listen(env.API_PORT, env.API_HOST, () => {
    logger.info('API iniciada', { url: `http://${env.API_HOST}:${env.API_PORT}`, nodeEnv: env.NODE_ENV });
  });

  const shutdown = (signal: string) => {
    logger.info('Encerrando API', { signal });
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  main();
} catch (error) {
  if (error instanceof EnvValidationError) {
    logger.error(error.message, {});
    process.exit(1);
  }
  throw error;
}
