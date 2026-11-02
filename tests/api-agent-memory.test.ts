import { call, submit } from '@nexo/agent/testing';
import { AgentDecisionSchema, ConsoleConversationDetailSchema, ConversationDetailSchema } from '@nexo/shared';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ANA, type Harness, MARCOS, bearer, buildHarness, parseSse } from './helpers/api-harness.js';
import { request } from './helpers/http.js';

/**
 * Agente real (Mastra, ferramentas, política, publicação) com modelo roteirizado sobre o estado em
 * memória da API. É a base dos testes de interface: tudo que a tela mostra vem destas rotas.
 */

const proposal = (overrides: Record<string, unknown> = {}) => ({
  intent: 'ASK_QUESTION',
  understanding: 'Pergunta de TI.',
  action: 'REPLY',
  confidence: 0.9,
  rationale: 'Resposta direta.',
  reply: 'Certo!',
  ...overrides,
});

const DRAFT_SCRIPT = [
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
];

async function chat(h: Harness, token: string, content: string, id?: string) {
  const conversationId = id ?? ((await request(h.app).post('/api/conversations').set(bearer(token))).body.conversation.id as string);
  const res = await request(h.app).post(`/api/conversations/${conversationId}/messages`).set(bearer(token)).send({ content, clientMessageId: randomUUID() });
  return { conversationId, events: parseSse(res.text) };
}

const detailOf = async (h: Harness, token: string, id: string) =>
  ConversationDetailSchema.parse((await request(h.app).get(`/api/conversations/${id}`).set(bearer(token))).body.conversation);

describe('agente real sobre o estado em memória', () => {
  it('resposta com passos em tempo real, mensagem e decisão persistidas e ligadas', async () => {
    const h = await buildHarness({
      agentScript: [call('listMyTickets', { onlyOpen: true }), submit(proposal({ intent: 'CHECK_TICKET_STATUS', action: 'SHOW_TICKETS', reply: 'Seu INC-20311 está vencido.', showTickets: ['INC-20311'] }))],
    });
    const ana = await h.login(ANA);
    const { conversationId, events } = await chat(h, ana, 'Como estão meus chamados?');
    expect(events.map((e) => e.event)).toEqual(['message.accepted', 'agent.step', 'agent.message', 'done']);

    const detail = await detailOf(h, ana, conversationId);
    expect(detail.messages.map((m) => m.role)).toEqual(['EMPLOYEE', 'AGENT']);
    const agentMessage = detail.messages[1];
    expect(agentMessage?.blocks.find((b) => b.type === 'ticket_cards')).toMatchObject({ tickets: [{ code: 'INC-20311', isOverdue: true }] });
    const [decision] = detail.decisions.map((d) => AgentDecisionSchema.parse(d));
    expect(decision).toMatchObject({ messageId: agentMessage?.id, triggerMessageId: detail.messages[0]?.id, intent: 'CHECK_TICKET_STATUS', action: 'SHOW_TICKETS' });
    expect(decision?.steps.map((s) => s.kind)).toContain('listMyTickets');
    expect(agentMessage?.decisionId).toBe(decision?.id);
    expect(detail.pendingAgentResponse).toBeNull();
  });

  it('rascunho confirmado: o histórico recarregado mostra o estado atual e a mensagem de resultado', async () => {
    const h = await buildHarness({ agentScript: DRAFT_SCRIPT });
    const ana = await h.login(ANA);
    const { conversationId } = await chat(h, ana, 'Meu mouse sem fio parou, mas uso o touchpad');
    const before = await detailOf(h, ana, conversationId);
    const block = before.messages.flatMap((m) => m.blocks).find((b) => b.type === 'draft');
    if (block?.type !== 'draft') throw new Error('sem rascunho');
    expect(block.draft.status).toBe('PENDING');

    const confirmed = await request(h.app).post(`/api/conversations/${conversationId}/drafts/${block.draft.id}/confirm`).set(bearer(ana));
    expect(confirmed.status).toBe(200);

    const after = await detailOf(h, ana, conversationId);
    const refreshed = after.messages.flatMap((m) => m.blocks).find((b) => b.type === 'draft');
    expect(refreshed?.type === 'draft' && refreshed.draft).toMatchObject({ id: block.draft.id, status: 'CONFIRMED', resultTicketCode: confirmed.body.ticket.code });
    expect(after.messages.at(-1)).toMatchObject({ role: 'AGENT', content: expect.stringContaining(confirmed.body.ticket.code) });

    // O console enxerga o mesmo estado (depois que a conversa for transferida).
    h.conversations.transfer(conversationId);
    const consoleDetail = ConsoleConversationDetailSchema.parse((await request(h.app).get(`/api/console/conversations/${conversationId}`).set(bearer(await h.login(MARCOS)))).body.conversation);
    const consoleBlock = consoleDetail.messages.flatMap((m) => m.blocks).find((b) => b.type === 'draft');
    expect(consoleBlock?.type === 'draft' && consoleBlock.draft.status).toBe('CONFIRMED');
    expect(consoleDetail.decisions).toHaveLength(1);
  });

  it('rascunho descartado e rascunho substituído aparecem como tais', async () => {
    const h = await buildHarness({ agentScript: [...DRAFT_SCRIPT, ...DRAFT_SCRIPT, ...DRAFT_SCRIPT] });
    const ana = await h.login(ANA);
    const { conversationId } = await chat(h, ana, 'Meu mouse parou');
    await chat(h, ana, 'Na verdade é outro mouse', conversationId);
    const blocks = (await detailOf(h, ana, conversationId)).messages.flatMap((m) => m.blocks).filter((b) => b.type === 'draft');
    expect(blocks.map((b) => b.type === 'draft' && b.draft.status)).toEqual(['SUPERSEDED', 'PENDING']);

    const latest = blocks[1];
    if (latest?.type !== 'draft') throw new Error('sem rascunho');
    await request(h.app).post(`/api/conversations/${conversationId}/drafts/${latest.draft.id}/discard`).set(bearer(ana));
    const again = (await detailOf(h, ana, conversationId)).messages.flatMap((m) => m.blocks).filter((b) => b.type === 'draft');
    expect(again.map((b) => b.type === 'draft' && b.draft.status)).toEqual(['SUPERSEDED', 'DISCARDED']);
  });

  it('transferência pelo agente: conversa aguardando, fila do console e agente pausado', async () => {
    const h = await buildHarness({
      agentScript: [
        call('requestHandoff', { reason: 'EMPLOYEE_REQUEST', summary: 'Ana quer um analista para o INC-20311.', relatedTicketCode: 'INC-20311' }),
        submit(proposal({ intent: 'TALK_TO_ANALYST', action: 'TRANSFER_TO_ANALYST', reply: 'Chamei um analista.' })),
      ],
    });
    const ana = await h.login(ANA);
    const { conversationId, events } = await chat(h, ana, 'Quero falar com um analista');
    expect(events.map((e) => e.event)).toEqual(['message.accepted', 'agent.step', 'agent.message', 'conversation.status', 'done']);
    expect((await detailOf(h, ana, conversationId)).status).toBe('WAITING_ANALYST');

    const queue = await request(h.app).get('/api/console/conversations').set(bearer(await h.login(MARCOS)));
    expect(queue.body.items[0]).toMatchObject({ id: conversationId, activeHandoff: { relatedTicketCode: 'INC-20311' } });
    const callsBefore = h.modelCalls.length;
    await chat(h, ana, 'Alguém aí?', conversationId);
    expect(h.modelCalls.length).toBe(callsBefore);
  });
});
