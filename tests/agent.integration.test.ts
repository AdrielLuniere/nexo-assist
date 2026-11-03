import { type ScriptStep, call, createScriptedModel, submit } from '@nexo/agent/testing';
import { AgentDecisionSchema, ConversationDetailSchema, MessageSchema } from '@nexo/shared';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentResponder } from '../apps/api/src/agent/agent-responder.js';
import { createPrismaAgentTurnStore } from '../apps/api/src/agent/agent-turn-store.js';
import { createPrismaHelpCenter } from '../apps/api/src/agent/help-center.js';
import { createAuthService } from '../apps/api/src/auth/auth-service.js';
import { createPrismaUserRepository } from '../apps/api/src/auth/user-repository.js';
import { createPrismaConversationRepository } from '../apps/api/src/conversations/conversation-repository.js';
import { createConversationService } from '../apps/api/src/conversations/conversation-service.js';
import { createPrismaDraftRepository } from '../apps/api/src/drafts/draft-repository.js';
import { createDraftService } from '../apps/api/src/drafts/draft-service.js';
import { createApp } from '../apps/api/src/http/app.js';
import { type PrismaClient, createPrismaClient } from '../apps/api/src/infra/prisma.js';
import { createLegacyTicketService } from '../apps/api/src/infra/ticket-service.js';
import { seedDatabase } from '../apps/api/src/seed/seed.js';
import { parseSse, serve } from './helpers/api-harness.js';
import { type DisposableDatabase, createDisposableDatabase } from './helpers/disposable-database.js';
import { request } from './helpers/http.js';

/**
 * Agente de ponta a ponta sobre PostgreSQL real (banco descartável): rota SSE → agente Mastra com
 * provedor de LLM simulado → ferramentas reais (serviço de chamados e central de ajuda do seed) →
 * publicação transacional. Roda com `npm run test:db`; nenhuma chave de LLM é usada.
 */

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres!!';
const ANA = 'ana.souza@nexo.com.br';
const BRUNO = 'bruno.lima@nexo.com.br';

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

interface AppOptions {
  readonly script?: ScriptStep[];
  readonly noModel?: boolean;
  readonly client?: PrismaClient;
}

/** Sobe a API com o agente real e um modelo roteirizado. Cada chamada é um "processo" novo. */
async function startApi(options: AppOptions = {}) {
  const client = options.client ?? prisma;
  const scripted = createScriptedModel(options.script ?? []);
  const tickets = createLegacyTicketService(client);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const app: Express = createApp({
    checkDatabase: async () => ({ status: 'up' }),
    version: 'test',
    startedAt: new Date(),
    logger,
    api: {
      auth: createAuthService({ users: createPrismaUserRepository(client), secret: SECRET, sessionTtlSeconds: 3600 }),
      tickets,
      conversations: createConversationService({ conversations: createPrismaConversationRepository(client), drafts: createPrismaDraftRepository(client) }),
      drafts: createDraftService({ drafts: createPrismaDraftRepository(client), tickets }),
      responder: createAgentResponder({
        store: createPrismaAgentTurnStore(client),
        tickets,
        helpCenter: createPrismaHelpCenter(client),
        model: options.noModel ? null : scripted.model,
        modelId: 'teste/roteirizado',
        logger,
      }),
    },
  });
  return { url: await serve(app), calls: scripted.calls, logger };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function login(url: string, email: string): Promise<string> {
  return ((await request(url).post('/api/auth/login').send({ email, password: 'x' })).body as { token: string }).token;
}

async function newConversation(url: string, token: string): Promise<string> {
  // Conversa sempre nova: a vazia anterior seria reaproveitada.
  const res = await request(url).post('/api/conversations').set(bearer(token));
  return (res.body as { conversation: { id: string } }).conversation.id;
}

async function send(url: string, token: string, conversationId: string, content: string, clientMessageId = randomUUID()) {
  const res = await request(url).post(`/api/conversations/${conversationId}/messages`).set(bearer(token)).send({ content, clientMessageId });
  return { status: res.status, events: parseSse(res.text) };
}

async function resume(url: string, token: string, conversationId: string) {
  const res = await request(url).post(`/api/conversations/${conversationId}/resume`).set(bearer(token));
  return { status: res.status, events: parseSse(res.text) };
}

async function detail(url: string, token: string, conversationId: string) {
  const res = await request(url).get(`/api/conversations/${conversationId}`).set(bearer(token));
  return ConversationDetailSchema.parse((res.body as { conversation: unknown }).conversation);
}

const names = (events: Array<{ event: string }>) => events.map((e) => e.event);

beforeAll(async () => {
  db = await createDisposableDatabase();
  prisma = createPrismaClient(db.url);
  await seedDatabase(prisma, new Date());
}, 90_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.drop();
}, 30_000);

