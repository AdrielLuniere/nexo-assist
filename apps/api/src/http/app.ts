import express, { type Express } from 'express';
import type { DatabaseCheck } from '../infra/database-health.js';
import { createErrorHandler, type ErrorLogger, notFoundHandler } from './middleware/error-handler.js';
import { requestId } from './middleware/request-id.js';
import { healthRouter } from './routes/health.js';

export interface AppDeps {
  readonly checkDatabase: DatabaseCheck;
  readonly version: string;
  readonly startedAt: Date;
  readonly logger: ErrorLogger;
}

/** Monta o app sem abrir porta: testável com supertest e dependências falsas. */
export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(requestId);
  app.use(express.json({ limit: '32kb' }));

  app.use(healthRouter(deps));
  // Rotas /api/* entram a partir da P0.2 (ver docs/api-contracts.md).

  app.use(notFoundHandler);
  app.use(createErrorHandler(deps.logger));

  return app;
}
