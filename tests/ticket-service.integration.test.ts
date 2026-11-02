import type { DraftPayload, TicketFields } from '@nexo/shared';
import {
  TicketServiceError,
  type TicketService,
  createTicketService,
  withRetry,
  withSimulatedOutages,
} from '@nexo/ticket-service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaConfirmationGate } from '../apps/api/src/infra/prisma-confirmation-gate.js';
import { createPrismaTicketStore } from '../apps/api/src/infra/prisma-ticket-store.js';
import { createPrismaClient, type PrismaClient } from '../apps/api/src/infra/prisma.js';
import { buildSeedData } from '../apps/api/src/seed/data.js';
import { seedDatabase } from '../apps/api/src/seed/seed.js';
import { type DisposableDatabase, createDisposableDatabase } from './helpers/disposable-database.js';

/**
 * Serviço de chamados contra PostgreSQL real, em um banco descartável criado só para este arquivo.
 * Exercita o que o banco em memória não cobre: transações, advisory lock, índice único e a migration.
 * Roda com `npm run test:db`.
 */

const NOW = new Date('2026-11-02T13:00:00Z'); // segunda-feira, 10h em America/Sao_Paulo
const clock = { now: () => NOW };
const ANA = { employeeId: 'usr_ana_souza' };
const BRUNO = { employeeId: 'usr_bruno_lima' };

let db: DisposableDatabase;
let prisma: PrismaClient;
let service: TicketService;

const FIELDS: TicketFields = {
  type: 'INC',
  title: 'Teclado com teclas falhando',
  description: 'Várias teclas do teclado do notebook pararam de funcionar hoje cedo.',
  category: 'HARDWARE',
  priority: 'HIGH',
  affectedScope: 'INDIVIDUAL',
  affectedDescription: 'Somente Ana Souza',
};
const ASSESSMENT = { priority: 'HIGH' as const, impact: 'Uma pessoa', urgency: 'Impede o trabalho', rationale: 'Alta.' };

let draftCounter = 0;
async function confirmedDraft(
  employeeId: string,
  payload: DraftPayload,
  options: { status?: 'PENDING' | 'CONFIRMED' } = {},
): Promise<string> {
  const id = `drf_${++draftCounter}`;
  const conversationId = employeeId === ANA.employeeId ? 'conv_ana' : 'conv_bruno';
  await prisma.ticketDraft.create({
    data: {
      id,
      conversationId,
      employeeId,
      operation: payload.operation,
      payload: payload as object,
      status: options.status ?? 'CONFIRMED',
    },
  });
  return id;
}

const createPayload = (fields: TicketFields = FIELDS): DraftPayload => ({
  operation: 'CREATE',
  fields,
  priorityAssessment: { ...ASSESSMENT, priority: fields.priority },
});

const createCommand = (draftId: string, conversationId: string, fields: TicketFields = FIELDS) => ({
  confirmedDraftId: draftId,
  conversationId,
  fields,
  priorityAssessment: { ...ASSESSMENT, priority: fields.priority },
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TicketServiceError) return error.code;
    throw error;
  }
  throw new Error('esperava TicketServiceError');
}

beforeAll(async () => {
  db = await createDisposableDatabase();
  prisma = createPrismaClient(db.url);
  await seedDatabase(prisma, NOW);
  await prisma.conversation.createMany({
    data: [
      { id: 'conv_ana', employeeId: ANA.employeeId },
      { id: 'conv_bruno', employeeId: BRUNO.employeeId },
    ],
  });
  service = createTicketService({
    store: createPrismaTicketStore(prisma),
    confirmations: createPrismaConfirmationGate(prisma),
    clock,
  });
}, 90_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.drop();
}, 30_000);

