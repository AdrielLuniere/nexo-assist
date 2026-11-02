import type { ChatStreamEvent, Message, User } from '@nexo/shared';
import type { ConversationRecord } from './conversation-repository.js';

/**
 * Porta por onde o agente responderá ao funcionário (Mastra, em fase futura). A rota de mensagens
 * só a aciona quando a conversa está com o agente e a mensagem é nova; ela devolve os eventos de
 * streaming (`agent.step`, `agent.delta`, `agent.message`...), que a rota valida e repassa por SSE.
 */
export interface AgentResponder {
  respond(input: {
    readonly user: User;
    readonly conversation: ConversationRecord;
    readonly message: Message;
    readonly signal: AbortSignal;
  }): AsyncIterable<ChatStreamEvent>;
}

/** Enquanto o agente não existe: a mensagem é gravada e o stream termina sem resposta. */
export const noAgentResponder: AgentResponder = {
  // eslint-disable-next-line require-yield
  async *respond() {
    return;
  },
};
