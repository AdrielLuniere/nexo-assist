/**
 * Falha de uma resposta do agente. Nada foi gravado quando ela acontece (o agente só lê durante a
 * execução), então a mensagem do funcionário continua pendente e pode ser retomada.
 *
 * - MODEL_UNAVAILABLE: o provedor de LLM falhou ou recusou a chamada (rede, cota, chave).
 * - TIMEOUT: a resposta passou do tempo máximo.
 * - INVALID_RESPONSE: o modelo terminou sem entregar uma resposta válida (`submitResponse`).
 * - ABORTED: execução cancelada por quem chamou.
 */
export type AgentTurnFailure = 'MODEL_UNAVAILABLE' | 'TIMEOUT' | 'INVALID_RESPONSE' | 'ABORTED';

export class AgentTurnError extends Error {
  override readonly name = 'AgentTurnError';

  constructor(
    readonly reason: AgentTurnFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
