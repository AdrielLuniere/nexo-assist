import { ApiErrorBodySchema, HandoffResponseSchema } from '@nexo/shared';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AgentResponder } from '../apps/api/src/conversations/responder.js';
import { buildHandoffSummary } from '../apps/api/src/conversations/handoff-request.js';
import { ANA, BRUNO, type Harness, MARCOS, bearer, buildHarness } from './helpers/api-harness.js';
import { request } from './helpers/http.js';

const errorOf = (body: unknown) => ApiErrorBodySchema.parse(body).error;

async function conversationWith(h: Harness, token: string, content = 'Meu notebook está lento desde ontem') {
  const id = ((await request(h.app).post('/api/conversations').set(bearer(token))).body as { conversation: { id: string } }).conversation.id;
  await request(h.app).post(`/api/conversations/${id}/messages`).set(bearer(token)).send({ content, clientMessageId: randomUUID() });
  return id;
}

const ask = (h: Harness, token: string, id: string, body: object = {}) =>
  request(h.app).post(`/api/conversations/${id}/handoff`).set(bearer(token)).send(body);

describe('POST /api/conversations/:id/handoff', () => {
  it('exige login de funcionário', async () => {
    const h = await buildHarness();
    const id = await conversationWith(h, await h.login(ANA));
    expect((await request(h.app).post(`/api/conversations/${id}/handoff`).send({})).status).toBe(401);
    expect((await ask(h, await h.login(MARCOS), id)).status).toBe(403);
  });

  it('conversa de outra pessoa ou inexistente: mesmo 404, e nada muda', async () => {
    const h = await buildHarness();
    const ana = await h.login(ANA);
    const id = await conversationWith(h, ana);
    const stranger = await ask(h, await h.login(BRUNO), id);
    const missing = await ask(h, await h.login(BRUNO), 'conv_inexistente');
    expect(stranger.status).toBe(404);
    const strip = (body: unknown) => {
      const { requestId: _r, ...rest } = errorOf(body);
      return rest;
    };
    expect(strip(stranger.body)).toEqual(strip(missing.body));
    const after = await request(h.app).get(`/api/conversations/${id}`).set(bearer(ana));
    expect(after.body.conversation).toMatchObject({ status: 'WITH_AGENT', version: 0 });
  });

  it('transfere sem chamar o modelo: EMPLOYEE_REQUEST, resumo útil, WAITING_ANALYST e agente pausado', async () => {
    const respond = vi.fn<AgentResponder['respond']>(async function* () {});
    const h = await buildHarness({ responder: { respond: (input) => respond(input) } });
    const ana = await h.login(ANA);
    const id = await conversationWith(h, ana);
    respond.mockClear();

    const res = await ask(h, ana, id, { note: 'É urgente, tenho uma apresentação.' });
    expect(res.status).toBe(201);
    const body = HandoffResponseSchema.parse(res.body);
    expect(body.handoff).toMatchObject({ reason: 'EMPLOYEE_REQUEST', status: 'WAITING', assumedById: null, conversationId: id });
    expect(body.handoff.summary).toContain('Meu notebook está lento desde ontem');
    expect(body.handoff.summary).toContain('É urgente, tenho uma apresentação.');
    expect(body.conversation).toMatchObject({ status: 'WAITING_ANALYST', version: 1 });

    // O analista a vê na fila com o resumo; o agente não responde mais.
    const queue = await request(h.app).get('/api/console/conversations').set(bearer(await h.login(MARCOS)));
    expect(queue.body.items[0]).toMatchObject({ id, activeHandoff: { id: body.handoff.id, reason: 'EMPLOYEE_REQUEST' } });
    await request(h.app).post(`/api/conversations/${id}/messages`).set(bearer(ana)).send({ content: 'Alguém?', clientMessageId: randomUUID() });
    expect(respond).not.toHaveBeenCalled();
  });

  it('não lê identidade nem estado do corpo', async () => {
    const h = await buildHarness();
    const ana = await h.login(ANA);
    const id = await conversationWith(h, ana);
    const res = await ask(h, ana, id, { employeeId: BRUNO.id, reason: 'CRITICAL_ISSUE', status: 'WITH_ANALYST', summary: 'forjado' });
    expect(res.status).toBe(201);
    expect(res.body.handoff.reason).toBe('EMPLOYEE_REQUEST');
    expect(res.body.handoff.summary).not.toContain('forjado');
    expect(res.body.conversation.status).toBe('WAITING_ANALYST');
  });

  it('repetir é idempotente (200, mesma transferência, sem nova versão), também em rajada', async () => {
    const h = await buildHarness();
    const ana = await h.login(ANA);
    const id = await conversationWith(h, ana);
    const results = await Promise.all(Array.from({ length: 10 }, () => ask(h, ana, id)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.handoff.id)).size).toBe(1);

    const again = await ask(h, ana, id);
    expect(again.status).toBe(200);
    const detail = await request(h.app).get(`/api/console/conversations/${id}`).set(bearer(await h.login(MARCOS)));
    expect(detail.body.conversation.handoffs).toHaveLength(1);
    expect(detail.body.conversation.version).toBe(1);
  });

  it('recusa quando já há analista atendendo ou a conversa está encerrada', async () => {
    const h = await buildHarness();
    const ana = await h.login(ANA);
    const marcos = await h.login(MARCOS);
    const attended = await conversationWith(h, ana);
    await ask(h, ana, attended);
    await request(h.app).post(`/api/console/conversations/${attended}/assume`).set(bearer(marcos)).send({ expectedVersion: 1 });
    const busy = await ask(h, ana, attended);
    expect([busy.status, errorOf(busy.body).code]).toEqual([409, 'INVALID_STATE_TRANSITION']);

    const closed = await conversationWith(h, ana, 'Outra conversa');
    await ask(h, ana, closed);
    await request(h.app).post(`/api/console/conversations/${closed}/close`).set(bearer(marcos)).send({ expectedVersion: 1 });
    const res = await ask(h, ana, closed);
    expect([res.status, errorOf(res.body).code]).toEqual([409, 'INVALID_STATE_TRANSITION']);
  });

  it('valida a observação', async () => {
    const h = await buildHarness();
    const ana = await h.login(ANA);
    const id = await conversationWith(h, ana);
    expect((await ask(h, ana, id, { note: 'x'.repeat(501) })).status).toBe(400);
    expect((await request(h.app).post(`/api/conversations/${id}/handoff`).set(bearer(ana))).status).toBe(201); // sem corpo
  });

  it('avisa quem acompanha a conversa', async () => {
    const h = await buildHarness();
    const ana = await h.login(ANA);
    const id = await conversationWith(h, ana);
    const seen: unknown[] = [];
    h.events.subscribe(id, { onEvent: (e) => seen.push(e), onShutdown: () => undefined });
    await ask(h, ana, id);
    await ask(h, ana, id); // repetição não publica de novo
    expect(seen).toEqual([{ event: 'conversation.status', data: { status: 'WAITING_ANALYST', version: 1 } }]);
  });
});

describe('buildHandoffSummary', () => {
  const msg = (role: 'EMPLOYEE' | 'AGENT', content: string) => ({ id: content, conversationId: 'c', role, authorId: null, content, blocks: [], decisionId: null, createdAt: '2026-11-02T10:00:00.000Z' });

  it('usa as últimas mensagens, corta textos longos e respeita o limite', () => {
    const many = Array.from({ length: 20 }, (_, i) => msg(i % 2 ? 'AGENT' : 'EMPLOYEE', `mensagem ${i} ${'x'.repeat(500)}`));
    const summary = buildHandoffSummary(many, 'nota');
    expect(summary.length).toBeLessThanOrEqual(2000);
    expect(summary).toContain('mensagem 19');
    expect(summary).not.toContain('mensagem 3 ');
    expect(summary).toContain('…');
  });

  it('funciona sem mensagens', () => {
    expect(buildHandoffSummary([])).toContain('ainda não tem mensagens');
  });
});
