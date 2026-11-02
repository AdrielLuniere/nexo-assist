import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { noopLogger } from '@mastra/core/logger';
import type { ToolsInput } from '@mastra/core/agent';
import { buildAgentInstructions } from './instructions.js';

export const NEXO_AGENT_ID = 'nexo-assist';

/** Modelo aceito pelo agente: id do model router do Mastra (`provedor/modelo`) ou instância de modelo. */
export type AgentModel = MastraModelConfig;

export interface CreateNexoAgentOptions {
  /**
   * Modelo no formato do model router do Mastra (`provedor/modelo`, ex.: `anthropic/claude-haiku-5-5`)
   * ou uma instância de modelo (os testes usam um modelo roteirizado, sem rede).
   */
  readonly model: AgentModel;
  readonly instructions?: string;
  /** Ferramentas já vinculadas ao funcionário (`createAgentTools`). Sem elas, o agente só conversa. */
  readonly tools?: ToolsInput;
}

/**
 * Cria o agente Mastra. As ferramentas são vinculadas a cada resposta (ao funcionário autenticado),
 * por isso o agente é criado por resposta: é um objeto leve, sem conexão nem estado.
 *
 * A memória do Mastra não é usada: o histórico vem das conversas persistidas pela API, que são a fonte
 * de verdade. O logger do Mastra é silenciado; os erros são tratados e registrados pela API.
 */
export function createNexoAgent(options: CreateNexoAgentOptions): Agent {
  const agent = new Agent({
    id: NEXO_AGENT_ID,
    name: 'Nexo Assist',
    description: 'Agente de atendimento do service desk de TI da Nexo.',
    instructions: options.instructions ?? buildAgentInstructions(),
    model: options.model,
    ...(options.tools ? { tools: options.tools } : {}),
  });
  agent.__setLogger(noopLogger);
  return agent;
}
