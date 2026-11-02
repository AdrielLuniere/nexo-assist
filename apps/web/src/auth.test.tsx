// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ANA, MARCOS } from '../../../tests/helpers/api-harness';
import { App } from './App';
import { screen, signIn, startApp } from './test/app-harness';

describe('login', () => {
  it('funcionário entra e vai para o atendimento', async () => {
    const { user } = await startApp();
    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeTruthy();
    await signIn(user, ANA);
    expect(await screen.findByRole('button', { name: /nova conversa/i, hidden: false })).toBeTruthy();
    expect(screen.getAllByText('Ana Souza').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Atendimento' }).getAttribute('aria-current')).toBe('page');
  });

  it('analista entra e vai para o console', async () => {
    const { user } = await startApp();
    await signIn(user, MARCOS);
    expect(await screen.findByRole('heading', { name: 'Conversas' })).toBeTruthy();
    expect(screen.getByText('Suporte N1')).toBeTruthy();
  });

  it('credenciais inválidas: mensagem clara e continua no login', async () => {
    const { user } = await startApp();
    await signIn(user, { email: 'ninguem@nexo.com.br' });
    expect((await screen.findByRole('alert')).textContent).toContain('E-mail ou senha inválidos.');
    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeTruthy();
  });

  it('mostra carregamento durante o envio e não aceita formulário vazio', async () => {
    const { user } = await startApp();
    const submit = screen.getByRole('button', { name: /entrar/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('E-mail corporativo'), ANA.email);
    await user.type(screen.getByLabelText('Senha'), 'x');
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it('sem conexão com a API: avisa sem travar a tela', async () => {
    const view = render(<App baseUrl="http://127.0.0.1:1" />);
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    await signIn(user, ANA);
    expect((await screen.findByRole('alert')).textContent).toContain('Sem conexão com o servidor');
    view.unmount();
  });

  it('a sessão sobrevive a recarregar a página (papel relido da API) e sair volta ao login', async () => {
    const { user, remount } = await startApp();
    await signIn(user, ANA);
    await screen.findByRole('button', { name: 'Atendimento' });
    remount();
    expect(await screen.findByRole('button', { name: 'Atendimento' })).toBeTruthy();
    await user.click(screen.getAllByRole('button', { name: 'Sair' })[0] as HTMLElement);
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeTruthy();
    expect(screen.queryByText(/sessão expirou/)).toBeNull();
  });

  it('sessão expirada: volta ao login com aviso', async () => {
    const { h, user, remount } = await startApp({ sessionTtlSeconds: 60 });
    await signIn(user, ANA);
    await screen.findByRole('button', { name: 'Atendimento' });
    h.clock.current = new Date(h.clock.current.getTime() + 2 * 60_000); // token vencido para a API
    remount();
    expect(await screen.findByText('Sua sessão expirou. Entre novamente para continuar.')).toBeTruthy();
  });

  it('sessão recusada pela API no meio do uso também leva ao login', async () => {
    const { h, user } = await startApp({ sessionTtlSeconds: 3600 });
    await signIn(user, ANA);
    await screen.findByRole('button', { name: 'Atendimento' });
    // A API passa a recusar o token (ex.: segredo trocado, usuário removido): o próximo pedido dá 401.
    h.clock.current = new Date(h.clock.current.getTime() + 2 * 3600_000);
    await user.click(screen.getAllByRole('button', { name: /nova conversa/i })[0] as HTMLElement);
    expect(await screen.findByText('Sua sessão expirou. Entre novamente para continuar.')).toBeTruthy();
  });
});
