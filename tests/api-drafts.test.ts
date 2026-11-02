import { ApiErrorBodySchema, DraftConfirmationResponseSchema, type TicketFields } from '@nexo/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  ANA,
  BRUNO,
  CONV_ANA,
  CONV_BRUNO,
  NEW_FIELDS,
  type Harness,
  bearer,
  buildHarness,
  createPayload,
  reopenPayload,
  updatePayload,
} from './helpers/api-harness.js';

const errorOf = (res: request.Response) => ApiErrorBodySchema.parse(res.body).error;
const confirmUrl = (conversationId: string, draftId: string) => `/api/conversations/${conversationId}/drafts/${draftId}/confirm`;
const discardUrl = (conversationId: string, draftId: string) => `/api/conversations/${conversationId}/drafts/${draftId}/discard`;

async function confirm(h: Harness, token: string, draftId: string, conversationId = CONV_ANA) {
  return request(h.app).post(confirmUrl(conversationId, draftId)).set(bearer(token));
}

async function ticketCount(h: Harness, who = ANA) {
  return (await h.realTickets.listForRequester({ employeeId: who.id })).length;
}

describe('confirmação válida', () => {
  it('cria o chamado, marca o rascunho e registra a mensagem do agente', async () => {
    const h = buildHarness();
    const token = await h.login(ANA);
    const draftId = h.addDraft(ANA, createPayload());

    const res = await confirm(h, token, draftId);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = DraftConfirmationResponseSchema.parse(res.body);

    expect(body.ticket).toMatchObject({ code: 'INC-20345', status: 'WAITING_ANALYST', priority: 'HIGH' });
    expect(body.draft).toMatchObject({ id: draftId, status: 'CONFIRMED', resultTicketCode: 'INC-20345' });
    expect(body.draft.confirmedAt).not.toBeNull();
    expect(body.message).toMatchObject({ role: 'AGENT', authorId: null, conversationId: CONV_ANA });
    expect(body.message.blocks.map((b) => b.type)).toEqual(['text', 'ticket_cards']);
    expect(await ticketCount(h)).toBe(4);
  });

  it('atualiza um chamado aberto', async () => {
    const h = buildHarness();
    const draftId = h.addDraft(ANA, updatePayload('INC-20311', 'Agora também trava ao abrir o Teams.'));
    const res = await confirm(h, await h.login(ANA), draftId);
    expect(res.status).toBe(200);
    const body = DraftConfirmationResponseSchema.parse(res.body);
    expect(body.ticket.history.at(-1)).toMatchObject({ type: 'COMMENT_ADDED', comment: 'Agora também trava ao abrir o Teams.' });
    expect(body.message.content).toContain('Atualizei o chamado INC-20311');
  });

  it('reabre um chamado resolvido dentro da janela de 7 dias', async () => {
    const h = buildHarness();
    const draftId = h.addDraft(ANA, reopenPayload('INC-20150'));
    const res = await confirm(h, await h.login(ANA), draftId);
    expect(res.status).toBe(200);
    expect(DraftConfirmationResponseSchema.parse(res.body).ticket).toMatchObject({ code: 'INC-20150', status: 'WAITING_ANALYST' });
  });
});

