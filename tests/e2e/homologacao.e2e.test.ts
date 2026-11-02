import { call, submit } from '@nexo/agent/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type Page } from './browser.js';
import { type Stack, startStack } from './stack.js';

/**
 * Homologação no NAVEGADOR REAL (Chrome/Edge) contra a pilha completa: web real, API real, regras e
 * Mastra reais, PostgreSQL descartável com migrations e seed reais. Só o modelo de linguagem é
 * roteirizado (sem custo). Cada teste é um cenário do roteiro de homologação (docs/homologacao.md).
 * Roda com `npm run test:e2e` (exige `npm run db:up`).
 */

const ANA = 'ana.souza@nexo.com.br';
const BRUNO = 'bruno.lima@nexo.com.br';
const MARCOS = 'marcos.oliveira@nexo.com.br';
const PAULA = 'paula.santos@nexo.com.br';

const proposal = (o: Record<string, unknown> = {}) => ({
  intent: 'ASK_QUESTION',
  understanding: 'Pergunta de TI.',
  action: 'REPLY',
  confidence: 0.9,
  rationale: 'Resposta direta.',
  reply: 'Certo!',
  ...o,
});
/** Falha do provedor. O agente tenta 2 vezes por resposta e a tela retoma 1 vez sozinha: 4 falhas = 1 resposta perdida de verdade. */
const providerDown = () => ({ fail: Object.assign(new Error('503 Service Unavailable'), { statusCode: 503 }) });
const modelOutage = () => [providerDown(), providerDown(), providerDown(), providerDown()];

let stack: Stack;
const pages: Page[] = [];
const OUT = process.env.E2E_OUT ?? 'test-results/e2e';

beforeAll(async () => {
  stack = await startStack();
}, 180_000);

// Cada cenário fecha as suas páginas: evita dezenas de abas abertas e conexões SSE penduradas.
afterEach(async () => {
  for (const page of pages.splice(0)) await page.close().catch(() => undefined);
});

afterAll(async () => {
  await stack?.stop();
}, 60_000);

async function open(email: string, size: { width?: number; height?: number } = {}): Promise<Page> {
  const page = await stack.browser.newPage(size);
  pages.push(page);
  await page.goto(stack.webUrl);
  await page.fill('E-mail corporativo', email);
  await page.fill('Senha', 'qualquer');
  await page.click('Entrar');
  return page;
}

/** A área do funcionário carregou (o texto "Atendimento" também existe na tela de login). */
const waitEmployeeHome = (page: Page) => page.waitFor(`!!document.querySelector('nav[aria-label="Você está em"]')`, 'área do funcionário');

/** Funcionária logada com uma conversa nova, pronta para escrever. */
async function employee(email = ANA, size: { width?: number; height?: number } = {}): Promise<Page> {
  const page = await open(email, size);
  await waitEmployeeHome(page);
  if (await page.exists('Abrir menu')) await page.click('Abrir menu'); // celular: a barra lateral é uma gaveta
  await page.click('Nova conversa');
  await page.waitFor(`(() => { const t = document.querySelector('textarea'); return !!t && !t.disabled; })()`, 'campo de mensagem habilitado');
  return page;
}

async function say(page: Page, text: string) {
  await page.fill('Mensagem', text);
  await page.press('Enter');
}

