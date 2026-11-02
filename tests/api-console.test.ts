import {
  ApiErrorBodySchema,
  ConsoleConversationDetailSchema,
  ConsoleConversationItemSchema,
  ConversationDetailSchema,
  ConversationEventSchema,
  ConversationSummarySchema,
  MessageSchema,
} from '@nexo/shared';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AgentResponder } from '../apps/api/src/conversations/responder.js';
import { ANA, BRUNO, type Harness, LUCAS, MARCOS, PAULA, bearer, buildHarness, local } from './helpers/api-harness.js';
import { openEvents } from './helpers/event-stream.js';
import { type TestResponse, request } from './helpers/http.js';

const errorOf = (res: TestResponse) => ApiErrorBodySchema.parse(res.body).error;
/** Corpo de erro sem o `requestId`, que muda a cada requisição. */
const withoutRequestId = (body: unknown) => {
  const { error } = ApiErrorBodySchema.parse(body);
  const { requestId: _ignored, ...rest } = error;
  return rest;
};

function call(h: Harness, method: string, path: string, token?: string, body?: object) {
  const client = request(h.app);
  const req = method === 'get' ? client.get(path) : client.post(path).send(body ?? {});
  return token ? req.set(bearer(token)) : req;
}

async function startConversation(h: Harness, token: string): Promise<string> {
  const res = await request(h.app).post('/api/conversations').set(bearer(token));
  return (res.body as { conversation: { id: string } }).conversation.id;
}

const sendAsEmployee = (h: Harness, token: string, id: string, content = 'Meu notebook está lento', clientMessageId: string = randomUUID()) =>
  request(h.app).post(`/api/conversations/${id}/messages`).set(bearer(token)).send({ content, clientMessageId });

/** Conversa da Ana com uma mensagem e uma transferência pendente (o que o agente deixa no banco). */
async function transferred(h: Harness, owner = ANA, at = local('2026-11-02T10:05:00'), title = 'Meu notebook está lento') {
  const token = await h.login(owner);
  const id = await startConversation(h, token);
  await sendAsEmployee(h, token, id, title);
  const handoff = h.conversations.transfer(id, { reason: 'OVERDUE_TICKET', summary: 'Chamado INC-20311 vencido; o funcionário quer um analista.', relatedTicketCode: 'INC-20311' }, at);
  return { id, token, handoff };
}

const consoleGet = (h: Harness, token: string, path: string) => request(h.app).get(`/api/console${path}`).set(bearer(token));
const consolePost = (h: Harness, token: string, path: string, body: unknown = {}) => request(h.app).post(`/api/console${path}`).set(bearer(token)).send(body);
const act = (h: Harness, token: string, id: string, action: 'assume' | 'return' | 'close', expectedVersion: number, extra: object = {}) =>
  consolePost(h, token, `/conversations/${id}/${action}`, { expectedVersion, ...extra });
const analystSays = (h: Harness, token: string, id: string, content = 'Olá, sou do suporte.', clientMessageId: string = randomUUID()) =>
  consolePost(h, token, `/conversations/${id}/messages`, { content, clientMessageId });

async function detail(h: Harness, token: string, id: string) {
  const res = await consoleGet(h, token, `/conversations/${id}`);
  expect(res.status).toBe(200);
  return ConsoleConversationDetailSchema.parse(res.body.conversation);
}

async function employeeView(h: Harness, token: string, id: string) {
  const res = await request(h.app).get(`/api/conversations/${id}`).set(bearer(token));
  return ConversationDetailSchema.parse(res.body.conversation);
}

