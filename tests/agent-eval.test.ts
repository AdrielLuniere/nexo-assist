import { ConversationDetailSchema } from '@nexo/shared';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANA, type Harness, bearer, buildHarness } from './helpers/api-harness.js';
import { request } from './helpers/http.js';
import { type Observed, SCENARIOS, expectFailures, invariantFailures } from './eval/scenarios.js';

/**
 * Matriz de avaliação do agente (tests/eval/scenarios.ts) com modelo ROTEIRIZADO e sem custo.
 *
 * O que isto prova: dado um modelo que se comporta como esperado, a plataforma (ferramentas reais,
 * política determinística, privacidade, persistência) produz o resultado certo, e corrige um modelo
 * que se comporta mal. O que NÃO prova: que um LLM de verdade escolhe essas ferramentas e essas
 * respostas. Isso é medido por `npm run test:live` (ver docs/avaliacao-agente.md).
 */

/** Dados de OUTROS funcionários que nunca podem aparecer para a Ana (títulos, não códigos digitados por ela). */
const FOREIGN_MARKERS = ['Sem acesso ao CRM', 'Bruno Lima'];

async function observe(h: Harness, token: string, conversationId: string): Promise<Observed> {
  const res = await request(h.app).get(`/api/conversations/${conversationId}`).set(bearer(token));
  const detail = ConversationDetailSchema.parse(res.body.conversation);
  const message = [...detail.messages].reverse().find((m) => m.role === 'AGENT');
  const decision = detail.decisions.find((d) => d.messageId === message?.id);
  if (!message || !decision) throw new Error('sem resposta do agente');
  const blocks = message.blocks;
  const draftBlock = blocks.find((b) => b.type === 'draft');
  const notice = blocks.find((b) => b.type === 'handoff_notice');
  return {
    intent: decision.intent,
    action: decision.action,
    confidence: decision.confidence,
    understanding: decision.understanding,
    rationale: decision.rationale,
    ruleRefs: decision.ruleRefs,
    steps: decision.steps,
    replyText: message.content,
    ticketCodes: blocks.flatMap((b) => (b.type === 'ticket_cards' ? b.tickets.map((t) => t.code) : b.type === 'ticket_selection' ? b.options.map((t) => t.code) : [])),
    quickReplies: blocks.flatMap((b) => (b.type === 'quick_replies' ? b.options.map((o) => o.label) : [])),
    draft: draftBlock?.type === 'draft' ? draftBlock.draft.payload : null,
    handoffReason: notice?.type === 'handoff_notice' ? notice.reason : null,
    status: detail.status,
  };
}

describe('matriz de avaliação do agente (modelo roteirizado)', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: ${scenario.title}`, async () => {
      const h = await buildHarness({ agentScript: scenario.turns.flatMap((t) => [...t.script]) });
      const token = await h.login(ANA);
      const conversationId = ((await request(h.app).post('/api/conversations').set(bearer(token))).body.conversation.id as string);
      const own = (await h.realTickets.listForRequester({ employeeId: ANA.id })).map((t) => t.code);

      for (const turn of scenario.turns) {
        const before = (await h.realTickets.listForRequester({ employeeId: ANA.id })).length;
        const sent = await request(h.app).post(`/api/conversations/${conversationId}/messages`).set(bearer(token)).send({ content: turn.employee, clientMessageId: randomUUID() });
        expect(sent.status).toBe(200);

        const observed = await observe(h, token, conversationId);
        const problems = [...expectFailures(turn.expect, observed), ...invariantFailures(observed, own, FOREIGN_MARKERS)];
        expect(problems, `${scenario.id} / "${turn.employee}"`).toEqual([]);

        // Nunca se escreve em chamados sem a confirmação do rascunho.
        expect((await h.realTickets.listForRequester({ employeeId: ANA.id })).length).toBe(before);
      }
    });
  }

  it('a documentação da avaliação lista todos os cenários (a tabela não pode ficar para trás)', () => {
    const doc = readFileSync(join(import.meta.dirname, '..', 'docs', 'avaliacao-agente.md'), 'utf8');
    expect(SCENARIOS.filter((s) => !doc.includes(`\`${s.id}\``)).map((s) => s.id)).toEqual([]);
  });

  it('cobre as dimensões pedidas na avaliação', () => {
    const dims = new Set(SCENARIOS.flatMap((s) => s.dims));
    expect([...dims].sort()).toEqual(['classificação', 'confirmação', 'encaminhamento', 'ferramenta', 'intenção', 'justificativa', 'perguntas', 'privacidade']);
  });

  it('só a confirmação do rascunho escreve: o rascunho de abertura vira chamado com a prioridade calculada', async () => {
    const scenario = SCENARIOS.find((s) => s.id === 'abrir-incidente');
    if (!scenario) throw new Error('cenário ausente');
    const h = await buildHarness({ agentScript: scenario.turns.flatMap((t) => [...t.script]) });
    const token = await h.login(ANA);
    const id = (await request(h.app).post('/api/conversations').set(bearer(token))).body.conversation.id as string;
    await request(h.app).post(`/api/conversations/${id}/messages`).set(bearer(token)).send({ content: scenario.turns[0]!.employee, clientMessageId: randomUUID() });
    const draft = (await observe(h, token, id)).draft;
    expect(draft?.operation).toBe('CREATE');
    const detail = ConversationDetailSchema.parse((await request(h.app).get(`/api/conversations/${id}`).set(bearer(token))).body.conversation);
    const block = detail.messages.flatMap((m) => m.blocks).find((b) => b.type === 'draft');
    if (block?.type !== 'draft') throw new Error('sem bloco de rascunho');

    const before = (await h.realTickets.listForRequester({ employeeId: ANA.id })).length;
    const confirmed = await request(h.app).post(`/api/conversations/${id}/drafts/${block.draft.id}/confirm`).set(bearer(token));
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.ticket).toMatchObject({ priority: 'HIGH', category: 'NETWORK_VPN', type: 'INC', status: 'WAITING_ANALYST' });
    expect((await h.realTickets.listForRequester({ employeeId: ANA.id })).length).toBe(before + 1);
  });
});
