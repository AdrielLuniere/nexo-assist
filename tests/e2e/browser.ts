import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Driver mínimo do Chrome/Edge pelo protocolo DevTools (sem Playwright/Puppeteer: nenhuma dependência
 * nova). Cada `newPage()` abre um contexto de navegador ISOLADO (armazenamento próprio), então duas
 * "pessoas" (funcionária e analista) podem usar o sistema ao mesmo tempo.
 */

const CANDIDATES = [
  process.env.E2E_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p): p is string => Boolean(p));

export const findBrowser = (): string | null => CANDIDATES.find((p) => existsSync(p)) ?? null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class Connection {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  readonly events: Array<{ method: string; params: any }> = [];

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(`${message.error.message}`));
        else waiter?.resolve(message.result);
      } else if (message.method) {
        this.events.push({ method: message.method, params: message.params });
        this.onEvent?.(message.method, message.params);
      }
    });
  }

  onEvent?: (method: string, params: any) => void;

  static async open(url: string): Promise<Connection> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error(`não conectou em ${url}`)));
    });
    return new Connection(ws);
  }

  send<T = any>(method: string, params: object = {}): Promise<T> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    this.ws.close();
  }
}

export interface PageOptions {
  readonly width?: number;
  readonly height?: number;
}

export class Page {
  /** Erros de console e exceções não tratadas, do início da página. */
  readonly errors: string[] = [];

