import { ApiErrorBodySchema, ConversationDetailSchema, type DraftPayload } from '@nexo/shared';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { type TestResponse, request } from './helpers/http.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthService } from '../apps/api/src/auth/auth-service.js';
import { createPrismaUserRepository } from '../apps/api/src/auth/user-repository.js';
import { createPrismaConversationRepository } from '../apps/api/src/conversations/conversation-repository.js';
import { createConversationService } from '../apps/api/src/conversations/conversation-service.js';
import type { AgentResponder } from '../apps/api/src/conversations/responder.js';
import { createPrismaDraftRepository } from '../apps/api/src/drafts/draft-repository.js';
import { createDraftService } from '../apps/api/src/drafts/draft-service.js';
import { createApp } from '../apps/api/src/http/app.js';
import { createPrismaClient, type PrismaClient } from '../apps/api/src/infra/prisma.js';
import { createLegacyTicketService } from '../apps/api/src/infra/ticket-service.js';
import { seedDatabase } from '../apps/api/src/seed/seed.js';
import { type DisposableDatabase, createDisposableDatabase } from './helpers/disposable-database.js';
import { type RequestTarget, parseSse, serve, withServer } from './helpers/api-harness.js';

/**
 * Conversas e mensagens sobre PostgreSQL real, em banco descartável. É aqui que a concorrência é de
 * fato exercitada: trava de linha por conversa, limite de 30, idempotência e ordenação.
 * Roda com `npm run test:db`.
 */

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres!!';
const ANA = 'ana.souza@nexo.com.br';
const BRUNO = 'bruno.lima@nexo.com.br';
const DIEGO = 'diego.ferreira@nexo.com.br';
const CARLA = 'carla.mendes@nexo.com.br';
const ANA_ID = 'usr_ana_souza';

let db: DisposableDatabase;
let prisma: PrismaClient;
let app: string;
const responder = vi.fn<AgentResponder['respond']>(async function* () {});

function buildExpress(client: PrismaClient): Express {
  const tickets = createLegacyTicketService(client);
  return createApp({
    checkDatabase: async () => ({ status: 'up' }),
    version: 'test',
    startedAt: new Date(),
    logger: { error: () => undefined },
    api: {
      auth: createAuthService({ users: createPrismaUserRepository(client), secret: SECRET, sessionTtlSeconds: 3600 }),
      tickets,
      conversations: createConversationService({ conversations: createPrismaConversationRepository(client) }),
      drafts: createDraftService({ drafts: createPrismaDraftRepository(client), tickets }),
      responder: { respond: (input) => responder(input) },
    },
  });
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function login(email: string, target: RequestTarget = app): Promise<string> {
  const res = await request(target).post('/api/auth/login').send({ email, password: 'x' });
  return (res.body as { token: string }).token;
}

async function start(token: string, target: RequestTarget = app): Promise<string> {
  const res = await request(target).post('/api/conversations').set(bearer(token));
  return (res.body as { conversation: { id: string } }).conversation.id;
}

const send = (token: string, conversationId: string, content: string, clientMessageId: string = randomUUID(), target: RequestTarget = app) =>
  request(target).post(`/api/conversations/${conversationId}/messages`).set(bearer(token)).send({ content, clientMessageId });

async function history(token: string, conversationId: string, target: RequestTarget = app) {
  const res = await request(target).get(`/api/conversations/${conversationId}`).set(bearer(token));
  return ConversationDetailSchema.parse((res.body as { conversation: unknown }).conversation);
}

const strictlyIncreasing = (times: number[]) => times.every((t, i) => i === 0 || t > (times[i - 1] ?? 0));

beforeAll(async () => {
  db = await createDisposableDatabase();
  prisma = createPrismaClient(db.url);
  await seedDatabase(prisma, new Date());
  app = await serve(buildExpress(prisma), 'file');
}, 90_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.drop();
}, 30_000);

