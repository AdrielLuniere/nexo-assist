import type { ChatStreamEvent, Message, User } from '@nexo/shared';
import type { ConversationRecord } from './conversation-repository.js';

/**
 * Porta por onde o agente responde ao funcionário. A rota de mensagens (e a de retomada) só a aciona
 * quando a conversa está com o agente e a mensagem ainda não tem resposta; ela devolve os eventos de
 * streaming (`agent.step`, `agent.message`...), que a rota valida e repassa por SSE.
 * Implementação real: `agent/agent-responder.ts` (Mastra).
 */
export interface AgentResponder {
  respond(input: {
    readonly user: User;
    readonly conversation: ConversationRecord;
    readonly message: Message;
    readonly signal: AbortSignal;
  }): AsyncIterable<ChatStreamEvent>;
}

/** Sem respondedor injetado (testes): a mensagem é gravada e o stream termina sem resposta. */
export const noAgentResponder: AgentResponder = {
  // eslint-disable-next-line require-yield
  async *respond() {
    return;
  },
};
