import { ApiErrorBodySchema, LoginResponseSchema, UserSchema } from '@nexo/shared';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createAuthService } from '../apps/api/src/auth/auth-service.js';
import { createInMemoryUserRepository } from '../apps/api/src/auth/user-repository.js';
import { createErrorHandler } from '../apps/api/src/http/middleware/error-handler.js';
import { authenticate, requireRole } from '../apps/api/src/http/middleware/authenticate.js';
import { requestId } from '../apps/api/src/http/middleware/request-id.js';
import { ANA, MARCOS, PAULA, SECRET, USERS, bearer, buildHarness } from './helpers/api-harness.js';

function errorOf(res: request.Response) {
  return ApiErrorBodySchema.parse(res.body).error;
}

describe('POST /api/auth/login', () => {
  it('autentica funcionário e analistas dos dados de exemplo com qualquer senha', async () => {
    const { app } = buildHarness();
    for (const user of USERS) {
      const res = await request(app).post('/api/auth/login').send({ email: user.email, password: 'qualquer-coisa' });
      expect(res.status).toBe(200);
      const body = LoginResponseSchema.parse(res.body);
      expect(body.user).toEqual(user);
      expect(UserSchema.parse(body.user)).toBeTruthy();
    }
  });

  it('devolve papel e nível: N1 e N2 para analistas, nulo para funcionário', async () => {
    const { app } = buildHarness();
    const login = async (email: string) =>
      (await request(app).post('/api/auth/login').send({ email, password: 'x' })).body.user as { role: string; analystLevel: string | null };
    expect(await login(ANA.email)).toMatchObject({ role: 'EMPLOYEE', analystLevel: null });
    expect(await login(MARCOS.email)).toMatchObject({ role: 'ANALYST', analystLevel: 'N1' });
    expect(await login(PAULA.email)).toMatchObject({ role: 'ANALYST', analystLevel: 'N2' });
  });

  it('ignora caixa do e-mail e a expiração segue a configuração', async () => {
    const { app, clock } = buildHarness({ sessionTtlSeconds: 600 });
    const res = await request(app).post('/api/auth/login').send({ email: 'ANA.Souza@NEXO.com.br', password: 'x' });
    expect(res.status).toBe(200);
    expect(new Date(res.body.expiresAt as string).getTime()).toBe(clock.current.getTime() + 600_000);
  });

  it('e-mail desconhecido e senha só com espaços recebem a mesma resposta genérica', async () => {
    const { app } = buildHarness();
    const unknown = await request(app).post('/api/auth/login').send({ email: 'ninguem@nexo.com.br', password: 'x' });
    const blank = await request(app).post('/api/auth/login').send({ email: ANA.email, password: '   ' });
    expect(unknown.status).toBe(401);
    expect(blank.status).toBe(401);
    expect(errorOf(unknown)).toMatchObject({ code: 'INVALID_CREDENTIALS', retryable: false });
    expect(errorOf(unknown).message).toBe(errorOf(blank).message);
  });

  it('rejeita corpo inválido com VALIDATION_ERROR, sem ecoar a senha', async () => {
    const { app } = buildHarness();
    const bad = [
      {},
      { email: ANA.email },
      { email: ANA.email, password: '' },
      { email: 'não-é-email', password: 'senha-super-secreta' },
      { email: ANA.email, password: 42 },
    ];
    for (const body of bad) {
      const res = await request(app).post('/api/auth/login').send(body);
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.body)).not.toContain('senha-super-secreta');
    }
    expect((await request(app).post('/api/auth/login')).status).toBe(400);
  });

  it('não devolve credenciais nem usa cache; não há campo de senha na resposta', async () => {
    const { app } = buildHarness();
    const res = await request(app).post('/api/auth/login').send({ email: ANA.email, password: 'minha-senha-123' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toContain('minha-senha-123');
    expect(JSON.stringify(res.body)).not.toMatch(/password|senha|secret/i);
  });
});

