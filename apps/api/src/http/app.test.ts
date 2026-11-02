import { ApiErrorBodySchema, HealthResponseSchema } from '@nexo/shared';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseCheck } from '../infra/database-health.js';
import { createApp } from './app.js';

function buildApp(checkDatabase: DatabaseCheck) {
  const logger = { error: vi.fn() };
  const app = createApp({ checkDatabase, version: '0.1.0-test', startedAt: new Date(Date.now() - 5_000), logger });
  return { app, logger };
}

describe('GET /health', () => {
  it('responde 200 quando o banco está de pé', async () => {
    const { app } = buildApp(async () => ({ status: 'up', latencyMs: 3 }));
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    const body = HealthResponseSchema.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.1.0-test');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(4);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('responde 503 degradado quando o banco está fora', async () => {
    const { app } = buildApp(async () => ({ status: 'down', error: 'falha de conexão' }));
    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(HealthResponseSchema.parse(res.body)).toMatchObject({
      status: 'degraded',
      checks: { database: { status: 'down' } },
    });
  });

  it('esconde detalhes de falhas inesperadas', async () => {
    const { app, logger } = buildApp(async () => {
      throw new Error('detalhe interno sensível');
    });
    const res = await request(app).get('/health');

    expect(res.status).toBe(500);
    const body = ApiErrorBodySchema.parse(res.body);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('sensível');
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe('erros estruturados', () => {
  const { app } = buildApp(async () => ({ status: 'up' }));

  it('rota inexistente responde NOT_FOUND no formato do contrato', async () => {
    const res = await request(app).get('/api/nao-existe');

    expect(res.status).toBe(404);
    const body = ApiErrorBodySchema.parse(res.body);
    expect(body.error).toMatchObject({ code: 'NOT_FOUND', retryable: false });
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('JSON malformado responde VALIDATION_ERROR', async () => {
    const res = await request(app).post('/api/qualquer').set('content-type', 'application/json').send('{"a":');

    expect(res.status).toBe(400);
    expect(ApiErrorBodySchema.parse(res.body).error.code).toBe('VALIDATION_ERROR');
  });

  it('propaga x-request-id válido e substitui inválido', async () => {
    const kept = await request(app).get('/health').set('x-request-id', 'abc-123');
    expect(kept.headers['x-request-id']).toBe('abc-123');

    const replaced = await request(app).get('/health').set('x-request-id', 'inválido com espaço');
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
