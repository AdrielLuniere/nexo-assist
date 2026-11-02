import type { HealthResponse } from '@nexo/shared';
import { Router } from 'express';
import type { DatabaseCheck } from '../../infra/database-health.js';

export interface HealthRouteDeps {
  readonly checkDatabase: DatabaseCheck;
  readonly version: string;
  readonly startedAt: Date;
  readonly now?: () => Date;
}

/** `GET /health`: 200 quando tudo está de pé, 503 (`degraded`) quando o banco está fora. */
export function healthRouter(deps: HealthRouteDeps): Router {
  const now = deps.now ?? (() => new Date());
  const router = Router();

  router.get('/health', async (_req, res) => {
    const database = await deps.checkDatabase();
    const current = now();
    const body: HealthResponse = {
      status: database.status === 'up' ? 'ok' : 'degraded',
      service: 'nexo-assist-api',
      version: deps.version,
      uptimeSeconds: Math.max(0, Math.floor((current.getTime() - deps.startedAt.getTime()) / 1000)),
      timestamp: current.toISOString(),
      checks: { database },
    };
    res.setHeader('cache-control', 'no-store');
    res.status(body.status === 'ok' ? 200 : 503).json(body);
  });

  return router;
}
