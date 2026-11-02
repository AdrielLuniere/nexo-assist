import type { DraftPayload, TicketFields } from '@nexo/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { TicketServiceError } from './errors.js';
import { createTicketService } from './default-ticket-service.js';
import {
  type InMemoryConfirmationGate,
  createInMemoryConfirmationGate,
  createInMemoryTicketStore,
} from './in-memory.js';
import type { TicketRecord } from './store.js';
import type { Clock, TicketService } from './ticket-service.js';

const local = (iso: string) => new Date(`${iso}-03:00`);
const ANA = { employeeId: 'usr_ana' };
const BRUNO = { employeeId: 'usr_bruno' };
const CONVERSATION = 'conv_1';

let nowValue = local('2026-11-02T10:00:00'); // segunda 10h
const clock: Clock = { now: () => nowValue };

function ticket(overrides: Partial<TicketRecord> & Pick<TicketRecord, 'id' | 'code' | 'requesterId'>): TicketRecord {
  return {
    type: 'INC',
    title: 'Chamado de exemplo',
    description: 'Descrição de exemplo do chamado.',
    category: 'HARDWARE',
    priority: 'MEDIUM',
    status: 'WAITING_ANALYST',
    affectedScope: 'INDIVIDUAL',
    affectedDescription: 'Apenas o solicitante',
    slaDueAt: local('2026-11-05T10:00:00'),
    firstResponseAt: null,
    resolvedAt: null,
    closedAt: null,
    originConversationId: null,
    createdAt: local('2026-11-02T09:00:00'),
    updatedAt: local('2026-11-02T09:00:00'),
    ...overrides,
  };
}

const NOTEBOOK = ticket({
  id: 't1',
  code: 'INC-20311',
  requesterId: ANA.employeeId,
  title: 'Notebook lento após atualização do Windows',
  description: 'Depois da última atualização o notebook demora muito para abrir qualquer programa.',
});
const SAP_RESOLVED = ticket({
  id: 't2',
  code: 'INC-20150',
  requesterId: ANA.employeeId,
  title: 'Senha do SAP bloqueada',
  category: 'ACCESS',
  status: 'RESOLVED',
  resolvedAt: local('2026-10-29T10:00:00'), // 4 dias antes
  updatedAt: local('2026-10-29T10:00:00'),
});
const VPN_OLD = ticket({
  id: 't3',
  code: 'INC-19980',
  requesterId: ANA.employeeId,
  title: 'VPN caindo toda hora',
  category: 'NETWORK_VPN',
  status: 'RESOLVED',
  resolvedAt: local('2026-10-21T10:00:00'), // 12 dias antes
  updatedAt: local('2026-10-21T10:00:00'),
});
const BRUNO_TICKET = ticket({
  id: 't4',
  code: 'INC-20344',
  requesterId: BRUNO.employeeId,
  title: 'Sem acesso ao CRM',
  category: 'ACCESS',
  priority: 'HIGH',
});

const NEW_FIELDS: TicketFields = {
  type: 'INC',
  title: 'Outlook não sincroniza e-mails',
  description: 'O Outlook parou de receber novos e-mails desde ontem à tarde.',
  category: 'EMAIL',
  priority: 'HIGH',
  affectedScope: 'INDIVIDUAL',
  affectedDescription: 'Somente o solicitante',
};

const createPayload = (fields: TicketFields = NEW_FIELDS): DraftPayload => ({
  operation: 'CREATE',
  fields,
  priorityAssessment: {
    priority: fields.priority,
    impact: 'Afeta uma pessoa',
    urgency: 'Impede o trabalho',
    rationale: 'Impede uma pessoa de trabalhar: prioridade Alta.',
  },
});

interface Harness {
  service: TicketService;
  gate: InMemoryConfirmationGate;
  confirmDraft(id: string, payload: DraftPayload, who?: { employeeId: string }): void;
  store: ReturnType<typeof createInMemoryTicketStore>;
}

