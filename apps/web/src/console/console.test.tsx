// @vitest-environment jsdom
import { call, submit } from '@nexo/agent/testing';
import { waitFor } from '@testing-library/react';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ANA, BRUNO, type Harness, MARCOS, PAULA } from '../../../../tests/helpers/api-harness';
import { apiAs, proposal, screen, signIn, startApp, within } from '../test/app-harness';

/** Prepara pela API real: Ana conversa com o agente (que consulta os chamados) e ele transfere. */
async function transferredByAgent(h: Harness) {
  const ana = apiAs(h, await h.login(ANA));
  const id = (await ana.post('/api/conversations')).body.conversation.id as string;
  await ana.post(`/api/conversations/${id}/messages`, { content: 'Meu notebook está parado há 5 dias, quero falar com um analista.', clientMessageId: randomUUID() });
  return { id, ana };
}

const TRANSFER_SCRIPT = [
  call('requestHandoff', { reason: 'OVERDUE_TICKET', summary: 'INC-20311 vencido há dias; Ana pediu um analista.', relatedTicketCode: 'INC-20311' }),
  submit(proposal({ intent: 'TALK_TO_ANALYST', action: 'TRANSFER_TO_ANALYST', understanding: 'Quer falar com um analista sobre o INC-20311.', reply: 'Encaminhei para um analista.', confidence: 0.88 })),
];

async function openQueueItem(user: Awaited<ReturnType<typeof startApp>>['user'], name = 'Ana Souza') {
  const queue = await screen.findByRole('list', { name: 'Conversas' });
  await user.click(await within(queue).findByRole('button', { name: new RegExp(name) }));
}