describe('autorização do console', () => {
  const routes = (id: string): Array<[string, string, object?]> => [
    ['get', '/conversations'],
    ['get', `/conversations/${id}`],
    ['post', `/conversations/${id}/assume`, { expectedVersion: 1 }],
    ['post', `/conversations/${id}/return`, { expectedVersion: 1 }],
    ['post', `/conversations/${id}/close`, { expectedVersion: 1 }],
    ['post', `/conversations/${id}/messages`, { content: 'oi', clientMessageId: randomUUID() }],
  ];

  it('exige login em todas as rotas', async () => {
    const h = await buildHarness();
    const { id } = await transferred(h);
    for (const [method, path, body] of routes(id)) {
      const res = await call(h, method, `/api/console${path}`, undefined, body);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('funcionário nunca acessa o console, nem a própria conversa, e não recebe dado algum', async () => {
    const h = await buildHarness();
    const { id, token } = await transferred(h);
    for (const [method, path, body] of routes(id)) {
      const res = await call(h, method, `/api/console${path}`, token, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(errorOf(res).code).toBe('FORBIDDEN');
      expect(res.text).not.toContain('Meu notebook');
    }
    expect((await detail(h, await h.login(MARCOS), id)).status).toBe('WAITING_ANALYST'); // continua intacta
  });

  it('o papel vem do servidor: cabeçalhos e corpo que dizem "analista" não adiantam', async () => {
    const h = await buildHarness();
    const { id, token } = await transferred(h);
    const res = await request(h.app)
      .post(`/api/console/conversations/${id}/assume`)
      .set({ ...bearer(token), 'x-role': 'ANALYST', 'x-user-role': 'ANALYST' })
      .send({ expectedVersion: 1, role: 'ANALYST', analystLevel: 'N2', analystId: MARCOS.id });
    expect(res.status).toBe(403);
  });

  it('recusa analista sem nível N1/N2 (dado inconsistente)', async () => {
    const h = await buildHarness();
    const { id } = await transferred(h);
    const res = await consoleGet(h, await h.login(LUCAS), '/conversations');
    expect(res.status).toBe(403);
    expect((await act(h, await h.login(LUCAS), id, 'assume', 1)).status).toBe(403);
  });

  it('analistas N1 e N2 têm acesso', async () => {
    const h = await buildHarness();
    await transferred(h);
    for (const analyst of [MARCOS, PAULA]) {
      const res = await consoleGet(h, await h.login(analyst), '/conversations');
      expect(res.status, analyst.analystLevel ?? '').toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.items).toHaveLength(1);
    }
  });
});

describe('fila de atendimento', () => {
  it('lista só conversas transferidas, com funcionário, motivo e resumo', async () => {
    const h = await buildHarness();
    const { id } = await transferred(h);
    const brunoToken = await h.login(BRUNO);
    const semTransferencia = await startConversation(h, brunoToken);
    await sendAsEmployee(h, brunoToken, semTransferencia, 'Só uma dúvida sobre VPN');

    const res = await consoleGet(h, await h.login(MARCOS), '/conversations');
    expect(res.status).toBe(200);
    const items = (res.body.items as unknown[]).map((item) => ConsoleConversationItemSchema.parse(item));
    expect(items.map((item) => item.id)).toEqual([id]);
    expect(items[0]).toMatchObject({
      status: 'WAITING_ANALYST',
      version: 1,
      assignedAnalystId: null,
      employee: { id: ANA.id, name: 'Ana Souza', email: ANA.email, department: 'Marketing' },
      activeHandoff: { reason: 'OVERDUE_TICKET', status: 'WAITING', relatedTicketCode: 'INC-20311', summary: expect.stringContaining('INC-20311') },
    });
    expect(res.body.nextCursor).toBeNull();
  });

  it('o item expõe do funcionário só o necessário (sem papel nem nível)', async () => {
    const h = await buildHarness();
    await transferred(h);
    const res = await consoleGet(h, await h.login(MARCOS), '/conversations');
    expect(Object.keys(res.body.items[0].employee).sort()).toEqual(['department', 'email', 'id', 'name']);
    expect(res.body.items[0]).not.toHaveProperty('messages');
  });

  it('a conversa que não foi transferida não existe para o analista (nem no detalhe nem nas ações)', async () => {
    const h = await buildHarness();
    const token = await h.login(ANA);
    const id = await startConversation(h, token);
    await sendAsEmployee(h, token, id);
    const marcos = await h.login(MARCOS);

    const missing = await consoleGet(h, marcos, '/conversations/conv_inexistente');
    for (const res of [await consoleGet(h, marcos, `/conversations/${id}`), await act(h, marcos, id, 'assume', 0), await act(h, marcos, id, 'close', 0), await analystSays(h, marcos, id)]) {
      expect(res.status).toBe(404);
      expect(withoutRequestId(res.body)).toEqual(withoutRequestId(missing.body)); // indistinguível de "não existe"
    }
    expect((await employeeView(h, token, id)).status).toBe('WITH_AGENT');
  });

  it('filtra por status', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const a = await transferred(h, ANA, local('2026-11-02T10:05:00'));
    const b = await transferred(h, BRUNO, local('2026-11-02T10:06:00'));
    h.clock.current = local('2026-11-02T10:30:00'); // dentro da validade das sessões (1 h)
    await act(h, marcos, b.id, 'assume', 1);

    const ids = async (query: string) => ((await consoleGet(h, marcos, `/conversations${query}`)).body.items as Array<{ id: string }>).map((i) => i.id);
    expect(await ids('?status=WAITING_ANALYST')).toEqual([a.id]);
    expect(await ids('?status=WITH_ANALYST')).toEqual([b.id]);
    expect(await ids('?status=CLOSED')).toEqual([]);
    expect(await ids('')).toEqual([b.id, a.id]); // sem filtro: atividade mais recente primeiro
  });

  it('busca por nome, e-mail do funcionário ou título, sem diferenciar maiúsculas', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const ana = await transferred(h, ANA, local('2026-11-02T10:05:00'), 'Problema com a VPN');
    const bruno = await transferred(h, BRUNO, local('2026-11-02T10:06:00'), 'Sem acesso ao CRM');

    const ids = async (q: string) => ((await consoleGet(h, marcos, `/conversations?q=${encodeURIComponent(q)}`)).body.items as Array<{ id: string }>).map((i) => i.id);
    expect(await ids('ANA SOU')).toEqual([ana.id]);
    expect(await ids('bruno.lima@')).toEqual([bruno.id]);
    expect(await ids('crm')).toEqual([bruno.id]);
    expect(await ids('ninguém')).toEqual([]);
  });

  it('pagina por cursor sem repetir nem pular conversas', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const created = [
      await transferred(h, ANA, local('2026-11-02T10:05:00')),
      await transferred(h, BRUNO, local('2026-11-02T10:06:00')),
      await transferred(h, ANA, local('2026-11-02T10:07:00')),
    ];
    const first = await consoleGet(h, marcos, '/conversations?limit=2');
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await consoleGet(h, marcos, `/conversations?limit=2&cursor=${encodeURIComponent(first.body.nextCursor as string)}`);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    const all = [...first.body.items, ...second.body.items].map((i: { id: string }) => i.id);
    expect(all).toEqual(created.map((c) => c.id).reverse());
  });

  it('valida os parâmetros', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    for (const query of ['?limit=0', '?limit=101', '?limit=abc', '?status=OUTRO', '?cursor=lixo', `?q=${'x'.repeat(101)}`]) {
      const res = await consoleGet(h, marcos, `/conversations${query}`);
      expect(res.status, query).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('detalhe da conversa', () => {
  it('traz histórico, decisões, transferências e os chamados do funcionário atendido, só dele', async () => {
    const h = await buildHarness();
    const { id } = await transferred(h);
    const conversation = await detail(h, await h.login(MARCOS), id);

    expect(conversation).toMatchObject({ id, status: 'WAITING_ANALYST', employee: { id: ANA.id, email: ANA.email, role: 'EMPLOYEE' } });
    expect(conversation.messages.map((m) => m.role)).toEqual(['EMPLOYEE']);
    expect(conversation.decisions).toEqual([]);
    expect(conversation.handoffs).toHaveLength(1);
    expect(conversation.handoffs[0]).toMatchObject({ reason: 'OVERDUE_TICKET', status: 'WAITING', relatedTicketCode: 'INC-20311', assumedById: null });
    const codes = conversation.employeeTickets.map((t) => t.code).sort();
    expect(codes).toEqual(['INC-19980', 'INC-20150', 'INC-20311']);
    expect(codes).not.toContain('INC-20344'); // chamado do Bruno
  });

  it('o painel de chamados acompanha o funcionário da conversa, não o analista nem a consulta', async () => {
    const h = await buildHarness();
    const { id } = await transferred(h, BRUNO);
    const res = await request(h.app).get(`/api/console/conversations/${id}?employeeId=${ANA.id}`).set({ ...bearer(await h.login(MARCOS)), 'x-employee-id': ANA.id });
    const conversation = ConsoleConversationDetailSchema.parse(res.body.conversation);
    expect(conversation.employee.id).toBe(BRUNO.id);
    expect(conversation.employeeTickets.map((t) => t.code)).toEqual(['INC-20344']);
  });

  it('não vaza segredos nem credenciais', async () => {
    const h = await buildHarness();
    const { id, token } = await transferred(h);
    const res = await consoleGet(h, await h.login(MARCOS), `/conversations/${id}`);
    expect(res.text).not.toContain(token);
    expect(res.text.toLowerCase()).not.toMatch(/password|senha-hash|secret|authorization/);
  });

  it('uma transferência encerrada continua no histórico', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const { id } = await transferred(h);
    await act(h, marcos, id, 'assume', 1);
    await act(h, marcos, id, 'return', 2);
    h.conversations.transfer(id, { reason: 'LOW_CONFIDENCE', summary: 'Nova transferência.' }, local('2026-11-02T11:00:00'));

    const conversation = await detail(h, marcos, id);
    expect(conversation.handoffs.map((x) => [x.reason, x.status])).toEqual([
      ['OVERDUE_TICKET', 'RETURNED_TO_AGENT'],
      ['LOW_CONFIDENCE', 'WAITING'],
    ]);
    expect(conversation.handoffs[0]).toMatchObject({ assumedById: MARCOS.id, assumedAt: expect.any(String), endedAt: expect.any(String) });
  });
});

describe('assumir o atendimento', () => {
  it('leva a WAITING_ANALYST → WITH_ANALYST, registra o responsável e a transferência', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const { id, token } = await transferred(h);

    const res = await act(h, marcos, id, 'assume', 1);
    expect(res.status).toBe(200);
    expect(ConversationSummarySchema.parse(res.body.conversation)).toMatchObject({ status: 'WITH_ANALYST', assignedAnalystId: MARCOS.id, version: 2 });

    const conversation = await detail(h, marcos, id);
    expect(conversation.handoffs[0]).toMatchObject({ status: 'ASSUMED', assumedById: MARCOS.id, assumedAt: expect.any(String), endedAt: null });
    expect(await employeeView(h, token, id)).toMatchObject({ status: 'WITH_ANALYST', assignedAnalystId: MARCOS.id });
  });

  it('um analista N2 também assume', async () => {
    const h = await buildHarness();
    const { id } = await transferred(h);
    const res = await act(h, await h.login(PAULA), id, 'assume', 1);
    expect(res.body.conversation).toMatchObject({ status: 'WITH_ANALYST', assignedAnalystId: PAULA.id });
  });

  it('dois analistas ao mesmo tempo: exatamente um assume, o outro recebe conflito', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const paula = await h.login(PAULA);
    const { id } = await transferred(h);

    const [a, b] = await Promise.all([act(h, marcos, id, 'assume', 1), act(h, paula, id, 'assume', 1)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const [winner, loser, winnerUser] = a.status === 200 ? [a, b, MARCOS] : [b, a, PAULA];
    expect(winner.body.conversation.assignedAnalystId).toBe(winnerUser.id);
    expect(errorOf(loser).code).toBe('CONFLICT');
    expect(loser.body.error.details).toEqual({ status: 'WITH_ANALYST', version: 2 });

    const conversation = await detail(h, marcos, id);
    expect(conversation.assignedAnalystId).toBe(winnerUser.id);
    expect(conversation.version).toBe(2);
    expect(conversation.handoffs.filter((x) => x.status === 'ASSUMED')).toHaveLength(1);
  });

  it('quem chega depois, já vendo a conversa assumida, é recusado por estado', async () => {
    const h = await buildHarness();
    const { id } = await transferred(h);
    await act(h, await h.login(MARCOS), id, 'assume', 1);
    const res = await act(h, await h.login(PAULA), id, 'assume', 2);
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('INVALID_STATE_TRANSITION');
    expect((await detail(h, await h.login(PAULA), id)).assignedAnalystId).toBe(MARCOS.id);
  });

  it('repetir o próprio pedido (resposta perdida) não muda nada nem avisa o funcionário de novo', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const { id } = await transferred(h);
    const first = await act(h, marcos, id, 'assume', 1);
    const again = await act(h, marcos, id, 'assume', 1);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect((await detail(h, marcos, id)).version).toBe(2);
  });

  it('versão desatualizada não assume (conflito, nada muda)', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const { id } = await transferred(h);
    const res = await act(h, marcos, id, 'assume', 0);
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('CONFLICT');
    expect(res.body.error.details).toEqual({ status: 'WAITING_ANALYST', version: 1 });
    expect((await detail(h, marcos, id)).status).toBe('WAITING_ANALYST');
  });

  it('só se assume conversa que aguarda atendimento', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const { id } = await transferred(h);
    await act(h, marcos, id, 'assume', 1);
    await act(h, marcos, id, 'return', 2); // WITH_AGENT, versão 3
    const res = await act(h, marcos, id, 'assume', 3);
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('INVALID_STATE_TRANSITION');
  });

  it('valida o corpo e ignora quem diz estar agindo', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const { id } = await transferred(h);
    for (const body of [{}, { expectedVersion: -1 }, { expectedVersion: '1' }, { expectedVersion: 1.5 }]) {
      const res = await consolePost(h, marcos, `/conversations/${id}/assume`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const res = await act(h, marcos, id, 'assume', 1, { analystId: PAULA.id, assignedAnalystId: PAULA.id, status: 'CLOSED' });
    expect(res.body.conversation).toMatchObject({ assignedAnalystId: MARCOS.id, status: 'WITH_ANALYST' });
  });
});

describe('atendimento humano', () => {
  async function assumed(h: Harness) {
    const marcos = await h.login(MARCOS);
    const conv = await transferred(h);
    await act(h, marcos, conv.id, 'assume', 1);
    return { ...conv, marcos };
  }

  it('o responsável responde; a mensagem fica registrada com o autor e o funcionário a vê', async () => {
    const h = await buildHarness();
    const { id, token, marcos } = await assumed(h);
    const res = await analystSays(h, marcos, id, 'Olá Ana, já estou vendo o seu chamado.');
    expect(res.status).toBe(201);
    expect(MessageSchema.parse(res.body.message)).toMatchObject({ role: 'ANALYST', authorId: MARCOS.id, conversationId: id, content: 'Olá Ana, já estou vendo o seu chamado.', decisionId: null });

    const messages = (await employeeView(h, token, id)).messages;
    expect(messages.map((m) => [m.role, m.authorId])).toEqual([['EMPLOYEE', ANA.id], ['ANALYST', MARCOS.id]]);
  });

  it('preserva a ordem da conversa quando funcionário e analista se alternam', async () => {
    const h = await buildHarness();
    const { id, token, marcos } = await assumed(h);
    for (const [who, text] of [['analyst', 'um'], ['employee', 'dois'], ['analyst', 'três'], ['employee', 'quatro']] as const) {
      if (who === 'analyst') await analystSays(h, marcos, id, text);
      else await sendAsEmployee(h, token, id, text);
    }
    const messages = (await detail(h, marcos, id)).messages;
    expect(messages.map((m) => m.content)).toEqual(['Meu notebook está lento', 'um', 'dois', 'três', 'quatro']);
    const times = messages.map((m) => Date.parse(m.createdAt));
    expect(times).toEqual([...times].sort((x, y) => x - y));
    expect(new Set(times).size).toBe(times.length); // nunca empata
  });

  it('outro analista (inclusive N2) não responde por quem assumiu', async () => {
    const h = await buildHarness();
    const { id } = await assumed(h);
    const res = await analystSays(h, await h.login(PAULA), id, 'Posso ajudar?');
    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
    expect((await detail(h, await h.login(MARCOS), id)).messages.map((m) => m.role)).toEqual(['EMPLOYEE']);
  });

  it('não responde sem assumir, nem depois de devolver ou encerrar', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const waiting = await transferred(h);
    expect(errorOf(await analystSays(h, marcos, waiting.id)).code).toBe('INVALID_STATE_TRANSITION');

    const returned = await transferred(h, BRUNO);
    await act(h, marcos, returned.id, 'assume', 1);
    await act(h, marcos, returned.id, 'return', 2);
    expect((await analystSays(h, marcos, returned.id)).status).toBe(409);

    const closed = await transferred(h, ANA, local('2026-11-02T10:30:00'));
    await act(h, marcos, closed.id, 'close', 1);
    expect((await analystSays(h, marcos, closed.id)).status).toBe(409);
    for (const { id } of [waiting, returned, closed]) {
      expect((await detail(h, marcos, id)).messages.every((m) => m.role !== 'ANALYST')).toBe(true);
    }
  });

  it('reenvio com o mesmo clientMessageId não duplica; o identificador do funcionário não é reaproveitável', async () => {
    const h = await buildHarness();
    const { id, token, marcos } = await assumed(h);
    const clientMessageId = randomUUID();
    const first = await analystSays(h, marcos, id, 'Já verifiquei.', clientMessageId);
    const again = await analystSays(h, marcos, id, 'Já verifiquei.', clientMessageId);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.message.id).toBe(first.body.message.id);
    expect((await detail(h, marcos, id)).messages.filter((m) => m.role === 'ANALYST')).toHaveLength(1);

    const employeeMessageId = randomUUID();
    await sendAsEmployee(h, token, id, 'Obrigada', employeeMessageId);
    const clash = await analystSays(h, marcos, id, 'tentando reusar', employeeMessageId);
    expect(clash.status).toBe(409);
    expect(errorOf(clash).code).toBe('CONFLICT');
  });

  it('valida a mensagem', async () => {
    const h = await buildHarness();
    const { id, marcos } = await assumed(h);
    for (const body of [{ content: '   ', clientMessageId: randomUUID() }, { content: 'x'.repeat(4001), clientMessageId: randomUUID() }, { content: 'oi', clientMessageId: 'não-é-uuid' }, { content: 'oi' }]) {
      expect((await consolePost(h, marcos, `/conversations/${id}/messages`, body)).status).toBe(400);
    }
  });

  it('o agente não executa nem responde enquanto a conversa está com a equipe humana', async () => {
    const respond = vi.fn<AgentResponder['respond']>(async function* () {});
    const h = await buildHarness({ responder: { respond: (input) => respond(input) } });
    const marcos = await h.login(MARCOS);
    const { id, token } = await transferred(h);
    respond.mockClear(); // a primeira mensagem, ainda com o agente, foi respondida normalmente

    await sendAsEmployee(h, token, id, 'Ainda estou aqui'); // aguardando
    await act(h, marcos, id, 'assume', 1);
    await sendAsEmployee(h, token, id, 'E agora?'); // com o analista
    expect(respond).not.toHaveBeenCalled();
  });
});