/** Espera o modelo roteirizado receber `n` chamadas (a retomada automática da tela também conta). */
async function waitModelCalls(n: number, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (stack.modelCalls() < n) {
    if (Date.now() > deadline) throw new Error(`o modelo recebeu ${stack.modelCalls()} chamadas; esperava ${n}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function ticketCount(requesterId = 'usr_ana_souza') {
  return stack.prisma.ticket.count({ where: { requesterId } });
}

const DRAFT_VPN = [
  call('proposeTicketDraft', {
    operation: 'CREATE',
    type: 'INC',
    category: 'NETWORK_VPN',
    title: 'VPN não conecta no notebook, erro 809',
    description: 'Desde ontem o notebook (Windows 11) não conecta na VPN e mostra o erro 809. Reunião com cliente às 14h.',
    affectedScope: 'INDIVIDUAL',
    affectedDescription: 'Somente Ana Souza',
    urgency: 'SAME_DAY_DEADLINE',
  }),
  submit(proposal({ intent: 'OPEN_TICKET', action: 'PROPOSE_TICKET_DRAFT', understanding: 'VPN com erro 809 no Windows 11 e reunião às 14h.', rationale: 'Afeta uma pessoa com compromisso hoje: prioridade Alta.', reply: 'Preparei o chamado com prioridade Alta. Confira antes de eu criar.', ruleRefs: ['A.ABERTURA', 'A.PRIORIDADE_PRAZO'] })),
];

/**
 * Rascunho de abertura. Cada teste que cria ou rascunha usa um assunto próprio: a regra de duplicidade
 * é real e recusa um chamado parecido com outro que já está aberto.
 */
const draftScript = (title: string, description: string, category: 'SOFTWARE' | 'OTHER', reply = 'Preparei o chamado. Confira antes de eu criar.') => [
  call('proposeTicketDraft', { operation: 'CREATE', type: 'INC', category, title, description, affectedScope: 'INDIVIDUAL', affectedDescription: 'Somente Ana Souza', urgency: 'HAS_WORKAROUND' }),
  submit(proposal({ intent: 'OPEN_TICKET', action: 'PROPOSE_TICKET_DRAFT', understanding: title, rationale: 'Afeta uma pessoa e há alternativa: prioridade Média.', reply })),
];

describe('H1 login', () => {
  it('funcionário entra e cai no atendimento; credencial desconhecida é recusada com mensagem clara', async () => {
    stack.scenario({ script: [] });
    const bad = await stack.browser.newPage();
    pages.push(bad);
    await bad.goto(stack.webUrl);
    await bad.fill('E-mail corporativo', 'ninguem@nexo.com.br');
    await bad.fill('Senha', 'x');
    await bad.click('Entrar');
    await bad.waitText('E-mail ou senha inválidos.');

    const page = await open(ANA);
    await waitEmployeeHome(page);
    expect(await page.hasText('Ana Souza')).toBe(true);
    expect(page.errors).toEqual([]);
  });

  it('analista entra e cai no console', async () => {
    const page = await open(MARCOS);
    await page.waitText('Suporte N1');
    await page.waitFor(`!!document.querySelector('input[type=search]')`, 'campo de busca da fila');
  });
});

describe('H2 dúvida pela central de ajuda', () => {
  it('responde com o artigo, mostra a ferramenta usada e a decisão persistida; sobrevive ao recarregar', async () => {
    stack.scenario({
      script: [
        call('searchHelpCenter', { query: 'vpn erro 809' }),
        submit(proposal({ intent: 'ASK_QUESTION', action: 'ANSWER_FROM_HELP_CENTER', understanding: 'Erro 809 na VPN com Windows 10.', rationale: 'O artigo "VPN com erro 809" cobre o caso (Windows 10).', reply: 'Reinstale o cliente de VPN pelo portal de softwares e reinicie o computador.', confidence: 0.93, ruleRefs: ['A.ABERTURA'] })),
      ],
    });
    const page = await employee();
    const before = await ticketCount();
    await say(page, 'Minha VPN está dando erro 809. Uso Windows 10. O que eu faço?');
    await page.waitText('Reinstale o cliente de VPN');
    expect(await page.hasText('buscou na central de ajuda')).toBe(true);
    expect(await page.exists('Chamar um analista')).toBe(false);
    expect(await ticketCount()).toBe(before); // dúvida não abre chamado

    await page.click('Ver detalhes da decisão');
    await page.waitText('Grau de confiança'); // (o título do painel vem em caixa alta por CSS)
    for (const expected of ['Respondeu com a central de ajuda', 'Erro 809 na VPN com Windows 10.', '0,93 · Alta', 'O artigo "VPN com erro 809" cobre o caso', 'buscou na central de ajuda', 'Não inclui raciocínio interno do modelo']) {
      expect(await page.hasText(expected), expected).toBe(true);
    }
    // O resumo do passo vem do resultado real da ferramenta (artigo do seed), não de texto da interface.
    expect(await page.hasText('VPN com erro 809')).toBe(true);
    await page.press('Escape');

    await page.reload();
    await page.waitText('Reinstale o cliente de VPN');
    expect(await page.hasText('buscou na central de ajuda')).toBe(true);
    await page.click('Ver detalhes da decisão');
    await page.waitText('0,93 · Alta');
    expect(page.errors).toEqual([]);
  });
});

describe('H3 consulta de chamado próprio e vencido', () => {
  it('mostra o chamado, o prazo vencido, a prioridade com SLA e oferece o analista', async () => {
    stack.scenario({
      script: [
        call('listMyTickets', { onlyOpen: true }),
        submit(proposal({ intent: 'CHECK_TICKET_STATUS', action: 'SHOW_TICKETS', understanding: 'Quer saber como estão os chamados abertos.', rationale: 'A consulta mostrou o INC-20311 aguardando analista e vencido.', reply: 'O INC-20311 está aguardando analista e com o prazo vencido.', showTickets: ['INC-20311'], ruleRefs: ['A.PRIORIDADE_PRAZO'], confidence: 0.92 })),
      ],
    });
    const page = await employee();
    await say(page, 'Como está aquele meu chamado do notebook lento?');
    await page.waitText('Notebook lento após atualização do Windows');
    expect(await page.hasText('prazo vencido')).toBe(true);
    expect(await page.hasText('3 dias úteis')).toBe(true); // SLA da prioridade Média (Anexo A)
    expect(await page.hasText('Aguardando analista')).toBe(true);
    expect(await page.exists('Chamar um analista')).toBe(true);
    // Privacidade: nada de chamados de outras pessoas do seed.
    for (const foreign of ['Sem acesso ao CRM', 'Servidor de build', 'Licença do Adobe']) expect(await page.hasText(foreign)).toBe(false);
  });
});

describe('H4 abertura mediante rascunho e confirmação', () => {
  it('rascunho não escreve; confirmar cria uma única vez (duplo clique) com a prioridade calculada; recarregar mantém', async () => {
    stack.scenario({ script: DRAFT_VPN });
    const page = await employee();
    const before = await ticketCount();
    await say(page, 'Meu notebook não conecta na VPN desde ontem, erro 809, Windows 11. Tenho reunião com cliente às 14h.');
    await page.waitText('Aguardando confirmação');
    expect(await page.hasText('VPN não conecta no notebook, erro 809')).toBe(true);
    expect(await page.hasText('Rede e VPN')).toBe(true);
    expect(await page.hasText('resposta em até 4 horas úteis')).toBe(true);
    expect(await ticketCount()).toBe(before); // nada escrito antes da confirmação

    await page.doubleClick('Confirmar');
    await page.waitText('Pronto! Abri o chamado INC-');
    await page.waitFor(`document.body.innerText.includes('Confirmado · INC-')`, 'rascunho confirmado');
    expect(await ticketCount()).toBe(before + 1); // duplo clique não duplica
    const created = await stack.prisma.ticket.findFirstOrThrow({ where: { title: 'VPN não conecta no notebook, erro 809' } });
    expect(created).toMatchObject({ priority: 'HIGH', category: 'NETWORK_VPN', type: 'INC', status: 'WAITING_ANALYST', requesterId: 'usr_ana_souza' });

    await page.reload();
    await page.waitText('Confirmado · INC-');
    expect(await page.exists('Confirmar')).toBe(false);
  });

  it('descartar não cria nada', async () => {
    stack.scenario({ script: draftScript('Excel fecha sozinho ao abrir planilhas grandes', 'O Excel fecha sozinho toda vez que abro planilhas grandes no trabalho.', 'SOFTWARE') });
    const page = await employee();
    const before = await ticketCount();
    await say(page, 'O Excel fecha sozinho quando abro planilhas grandes');
    await page.waitText('Aguardando confirmação');
    await page.click('Descartar');
    await page.waitText('Descartado');
    expect(await page.exists('Confirmar')).toBe(false);
    expect(await ticketCount()).toBe(before);
  });
});

describe('H5 atualização de chamado existente', () => {
  it('registra a informação nova no histórico do chamado aberto, só depois de confirmar', async () => {
    stack.scenario({
      script: [
        call('getMyTicket', { code: 'INC-20311' }),
        call('proposeTicketDraft', { operation: 'UPDATE', ticketCode: 'INC-20311', comment: 'O notebook também trava quando o Excel é aberto.' }),
        submit(proposal({ intent: 'UPDATE_TICKET', action: 'PROPOSE_TICKET_UPDATE', understanding: 'Informação nova sobre o INC-20311.', rationale: 'Chamado aberto da própria funcionária: complemento em vez de novo chamado.', reply: 'Vou registrar isso no INC-20311. Confira.' })),
      ],
    });
    const page = await employee();
    const events = await stack.prisma.ticketEvent.count({ where: { ticket: { code: 'INC-20311' } } });
    await say(page, 'Sobre o INC-20311: o notebook também trava quando abro o Excel.');
    await page.waitText('Atualização de chamado');
    expect(await stack.prisma.ticketEvent.count({ where: { ticket: { code: 'INC-20311' } } })).toBe(events);
    await page.click('Confirmar');
    await page.waitText('Atualizei o chamado INC-20311');
    const added = await stack.prisma.ticketEvent.findFirstOrThrow({ where: { ticket: { code: 'INC-20311' }, comment: { contains: 'Excel' } } });
    expect(added.actorType).toBe('EMPLOYEE');
  });
});

describe('H6 reabertura e janela de sete dias', () => {
  it('reabre o chamado resolvido há 4 dias após confirmar', async () => {
    stack.scenario({
      script: [
        call('getMyTicket', { code: 'INC-20150' }),
        call('proposeTicketDraft', { operation: 'REOPEN', ticketCode: 'INC-20150', reason: 'A senha do SAP bloqueou de novo.' }),
        submit(proposal({ intent: 'REOPEN_TICKET', action: 'PROPOSE_TICKET_REOPEN', rationale: 'Resolvido há 4 dias, dentro da janela de 7 dias.', reply: 'Posso reabrir o INC-20150. Confira.', ruleRefs: ['A.REABERTURA'] })),
      ],
    });
    const page = await employee();
    await say(page, 'A senha do SAP bloqueou de novo, mesmo problema do INC-20150.');
    await page.waitText('Reabertura de chamado');
    expect((await stack.prisma.ticket.findUniqueOrThrow({ where: { code: 'INC-20150' } })).status).toBe('RESOLVED');
    await page.click('Confirmar');
    await page.waitText('Reabri o chamado INC-20150');
    expect((await stack.prisma.ticket.findUniqueOrThrow({ where: { code: 'INC-20150' } })).status).not.toBe('RESOLVED');
  });

  it('não reabre o chamado resolvido há 12 dias: sem rascunho, e o chamado continua resolvido', async () => {
    stack.scenario({
      script: [
        call('getMyTicket', { code: 'INC-19980' }),
        call('proposeTicketDraft', { operation: 'REOPEN', ticketCode: 'INC-19980', reason: 'A VPN voltou a cair.' }),
        submit(proposal({ intent: 'REOPEN_TICKET', action: 'ASK_CLARIFICATION', understanding: 'Quer reabrir o INC-19980.', rationale: 'Resolvido há 12 dias: fora da janela de 7 dias.', reply: 'O INC-19980 foi resolvido há mais de 7 dias e não pode ser reaberto. Posso abrir um chamado novo?', confidence: 0.85 })),
      ],
    });
    const page = await employee();
    await say(page, 'A VPN voltou a cair toda hora. Reabre o INC-19980?');
    await page.waitText('não pode ser reaberto');
    expect(await page.exists('Confirmar')).toBe(false);
    expect(await page.hasText('Reabertura de chamado')).toBe(false);
    expect((await stack.prisma.ticket.findUniqueOrThrow({ where: { code: 'INC-19980' } })).status).toBe('RESOLVED');
  });
});

describe('H7 prevenção de duplicidade', () => {
  it('chamado aberto parecido: a abertura é recusada e o agente propõe atualizar o existente', async () => {
    stack.scenario({
      script: [
        call('proposeTicketDraft', { operation: 'CREATE', type: 'INC', category: 'HARDWARE', title: 'Notebook lento depois da atualização do Windows', description: 'O notebook continua muito lento depois da atualização do Windows.', affectedScope: 'INDIVIDUAL', affectedDescription: 'Somente Ana Souza', urgency: 'HAS_WORKAROUND' }),
        call('proposeTicketDraft', { operation: 'UPDATE', ticketCode: 'INC-20311', comment: 'O notebook continua muito lento depois da atualização do Windows.' }),
        submit(proposal({ intent: 'UPDATE_TICKET', action: 'PROPOSE_TICKET_UPDATE', understanding: 'Mesmo problema do INC-20311.', rationale: 'Já existe o INC-20311 aberto sobre o mesmo problema; pela regra de duplicidade, atualizo em vez de abrir outro.', reply: 'Você já tem o INC-20311 aberto sobre isso. Quer que eu registre esta informação nele?', ruleRefs: ['A.DUPLICIDADE'] })),
      ],
    });
    const page = await employee();
    const before = await ticketCount();
    await say(page, 'Meu notebook continua muito lento depois da atualização do Windows.');
    await page.waitText('Atualização de chamado');
    expect(await page.hasText('Novo chamado')).toBe(false);
    expect(await ticketCount()).toBe(before);
    await page.click('Ver detalhes da decisão');
    await page.waitText('Sem chamados duplicados');
    expect(await page.hasText('possível duplicidade com INC-20311')).toBe(true); // resultado real da ferramenta
  });
});

describe('H8 solicitação direta de analista e atendimento humano', () => {
  it('pedido direto, sem o modelo; analista assume, responde, devolve; funcionária acompanha em tempo real', async () => {
    stack.scenario({ script: [submit(proposal({ reply: 'Oi! Em que posso ajudar?' })), submit(proposal({ reply: 'Que bom que resolveu! Algo mais?', understanding: 'Agradecimento.', rationale: 'Conversa encerrada pelo analista; retomo o atendimento.' }))] });
    const ana = await employee();
    await say(ana, 'Oi, meu notebook está estranho');
    await ana.waitText('Oi! Em que posso ajudar?');
    const callsBefore = stack.modelCalls();

    await ana.click('Falar com um analista');
    await ana.waitText('Aguardando atendente');
    await ana.waitText('O assistente está pausado');
    expect(stack.modelCalls()).toBe(callsBefore); // sem LLM

    const marcos = await open(MARCOS);
    await marcos.waitText('Ana Souza');
    await marcos.click('Ana Souza');
    await marcos.waitText('Ana espera um atendente');
    expect(await marcos.hasText('pediu para falar com um analista')).toBe(true); // resumo da transferência
    expect(await marcos.hasText('INC-20311')).toBe(true); // chamados da funcionária
    expect(await marcos.hasText('Sem acesso ao CRM')).toBe(false); // e só dela

    await marcos.click('Assumir atendimento');
    await marcos.waitText('Você assumiu a conversa');
    await ana.waitText('Com um analista'); // mudança de estado em tempo real
    await say(marcos, 'Oi Ana, aqui é o Marcos. Já estou vendo o seu notebook.');
    await ana.waitText('Oi Ana, aqui é o Marcos. Já estou vendo o seu notebook.');
    expect(stack.modelCalls()).toBe(callsBefore); // agente pausado de fato

    await say(ana, 'Obrigada! Pode acessar agora.');
    await marcos.waitText('Obrigada! Pode acessar agora.', 20_000); // o console atualiza a cada poucos segundos
    await marcos.click('Devolver ao agente');
    await marcos.waitText('Conversa devolvida ao agente.');
    await ana.waitText('Com o assistente');
    await say(ana, 'Resolveu, obrigada!');
    await ana.waitText('Que bom que resolveu!');
    expect(stack.modelCalls()).toBe(callsBefore + 1); // o agente voltou a responder
    expect(ana.errors).toEqual([]);
    expect(marcos.errors).toEqual([]);
  }, 120_000);

  it('N2 assume e encerra o atendimento; a funcionária vê o encerramento e não pode mais escrever', async () => {
    stack.scenario({ script: [submit(proposal({ reply: 'Olá!' }))] });
    const ana = await employee();
    await say(ana, 'Preciso de ajuda');
    await ana.waitText('Olá!');
    await ana.click('Falar com um analista');
    await ana.waitText('Aguardando atendente');

    const paula = await open(PAULA);
    await paula.waitText('Suporte N2');
    await paula.click('Ana Souza');
    await paula.click('Assumir atendimento');
    await paula.waitText('Você assumiu a conversa');
    await paula.click('Encerrar atendimento');
    await paula.click('Confirmar encerramento');
    await paula.waitText('Atendimento encerrado.');
    await ana.waitText('Este atendimento foi encerrado');
    expect(await ana.exists('Enviar')).toBe(false);
    expect(await ana.exists('Nova conversa')).toBe(true);
  }, 90_000);

  it('conflito: dois analistas assumem a mesma conversa; só um vence e o outro é avisado', async () => {
    stack.scenario({ script: [submit(proposal({ reply: 'Olá!' }))] });
    const ana = await employee();
    await say(ana, 'Preciso de um analista');
    await ana.waitText('Olá!');
    await ana.click('Falar com um analista');
    await ana.waitText('Aguardando atendente');

    const marcos = await open(MARCOS);
    const paula = await open(PAULA);
    await marcos.click('Ana Souza');
    await paula.click('Ana Souza');
    await marcos.waitText('Ana espera um atendente');
    await paula.waitText('Ana espera um atendente');
    await marcos.click('Assumir atendimento');
    await marcos.waitText('Você assumiu a conversa');
    await paula.click('Assumir atendimento');
    await paula.waitText('alterada por outra pessoa');
    await paula.waitText('Outro analista está atendendo esta conversa');
    expect(await paula.exists('Enviar')).toBe(false);
  }, 90_000);
});

describe('H9 retomada após recarregar', () => {
  it('a conversa, as decisões e o rascunho voltam; a resposta pendente após falha do modelo é retomada sozinha', async () => {
    stack.scenario({ script: [...modelOutage(), submit(proposal({ reply: 'Retomei a sua resposta.', understanding: 'Ajuda com Outlook.', rationale: 'Resposta retomada após falha temporária do modelo.' }))] });
    const page = await employee();
    await say(page, 'Preciso de ajuda com o Outlook');
    await page.waitText('Não consegui responder agora', 25_000);
    expect(await page.hasText('Preciso de ajuda com o Outlook')).toBe(true); // a mensagem ficou gravada
    // O envio gasta 2 falhas e a tela retoma sozinha uma vez (mais 2). Só então a resposta está de fato pendente.
    await waitModelCalls(4);
    await page.waitText('Tentar de novo');
    await page.reload();
    await page.waitText('Retomei a sua resposta.', 20_000);
    expect(await page.hasText('Preciso de ajuda com o Outlook')).toBe(true);
    await page.click('Ver detalhes da decisão');
    await page.waitText('Resposta retomada após falha temporária do modelo.');
  }, 90_000);
});

describe('H10 resiliência', () => {
  it('modelo indisponível: erro claro e "Tentar de novo" recupera', async () => {
    stack.scenario({ script: [...modelOutage(), submit(proposal({ reply: 'Agora respondi.' }))] });
    const page = await employee();
    await say(page, 'Minha VPN caiu');
    await page.waitText('Não consegui responder agora', 25_000);
    await page.click('Tentar de novo');
    await page.waitText('Agora respondi.', 20_000);
    expect(await page.hasText('Não consegui responder agora')).toBe(false);
  }, 90_000);

  it('queda do sistema de chamados no meio da confirmação: a escrita não duplica', async () => {
    // A 1ª chamada a `create` grava, mas a resposta se perde (o caso perigoso); a retentativa não pode duplicar.
    stack.scenario({
      script: draftScript('Teams não abre depois da atualização', 'O Teams não abre mais depois da atualização de ontem, aparece uma tela branca.', 'SOFTWARE'),
      outages: { outageFor: ({ method, callNumber }) => (method === 'create' && callNumber === 1 ? 'after' : null) },
    });
    const page = await employee();
    const before = await ticketCount();
    await say(page, 'O Teams não abre depois da atualização de ontem, só mostra uma tela branca');
    await page.waitText('Aguardando confirmação');
    await page.click('Confirmar');
    await page.waitText('Pronto! Abri o chamado INC-');
    expect(await ticketCount()).toBe(before + 1);
  });

  it('sistema de chamados fora do ar numa consulta: a falha aparece no passo e o agente avisa, sem inventar dados', async () => {
    stack.scenario({
      script: [
        call('listMyTickets', {}),
        submit(proposal({ intent: 'CHECK_TICKET_STATUS', action: 'REPLY', understanding: 'Quer ver os chamados.', rationale: 'O sistema de chamados não respondeu; não posso afirmar nada sobre eles.', reply: 'Não consegui consultar seus chamados agora. Tente de novo em instantes.', confidence: 0.8 })),
      ],
      outages: { outageFor: ({ method }) => (method === 'listForRequester' ? 'before' : null) },
    });
    const page = await employee();
    await say(page, 'Quais são os meus chamados?');
    await page.waitText('Não consegui consultar seus chamados agora');
    // Nada inventado na conversa (o título de outras conversas na lateral não conta).
    expect(await page.eval<string>(`document.querySelector('main').innerText`)).not.toContain('INC-20311');
    await page.click('Ver detalhes da decisão');
    await page.waitText('falhou');
  });

  it('o mesmo envio repetido não duplica mensagem nem resposta', async () => {
    stack.scenario({ script: [submit(proposal({ reply: 'Única resposta.' }))] });
    const page = await employee();
    await say(page, 'Mensagem enviada uma vez');
    await page.waitText('Única resposta.');
    await page.reload();
    await page.waitText('Única resposta.');
    const text = await page.text();
    expect(text.split('Única resposta.').length - 1).toBe(1);
    expect(text.split('Mensagem enviada uma vez').length - 1).toBeLessThanOrEqual(2); // texto + título da conversa na lista
  });
});

describe('H11 privacidade entre funcionários', () => {
  it('Bruno não vê as conversas nem os chamados da Ana', async () => {
    stack.scenario({
      script: [
        call('getMyTicket', { code: 'INC-20311' }),
        submit(proposal({ intent: 'CHECK_TICKET_STATUS', action: 'REPLY', understanding: 'Quer o status de um chamado que não é dele.', rationale: 'O chamado não é do funcionário; só quem abriu pode ver.', reply: 'Não encontrei esse chamado entre os seus. Por privacidade, só mostro chamados de quem os abriu.', ruleRefs: ['A.PRIVACIDADE'] })),
      ],
    });
    const bruno = await employee(BRUNO);
    await say(bruno, 'Qual o status do INC-20311?');
    await bruno.waitText('Não encontrei esse chamado entre os seus');
    expect(await bruno.hasText('Notebook lento')).toBe(false);
    expect(await bruno.hasText('Ana Souza')).toBe(false);
    await bruno.click('Ver detalhes da decisão');
    await bruno.waitText('Privacidade dos chamados');
  });
});

describe('H12 visual e experiência (desktop, tablet e celular)', () => {
  const SIZES = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'tablet', width: 820, height: 1180 },
    { name: 'celular', width: 390, height: 844 },
  ];

  /** Falhas de layout que impedem a demonstração: rolagem horizontal e controles fora da tela. */
  async function layoutProblems(page: Page, mustBeReachable: string[]): Promise<string[]> {
    const problems: string[] = [];
    const overflow = await page.eval<number>('document.documentElement.scrollWidth - window.innerWidth');
    if (overflow > 1) problems.push(`rolagem horizontal de ${overflow}px`);
    for (const name of mustBeReachable) {
      const ok = await page.eval<boolean>(`(() => { const els = [...document.querySelectorAll('button, textarea, input')].filter(e => ([e.getAttribute('aria-label'), e.innerText, e.placeholder, ...(e.labels ? [...e.labels].map(l => l.innerText) : [])].filter(Boolean).join(' ')).includes(${JSON.stringify(name)}) && (e.offsetWidth || e.offsetHeight)); if (!els.length) return false; return els.some(e => { const r = e.getBoundingClientRect(); return r.right > 0 && r.left < window.innerWidth && r.width > 8; }); })()`);
      if (!ok) problems.push(`controle "${name}" ausente ou fora da tela`);
    }
    return problems;
  }

  for (const size of SIZES) {
    it(`login, chat com rascunho, decisão e console em ${size.name}`, async () => {
      stack.scenario({ script: [...draftScript('Zoom sem áudio nas reuniões', 'O Zoom abre, mas o áudio não funciona em nenhuma reunião desde hoje cedo.', 'OTHER'), submit(proposal({ reply: 'Olá!' }))] });
      const problems: string[] = [];

      const anon = await stack.browser.newPage(size);
      pages.push(anon);
      await anon.goto(stack.webUrl);
      await anon.waitText('Entrar');
      await anon.screenshot(`${OUT}/${size.name}-1-login.png`);
      problems.push(...(await layoutProblems(anon, ['Entrar', 'Senha'])).map((p) => `login: ${p}`));

      const page = await employee(ANA, size);
      await say(page, 'O Zoom abre, mas o áudio não funciona em nenhuma reunião desde hoje cedo.');
      await page.waitText('Aguardando confirmação');
      await page.screenshot(`${OUT}/${size.name}-2-chat-rascunho.png`);
      problems.push(...(await layoutProblems(page, ['Confirmar', 'Descartar', 'Enviar'])).map((p) => `chat: ${p}`));
      await page.click('Ver detalhes da decisão');
      await page.waitText('Grau de confiança'); // (o título do painel vem em caixa alta por CSS)
      await page.screenshot(`${OUT}/${size.name}-3-decisao.png`);
      problems.push(...(await layoutProblems(page, ['Fechar detalhes'])).map((p) => `decisão: ${p}`));
      await page.press('Escape');
      await page.click('Falar com um analista');
      await page.waitText('Aguardando atendente');

      const marcos = await open(MARCOS, size);
      await marcos.waitText('Suporte N1');
      await marcos.screenshot(`${OUT}/${size.name}-4-console-fila.png`);
      await marcos.click('Ana Souza');
      await marcos.waitText('Ana espera um atendente');
      await marcos.screenshot(`${OUT}/${size.name}-5-console-aguardando.png`);
      problems.push(...(await layoutProblems(marcos, ['Assumir atendimento'])).map((p) => `console aguardando: ${p}`));
      await marcos.click('Assumir atendimento');
      await marcos.waitText('Você assumiu a conversa');
      await marcos.screenshot(`${OUT}/${size.name}-6-console-atendendo.png`);
      problems.push(...(await layoutProblems(marcos, ['Devolver ao agente', 'Encerrar atendimento', 'Enviar'])).map((p) => `console atendendo: ${p}`));

      expect(problems).toEqual([]);
      expect(page.errors).toEqual([]);
      expect(marcos.errors).toEqual([]);
    }, 120_000);
  }
});
