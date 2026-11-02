import { type ScriptStep, call, createScriptedModel, submit } from '@nexo/agent/testing';
import { ApiErrorBodySchema, ConsoleConversationDetailSchema, ConsoleConversationItemSchema, ConversationDetailSchema } from '@nexo/shared';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentResponder } from '../apps/api/src/agent/agent-responder.js';
import { createPrismaAgentTurnStore } from '../apps/api/src/agent/agent-turn-store.js';
import { createPrismaHelpCenter } from '../apps/api/src/agent/help-center.js';
import { createAuthService } from '../apps/api/src/auth/auth-service.js';
import { createPrismaUserRepository } from '../apps/api/src/auth/user-repository.js';
import { createPrismaConsoleRepository } from '../apps/api/src/console/console-repository.js';
import { createConsoleService } from '../apps/api/src/console/console-service.js';
import { createConversationEventBus } from '../apps/api/src/conversations/conversation-events.js';
import { createPrismaConversationRepository } from '../apps/api/src/conversations/conversation-repository.js';
import { createHandoffRequestService, createPrismaHandoffRequestRepository } from '../apps/api/src/conversations/handoff-request.js';
import { createConversationService } from '../apps/api/src/conversations/conversation-service.js';
import { createPrismaDraftRepository } from '../apps/api/src/drafts/draft-repository.js';
import { createDraftService } from '../apps/api/src/drafts/draft-service.js';
import { createApp } from '../apps/api/src/http/app.js';
import { type PrismaClient, createPrismaClient } from '../apps/api/src/infra/prisma.js';
import { createLegacyTicketService } from '../apps/api/src/infra/ticket-service.js';
import { seedDatabase } from '../apps/api/src/seed/seed.js';
import { parseSse, serve } from './helpers/api-harness.js';
import { type DisposableDatabase, createDisposableDatabase } from './helpers/disposable-database.js';
import { openEvents } from './helpers/event-stream.js';
import { request } from './helpers/http.js';

/**
 * Transferência e console do analista sobre PostgreSQL real, em banco descartável. É aqui que a
 * concorrência é de fato exercitada: trava de linha por conversa, versão otimista, agente x console.
 * Roda com `npm run test:db`; nenhuma chave de LLM é usada (modelo roteirizado).
 */

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres!!';
const ANA = { id: 'usr_ana_souza', email: 'ana.souza@nexo.com.br' };
const BRUNO = { id: 'usr_bruno_lima', email: 'bruno.lima@nexo.com.br' };
const CARLA = { id: 'usr_carla_mendes', email: 'carla.mendes@nexo.com.br' };
const MARCOS = { id: 'usr_marcos_oliveira', email: 'marcos.oliveira@nexo.com.br' };
const PAULA = { id: 'usr_paula_santos', email: 'paula.santos@nexo.com.br' };

let db: DisposableDatabase;
let prisma: PrismaClient;

const proposal = (overrides: Record<string, unknown> = {}) => ({
  intent: 'ASK_QUESTION',
  understanding: 'Pergunta de TI.',
  action: 'REPLY',
  confidence: 0.9,
  rationale: 'Resposta direta.',
  reply: 'Certo!',
  ...overrides,
});

interface ApiOptions {
  readonly script?: ScriptStep[];
  /** Sem agente (rota de mensagens só grava), para preparar cenários. */
  readonly withoutAgent?: boolean;
  readonly client?: PrismaClient;
}

/** Sobe a API completa (agente, console e eventos). Cada chamada é um "processo" novo, com barramento próprio. */
async function startApi(options: ApiOptions = {}) {
  const client = options.client ?? prisma;
  const scripted = createScriptedModel(options.script ?? []);
  const tickets = createLegacyTicketService(client);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const events = createConversationEventBus();
  const conversations = createPrismaConversationRepository(client);
  const app: Express = createApp({
    checkDatabase: async () => ({ status: 'up' }),
    version: 'test',
    startedAt: new Date(),
    logger,
    api: {
      auth: createAuthService({ users: createPrismaUserRepository(client), secret: SECRET, sessionTtlSeconds: 3600 }),
      tickets,
      conversations: createConversationService({ conversations }),
      drafts: createDraftService({ drafts: createPrismaDraftRepository(client), tickets }),
      ...(options.withoutAgent
        ? {}
        : {
            responder: createAgentResponder({
              store: createPrismaAgentTurnStore(client),
              tickets,
              helpCenter: createPrismaHelpCenter(client),
              model: scripted.model,
              modelId: 'teste/roteirizado',
              logger,
            }),
          }),
      console: createConsoleService({ console: createPrismaConsoleRepository(client), conversations, tickets, events }),
      events,
      handoffs: createHandoffRequestService({ handoffs: createPrismaHandoffRequestRepository(client), conversations, events }),
    },
  });
  return { url: await serve(app), events, calls: scripted.calls, logger };
}

type Api = Awaited<ReturnType<typeof startApi>>;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function login(url: string, email: string): Promise<string> {
  return ((await request(url).post('/api/auth/login').send({ email, password: 'x' })).body as { token: string }).token;
}

