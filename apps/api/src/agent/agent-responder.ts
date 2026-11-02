import { type AgentLimits, type AgentModel, AgentTurnError, type AgentTurnResult, DEFAULT_AGENT_LIMITS, runAgentTurn } from '@nexo/agent';
import { type ChatStreamEvent, agentCanRespond } from '@nexo/shared';
import type { TicketService } from '@nexo/ticket-service';
import type { AgentResponder } from '../conversations/responder.js';
import { AppError } from '../http/app-error.js';
import { type KeyedLock, type Slots, createKeyedLock, createSlots } from '../infra/write-slots.js';
import { createAgentReadPorts } from './agent-ports.js';
import type { AgentTurnStore } from './agent-turn-store.js';
import type { HelpCenter } from './help-center.js';

/**
 * Responde mensagens com o agente Mastra e publica o resultado.
 *
 * Fluxo de uma resposta (sempre para uma mensagem específica do funcionário):
 * 1. Fila por conversa (uma resposta de cada vez, na ordem) e teto global de execuções do modelo,
 *    ambos com prazo de espera.
 * 2. Já respondida? Devolve a resposta gravada, sem chamar o modelo (retomadas são idempotentes).
 * 3. Conversa fora de WITH_AGENT? Não chama o modelo.
 * 4. Executa o agente (só leitura), repassando cada passo em tempo real.
 * 5. Publica numa transação que revalida o estado (ver agent-turn-store.ts).
 *
 * A execução é desacoplada da conexão: se o cliente desconectar no meio, a resposta termina e é
 * gravada mesmo assim (o custo do modelo já foi gasto); ele a vê ao reabrir a conversa.
 */

export interface AgentResponderLogger {
  info(message: string, context: Record<string, unknown>): void;
  warn(message: string, context: Record<string, unknown>): void;
}

export interface AgentResponderDeps {
  readonly store: AgentTurnStore;
  readonly tickets: TicketService;
  readonly helpCenter: HelpCenter;
  /** `null` quando nenhum modelo foi configurado (`AGENT_MODEL`): as respostas falham como indisponíveis. */
  readonly model: AgentModel | null;
  /** Identificação do modelo gravada em cada decisão. */
  readonly modelId: string;
  readonly limits?: Partial<AgentLimits>;
  /** Execuções simultâneas do modelo neste processo. */
  readonly maxConcurrentRuns?: number;
  /** Espera máxima numa fila antes de desistir com erro repetível. */
  readonly queueWaitMs?: number;
  readonly logger: AgentResponderLogger;
  readonly now?: () => Date;
}

export const DEFAULT_MAX_CONCURRENT_RUNS = 4;
export const DEFAULT_QUEUE_WAIT_MS = 20_000;

/** Canal de eventos entre a execução (produtor) e o stream HTTP (consumidor), que pode sair antes. */
function createChannel<T>() {
  const buffer: T[] = [];
  let finished = false;
  let failure: unknown = null;
  let detached = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  return {
    get detached() {
      return detached;
    },
    push(item: T) {
      if (detached) return;
      buffer.push(item);
      notify();
    },
    fail(error: unknown) {
      failure = error;
      finished = true;
      notify();
    },
    close() {
      finished = true;
      notify();
    },
    async *consume(): AsyncGenerator<T> {
      try {
        while (true) {
          if (buffer.length > 0) {
            yield buffer.shift() as T;
            continue;
          }
          if (finished) {
            if (failure) throw failure;
            return;
          }
          await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        detached = true;
        buffer.length = 0;
      }
    },
  };
}

export function createAgentResponder(deps: AgentResponderDeps): AgentResponder {
  const now = deps.now ?? (() => new Date());
  const limits: AgentLimits = { ...DEFAULT_AGENT_LIMITS, ...deps.limits };
  const queueWaitMs = deps.queueWaitMs ?? DEFAULT_QUEUE_WAIT_MS;
  const perConversation: KeyedLock = createKeyedLock({ acquireTimeoutMs: queueWaitMs, resource: 'agent' });
  const runs: Slots = createSlots({ max: deps.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS, acquireTimeoutMs: queueWaitMs, resource: 'agent' });

  return {
    respond({ user, conversation, message }) {
      const channel = createChannel<ChatStreamEvent>();
      const context = { conversationId: conversation.id, messageId: message.id };

      const job = async () => {
        await perConversation.run(conversation.id, async () => {
          const turn = await deps.store.load(user.id, conversation.id, message.id, limits.historyMessages);
          if (!turn) return;
          if (turn.answered) {
            channel.push({ event: 'agent.message', data: turn.answered });
            return;
          }
          if (!agentCanRespond(turn.status)) {
            channel.push({ event: 'conversation.status', data: { status: turn.status, version: turn.version } });
            return;
          }
          if (!deps.model) throw new AppError('AGENT_UNAVAILABLE', 'O agente não está configurado neste ambiente. Sua mensagem ficou registrada.');

          const result = await runs.run(async () => {
            let outcome: AgentTurnResult | null = null;
            for await (const event of runAgentTurn({
              model: deps.model!,
              modelId: deps.modelId,
              ports: createAgentReadPorts({ employeeId: user.id, tickets: deps.tickets, helpCenter: deps.helpCenter }),
              employee: { name: user.name, department: user.department },
              history: turn.history,
              now: now(),
              limits,
            })) {
              if (event.type === 'step') channel.push({ event: 'agent.step', data: { step: event.step } });
              else outcome = event.result;
            }
            if (!outcome) throw new AgentTurnError('INVALID_RESPONSE', 'O agente terminou sem resultado.');
            return outcome;
          });

          const published = await deps.store.publish({
            employeeId: user.id,
            conversationId: conversation.id,
            triggerMessageId: message.id,
            expectedVersion: turn.version,
            result,
            now: now(),
          });
          switch (published.kind) {
            case 'published':
            case 'already_published':
              channel.push({ event: 'agent.message', data: { message: published.message, decision: published.decision } });
              if (published.status !== 'WITH_AGENT') channel.push({ event: 'conversation.status', data: { status: published.status, version: published.version } });
              deps.logger.info('Resposta do agente publicada', {
                ...context,
                kind: published.kind,
                action: published.decision.action,
                confidence: published.decision.confidence,
                latencyMs: result.telemetry.latencyMs,
                inputTokens: result.telemetry.inputTokens,
                outputTokens: result.telemetry.outputTokens,
              });
              return;
            case 'agent_paused':
              // Transferida, assumida, encerrada ou com qualquer outra mudança de estado durante a execução: a resposta é descartada.
              deps.logger.info('Resposta do agente descartada: o estado da conversa mudou durante a execução', { ...context, status: published.status });
              channel.push({ event: 'conversation.status', data: { status: published.status, version: published.version } });
              return;
            case 'not_found':
              return;
          }
        });
      };

      void job().then(
        () => channel.close(),
        (error: unknown) => {
          if (channel.detached) {
            // Ninguém mais escuta este stream: registra aqui para a falha não sumir.
            deps.logger.warn('Resposta do agente falhou sem cliente conectado; a mensagem segue pendente', {
              ...context,
              error: error instanceof AgentTurnError ? error.reason : error instanceof Error ? error.name : 'desconhecido',
            });
          }
          channel.fail(error);
        },
      );

      return channel.consume();
    },
  };
}
