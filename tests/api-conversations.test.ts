import {
  ApiErrorBodySchema,
  type ChatStreamEvent,
  ChatStreamEventSchema,
  ConversationDetailSchema,
  ConversationSummarySchema,
  MAX_EMPLOYEE_MESSAGES_PER_SESSION,
} from '@nexo/shared';
import { randomUUID } from 'node:crypto';
import { type TestResponse, request } from './helpers/http.js';
import { describe, expect, it, vi } from 'vitest';
import type { AgentResponder } from '../apps/api/src/conversations/responder.js';
import { ANA, BRUNO, type Harness, MARCOS, type RequestTarget, bearer, buildHarness, parseSse, withServer } from './helpers/api-harness.js';

const errorOf = (res: TestResponse) => ApiErrorBodySchema.parse(res.body).error;

async function startConversation(h: Harness, token: string): Promise<string> {
  const res = await request(h.app).post('/api/conversations').set(bearer(token));
  return (res.body as { conversation: { id: string } }).conversation.id;
}

function send(h: Harness, token: string, conversationId: string, content = 'Meu notebook está lento', clientMessageId = randomUUID(), target: RequestTarget = h.app) {
  return request(target).post(`/api/conversations/${conversationId}/messages`).set(bearer(token)).send({ content, clientMessageId });
}

async function history(h: Harness, token: string, conversationId: string) {
  const res = await request(h.app).get(`/api/conversations/${conversationId}`).set(bearer(token));
  return ConversationDetailSchema.parse((res.body as { conversation: unknown }).conversation);
}

describe('POST /api/conversations', () => {
  it('inicia uma conversa do funcionário autenticado, vazia e com o agente', async () => {
    const h = await buildHarness();
    const res = await request(h.app).post('/api/conversations').set(bearer(await h.login(ANA)));
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const conversation = ConversationDetailSchema.parse(res.body.conversation);
    expect(conversation).toMatchObject({ employeeId: ANA.id, status: 'WITH_AGENT', title: null, employeeMessageCount: 0, messages: [], decisions: [] });
  });

  it('reaproveita a conversa ainda vazia (duplo clique não cria duas) e cria outra depois de usada', async () => {
    const h = await buildHarness();
    const token = await h.login(ANA);
    const first = await request(h.app).post('/api/conversations').set(bearer(token));
    const again = await request(h.app).post('/api/conversations').set(bearer(token));
    expect(again.status).toBe(200);
    expect(again.body.conversation.id).toBe(first.body.conversation.id);

    await send(h, token, first.body.conversation.id as string);
    const next = await request(h.app).post('/api/conversations').set(bearer(token));
    expect(next.status).toBe(201);
    expect(next.body.conversation.id).not.toBe(first.body.conversation.id);
  });

  it('ignora identidade vinda do cliente', async () => {
    const h = await buildHarness();
    const res = await request(h.app)
      .post('/api/conversations?employeeId=' + BRUNO.id)
      .set({ ...bearer(await h.login(ANA)), 'x-employee-id': BRUNO.id })
      .send({ employeeId: BRUNO.id, status: 'WITH_ANALYST', assignedAnalystId: MARCOS.id });
    expect(res.body.conversation).toMatchObject({ employeeId: ANA.id, status: 'WITH_AGENT', assignedAnalystId: null });
  });

  it('exige login de funcionário', async () => {
    const h = await buildHarness();
    expect((await request(h.app).post('/api/conversations')).status).toBe(401);
    expect((await request(h.app).post('/api/conversations').set(bearer(await h.login(MARCOS)))).status).toBe(403);
  });
});

describe('GET /api/conversations', () => {
  it('lista só as conversas do funcionário, a mais recente primeiro', async () => {
    const h = await buildHarness();
    const ana = await h.login(ANA);
    const bruno = await h.login(BRUNO);

    const older = await startConversation(h, ana);
    await send(h, ana, older, 'Primeira conversa');
    const newer = await startConversation(h, ana);
    await send(h, ana, newer, 'Segunda conversa');
    const brunos = await startConversation(h, bruno);
    await send(h, bruno, brunos, 'Conversa do Bruno');

    const res = await request(h.app).get('/api/conversations').set(bearer(ana));
    expect(res.status).toBe(200);
    const items = (res.body.items as unknown[]).map((i) => ConversationSummarySchema.parse(i));
    expect(items.map((c) => c.id)).toEqual([newer, older]);
    expect(items.every((c) => c.employeeId === ANA.id)).toBe(true);
    expect(items.map((c) => c.title)).toEqual(['Segunda conversa', 'Primeira conversa']);
    expect(JSON.stringify(res.body)).not.toContain(brunos);
  });

  it('lista vazia para quem nunca conversou e exige login de funcionário', async () => {
    const h = await buildHarness();
    const res = await request(h.app).get('/api/conversations').set(bearer(await h.login(BRUNO)));
    expect(res.body).toEqual({ items: [] });
    expect((await request(h.app).get('/api/conversations')).status).toBe(401);
    expect((await request(h.app).get('/api/conversations').set(bearer(await h.login(MARCOS)))).status).toBe(403);
  });
});