describe('idempotência e concorrência', () => {
  it('confirmar de novo devolve o mesmo chamado e a mesma mensagem, sem duplicar', async () => {
    const h = buildHarness();
    const token = await h.login(ANA);
    const draftId = h.addDraft(ANA, createPayload());

    const first = DraftConfirmationResponseSchema.parse((await confirm(h, token, draftId)).body);
    const second = await confirm(h, token, draftId);
    expect(second.status).toBe(200);
    const again = DraftConfirmationResponseSchema.parse(second.body);

    expect(again.ticket.code).toBe(first.ticket.code);
    expect(again.message.id).toBe(first.message.id);
    expect(h.drafts.messages()).toHaveLength(1);
    expect(await ticketCount(h)).toBe(4);
  });

  it('confirmações simultâneas criam um único chamado e todas recebem o mesmo resultado', async () => {
    const h = buildHarness();
    const token = await h.login(ANA);
    const draftId = h.addDraft(ANA, createPayload());

    const responses = await Promise.all(Array.from({ length: 10 }, () => confirm(h, token, draftId)));
    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(new Set(responses.map((r) => r.body.ticket.code as string)).size).toBe(1);
    expect(new Set(responses.map((r) => r.body.message.id as string)).size).toBe(1);
    expect(await ticketCount(h)).toBe(4);
  });

  it('confirmar e descartar ao mesmo tempo: exatamente um resultado prevalece', async () => {
    const h = buildHarness();
    const token = await h.login(ANA);
    const draftId = h.addDraft(ANA, createPayload());

    const [confirmed, discarded] = await Promise.all([
      confirm(h, token, draftId),
      request(h.app).post(discardUrl(CONV_ANA, draftId)).set(bearer(token)),
    ]);
    const created = await ticketCount(h);
    if (confirmed.status === 200) {
      expect(created).toBe(4);
      expect(discarded.status).toBe(409);
    } else {
      expect(created).toBe(3);
      expect(discarded.status).toBe(200);
      expect(errorOf(confirmed).code).toBe('DRAFT_NOT_PENDING');
    }
  });
});

describe('falha entre marcar como confirmado e efetivar', () => {
  it('sistema fora do ar: devolve 503, mantém CONFIRMED e a retentativa conclui', async () => {
    let down = true;
    const h = buildHarness({ retry: false, outages: { outageFor: () => (down ? 'before' : null) } });
    const token = await h.login(ANA);
    const draftId = h.addDraft(ANA, createPayload());

    const failed = await confirm(h, token, draftId);
    expect(failed.status).toBe(503);
    expect(errorOf(failed)).toMatchObject({ code: 'TICKET_SERVICE_UNAVAILABLE', retryable: true });
    expect(await ticketCount(h)).toBe(3);
    expect((await h.drafts.findById(draftId))?.status).toBe('CONFIRMED');

    down = false;
    const retried = await confirm(h, token, draftId);
    expect(retried.status).toBe(200);
    expect(await ticketCount(h)).toBe(4);
  });

  it('escrita feita mas resposta perdida: a retentativa não duplica o chamado', async () => {
    let lose = true;
    const h = buildHarness({ retry: false, outages: { outageFor: ({ method }) => (lose && method === 'create' ? 'after' : null) } });
    const token = await h.login(ANA);
    const draftId = h.addDraft(ANA, createPayload());

    expect((await confirm(h, token, draftId)).status).toBe(503);
    expect(await ticketCount(h)).toBe(4); // o chamado já foi gravado

    lose = false;
    const retried = await confirm(h, token, draftId);
    expect(retried.status).toBe(200);
    expect(retried.body.ticket.code).toBe('INC-20345');
    expect(await ticketCount(h)).toBe(4);
  });

  it('falha ao registrar o resultado depois de gravar: a retentativa reconcilia', async () => {
    const h = buildHarness();
    const token = await h.login(ANA);
    const draftId = h.addDraft(ANA, createPayload());

    h.drafts.failNextMarkExecuted();
    const failed = await confirm(h, token, draftId);
    expect(failed.status).toBe(500);
    expect(await ticketCount(h)).toBe(4);
    expect((await h.drafts.findById(draftId))?.resultTicketCode).toBeNull();

    const retried = await confirm(h, token, draftId);
    expect(retried.status).toBe(200);
    expect(retried.body.draft.resultTicketCode).toBe('INC-20345');
    expect(await ticketCount(h)).toBe(4);
    expect(h.drafts.messages()).toHaveLength(1);
  });
});