const consoleGet = (url: string, token: string, path: string) => request(url).get(`/api/console${path}`).set(bearer(token));
const act = (url: string, token: string, id: string, action: 'assume' | 'return' | 'close', expectedVersion: number) =>
  request(url).post(`/api/console/conversations/${id}/${action}`).set(bearer(token)).send({ expectedVersion });
const analystSays = (url: string, token: string, id: string, content = 'Olá, sou do suporte.', clientMessageId: string = randomUUID()) =>
  request(url).post(`/api/console/conversations/${id}/messages`).set(bearer(token)).send({ content, clientMessageId });
const employeeSays = (url: string, token: string, id: string, content: string, clientMessageId: string = randomUUID()) =>
  request(url).post(`/api/conversations/${id}/messages`).set(bearer(token)).send({ content, clientMessageId });

async function newConversation(url: string, token: string): Promise<string> {
  const res = await request(url).post('/api/conversations').set(bearer(token));
  return (res.body as { conversation: { id: string } }).conversation.id;
}

async function consoleDetail(url: string, token: string, id: string) {
  const res = await consoleGet(url, token, `/conversations/${id}`);
  expect(res.status).toBe(200);
  return ConsoleConversationDetailSchema.parse(res.body.conversation);
}

async function employeeDetail(url: string, token: string, id: string) {
  const res = await request(url).get(`/api/conversations/${id}`).set(bearer(token));
  return ConversationDetailSchema.parse(res.body.conversation);
}

const errorCode = (res: { body: unknown }) => ApiErrorBodySchema.parse(res.body).error.code;

/**
 * Deixa no banco o que a publicação de uma transferência pelo agente deixa: a conversa em
 * WAITING_ANALYST (versão + 1), o pedido de atendimento e a mensagem do funcionário.
 */
async function seedTransferred(options: { employeeId?: string; title?: string; reason?: 'EMPLOYEE_REQUEST' | 'CRITICAL_ISSUE' | 'OVERDUE_TICKET' | 'LOW_CONFIDENCE'; summary?: string; relatedTicketId?: string | null; at?: Date } = {}) {
  const at = options.at ?? new Date();
  const conversation = await prisma.conversation.create({
    data: {
      employeeId: options.employeeId ?? ANA.id,
      title: options.title ?? 'Notebook lento',
      status: 'WAITING_ANALYST',
      version: 1,
      employeeMessageCount: 1,
      lastMessageAt: at,
      createdAt: at,
      updatedAt: at,
    },
  });
  await prisma.message.create({
    data: { conversationId: conversation.id, role: 'EMPLOYEE', authorId: options.employeeId ?? ANA.id, content: options.title ?? 'Notebook lento', clientMessageId: randomUUID(), createdAt: at },
  });
  await prisma.handoff.create({
    data: {
      conversationId: conversation.id,
      reason: options.reason ?? 'EMPLOYEE_REQUEST',
      requestedBy: 'AGENT',
      summary: options.summary ?? 'A funcionária pediu para falar com um analista.',
      relatedTicketId: options.relatedTicketId ?? null,
      createdAt: at,
    },
  });
  return conversation.id;
}

beforeAll(async () => {
  db = await createDisposableDatabase();
  prisma = createPrismaClient(db.url);
  await seedDatabase(prisma, new Date());
}, 90_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.drop();
}, 30_000);

