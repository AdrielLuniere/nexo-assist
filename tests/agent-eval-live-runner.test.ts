import { runAgentTurn } from '@nexo/agent';
import { createScriptedModel } from '@nexo/agent/testing';
import { describe, expect, it } from 'vitest';
import { ANA_TICKETS, FOREIGN_TICKET, NOW, employeeMessage } from '../packages/agent/src/agent.fixtures.js';
import { evalPorts } from './eval/ports.js';
import { SCENARIOS, expectFailures, invariantFailures, observeTurnResult } from './eval/scenarios.js';

/**
 * Valida, SEM custo, o caminho que `npm run test:live` usa: mesmas portas falsas, mesmo mapeamento do
 * resultado e mesmas verificações, mas com o modelo roteirizado no lugar do real. Se este teste passa e
 * o live falha, a divergência é do modelo, não do runner.
 */
describe('runner da avaliação com modelo real (verificado com modelo roteirizado)', () => {
  for (const scenario of SCENARIOS.filter((s) => s.live)) {
    it(scenario.id, async () => {
      const turn = scenario.turns[0]!;
      const { model } = createScriptedModel(turn.script);
      let result;
      for await (const event of runAgentTurn({ model, modelId: 'teste/roteirizado', ports: evalPorts(), employee: { name: 'Ana Souza', department: 'Marketing' }, history: [employeeMessage(turn.employee)], now: NOW })) {
        if (event.type === 'result') result = event.result;
      }
      if (!result) throw new Error('sem resultado');
      const observed = observeTurnResult(result);
      const problems = [...expectFailures({ ...turn.expect, status: undefined }, observed), ...invariantFailures(observed, ANA_TICKETS.map((t) => t.code), [FOREIGN_TICKET.title, 'Bruno Lima'])];
      expect(problems).toEqual([]);
    });
  }
});
