import { runAgentTurn, type AgentTurnResult } from '@nexo/agent';
import { describe, expect, it } from 'vitest';
import { NOW, employeeMessage, fakePorts } from '../packages/agent/src/agent.fixtures.js';

/**
 * Avaliação com o modelo REAL (custa tokens e depende de rede). Fora do `npm test` e do `test:db`.
 *
 *   AGENT_LIVE_TEST=1 AGENT_MODEL=anthropic/claude-haiku-5-5 ANTHROPIC_API_KEY=... npm run test:live
 *
 * Os dados são as portas falsas da Ana (nada de banco). As verificações são de comportamento (ação,
 * ferramentas usadas, regras), não de texto, porque a redação do modelo varia entre execuções.
 */

const model = process.env.AGENT_MODEL;
const enabled = process.env.AGENT_LIVE_TEST === '1' && Boolean(model);

async function answer(text: string): Promise<AgentTurnResult> {
  for await (const event of runAgentTurn({
    model: model!,
    modelId: model!,
    ports: fakePorts(),
    employee: { name: 'Ana Souza', department: 'Marketing' },
    history: [employeeMessage(text)],
    now: NOW,
  })) {
    if (event.type === 'result') return event.result;
  }
  throw new Error('sem resultado');
}

describe.skipIf(!enabled)(`agente com modelo real (${model ?? 'desligado'})`, () => {
  it('dúvida coberta pela central de ajuda: responde sem abrir chamado', async () => {
    const result = await answer('Minha VPN está dando erro 809. Uso Windows 10. O que eu faço?');
    expect(result.decision.steps.map((s) => s.kind)).toContain('searchHelpCenter');
    expect(result.draft).toBeNull();
    expect(result.handoff).toBeNull();
    expect(result.decision.action).toBe('ANSWER_FROM_HELP_CENTER');
  });

  it('consulta sem número: usa os chamados da funcionária e mostra o vencido', async () => {
    const result = await answer('Como está aquele meu chamado do notebook lento?');
    expect(result.decision.steps.map((s) => s.kind)).toEqual(expect.arrayContaining(['listMyTickets']));
    expect(JSON.stringify(result.reply.blocks)).toContain('INC-20311');
  });

  it('pedido incompleto: pergunta antes de propor rascunho', async () => {
    const result = await answer('Quero abrir um chamado.');
    expect(result.draft).toBeNull();
    expect(result.decision.action).toBe('ASK_CLARIFICATION');
  });

  it('fora de TI: redireciona', async () => {
    const result = await answer('Quantos dias de férias eu ainda tenho?');
    expect(result.decision).toMatchObject({ intent: 'OUT_OF_SCOPE', action: 'REDIRECT_OUT_OF_SCOPE' });
  });
});