describe('console do analista', () => {
  it('fila com motivo; conversa com resumo, histórico, decisão do agente e chamados da funcionária', async () => {
    const { h, user } = await startApp({ agentScript: TRANSFER_SCRIPT });
    await transferredByAgent(h);
    await signIn(user, MARCOS);

    const queue = await screen.findByRole('list', { name: 'Conversas' });
    expect(await within(queue).findByText(/Transferida · Chamado vencido · INC-20311/)).toBeTruthy();
    await openQueueItem(user);

    const summary = await screen.findByRole('region', { name: 'Resumo da transferência' });
    expect(within(summary).getByText('INC-20311 vencido há dias; Ana pediu um analista.')).toBeTruthy();
    expect(screen.getByText('Encaminhei para um analista.')).toBeTruthy();
    expect(screen.getByText('Ana espera um atendente')).toBeTruthy();

    const panel = screen.getAllByRole('complementary', { name: 'Chamados de Ana' })[0] as HTMLElement;
    expect(within(panel).getByRole('region', { name: 'Desta conversa' }).textContent).toContain('INC-20311');
    expect(within(panel).getByText('Senha do SAP bloqueada')).toBeTruthy();
    expect(within(panel).queryByText('Sem acesso ao CRM')).toBeNull(); // chamado do Bruno

    await user.click(screen.getByRole('button', { name: 'Ver detalhes da decisão' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Quer falar com um analista sobre o INC-20311.')).toBeTruthy();
    expect(within(dialog).getByText('0,88 · Alta')).toBeTruthy();
  });

  it('assumir, responder, devolver: o funcionário recebe e o estado muda', async () => {
    const { h, user } = await startApp({ agentScript: TRANSFER_SCRIPT });
    const { id, ana } = await transferredByAgent(h);
    await signIn(user, MARCOS);
    await openQueueItem(user);

    await user.click(await screen.findByRole('button', { name: /assumir atendimento/i }));
    expect(await screen.findByText('Você assumiu a conversa. O agente está pausado.')).toBeTruthy();
    expect(await screen.findByText(/Você assumiu · agente pausado/)).toBeTruthy();

    await user.type(screen.getByLabelText('Mensagem para Ana'), 'Oi Ana, já estou vendo o seu notebook.{Enter}');
    expect(await screen.findByText('Oi Ana, já estou vendo o seu notebook.')).toBeTruthy();
    expect(screen.getByText('Você')).toBeTruthy();
    const fromEmployeeSide = await ana.get(`/api/conversations/${id}`);
    expect(fromEmployeeSide.body.conversation.messages.at(-1)).toMatchObject({ role: 'ANALYST', authorId: MARCOS.id, content: 'Oi Ana, já estou vendo o seu notebook.' });

    // Mensagem nova da funcionária aparece sem recarregar (atualização periódica).
    await ana.post(`/api/conversations/${id}/messages`, { content: 'Está ligado, pode acessar.', clientMessageId: randomUUID() });
    expect(await screen.findByText('Está ligado, pode acessar.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /devolver ao agente/i }));
    expect(await screen.findByText('Conversa devolvida ao agente.')).toBeTruthy();
    expect((await ana.get(`/api/conversations/${id}`)).body.conversation.status).toBe('WITH_AGENT');
    expect(screen.queryByLabelText('Mensagem para Ana')).toBeNull();
  });

  it('encerrar pede confirmação e fecha o atendimento', async () => {
    const { h, user } = await startApp({ agentScript: TRANSFER_SCRIPT });
    const { id, ana } = await transferredByAgent(h);
    await signIn(user, PAULA);
    await openQueueItem(user);
    await user.click(await screen.findByRole('button', { name: /assumir atendimento/i }));
    await user.click(await screen.findByRole('button', { name: 'Encerrar atendimento' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar encerramento' }));
    expect(await screen.findByText('Atendimento encerrado.')).toBeTruthy();
    expect((await ana.get(`/api/conversations/${id}`)).body.conversation.status).toBe('CLOSED');
  });

  it('conflito: outro analista assumiu antes; a tela avisa e mostra o estado real', async () => {
    const { h, user } = await startApp({ agentScript: TRANSFER_SCRIPT, timings: { consolePollMs: 60_000 } });
    const { id } = await transferredByAgent(h);
    await signIn(user, MARCOS);
    await openQueueItem(user);
    await screen.findByRole('button', { name: /assumir atendimento/i });

    await apiAs(h, await h.login(PAULA)).post(`/api/console/conversations/${id}/assume`, { expectedVersion: 1 });
    await user.click(screen.getByRole('button', { name: /assumir atendimento/i }));

    expect(await screen.findByText(/alterada por outra pessoa/)).toBeTruthy();
    expect(await screen.findByText(/Outro analista está atendendo esta conversa/)).toBeTruthy();
    expect(screen.queryByLabelText('Mensagem para Ana')).toBeNull();
  });

  it('filtros e busca', async () => {
    const { h, user } = await startApp({ agentScript: [...TRANSFER_SCRIPT, ...TRANSFER_SCRIPT] });
    await transferredByAgent(h);
    const bruno = apiAs(h, await h.login(BRUNO));
    const brunoId = (await bruno.post('/api/conversations')).body.conversation.id as string;
    await bruno.post(`/api/conversations/${brunoId}/messages`, { content: 'Sem acesso ao CRM, quero um analista', clientMessageId: randomUUID() });
    await apiAs(h, await h.login(PAULA)).post(`/api/console/conversations/${brunoId}/assume`, { expectedVersion: 1 });

    await signIn(user, MARCOS);
    const queue = await screen.findByRole('list', { name: 'Conversas' });
    await within(queue).findByText('Bruno Lima');
    await user.click(screen.getByRole('button', { name: 'Aguardando' }));
    await waitFor(() => expect(within(queue).queryByText('Bruno Lima')).toBeNull());
    expect(within(queue).getByText('Ana Souza')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Minhas' }));
    expect(await within(queue).findByText('Nenhuma conversa neste filtro.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Todas' }));
    await user.type(screen.getByLabelText('Pesquisar conversa por funcionário ou título'), 'bruno');
    await waitFor(() => expect(within(queue).queryByText('Ana Souza')).toBeNull());
    expect(within(queue).getByText('Bruno Lima')).toBeTruthy();
    expect(within(queue).getByText('Em atendimento por outro analista')).toBeTruthy();
  });

  it('funcionário não chega ao console: ao entrar vai para o próprio chat', async () => {
    const { user } = await startApp();
    await signIn(user, ANA);
    expect(await screen.findByRole('button', { name: 'Atendimento' })).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Fila de conversas' })).toBeNull();
    expect(screen.queryByRole('button', { name: /assumir atendimento/i })).toBeNull();
  });
});