function setup(): Harness {
  const store = createInMemoryTicketStore({
    tickets: [NOTEBOOK, SAP_RESOLVED, VPN_OLD, BRUNO_TICKET],
    sequences: { INC: 20344, REQ: 10442 },
  });
  const gate = createInMemoryConfirmationGate();
  const service = createTicketService({ store, confirmations: gate, clock });
  return {
    service,
    gate,
    store,
    confirmDraft(id, payload, who = ANA) {
      gate.addDraft({ id, employeeId: who.employeeId, conversationId: CONVERSATION, payload, status: 'PENDING' });
      gate.confirm(id);
    },
  };
}

async function errorCodeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TicketServiceError) return error.code;
    throw error;
  }
  throw new Error('esperava TicketServiceError, mas a chamada teve sucesso');
}

function createCommand(draftId: string, fields: TicketFields = NEW_FIELDS) {
  const payload = createPayload(fields);
  if (payload.operation !== 'CREATE') throw new Error('payload inesperado');
  return {
    confirmedDraftId: draftId,
    conversationId: CONVERSATION,
    fields,
    priorityAssessment: payload.priorityAssessment,
  };
}

beforeEach(() => {
  nowValue = local('2026-11-02T10:00:00');
});

describe('consulta', () => {
  it('lista apenas os chamados do solicitante, com vencimento derivado', async () => {
    const { service } = setup();
    nowValue = local('2026-11-06T10:00:00'); // depois do prazo de INC-20311
    const list = await service.listForRequester(ANA);
    expect(list.map((t) => t.code).sort()).toEqual(['INC-19980', 'INC-20150', 'INC-20311']);
    expect(list.find((t) => t.code === 'INC-20311')?.isOverdue).toBe(true);
    expect(list.find((t) => t.code === 'INC-20150')?.isOverdue).toBe(false);
  });

  it('filtra por abertos e por texto sem diferenciar acentos', async () => {
    const { service } = setup();
    expect((await service.listForRequester(ANA, { onlyOpen: true })).map((t) => t.code)).toEqual(['INC-20311']);
    expect((await service.listForRequester(ANA, { text: 'ATUALIZACAO windows' })).map((t) => t.code)).toEqual(['INC-20311']);
    expect(await service.listForRequester(ANA, { text: 'impressora' })).toEqual([]);
  });

  it('devolve o detalhe do próprio chamado', async () => {
    const { service } = setup();
    const detail = await service.getForRequester(ANA, 'INC-20311');
    expect(detail.title).toContain('Notebook lento');
    expect(detail.history).toEqual([]);
  });

  it('isola funcionários: chamado de terceiros é FORBIDDEN e inexistente é NOT_FOUND', async () => {
    const { service } = setup();
    expect(await errorCodeOf(service.getForRequester(ANA, 'INC-20344'))).toBe('FORBIDDEN');
    expect(await errorCodeOf(service.getForRequester(ANA, 'INC-99999'))).toBe('NOT_FOUND');
    expect(await service.listForRequester(BRUNO)).toHaveLength(1);
  });

  it('exige contexto de solicitante e código bem formado', async () => {
    const { service } = setup();
    expect(await errorCodeOf(service.listForRequester({ employeeId: '' }))).toBe('INVALID_INPUT');
    expect(await errorCodeOf(service.getForRequester(ANA, 'abc'))).toBe('INVALID_INPUT');
  });
});

