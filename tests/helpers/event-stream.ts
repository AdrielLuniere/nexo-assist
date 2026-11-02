/**
 * Cliente de teste para streams SSE de longa duração (`GET /api/conversations/:id/events`).
 * Diferente de `request(...)`, que espera o corpo terminar, este devolve assim que os cabeçalhos
 * chegam e vai acumulando os eventos recebidos até `close()`.
 */

export interface ReceivedEvent {
  readonly id: string | null;
  readonly event: string;
  // biome-ignore lint/suspicious/noExplicitAny: dados do evento, lidos de forma dinâmica nos testes.
  readonly data: any;
}

export interface EventStreamClient {
  readonly status: number;
  readonly headers: Record<string, string>;
  /** Corpo de erro (JSON) quando o status não é 200. */
  readonly body: unknown;
  /** Texto bruto recebido até agora (inclui comentários `: keep-alive` e `retry:`). */
  raw(): string;
  events(): ReceivedEvent[];
  /** Espera até haver `count` eventos no total; falha com o que chegou se passar do prazo. */
  waitForCount(count: number, timeoutMs?: number): Promise<ReceivedEvent[]>;
  /** Espera um intervalo e confirma que nada novo chegou além de `count` eventos. */
  expectNoMoreThan(count: number, waitMs?: number): Promise<ReceivedEvent[]>;
  /** Espera o servidor encerrar o stream. */
  waitForEnd(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

function parseBlock(block: string): ReceivedEvent | null {
  const lines = block.split('\n');
  const field = (name: string) => lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
  const event = field('event');
  if (!event) return null;
  return { id: field('id'), event, data: JSON.parse(field('data') ?? '{}') };
}

export async function openEvents(base: string, path: string, headers: Record<string, string>): Promise<EventStreamClient> {
  const abort = new AbortController();
  const response = await fetch(new URL(path, `${base}/`), { headers, signal: abort.signal });
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value;
  });

  const received: ReceivedEvent[] = [];
  let raw = '';
  let ended = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const changed = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  let body: unknown = null;
  if (response.status !== 200 || !response.body) {
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    ended = true;
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          raw += chunk;
          pending += chunk;
          const blocks = pending.split('\n\n');
          pending = blocks.pop() ?? '';
          for (const block of blocks) {
            const parsed = parseBlock(block);
            if (parsed) received.push(parsed);
          }
          notify();
        }
      } catch {
        // abortado por close()
      } finally {
        ended = true;
        notify();
      }
    })();
  }

  return {
    status: response.status,
    headers: responseHeaders,
    body,
    raw: () => raw,
    events: () => [...received],
    async waitForCount(count, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (received.length < count && !ended && Date.now() < deadline) await changed(deadline - Date.now());
      if (received.length < count) {
        throw new Error(`esperava ${count} evento(s), recebeu ${received.length}: ${JSON.stringify(received.map((e) => e.event))}`);
      }
      return [...received];
    },
    async expectNoMoreThan(count, waitMs = 150) {
      await changed(waitMs);
      if (received.length > count) throw new Error(`esperava no máximo ${count} evento(s), recebeu ${received.length}: ${JSON.stringify(received)}`);
      return [...received];
    },
    async waitForEnd(timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!ended && Date.now() < deadline) await changed(deadline - Date.now());
      if (!ended) throw new Error('o stream não foi encerrado pelo servidor');
    },
    async close() {
      abort.abort();
      await changed(10);
    },
  };
}
