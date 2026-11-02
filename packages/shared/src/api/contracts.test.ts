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

  it('lista exatamente as rotas implementadas até a P0.6-A', () => {
    expect(
      routes
        .filter((route) => route.status === 'implemented')
        .map((route) => `${route.method} ${route.path}`)
        .sort(),
    ).toEqual(
      [
        'GET /health',
        'POST /api/auth/login',
        'GET /api/auth/me',
        'GET /api/conversations',
        'POST /api/conversations',
        'GET /api/conversations/:conversationId',
        'POST /api/conversations/:conversationId/messages',
        'POST /api/conversations/:conversationId/resume',
        'GET /api/conversations/:conversationId/events',
        'POST /api/conversations/:conversationId/handoff',
        'GET /api/console/conversations',
        'GET /api/console/conversations/:conversationId',
        'POST /api/console/conversations/:conversationId/assume',
        'POST /api/console/conversations/:conversationId/return',
        'POST /api/console/conversations/:conversationId/close',
        'POST /api/console/conversations/:conversationId/messages',
        'GET /api/tickets',
        'GET /api/tickets/:ticketCode',
        'POST /api/conversations/:conversationId/drafts/:draftId/confirm',
        'POST /api/conversations/:conversationId/drafts/:draftId/discard',
      ].sort(),
    );
  });

  it('console exige papel de analista e nada fora dele o exige', () => {
    for (const route of routes) {
      expect(route.auth === 'analyst').toBe(route.path.startsWith('/api/console/'));
    }
  });

  it('nenhuma rota está planejada', () => {
    expect(routes.filter((r) => (r.status as string) === 'planned')).toEqual([]);
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
