import type { ConversationEvent } from '@nexo/shared';
import { type ApiClient, isApiError } from './api';

export type EventsConnection = 'connecting' | 'open' | 'reconnecting' | 'stopped';

export interface ConversationEventsOptions {
  /** Id da última mensagem que a tela já tem (do histórico carregado). */
  readonly after: string | null;
  readonly onEvent: (event: ConversationEvent) => void;
  readonly onConnection?: (state: EventsConnection) => void;
  /** Espera entre reconexões (ms), crescente até o máximo. */
  readonly retryDelays?: readonly number[];
}

const DEFAULT_DELAYS = [1_000, 2_000, 5_000, 10_000];

/**
 * Acompanha a conversa (`GET .../events`) e reconecta sozinho se a conexão cair. Na reconexão envia
 * `Last-Event-ID` com a última mensagem recebida, e o servidor devolve só o que foi perdido; quem usa
 * ainda descarta por id o que já tem. Para em 401/403/404 (sessão ou acesso inválido).
 */
export function watchConversation(client: ApiClient, conversationId: string, options: ConversationEventsOptions): () => void {
  const delays = options.retryDelays ?? DEFAULT_DELAYS;
  const controller = new AbortController();
  let lastEventId: string | null = null;
  let attempt = 0;
  let stopped = false;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      controller.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });

  void (async () => {
    while (!stopped) {
      options.onConnection?.(attempt === 0 ? 'connecting' : 'reconnecting');
      try {
        await client.conversationEvents(
          conversationId,
          (event) => {
            if (attempt > 0 || event.event === 'conversation.status') options.onConnection?.('open');
            attempt = 0;
            if (event.event === 'message.created') lastEventId = event.id ?? event.data.message.id;
            options.onEvent(event);
          },
          { after: options.after, lastEventId, signal: controller.signal },
        );
      } catch (error) {
        if (stopped) break;
        if (isApiError(error) && [401, 403, 404].includes(error.status)) {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 5_000;
      attempt += 1;
      options.onConnection?.('reconnecting');
      await wait(delay);
    }
    options.onConnection?.('stopped');
  })();

  return () => {
    stopped = true;
    controller.abort();
  };
}