describe('devolver ao agente', () => {
  it('só o responsável devolve; a conversa volta ao agente e o responsável é limpo', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const { id, token } = await transferred(h);
    await act(h, marcos, id, 'assume', 1);

    const outro = await act(h, await h.login(PAULA), id, 'return', 2);
    expect(outro.status).toBe(403);
    expect((await detail(h, marcos, id)).status).toBe('WITH_ANALYST');

    const res = await act(h, marcos, id, 'return', 2);
    expect(res.status).toBe(200);
    expect(res.body.conversation).toMatchObject({ status: 'WITH_AGENT', assignedAnalystId: null, version: 3 });
    const conversation = await detail(h, marcos, id);
    expect(conversation.handoffs[0]).toMatchObject({ status: 'RETURNED_TO_AGENT', assumedById: MARCOS.id, endedAt: expect.any(String) });
    expect(await employeeView(h, token, id)).toMatchObject({ status: 'WITH_AGENT', assignedAnalystId: null });
  });

  it('exige que a conversa esteja em atendimento e a versão correta', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const { id } = await transferred(h);
    expect(errorOf(await act(h, marcos, id, 'return', 1)).code).toBe('INVALID_STATE_TRANSITION'); // aguardando
    await act(h, marcos, id, 'assume', 1);
    expect(errorOf(await act(h, marcos, id, 'return', 1)).code).toBe('CONFLICT'); // versão antiga
  });

  it('depois de devolvida o agente volta a responder', async () => {
    const respond = vi.fn<AgentResponder['respond']>(async function* () {});
    const h = await buildHarness({ responder: { respond: (input) => respond(input) } });
    const marcos = await h.login(MARCOS);
    const { id, token } = await transferred(h);
    await act(h, marcos, id, 'assume', 1);
    await act(h, marcos, id, 'return', 2);
    respond.mockClear();

    await sendAsEmployee(h, token, id, 'Voltei, pode continuar?');
    expect(respond).toHaveBeenCalledOnce();
  });

  it('a mensagem que o analista já tratou não vira resposta pendente do agente; a que ficou sem resposta, sim', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);

    const tratada = await transferred(h);
    await act(h, marcos, tratada.id, 'assume', 1);
    await sendAsEmployee(h, tratada.token, tratada.id, 'Preciso de ajuda com a VPN');
    await analystSays(h, marcos, tratada.id, 'Resolvido, é só reiniciar o cliente.');
    await act(h, marcos, tratada.id, 'return', 2);
    expect((await employeeView(h, tratada.token, tratada.id)).pendingAgentResponse).toBeNull();

    const ignorada = await transferred(h, BRUNO, local('2026-11-02T10:40:00'));
    await act(h, marcos, ignorada.id, 'assume', 1);
    const sent = await sendAsEmployee(h, ignorada.token, ignorada.id, 'Alguém me responde?');
    const messageId = (sent.text.match(/"message":\{"id":"([^"]+)"/) ?? [])[1];
    await act(h, marcos, ignorada.id, 'return', 2);
    expect((await employeeView(h, ignorada.token, ignorada.id)).pendingAgentResponse).toEqual({ messageId });
  });
});