describe('migration e seed', () => {
  it('o seed é idempotente e não sobrescreve nada', async () => {
    const again = await seedDatabase(prisma, NOW);
    expect(again).toEqual({ users: 0, helpArticles: 0, tickets: 0, events: 0 });
    const data = buildSeedData(NOW);
    expect(await prisma.ticket.count()).toBe(data.tickets.length);
    expect(await prisma.helpArticle.count()).toBe(data.helpArticles.length);
  });

  it('os chamados de exemplo cobrem aberto, vencido, resolvido recente, expirado e de terceiros', async () => {
    const ana = await service.listForRequester(ANA);
    const byCode = new Map(ana.map((t) => [t.code, t]));
    expect(ana).toHaveLength(5);
    expect(byCode.get('INC-20311')).toMatchObject({ status: 'WAITING_ANALYST', isOverdue: true });
    expect(byCode.get('INC-20335')).toMatchObject({ status: 'IN_PROGRESS', isOverdue: false });
    expect(byCode.get('REQ-10442')?.status).toBe('APPROVED');
    expect(byCode.get('INC-20150')).toMatchObject({ status: 'RESOLVED', isOverdue: false });

    const bruno = await service.listForRequester(BRUNO);
    expect(bruno.map((t) => t.code).sort()).toEqual(['INC-20290', 'INC-20344']);
    const diego = await service.listForRequester({ employeeId: 'usr_diego_ferreira' });
    expect(diego[0]).toMatchObject({ code: 'INC-20352', priority: 'CRITICAL', isOverdue: true });
  });

  it('a sequência continua do último código usado', async () => {
    const sequences = await prisma.ticketSequence.findMany({ orderBy: { type: 'asc' } });
    expect(sequences.map((s) => [s.type, s.lastNumber])).toEqual([
      ['INC', 20352],
      ['REQ', 10450],
    ]);
  });
});

describe('isolamento entre funcionários (PostgreSQL)', () => {
  it('não lê nem altera chamados de terceiros', async () => {
    expect(await codeOf(service.getForRequester(ANA, 'INC-20344'))).toBe('FORBIDDEN');

    const draftId = await confirmedDraft(ANA.employeeId, {
      operation: 'UPDATE',
      ticketCode: 'INC-20344',
      comment: 'Tentando alterar chamado de outra pessoa.',
    });
    const attempt = service.addUpdate(ANA, {
      confirmedDraftId: draftId,
      conversationId: 'conv_ana',
      ticketCode: 'INC-20344',
      comment: 'Tentando alterar chamado de outra pessoa.',
    });
    expect(await codeOf(attempt)).toBe('FORBIDDEN');
    expect((await service.getForRequester(BRUNO, 'INC-20344')).history.map((e) => e.type)).toEqual(['CREATED']);
  });
});

describe('confirmação (PostgreSQL)', () => {
  it('rascunho pendente não escreve; confirmado escreve', async () => {
    const pending = await confirmedDraft(ANA.employeeId, createPayload(), { status: 'PENDING' });
    expect(await codeOf(service.create(ANA, createCommand(pending, 'conv_ana')))).toBe('CONFIRMATION_REQUIRED');
    expect(await prisma.ticket.count({ where: { title: FIELDS.title } })).toBe(0);

    await prisma.ticketDraft.update({ where: { id: pending }, data: { status: 'CONFIRMED' } });
    const created = await service.create(ANA, createCommand(pending, 'conv_ana'));
    expect(created.code).toBe('INC-20353');
    expect(created.slaDueAt).toBe(new Date('2026-11-02T17:00:00Z').toISOString()); // 4h úteis a partir de 10h
  });

  it('conteúdo diferente do confirmado é recusado', async () => {
    const draftId = await confirmedDraft(ANA.employeeId, createPayload());
    const tampered = { ...FIELDS, title: 'Título adulterado depois da confirmação' };
    expect(await codeOf(service.create(ANA, createCommand(draftId, 'conv_ana', tampered)))).toBe('CONFIRMATION_REQUIRED');
  });

  it('rascunho de outra conversa é recusado', async () => {
    const draftId = await confirmedDraft(ANA.employeeId, createPayload());
    expect(await codeOf(service.create(ANA, createCommand(draftId, 'conv_bruno')))).toBe('CONFIRMATION_REQUIRED');
  });
});