describe('GET /api/conversations/:id', () => {
  it('devolve o histórico completo para continuar de onde parou', async () => {
    const h = await buildHarness();
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    await send(h, token, id, 'Olá, preciso de ajuda');
    h.conversations.addMessage(id, 'AGENT', 'Claro! Qual é o problema?', new Date());
    await send(h, token, id, 'O VPN não conecta');

    const conversation = await history(h, token, id);
    expect(conversation.messages.map((m) => [m.role, m.content])).toEqual([
      ['EMPLOYEE', 'Olá, preciso de ajuda'],
      ['AGENT', 'Claro! Qual é o problema?'],
      ['EMPLOYEE', 'O VPN não conecta'],
    ]);
    expect(conversation.employeeMessageCount).toBe(2);
    expect(conversation.lastMessageAt).not.toBeNull();
  });

  it('conversa de outro funcionário é indistinguível de conversa inexistente (404)', async () => {
    const h = await buildHarness();
    const brunosConversation = await startConversation(h, await h.login(BRUNO));
    const ana = await h.login(ANA);

    const foreign = await request(h.app).get(`/api/conversations/${brunosConversation}`).set(bearer(ana));
    const missing = await request(h.app).get('/api/conversations/conv_inexistente').set(bearer(ana));
    expect([foreign.status, missing.status]).toEqual([404, 404]);
    expect(errorOf(foreign)).toMatchObject({ code: 'NOT_FOUND', message: errorOf(missing).message });
    expect(foreign.text).not.toContain(brunosConversation);
  });

  it('exige login de funcionário e valida o identificador', async () => {
    const h = await buildHarness();
    const id = await startConversation(h, await h.login(ANA));
    expect((await request(h.app).get(`/api/conversations/${id}`)).status).toBe(401);
    expect((await request(h.app).get(`/api/conversations/${id}`).set(bearer(await h.login(MARCOS)))).status).toBe(403);
    const long = await request(h.app).get(`/api/conversations/${'x'.repeat(200)}`).set(bearer(await h.login(ANA)));
    expect(long.status).toBe(400);
  });
});

describe('POST /api/conversations/:id/messages', () => {
  it('grava a mensagem e responde por SSE no formato do contrato', async () => {
    const h = await buildHarness();
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    const clientMessageId = randomUUID();

    const res = await send(h, token, id, '  Meu notebook está muito lento  ', clientMessageId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.headers['x-accel-buffering']).toBe('no');

    const events = parseSse(res.text);
    for (const e of events) expect(ChatStreamEventSchema.safeParse(e).success).toBe(true);
    expect(events.map((e) => e.event)).toEqual(['message.accepted', 'done']);
    const accepted = events[0]?.data.message as { role: string; authorId: string; content: string; conversationId: string };
    expect(accepted).toMatchObject({ role: 'EMPLOYEE', authorId: ANA.id, content: 'Meu notebook está muito lento', conversationId: id });

    const conversation = await history(h, token, id);
    expect(conversation.messages).toHaveLength(1);
    expect(conversation).toMatchObject({ employeeMessageCount: 1, title: 'Meu notebook está muito lento' });
  });

  it('título longo é truncado em 60 caracteres', async () => {
    const h = await buildHarness();
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    await send(h, token, id, 'a'.repeat(150));
    const title = (await history(h, token, id)).title ?? '';
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('…')).toBe(true);
  });

  it('ignora papel, autor e conversa enviados pelo cliente', async () => {
    const h = await buildHarness();
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    const res = await request(h.app)
      .post(`/api/conversations/${id}/messages`)
      .set({ ...bearer(token), 'x-employee-id': BRUNO.id })
      .send({ content: 'Oi', clientMessageId: randomUUID(), role: 'ANALYST', authorId: BRUNO.id, employeeId: BRUNO.id, conversationId: 'conv_outra' });
    const message = parseSse(res.text)[0]?.data.message as { role: string; authorId: string; conversationId: string };
    expect(message).toMatchObject({ role: 'EMPLOYEE', authorId: ANA.id, conversationId: id });
  });

  it.each([
    ['conteúdo vazio', { content: '', clientMessageId: randomUUID() }],
    ['conteúdo só com espaços', { content: '   ', clientMessageId: randomUUID() }],
    ['conteúdo acima de 2000 caracteres', { content: 'x'.repeat(2001), clientMessageId: randomUUID() }],
    ['sem clientMessageId', { content: 'Oi' }],
    ['clientMessageId que não é UUID', { content: 'Oi', clientMessageId: 'abc' }],
    ['conteúdo que não é texto', { content: 42, clientMessageId: randomUUID() }],
    ['corpo vazio', {}],
  ])('rejeita %s antes de abrir o stream e não grava nada', async (_name, body) => {
    const h = await buildHarness();
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    const res = await request(h.app).post(`/api/conversations/${id}/messages`).set(bearer(token)).send(body);
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/json');
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    expect((await history(h, token, id)).messages).toEqual([]);
    expect((await history(h, token, id)).employeeMessageCount).toBe(0);
  });

  it('aceita exatamente 2000 caracteres', async () => {
    const h = await buildHarness();
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    expect((await send(h, token, id, 'x'.repeat(2000))).status).toBe(200);
  });

  it('exige login de funcionário', async () => {
    const h = await buildHarness();
    const id = await startConversation(h, await h.login(ANA));
    const body = { content: 'Oi', clientMessageId: randomUUID() };
    expect((await request(h.app).post(`/api/conversations/${id}/messages`).send(body)).status).toBe(401);
    expect((await request(h.app).post(`/api/conversations/${id}/messages`).set(bearer(await h.login(MARCOS))).send(body)).status).toBe(403);
  });
});

