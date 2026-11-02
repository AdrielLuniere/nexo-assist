import { ApiErrorBodySchema, DraftConfirmationResponseSchema, type DraftPayload, type TicketFields } from '@nexo/shared';
import type { Express } from 'express';
import { type TestResponse, request } from './helpers/http.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService } from '../apps/api/src/auth/auth-service.js';
import { createPrismaUserRepository } from '../apps/api/src/auth/user-repository.js';
import { createPrismaConversationRepository } from '../apps/api/src/conversations/conversation-repository.js';
import { createConversationService } from '../apps/api/src/conversations/conversation-service.js';
import { createPrismaDraftRepository } from '../apps/api/src/drafts/draft-repository.js';
import { createDraftService } from '../apps/api/src/drafts/draft-service.js';
import { createApp } from '../apps/api/src/http/app.js';
import { createLegacyTicketService } from '../apps/api/src/infra/ticket-service.js';
import { createPrismaClient, type PrismaClient } from '../apps/api/src/infra/prisma.js';
import { seedDatabase } from '../apps/api/src/seed/seed.js';
import { type DisposableDatabase, createDisposableDatabase } from './helpers/disposable-database.js';
import { serve } from './helpers/api-harness.js';

/**
 * API HTTP completa sobre PostgreSQL real, em um banco descartável criado só para este arquivo.
 * Cobre o que os testes em memória não alcançam: CAS de rascunho no banco, índice único de
 * idempotência, mensagem de resultado única e erros reais de conexão. Roda com `npm run test:db`.
 */

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres!!';
const ANA = 'ana.souza@nexo.com.br';
const BRUNO = 'bruno.lima@nexo.com.br';
const ANA_ID = 'usr_ana_souza';
const BRUNO_ID = 'usr_bruno_lima';

let db: DisposableDatabase;
let prisma: PrismaClient;
let app: string;

const FIELDS: TicketFields = {
  type: 'INC',
  title: 'Teclado com teclas falhando',
  description: 'Várias teclas do teclado do notebook pararam de funcionar hoje cedo.',
  category: 'HARDWARE',
  priority: 'HIGH',
  affectedScope: 'INDIVIDUAL',
  affectedDescription: 'Somente Ana Souza',
};
const createPayload = (fields: TicketFields = FIELDS): DraftPayload => ({
  operation: 'CREATE',
  fields,
  priorityAssessment: { priority: fields.priority, impact: 'Uma pessoa', urgency: 'Impede o trabalho', rationale: 'Alta.' },
});

let counter = 0;
async function newDraft(employeeId: string, payload: DraftPayload, status: 'PENDING' | 'CONFIRMED' = 'PENDING') {
  const id = `drf_api_${++counter}`;
  await prisma.ticketDraft.create({
    data: {
      id,
      employeeId,
      conversationId: employeeId === ANA_ID ? 'conv_ana' : 'conv_bruno',
      operation: payload.operation,
      payload: payload as object,
      status,
    },
  });
  return id;
}

async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'qualquer' });
  expect(res.status).toBe(200);
  return (res.body as { token: string }).token;
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const confirmUrl = (conversationId: string, draftId: string) => `/api/conversations/${conversationId}/drafts/${draftId}/confirm`;

function buildApp(client: PrismaClient): Express {
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
    },
  });
}

beforeAll(async () => {
  db = await createDisposableDatabase();
  prisma = createPrismaClient(db.url);
  await seedDatabase(prisma, new Date());
  await prisma.conversation.createMany({
    data: [
      { id: 'conv_ana', employeeId: ANA_ID },
      { id: 'conv_bruno', employeeId: BRUNO_ID },
    ],
  });
  app = await serve(buildApp(prisma), 'file');
}, 90_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.drop();
}, 30_000);