describe('concorrência e idempotência (PostgreSQL)', () => {
  const fields: TicketFields = {
    type: 'REQ',
    title: 'Mouse sem fio novo',
    description: 'Peço um mouse sem fio novo, o atual está com o botão esquerdo falhando.',
    category: 'HARDWARE',
    priority: 'LOW',
    affectedScope: 'INDIVIDUAL',
    affectedDescription: 'Somente Bruno Lima',
  };

  it('confirmações simultâneas do mesmo rascunho criam um único chamado', async () => {
    const draftId = await confirmedDraft(BRUNO.employeeId, createPayload(fields));
    const before = await prisma.ticket.count();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.create(BRUNO, createCommand(draftId, 'conv_bruno', fields))),
    );
    expect(new Set(results.map((r) => r.code)).size).toBe(1);
    expect(await prisma.ticket.count()).toBe(before + 1);
    expect(await prisma.ticketEvent.count({ where: { draftId } })).toBe(1);
  });

  it('rascunhos diferentes sobre o mesmo problema, em paralelo, geram um chamado só', async () => {
    const racing: TicketFields = { ...fields, title: 'Monitor piscando constantemente', description: 'O monitor externo pisca sem parar desde ontem.', category: 'HARDWARE' };
    const [a, b, c] = await Promise.all([
      confirmedDraft(BRUNO.employeeId, createPayload(racing)),
      confirmedDraft(BRUNO.employeeId, createPayload(racing)),
      confirmedDraft(BRUNO.employeeId, createPayload(racing)),
    ]);
    const outcomes = await Promise.allSettled(
      [a, b, c].map((id) => service.create(BRUNO, createCommand(id, 'conv_bruno', racing))),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') expect((outcome.reason as TicketServiceError).code).toBe('DUPLICATE_OPEN_TICKET');
    }
    expect(await prisma.ticket.count({ where: { title: racing.title } })).toBe(1);
  });

  it('criações simultâneas de assuntos diferentes recebem códigos distintos e sem buracos', async () => {
    const subjects = ['Cabo HDMI extra', 'Suporte de notebook', 'Webcam externa', 'Headset com microfone'];
    const drafts = await Promise.all(
      subjects.map((title) =>
        confirmedDraft(ANA.employeeId, createPayload({ ...fields, title, description: `Solicitação de equipamento: ${title}, para uso diário.` })),
      ),
    );
    const results = await Promise.all(
      drafts.map((id, i) => {
        const f = { ...fields, title: subjects[i] ?? '', description: `Solicitação de equipamento: ${subjects[i]}, para uso diário.` };
        return service.create(ANA, createCommand(id, 'conv_ana', f));
      }),
    );
    const numbers = results.map((r) => Number(r.code.slice(4))).sort((x, y) => x - y);
    expect(new Set(numbers).size).toBe(subjects.length);
    expect(numbers[numbers.length - 1]! - numbers[0]!).toBe(subjects.length - 1);
  });
});

describe('transações (PostgreSQL)', () => {
  it('falha no meio da escrita desfaz tudo, inclusive o número da sequência', async () => {
    const store = createPrismaTicketStore(prisma);
    const before = {
      tickets: await prisma.ticket.count(),
      sequence: (await prisma.ticketSequence.findUniqueOrThrow({ where: { type: 'INC' } })).lastNumber,
    };

    await expect(
      store.transaction(async (tx) => {
        const number = await tx.nextNumber('INC');
        await tx.insertTicket({
          code: `INC-${number}`,
          type: 'INC',
          title: 'Chamado que não deve persistir',
          description: 'Este chamado precisa ser desfeito pela transação.',
          category: 'OTHER',
          priority: 'LOW',
          status: 'WAITING_ANALYST',
          affectedScope: 'INDIVIDUAL',
          affectedDescription: 'Ninguém',
          requesterId: ANA.employeeId,
          slaDueAt: NOW,
          firstResponseAt: null,
          resolvedAt: null,
          closedAt: null,
          originConversationId: null,
          createdAt: NOW,
          updatedAt: NOW,
        });
        throw new Error('falha simulada');
      }),
    ).rejects.toThrow('falha simulada');

    expect(await prisma.ticket.count()).toBe(before.tickets);
    expect((await prisma.ticketSequence.findUniqueOrThrow({ where: { type: 'INC' } })).lastNumber).toBe(before.sequence);
  });
});