describe('persistência e retomada', () => {
  it('o histórico sobrevive a um reinício da aplicação (cliente e app novos)', async () => {
    const token = await login(ANA);
    const id = await start(token);
    await send(token, id, 'Primeira mensagem');
    await send(token, id, 'Segunda mensagem');
    await send(token, id, 'Terceira mensagem');
    const before = await history(token, id);

    // "reinício": nova conexão, novo app, nova sessão (o token continua válido: mesmo segredo)
    const fresh = createPrismaClient(db.url);
    try {
      const restarted = await serve(buildExpress(fresh));
      const after = await history(token, id, restarted);
      expect(after).toEqual(before);
      expect(after.messages.map((m) => m.content)).toEqual(['Primeira mensagem', 'Segunda mensagem', 'Terceira mensagem']);
      expect(after).toMatchObject({ employeeId: ANA_ID, status: 'WITH_AGENT', employeeMessageCount: 3, title: 'Primeira mensagem' });

      // e é possível continuar de onde parou
      expect((await send(token, id, 'Quarta, depois do reinício', randomUUID(), restarted)).status).toBe(200);
      expect((await history(token, id, restarted)).messages).toHaveLength(4);
      const list = await request(restarted).get('/api/conversations').set(bearer(token));
      expect((list.body.items as Array<{ id: string }>)[0]?.id).toBe(id);
    } finally {
      await fresh.$disconnect();
    }
  });

  it('listagem: só conversas próprias, mais recente primeiro, e nunca as de outros', async () => {
    const carla = await login(CARLA);
    const a = await start(carla);
    await send(carla, a, 'Antiga');
    await new Promise((r) => setTimeout(r, 5));
    const b = await start(carla);
    await send(carla, b, 'Recente');

    const list = await request(app).get('/api/conversations').set(bearer(carla));
    expect((list.body.items as Array<{ id: string; employeeId: string }>).map((c) => c.id)).toEqual([b, a]);
    expect((list.body.items as Array<{ employeeId: string }>).every((c) => c.employeeId === 'usr_carla_mendes')).toBe(true);
  });

  it('abertura simultânea cria uma única conversa vazia', async () => {
    const diego = await login(DIEGO);
    const responses = await withServer(app, (server) =>
      Promise.all(Array.from({ length: 6 }, () => request(server).post('/api/conversations').set(bearer(diego)))),
    );
    expect(new Set(responses.map((r) => r.body.conversation.id as string)).size).toBe(1);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await prisma.conversation.count({ where: { employeeId: 'usr_diego_ferreira' } })).toBe(1);
  });

  it('decisões do agente e blocos corrompidos são lidos sem derrubar a conversa', async () => {
    const token = await login(BRUNO);
    const id = await start(token);
    const agentMessage = await prisma.message.create({
      data: { conversationId: id, role: 'AGENT', content: 'Resposta', blocks: [{ type: 'bloco-que-nao-existe' }] },
    });
    const decision = await prisma.agentDecision.create({
      data: {
        conversationId: id,
        messageId: agentMessage.id,
        intent: 'ASK_QUESTION',
        understanding: 'Pergunta sobre VPN',
        action: 'ANSWER_FROM_HELP_CENTER',
        confidence: 0.9,
        rationale: 'Há artigo na central de ajuda.',
        ruleRefs: ['A.ESCOPO'],
        steps: [],
      },
    });
    const conversation = await history(token, id);
    expect(conversation.messages[0]).toMatchObject({ role: 'AGENT', blocks: [], decisionId: decision.id });
    expect(conversation.decisions[0]).toMatchObject({ id: decision.id, messageId: agentMessage.id, confidenceLevel: 'HIGH' });
  });
});