describe('recusas de negócio devolvem o rascunho a PENDING', () => {
  it('duplicidade: 409 DUPLICATE_TICKET apontando o chamado existente', async () => {
    const h = buildHarness();
    const token = await h.login(ANA);
    const duplicate: TicketFields = {
      ...NEW_FIELDS,
      title: 'Notebook muito lento depois da atualização',
      description: 'Meu notebook ficou lento depois que o Windows atualizou.',
      category: 'HARDWARE',
      priority: 'MEDIUM',
    };
    const draftId = h.addDraft(ANA, createPayload(duplicate));

    const res = await confirm(h, token, draftId);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toMatchObject({ code: 'DUPLICATE_TICKET', details: { ticketCode: 'INC-20311' } });
    expect((await h.drafts.findById(draftId))?.status).toBe('PENDING');
    expect(await ticketCount(h)).toBe(3);

    // como voltou a PENDING, o funcionário ainda pode descartar
    expect((await request(h.app).post(discardUrl(CONV_ANA, draftId)).set(bearer(token))).status).toBe(200);
  });

  it('reabertura fora da janela: 422 REOPEN_WINDOW_EXPIRED', async () => {
    const h = buildHarness();
    const draftId = h.addDraft(ANA, reopenPayload('INC-19980'));
    const res = await confirm(h, await h.login(ANA), draftId);
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('REOPEN_WINDOW_EXPIRED');
    expect((await h.drafts.findById(draftId))?.status).toBe('PENDING');
  });

  it('atualizar chamado resolvido: 409 CONFLICT', async () => {
    const h = buildHarness();
    const draftId = h.addDraft(ANA, updatePayload('INC-20150', 'A senha bloqueou de novo agora.'));
    const res = await confirm(h, await h.login(ANA), draftId);
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('CONFLICT');
  });
});

describe('propriedade e privacidade', () => {
  it('outro funcionário não confirma nem descarta o rascunho: 404 e nada é escrito', async () => {
    const h = buildHarness();
    const draftId = h.addDraft(ANA, createPayload());
    const bruno = await h.login(BRUNO);

    // tenta pela conversa dele e pela conversa da Ana
    for (const conv of [CONV_BRUNO, CONV_ANA]) {
      const res = await confirm(h, bruno, draftId, conv);
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('NOT_FOUND');
      expect((await request(h.app).post(discardUrl(conv, draftId)).set(bearer(bruno))).status).toBe(404);
    }
    expect((await h.drafts.findById(draftId))?.status).toBe('PENDING');
    expect(await ticketCount(h)).toBe(3);
    expect(await ticketCount(h, BRUNO)).toBe(1);
  });

  it('rascunho de outro é indistinguível de rascunho inexistente', async () => {
    const h = buildHarness();
    const draftId = h.addDraft(ANA, createPayload());
    const bruno = await h.login(BRUNO);
    const foreign = await confirm(h, bruno, draftId, CONV_BRUNO);
    const missing = await confirm(h, bruno, 'drf_inexistente', CONV_BRUNO);
    expect(errorOf(foreign)).toEqual({ ...errorOf(missing), requestId: errorOf(foreign).requestId });
  });

  it('conversa errada na URL: 404', async () => {
    const h = buildHarness();
    const draftId = h.addDraft(ANA, createPayload());
    expect((await confirm(h, await h.login(ANA), draftId, 'conv_outra')).status).toBe(404);
  });

  it('employeeId enviado pelo cliente (corpo, query, cabeçalho) é ignorado', async () => {
    const h = buildHarness();
    const draftId = h.addDraft(ANA, createPayload());
    const bruno = await h.login(BRUNO);

    const spoof = await request(h.app)
      .post(`${confirmUrl(CONV_ANA, draftId)}?employeeId=${ANA.id}`)
      .set({ ...bearer(bruno), 'x-employee-id': ANA.id })
      .send({ employeeId: ANA.id, requesterId: ANA.id, status: 'CONFIRMED' });
    expect(spoof.status).toBe(404);
    expect((await h.drafts.findById(draftId))?.status).toBe('PENDING');
  });

  it('o corpo da requisição não altera o que é gravado', async () => {
    const h = buildHarness();
    const draftId = h.addDraft(ANA, createPayload());
    const res = await request(h.app)
      .post(confirmUrl(CONV_ANA, draftId))
      .set(bearer(await h.login(ANA)))
      .send({ fields: { ...NEW_FIELDS, title: 'Título injetado pelo cliente', priority: 'LOW' } });
    expect(res.status).toBe(200);
    expect(res.body.ticket).toMatchObject({ title: NEW_FIELDS.title, priority: 'HIGH' });
  });

  it('exige login', async () => {
    const h = buildHarness();
    const draftId = h.addDraft(ANA, createPayload());
    expect((await request(h.app).post(confirmUrl(CONV_ANA, draftId))).status).toBe(401);
    expect((await request(h.app).post(discardUrl(CONV_ANA, draftId))).status).toBe(401);
  });

  it('identificadores absurdos são rejeitados na validação', async () => {
    const h = buildHarness();
    const res = await confirm(h, await h.login(ANA), 'x'.repeat(200));
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });
});