describe('criação', () => {
  it('cria o chamado confirmado, com código sequencial, prazo e histórico', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('d1', createPayload());
    const created = await service.create(ANA, createCommand('d1'));

    expect(created.code).toBe('INC-20345');
    expect(created.status).toBe('WAITING_ANALYST');
    expect(created.priority).toBe('HIGH');
    expect(created.slaDueAt).toBe(local('2026-11-02T14:00:00').toISOString()); // 4h úteis
    expect(created.isOverdue).toBe(false);
    expect(created.history.map((e) => e.type)).toEqual(['CREATED']);
    expect((await service.listForRequester(ANA)).map((t) => t.code)).toContain('INC-20345');
  });

  it('REQ usa a própria sequência', async () => {
    const { service, confirmDraft } = setup();
    const fields: TicketFields = {
      ...NEW_FIELDS,
      type: 'REQ',
      title: 'Licença do Adobe Acrobat',
      description: 'Preciso de uma licença do Adobe Acrobat para editar contratos.',
      category: 'SOFTWARE',
      priority: 'LOW',
    };
    confirmDraft('d1', createPayload(fields));
    expect((await service.create(ANA, createCommand('d1', fields))).code).toBe('REQ-10443');
  });

  it('sem confirmação não escreve nada', async () => {
    const { service, gate } = setup();
    // rascunho existe, mas o funcionário ainda não confirmou
    gate.addDraft({ id: 'd1', employeeId: ANA.employeeId, conversationId: CONVERSATION, payload: createPayload(), status: 'PENDING' });
    expect(await errorCodeOf(service.create(ANA, createCommand('d1')))).toBe('CONFIRMATION_REQUIRED');
    expect(await errorCodeOf(service.create(ANA, createCommand('inexistente')))).toBe('CONFIRMATION_REQUIRED');
    expect(await errorCodeOf(service.create(ANA, { ...createCommand('d1'), confirmedDraftId: '' }))).toBe('CONFIRMATION_REQUIRED');
    expect(await service.listForRequester(ANA)).toHaveLength(3);
  });

  it('rascunho de outro funcionário ou de outra conversa não vale', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('d1', createPayload(), BRUNO);
    expect(await errorCodeOf(service.create(ANA, createCommand('d1')))).toBe('CONFIRMATION_REQUIRED');

    confirmDraft('d2', createPayload());
    expect(
      await errorCodeOf(service.create(ANA, { ...createCommand('d2'), conversationId: 'outra_conversa' })),
    ).toBe('CONFIRMATION_REQUIRED');
  });

  it('o conteúdo escrito precisa ser o que foi confirmado', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('d1', createPayload());
    const tampered = { ...NEW_FIELDS, title: 'Título diferente do confirmado' };
    expect(await errorCodeOf(service.create(ANA, createCommand('d1', tampered)))).toBe('CONFIRMATION_REQUIRED');
  });

  it('valida os campos obrigatórios do Anexo A', async () => {
    const { service, confirmDraft } = setup();
    const bad = { ...NEW_FIELDS, title: 'abc' };
    confirmDraft('d1', createPayload(bad));
    expect(await errorCodeOf(service.create(ANA, createCommand('d1', bad)))).toBe('INVALID_INPUT');
  });

  it('prioridade Crítica para uma pessoa é recusada (Anexo A)', async () => {
    const { service, confirmDraft } = setup();
    const critical: TicketFields = { ...NEW_FIELDS, priority: 'CRITICAL' };
    confirmDraft('d1', createPayload(critical));
    expect(await errorCodeOf(service.create(ANA, createCommand('d1', critical)))).toBe('INVALID_INPUT');
  });

  it('Crítica para uma equipe vence em 1 hora', async () => {
    const { service, confirmDraft } = setup();
    const critical: TicketFields = {
      ...NEW_FIELDS,
      title: 'Servidor de build fora do ar',
      description: 'O servidor de build não responde e a equipe inteira está parada.',
      category: 'OTHER',
      priority: 'CRITICAL',
      affectedScope: 'TEAM',
      affectedDescription: 'Equipe de engenharia (12 pessoas)',
    };
    confirmDraft('d1', createPayload(critical));
    const created = await service.create(ANA, createCommand('d1', critical));
    expect(created.slaDueAt).toBe(local('2026-11-02T11:00:00').toISOString());
  });

  it('a avaliação de prioridade precisa concordar com a prioridade do chamado', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('d1', createPayload());
    const command = createCommand('d1');
    expect(
      await errorCodeOf(
        service.create(ANA, { ...command, priorityAssessment: { ...command.priorityAssessment, priority: 'LOW' } }),
      ),
    ).toBe('INVALID_INPUT');
  });
});

