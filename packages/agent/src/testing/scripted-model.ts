import type { MastraModelConfig } from '@mastra/core/llm';

/**
 * Provedor de LLM simulado para testes determinísticos (sem rede, sem chave). Implementa a interface
 * de modelo do AI SDK (v2) que o Mastra consome, então o agente roda de verdade: laço de ferramentas,
 * validação de argumentos e streaming. Só as "decisões do modelo" vêm de um roteiro.
 *
 * Cada item do roteiro responde a uma chamada ao modelo: chamadas de ferramenta, texto solto ou falha.
 * Um item pode ser uma função que lê o prompt (ex.: o resultado da ferramenta anterior) para decidir.
 */

export interface ScriptedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type ScriptedReply =
  | { readonly calls: ReadonlyArray<{ readonly tool: string; readonly input: unknown }>; readonly usage?: ScriptedUsage }
  | { readonly text: string; readonly usage?: ScriptedUsage }
  | { readonly fail: Error };

export interface ScriptedCall {
  readonly index: number;
  /** Prompt completo recebido nesta chamada (sistema, histórico, resultados de ferramentas). */
  readonly prompt: ReadonlyArray<{ readonly role: string; readonly content: unknown }>;
  /** Ferramentas oferecidas ao modelo nesta chamada. */
  readonly tools: readonly string[];
  /** Resultado mais recente da ferramenta, como o modelo o recebeu. */
  toolResult(tool: string): unknown;
  /** Texto da última mensagem do funcionário. */
  lastUserText(): string;
  readonly signal: AbortSignal | undefined;
}

export type ScriptStep = ScriptedReply | ((call: ScriptedCall) => ScriptedReply | Promise<ScriptedReply>);

export interface ScriptedModel {
  readonly model: MastraModelConfig;
  readonly calls: ScriptedCall[];
}

const DEFAULT_USAGE: ScriptedUsage = { inputTokens: 120, outputTokens: 30 };

export const call = (tool: string, input: unknown = {}): ScriptedReply => ({ calls: [{ tool, input }] });
export const submit = (proposal: Record<string, unknown>): ScriptedReply => call('submitResponse', proposal);

/** Item de roteiro que só termina quando a chamada é cancelada (para testar o tempo máximo). */
export const hang: ScriptStep = ({ signal }) =>
  new Promise<ScriptedReply>((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('abortado')), { once: true });
  });

interface PromptPart {
  readonly type?: string;
  readonly text?: string;
  readonly toolName?: string;
  readonly output?: { readonly value?: unknown };
}

function partsOf(content: unknown): PromptPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as PromptPart[]) : [];
}

export function createScriptedModel(script: readonly ScriptStep[], options: { modelId?: string } = {}): ScriptedModel {
  const calls: ScriptedCall[] = [];

  const model = {
    specificationVersion: 'v2',
    provider: 'scripted',
    modelId: options.modelId ?? 'scripted-test-model',
    supportedUrls: {},
    async doGenerate(): Promise<never> {
      throw new Error('o modelo roteirizado só implementa streaming');
    },
    async doStream(request: { prompt: ScriptedCall['prompt']; tools?: Array<{ name: string }>; abortSignal?: AbortSignal }) {
      const prompt = request.prompt;
      const current: ScriptedCall = {
        index: calls.length,
        prompt,
        tools: (request.tools ?? []).map((tool) => tool.name),
        signal: request.abortSignal,
        toolResult(tool) {
          for (const message of [...prompt].reverse()) {
            if (message.role !== 'tool') continue;
            const part = partsOf(message.content).find((p) => p.type === 'tool-result' && p.toolName === tool);
            if (part) return part.output?.value;
          }
          return undefined;
        },
        lastUserText() {
          const user = [...prompt].reverse().find((m) => m.role === 'user');
          return partsOf(user?.content)
            .filter((p) => p.type === 'text')
            .map((p) => p.text ?? '')
            .join('\n');
        },
      };
      calls.push(current);

      const step = script[current.index] ?? { text: 'Fim do roteiro.' };
      const reply = typeof step === 'function' ? await step(current) : step;
      if ('fail' in reply) throw reply.fail;

      const usage = reply.usage ?? DEFAULT_USAGE;
      const parts: unknown[] = [{ type: 'stream-start', warnings: [] }];
      if ('calls' in reply) {
        reply.calls.forEach((toolCall, i) =>
          parts.push({ type: 'tool-call', toolCallId: `call_${current.index}_${i}`, toolName: toolCall.tool, input: JSON.stringify(toolCall.input) }),
        );
      } else {
        parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: reply.text }, { type: 'text-end', id: 't' });
      }
      parts.push({
        type: 'finish',
        finishReason: 'calls' in reply ? 'tool-calls' : 'stop',
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.inputTokens + usage.outputTokens },
      });

      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };

  return { model: model as unknown as MastraModelConfig, calls };
}