describe('fluxo completo da transferência (agente real com modelo roteirizado)', () => {
  it('funcionário pede analista → fila → assumir → atendimento → devolver → agente volta → transferir de novo → encerrar', async () => {
    const api = await startApi({
      script: [
        call('requestHandoff', { reason: 'EMPLOYEE_REQUEST', summary: 'Ana quer falar com um analista sobre o notebook lento (INC-20311).', relatedTicketCode: 'INC-20311' }),
        submit(proposal({ intent: 'TALK_TO_ANALYST', action: 'TRANSFER_TO_ANALYST', reply: 'Chamei um analista; ele já recebe o resumo.' })),
        // depois de devolvida
        submit(proposal({ reply: 'Que bom que o analista resolveu! Posso ajudar em mais alguma coisa?' })),
        // segunda transferência
        call('requestHandoff', { reason: 'EMPLOYEE_REQUEST', summary: 'Ana voltou a pedir um analista.' }),
        submit(proposal({ intent: 'TALK_TO_ANALYST', action: 'TRANSFER_TO_ANALYST', reply: 'Chamei o analista de novo.' })),
      ],
    });
    const ana = await login(api.url, ANA.email);
    const marcos = await login(api.url, MARCOS.email);
    const id = await newConversation(api.url, ana);

    // 1. O agente transfere (fluxo real: ferramenta → política → publicação transacional).
    const first = parseSse((await employeeSays(api.url, ana, id, 'Quero falar com um analista')).text);
    expect(first.map((e) => e.event)).toEqual(['message.accepted', 'agent.step', 'agent.message', 'conversation.status', 'done']);

    // 2. A fila mostra a conversa com motivo, resumo e chamado relacionado.
    const queue = await consoleGet(api.url, marcos, '/conversations?status=WAITING_ANALYST');
    const item = ConsoleConversationItemSchema.parse((queue.body.items as unknown[]).find((i) => (i as { id: string }).id === id));
    expect(item).toMatchObject({
      employee: { id: ANA.id, name: 'Ana Souza' },
      activeHandoff: { reason: 'EMPLOYEE_REQUEST', status: 'WAITING', relatedTicketCode: 'INC-20311', summary: expect.stringContaining('INC-20311') },
    });

    // 3. O analista vê o histórico, as decisões do agente e os chamados da Ana.
    const waiting = await consoleDetail(api.url, marcos, id);
    expect(waiting.decisions).toHaveLength(1);
    expect(waiting.decisions[0]).toMatchObject({ intent: 'TALK_TO_ANALYST', action: 'TRANSFER_TO_ANALYST' });
    expect(waiting.messages.map((m) => m.role)).toEqual(['EMPLOYEE', 'AGENT']);
    const anaTickets = await prisma.ticket.findMany({ where: { requesterId: ANA.id }, select: { code: true } });
    expect(waiting.employeeTickets.map((t) => t.code).sort()).toEqual(anaTickets.map((t) => t.code).sort());
    expect(waiting.employeeTickets.map((t) => t.code)).toContain('INC-20311');

    // 4. Assume e atende; o funcionário vê tudo no histórico.
    expect((await act(api.url, marcos, id, 'assume', waiting.version)).status).toBe(200);
    expect((await analystSays(api.url, marcos, id, 'Oi Ana, vou olhar o seu notebook agora.')).status).toBe(201);
    expect((await employeeSays(api.url, ana, id, 'Obrigada!')).status).toBe(200);
    const during = await employeeDetail(api.url, ana, id);
    expect(during.messages.map((m) => m.role)).toEqual(['EMPLOYEE', 'AGENT', 'ANALYST', 'EMPLOYEE']);
    expect(api.calls).toHaveLength(2); // o agente não foi chamado nem durante a espera nem com o analista

    // 5. Devolve. O "Obrigada!" veio depois da última fala do analista, então ainda é pendência do agente;
    //    o agente volta a responder, agora com o histórico completo.
    expect((await act(api.url, marcos, id, 'return', waiting.version + 1)).status).toBe(200);
    expect((await employeeDetail(api.url, ana, id)).pendingAgentResponse).not.toBeNull();
    const back = parseSse((await employeeSays(api.url, ana, id, 'Funcionou, obrigada.')).text);
    expect(back.map((e) => e.event)).toEqual(['message.accepted', 'agent.message', 'done']);

    // 6. Segunda transferência: os registros anteriores permanecem.
    const again = parseSse((await employeeSays(api.url, ana, id, 'Preciso do analista de novo')).text);
    expect(again.map((e) => e.event)).toContain('conversation.status');
    const second = await consoleDetail(api.url, marcos, id);
    expect(second.status).toBe('WAITING_ANALYST');
    expect(second.handoffs.map((h) => h.status)).toEqual(['RETURNED_TO_AGENT', 'WAITING']);
    expect(second.handoffs[0]).toMatchObject({ assumedById: MARCOS.id, endedAt: expect.any(String) });

    // 7. Outro analista (N2) encerra a que ainda aguarda.
    const paula = await login(api.url, PAULA.email);
    const closed = await act(api.url, paula, id, 'close', second.version);
    expect(closed.body.conversation).toMatchObject({ status: 'CLOSED', assignedAnalystId: null });
    const final = await consoleDetail(api.url, paula, id);
    expect(final.handoffs.map((h) => h.status)).toEqual(['RETURNED_TO_AGENT', 'CLOSED']);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id } })).closedAt).not.toBeNull();
    expect((await employeeSays(api.url, ana, id, 'e agora?')).status).toBe(409);
  });
});

