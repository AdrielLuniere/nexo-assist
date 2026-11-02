import type { AgentStep, Message } from '@nexo/shared';
import { type AgentModel, createNexoAgent } from './create-agent.js';
import { AgentTurnError } from './errors.js';
import { toModelTurns } from './history.js';
import { buildAgentInstructions } from './instructions.js';
import { type PolicyOutcome, finalizeTurn } from './policy.js';
import type { AgentReadPorts } from './ports.js';
import { SUBMIT_TOOL, createAgentTools } from './tools.js';
import { createTurnTrace } from './trace.js';

/**
 * Executa UMA resposta do agente: monta o contexto, roda o modelo com as ferramentas, aplica a
 * política determinística e devolve a decisão pronta para publicar.
 *
 * Nada é gravado aqui. O chamador (a API) publica o resultado numa transação que revalida o estado da
 * conversa; se esta execução falhar ou for interrompida, não sobra efeito parcial.
 *
 * Eventos: `step` a cada ferramenta concluída (tempo real para a interface) e `result` no final.
 * Falhas viram `AgentTurnError` (ver errors.ts).
 */

export interface AgentLimits {
  /** Chamadas ao modelo por resposta (cada uma pode executar ferramentas). */
  readonly maxSteps: number;
  /** Execuções de ferramenta por resposta (exceto `submitResponse`). */
  readonly maxToolCalls: number;
  /** Duração máxima da resposta inteira. */
  readonly timeoutMs: number;
  /** Teto de tokens gerados por chamada ao modelo. */
  readonly maxOutputTokens: number;
  /** Mensagens do histórico enviadas ao modelo. */
  readonly historyMessages: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxSteps: 6,
  maxToolCalls: 8,
  timeoutMs: 45_000,
  maxOutputTokens: 1_500,
  historyMessages: 24,
};

export interface RunAgentTurnInput {
  readonly model: AgentModel;
  /** Identificação do modelo para a telemetria da decisão, ex.: `anthropic/claude-haiku-5-5`. */
  readonly modelId: string;
  readonly ports: AgentReadPorts;
  readonly employee: { readonly name: string; readonly department: string | null };
  /** Histórico em ordem cronológica, terminando na mensagem a responder. */
  readonly history: readonly Message[];
  readonly now: Date;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<AgentLimits>;
}

export interface AgentTurnTelemetry {
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number;
}

export interface AgentTurnResult extends PolicyOutcome {
  readonly telemetry: AgentTurnTelemetry;
}

export type AgentTurnEvent =
  | { readonly type: 'step'; readonly step: AgentStep }
  | { readonly type: 'result'; readonly result: AgentTurnResult };

interface StreamChunk {
  readonly type: string;
  readonly payload?: { readonly error?: unknown };
}

interface StepLike {
  readonly toolCalls?: ReadonlyArray<{ readonly toolName?: string; readonly payload?: { readonly toolName?: string } }>;
}

/** Encerra o laço do modelo assim que a resposta final foi entregue. */
const submitted = ({ steps }: { steps: readonly StepLike[] }): boolean =>
  steps.at(-1)?.toolCalls?.some((call) => (call.toolName ?? call.payload?.toolName) === SUBMIT_TOOL) ?? false;

const tokens = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

export async function* runAgentTurn(input: RunAgentTurnInput): AsyncGenerator<AgentTurnEvent, void, undefined> {
  const limits: AgentLimits = { ...DEFAULT_AGENT_LIMITS, ...input.limits };
  const started = performance.now();
  const trace = createTurnTrace();
  const tools = createAgentTools({ ports: input.ports, trace, now: input.now, maxToolCalls: limits.maxToolCalls });
  const agent = createNexoAgent({
    model: input.model,
    tools,
    instructions: buildAgentInstructions({ now: input.now, employeeName: input.employee.name, department: input.employee.department }),
  });

  const turns = toModelTurns(input.history, limits.historyMessages);
  if (turns.length === 0) throw new AgentTurnError('INVALID_RESPONSE', 'Não há mensagem do funcionário para responder.');

  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const interrupted = () =>
    timeout.aborted
      ? new AgentTurnError('TIMEOUT', 'O agente demorou demais para responder.')
      : new AgentTurnError('ABORTED', 'A resposta do agente foi cancelada.');

  let output: Awaited<ReturnType<typeof agent.stream>>;
  try {
    output = await agent.stream([...turns], {
      maxSteps: limits.maxSteps,
      // Toda etapa termina em ferramenta: ou consulta, ou `submitResponse`. Texto solto não é resposta.
      toolChoice: 'required',
      stopWhen: submitted as never,
      modelSettings: { maxOutputTokens: limits.maxOutputTokens, maxRetries: 1 },
      abortSignal: signal,
    });
  } catch (error) {
    if (signal.aborted) throw interrupted();
    throw new AgentTurnError('MODEL_UNAVAILABLE', 'O modelo de linguagem está indisponível.', { cause: error });
  }

  let streamError: unknown;
  try {
    for await (const chunk of output.fullStream as AsyncIterable<StreamChunk>) {
      if (chunk.type === 'error') streamError ??= chunk.payload?.error ?? new Error('erro no stream do modelo');
      for (const step of trace.takeNewSteps()) yield { type: 'step', step };
    }
  } catch (error) {
    streamError ??= error;
  }
  for (const step of trace.takeNewSteps()) yield { type: 'step', step };

  if (signal.aborted && !trace.submission) throw interrupted();
  const failure = streamError ?? output.error;
  if (!trace.submission) {
    if (failure) throw new AgentTurnError('MODEL_UNAVAILABLE', 'O modelo de linguagem está indisponível.', { cause: failure });
    throw new AgentTurnError('INVALID_RESPONSE', 'O modelo terminou sem entregar uma resposta válida.');
  }

  let usage: { inputTokens?: unknown; outputTokens?: unknown } = {};
  try {
    usage = (await output.totalUsage) ?? {};
  } catch {
    // Telemetria indisponível não invalida a resposta.
  }

  const outcome = finalizeTurn(trace, trace.submission);
  for (const step of outcome.policySteps) yield { type: 'step', step };
  yield {
    type: 'result',
    result: {
      ...outcome,
      telemetry: {
        model: input.modelId,
        inputTokens: tokens(usage.inputTokens),
        outputTokens: tokens(usage.outputTokens),
        latencyMs: Math.round(performance.now() - started),
      },
    },
  };
}