describe('resposta do agente publicada', () => {
  it('consulta de chamados: passos em tempo real, mensagem e decisão persistidas e ligadas', async () => {
    const api = await startApi({
      script: [
        call('listMyTickets', { onlyOpen: true }),
        submit(
          proposal({
            intent: 'CHECK_TICKET_STATUS',
            action: 'SHOW_TICKETS',
            understanding: 'Quer saber como estão os chamados abertos.',
            rationale: 'A consulta mostrou um chamado vencido.',
            reply: 'O INC-20311 está aguardando analista e com o prazo vencido.',
            showTickets: ['INC-20311'],
            ruleRefs: ['A.PRIORIDADE_PRAZO', 'A.INVENTADA'],
          }),
        ),
      ],
    });
    const token = await login(api.url, ANA);
    const id = await newConversation(api.url, token);
    const { events } = await send(api.url, token, id, 'Como estão meus chamados?');

    expect(names(events)).toEqual(['message.accepted', 'agent.step', 'agent.message', 'done']);
    const trigger = MessageSchema.parse((events[0]?.data as { message: unknown }).message);
    const streamed = events[2]?.data as { message: unknown; decision: unknown };
    const message = MessageSchema.parse(streamed.message);
    const decision = AgentDecisionSchema.parse(streamed.decision);

    expect(decision).toMatchObject({
      conversationId: id,
      messageId: message.id,
      triggerMessageId: trigger.id,
      intent: 'CHECK_TICKET_STATUS',
      action: 'SHOW_TICKETS',
      confidence: 0.9,
      confidenceLevel: 'HIGH',
      model: 'teste/roteirizado',
      inputTokens: 240,
      outputTokens: 60,
      // Regra inventada pelo modelo é descartada; as aplicadas de fato entram.
      ruleRefs: ['A.TRANSFERENCIA', 'A.PRIORIDADE_PRAZO'],
    });
    expect(decision.latencyMs).toBeGreaterThanOrEqual(0);
    expect(decision.steps).toEqual([expect.objectContaining({ kind: 'listMyTickets', status: 'OK', summary: expect.stringContaining('INC-20311') })]);
    expect(message).toMatchObject({ role: 'AGENT', decisionId: decision.id, authorId: null });
    expect(message.blocks.map((b) => b.type)).toEqual(['text', 'ticket_cards', 'quick_replies']);

    // O que foi transmitido é exatamente o que ficou gravado.
    const stored = await detail(api.url, token, id);
    expect(stored.decisions).toEqual([decision]);
    expect(stored.messages.map((m) => m.id)).toEqual([trigger.id, message.id]);
    expect(stored.messages[1]).toEqual(message);
    expect(stored.pendingAgentResponse).toBeNull();
    // Dados do Bruno nunca aparecem para a Ana.
    expect(JSON.stringify(stored)).not.toContain('INC-20344');
  });

  it('rascunho: publicado como PENDING sem escrever no sistema de chamados; só a confirmação cria', async () => {
    const api = await startApi({
      script: [
        call('proposeTicketDraft', {
          operation: 'CREATE',
          type: 'INC',
          category: 'HARDWARE',
          title: 'Mouse sem fio parou de funcionar',
          description: 'O mouse sem fio parou de responder hoje cedo; já troquei as pilhas.',
          affectedScope: 'INDIVIDUAL',
          affectedDescription: 'Somente Ana Souza',
          urgency: 'HAS_WORKAROUND',
        }),
        submit(proposal({ intent: 'OPEN_TICKET', action: 'PROPOSE_TICKET_DRAFT', reply: 'Preparei o chamado; confira e confirme.' })),
      ],
    });
    const token = await login(api.url, ANA);
    const id = await newConversation(api.url, token);
    const ticketsBefore = await prisma.ticket.count();

    const { events } = await send(api.url, token, id, 'Meu mouse sem fio parou, mas estou usando o touchpad');
    expect(names(events)).toEqual(['message.accepted', 'agent.step', 'agent.step', 'agent.step', 'agent.step', 'agent.step', 'agent.message', 'done']);
    const message = MessageSchema.parse((events.at(-2)?.data as { message: unknown }).message);
    const block = message.blocks.find((b) => b.type === 'draft');
    expect(block?.type === 'draft' && block.draft).toMatchObject({
      status: 'PENDING',
      payload: { operation: 'CREATE', fields: { priority: 'MEDIUM', category: 'HARDWARE' } },
    });

    // Nada foi escrito no sistema de chamados.
    expect(await prisma.ticket.count()).toBe(ticketsBefore);
    const draftId = block?.type === 'draft' ? block.draft.id : '';
    expect(await prisma.ticketDraft.findUnique({ where: { id: draftId } })).toMatchObject({ status: 'PENDING', conversationId: id });

    const confirmed = await request(api.url).post(`/api/conversations/${id}/drafts/${draftId}/confirm`).set(bearer(token));
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.ticket).toMatchObject({ title: 'Mouse sem fio parou de funcionar', priority: 'MEDIUM', status: 'WAITING_ANALYST' });
    expect(await prisma.ticket.count()).toBe(ticketsBefore + 1);

    // Ao recarregar o histórico, o bloco do rascunho mostra o estado atual, não o retrato PENDING.
    const reloaded = await detail(api.url, token, id);
    const reloadedBlock = reloaded.messages.flatMap((m) => m.blocks).find((b) => b.type === 'draft');
    expect(reloadedBlock?.type === 'draft' && reloadedBlock.draft).toMatchObject({
      id: draftId,
      status: 'CONFIRMED',
      resultTicketCode: confirmed.body.ticket.code,
      confirmedAt: expect.any(String),
    });

    // O contexto que o AGENTE recebe na próxima resposta (o `load` real) também traz o estado atual:
    // sem isso o modelo veria o retrato "pendente" e pediria para confirmar de novo um rascunho já confirmado.
    const next = await prisma.message.create({ data: { conversationId: id, role: 'EMPLOYEE', authorId: 'usr_ana_souza', content: 'E agora?', clientMessageId: randomUUID() } });
    const turn = await createPrismaAgentTurnStore(prisma).load('usr_ana_souza', id, next.id, 24);
    const seen = turn?.history.flatMap((m) => m.blocks).find((b) => b.type === 'draft');
    expect(seen?.type === 'draft' && seen.draft).toMatchObject({ id: draftId, status: 'CONFIRMED', resultTicketCode: confirmed.body.ticket.code });
  });

  it('um novo rascunho substitui o pendente anterior da conversa', async () => {
    const draft = (title: string) =>
      call('proposeTicketDraft', {
        operation: 'CREATE',
        type: 'REQ',
        category: 'SOFTWARE',
        title,
        description: `Preciso do ${title} instalado para o trabalho do time.`,
        affectedScope: 'INDIVIDUAL',
        affectedDescription: 'Somente Ana Souza',
        urgency: 'NONE',
      });
    const api = await startApi({
      script: [draft('Licença do Figma'), submit(proposal({ intent: 'OPEN_TICKET' })), draft('Licença do Miro'), submit(proposal({ intent: 'OPEN_TICKET' }))],
    });
    const token = await login(api.url, ANA);
    const id = await newConversation(api.url, token);
    await send(api.url, token, id, 'Preciso do Figma');
    await send(api.url, token, id, 'Na verdade é o Miro');
    const drafts = await prisma.ticketDraft.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'asc' } });
    expect(drafts.map((d) => d.status)).toEqual(['SUPERSEDED', 'PENDING']);
  });
});