describe('concorrência no console', () => {
  it('N1 e N2 disputando: exatamente um assume, em rajada', async () => {
    const api = await startApi({ withoutAgent: true });
    const [marcos, paula] = await Promise.all([login(api.url, MARCOS.email), login(api.url, PAULA.email)]);
    const id = await seedTransferred();

    const analysts = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? MARCOS : PAULA));
    const attempts = await Promise.all(analysts.map((analyst, i) => act(api.url, i % 2 === 0 ? marcos : paula, id, 'assume', 1).then((res) => ({ analyst, res }))));

    // Um único analista vence. Os pedidos repetidos dele são idempotentes (200); todos os do outro, conflito.
    const winners = new Set(attempts.filter((a) => a.res.status === 200).map((a) => a.analyst.id));
    expect(winners.size).toBe(1);
    const [winnerId] = [...winners];
    for (const { analyst, res } of attempts) {
      if (analyst.id === winnerId) expect(res.status).toBe(200);
      else expect([res.status, errorCode(res)]).toEqual([409, 'CONFLICT']);
    }

    const row = await prisma.conversation.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'WITH_ANALYST', version: 2 });
    const handoffs = await prisma.handoff.findMany({ where: { conversationId: id } });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ status: 'ASSUMED', assumedById: winnerId });
    expect(row.assignedAnalystId).toBe(winnerId);
  });

  it('assumir e encerrar ao mesmo tempo: só um dos dois vale e o estado fica consistente', async () => {
    const api = await startApi({ withoutAgent: true });
    const [marcos, paula] = await Promise.all([login(api.url, MARCOS.email), login(api.url, PAULA.email)]);
    const id = await seedTransferred();

    const [assume, close] = await Promise.all([act(api.url, marcos, id, 'assume', 1), act(api.url, paula, id, 'close', 1)]);
    const row = await prisma.conversation.findUniqueOrThrow({ where: { id } });
    const handoff = await prisma.handoff.findFirstOrThrow({ where: { conversationId: id } });
    expect(row.version).toBe(2); // só uma das ações foi aplicada
    if (assume.status === 200) {
      // Assumiu primeiro: quem não é o responsável não encerra (autorização antes da versão).
      expect(close.status).toBe(403);
      expect([row.status, handoff.status]).toEqual(['WITH_ANALYST', 'ASSUMED']);
    } else {
      // Encerrou primeiro: a versão que o outro viu já não vale.
      expect([close.status, assume.status, errorCode(assume)]).toEqual([200, 409, 'CONFLICT']);
      expect([row.status, handoff.status]).toEqual(['CLOSED', 'CLOSED']);
    }
  });

  it('mensagens do analista em rajada junto com a devolução: nada é gravado depois que a conversa saiu do atendimento', async () => {
    const api = await startApi({ withoutAgent: true });
    const marcos = await login(api.url, MARCOS.email);
    const id = await seedTransferred();
    await act(api.url, marcos, id, 'assume', 1);

    const sends = Array.from({ length: 10 }, (_, i) => analystSays(api.url, marcos, id, `mensagem ${i}`));
    const giveBack = act(api.url, marcos, id, 'return', 2);
    const results = await Promise.all([...sends, giveBack]);

    expect(results.at(-1)?.status).toBe(200);
    const accepted = results.slice(0, 10).filter((r) => r.status === 201);
    const refused = results.slice(0, 10).filter((r) => r.status === 409);
    expect(accepted.length + refused.length).toBe(10);
    expect(await prisma.message.count({ where: { conversationId: id, role: 'ANALYST' } })).toBe(accepted.length);
    // Depois da devolução, qualquer nova mensagem é recusada.
    expect((await analystSays(api.url, marcos, id)).status).toBe(409);
    expect(await prisma.message.count({ where: { conversationId: id, role: 'ANALYST' } })).toBe(accepted.length);

    const times = (await prisma.message.findMany({ where: { conversationId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map((m) => m.createdAt.getTime());
    expect(new Set(times).size).toBe(times.length);
  });

  it('o mesmo clientMessageId em rajada grava uma única mensagem do analista', async () => {
    const api = await startApi({ withoutAgent: true });
    const marcos = await login(api.url, MARCOS.email);
    const id = await seedTransferred();
    await act(api.url, marcos, id, 'assume', 1);

    const clientMessageId = randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, () => analystSays(api.url, marcos, id, 'só uma vez', clientMessageId)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.message.id)).size).toBe(1);
    expect(await prisma.message.count({ where: { conversationId: id, role: 'ANALYST' } })).toBe(1);
  });
});

