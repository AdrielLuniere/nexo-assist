// @vitest-environment jsdom
import { call, submit } from '@nexo/agent/testing';
import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ANA, MARCOS } from '../../../../tests/helpers/api-harness';
import { apiAs, proposal, screen, signIn, startApp, within } from '../test/app-harness';

const providerDown = () => ({ fail: Object.assign(new Error('503 Service Unavailable'), { statusCode: 503 }) });

const SHOW_OVERDUE = [
  call('listMyTickets', { onlyOpen: true }),
  submit(
    proposal({
      intent: 'CHECK_TICKET_STATUS',
      action: 'SHOW_TICKETS',
      understanding: 'Quer saber como estão os chamados abertos.',
      rationale: 'A consulta mostrou o INC-20311 aguardando analista e vencido.',
      reply: 'O INC-20311 está aguardando analista e com o prazo vencido.',
      showTickets: ['INC-20311'],
      ruleRefs: ['A.PRIORIDADE_PRAZO'],
      confidence: 0.92,
    }),
  ),
];

const DRAFT = [
  call('proposeTicketDraft', {
    operation: 'CREATE',
    type: 'INC',
    category: 'HARDWARE',
    title: 'Mouse sem fio parou de funcionar',
    description: 'O mouse sem fio parou de responder hoje cedo; já troquei as pilhas.',
    affectedScope: 'INDIVIDUAL',
    affectedDescription: 'Somente Ana Souza',
    urgency: 'HAS_WORKAROUND',
  }),
  submit(proposal({ intent: 'OPEN_TICKET', action: 'PROPOSE_TICKET_DRAFT', reply: 'Preparei o chamado; confira antes de eu criar.' })),
];

async function openChatAndSend(user: Awaited<ReturnType<typeof startApp>>['user'], text: string) {
  await signIn(user, ANA);
  await user.click((await screen.findAllByRole('button', { name: /nova conversa/i }))[0] as HTMLElement);
  const box = await screen.findByLabelText('Mensagem');
  await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
  await user.type(box, `${text}{Enter}`);
}