describe('mensagens e concorrência no PostgreSQL', () => {
  it('reenvio e requisições simultâneas com o mesmo clientMessageId gravam uma única vez', async () => {
    const token = await login(ANA);
    const id = await start(token);
    const clientMessageId = randomUUID();

    const responses = await withServer(app, (server) =>
      Promise.all(Array.from({ length: 10 }, () => send(token, id, 'Uma vez só', clientMessageId, server))),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(new Set(responses.map((r) => (parseSse(r.text)[0]?.data.message as { id: string }).id)).size).toBe(1);

    const stored = await prisma.message.count({ where: { conversationId: id } });
    expect(stored).toBe(1);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id } })).employeeMessageCount).toBe(1);
  });

  it('o limite de 30 vale sob concorrência: 40 envios simultâneos, exatamente 30 aceitos', async () => {
    const token = await login(BRUNO);
    const id = await start(token);
    const responses = await withServer(app, (server) =>
      Promise.all(Array.from({ length: 40 }, (_, i) => send(token, id, `rajada ${i}`, randomUUID(), server))),
    );

    expect(responses.filter((r) => r.status === 200)).toHaveLength(30);
    const refused = responses.filter((r) => r.status === 429);
    expect(refused).toHaveLength(10);
    expect(ApiErrorBodySchema.parse(refused[0]?.body).error.code).toBe('MESSAGE_LIMIT_REACHED');

    expect(await prisma.message.count({ where: { conversationId: id } })).toBe(30);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id } })).employeeMessageCount).toBe(30);
  });

  it('ordem estável: createdAt estritamente crescente, também quando a mensagem do agente concorre', async () => {
    const token = await login(ANA);
    const id = await start(token);
    await send(token, id, 'Preciso abrir um chamado');

    // rascunho confirmado em paralelo a várias mensagens: ambos escrevem na mesma conversa
    const payload: DraftPayload = {
      operation: 'CREATE',
      fields: {
        type: 'REQ',
        title: 'Cabo HDMI extra',
        description: 'Preciso de um cabo HDMI extra para a sala de reunião.',
        category: 'HARDWARE',
        priority: 'LOW',
        affectedScope: 'INDIVIDUAL',
        affectedDescription: 'Somente Ana Souza',
      },
      priorityAssessment: { priority: 'LOW', impact: 'Uma pessoa', urgency: 'Sem urgência', rationale: 'Baixa.' },
    };
    const draftId = `drf_ord_${randomUUID().slice(0, 8)}`;
    await prisma.ticketDraft.create({ data: { id: draftId, conversationId: id, employeeId: ANA_ID, operation: 'CREATE', payload: payload as object } });

    const results = await withServer(app, (server) =>
      Promise.all([
        ...Array.from({ length: 8 }, (_, i) => send(token, id, `em paralelo ${i}`, randomUUID(), server)),
        request(server).post(`/api/conversations/${id}/drafts/${draftId}/confirm`).set(bearer(token)),
      ]),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);

    const conversation = await history(token, id);
    expect(conversation.messages).toHaveLength(1 + 8 + 1);
    expect(strictlyIncreasing(conversation.messages.map((m) => Date.parse(m.createdAt)))).toBe(true);
    expect(conversation.messages.filter((m) => m.role === 'AGENT')).toHaveLength(1);
    expect(conversation.employeeMessageCount).toBe(9);
    // a data de última mensagem acompanha a mais recente
    expect(Date.parse(conversation.lastMessageAt ?? '')).toBe(Date.parse(conversation.messages.at(-1)?.createdAt ?? ''));
  });
});

