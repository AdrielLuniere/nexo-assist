import { type Server, createServer } from 'node:http';
import type { Express } from 'express';

/**
 * Cliente HTTP de teste com a mesma sintaxe do supertest (`request(alvo).post(url).set(...).send(...)`),
 * mas sobre o `fetch` nativo.
 *
 * Por que não o supertest: dentro do Vitest, no Windows, o cliente do supertest (superagent) derrubava
 * o worker de forma intermitente com código nativo 0xC0000409 (medido: um Express vazio + supertest
 * caía em 5 de 40 execuções, enquanto o mesmo volume de requisições com `fetch` caiu em 0 de 40).
 * O aborto não deixa erro de JavaScript nem relatório do V8, e não tem relação com o código da API.
 *
 * Alvo aceito: URL base (string), `http.Server` já escutando ou app Express (sobe um servidor
 * temporário por chamada; use `serve()` do harness quando houver muitas requisições).
 */

export type HttpTarget = string | Server | Express;

export interface TestResponse {
  readonly status: number;
  /** Cabeçalhos com nomes em minúsculas. */
  readonly headers: Record<string, string>;
  readonly text: string;
  /** JSON já decodificado quando o corpo é JSON; `{}` caso contrário. */
  // biome-ignore lint/suspicious/noExplicitAny: espelha o `res.body` do supertest, usado de forma dinâmica nos testes.
  readonly body: any;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function resolveBase(target: HttpTarget): Promise<{ base: string; close: () => Promise<void> }> {
  if (typeof target === 'string') return { base: target.replace(/\/$/, ''), close: async () => undefined };

  let server: Server;
  let owned = false;
  if (typeof (target as Server).address === 'function') {
    server = target as Server;
  } else {
    server = createServer(target as Express);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    owned = true;
  }
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('servidor de teste não está escutando');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (!owned) return;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

class TestRequest implements PromiseLike<TestResponse> {
  private readonly headers: Record<string, string> = {};
  private payload: unknown;
  private params: Record<string, string> = {};

  constructor(
    private readonly target: HttpTarget,
    private readonly method: Method,
    private readonly path: string,
  ) {}

  set(name: string | Record<string, string>, value?: string): this {
    if (typeof name === 'string') this.headers[name.toLowerCase()] = value ?? '';
    else for (const [key, val] of Object.entries(name)) this.headers[key.toLowerCase()] = val;
    return this;
  }

  query(params: Record<string, string>): this {
    this.params = { ...this.params, ...params };
    return this;
  }

  send(body: unknown): this {
    this.payload = body;
    return this;
  }

  private async execute(): Promise<TestResponse> {
    const { base, close } = await resolveBase(this.target);
    try {
      const url = new URL(this.path, `${base}/`);
      for (const [key, value] of Object.entries(this.params)) url.searchParams.set(key, value);

      const headers = { ...this.headers };
      let body: string | undefined;
      if (this.payload !== undefined) {
        if (typeof this.payload === 'string') {
          body = this.payload;
        } else {
          body = JSON.stringify(this.payload);
          headers['content-type'] ??= 'application/json';
        }
      }

      const response = await fetch(url, { method: this.method, headers, ...(body === undefined ? {} : { body }) });
      const text = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });

      let parsed: unknown = {};
      if ((responseHeaders['content-type'] ?? '').includes('json') && text !== '') {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = {};
        }
      }
      return { status: response.status, headers: responseHeaders, text, body: parsed };
    } finally {
      await close();
    }
  }

  then<R1 = TestResponse, R2 = never>(
    onfulfilled?: ((value: TestResponse) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

export interface TestClient {
  get(path: string): TestRequest;
  post(path: string): TestRequest;
  put(path: string): TestRequest;
  patch(path: string): TestRequest;
  delete(path: string): TestRequest;
}

export function request(target: HttpTarget): TestClient {
  const make = (method: Method) => (path: string) => new TestRequest(target, method, path);
  return { get: make('GET'), post: make('POST'), put: make('PUT'), patch: make('PATCH'), delete: make('DELETE') };
}