describe('idempotência e ordenação', () => {
  it('reenviar o mesmo clientMessageId não duplica a mensagem nem consome o limite', async () => {
    const respond = vi.fn<AgentResponder['respond']>(async function* () {
      yield { event: 'agent.delta', data: { text: 'Olá' } };
    });
    const h = await buildHarness({ responder: { respond } });
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    const clientMessageId = randomUUID();

    const first = parseSse((await send(h, token, id, 'Preciso de ajuda', clientMessageId)).text);
    const second = parseSse((await send(h, token, id, 'Preciso de ajuda', clientMessageId)).text);

    expect(second.map((e) => e.event)).toEqual(['message.accepted', 'done']); // sem nova resposta do agente
    expect((second[0]?.data.message as { id: string }).id).toBe((first[0]?.data.message as { id: string }).id);
    expect(respond).toHaveBeenCalledOnce();
    const conversation = await history(h, token, id);
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.employeeMessageCount).toBe(1);
  });

  it('o mesmo clientMessageId com outro texto devolve a mensagem original, sem sobrescrever', async () => {
    const h = await buildHarness();
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    const clientMessageId = randomUUID();
    await send(h, token, id, 'Texto original', clientMessageId);
    const retry = parseSse((await send(h, token, id, 'Texto trocado', clientMessageId)).text);
    expect((retry[0]?.data.message as { content: string }).content).toBe('Texto original');
    expect((await history(h, token, id)).messages.map((m) => m.content)).toEqual(['Texto original']);
  });

  it('o mesmo clientMessageId em outra conversa é uma mensagem nova', async () => {
    const h = await buildHarness();
    const token = await h.login(ANA);
    const a = await startConversation(h, token);
    await send(h, token, a, 'Primeira');
    const b = await startConversation(h, token);
    const shared = randomUUID();
    await send(h, token, a, 'Em A', shared);
    await send(h, token, b, 'Em B', shared);
    expect((await history(h, token, b)).messages.map((m) => m.content)).toEqual(['Em B']);
  });

  it('requisições simultâneas com o mesmo clientMessageId gravam uma única vez', async () => {
    const h = await buildHarness();
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    const clientMessageId = randomUUID();
    const responses = await withServer(h.app, (server) =>
      Promise.all(Array.from({ length: 10 }, () => send(h, token, id, 'Só uma vez', clientMessageId, server))),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(new Set(responses.map((r) => (parseSse(r.text)[0]?.data.message as { id: string }).id)).size).toBe(1);
    const conversation = await history(h, token, id);
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.employeeMessageCount).toBe(1);
  });

  it('mantém a ordem de envio, com createdAt estritamente crescente mesmo com relógio parado', async () => {
    const h = await buildHarness(); // relógio fixo: todas as mensagens chegam "no mesmo instante"
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    const sent: string[] = [];
    for (let i = 1; i <= 8; i++) {
      sent.push(`mensagem ${i}`);
      await send(h, token, id, `mensagem ${i}`);
      if (i % 3 === 0) {
        sent.push(`resposta ${i}`);
        h.conversations.addMessage(id, 'AGENT', `resposta ${i}`, h.clock.current);
      }
    }
    const { messages } = await history(h, token, id);
    expect(messages.map((m) => m.content)).toEqual(sent);
    const times = messages.map((m) => Date.parse(m.createdAt));
    expect(times.every((t, i) => i === 0 || t > (times[i - 1] ?? 0))).toBe(true);
  });

  it('envios simultâneos distintos são todos gravados, em ordem consistente', async () => {
    const h = await buildHarness();
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    await withServer(h.app, (server) => Promise.all(Array.from({ length: 12 }, (_, i) => send(h, token, id, `paralela ${i}`, randomUUID(), server))));
    const conversation = await history(h, token, id);
    expect(conversation.messages).toHaveLength(12);
    expect(conversation.employeeMessageCount).toBe(12);
    const times = conversation.messages.map((m) => Date.parse(m.createdAt));
    expect(times.every((t, i) => i === 0 || t > (times[i - 1] ?? 0))).toBe(true);
  });
});