describe('GET /api/auth/me e sessão', () => {
  it('devolve o usuário da sessão', async () => {
    const h = buildHarness();
    const res = await request(h.app).get('/api/auth/me').set(bearer(await h.login(MARCOS)));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: MARCOS });
  });

  it('sem credenciais responde 401 UNAUTHENTICATED com WWW-Authenticate', async () => {
    const { app } = buildHarness();
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('UNAUTHENTICATED');
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it.each([
    ['esquema errado', 'Basic abc'],
    ['token vazio', 'Bearer '],
    ['lixo', 'Bearer isto-nao-e-um-token'],
    ['token gigante', `Bearer ${'a'.repeat(5000)}`],
  ])('sessão inválida: %s', async (_name, header) => {
    const { app } = buildHarness();
    const res = await request(app).get('/api/auth/me').set('authorization', header);
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('UNAUTHENTICATED');
  });

  it('token adulterado (trocando o usuário no payload) é recusado', async () => {
    const h = buildHarness();
    const [version, , signature] = (await h.login(ANA)).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: MARCOS.id, iat: 0, exp: 9_999_999_999 })).toString('base64url');
    const res = await request(h.app).get('/api/auth/me').set(bearer(`${version}.${forged}.${signature}`));
    expect(res.status).toBe(401);
  });

  it('sessão expirada pede novo login, com mensagem própria', async () => {
    const h = buildHarness({ sessionTtlSeconds: 60 });
    const token = await h.login(ANA);
    h.clock.current = new Date(h.clock.current.getTime() + 61_000);
    const res = await request(h.app).get('/api/auth/me').set(bearer(token));
    expect(res.status).toBe(401);
    expect(errorOf(res)).toMatchObject({ code: 'UNAUTHENTICATED', message: expect.stringContaining('expirada') });
  });

  it('usuário removido depois do login perde o acesso na hora', async () => {
    const users = [ANA];
    const auth = createAuthService({ users: createInMemoryUserRepository(users), secret: SECRET, sessionTtlSeconds: 3600 });
    const { token } = await auth.login(ANA.email, 'x');
    users.length = 0;
    await expect(auth.authenticate(token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('o papel vem do banco a cada requisição, não do token', async () => {
    const mutable = { ...ANA };
    const users = [mutable];
    const auth = createAuthService({ users: createInMemoryUserRepository(users), secret: SECRET, sessionTtlSeconds: 3600 });
    const { token } = await auth.login(ANA.email, 'x');
    expect((await auth.authenticate(token)).role).toBe('EMPLOYEE');
    users[0] = { ...mutable, role: 'ANALYST', analystLevel: 'N2' };
    expect(await auth.authenticate(token)).toMatchObject({ role: 'ANALYST', analystLevel: 'N2' });
  });
});

describe('autorização por papel', () => {
  it('analista não acessa rotas de funcionário', async () => {
    const h = buildHarness();
    const token = await h.login(MARCOS);
    for (const res of [
      await request(h.app).get('/api/tickets').set(bearer(token)),
      await request(h.app).get('/api/tickets/INC-20311').set(bearer(token)),
      await request(h.app).post('/api/conversations/conv_ana/drafts/drf_x/confirm').set(bearer(token)),
      await request(h.app).post('/api/conversations/conv_ana/drafts/drf_x/discard').set(bearer(token)),
    ]) {
      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('FORBIDDEN');
    }
  });

  it('requireRole("ANALYST") barra funcionário e libera analista (base do console)', async () => {
    const h = buildHarness();
    const auth = createAuthService({ users: createInMemoryUserRepository(USERS), secret: SECRET, sessionTtlSeconds: 3600, now: () => h.clock.current });
    const app = express();
    app.use(requestId);
    app.get('/console-teste', authenticate(auth), requireRole('ANALYST'), (_req, res) => void res.json({ ok: true }));
    app.use(createErrorHandler({ error: () => undefined }));

    const asEmployee = await request(app).get('/console-teste').set(bearer(await h.login(ANA)));
    expect(asEmployee.status).toBe(403);
    const asAnalyst = await request(app).get('/console-teste').set(bearer(await h.login(PAULA)));
    expect(asAnalyst.status).toBe(200);
    expect((await request(app).get('/console-teste')).status).toBe(401);
  });

  it('rotas desconhecidas de /api continuam 404 estruturado, sem exigir login', async () => {
    const { app } = buildHarness();
    const res = await request(app).get('/api/nao-existe');
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('NOT_FOUND');
  });
});
