import { type ScriptStep, createScriptedModel } from '@nexo/agent/testing';
import { createTicketService, withRetry, withSimulatedOutages, type OutagePlan } from '@nexo/ticket-service';
import type { Express } from 'express';
import { type Server, createServer } from 'node:http';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { createAgentResponder } from '../../apps/api/src/agent/agent-responder.js';
import { createPrismaAgentTurnStore } from '../../apps/api/src/agent/agent-turn-store.js';
import { createPrismaHelpCenter } from '../../apps/api/src/agent/help-center.js';
import { createAuthService } from '../../apps/api/src/auth/auth-service.js';
import { createPrismaUserRepository } from '../../apps/api/src/auth/user-repository.js';
import { createPrismaConsoleRepository } from '../../apps/api/src/console/console-repository.js';
import { createConsoleService } from '../../apps/api/src/console/console-service.js';
import { createConversationEventBus } from '../../apps/api/src/conversations/conversation-events.js';
import { createPrismaConversationRepository } from '../../apps/api/src/conversations/conversation-repository.js';
import { createConversationService } from '../../apps/api/src/conversations/conversation-service.js';
import { createHandoffRequestService, createPrismaHandoffRequestRepository } from '../../apps/api/src/conversations/handoff-request.js';
import { createPrismaDraftRepository } from '../../apps/api/src/drafts/draft-repository.js';
import { createDraftService } from '../../apps/api/src/drafts/draft-service.js';
import { createApp } from '../../apps/api/src/http/app.js';
import { createPrismaConfirmationGate } from '../../apps/api/src/infra/prisma-confirmation-gate.js';
import { createPrismaTicketStore } from '../../apps/api/src/infra/prisma-ticket-store.js';
import { type PrismaClient, createPrismaClient } from '../../apps/api/src/infra/prisma.js';
import { seedDatabase } from '../../apps/api/src/seed/seed.js';
import { type DisposableDatabase, createDisposableDatabase } from '../helpers/disposable-database.js';
import { Browser } from './browser.js';

/**
 * Pilha completa para a homologação no navegador:
 *
 *   Chrome ──▶ Vite (apps/web, código real) ──proxy──▶ API real (Express, Prisma, regras, Mastra)
 *                                                          └──▶ PostgreSQL descartável (migrations + seed reais)
 *
 * A única parte simulada é o MODELO DE LINGUAGEM (roteirizado, sem custo): ferramentas, política,
 * persistência, SSE e interface são os de produção. Cada cenário troca o roteiro do modelo (e,
 * opcionalmente, injeta quedas do sistema de chamados) sem reiniciar nada.
 */

const SECRET = 'segredo-de-homologacao-com-mais-de-32-caracteres!';

export interface Scenario {
  readonly script: readonly ScriptStep[];
  /** Quedas simuladas do sistema de chamados legado (PRD: "fica indisponível por alguns segundos"). */
  readonly outages?: OutagePlan;
}

export interface Stack {
  readonly db: DisposableDatabase;
  readonly prisma: PrismaClient;
  readonly webUrl: string;
  readonly browser: Browser;
  /** Chamadas feitas ao modelo no cenário atual. */
  modelCalls(): number;
  scenario(next: Scenario): void;
  stop(): Promise<void>;
}

export async function startStack(): Promise<Stack> {
  const db = await createDisposableDatabase();
  const prisma = createPrismaClient(db.url);
  await seedDatabase(prisma, new Date());

  let current: Express;
  let calls: () => number = () => 0;

  const build = (scenario: Scenario): Express => {
    const scripted = createScriptedModel([...scenario.script]);
    calls = () => scripted.calls.length;
    const real = createTicketService({ store: createPrismaTicketStore(prisma), confirmations: createPrismaConfirmationGate(prisma) });
    const tickets = withRetry(scenario.outages ? withSimulatedOutages(real, scenario.outages) : real, { sleep: () => Promise.resolve() });
    const events = createConversationEventBus();
    const conversations = createPrismaConversationRepository(prisma);
    const drafts = createPrismaDraftRepository(prisma);
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
    return createApp({
      checkDatabase: async () => ({ status: 'up' }),
      version: 'e2e',
      startedAt: new Date(),
      logger,
      api: {
        auth: createAuthService({ users: createPrismaUserRepository(prisma), secret: SECRET, sessionTtlSeconds: 3600 }),
        tickets,
        conversations: createConversationService({ conversations, drafts }),
        drafts: createDraftService({ drafts, tickets }),
        responder: createAgentResponder({ store: createPrismaAgentTurnStore(prisma), tickets, helpCenter: createPrismaHelpCenter(prisma), model: scripted.model, modelId: 'homologacao/roteirizado', logger }),
        console: createConsoleService({ console: createPrismaConsoleRepository(prisma), conversations, tickets, events, drafts }),
        events,
        handoffs: createHandoffRequestService({ handoffs: createPrismaHandoffRequestRepository(prisma), conversations, events }),
      },
    });
  };

  current = build({ script: [] });
  const api: Server = createServer((req, res) => current(req, res));
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const apiPort = (api.address() as { port: number }).port;

  process.env.VITE_API_PROXY_TARGET = `http://127.0.0.1:${apiPort}`;
  const vite: ViteDevServer = await createViteServer({
    root: 'apps/web',
    configFile: 'apps/web/vite.config.ts',
    server: { host: '127.0.0.1', port: 5198, strictPort: true },
    logLevel: 'error',
  });
  await vite.listen();

  const browser = await Browser.launch();

  return {
    db,
    prisma,
    webUrl: 'http://127.0.0.1:5198',
    browser,
    modelCalls: () => calls(),
    scenario(next) {
      current = build(next);
    },
    async stop() {
      await browser.close().catch(() => undefined);
      await vite.close().catch(() => undefined);
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
      await prisma.$disconnect().catch(() => undefined);
      await db.drop().catch(() => undefined);
    },
  };
}