describe('duplicidade', () => {
  const sameProblem: TicketFields = {
    ...NEW_FIELDS,
    title: 'Notebook muito lento depois da atualização',
    description: 'Meu notebook ficou lento depois que o Windows atualizou.',
    category: 'HARDWARE',
    priority: 'MEDIUM',
  };

  it('sugere o chamado aberto parecido, mas não chamados resolvidos nem de terceiros', async () => {
    const { service } = setup();
    const found = await service.findPossibleDuplicates(ANA, sameProblem);
    expect(found.map((t) => t.code)).toEqual(['INC-20311']);
    expect(await service.findPossibleDuplicates(BRUNO, sameProblem)).toEqual([]);
  });

  it('não sugere chamado de outra categoria nem de assunto diferente', async () => {
    const { service } = setup();
    expect(await service.findPossibleDuplicates(ANA, { ...sameProblem, category: 'EMAIL' })).toEqual([]);
    expect(
      await service.findPossibleDuplicates(ANA, {
        category: 'HARDWARE',
        title: 'Teclado com teclas falhando',
        description: 'Algumas teclas do teclado não funcionam.',
      }),
    ).toEqual([]);
  });

  it('recusa criar um segundo chamado sobre o mesmo problema', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('d1', createPayload(sameProblem));
    const error = await service.create(ANA, createCommand('d1', sameProblem)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TicketServiceError);
    expect((error as TicketServiceError).code).toBe('DUPLICATE_OPEN_TICKET');
    expect((error as TicketServiceError).details?.ticketCode).toBe('INC-20311');
    expect(await service.listForRequester(ANA, { onlyOpen: true })).toHaveLength(1);
  });

  it('o mesmo texto de outro funcionário não é duplicidade', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('d1', createPayload(sameProblem), BRUNO);
    const created = await service.create(BRUNO, createCommand('d1', sameProblem));
    expect(created.code).toBe('INC-20345');
  });

  it('o número da sequência não é consumido quando a criação é recusada', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('dup', createPayload(sameProblem));
    await errorCodeOf(service.create(ANA, createCommand('dup', sameProblem)));
    confirmDraft('ok', createPayload());
    expect((await service.create(ANA, createCommand('ok'))).code).toBe('INC-20345');
  });
});

