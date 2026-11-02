import { describe, expect, it } from 'vitest';
import { NEXO_AGENT_ID, createNexoAgent } from './create-agent.js';
import { buildAgentInstructions } from './instructions.js';
import { AGENT_TOOLS } from './tool-catalog.js';

describe('agente Mastra', () => {
  it('é criado sem chamar o provedor de LLM', () => {
    const agent = createNexoAgent({ model: 'openai/gpt-4o-mini' });
    expect(agent.id).toBe(NEXO_AGENT_ID);
    expect(agent.name).toBe('Nexo Assist');
  });

  it('instruções cobrem as regras do Anexo A', () => {
    const text = buildAgentInstructions();
    expect(text).toMatch(/apenas assuntos de TI/i);
    expect(text).toMatch(/rascunho/i);
    expect(text).toMatch(/nunca duplicar/i);
    expect(text).toMatch(/até 7 dias/);
    expect(text).toMatch(/não tiver segurança/i);
    expect(text).toMatch(/próprio funcionário/i);
    expect(text).toContain('Rede e VPN');
  });

  it('toda ferramenta tem rótulo para a interface', () => {
    for (const tool of Object.values(AGENT_TOOLS)) {
      expect(tool.label.length).toBeGreaterThan(0);
    }
  });
});