describe('encerrar', () => {
  it('o responsável encerra a conversa em atendimento; o registro da transferência fica', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const { id, token } = await transferred(h);
    await act(h, marcos, id, 'assume', 1);
    const res = await act(h, marcos, id, 'close', 2);
    expect(res.status).toBe(200);
    expect(res.body.conversation).toMatchObject({ status: 'CLOSED', version: 3, assignedAnalystId: MARCOS.id });

    const conversation = await detail(h, marcos, id);
    expect(conversation.handoffs[0]).toMatchObject({ status: 'CLOSED', assumedById: MARCOS.id, endedAt: expect.any(String) });
    const blocked = await sendAsEmployee(h, token, id, 'Posso escrever?');
    expect(blocked.status).toBe(409);
    expect(errorOf(blocked).code).toBe('INVALID_STATE_TRANSITION');
  });

  it('outro analista não encerra a conversa de quem está atendendo', async () => {
    const h = await buildHarness();
    const { id } = await transferred(h);
    await act(h, await h.login(MARCOS), id, 'assume', 1);
    const res = await act(h, await h.login(PAULA), id, 'close', 2);
    expect(res.status).toBe(403);
    expect((await detail(h, await h.login(MARCOS), id)).status).toBe('WITH_ANALYST');
  });

  it('qualquer analista encerra uma conversa que ainda aguarda atendimento', async () => {
    const h = await buildHarness();
    const { id } = await transferred(h);
    const paula = await h.login(PAULA);
    const res = await act(h, paula, id, 'close', 1);
    expect(res.status).toBe(200);
    expect(res.body.conversation).toMatchObject({ status: 'CLOSED', assignedAnalystId: null });
    expect((await detail(h, paula, id)).handoffs[0]).toMatchObject({ status: 'CLOSED', assumedById: null, endedAt: expect.any(String) });
  });

  it('não se encerra duas vezes nem uma conversa que está com o agente', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const { id } = await transferred(h);
    await act(h, marcos, id, 'close', 1);
    expect(errorOf(await act(h, marcos, id, 'close', 2)).code).toBe('INVALID_STATE_TRANSITION');

    const other = await transferred(h, BRUNO, local('2026-11-02T10:40:00'));
    await act(h, marcos, other.id, 'assume', 1);
    await act(h, marcos, other.id, 'return', 2);
    expect(errorOf(await act(h, marcos, other.id, 'close', 3)).code).toBe('INVALID_STATE_TRANSITION');
  });

  it('versão desatualizada não encerra', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const { id } = await transferred(h);
    expect(errorOf(await act(h, marcos, id, 'close', 0)).code).toBe('CONFLICT');
    expect((await detail(h, marcos, id)).status).toBe('WAITING_ANALYST');
  });
});

