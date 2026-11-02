import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createAuthService } from './auth/auth-service.js';
import { createPrismaUserRepository } from './auth/user-repository.js';
import { EnvValidationError, loadEnv } from './config/env.js';
import { createPrismaConversationRepository } from './conversations/conversation-repository.js';
import { createConversationService } from './conversations/conversation-service.js';
import { createDraftService } from './drafts/draft-service.js';
import { createPrismaDraftRepository } from './drafts/draft-repository.js';
import { createApp } from './http/app.js';
import { createDatabaseCheck } from './infra/database-health.js';
import { createPrismaClient } from './infra/prisma.js';
import { createLegacyTicketService } from './infra/ticket-service.js';
import { logger } from './infra/logger.js';

// O .env fica na raiz do monorepo. Variáveis já definidas no ambiente têm precedência.
const rootEnvFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

function main(): void {
  const env = loadEnv();
  const prisma = createPrismaClient(env.DATABASE_URL);

  let authSecret = env.AUTH_SECRET;
  if (!authSecret) {
    authSecret = randomBytes(32).toString('hex');
    logger.warn('AUTH_SECRET ausente: usando segredo efêmero; as sessões não sobrevivem a um reinício.', {});
  }
  const tickets = createLegacyTicketService(prisma);

  const app = createApp({
    checkDatabase: createDatabaseCheck(prisma, env.HEALTH_DB_TIMEOUT_MS),
    version: process.env.npm_package_version ?? '0.0.0-dev',
    startedAt: new Date(),
    logger,
    api: {
      auth: createAuthService({
        users: createPrismaUserRepository(prisma),
        secret: authSecret,
        sessionTtlSeconds: env.AUTH_SESSION_TTL_MINUTES * 60,
      }),
      tickets,
      conversations: createConversationService({ conversations: createPrismaConversationRepository(prisma) }),
      drafts: createDraftService({ drafts: createPrismaDraftRepository(prisma), tickets }),
    },
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