describe('atualização e reabertura (PostgreSQL)', () => {
  it('atualiza chamado aberto com comentário e histórico', async () => {
    const payload: DraftPayload = { operation: 'UPDATE', ticketCode: 'INC-20311', comment: 'Agora também trava ao abrir o Teams.' };
    const draftId = await confirmedDraft(ANA.employeeId, payload);
    const updated = await service.addUpdate(ANA, {
      confirmedDraftId: draftId,
      conversationId: 'conv_ana',
      ticketCode: 'INC-20311',
      comment: 'Agora também trava ao abrir o Teams.',
    });
    expect(updated.history.at(-1)).toMatchObject({ type: 'COMMENT_ADDED', comment: 'Agora também trava ao abrir o Teams.' });
    // continua vencido: a atualização não esconde o atraso
    expect(updated.isOverdue).toBe(true);
  });

  it('reabre chamado resolvido recentemente e recusa o resolvido há 12 dias', async () => {
    const reopenPayload = (code: string): DraftPayload => ({ operation: 'REOPEN', ticketCode: code, reason: 'O problema voltou a acontecer.' });
    const command = (draftId: string, code: string) => ({
      confirmedDraftId: draftId,
      conversationId: code === 'INC-20290' ? 'conv_bruno' : 'conv_ana',
      ticketCode: code,
      reason: 'O problema voltou a acontecer.',
    });

    const ok = await confirmedDraft(BRUNO.employeeId, reopenPayload('INC-20290'));
    const reopened = await service.reopen(BRUNO, command(ok, 'INC-20290'));
    expect(reopened.status).toBe('WAITING_ANALYST');
    expect(reopened.history.at(-1)?.type).toBe('REOPENED');

    const expired = await confirmedDraft(ANA.employeeId, reopenPayload('INC-19980'));
    expect(await codeOf(service.reopen(ANA, command(expired, 'INC-19980')))).toBe('REOPEN_WINDOW_EXPIRED');
  });
});

describe('indisponibilidade temporária (PostgreSQL)', () => {
  it('resposta perdida depois de gravar: a repetição não duplica o chamado', async () => {
    const fields: TicketFields = {
      ...FIELDS,
      title: 'Fone de ouvido com ruído',
      description: 'O fone de ouvido corporativo está com ruído constante nas chamadas.',
    };
    const draftId = await confirmedDraft(ANA.employeeId, createPayload(fields));
    const resilient = withRetry(
      withSimulatedOutages(service, { outageFor: ({ callNumber }) => (callNumber <= 2 ? 'after' : null) }),
      { sleep: () => Promise.resolve() },
    );
    const before = await prisma.ticket.count();
    const created = await resilient.create(ANA, createCommand(draftId, 'conv_ana', fields));
    expect(created.title).toBe(fields.title);
    expect(await prisma.ticket.count()).toBe(before + 1);
  });

  it('banco inacessível vira UNAVAILABLE (retryable), sem vazar credenciais', async () => {
    const dead = createPrismaClient('postgresql://ninguem:senha-secreta@127.0.0.1:1/inexistente');
    try {
      const broken = createTicketService({
        store: createPrismaTicketStore(dead),
        confirmations: createPrismaConfirmationGate(dead),
        clock,
      });
      const error = await broken.listForRequester(ANA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TicketServiceError);
      expect((error as TicketServiceError).code).toBe('UNAVAILABLE');
      expect(JSON.stringify({ message: (error as Error).message, details: (error as TicketServiceError).details })).not.toContain('senha-secreta');
    } finally {
      await dead.$disconnect();
    }
  });
});

describe('persistência entre reinícios', () => {
  it('um cliente novo enxerga os chamados criados antes', async () => {
    const fresh = createPrismaClient(db.url);
    try {
      const restarted = createTicketService({
        store: createPrismaTicketStore(fresh),
        confirmations: createPrismaConfirmationGate(fresh),
        clock,
      });
      const titles = (await restarted.listForRequester(ANA)).map((t) => t.title);
      expect(titles).toContain('Teclado com teclas falhando');
    } finally {
      await fresh.$disconnect();
    }
  });
});