describe('limite de mensagens por sessão (PRD: 30)', () => {
  it('aceita 30 e recusa a 31ª com 429, sem gravar', async () => {
    expect(MAX_EMPLOYEE_MESSAGES_PER_SESSION).toBe(30);
    const h = await buildHarness();
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    const firstId = randomUUID();
    await send(h, token, id, 'mensagem 1', firstId);
    for (let i = 2; i <= 30; i++) expect((await send(h, token, id, `mensagem ${i}`)).status).toBe(200);

    const over = await send(h, token, id, 'mensagem 31');
    expect(over.status).toBe(429);
    expect(over.headers['content-type']).toContain('application/json');
    expect(errorOf(over)).toMatchObject({ code: 'MESSAGE_LIMIT_REACHED', retryable: false });

    const conversation = await history(h, token, id);
    expect(conversation.messages).toHaveLength(30);
    expect(conversation.employeeMessageCount).toBe(30);

    // reenviar uma mensagem já aceita continua funcionando: não é uma 31ª mensagem
    expect((await send(h, token, id, 'mensagem 1', firstId)).status).toBe(200);
    // outra conversa não é afetada
    const other = await startConversation(h, token);
    expect((await send(h, token, other, 'conversa nova')).status).toBe(200);
  });

  it('com 40 envios simultâneos exatamente 30 passam', async () => {
    const h = await buildHarness();
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    const responses = await withServer(h.app, (server) =>
      Promise.all(Array.from({ length: 40 }, (_, i) => send(h, token, id, `rajada ${i}`, randomUUID(), server))),
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(30);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(10);
    expect((await history(h, token, id)).messages).toHaveLength(30);
  });

  it('mensagens mais antigas do agente não contam no limite', async () => {
    const h = await buildHarness({ messageLimit: 2 });
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    await send(h, token, id, 'um');
    h.conversations.addMessage(id, 'AGENT', 'resposta', new Date());
    expect((await send(h, token, id, 'dois')).status).toBe(200);
    expect((await send(h, token, id, 'três')).status).toBe(429);
  });
});

describe('estado da conversa e agente pausado', () => {
  it('conversa encerrada não aceita mensagens (409) e nada é gravado', async () => {
    const respond = vi.fn<AgentResponder['respond']>(async function* () {});
    const h = await buildHarness({ responder: { respond } });
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    await send(h, token, id, 'antes de encerrar');
    h.conversations.setStatus(id, 'CLOSED');
    respond.mockClear();

    const res = await send(h, token, id, 'depois de encerrar');
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('INVALID_STATE_TRANSITION');
    expect((await history(h, token, id)).messages).toHaveLength(1);
    expect(respond).not.toHaveBeenCalled();
  });

  it.each(['WAITING_ANALYST', 'WITH_ANALYST'] as const)('com a conversa em %s a mensagem é gravada e o agente NÃO responde', async (status) => {
    const respond = vi.fn<AgentResponder['respond']>(async function* () {
      yield { event: 'agent.delta', data: { text: 'não deveria sair' } };
    });
    const h = await buildHarness({ responder: { respond } });
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    h.conversations.setStatus(id, status);

    const res = await send(h, token, id, 'Alguém pode me ajudar?');
    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    expect(events.map((e) => e.event)).toEqual(['message.accepted', 'conversation.status', 'done']);
    expect(events[1]?.data).toMatchObject({ status });
    expect(respond).not.toHaveBeenCalled();
    expect((await history(h, token, id)).messages.map((m) => m.content)).toEqual(['Alguém pode me ajudar?']);
  });

  it('com o agente, a resposta é repassada pelo stream na ordem do contrato', async () => {
    const received: string[] = [];
    const responder: AgentResponder = {
      async *respond({ message, user, conversation }) {
        received.push(`${user.id}|${conversation.status}|${message.content}`);
        yield { event: 'agent.step', data: { step: { kind: 'listMyTickets', label: 'consultou seus chamados', status: 'OK' } } } satisfies ChatStreamEvent;
        yield { event: 'agent.delta', data: { text: 'Você tem ' } };
        yield { event: 'agent.delta', data: { text: '3 chamados.' } };
      },
    };
    const h = await buildHarness({ responder });
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    const res = await send(h, token, id, 'Quais são meus chamados?');
    expect(parseSse(res.text).map((e) => e.event)).toEqual(['message.accepted', 'agent.step', 'agent.delta', 'agent.delta', 'done']);
    expect(received).toEqual([`${ANA.id}|WITH_AGENT|Quais são meus chamados?`]);
  });

  it('falha do agente no meio do stream vira evento `error`, sem vazar detalhes, e a mensagem permanece gravada', async () => {
    const h = await buildHarness({
      responder: {
        // eslint-disable-next-line require-yield
        async *respond() {
          throw new Error('chave sk-secreta-123 rejeitada pelo provedor');
        },
      },
    });
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    const res = await send(h, token, id, 'Oi');
    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    expect(events.map((e) => e.event)).toEqual(['message.accepted', 'error', 'done']);
    expect(events[1]?.data).toMatchObject({ error: { code: 'AGENT_UNAVAILABLE', retryable: true } });
    expect(res.text).not.toContain('sk-secreta-123');
    expect(h.logger.error).toHaveBeenCalledOnce();
    expect((await history(h, token, id)).messages).toHaveLength(1);
  });

  it('evento fora do contrato nunca chega ao cliente', async () => {
    const h = await buildHarness({
      responder: {
        async *respond() {
          yield { event: 'agent.delta', data: { texto: 'campo errado' } } as unknown as ChatStreamEvent;
        },
      },
    });
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    const events = parseSse((await send(h, token, id, 'Oi')).text);
    expect(events.map((e) => e.event)).toEqual(['message.accepted', 'error', 'done']);
  });

  it('sem agente configurado, a mensagem é gravada e o stream termina', async () => {
    const h = await buildHarness();
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    expect(parseSse((await send(h, token, id)).text).map((e) => e.event)).toEqual(['message.accepted', 'done']);
  });
});

describe('isolamento entre funcionários', () => {
  it('não escreve na conversa de outro funcionário: 404 e nada gravado', async () => {
    const h = await buildHarness();
    const bruno = await h.login(BRUNO);
    const brunosId = await startConversation(h, bruno);
    const ana = await h.login(ANA);

    const res = await send(h, ana, brunosId, 'Tentando escrever na conversa alheia');
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('NOT_FOUND');
    expect(res.text).not.toContain(brunosId);
    expect((await history(h, bruno, brunosId)).messages).toEqual([]);
    expect((await history(h, bruno, brunosId)).employeeMessageCount).toBe(0);
  });

  it('conversa inexistente e de terceiro respondem igual', async () => {
    const h = await buildHarness();
    const brunosId = await startConversation(h, await h.login(BRUNO));
    const ana = await h.login(ANA);
    const foreign = await send(h, ana, brunosId);
    const missing = await send(h, ana, 'conv_nao_existe');
    expect(foreign.status).toBe(missing.status);
    expect(errorOf(foreign).message).toBe(errorOf(missing).message);
  });

  it('o mesmo clientMessageId de outro funcionário não revela nem devolve mensagem alheia', async () => {
    const h = await buildHarness();
    const bruno = await h.login(BRUNO);
    const brunosId = await startConversation(h, bruno);
    const shared = randomUUID();
    await send(h, bruno, brunosId, 'Segredo do Bruno', shared);

    const ana = await h.login(ANA);
    const anasId = await startConversation(h, ana);
    const res = await send(h, ana, anasId, 'Mensagem da Ana', shared);
    expect((parseSse(res.text)[0]?.data.message as { content: string }).content).toBe('Mensagem da Ana');
    expect(res.text).not.toContain('Segredo do Bruno');
  });
});