describe('estado da conversa (PostgreSQL)', () => {
  it('encerrada: 409 e nada gravado', async () => {
    const token = await login(ANA);
    const id = await start(token);
    await send(token, id, 'Antes de encerrar');
    await prisma.conversation.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() } });

    const res = await send(token, id, 'Depois de encerrar');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await prisma.message.count({ where: { conversationId: id } })).toBe(1);
  });

  it.each(['WAITING_ANALYST', 'WITH_ANALYST'] as const)('%s: grava a mensagem e o agente não é acionado', async (status) => {
    const token = await login(ANA);
    const id = await start(token);
    await prisma.conversation.update({ where: { id }, data: { status } });
    responder.mockClear();

    const res = await send(token, id, 'Posso falar com alguém?');
    expect(parseSse(res.text).map((e) => e.event)).toEqual(['message.accepted', 'conversation.status', 'done']);
    expect(responder).not.toHaveBeenCalled();
    expect(await prisma.message.count({ where: { conversationId: id, role: 'EMPLOYEE' } })).toBe(1);
  });

  it('com o agente, reenvio de mensagem já respondida não aciona o responder de novo', async () => {
    const token = await login(ANA);
    const id = await start(token);
    responder.mockClear();
    const clientMessageId = randomUUID();
    const first = parseSse((await send(token, id, 'Olá', clientMessageId)).text);
    const triggerMessageId = (first[0]?.data.message as { id: string }).id;
    // Resposta registrada (o responder deste arquivo é falso e não publica nada).
    await prisma.agentDecision.create({
      data: { conversationId: id, triggerMessageId, intent: 'SMALL_TALK', understanding: 'Cumprimento.', action: 'REPLY', confidence: 0.9, rationale: 'Teste.' },
    });
    await send(token, id, 'Olá', clientMessageId);
    expect(responder).toHaveBeenCalledOnce();
  });

  it('com o agente, reenvio de mensagem ainda pendente retoma a resposta (P0.5)', async () => {
    const token = await login(ANA);
    const id = await start(token);
    responder.mockClear();
    const clientMessageId = randomUUID();
    await send(token, id, 'Olá', clientMessageId);
    await send(token, id, 'Olá', clientMessageId);
    expect(responder).toHaveBeenCalledTimes(2);
    expect(await prisma.message.count({ where: { conversationId: id } })).toBe(1);
  });
});

describe('isolamento (PostgreSQL)', () => {
  it('outro funcionário não lê nem escreve na conversa: 404 e nada gravado', async () => {
    const ana = await login(ANA);
    const id = await start(ana);
    await send(ana, id, 'Assunto privado da Ana');
    const bruno = await login(BRUNO);

    const read = await request(app).get(`/api/conversations/${id}`).set(bearer(bruno));
    const write = await send(bruno, id, 'Invadindo');
    expect([read.status, write.status]).toEqual([404, 404]);
    expect(read.text + write.text).not.toMatch(/privado|Invadindo/);
    expect(await prisma.message.count({ where: { conversationId: id } })).toBe(1);
  });
});

describe('banco indisponível', () => {
  it('responde 503 DATABASE_UNAVAILABLE em todas as rotas de conversa, sem vazar credenciais', async () => {
    const token = await login(ANA);
    const dead = createPrismaClient('postgresql://ninguem:senha-secreta@127.0.0.1:1/inexistente');
    try {
      // autenticação real (token válido) + conversas contra um banco fora do ar
      const mixed = await serve(createApp({
        checkDatabase: async () => ({ status: 'up' }),
        version: 'test',
        startedAt: new Date(),
        logger: { error: () => undefined },
        api: {
          auth: createAuthService({ users: createPrismaUserRepository(prisma), secret: SECRET, sessionTtlSeconds: 3600 }),
          tickets: createLegacyTicketService(prisma),
          conversations: createConversationService({ conversations: createPrismaConversationRepository(dead) }),
          drafts: createDraftService({ drafts: createPrismaDraftRepository(prisma), tickets: createLegacyTicketService(prisma) }),
        },
      }));
      const responses = [
        await request(mixed).get('/api/conversations').set(bearer(token)),
        await request(mixed).post('/api/conversations').set(bearer(token)),
        await request(mixed).get('/api/conversations/conv_x').set(bearer(token)),
        await send(token, 'conv_x', 'Oi', randomUUID(), mixed),
      ];
      for (const res of responses) {
        expect(res.status).toBe(503);
        expect(ApiErrorBodySchema.parse(res.body).error).toMatchObject({ code: 'DATABASE_UNAVAILABLE', retryable: true });
        expect(res.text).not.toMatch(/senha-secreta|127\.0\.0\.1|inexistente/);
      }
    } finally {
      await dead.$disconnect();
    }
  });
});