describe('atualização', () => {
  const updatePayload = (ticketCode: string, comment: string, priority?: 'HIGH'): DraftPayload => ({
    operation: 'UPDATE',
    ticketCode,
    comment,
    ...(priority
      ? { priorityAssessment: { priority, impact: 'Uma pessoa', urgency: 'Impede o trabalho', rationale: 'Agora impede o trabalho.' } }
      : {}),
  });
  const updateCommand = (draftId: string, ticketCode: string, comment: string, newPriority?: 'HIGH') => ({
    confirmedDraftId: draftId,
    conversationId: CONVERSATION,
    ticketCode,
    comment,
    ...(newPriority ? { newPriority } : {}),
  });

  it('registra o comentário no histórico e reinicia o prazo', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('u1', updatePayload('INC-20311', 'Agora também trava ao abrir o Excel.'));
    nowValue = local('2026-11-03T09:00:00');
    const updated = await service.addUpdate(ANA, updateCommand('u1', 'INC-20311', 'Agora também trava ao abrir o Excel.'));
    expect(updated.history.map((e) => e.type)).toEqual(['COMMENT_ADDED']);
    expect(updated.history[0]?.comment).toBe('Agora também trava ao abrir o Excel.');
    expect(updated.slaDueAt).toBe(local('2026-11-06T09:00:00').toISOString()); // 3 dias úteis a partir de terça 9h
  });

  it('muda a prioridade quando a informação nova pede', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('u1', updatePayload('INC-20311', 'Agora não consigo trabalhar de jeito nenhum.', 'HIGH'));
    const updated = await service.addUpdate(ANA, updateCommand('u1', 'INC-20311', 'Agora não consigo trabalhar de jeito nenhum.', 'HIGH'));
    expect(updated.priority).toBe('HIGH');
    expect(updated.history.map((e) => e.type).sort()).toEqual(['COMMENT_ADDED', 'PRIORITY_CHANGED']);
    expect(updated.slaDueAt).toBe(local('2026-11-02T14:00:00').toISOString());
  });

  it('chamado vencido mantém o prazo vencido após a atualização', async () => {
    const { service, confirmDraft } = setup();
    nowValue = local('2026-11-09T10:00:00'); // bem depois do prazo (05/11)
    confirmDraft('u1', updatePayload('INC-20311', 'Alguma novidade sobre este chamado?'));
    const updated = await service.addUpdate(ANA, updateCommand('u1', 'INC-20311', 'Alguma novidade sobre este chamado?'));
    expect(updated.isOverdue).toBe(true);
    expect(updated.slaDueAt).toBe(local('2026-11-05T10:00:00').toISOString());
  });

  it('sem confirmação não atualiza', async () => {
    const { service } = setup();
    expect(await errorCodeOf(service.addUpdate(ANA, updateCommand('nada', 'INC-20311', 'Comentário qualquer')))).toBe('CONFIRMATION_REQUIRED');
    expect((await service.getForRequester(ANA, 'INC-20311')).history).toEqual([]);
  });

  it('não altera chamado de terceiros, mesmo com rascunho confirmado', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('u1', updatePayload('INC-20344', 'Tentando mexer no chamado do Bruno.'));
    expect(await errorCodeOf(service.addUpdate(ANA, updateCommand('u1', 'INC-20344', 'Tentando mexer no chamado do Bruno.')))).toBe('FORBIDDEN');
    expect((await service.getForRequester(BRUNO, 'INC-20344')).history).toEqual([]);
  });

  it('chamado resolvido não recebe atualização: deve ser reaberto', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('u1', updatePayload('INC-20150', 'A senha bloqueou de novo agora.'));
    expect(await errorCodeOf(service.addUpdate(ANA, updateCommand('u1', 'INC-20150', 'A senha bloqueou de novo agora.')))).toBe('INVALID_STATUS');
  });
});

describe('reabertura (janela de 7 dias)', () => {
  const reopenPayload = (ticketCode: string): DraftPayload => ({ operation: 'REOPEN', ticketCode, reason: 'O problema voltou a acontecer.' });
  const reopenCommand = (draftId: string, ticketCode: string) => ({
    confirmedDraftId: draftId,
    conversationId: CONVERSATION,
    ticketCode,
    reason: 'O problema voltou a acontecer.',
  });

  it('reabre chamado resolvido há 4 dias', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('r1', reopenPayload('INC-20150'));
    const reopened = await service.reopen(ANA, reopenCommand('r1', 'INC-20150'));
    expect(reopened.status).toBe('WAITING_ANALYST');
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.history.map((e) => e.type)).toEqual(['REOPENED']);
    expect(reopened.slaDueAt).toBe(local('2026-11-05T10:00:00').toISOString()); // 3 dias úteis (Média)
  });

  it('aceita o limite exato de 7 dias e recusa um instante depois', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('r1', reopenPayload('INC-20150'));
    nowValue = new Date(local('2026-10-29T10:00:00').getTime() + 7 * 24 * 3_600_000);
    expect((await service.reopen(ANA, reopenCommand('r1', 'INC-20150'))).status).toBe('WAITING_ANALYST');

    const second = setup();
    second.confirmDraft('r1', reopenPayload('INC-20150'));
    nowValue = new Date(local('2026-10-29T10:00:00').getTime() + 7 * 24 * 3_600_000 + 1);
    expect(await errorCodeOf(second.service.reopen(ANA, reopenCommand('r1', 'INC-20150')))).toBe('REOPEN_WINDOW_EXPIRED');
  });

  it('recusa chamado resolvido há 12 dias', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('r1', reopenPayload('INC-19980'));
    expect(await errorCodeOf(service.reopen(ANA, reopenCommand('r1', 'INC-19980')))).toBe('REOPEN_WINDOW_EXPIRED');
  });

  it('recusa reabrir chamado que já está aberto', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('r1', reopenPayload('INC-20311'));
    expect(await errorCodeOf(service.reopen(ANA, reopenCommand('r1', 'INC-20311')))).toBe('INVALID_STATUS');
  });

  it('exige confirmação e propriedade do chamado', async () => {
    const { service, confirmDraft } = setup();
    expect(await errorCodeOf(service.reopen(ANA, reopenCommand('nada', 'INC-20150')))).toBe('CONFIRMATION_REQUIRED');
    confirmDraft('r1', reopenPayload('INC-20150'), BRUNO);
    expect(await errorCodeOf(service.reopen(BRUNO, reopenCommand('r1', 'INC-20150')))).toBe('FORBIDDEN');
  });
});