describe('estado do rascunho', () => {
  it('rascunho descartado não pode mais ser confirmado', async () => {
    const h = buildHarness();
    const token = await h.login(ANA);
    const draftId = h.addDraft(ANA, createPayload());

    const discarded = await request(h.app).post(discardUrl(CONV_ANA, draftId)).set(bearer(token));
    expect(discarded.status).toBe(200);
    expect(discarded.body.draft.status).toBe('DISCARDED');

    const res = await confirm(h, token, draftId);
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('DRAFT_NOT_PENDING');
    expect(await ticketCount(h)).toBe(3);
  });

  it('descartar é idempotente, mas rascunho confirmado não pode ser descartado', async () => {
    const h = buildHarness();
    const token = await h.login(ANA);
    const toDiscard = h.addDraft(ANA, createPayload());
    expect((await request(h.app).post(discardUrl(CONV_ANA, toDiscard)).set(bearer(token))).status).toBe(200);
    expect((await request(h.app).post(discardUrl(CONV_ANA, toDiscard)).set(bearer(token))).status).toBe(200);

    const confirmedId = h.addDraft(ANA, updatePayload('INC-20311', 'Informação nova importante.'));
    expect((await confirm(h, token, confirmedId)).status).toBe(200);
    const res = await request(h.app).post(discardUrl(CONV_ANA, confirmedId)).set(bearer(token));
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('DRAFT_NOT_PENDING');
  });

  it('conversa encerrada não aceita confirmação', async () => {
    const h = buildHarness();
    const draftId = 'drf_fechado';
    h.drafts.addDraft({
      id: draftId,
      conversationId: CONV_ANA,
      employeeId: ANA.id,
      operation: 'CREATE',
      payload: createPayload(),
      status: 'PENDING',
      createdAt: h.clock.current,
      conversationOwnerId: ANA.id,
      conversationStatus: 'CLOSED',
    });
    const res = await confirm(h, await h.login(ANA), draftId);
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('não há escrita direta contornando a confirmação', () => {
  it('o serviço recusa escrever com rascunho PENDING, inexistente, alheio ou adulterado', async () => {
    const h = buildHarness();
    const pending = h.addDraft(ANA, createPayload());
    const foreign = h.addDraft(BRUNO, createPayload(), CONV_BRUNO, 'CONFIRMED');
    const command = (confirmedDraftId: string, fields: TicketFields = NEW_FIELDS) => ({
      confirmedDraftId,
      conversationId: CONV_ANA,
      fields,
      priorityAssessment: { priority: fields.priority, impact: 'Afeta uma pessoa', urgency: 'Impede o trabalho', rationale: 'Impede uma pessoa de trabalhar: prioridade Alta.' },
    });

    for (const draftId of [pending, 'drf_inexistente', foreign]) {
      await expect(h.realTickets.create({ employeeId: ANA.id }, command(draftId))).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    }
    // confirmado, mas com conteúdo diferente do que o funcionário viu
    const confirmed = h.addDraft(ANA, createPayload(), CONV_ANA, 'CONFIRMED');
    await expect(
      h.realTickets.create({ employeeId: ANA.id }, command(confirmed, { ...NEW_FIELDS, title: 'Título trocado depois da confirmação' })),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(await ticketCount(h)).toBe(3);
  });

  it('não existe rota HTTP de escrita direta de chamados', async () => {
    const h = buildHarness();
    const token = await h.login(ANA);
    for (const [method, path] of [
      ['post', '/api/tickets'],
      ['put', '/api/tickets/INC-20311'],
      ['patch', '/api/tickets/INC-20311'],
      ['delete', '/api/tickets/INC-20311'],
      ['post', '/api/tickets/INC-20311/updates'],
    ] as const) {
      const res = await request(h.app)[method](path).set(bearer(token)).send(createPayload());
      expect([404, 405]).toContain(res.status);
    }
    expect(await ticketCount(h)).toBe(3);
  });
});