describe('concorrência entre transferência e resposta do agente', () => {
  it('duas mensagens do funcionário ao mesmo tempo: uma única transferência e o agente não fala depois dela', async () => {
    const api = await startApi({
      script: [
        call('requestHandoff', { reason: 'EMPLOYEE_REQUEST', summary: 'Ana pediu um analista.' }),
        submit(proposal({ intent: 'TALK_TO_ANALYST', action: 'TRANSFER_TO_ANALYST', reply: 'Chamei um analista.' })),
        submit(proposal({ reply: 'ESTA RESPOSTA NÃO PODE EXISTIR' })),
      ],
    });
    const ana = await login(api.url, ANA.email);
    const id = await newConversation(api.url, ana);

    const [a, b] = await Promise.all([employeeSays(api.url, ana, id, 'Quero um analista'), employeeSays(api.url, ana, id, 'Alguém?')]);
    expect([a.status, b.status]).toEqual([200, 200]);

    expect(await prisma.handoff.count({ where: { conversationId: id } })).toBe(1);
    const messages = await prisma.message.findMany({ where: { conversationId: id } });
    expect(messages.filter((m) => m.role === 'AGENT')).toHaveLength(1);
    expect(messages.some((m) => m.content.includes('NÃO PODE EXISTIR'))).toBe(false);
    expect(api.calls).toHaveLength(2); // uma execução (ferramenta + resposta); a outra mensagem nem chegou ao modelo
    expect(await prisma.agentDecision.count({ where: { conversationId: id } })).toBe(1);
  });

  it('conversa que passou por assumir e devolver durante a execução: a resposta velha é descartada e a retomada responde uma vez', async () => {
    let conversationId = '';
    let marcosToken = '';
    let url = '';
    const api = await startApi({
      script: [
        call('listMyTickets'),
        async () => {
          // Enquanto o modelo "pensa": outro processo transferiu (direto no banco) e um analista assumiu e devolveu.
          await prisma.handoff.create({ data: { conversationId, reason: 'LOW_CONFIDENCE', requestedBy: 'AGENT', summary: 'Transferência feita por outro processo.' } });
          const { version } = await prisma.conversation.update({ where: { id: conversationId }, data: { status: 'WAITING_ANALYST', version: { increment: 1 } } });
          expect((await act(url, marcosToken, conversationId, 'assume', version)).status).toBe(200);
          expect((await act(url, marcosToken, conversationId, 'return', version + 1)).status).toBe(200);
          return submit(proposal({ intent: 'CHECK_TICKET_STATUS', reply: 'Esta resposta é de um contexto que já não vale.' }));
        },
        submit(proposal({ reply: 'Agora sim, com o contexto atual.' })),
      ],
    });
    url = api.url;
    const ana = await login(url, ANA.email);
    marcosToken = await login(url, MARCOS.email);
    conversationId = await newConversation(url, ana);

    const run = parseSse((await employeeSays(url, ana, conversationId, 'Como estão os meus chamados?')).text);
    expect(run.map((e) => e.event)).toEqual(['message.accepted', 'agent.step', 'conversation.status', 'done']);
    expect(run[2]?.data).toMatchObject({ status: 'WITH_AGENT', version: 3 }); // voltou ao agente, mas a versão mudou

    expect(await prisma.message.count({ where: { conversationId, role: 'AGENT' } })).toBe(0);
    expect(await prisma.agentDecision.count({ where: { conversationId } })).toBe(0);
    const pending = (await employeeDetail(url, ana, conversationId)).pendingAgentResponse;
    expect(pending).not.toBeNull();

    const resumed = parseSse((await request(url).post(`/api/conversations/${conversationId}/resume`).set(bearer(ana))).text);
    expect(resumed.map((e) => e.event)).toEqual(['agent.message', 'done']);
    expect(await prisma.message.count({ where: { conversationId, role: 'AGENT' } })).toBe(1);
    expect(await prisma.agentDecision.count({ where: { conversationId } })).toBe(1);
    expect((await employeeDetail(url, ana, conversationId)).pendingAgentResponse).toBeNull();
  });
});

describe('persistência e reinício da aplicação', () => {
  it('responsável, histórico e transferências sobrevivem a um reinício; o atendimento continua de onde parou', async () => {
    const before = await startApi({ withoutAgent: true });
    const marcosBefore = await login(before.url, MARCOS.email);
    const id = await seedTransferred({ title: 'VPN caindo' });
    await act(before.url, marcosBefore, id, 'assume', 1);
    await analystSays(before.url, marcosBefore, id, 'Antes do reinício.');

    // "Reinício": outro cliente do banco, outra instância, sem nenhum estado em memória.
    const secondClient = createPrismaClient(db.url);
    try {
      const after = await startApi({ withoutAgent: true, client: secondClient });
      const marcos = await login(after.url, MARCOS.email); // a sessão é só um token assinado: também vale
      const detail = await consoleDetail(after.url, marcos, id);
      expect(detail).toMatchObject({ status: 'WITH_ANALYST', assignedAnalystId: MARCOS.id, version: 2 });
      expect(detail.messages.map((m) => m.content)).toEqual(['VPN caindo', 'Antes do reinício.']);
      expect(detail.handoffs[0]).toMatchObject({ status: 'ASSUMED', assumedById: MARCOS.id });

      expect((await analystSays(after.url, marcos, id, 'Depois do reinício.')).status).toBe(201);
      expect((await analystSays(after.url, await login(after.url, PAULA.email), id)).status).toBe(403); // continua só o responsável
      expect((await act(after.url, marcos, id, 'return', 2)).status).toBe(200);
    } finally {
      await secondClient.$disconnect();
    }
  });
});

