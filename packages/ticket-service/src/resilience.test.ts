import type { DraftPayload, TicketFields } from '@nexo/shared';
import { describe, expect, it, vi } from 'vitest';
import { createTicketService } from './default-ticket-service.js';
import { TicketServiceError } from './errors.js';
import { createInMemoryConfirmationGate, createInMemoryTicketStore } from './in-memory.js';
import { withSimulatedOutages } from './outage-simulation.js';
import { withRetry } from './resilience.js';

const ANA = { employeeId: 'usr_ana' };
const fields: TicketFields = {
  type: 'INC',
  title: 'Outlook não sincroniza e-mails',
  description: 'O Outlook parou de receber novos e-mails desde ontem à tarde.',
  category: 'EMAIL',
  priority: 'HIGH',
  affectedScope: 'INDIVIDUAL',
  affectedDescription: 'Somente o solicitante',
};
const assessment = { priority: 'HIGH' as const, impact: 'Uma pessoa', urgency: 'Impede o trabalho', rationale: 'Alta.' };

function setup() {
  const store = createInMemoryTicketStore({ sequences: { INC: 20344 } });
  const gate = createInMemoryConfirmationGate();
  const payload: DraftPayload = { operation: 'CREATE', fields, priorityAssessment: assessment };
  gate.addDraft({ id: 'd1', employeeId: ANA.employeeId, conversationId: 'c1', payload, status: 'PENDING' });
  gate.confirm('d1');
  const inner = createTicketService({ store, confirmations: gate });
  const command = { confirmedDraftId: 'd1', conversationId: 'c1', fields, priorityAssessment: assessment };
  return { inner, command };
}

const noSleep = () => Promise.resolve();

describe('indisponibilidade temporária do sistema de chamados', () => {
  it('repete leituras e se recupera quando o sistema volta', async () => {
    const { inner } = setup();
    const onRetry = vi.fn();
    const service = withRetry(
      withSimulatedOutages(inner, { outageFor: ({ callNumber }) => (callNumber <= 2 ? 'before' : null) }),
      { sleep: noSleep, onRetry },
    );
    expect(await service.listForRequester(ANA)).toEqual([]);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('desiste com UNAVAILABLE (retryable) depois de esgotar as tentativas', async () => {
    const { inner } = setup();
    const service = withRetry(withSimulatedOutages(inner, { outageFor: () => 'before' }), { maxAttempts: 3, sleep: noSleep });
    const error = await service.listForRequester(ANA).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TicketServiceError);
    expect((error as TicketServiceError).code).toBe('UNAVAILABLE');
    expect((error as TicketServiceError).retryable).toBe(true);
  });

  it('queda antes da escrita: a repetição cria o chamado uma única vez', async () => {
    const { inner, command } = setup();
    const service = withRetry(
      withSimulatedOutages(inner, { outageFor: ({ callNumber }) => (callNumber === 1 ? 'before' : null) }),
      { sleep: noSleep },
    );
    const created = await service.create(ANA, command);
    expect(created.code).toBe('INC-20345');
    expect(await inner.listForRequester(ANA)).toHaveLength(1);
  });

  it('queda DEPOIS de gravar (resposta perdida): a repetição não duplica o chamado', async () => {
    const { inner, command } = setup();
    const service = withRetry(
      withSimulatedOutages(inner, { outageFor: ({ callNumber }) => (callNumber <= 2 ? 'after' : null) }),
      { sleep: noSleep },
    );
    const created = await service.create(ANA, command);
    expect(created.code).toBe('INC-20345');
    expect(await inner.listForRequester(ANA)).toHaveLength(1);
    expect((await inner.getForRequester(ANA, 'INC-20345')).history).toHaveLength(1);
  });

  it('sem retry, a resposta perdida só fica segura porque a escrita é idempotente', async () => {
    const { inner, command } = setup();
    const flaky = withSimulatedOutages(inner, { outageFor: ({ callNumber }) => (callNumber === 1 ? 'after' : null) });
    await expect(flaky.create(ANA, command)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const retried = await flaky.create(ANA, command);
    expect(retried.code).toBe('INC-20345');
    expect(await inner.listForRequester(ANA)).toHaveLength(1);
  });

  it('erros de negócio não são repetidos', async () => {
    const { inner } = setup();
    let calls = 0;
    const counting = withSimulatedOutages(inner, {
      outageFor: () => {
        calls++;
        return null;
      },
    });
    const service = withRetry(counting, { sleep: noSleep });
    await expect(service.getForRequester(ANA, 'INC-99999')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(calls).toBe(1);
  });

  it('espera cresce a cada tentativa, com teto', async () => {
    const { inner } = setup();
    const delays: number[] = [];
    const service = withRetry(withSimulatedOutages(inner, { outageFor: () => 'before' }), {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 300,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    await service.listForRequester(ANA).catch(() => undefined);
    expect(delays).toEqual([100, 200, 300, 300]);
  });
});
