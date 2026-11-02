import { ConversationEventsQuerySchema, type ConversationEvent, IdSchema } from '@nexo/shared';
import type { RequestHandler } from 'express';
import type { ConversationEventBus } from '../../conversations/conversation-events.js';
import type { ConversationService } from '../../conversations/conversation-service.js';
import { AppError } from '../app-error.js';
import { currentUser } from '../middleware/authenticate.js';
import { DEFAULT_HEARTBEAT_MS, type EventStream, openEventStream } from '../sse.js';

export const DEFAULT_MAX_EVENT_STREAMS_PER_USER = 5;

export interface ConversationEventsOptions {
  readonly conversations: ConversationService;
  readonly events: ConversationEventBus;
  /** Conexões simultâneas por funcionário (abas abertas, reconexões que ainda não caíram). */
  readonly maxPerUser?: number;
  readonly heartbeatMs?: number;
}

/**
 * `GET /api/conversations/:id/events`: acompanha a conversa sem recarregar a página.
 *
 * Ordem (importa para não perder nada entre ler o estado e começar a ouvir):
 * 1. assina o barramento, guardando os eventos que chegarem;
 * 2. lê do banco o estado atual e as mensagens de analista perdidas (404 se a conversa não é do
 *    funcionário: nada é enviado a quem não é o dono);
 * 3. abre o stream e envia o estado, as mensagens perdidas e, por fim, o que chegou nesse meio-tempo,
 *    sem repetir o que já foi enviado;
 * 4. segue repassando os eventos ao vivo.
 */
export function conversationEventsHandler(options: ConversationEventsOptions): RequestHandler {
  const maxPerUser = options.maxPerUser ?? DEFAULT_MAX_EVENT_STREAMS_PER_USER;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const openByUser = new Map<string, number>();

  return async (req, res) => {
    const user = currentUser(req);
    const conversationId = IdSchema.parse(req.params.conversationId);
    const { after } = ConversationEventsQuerySchema.parse(req.query);

    // Na reconexão o navegador informa a última mensagem recebida; vale mais que `after`.
    let from: string | null = after ?? null;
    const lastEventId = req.header('last-event-id');
    if (lastEventId) {
      const parsed = IdSchema.safeParse(lastEventId);
      if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Last-Event-ID inválido.');
      from = parsed.data;
    }

    if ((openByUser.get(user.id) ?? 0) >= maxPerUser) {
      throw new AppError('RATE_LIMITED', 'Há conexões demais abertas para este usuário. Feche abas antigas e tente novamente.');
    }
    openByUser.set(user.id, (openByUser.get(user.id) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      unsubscribe();
      const left = (openByUser.get(user.id) ?? 1) - 1;
      if (left <= 0) openByUser.delete(user.id);
      else openByUser.set(user.id, left);
    };

    let stream: EventStream | null = null;
    const buffered: ConversationEvent[] = [];
    let deliver = (event: ConversationEvent): void => {
      buffered.push(event);
    };
    const unsubscribe = options.events.subscribe(conversationId, {
      onEvent: (event) => deliver(event),
      onShutdown: () => stream?.end(),
    });

    try {
      const snapshot = await options.conversations.eventsSnapshot(user, conversationId, from);
      // O cliente pode ter saído enquanto líamos o banco: o 'close' já passou e não vai se repetir.
      if (res.destroyed || res.socket?.destroyed) {
        release();
        return;
      }

      const opened = openEventStream(res, { heartbeatMs });
      stream = opened;
      res.on('close', release);

      const seen = new Set(snapshot.missed.map((message) => message.id));
      let lastVersion = snapshot.version;
      opened.send({ event: 'conversation.status', data: { status: snapshot.status, version: snapshot.version } });
      for (const message of snapshot.missed) opened.send({ event: 'message.created', data: { message } });

      const forward = (event: ConversationEvent): void => {
        if (event.event === 'message.created') {
          if (seen.has(event.data.message.id)) return;
          seen.add(event.data.message.id);
        } else {
          if (event.data.version <= lastVersion) return;
          lastVersion = event.data.version;
        }
        opened.send(event);
      };
      // Sem `await` daqui até a troca de `deliver`: nenhum evento escapa entre o esvaziamento e o ao vivo.
      for (const event of buffered.splice(0)) forward(event);
      deliver = forward;
    } catch (error) {
      release();
      throw error;
    }
  };
}
