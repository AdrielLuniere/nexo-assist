import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { buildAgentInstructions } from './instructions.js';

export const NEXO_AGENT_ID = 'nexo-assist';

export interface CreateNexoAgentOptions {
  /**
   * Modelo no formato do model router do Mastra (`provedor/modelo`) ou uma instância de modelo.
   * A escolha do provedor é registrada no README (pendente para a P0.3).
   */
  readonly model: MastraModelConfig;
}

/**
 * Cria o agente Mastra. Na P0.1 o agente ainda não tem ferramentas:
 * elas serão criadas a partir de `AgentToolPorts` na P0.3, por requisição,
 * já vinculadas ao funcionário autenticado.
 */
export function createNexoAgent(options: CreateNexoAgentOptions): Agent {
  return new Agent({
    id: NEXO_AGENT_ID,
    name: 'Nexo Assist',
    description: 'Agente de atendimento do service desk de TI da Nexo.',
    instructions: buildAgentInstructions(),
    model: options.model,
  });
}