describe('idempotência e concorrência', () => {
  it('confirmar duas vezes o mesmo rascunho devolve o mesmo chamado', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('d1', createPayload());
    const first = await service.create(ANA, createCommand('d1'));
    const second = await service.create(ANA, createCommand('d1'));
    expect(second.code).toBe(first.code);
    expect(second.history).toHaveLength(1);
    expect((await service.listForRequester(ANA)).filter((t) => t.title === NEW_FIELDS.title)).toHaveLength(1);
  });

  it('atualização repetida não duplica o comentário', async () => {
    const { service, confirmDraft } = setup();
    const payload: DraftPayload = { operation: 'UPDATE', ticketCode: 'INC-20311', comment: 'Informação nova importante.' };
    confirmDraft('u1', payload);
    const command = { confirmedDraftId: 'u1', conversationId: CONVERSATION, ticketCode: 'INC-20311', comment: 'Informação nova importante.' };
    await service.addUpdate(ANA, command);
    const again = await service.addUpdate(ANA, command);
    expect(again.history).toHaveLength(1);
  });

  it('confirmações simultâneas do mesmo rascunho criam um único chamado', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('d1', createPayload());
    const results = await Promise.all(Array.from({ length: 8 }, () => service.create(ANA, createCommand('d1'))));
    expect(new Set(results.map((r) => r.code)).size).toBe(1);
    expect((await service.listForRequester(ANA)).filter((t) => t.title === NEW_FIELDS.title)).toHaveLength(1);
  });

  it('rascunhos diferentes sobre o mesmo problema, em paralelo, geram um chamado só', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('d1', createPayload());
    confirmDraft('d2', createPayload());
    const outcomes = await Promise.allSettled([
      service.create(ANA, createCommand('d1')),
      service.create(ANA, createCommand('d2')),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected');
    expect(rejected && rejected.status === 'rejected' && (rejected.reason as TicketServiceError).code).toBe('DUPLICATE_OPEN_TICKET');
  });

  it('um rascunho não pode ser reaproveitado para outra operação', async () => {
    const { service, confirmDraft } = setup();
    confirmDraft('d1', createPayload());
    await service.create(ANA, createCommand('d1'));
    const reopenAttempt = service.reopen(ANA, {
      confirmedDraftId: 'd1',
      conversationId: CONVERSATION,
      ticketCode: 'INC-20150',
      reason: 'O problema voltou a acontecer.',
    });
    expect(await errorCodeOf(reopenAttempt)).toBe('CONFIRMATION_REQUIRED');
  });
});
