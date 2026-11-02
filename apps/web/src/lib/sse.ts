/**
 * Leitor de Server-Sent Events sobre `fetch` (o `EventSource` do navegador não envia o cabeçalho
 * `Authorization`, e as rotas de mensagem são POST). Segue o formato do padrão: blocos separados por
 * linha em branco, campos `event:`, `data:` (pode repetir), `id:` e comentários iniciados por `:`.
 */

export interface SseMessage {
  readonly event: string;
  readonly data: string;
  readonly id: string | null;
}

function parseBlock(block: string): SseMessage | null {
  let event = 'message';
  let id: string | null = null;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  return data.length > 0 ? { event, data: data.join('\n'), id } : null;
}

/** Lê o corpo até o fim (ou até `signal` abortar), chamando `onMessage` a cada evento completo. */
export async function readSse(body: ReadableStream<Uint8Array>, onMessage: (message: SseMessage) => void, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const message = parseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (message) onMessage(message);
        boundary = buffer.indexOf('\n\n');
      }
    }
    const last = parseBlock(buffer);
    if (last) onMessage(last);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