describe('recuperação de resposta pendente', () => {
  const providerDown = { fail: Object.assign(new Error('503 do provedor'), { statusCode: 503 }) };

  it('falha do modelo: a mensagem fica pendente; a retomada responde uma única vez', async () => {
    const broken = await startApi({ script: [providerDown, providerDown] });
    const token = await login(broken.url, ANA);
    const id = await newConversation(broken.url, token);
    const clientMessageId = randomUUID();

    const failed = await send(broken.url, token, id, 'Minha VPN dá erro 809', clientMessageId);
    expect(names(failed.events)).toEqual(['message.accepted', 'error', 'done']);
    expect(failed.events[1]?.data).toMatchObject({ error: { code: 'AGENT_UNAVAILABLE', retryable: true } });
    const pending = await detail(broken.url, token, id);
    expect(pending.pendingAgentResponse).toEqual({ messageId: pending.messages[0]?.id });
    expect(pending.decisions).toEqual([]);

    // "Reinício" com o provedor de volta: a retomada responde à mensagem pendente.
    const healthy = await startApi({
      script: [call('searchHelpCenter', { query: 'vpn erro 809' }), submit(proposal({ action: 'ANSWER_FROM_HELP_CENTER', reply: 'Reinstale o cliente de VPN.' }))],
    });
    const resumed = await resume(healthy.url, token, id);
    expect(names(resumed.events)).toEqual(['agent.step', 'agent.message', 'done']);
    const after = await detail(healthy.url, token, id);
    expect(after.pendingAgentResponse).toBeNull();
    expect(after.decisions).toHaveLength(1);
    expect(after.decisions[0]).toMatchObject({ triggerMessageId: pending.messages[0]?.id, action: 'ANSWER_FROM_HELP_CENTER' });
    expect(healthy.calls).toHaveLength(2);

    // Retomar de novo e reenviar a mesma mensagem não chamam o modelo nem duplicam nada.
    expect(names((await resume(healthy.url, token, id)).events)).toEqual(['done']);
    expect(names((await send(healthy.url, token, id, 'Minha VPN dá erro 809', clientMessageId)).events)).toEqual(['message.accepted', 'done']);
    expect(healthy.calls).toHaveLength(2);
    expect(await prisma.message.count({ where: { conversationId: id } })).toBe(2);
  });

  it('reenviar a mensagem pendente (mesmo clientMessageId) também a recupera', async () => {
    const broken = await startApi({ script: [providerDown, providerDown] });
    const token = await login(broken.url, ANA);
    const id = await newConversation(broken.url, token);
    const clientMessageId = randomUUID();
    await send(broken.url, token, id, 'Oi', clientMessageId);

    const healthy = await startApi({ script: [submit(proposal({ intent: 'SMALL_TALK', reply: 'Olá! Em que posso ajudar?' }))] });
    const replay = await send(healthy.url, token, id, 'Oi', clientMessageId);
    expect(names(replay.events)).toEqual(['message.accepted', 'agent.message', 'done']);
    expect(await prisma.message.count({ where: { conversationId: id } })).toBe(2);
  });

  it('retomadas simultâneas, inclusive em "processos" diferentes, publicam uma única resposta', async () => {
    const broken = await startApi({ script: [providerDown, providerDown] });
    const token = await login(broken.url, ANA);
    const id = await newConversation(broken.url, token);
    await send(broken.url, token, id, 'Quais são meus chamados?');

    // Execução lenta: todas as retomadas chegam enquanto a primeira ainda está no modelo.
    const slow: ScriptStep[] = [
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return submit(proposal({ intent: 'CHECK_TICKET_STATUS', reply: 'Você tem chamados em aberto.' }));
      },
    ];
    const processA = await startApi({ script: slow });
    const processB = await startApi({ script: slow });
    const results = await Promise.all([resume(processA.url, token, id), resume(processA.url, token, id), resume(processB.url, token, id)]);

    const published = results.map((r) => (r.events.find((e) => e.event === 'agent.message')?.data as { message: { id: string } } | undefined)?.message.id);
    expect(published.every((messageId) => messageId === published[0] && messageId !== undefined)).toBe(true);
    expect(await prisma.agentDecision.count({ where: { conversationId: id } })).toBe(1);
    expect(await prisma.message.count({ where: { conversationId: id, role: 'AGENT' } })).toBe(1);
    // No mesmo processo, a fila por conversa evita a segunda chamada ao modelo.
    expect(processA.calls).toHaveLength(1);
  });

  it('sem modelo configurado: mensagem gravada, erro repetível e resposta pendente', async () => {
    const api = await startApi({ noModel: true });
    const token = await login(api.url, ANA);
    const id = await newConversation(api.url, token);
    const { events } = await send(api.url, token, id, 'Oi');
    expect(names(events)).toEqual(['message.accepted', 'error', 'done']);
    expect(events[1]?.data).toMatchObject({ error: { code: 'AGENT_UNAVAILABLE', retryable: true, message: expect.stringContaining('não está configurado') } });
    expect((await detail(api.url, token, id)).pendingAgentResponse).not.toBeNull();
  });
});

