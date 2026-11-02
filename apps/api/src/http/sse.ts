import { type ChatStreamEvent, ChatStreamEventSchema, type ConversationEvent, ConversationEventSchema } from '@nexo/shared';
import type { Response } from 'express';

/**
 * Escritor de Server-Sent Events para `ChatStreamEvent`. Cada evento é validado contra o contrato
 * antes de sair: um evento malformado vira erro do servidor, não lixo para a interface.
 */
export interface SseStream {
  /** Envia o evento. Devolve `false` se o cliente já desconectou (nada é escrito). */
  send(event: ChatStreamEvent): boolean;
  end(): void;
  readonly closed: boolean;
}

export function openSse(res: Response): SseStream {
  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  // Evita que proxies (nginx) acumulem a resposta em buffer e quebrem o "tempo real".
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders();

  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  return {
    get closed() {
      return closed || res.writableEnded;
    },
    send(event) {
      if (closed || res.writableEnded) return false;
      const valid = ChatStreamEventSchema.parse(event);
      res.write(`event: ${valid.event}\ndata: ${JSON.stringify(valid.data)}\n\n`);
      return true;
    },
    end() {
      if (!res.writableEnded) res.end();
    },
  };
}

/**
 * Escritor do stream de acompanhamento da conversa (`ConversationEvent`). Diferente do stream de
 * mensagens, ele fica aberto por muito tempo: manda um comentário periódico (`: keep-alive`) para que
 * proxies não derrubem a conexão por inatividade e identifica cada `message.created` pelo id da
 * mensagem, que o cliente devolve em `Last-Event-ID` ao reconectar.
 */
export interface EventStream {
  /** Devolve `false` se o cliente já desconectou (nada é escrito). */
  send(event: ConversationEvent): boolean;
  end(): void;
  readonly closed: boolean;
}

export const DEFAULT_HEARTBEAT_MS = 20_000;
/** Dica ao cliente de quanto esperar antes de reconectar. */
const RECONNECT_DELAY_MS = 3_000;

export function openEventStream(res: Response, options: { heartbeatMs?: number } = {}): EventStream {
  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders();
  res.write(`retry: ${RECONNECT_DELAY_MS}\n\n`);

  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': keep-alive\n\n');
  }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  heartbeat.unref();
  res.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
  });

  return {
    get closed() {
      return closed || res.writableEnded;
    },
    send(event) {
      if (closed || res.writableEnded) return false;
      const valid = ConversationEventSchema.parse(event);
      const id = valid.event === 'message.created' ? `id: ${valid.data.message.id}\n` : '';
      res.write(`${id}event: ${valid.event}\ndata: ${JSON.stringify(valid.data)}\n\n`);
      return true;
    },
    end() {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    },
  };
}