describe('chat do funcionário', () => {
  it('nova conversa: o campo fica bloqueado até a nova abrir, e a mensagem nunca vai para a conversa antiga', async () => {
    const { user, h } = await startApp({ agentScript: [submit(proposal({ reply: 'Oi!' })), submit(proposal({ reply: 'Na conversa nova.' }))] });
    await openChatAndSend(user, 'Primeira conversa');
    await screen.findByText('Oi!');
    const before = (await apiAs(h, await h.login(ANA)).get('/api/conversations')).body.items as Array<{ id: string }>;

    await user.click(screen.getAllByRole('button', { name: /nova conversa/i })[0] as HTMLElement);
    expect((screen.getByLabelText('Mensagem') as HTMLTextAreaElement).disabled).toBe(true);
    await waitFor(() => expect((screen.getByLabelText('Mensagem') as HTMLTextAreaElement).disabled).toBe(false));
    await user.type(screen.getByLabelText('Mensagem'), 'Segunda conversa{Enter}');
    expect(await screen.findByText('Na conversa nova.')).toBeTruthy();

    const after = (await apiAs(h, await h.login(ANA)).get('/api/conversations')).body.items as Array<{ id: string }>;
    expect(after).toHaveLength(before.length + 1);
    const oldId = before[0]!.id;
    const old = (await apiAs(h, await h.login(ANA)).get(`/api/conversations/${oldId}`)).body.conversation.messages as Array<{ content: string }>;
    expect(old.map((m) => m.content)).not.toContain('Segunda conversa');
  });

  it('envia, mostra as ações executadas acima da resposta e o card do chamado vencido', async () => {
    const { user } = await startApp({ agentScript: SHOW_OVERDUE });
    await openChatAndSend(user, 'Como estão meus chamados?');

    expect(await screen.findByText('O INC-20311 está aguardando analista e com o prazo vencido.')).toBeTruthy();
    const actions = screen.getByRole('list', { name: 'Ações executadas pelo agente' });
    expect(within(actions).getByText(/consultou seus chamados/i)).toBeTruthy();
    const card = screen.getByRole('article', { name: 'Chamado INC-20311' });
    expect(within(card).getByText('Notebook lento após atualização do Windows')).toBeTruthy();
    expect(within(card).getByText(/prazo vencido/)).toBeTruthy();
    expect(within(card).getByText('Média')).toBeTruthy();
    expect(screen.getByText('1/30 mensagens nesta sessão')).toBeTruthy();
    // A política ofereceu chamar um analista por causa do chamado vencido.
    expect(screen.getByRole('button', { name: 'Chamar um analista' })).toBeTruthy();
  });

  it('o histórico persiste: ao recarregar, a conversa e as decisões voltam', async () => {
    const { user, remount } = await startApp({ agentScript: SHOW_OVERDUE });
    await openChatAndSend(user, 'Como estão meus chamados?');
    await screen.findByText('O INC-20311 está aguardando analista e com o prazo vencido.');

    remount();
    expect(await screen.findByText('O INC-20311 está aguardando analista e com o prazo vencido.')).toBeTruthy();
    expect(within(screen.getByRole('main')).getByText('Como estão meus chamados?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ver detalhes da decisão' })).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Ações executadas pelo agente' });
    expect(within(list).getByText(/consultou seus chamados/i)).toBeTruthy();
  });

  it('painel da decisão mostra o registro gravado: entendimento, intenção, ação, confiança, justificativa, regras e ferramentas', async () => {
    const { user } = await startApp({ agentScript: SHOW_OVERDUE });
    await openChatAndSend(user, 'Como estão meus chamados?');
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes da decisão' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Quer saber como estão os chamados abertos.')).toBeTruthy();
    expect(within(dialog).getByText('Consultar um chamado')).toBeTruthy();
    expect(within(dialog).getAllByText('Mostrou seus chamados').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('0,92 · Alta')).toBeTruthy();
    expect(within(dialog).getByRole('meter', { name: 'Grau de confiança' }).getAttribute('aria-valuenow')).toBe('0.92');
    expect(within(dialog).getByText(/A consulta mostrou o INC-20311/)).toBeTruthy();
    expect(within(dialog).getByText('A.PRIORIDADE_PRAZO')).toBeTruthy();
    expect(within(dialog).getByText('Prioridade e prazo')).toBeTruthy();
    expect(within(dialog).getByText(/consultou seus chamados/i)).toBeTruthy();
    expect(within(dialog).getByText(/teste\/roteirizado/)).toBeTruthy();
    expect(within(dialog).getByText(/Não inclui raciocínio interno do modelo/)).toBeTruthy();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('rascunho: confirmar cria o chamado, e o estado se mantém ao recarregar', async () => {
    const { user, remount } = await startApp({ agentScript: DRAFT });
    await openChatAndSend(user, 'Meu mouse sem fio parou, mas estou usando o touchpad');

    const draft = await screen.findByRole('article', { name: 'Novo chamado: Mouse sem fio parou de funcionar' });
    expect(within(draft).getByText('Aguardando confirmação')).toBeTruthy();
    expect(within(draft).getByText('Hardware')).toBeTruthy();
    expect(within(draft).getByText(/resposta em até 3 dias úteis/)).toBeTruthy();
    await user.click(within(draft).getByRole('button', { name: 'Confirmar' }));

    expect(await screen.findByText(/Pronto! Abri o chamado INC-\d+/)).toBeTruthy();
    await waitFor(() => expect(within(draft).queryByRole('button', { name: 'Confirmar' })).toBeNull());
    expect(within(draft).getByText(/Confirmado · INC-\d+/)).toBeTruthy();

    remount();
    const reloaded = await screen.findByRole('article', { name: 'Novo chamado: Mouse sem fio parou de funcionar' });
    expect(within(reloaded).getByText(/Confirmado · INC-\d+/)).toBeTruthy();
    expect(within(reloaded).queryByRole('button', { name: 'Confirmar' })).toBeNull();
  });

  it('rascunho descartado não oferece mais as ações', async () => {
    const { user } = await startApp({ agentScript: DRAFT });
    await openChatAndSend(user, 'Meu mouse sem fio parou');
    const draft = await screen.findByRole('article', { name: /Novo chamado/ });
    await user.click(within(draft).getByRole('button', { name: 'Descartar' }));
    expect(await within(draft).findByText('Descartado')).toBeTruthy();
    expect(within(draft).queryByRole('button', { name: 'Confirmar' })).toBeNull();
  });

  it('seleção de chamado e resposta rápida enviam a escolha como mensagem', async () => {
    const { user, h } = await startApp({
      agentScript: [
        call('listMyTickets', { onlyOpen: false }),
        submit(
          proposal({
            intent: 'CHECK_TICKET_STATUS',
            action: 'ASK_TICKET_SELECTION',
            reply: 'Você tem chamados abertos. Sobre qual deles quer saber?',
            ticketSelection: { prompt: 'Sobre qual deles quer saber?', ticketCodes: ['INC-20311', 'INC-20150'] },
          }),
        ),
        submit(proposal({ reply: 'Certo, falando do INC-20311.', quickReplies: [{ label: 'Adicionar informação', value: 'Quero adicionar uma informação' }] })),
        submit(proposal({ reply: 'Pode mandar.' })),
      ],
    });
    await openChatAndSend(user, 'Qual o status do meu chamado?');

    const option = await screen.findByRole('radio', { name: /INC-20311/ });
    await user.click(option);
    expect(await screen.findByText('INC-20311 · Notebook lento após atualização do Windows')).toBeTruthy();
    expect(await screen.findByText('Certo, falando do INC-20311.')).toBeTruthy();
    // a seleção antiga não aceita outra escolha
    expect((screen.getByRole('radio', { name: /INC-20150/ }) as HTMLInputElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Adicionar informação' }));
    expect(await screen.findByText('Pode mandar.')).toBeTruthy();
    expect(h.modelCalls.length).toBe(4);
  });

  it('pede um analista direto, sem chamar o modelo, e pausa o assistente', async () => {
    const { user, h } = await startApp({ agentScript: [submit(proposal({ reply: 'Oi! Em que posso ajudar?' }))] });
    await openChatAndSend(user, 'Oi');
    await screen.findByText('Oi! Em que posso ajudar?');
    const callsBefore = h.modelCalls.length;

    await user.click(screen.getByRole('button', { name: /falar com um analista/i }));
    expect(await screen.findByText(/um analista vai assumir esta conversa e já recebe um resumo/)).toBeTruthy();
    expect(screen.getByText('Aguardando atendente')).toBeTruthy();
    expect(screen.getByText(/O assistente está pausado/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /falar com um analista/i })).toBeNull();
    expect(h.modelCalls.length).toBe(callsBefore);

    const queue = await apiAs(h, await h.login(MARCOS)).get('/api/console/conversations');
    expect(queue.body.items[0].activeHandoff).toMatchObject({ reason: 'EMPLOYEE_REQUEST' });
  });

  it('tempo real: mensagens do analista e mudanças de estado chegam sem recarregar, sem duplicar', async () => {
    const { user, h } = await startApp({ agentScript: [submit(proposal({ reply: 'Oi!' }))] });
    await openChatAndSend(user, 'Oi');
    await screen.findByText('Oi!');
    await user.click(screen.getByRole('button', { name: /falar com um analista/i }));
    await screen.findByText('Aguardando atendente');

    const marcos = apiAs(h, await h.login(MARCOS));
    const id = (await marcos.get('/api/console/conversations')).body.items[0].id as string;
    await marcos.post(`/api/console/conversations/${id}/assume`, { expectedVersion: 1 });
    expect(await screen.findByText('Com um analista')).toBeTruthy();
    await marcos.analystSays(id, 'Olá Ana, sou do suporte.');
    expect(await screen.findByText('Olá Ana, sou do suporte.')).toBeTruthy();
    expect(screen.getByText('Analista do suporte')).toBeTruthy();

    await marcos.post(`/api/console/conversations/${id}/return`, { expectedVersion: 2 });
    expect(await screen.findByText('Com o assistente')).toBeTruthy();
    expect(screen.getAllByText('Olá Ana, sou do suporte.')).toHaveLength(1);
  });

  it('o aviso verde do pedido de analista some quando a conversa volta ao agente (e nada do histórico se perde)', async () => {
    const { user, h } = await startApp({ agentScript: [submit(proposal({ reply: 'Oi!' }))] });
    await openChatAndSend(user, 'Oi');
    await screen.findByText('Oi!');
    await user.click(screen.getByRole('button', { name: /falar com um analista/i }));
    expect(await screen.findByText(/um analista vai assumir esta conversa/)).toBeTruthy();

    const marcos = apiAs(h, await h.login(MARCOS));
    const id = (await marcos.get('/api/console/conversations')).body.items[0].id as string;
    await marcos.post(`/api/console/conversations/${id}/assume`, { expectedVersion: 1 });
    await screen.findByText('Com um analista');
    expect(screen.queryByText(/um analista vai assumir esta conversa/)).toBeTruthy(); // ainda com a equipe: o aviso vale
    await marcos.analystSays(id, 'Resolvido por aqui.');
    await marcos.post(`/api/console/conversations/${id}/return`, { expectedVersion: 2 });

    expect(await screen.findByText('Com o assistente')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/um analista vai assumir esta conversa/)).toBeNull());
    expect(screen.getByText('Resolvido por aqui.')).toBeTruthy(); // histórico preservado
  });

  it('reconexão: a conexão cai, o que chegou no meio aparece uma única vez', async () => {
    const { user, h } = await startApp({ agentScript: [submit(proposal({ reply: 'Oi!' }))], timings: { retryDelays: [400, 400] } });
    await openChatAndSend(user, 'Oi');
    await screen.findByText('Oi!');
    await user.click(screen.getByRole('button', { name: /falar com um analista/i }));
    const marcos = apiAs(h, await h.login(MARCOS));
    const id = (await marcos.get('/api/console/conversations')).body.items[0].id as string;
    await marcos.post(`/api/console/conversations/${id}/assume`, { expectedVersion: 1 });
    await marcos.analystSays(id, 'Primeira');
    await screen.findByText('Primeira');

    h.events.shutdown(); // o servidor derruba as conexões
    expect(await screen.findByText('Reconectando…')).toBeTruthy();
    await marcos.analystSays(id, 'Enviada enquanto você estava desconectada');
    expect(await screen.findByText('Enviada enquanto você estava desconectada', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getAllByText('Primeira')).toHaveLength(1);
    await waitFor(() => expect(screen.queryByText('Reconectando…')).toBeNull());
  });

  it('falha do provedor: mostra o erro, a mensagem fica gravada e "Tentar de novo" recupera a resposta', async () => {
    const { user } = await startApp({ agentScript: [providerDown(), providerDown(), submit(proposal({ reply: 'Agora respondi.' }))] });
    await openChatAndSend(user, 'Minha VPN caiu');
    const alert = await screen.findByRole('alert', {}, { timeout: 8000 });
    expect(alert.textContent).toContain('Não consegui responder agora');
    expect(within(screen.getByRole('main')).getByText('Minha VPN caiu')).toBeTruthy();
    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Agora respondi.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  }, 20_000);

  it('resposta pendente é retomada sozinha ao reabrir a conversa', async () => {
    const { user, remount } = await startApp({ agentScript: [providerDown(), providerDown(), submit(proposal({ reply: 'Retomei a sua resposta.' }))] });
    await openChatAndSend(user, 'Preciso de ajuda com o Outlook');
    await screen.findByRole('alert', {}, { timeout: 8000 });

    remount();
    expect(await screen.findByText('Retomei a sua resposta.')).toBeTruthy();
    expect(within(screen.getByRole('main')).getAllByText('Preciso de ajuda com o Outlook')).toHaveLength(1);
  }, 20_000);

  it('limite de mensagens: a recusa do servidor aparece e nada some da tela', async () => {
    const { user } = await startApp({ messageLimit: 1, agentScript: [submit(proposal({ reply: 'Oi!' }))] });
    await openChatAndSend(user, 'Oi');
    await screen.findByText('Oi!');
    await user.type(screen.getByLabelText('Mensagem'), 'Mais uma{Enter}');
    expect((await screen.findByRole('alert')).textContent).toContain('Limite de 1 mensagens por sessão atingido');
    expect(screen.queryByText('Mais uma')).toBeNull();
    expect(screen.getByText('Oi!')).toBeTruthy();
  });

  it('conversa encerrada não aceita mensagem e oferece nova conversa', async () => {
    const { user, h } = await startApp({ agentScript: [submit(proposal({ reply: 'Oi!' }))] });
    await openChatAndSend(user, 'Oi');
    await screen.findByText('Oi!');
    await user.click(screen.getByRole('button', { name: /falar com um analista/i }));
    await screen.findByText('Aguardando atendente');
    const marcos = apiAs(h, await h.login(MARCOS));
    const id = (await marcos.get('/api/console/conversations')).body.items[0].id as string;
    await marcos.post(`/api/console/conversations/${id}/close`, { expectedVersion: 1 });

    expect(await screen.findByText(/Este atendimento foi encerrado/)).toBeTruthy();
    expect(screen.queryByLabelText('Mensagem')).toBeNull();
    expect(screen.getAllByRole('button', { name: /nova conversa/i }).length).toBeGreaterThan(1);
  });
});
