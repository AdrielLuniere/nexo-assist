import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createAgentResponder } from './agent/agent-responder.js';
import { createPrismaAgentTurnStore } from './agent/agent-turn-store.js';
import { createPrismaHelpCenter } from './agent/help-center.js';
import { createAuthService } from './auth/auth-service.js';
import { createPrismaUserRepository } from './auth/user-repository.js';
import { EnvValidationError, loadEnv } from './config/env.js';
import { createPrismaConsoleRepository } from './console/console-repository.js';
import { createConsoleService } from './console/console-service.js';
import { createConversationEventBus } from './conversations/conversation-events.js';
import { createPrismaConversationRepository } from './conversations/conversation-repository.js';
import { createHandoffRequestService, createPrismaHandoffRequestRepository } from './conversations/handoff-request.js';
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

/** Variável da chave dos provedores mais comuns (o Mastra lê a chave do ambiente na hora da chamada). */
const PROVIDER_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

function main(): void {
  const env = loadEnv();
  const prisma = createPrismaClient(env.DATABASE_URL);

  let authSecret = env.AUTH_SECRET;
  if (!authSecret) {
    authSecret = randomBytes(32).toString('hex');
    logger.warn('AUTH_SECRET ausente: usando segredo efêmero; as sessões não sobrevivem a um reinício.', {});
  }
  const tickets = createLegacyTicketService(prisma);

  const agentModel = env.AGENT_MODEL ?? null;
  if (!agentModel) {
    logger.warn('AGENT_MODEL ausente: as mensagens são gravadas, mas o agente não responde (AGENT_UNAVAILABLE).', {});
  } else {
    const keyVar = PROVIDER_KEYS[agentModel.split('/')[0] ?? ''];
    if (keyVar && !process.env[keyVar]) logger.warn('Chave do provedor do modelo ausente; as respostas do agente vão falhar.', { model: agentModel, variable: keyVar });
  }
  const responder = createAgentResponder({
    store: createPrismaAgentTurnStore(prisma),
    tickets,
    helpCenter: createPrismaHelpCenter(prisma),
    model: agentModel,
    modelId: agentModel ?? 'nenhum',
    limits: { timeoutMs: env.AGENT_TIMEOUT_MS },
    maxConcurrentRuns: env.AGENT_MAX_CONCURRENCY,
    logger,
  });

  const conversations = createPrismaConversationRepository(prisma);
  const drafts = createPrismaDraftRepository(prisma);
  const events = createConversationEventBus();

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
      conversations: createConversationService({ conversations, drafts }),
      drafts: createDraftService({ drafts, tickets }),
      responder,
      console: createConsoleService({ console: createPrismaConsoleRepository(prisma), conversations, tickets, events, drafts }),
      events,
      handoffs: createHandoffRequestService({ handoffs: createPrismaHandoffRequestRepository(prisma), conversations, events }),
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
    // Streams de eventos ficam abertos por tempo indeterminado e impediriam o encerramento.
    events.shutdown();
    server.closeIdleConnections();
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