describe('eventos para o funcionário sobre PostgreSQL', () => {
  it('entrega ao vivo e, depois de um reinício, recupera pela mensagem de referência o que foi perdido', async () => {
    const before = await startApi({ withoutAgent: true });
    const [ana, marcos] = await Promise.all([login(before.url, ANA.email), login(before.url, MARCOS.email)]);
    const id = await seedTransferred();
    await act(before.url, marcos, id, 'assume', 1);

    const live = await openEvents(before.url, `/api/conversations/${id}/events`, bearer(ana));
    expect(live.status).toBe(200);
    const first = await analystSays(before.url, marcos, id, 'primeira');
    const events = await live.waitForCount(2);
    expect(events[1]).toMatchObject({ event: 'message.created', id: first.body.message.id });
    await live.close(); // a aplicação cai (e leva a conexão junto)

    // Enquanto a API estava fora, o atendimento seguiu (outra instância continua escrevendo no banco).
    const secondClient = createPrismaClient(db.url);
    try {
      const during = await startApi({ withoutAgent: true, client: secondClient });
      const duringMarcos = await login(during.url, MARCOS.email);
      const m2 = await analystSays(during.url, duringMarcos, id, 'segunda');
      const m3 = await analystSays(during.url, duringMarcos, id, 'terceira');
      await act(during.url, duringMarcos, id, 'return', 2);

      // O navegador reconecta (agora numa instância nova) com o Last-Event-ID da última mensagem que viu.
      const resumed = await openEvents(during.url, `/api/conversations/${id}/events`, { ...bearer(await login(during.url, ANA.email)), 'last-event-id': first.body.message.id as string });
      try {
        const got = await resumed.waitForCount(3);
        expect(got[0]).toMatchObject({ event: 'conversation.status', data: { status: 'WITH_AGENT', version: 3 } });
        expect(got.slice(1).map((e) => e.id)).toEqual([m2.body.message.id, m3.body.message.id]);
        await resumed.expectNoMoreThan(3);
      } finally {
        await resumed.close();
      }
    } finally {
      await secondClient.$disconnect();
    }
  });

  it('não entrega nada de outra conversa nem a quem não é o dono', async () => {
    const api = await startApi({ withoutAgent: true });
    const [bruno, marcos] = await Promise.all([login(api.url, BRUNO.email), login(api.url, MARCOS.email)]);
    const anaConv = await seedTransferred({ employeeId: ANA.id, title: 'Conversa da Ana' });
    const brunoConv = await seedTransferred({ employeeId: BRUNO.id, title: 'Conversa do Bruno' });
    await act(api.url, marcos, anaConv, 'assume', 1);

    const stranger = await openEvents(api.url, `/api/conversations/${anaConv}/events`, bearer(bruno));
    expect(stranger.status).toBe(404);
    const brunoStream = await openEvents(api.url, `/api/conversations/${brunoConv}/events`, bearer(bruno));
    try {
      await brunoStream.waitForCount(1);
      await analystSays(api.url, marcos, anaConv, 'Segredo da Ana');
      await brunoStream.expectNoMoreThan(1);
      expect(brunoStream.raw()).not.toContain('Segredo da Ana');
    } finally {
      await brunoStream.close();
    }
    const asAnalyst = await openEvents(api.url, `/api/conversations/${anaConv}/events`, bearer(marcos));
    expect(asAnalyst.status).toBe(403);
  });
});

