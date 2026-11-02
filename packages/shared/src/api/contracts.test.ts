import { describe, expect, it } from 'vitest';
import { API_ROUTES } from './contracts.js';
import { API_ERROR_CODES, API_ERROR_DEFINITIONS, ApiErrorBodySchema, httpStatusOf } from './errors.js';

describe('catálogo de rotas', () => {
  const routes = Object.values(API_ROUTES);

  it('não tem método + caminho duplicado', () => {
    const keys = routes.map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('mantém rotas de negócio sob /api e /health público', () => {
    for (const route of routes) {
      if (route.path === '/health') expect(route.auth).toBe('public');
      else expect(route.path.startsWith('/api/')).toBe(true);
    }
  });

  it('na P0.1 só /health está implementada', () => {
    expect(routes.filter((route) => route.status === 'implemented').map((route) => route.path)).toEqual(['/health']);
  });

  it('console exige papel de analista', () => {
    for (const route of routes.filter((r) => r.path.startsWith('/api/console/'))) {
      expect(route.auth).toBe('analyst');
    }
  });
});

describe('erros estruturados', () => {
  it('todo código tem status HTTP de erro', () => {
    for (const code of API_ERROR_CODES) {
      expect(httpStatusOf(code)).toBeGreaterThanOrEqual(400);
    }
  });

  it('indisponibilidade do sistema legado é repetível', () => {
    expect(API_ERROR_DEFINITIONS.TICKET_SERVICE_UNAVAILABLE).toEqual({ httpStatus: 503, retryable: true });
  });

  it('valida o corpo de erro', () => {
    const body = { error: { code: 'NOT_FOUND', message: 'Chamado não encontrado.', retryable: false } };
    expect(ApiErrorBodySchema.parse(body)).toEqual(body);
    expect(ApiErrorBodySchema.safeParse({ error: { ...body.error, code: 'TEAPOT' } }).success).toBe(false);
  });
});
