import type { ConversationEvent } from '@nexo/shared';

/**
 * Distribuição, dentro do processo, dos eventos de uma conversa para quem a está acompanhando
 * (`GET /api/conversations/:id/events`).
 *
 * O barramento só entrega o "ao vivo". A verdade fica no banco: quem conecta (ou reconecta, ou chega
 * depois de um reinício) recebe o estado atual e as mensagens perdidas lidas do PostgreSQL, então um
 * evento que não chegou nunca deixa o funcionário com a tela errada. Com várias instâncias da API
 * seria preciso levar os eventos entre elas (LISTEN/NOTIFY); isso está fora desta fase.
 */

export interface EventSubscription {
  /** Chamado a cada evento publicado na conversa. Exceções aqui nunca atrapalham os outros assinantes. */
  readonly onEvent: (event: ConversationEvent) => void;
  /** Chamado quando o servidor está encerrando; o assinante deve fechar sua conexão. */
  readonly onShutdown: () => void;
}

export interface ConversationEventBus {
  publish(conversationId: string, event: ConversationEvent): void;
  /** Devolve a função que cancela a assinatura. */
  subscribe(conversationId: string, subscription: EventSubscription): () => void;
  /** Avisa todos os assinantes de que o servidor vai encerrar e esquece deles. */
  shutdown(): void;
  /** Assinaturas abertas (diagnóstico e testes). */
  readonly size: number;
}

export function createConversationEventBus(): ConversationEventBus {
  const subscribers = new Map<string, Set<EventSubscription>>();

  return {
    publish(conversationId, event) {
      for (const subscription of [...(subscribers.get(conversationId) ?? [])]) {
        try {
          subscription.onEvent(event);
        } catch {
          // Um assinante com defeito (conexão quebrada) não pode impedir a entrega aos demais.
        }
      }
    },
    subscribe(conversationId, subscription) {
      const set = subscribers.get(conversationId) ?? new Set<EventSubscription>();
      set.add(subscription);
      subscribers.set(conversationId, set);
      return () => {
        set.delete(subscription);
        if (set.size === 0 && subscribers.get(conversationId) === set) subscribers.delete(conversationId);
      };
    },
    shutdown() {
      const all = [...subscribers.values()].flatMap((set) => [...set]);
      subscribers.clear();
      for (const subscription of all) {
        try {
          subscription.onShutdown();
        } catch {
          // idem
        }
      }
    },
    get size() {
      let total = 0;
      for (const set of subscribers.values()) total += set.size;
      return total;
    },
  };
}
