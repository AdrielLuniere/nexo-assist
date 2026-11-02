import { type ChatStreamEvent, ChatStreamEventSchema } from '@nexo/shared';
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
