import { ApiErrorBodySchema, TicketDetailSchema, TicketSummarySchema } from '@nexo/shared';
import { TicketServiceError } from '@nexo/ticket-service';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ANA, BRUNO, bearer, buildHarness } from './helpers/api-harness.js';

const errorOf = (res: request.Response) => ApiErrorBodySchema.parse(res.body).error;

describe('GET /api/tickets', () => {
  it('lista só os chamados do funcionário autenticado, com vencimento', async () => {
    const h = buildHarness();
    const res = await request(h.app).get('/api/tickets').set(bearer(await h.login(ANA)));

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const items = (res.body.items as unknown[]).map((item) => TicketSummarySchema.parse(item));
    expect(items.map((t) => t.code).sort()).toEqual(['INC-19980', 'INC-20150', 'INC-20311']);
    expect(items.find((t) => t.code === 'INC-20311')).toMatchObject({ status: 'WAITING_ANALYST', isOverdue: true });
    expect(items.find((t) => t.code === 'INC-20150')?.isOverdue).toBe(false);
  });

  it('cada funcionário vê apenas os seus', async () => {
    const h = buildHarness();
    const res = await request(h.app).get('/api/tickets').set(bearer(await h.login(BRUNO)));
    expect((res.body.items as Array<{ code: string }>).map((t) => t.code)).toEqual(['INC-20344']);
  });

  it('ignora qualquer tentativa do cliente de informar outro funcionário', async () => {
    const h = buildHarness();
    const token = await h.login(ANA);
    const res = await request(h.app)
      .get('/api/tickets')
      .query({ employeeId: BRUNO.id, requesterId: BRUNO.id, userId: BRUNO.id })
      .set({ ...bearer(token), 'x-employee-id': BRUNO.id, 'x-user-id': BRUNO.id });
    expect((res.body.items as Array<{ code: string }>).map((t) => t.code)).not.toContain('INC-20344');
    expect(res.body.items).toHaveLength(3);
  });

  it('exige login', async () => {
    const { app } = buildHarness();
    const res = await request(app).get('/api/tickets');
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('UNAUTHENTICATED');
  });
});

describe('GET /api/tickets/:ticketCode', () => {
  it('devolve o detalhe do próprio chamado com histórico', async () => {
    const h = buildHarness();
    const res = await request(h.app).get('/api/tickets/INC-20311').set(bearer(await h.login(ANA)));
    expect(res.status).toBe(200);
    const ticket = TicketDetailSchema.parse(res.body.ticket);
    expect(ticket).toMatchObject({ code: 'INC-20311', isOverdue: true, history: [] });
  });

  it('chamado de outro funcionário é indistinguível de chamado inexistente', async () => {
    const h = buildHarness();
    const token = await h.login(ANA);
    const foreign = await request(h.app).get('/api/tickets/INC-20344').set(bearer(token));
    const missing = await request(h.app).get('/api/tickets/INC-99999').set(bearer(token));

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(errorOf(foreign)).toMatchObject({ code: 'NOT_FOUND', message: errorOf(missing).message });
    // nada do chamado alheio vaza no corpo (título, código, etc.)
    expect(JSON.stringify(foreign.body)).not.toMatch(/CRM|INC-20344|Bruno/);
  });

  it('código malformado responde VALIDATION_ERROR', async () => {
    const h = buildHarness();
    const res = await request(h.app).get('/api/tickets/qualquer-coisa').set(bearer(await h.login(ANA)));
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('exige login', async () => {
    const { app } = buildHarness();
    expect((await request(app).get('/api/tickets/INC-20311')).status).toBe(401);
  });
});

describe('falhas do sistema de chamados', () => {
  it('queda curta é absorvida pelas retentativas e a requisição dá certo', async () => {
    const h = buildHarness({ outages: { outageFor: ({ callNumber }) => (callNumber <= 2 ? 'before' : null) } });
    const res = await request(h.app).get('/api/tickets').set(bearer(await h.login(ANA)));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
  });

  it('queda longa responde 503 repetível, com Retry-After e sem detalhes internos', async () => {
    const h = buildHarness({ outages: { outageFor: () => 'before' } });
    const res = await request(h.app).get('/api/tickets/INC-20311').set(bearer(await h.login(ANA)));
    expect(res.status).toBe(503);
    expect(errorOf(res)).toMatchObject({ code: 'TICKET_SERVICE_UNAVAILABLE', retryable: true });
    expect(res.headers['retry-after']).toBe('5');
  });

  it('erro inesperado vira 500 genérico: nada interno vaza, e vai para o log', async () => {
    const h = buildHarness({
      ticketServiceOverride: (real) => ({
        ...real,
        listForRequester: async () => {
          throw new Error('postgres://nexo:senha-do-banco@10.0.0.5/nexo falhou em tickets.sql:42');
        },
      }),
    });
    const res = await request(h.app).get('/api/tickets').set(bearer(await h.login(ANA)));
    expect(res.status).toBe(500);
    expect(errorOf(res)).toMatchObject({ code: 'INTERNAL_ERROR', retryable: false });
    expect(res.text).not.toMatch(/senha-do-banco|postgres|tickets\.sql|10\.0\.0\.5|stack/i);
    expect(h.logger.error).toHaveBeenCalledOnce();
  });

  it('o log de erros não registra o token de sessão', async () => {
    const h = buildHarness({
      ticketServiceOverride: (real) => ({
        ...real,
        listForRequester: async () => {
          throw new Error('falha qualquer');
        },
      }),
    });
    const token = await h.login(ANA);
    await request(h.app).get('/api/tickets').set(bearer(token));
    expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain(token);
  });

  it('erros do serviço de chamados são mapeados para o contrato HTTP', async () => {
    const cases: Array<[ConstructorParameters<typeof TicketServiceError>[0], number, string]> = [
      ['NOT_FOUND', 404, 'NOT_FOUND'],
      ['FORBIDDEN', 404, 'NOT_FOUND'],
      ['DUPLICATE_OPEN_TICKET', 409, 'DUPLICATE_TICKET'],
      ['REOPEN_WINDOW_EXPIRED', 422, 'REOPEN_WINDOW_EXPIRED'],
      ['INVALID_STATUS', 409, 'CONFLICT'],
      ['CONFIRMATION_REQUIRED', 409, 'DRAFT_NOT_PENDING'],
      ['INVALID_INPUT', 400, 'VALIDATION_ERROR'],
      ['UNAVAILABLE', 503, 'TICKET_SERVICE_UNAVAILABLE'],
    ];
    for (const [code, status, apiCode] of cases) {
      const h = buildHarness({
        retry: false,
        ticketServiceOverride: (real) => ({
          ...real,
          getForRequester: async () => {
            throw new TicketServiceError(code, 'mensagem interna');
          },
        }),
      });
      const res = await request(h.app).get('/api/tickets/INC-20311').set(bearer(await h.login(ANA)));
      expect([res.status, errorOf(res).code]).toEqual([status, apiCode]);
    }
  });
});