describe('eventos para o funcionário (SSE)', () => {
  const eventsOf = (h: Harness, token: string, id: string, query = '', extra: Record<string, string> = {}) =>
    openEvents(h.app, `/api/conversations/${id}/events${query}`, { ...bearer(token), ...extra });

  it('exige login de funcionário, dono da conversa', async () => {
    const h = await buildHarness();
    const { id, token } = await transferred(h);

    const anonymous = await openEvents(h.app, `/api/conversations/${id}/events`, {});
    expect(anonymous.status).toBe(401);
    const analyst = await eventsOf(h, await h.login(MARCOS), id);
    expect(analyst.status).toBe(403);
    const stranger = await eventsOf(h, await h.login(BRUNO), id);
    expect(stranger.status).toBe(404);
    expect(JSON.stringify(stranger.body)).not.toContain('Meu notebook');
    const missing = await eventsOf(h, token, 'conv_inexistente');
    expect(missing.status).toBe(404);
    expect(withoutRequestId(missing.body)).toEqual(withoutRequestId(stranger.body));
  });

  it('ao conectar informa o estado atual e segue aberto, com cabeçalhos de stream', async () => {
    const h = await buildHarness();
    const { id, token } = await transferred(h);
    const stream = await eventsOf(h, token, id);
    try {
      expect(stream.status).toBe(200);
      expect(stream.headers['content-type']).toContain('text/event-stream');
      expect(stream.headers['cache-control']).toContain('no-cache');
      expect(stream.headers['x-accel-buffering']).toBe('no');
      const [first] = await stream.waitForCount(1);
      expect(ConversationEventSchema.parse(first)).toMatchObject({ event: 'conversation.status', data: { status: 'WAITING_ANALYST', version: 1 } });
      expect(first?.id).toBeNull();
    } finally {
      await stream.close();
    }
  });

  it('entrega ao vivo as mudanças de estado e as mensagens do analista, na ordem', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const { id, token } = await transferred(h);
    const stream = await eventsOf(h, token, id);
    try {
      await stream.waitForCount(1);
      await act(h, marcos, id, 'assume', 1);
      const said = await analystSays(h, marcos, id, 'Olá! Estou com o seu caso.');
      await act(h, marcos, id, 'return', 2);

      const events = await stream.waitForCount(4);
      expect(events.map((e) => ConversationEventSchema.parse({ event: e.event, data: e.data }).event)).toEqual([
        'conversation.status',
        'conversation.status',
        'message.created',
        'conversation.status',
      ]);
      expect(events.slice(1).map((e) => e.data.status ?? e.data.message.role)).toEqual(['WITH_ANALYST', 'ANALYST', 'WITH_AGENT']);
      expect(events[2]).toMatchObject({ id: said.body.message.id, data: { message: { id: said.body.message.id, authorId: MARCOS.id } } });
      expect(events[3]?.data.version).toBe(3);
    } finally {
      await stream.close();
    }
  });

  it('o encerramento também chega', async () => {
    const h = await buildHarness();
    const { id, token } = await transferred(h);
    const stream = await eventsOf(h, token, id);
    try {
      await stream.waitForCount(1);
      await act(h, await h.login(MARCOS), id, 'close', 1);
      const events = await stream.waitForCount(2);
      expect(events[1]).toMatchObject({ event: 'conversation.status', data: { status: 'CLOSED', version: 2 } });
    } finally {
      await stream.close();
    }
  });

  it('isola por funcionário: cada um só recebe eventos da própria conversa', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const ana = await transferred(h, ANA, local('2026-11-02T10:05:00'));
    const bruno = await transferred(h, BRUNO, local('2026-11-02T10:06:00'));
    const anaStream = await eventsOf(h, ana.token, ana.id);
    const brunoStream = await eventsOf(h, bruno.token, bruno.id);
    try {
      await anaStream.waitForCount(1);
      await brunoStream.waitForCount(1);
      await act(h, marcos, ana.id, 'assume', 1);
      await analystSays(h, marcos, ana.id, 'Só para a Ana');
      await anaStream.waitForCount(3);
      const seenByBruno = await brunoStream.expectNoMoreThan(1);
      expect(JSON.stringify(seenByBruno)).not.toContain('Só para a Ana');
      expect(brunoStream.raw()).not.toContain(ana.id);
    } finally {
      await anaStream.close();
      await brunoStream.close();
    }
  });

  it('reconexão com Last-Event-ID recebe só o que perdeu, em ordem, sem repetir', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const { id, token } = await transferred(h);
    await act(h, marcos, id, 'assume', 1);

    const live = await eventsOf(h, token, id);
    const m1 = await analystSays(h, marcos, id, 'primeira');
    await live.waitForCount(2);
    await live.close(); // a conexão cai

    const m2 = await analystSays(h, marcos, id, 'segunda'); // enquanto desconectado
    const m3 = await analystSays(h, marcos, id, 'terceira');
    await act(h, marcos, id, 'return', 2);

    const resumed = await eventsOf(h, token, id, '', { 'last-event-id': m1.body.message.id });
    try {
      // Estado atual (a devolução que ele perdeu já está refletida) e as duas mensagens perdidas.
      const events = await resumed.waitForCount(3);
      expect(events.map((e) => e.event)).toEqual(['conversation.status', 'message.created', 'message.created']);
      expect(events[0]).toMatchObject({ event: 'conversation.status', data: { status: 'WITH_AGENT', version: 3 } });
      expect(events.slice(1).map((e) => e.id)).toEqual([m2.body.message.id, m3.body.message.id]);
      await resumed.expectNoMoreThan(3);
    } finally {
      await resumed.close();
    }
  });

  it('?after= recupera a diferença entre o histórico carregado e a conexão; sem ponto de partida só vem o estado', async () => {
    const h = await buildHarness();
    const marcos = await h.login(MARCOS);
    const { id, token } = await transferred(h);
    await act(h, marcos, id, 'assume', 1);
    const m1 = await analystSays(h, marcos, id, 'antes de abrir a tela');
    const m2 = await analystSays(h, marcos, id, 'entre o GET e o stream');

    const withAfter = await eventsOf(h, token, id, `?after=${m1.body.message.id}`);
    const without = await eventsOf(h, token, id);
    try {
      const events = await withAfter.waitForCount(2);
      expect(events.map((e) => e.id)).toEqual([null, m2.body.message.id]);
      await without.waitForCount(1);
      expect((await without.expectNoMoreThan(1)).map((e) => e.event)).toEqual(['conversation.status']);
    } finally {
      await withAfter.close();
      await without.close();
    }
  });

  it('Last-Event-ID malformado é recusado', async () => {
    const h = await buildHarness();
    const { id, token } = await transferred(h);
    const stream = await eventsOf(h, token, id, '', { 'last-event-id': 'x'.repeat(100) });
    expect(stream.status).toBe(400);
  });

  it('limita as conexões abertas por funcionário e libera ao fechar', async () => {
    const h = await buildHarness({ eventStreams: { maxPerUser: 2 } });
    const { id, token } = await transferred(h);
    const first = await eventsOf(h, token, id);
    const second = await eventsOf(h, token, id);
    await first.waitForCount(1);
    await second.waitForCount(1);
    const third = await eventsOf(h, token, id);
    expect(third.status).toBe(429);
    expect(errorOf({ status: third.status, headers: third.headers, text: '', body: third.body }).code).toBe('RATE_LIMITED');

    await first.close();
    await vi.waitFor(async () => {
      const retry = await eventsOf(h, token, id);
      expect(retry.status).toBe(200);
      await retry.close();
    });
    await second.close();
  });

  it('manda keep-alive e fecha as conexões quando o servidor encerra', async () => {
    const h = await buildHarness({ eventStreams: { heartbeatMs: 20 } });
    const { id, token } = await transferred(h);
    const stream = await eventsOf(h, token, id);
    try {
      await stream.waitForCount(1);
      await vi.waitFor(() => expect(stream.raw()).toContain(': keep-alive'));
      h.events.shutdown();
      await stream.waitForEnd();
    } finally {
      await stream.close();
    }
  });

  it('a assinatura é removida quando o cliente desconecta', async () => {
    const h = await buildHarness();
    const { id, token } = await transferred(h);
    const stream = await eventsOf(h, token, id);
    await stream.waitForCount(1);
    expect(h.events.size).toBe(1);
    await stream.close();
    await vi.waitFor(() => expect(h.events.size).toBe(0));
  });
});
