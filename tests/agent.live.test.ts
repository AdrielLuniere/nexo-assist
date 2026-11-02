import { type AgentTurnResult, runAgentTurn } from '@nexo/agent';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANA_TICKETS, FOREIGN_TICKET, NOW, employeeMessage } from '../packages/agent/src/agent.fixtures.js';
import { evalPorts } from './eval/ports.js';
import { SCENARIOS, expectFailures, invariantFailures, observeTurnResult } from './eval/scenarios.js';

/**
 * Avaliação com o modelo REAL (custa tokens e depende de rede). Fora do `npm test` e do `test:db`.
 * Usa a mesma matriz do teste sem custo (tests/eval/scenarios.ts), só os cenários `live: true`, um
 * turno cada. Procedimento, cenários e custo: docs/avaliacao-agente.md.
 *
 *   AGENT_LIVE_TEST=1 AGENT_MODEL=anthropic/claude-haiku-5-5 ANTHROPIC_API_KEY=... npm run test:live
 *
 * Limites de custo (variáveis opcionais):
 *   LIVE_MAX_SCENARIOS  quantos cenários rodar (padrão 13, todos os `live`)
 *   LIVE_MAX_TOKENS     teto de tokens (entrada + saída) somados; ao passar, os demais são pulados (padrão 150000)
 *   LIVE_ONLY           ids separados por vírgula para rodar só alguns (ex.: kb-duvida,privacidade)
 *   LIVE_REPORT         caminho de um arquivo .md para gravar a tabela de resultados
 *
 * Os dados são as portas falsas da Ana (nada de banco). As verificações são de comportamento (ação,
 * ferramentas, rascunho, transferência, privacidade), não de texto, porque a redação varia.
 */

const model = process.env.AGENT_MODEL;
const enabled = process.env.AGENT_LIVE_TEST === '1' && Boolean(model);
const maxScenarios = Number(process.env.LIVE_MAX_SCENARIOS ?? 13);
const maxTokens = Number(process.env.LIVE_MAX_TOKENS ?? 150_000);
const only = process.env.LIVE_ONLY?.split(',').map((s) => s.trim()).filter(Boolean);

async function answer(text: string): Promise<AgentTurnResult> {
  for await (const event of runAgentTurn({
    model: model!,
    modelId: model!,
    ports: evalPorts(),
    employee: { name: 'Ana Souza', department: 'Marketing' },
    history: [employeeMessage(text)],
    now: NOW,
  })) {
    if (event.type === 'result') return event.result;
  }
  throw new Error('sem resultado');
}

describe.skipIf(!enabled)(`agente com modelo real (${model ?? 'desligado'})`, () => {
  it('matriz de cenários', async () => {
    const chosen = SCENARIOS.filter((s) => s.live && (!only || only.includes(s.id))).slice(0, maxScenarios);
    const own = ANA_TICKETS.map((t) => t.code);
    const foreign = [FOREIGN_TICKET.title, 'Bruno Lima'];
    const rows: string[] = ['| Cenário | Resultado | Tokens | Divergências |', '| --- | --- | ---: | --- |'];
    let tokens = 0;
    let failed = 0;
    let skipped = 0;

    for (const scenario of chosen) {
      if (tokens >= maxTokens) {
        rows.push(`| ${scenario.id} | pulado (teto de ${maxTokens} tokens) | 0 | |`);
        skipped += 1;
        continue;
      }
      const turn = scenario.turns[0]!;
      const result = await answer(turn.employee);
      const used = (result.telemetry.inputTokens ?? 0) + (result.telemetry.outputTokens ?? 0);
      tokens += used;
      const problems = [...expectFailures({ ...turn.expect, status: undefined }, observeTurnResult(result)), ...invariantFailures(observeTurnResult(result), own, foreign)];
      if (problems.length > 0) failed += 1;
      rows.push(`| ${scenario.id} | ${problems.length === 0 ? 'ok' : 'divergiu'} | ${used} | ${problems.join('; ').replaceAll('|', '/')} |`);
    }

    const report = [`Modelo: ${model}`, `Cenários: ${chosen.length - skipped} executados, ${failed} com divergência, ${skipped} pulados`, `Tokens: ${tokens} (teto ${maxTokens})`, '', ...rows].join('\n');
    console.log(`\n${report}\n`);
    if (process.env.LIVE_REPORT) writeFileSync(process.env.LIVE_REPORT, `${report}\n`);
    expect(failed, report).toBe(0);
  });
});
