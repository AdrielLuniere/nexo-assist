import type { User } from '@nexo/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { afterEach } from 'vitest';
import { type Harness, type HarnessOptions, bearer, buildHarness } from '../../../../tests/helpers/api-harness';
import { request } from '../../../../tests/helpers/http';
import { App } from '../App';

/**
 * Testes de interface contra a API REAL (Express, serviços, regras e o agente Mastra com modelo
 * roteirizado), servida em memória. A tela fala HTTP e SSE com ela exatamente como no navegador:
 * nada do que aparece é dado simulado no front.
 */

// Como nos navegadores atuais (e diferente do jsdom), `scrollIntoView` devolve uma Promise. Um efeito
// que a devolva por engano derruba a tela; os testes precisam pegar isso.
Element.prototype.scrollIntoView = function scrollIntoView() {
  return Promise.resolve() as unknown as void;
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

export const FAST = { retryDelays: [30, 60, 120], consolePollMs: 150 } as const;

export async function startApp(options: HarnessOptions & { timings?: { retryDelays?: readonly number[]; consolePollMs?: number } } = {}) {
  const h = await buildHarness(options);
  const user = userEvent.setup();
  const now = () => h.clock.current;
  const mount = () => render(<App baseUrl={h.app} timings={options.timings ?? FAST} now={now} />);
  const view = mount();
  return { h, user, view, remount: () => (view.unmount(), mount()) };
}

export async function signIn(user: ReturnType<typeof userEvent.setup>, who: Pick<User, 'email'>, password = 'qualquer') {
  await user.type(await screen.findByLabelText('E-mail corporativo'), who.email);
  await user.type(screen.getByLabelText('Senha'), password);
  await user.click(screen.getByRole('button', { name: /entrar/i }));
}

/** Atalhos de API para o "outro lado" da conversa (analista, outra aba), usados nos testes. */
export const apiAs = (h: Harness, token: string) => ({
  get: (path: string) => request(h.app).get(path).set(bearer(token)),
  post: (path: string, body: unknown = {}) => request(h.app).post(path).set(bearer(token)).send(body),
  analystSays: (conversationId: string, content: string) =>
    request(h.app).post(`/api/console/conversations/${conversationId}/messages`).set(bearer(token)).send({ content, clientMessageId: randomUUID() }),
});

export const messageList = () => screen.getByRole('main');
export { screen, within };

export const proposal = (overrides: Record<string, unknown> = {}) => ({
  intent: 'ASK_QUESTION',
  understanding: 'Pergunta de TI.',
  action: 'REPLY',
  confidence: 0.9,
  rationale: 'Resposta direta.',
  reply: 'Certo!',
  ...overrides,
});