describe('fila, busca e privacidade com dados reais', () => {
  it('a fila só tem conversas transferidas, ordenadas por atividade, com busca e paginação', async () => {
    const api = await startApi({ withoutAgent: true });
    const marcos = await login(api.url, MARCOS.email);
    const base = Date.now() + 10 * 60_000; // depois de tudo que os outros testes criaram
    const a = await seedTransferred({ employeeId: CARLA.id, title: 'Impressora do 2º andar', at: new Date(base) });
    const b = await seedTransferred({ employeeId: BRUNO.id, title: 'Acesso 100% bloqueado', at: new Date(base + 1000) });
    const c = await seedTransferred({ employeeId: ANA.id, title: 'Excel_fecha sozinho', at: new Date(base + 2000), reason: 'CRITICAL_ISSUE' });
    // Conversa que nunca foi transferida: não aparece.
    const never = await prisma.conversation.create({ data: { employeeId: ANA.id, title: 'Só uma dúvida', employeeMessageCount: 1, updatedAt: new Date(base + 5000) } });

    const ids = async (query: string) => ((await consoleGet(api.url, marcos, `/conversations${query}`)).body.items as Array<{ id: string }>).map((i) => i.id);
    const top = await ids('?limit=100');
    expect(top.indexOf(c)).toBeLessThan(top.indexOf(b));
    expect(top.indexOf(b)).toBeLessThan(top.indexOf(a));
    expect(top).not.toContain(never.id);

    // Busca por nome, e-mail e título; curingas do LIKE são literais.
    expect(await ids('?q=carla')).toEqual([a]);
    const byEmail = (await consoleGet(api.url, marcos, `/conversations?q=${encodeURIComponent('BRUNO.LIMA@')}`)).body.items as Array<{ id: string; employee: { email: string } }>;
    expect(byEmail.map((i) => i.id)).toContain(b);
    expect(byEmail.every((i) => i.employee.email === BRUNO.email)).toBe(true);
    expect(await ids(`?q=${encodeURIComponent('excel_')}`)).toEqual([c]);
    expect(await ids(`?q=${encodeURIComponent('100%')}`)).toEqual([b]);
    expect(await ids(`?q=${encodeURIComponent('%')}`)).toEqual([b]);
    expect(await ids(`?q=${encodeURIComponent('_')}`)).toEqual([c]);
    expect(await ids('?q=ninguem-assim')).toEqual([]);

    // Paginação por cursor, sem repetir nem pular.
    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const res: Awaited<ReturnType<typeof consoleGet>> = await consoleGet(api.url, marcos, `/conversations?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      collected.push(...(res.body.items as Array<{ id: string }>).map((i) => i.id));
      cursor = res.body.nextCursor as string | null;
    } while (cursor);
    expect(collected).toEqual(top);
    expect(new Set(collected).size).toBe(collected.length);
  });

  it('o painel mostra só os chamados do funcionário atendido e o console não escreve em chamados', async () => {
    const api = await startApi({ withoutAgent: true });
    const marcos = await login(api.url, MARCOS.email);
    const id = await seedTransferred({ employeeId: BRUNO.id, relatedTicketId: 'tkt_inc_20344' });
    const ticketsBefore = await prisma.ticket.findMany({ orderBy: { id: 'asc' } });
    const eventsBefore = await prisma.ticketEvent.count();

    const detail = await consoleDetail(api.url, marcos, id);
    expect(detail.employee.id).toBe(BRUNO.id);
    expect(detail.handoffs[0]?.relatedTicketCode).toBe('INC-20344');
    const bruno = await prisma.ticket.findMany({ where: { requesterId: BRUNO.id }, select: { code: true } });
    expect(detail.employeeTickets.map((t) => t.code).sort()).toEqual(bruno.map((t) => t.code).sort());
    expect(detail.employeeTickets.some((t) => t.code === 'INC-20311')).toBe(false); // chamado da Ana

    await act(api.url, marcos, id, 'assume', 1);
    await analystSays(api.url, marcos, id);
    await act(api.url, marcos, id, 'return', 2);
    expect(await prisma.ticket.findMany({ orderBy: { id: 'asc' } })).toEqual(ticketsBefore);
    expect(await prisma.ticketEvent.count()).toBe(eventsBefore);
  });

  it('conversa nunca transferida é invisível ao console, e o funcionário não entra nele', async () => {
    const api = await startApi({ withoutAgent: true });
    const [marcos, ana] = await Promise.all([login(api.url, MARCOS.email), login(api.url, ANA.email)]);
    const plain = await prisma.conversation.create({ data: { employeeId: ANA.id, title: 'Sigilosa', employeeMessageCount: 1 } });

    expect((await consoleGet(api.url, marcos, `/conversations/${plain.id}`)).status).toBe(404);
    expect((await act(api.url, marcos, plain.id, 'assume', 0)).status).toBe(404);
    expect((await act(api.url, marcos, plain.id, 'close', 0)).status).toBe(404);
    expect((await analystSays(api.url, marcos, plain.id)).status).toBe(404);
    expect((await consoleGet(api.url, ana, '/conversations')).status).toBe(403);
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id: plain.id } })).toMatchObject({ status: 'WITH_AGENT', version: 0 });
  });

  it('a resposta pendente considera o que o analista já tratou, também no banco', async () => {
    const api = await startApi({ withoutAgent: true });
    const [ana, marcos] = await Promise.all([login(api.url, ANA.email), login(api.url, MARCOS.email)]);
    const id = await seedTransferred();
    await act(api.url, marcos, id, 'assume', 1);
    await employeeSays(api.url, ana, id, 'Preciso de ajuda');
    await analystSays(api.url, marcos, id, 'Tratado.');
    await act(api.url, marcos, id, 'return', 2);
    expect((await employeeDetail(api.url, ana, id)).pendingAgentResponse).toBeNull();

    // O contrário: o funcionário escreveu com o analista e ninguém respondeu antes de devolver.
    const other = await seedTransferred();
    await act(api.url, marcos, other, 'assume', 1);
    const sent = await employeeSays(api.url, ana, other, 'Sem resposta');
    expect(sent.status).toBe(200);
    const messageId = (await prisma.message.findFirstOrThrow({ where: { conversationId: other, content: 'Sem resposta' } })).id;
    await act(api.url, marcos, other, 'return', 2);
    expect((await employeeDetail(api.url, ana, other)).pendingAgentResponse).toEqual({ messageId });
  });
});

describe('pedido direto de analista (sem LLM) sobre PostgreSQL', () => {
  const ask = (url: string, token: string, id: string, body: object = {}) => request(url).post(`/api/conversations/${id}/handoff`).set(bearer(token)).send(body);

  it('rajada de pedidos: uma única transferência, atômica com a mudança de estado, e o agente fica pausado', async () => {
    const api = await startApi({ script: [submit(proposal({ reply: 'NÃO PODE EXISTIR' }))] });
    const ana = await login(api.url, ANA.email);
    const id = await newConversation(api.url, ana);
    await employeeSays(api.url, ana, id, 'Meu notebook está lento'); // o modelo roteirizado não tem resposta: fica pendente
    const callsBefore = api.calls.length;

    const results = await Promise.all(Array.from({ length: 12 }, () => ask(api.url, ana, id, { note: 'urgente' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(11);
    expect(new Set(results.map((r) => r.body.handoff.id)).size).toBe(1);

    const handoffs = await prisma.handoff.findMany({ where: { conversationId: id } });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ reason: 'EMPLOYEE_REQUEST', requestedBy: 'EMPLOYEE', status: 'WAITING' });
    expect(handoffs[0]?.summary).toContain('Meu notebook está lento');
    expect(handoffs[0]?.summary).toContain('urgente');
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'WAITING_ANALYST', version: 1 });
    expect(api.calls.length).toBe(callsBefore); // o pedido não chama o modelo

    // Pausado: a próxima mensagem não aciona o agente, e o analista enxerga a fila com o resumo.
    const next = parseSse((await employeeSays(api.url, ana, id, 'Alguém?')).text);
    expect(next.map((e) => e.event)).toEqual(['message.accepted', 'conversation.status', 'done']);
    const marcos = await login(api.url, MARCOS.email);
    const detail = await consoleDetail(api.url, marcos, id);
    expect(detail.handoffs[0]).toMatchObject({ reason: 'EMPLOYEE_REQUEST', status: 'WAITING' });
  });

  it('o pedido chega no meio da execução do agente: a resposta do agente é descartada e só há uma transferência', async () => {
    let conversationId = '';
    let url = '';
    let ana = '';
    const api = await startApi({
      script: [
        call('listMyTickets'),
        async () => {
          expect((await ask(url, ana, conversationId)).status).toBe(201);
          return submit(proposal({ intent: 'CHECK_TICKET_STATUS', reply: 'Esta resposta não pode sair.' }));
        },
      ],
    });
    url = api.url;
    ana = await login(url, ANA.email);
    conversationId = await newConversation(url, ana);

    const events = parseSse((await employeeSays(url, ana, conversationId, 'Como estão os meus chamados?')).text);
    expect(events.map((e) => e.event)).toEqual(['message.accepted', 'agent.step', 'conversation.status', 'done']);
    expect(events[2]?.data).toEqual({ status: 'WAITING_ANALYST', version: 1 });
    expect(await prisma.message.count({ where: { conversationId, role: 'AGENT' } })).toBe(0);
    expect(await prisma.agentDecision.count({ where: { conversationId } })).toBe(0);
    expect(await prisma.handoff.count({ where: { conversationId } })).toBe(1);
  });

  it('pedido e transferência do agente ao mesmo tempo: nunca duas transferências', async () => {
    for (let round = 0; round < 3; round++) {
      const api = await startApi({
        script: [
          call('requestHandoff', { reason: 'EMPLOYEE_REQUEST', summary: 'Ana pediu um analista.' }),
          submit(proposal({ intent: 'TALK_TO_ANALYST', action: 'TRANSFER_TO_ANALYST', reply: 'Chamei um analista.' })),
        ],
      });
      const ana = await login(api.url, ANA.email);
      const id = await newConversation(api.url, ana);
      const [chat, direct] = await Promise.all([employeeSays(api.url, ana, id, 'Quero um analista'), ask(api.url, ana, id)]);
      expect(chat.status).toBe(200);
      expect([200, 201]).toContain(direct.status);

      expect(await prisma.handoff.count({ where: { conversationId: id } })).toBe(1);
      expect(await prisma.conversation.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'WAITING_ANALYST', version: 1 });
      expect(await prisma.message.count({ where: { conversationId: id, role: 'AGENT' } })).toBeLessThanOrEqual(1);
    }
  });

  it('conversa encerrada ou de outro funcionário: recusado sem tocar em nada', async () => {
    const api = await startApi({ withoutAgent: true });
    const [ana, bruno, marcos] = await Promise.all([login(api.url, ANA.email), login(api.url, BRUNO.email), login(api.url, MARCOS.email)]);
    const id = await seedTransferred();
    await act(api.url, marcos, id, 'close', 1);
    const closed = await ask(api.url, ana, id);
    expect([closed.status, errorCode(closed)]).toEqual([409, 'INVALID_STATE_TRANSITION']);

    const fresh = await newConversation(api.url, ana);
    expect((await ask(api.url, bruno, fresh)).status).toBe(404);
    expect(await prisma.handoff.count({ where: { conversationId: fresh } })).toBe(0);
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id: fresh } })).toMatchObject({ status: 'WITH_AGENT', version: 0 });
  });

  it('sobrevive a reinício e repetir depois continua idempotente', async () => {
    const before = await startApi({ withoutAgent: true });
    const ana = await login(before.url, ANA.email);
    const id = await newConversation(before.url, ana);
    const first = await ask(before.url, ana, id);
    const secondClient = createPrismaClient(db.url);
    try {
      const after = await startApi({ withoutAgent: true, client: secondClient });
      const again = await ask(after.url, await login(after.url, ANA.email), id);
      expect([again.status, again.body.handoff.id]).toEqual([200, first.body.handoff.id]);
    } finally {
      await secondClient.$disconnect();
    }
  });
});