describe('transferência para analista', () => {
  it('o agente transfere: Handoff gravado, conversa aguardando analista e agente pausado', async () => {
    const api = await startApi({
      script: [
        call('requestHandoff', { reason: 'EMPLOYEE_REQUEST', summary: 'Ana quer falar com um analista sobre o notebook lento (INC-20311).', relatedTicketCode: 'INC-20311' }),
        submit(proposal({ intent: 'TALK_TO_ANALYST', action: 'TRANSFER_TO_ANALYST', reply: 'Chamei um analista; ele já recebe o resumo.' })),
      ],
    });
    const token = await login(api.url, ANA);
    const id = await newConversation(api.url, token);
    const before = await prisma.conversation.findUniqueOrThrow({ where: { id } });

    const { events } = await send(api.url, token, id, 'Quero falar com um analista');
    expect(names(events)).toEqual(['message.accepted', 'agent.step', 'agent.message', 'conversation.status', 'done']);
    expect(events[3]?.data).toEqual({ status: 'WAITING_ANALYST', version: before.version + 1 });
    const message = MessageSchema.parse((events[2]?.data as { message: unknown }).message);
    expect(message.blocks.find((b) => b.type === 'handoff_notice')).toMatchObject({ reason: 'EMPLOYEE_REQUEST', relatedTicketCode: 'INC-20311' });

    const handoff = await prisma.handoff.findFirstOrThrow({ where: { conversationId: id } });
    expect(handoff).toMatchObject({ reason: 'EMPLOYEE_REQUEST', status: 'WAITING', requestedBy: 'EMPLOYEE', summary: expect.stringContaining('INC-20311'), relatedTicketId: 'tkt_inc_20311' });
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'WAITING_ANALYST', version: before.version + 1 });

    // A próxima mensagem é gravada, mas o agente não é chamado.
    const next = await send(api.url, token, id, 'Alguém aí?');
    expect(names(next.events)).toEqual(['message.accepted', 'conversation.status', 'done']);
    expect(api.calls).toHaveLength(2);
    expect((await detail(api.url, token, id)).pendingAgentResponse).toBeNull();
  });

  it('conversa assumida durante a execução: a resposta do agente é descartada', async () => {
    let conversationId = '';
    const api = await startApi({
      script: [
        call('listMyTickets'),
        async () => {
          // Um analista assume enquanto o modelo ainda "pensa" (o console é de fase futura: muda direto no banco).
          await prisma.conversation.update({ where: { id: conversationId }, data: { status: 'WITH_ANALYST', version: { increment: 1 } } });
          return submit(proposal({ intent: 'CHECK_TICKET_STATUS', reply: 'Esta resposta não pode sair.' }));
        },
      ],
    });
    const token = await login(api.url, ANA);
    conversationId = await newConversation(api.url, token);

    const { events } = await send(api.url, token, conversationId, 'Meus chamados?');
    expect(names(events)).toEqual(['message.accepted', 'agent.step', 'conversation.status', 'done']);
    expect(events[2]?.data).toMatchObject({ status: 'WITH_ANALYST' });
    expect(await prisma.message.count({ where: { conversationId, role: 'AGENT' } })).toBe(0);
    expect(await prisma.agentDecision.count({ where: { conversationId } })).toBe(0);
    expect(JSON.stringify(events)).not.toContain('Esta resposta não pode sair');
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining('descartada'), expect.objectContaining({ status: 'WITH_ANALYST' }));
  });
});

describe('isolamento entre funcionários', () => {
  it('o agente da Ana não alcança o chamado do Bruno, e o Bruno não retoma a conversa da Ana', async () => {
    const api = await startApi({
      script: [call('getMyTicket', { code: 'INC-20344' }), submit(proposal({ intent: 'CHECK_TICKET_STATUS', reply: 'Não encontrei esse chamado entre os seus.', showTickets: ['INC-20344'] }))],
    });
    const ana = await login(api.url, ANA);
    const id = await newConversation(api.url, ana);
    const { events } = await send(api.url, ana, id, 'Qual o status do INC-20344?');
    const decision = AgentDecisionSchema.parse((events.find((e) => e.event === 'agent.message')?.data as { decision: unknown }).decision);
    expect(decision.steps[0]).toMatchObject({ kind: 'getMyTicket', summary: expect.stringContaining('não está entre os chamados') });
    expect(decision.ruleRefs).toContain('A.PRIVACIDADE');
    expect(JSON.stringify(events)).not.toMatch(/Sem acesso ao CRM|Bruno/);

    const bruno = await login(api.url, BRUNO);
    expect((await resume(api.url, bruno, id)).status).toBe(404);
  });
});
