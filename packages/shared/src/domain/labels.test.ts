import { describe, expect, it } from 'vitest';
import { RULE_REFS } from './agent-decision.js';
import { AGENT_INTENTS } from './enums.js';
import { AGENT_INTENT_LABELS, RULE_REF_LABELS } from './labels.js';

describe('rótulos da interface', () => {
  it('toda regra do Anexo A citada pelo agente tem rótulo legível', () => {
    expect(Object.values(RULE_REFS).filter((ref) => !RULE_REF_LABELS[ref])).toEqual([]);
  });

  it('toda intenção tem rótulo', () => {
    expect(AGENT_INTENTS.filter((intent) => !AGENT_INTENT_LABELS[intent])).toEqual([]);
  });
});