describe('autenticação com usuários reais do seed', () => {
  it('autentica funcionário e analista pelo banco', async () => {
    const employee = await request(app).post('/api/auth/login').send({ email: ANA, password: 'x' });
    expect(employee.body.user).toMatchObject({ id: ANA_ID, role: 'EMPLOYEE', analystLevel: null });
    const analyst = await request(app).post('/api/auth/login').send({ email: 'paula.santos@nexo.com.br', password: 'x' });
    expect(analyst.body.user).toMatchObject({ role: 'ANALYST', analystLevel: 'N2' });
    const me = await request(app).get('/api/auth/me').set(bearer(analyst.body.token as string));
    expect(me.body.user.email).toBe('paula.santos@nexo.com.br');
  });

  it('e-mail fora dos dados de exemplo é recusado', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'intruso@exemplo.com', password: 'x' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('chamados do seed pela API', () => {
  it('cada funcionário enxerga só os seus, e chamado alheio é 404', async () => {
    const ana = await login(ANA);
    const list = await request(app).get('/api/tickets').set(bearer(ana));
    const codes = (list.body.items as Array<{ code: string }>).map((t) => t.code).sort();
    expect(codes).toEqual(['INC-19980', 'INC-20150', 'INC-20311', 'INC-20335', 'REQ-10442']);
    expect((list.body.items as Array<{ code: string; isOverdue: boolean }>).find((t) => t.code === 'INC-20311')?.isOverdue).toBe(true);

    const own = await request(app).get('/api/tickets/INC-20311').set(bearer(ana));
    expect(own.status).toBe(200);
    expect(own.body.ticket.history.length).toBeGreaterThan(0);

    const foreign = await request(app).get('/api/tickets/INC-20344').set(bearer(ana));
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toMatch(/CRM|Bruno/);
  });
});

describe('confirmação de rascunhos no PostgreSQL', () => {
  it('confirma, grava o chamado, o resultado do rascunho e uma única mensagem', async () => {
    const draftId = await newDraft(ANA_ID, createPayload());
    const res = await request(app).post(confirmUrl('conv_ana', draftId)).set(bearer(await login(ANA)));
    expect(res.status).toBe(200);
    const body = DraftConfirmationResponseSchema.parse(res.body);
    expect(body.ticket.code).toBe('INC-20353');
    expect(body.draft).toMatchObject({ status: 'CONFIRMED', resultTicketCode: 'INC-20353' });

    const stored = await prisma.ticketDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect(stored.status).toBe('CONFIRMED');
    expect(stored.resultTicketId).not.toBeNull();
    expect(await prisma.message.count({ where: { conversationId: 'conv_ana', clientMessageId: `draft-result:${draftId}` } })).toBe(1);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: 'conv_ana' } })).lastMessageAt).not.toBeNull();
  });

  it('confirmações simultâneas criam um único chamado, evento e mensagem', async () => {
    const other: TicketFields = { ...FIELDS, title: 'Mouse com botão falhando', description: 'O botão esquerdo do mouse falha ao clicar, preciso de um novo.' };
    const draftId = await newDraft(ANA_ID, createPayload(other));
    const token = await login(ANA);
    const before = await prisma.ticket.count();

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => request(app).post(confirmUrl('conv_ana', draftId)).set(bearer(token))),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(new Set(responses.map((r) => r.body.ticket.code as string)).size).toBe(1);
    expect(new Set(responses.map((r) => r.body.message.id as string)).size).toBe(1);
    expect(await prisma.ticket.count()).toBe(before + 1);
    expect(await prisma.ticketEvent.count({ where: { draftId } })).toBe(1);
    expect(await prisma.message.count({ where: { clientMessageId: `draft-result:${draftId}` } })).toBe(1);
  });

  it('retoma uma confirmação interrompida (rascunho já CONFIRMED, chamado ainda não criado)', async () => {
    const other: TicketFields = { ...FIELDS, title: 'Webcam sem imagem', description: 'A webcam do notebook ficou sem imagem nas reuniões de hoje.' };
    // simula a queda do processo logo depois de marcar CONFIRMED
    const draftId = await newDraft(ANA_ID, createPayload(other), 'CONFIRMED');
    const before = await prisma.ticket.count();

    const res = await request(app).post(confirmUrl('conv_ana', draftId)).set(bearer(await login(ANA)));
    expect(res.status).toBe(200);
    expect(await prisma.ticket.count()).toBe(before + 1);
    expect((await prisma.ticketDraft.findUniqueOrThrow({ where: { id: draftId } })).resultTicketId).not.toBeNull();

    const again = await request(app).post(confirmUrl('conv_ana', draftId)).set(bearer(await login(ANA)));
    expect(again.body.ticket.code).toBe(res.body.ticket.code);
    expect(await prisma.ticket.count()).toBe(before + 1);
  });

  it('funcionário não confirma rascunho de outro e nada é escrito', async () => {
    const draftId = await newDraft(ANA_ID, createPayload({ ...FIELDS, title: 'Headset com ruído', description: 'O headset corporativo está com ruído constante nas chamadas.' }));
    const before = await prisma.ticket.count();
    const res = await request(app).post(confirmUrl('conv_bruno', draftId)).set(bearer(await login(BRUNO)));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect((await prisma.ticketDraft.findUniqueOrThrow({ where: { id: draftId } })).status).toBe('PENDING');
    expect(await prisma.ticket.count()).toBe(before);
  });

  it('duplicidade recusa com 409 e devolve o rascunho a PENDING', async () => {
    const duplicate: TicketFields = {
      ...FIELDS,
      title: 'Notebook muito lento depois da atualização',
      description: 'Meu notebook ficou lento depois que o Windows atualizou.',
      priority: 'MEDIUM',
    };
    const draftId = await newDraft(ANA_ID, createPayload(duplicate));
    const res = await request(app).post(confirmUrl('conv_ana', draftId)).set(bearer(await login(ANA)));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'DUPLICATE_TICKET', details: { ticketCode: 'INC-20311' } });
    expect((await prisma.ticketDraft.findUniqueOrThrow({ where: { id: draftId } })).status).toBe('PENDING');
  });

  it('reabre chamado resolvido recentemente e recusa o resolvido há mais de 7 dias', async () => {
    const token = await login(ANA);
    const ok = await newDraft(ANA_ID, { operation: 'REOPEN', ticketCode: 'INC-20150', reason: 'A senha bloqueou de novo.' });
    expect((await request(app).post(confirmUrl('conv_ana', ok)).set(bearer(token))).status).toBe(200);

    const expired = await newDraft(ANA_ID, { operation: 'REOPEN', ticketCode: 'INC-19980', reason: 'A VPN voltou a cair.' });
    const res = await request(app).post(confirmUrl('conv_ana', expired)).set(bearer(token));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('REOPEN_WINDOW_EXPIRED');
  });
});

describe('banco indisponível', () => {
  it('responde 503 DATABASE_UNAVAILABLE sem vazar credenciais', async () => {
    const dead = createPrismaClient('postgresql://ninguem:senha-secreta@127.0.0.1:1/inexistente');
    try {
      const res = await request(await serve(buildApp(dead))).post('/api/auth/login').send({ email: ANA, password: 'x' });
      expect(res.status).toBe(503);
      expect(ApiErrorBodySchema.parse(res.body).error).toMatchObject({ code: 'DATABASE_UNAVAILABLE', retryable: true });
      expect(res.text).not.toMatch(/senha-secreta|127\.0\.0\.1|inexistente/);
    } finally {
      await dead.$disconnect();
    }
  });
});