  constructor(
    private readonly conn: Connection,
    private readonly dispose: () => Promise<void>,
  ) {
    conn.onEvent = (method, params) => {
      if (method === 'Runtime.exceptionThrown') this.errors.push(`exceção: ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text}`);
      if (method === 'Runtime.consoleAPICalled' && params.type === 'error') this.errors.push(`console.error: ${(params.args ?? []).map((a: any) => a.value ?? a.description).join(' ').slice(0, 400)}`);
    };
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const res = await this.conn.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`erro no navegador: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result?.value as T;
  }

  async goto(url: string) {
    await this.conn.send('Page.navigate', { url });
    await this.waitFor(`document.readyState === 'complete' && !!document.getElementById('root')`, 'página carregada');
  }

  async reload() {
    await this.conn.send('Page.reload', {});
    await sleep(300);
    await this.waitFor(`document.readyState === 'complete' && !!document.getElementById('root')`, 'página recarregada');
  }

  async viewport(width: number, height: number) {
    await this.conn.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
  }

  async waitFor(expression: string, what: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (error) {
        last = error;
      }
      await sleep(80);
    }
    const body = await this.eval<string>('document.body.innerText.slice(0, 1200)').catch(() => '(sem corpo)');
    throw new Error(`Tempo esgotado esperando: ${what}\nTela:\n${body}`);
  }

  text = () => this.eval<string>('document.body.innerText');

  waitText(text: string, timeoutMs = 10_000) {
    return this.waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, `texto "${text}"`, timeoutMs);
  }

  waitNoText(text: string, timeoutMs = 10_000) {
    return this.waitFor(`!document.body.innerText.includes(${JSON.stringify(text)})`, `sumir o texto "${text}"`, timeoutMs);
  }

  async hasText(text: string) {
    return this.eval<boolean>(`document.body.innerText.includes(${JSON.stringify(text)})`);
  }

  /** Nome acessível de um elemento: aria-label ou texto visível. */
  private static readonly FIND = `
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const nameOf = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\\s+/g, ' ').trim();
    const clickables = () => [...document.querySelectorAll('button, a, [role=button], label, input[type=radio], input[type=checkbox]')].filter(visible);
  `;

  /** Clica no primeiro elemento visível cujo nome acessível contém `name` (prefere o nome exato). */
  async click(name: string, timeoutMs = 8_000) {
    await this.waitFor(
      `(() => { ${Page.FIND} const all = clickables().filter(el => !el.disabled); const target = all.find(el => nameOf(el) === ${JSON.stringify(name)}) || all.find(el => nameOf(el).includes(${JSON.stringify(name)})); if (!target) return false; target.click(); return true; })()`,
      `clicar em "${name}"`,
      timeoutMs,
    );
  }

  /** Dois cliques seguidos no mesmo botão, antes de a tela reagir (duplo clique). */
  async doubleClick(name: string) {
    const ok = await this.eval<boolean>(`(() => { ${Page.FIND} const el = clickables().find(el => nameOf(el) === ${JSON.stringify(name)} && !el.disabled); if (!el) return false; el.click(); el.click(); return true; })()`);
    if (!ok) throw new Error(`botão "${name}" não encontrado`);
  }

  async isEnabled(name: string) {
    return this.eval<boolean>(`(() => { ${Page.FIND} const el = clickables().find(el => nameOf(el) === ${JSON.stringify(name)}); return !!el && !el.disabled; })()`);
  }

  async exists(name: string) {
    return this.eval<boolean>(`(() => { ${Page.FIND} return clickables().some(el => nameOf(el) === ${JSON.stringify(name)}); })()`);
  }

  /** Preenche o campo cujo rótulo (label ou aria-label) contém `label`. */
  async fill(label: string, value: string, timeoutMs = 8_000) {
    await this.conn.send('Page.bringToFront');
    await this.waitFor(
      `(() => { const wanted = ${JSON.stringify(label)}; const fields = [...document.querySelectorAll('input, textarea')].filter(e => (e.offsetWidth || e.offsetHeight) && !e.disabled);
        const byLabel = (e) => (e.labels && [...e.labels].map(l => l.innerText).join(' ')) || e.getAttribute('aria-label') || '';
        const el = fields.find(e => byLabel(e).trim() === wanted) || fields.find(e => byLabel(e).includes(wanted)); if (!el) return false; el.focus(); el.select && el.select(); return true; })()`,
      `campo "${label}" habilitado`,
      timeoutMs,
    );
    await this.conn.send('Input.insertText', { text: value });
  }

  async press(key: 'Enter' | 'Escape') {
    const code = key === 'Enter' ? 13 : 27;
    for (const type of ['keyDown', 'keyUp']) {
      await this.conn.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code, ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) });
    }
  }

  async screenshot(path: string) {
    const { data } = await this.conn.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(data, 'base64'));
  }

  async close() {
    this.conn.close();
    await this.dispose();
  }
}

export class Browser {
  private constructor(
    private readonly process: ChildProcess,
    private readonly profile: string,
    private readonly port: number,
    private readonly root: Connection,
  ) {}

  static async launch(port = 9444): Promise<Browser> {
    const exe = findBrowser();
    if (!exe) throw new Error('Nenhum Chrome/Edge encontrado. Defina E2E_BROWSER com o caminho do executável.');
    const profile = mkdtempSync(join(tmpdir(), 'nexo-e2e-'));
    const child = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--lang=pt-BR', 'about:blank'], { stdio: 'ignore' });
    let wsUrl = '';
    for (let i = 0; i < 100 && !wsUrl; i++) {
      try {
        wsUrl = ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
      } catch {
        await sleep(150);
      }
    }
    if (!wsUrl) {
      child.kill();
      throw new Error('O navegador não abriu a porta de depuração.');
    }
    return new Browser(child, profile, port, await Connection.open(wsUrl));
  }

  /** Página nova num contexto isolado (outro "usuário"). */
  async newPage(options: PageOptions = {}): Promise<Page> {
    const { browserContextId } = await this.root.send<{ browserContextId: string }>('Target.createBrowserContext');
    const { targetId } = await this.root.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId });
    const conn = await Connection.open(`ws://127.0.0.1:${this.port}/devtools/page/${targetId}`);
    await conn.send('Page.enable');
    await conn.send('Runtime.enable');
    // Várias páginas abertas: cada uma precisa se comportar como a que tem o foco.
    await conn.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await conn.send('Page.bringToFront');
    const page = new Page(conn, async () => {
      await this.root.send('Target.disposeBrowserContext', { browserContextId }).catch(() => undefined);
    });
    await page.viewport(options.width ?? 1280, options.height ?? 900);
    return page;
  }

  async close() {
    this.root.close();
    this.process.kill();
    await sleep(300);
    try {
      rmSync(this.profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // perfil temporário: o sistema limpa depois
    }
  }
}
