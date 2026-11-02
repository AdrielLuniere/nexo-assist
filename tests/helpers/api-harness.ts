import type { DraftPayload, TicketFields, User } from '@nexo/shared';
import {
  type OutagePlan,
  type TicketRecord,
  type TicketService,
  createInMemoryTicketStore,
  createTicketService,
  withRetry,
  withSimulatedOutages,
} from '@nexo/ticket-service';
import { type Server, createServer } from 'node:http';
import type { Express } from 'express';
import { type HttpTarget, request } from './http.js';
import { afterAll, afterEach, vi } from 'vitest';
import { createAuthService } from '../../apps/api/src/auth/auth-service.js';
import { createInMemoryConversationRepository } from '../../apps/api/src/conversations/conversation-repository.js';
import { createConversationService } from '../../apps/api/src/conversations/conversation-service.js';
import type { AgentResponder } from '../../apps/api/src/conversations/responder.js';
import { createInMemoryUserRepository } from '../../apps/api/src/auth/user-repository.js';
import { createDraftRepositoryGate } from '../../apps/api/src/drafts/draft-gate.js';
import { createInMemoryDraftRepository } from '../../apps/api/src/drafts/draft-repository.js';
import { createDraftService } from '../../apps/api/src/drafts/draft-service.js';
import { createApp } from '../../apps/api/src/http/app.js';

export const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres!!';
export const local = (iso: string) => new Date(`${iso}-03:00`);

export const ANA: User = { id: 'usr_ana', email: 'ana.souza@nexo.com.br', name: 'Ana Souza', role: 'EMPLOYEE', analystLevel: null, department: 'Marketing' };
export const BRUNO: User = { id: 'usr_bruno', email: 'bruno.lima@nexo.com.br', name: 'Bruno Lima', role: 'EMPLOYEE', analystLevel: null, department: 'Comercial' };
export const MARCOS: User = { id: 'usr_marcos', email: 'marcos.oliveira@nexo.com.br', name: 'Marcos Oliveira', role: 'ANALYST', analystLevel: 'N1', department: 'Service Desk de TI' };
export const PAULA: User = { id: 'usr_paula', email: 'paula.santos@nexo.com.br', name: 'Paula Santos', role: 'ANALYST', analystLevel: 'N2', department: 'Service Desk de TI' };
export const USERS = [ANA, BRUNO, MARCOS, PAULA];

export const CONV_ANA = 'conv_ana';
export const CONV_BRUNO = 'conv_bruno';

function ticket(o: Partial<TicketRecord> & Pick<TicketRecord, 'id' | 'code' | 'requesterId' | 'title'>): TicketRecord {
  return {
    type: 'INC',
    description: 'Descrição de exemplo do chamado para os testes.',
    category: 'HARDWARE',
    priority: 'MEDIUM',
    status: 'WAITING_ANALYST',
    affectedScope: 'INDIVIDUAL',
    affectedDescription: 'Somente o solicitante',
    slaDueAt: local('2026-11-05T10:00:00'),
    firstResponseAt: null,
    resolvedAt: null,
    closedAt: null,
    originConversationId: null,
    createdAt: local('2026-10-26T09:00:00'),
    updatedAt: local('2026-10-27T10:00:00'),
    ...o,
  };
}

export const TICKETS: TicketRecord[] = [
  // vencido (prazo em 30/10, "agora" é 02/11)
  ticket({ id: 't1', code: 'INC-20311', requesterId: ANA.id, title: 'Notebook lento após atualização do Windows', slaDueAt: local('2026-10-30T10:00:00') }),
  // resolvido há 4 dias: pode ser reaberto
  ticket({ id: 't2', code: 'INC-20150', requesterId: ANA.id, title: 'Senha do SAP bloqueada', category: 'ACCESS', status: 'RESOLVED', resolvedAt: local('2026-10-29T10:00:00'), updatedAt: local('2026-10-29T10:00:00') }),
  // resolvido há 12 dias: fora da janela
  ticket({ id: 't3', code: 'INC-19980', requesterId: ANA.id, title: 'VPN caindo toda hora', category: 'NETWORK_VPN', status: 'RESOLVED', resolvedAt: local('2026-10-21T10:00:00'), updatedAt: local('2026-10-21T10:00:00') }),
  // de outro funcionário
  ticket({ id: 't4', code: 'INC-20344', requesterId: BRUNO.id, title: 'Sem acesso ao CRM', category: 'ACCESS', priority: 'HIGH', slaDueAt: local('2026-11-02T14:00:00') }),
];

export const NEW_FIELDS: TicketFields = {
  type: 'INC',
  title: 'Outlook não sincroniza e-mails',
  description: 'O Outlook parou de receber novos e-mails desde ontem à tarde.',
  category: 'EMAIL',
  priority: 'HIGH',
  affectedScope: 'INDIVIDUAL',
  affectedDescription: 'Somente o solicitante',
};

export const createPayload = (fields: TicketFields = NEW_FIELDS): DraftPayload => ({
  operation: 'CREATE',
  fields,
  priorityAssessment: { priority: fields.priority, impact: 'Afeta uma pessoa', urgency: 'Impede o trabalho', rationale: 'Impede uma pessoa de trabalhar: prioridade Alta.' },
});
export const updatePayload = (ticketCode: string, comment: string): DraftPayload => ({ operation: 'UPDATE', ticketCode, comment });
export const reopenPayload = (ticketCode: string): DraftPayload => ({ operation: 'REOPEN', ticketCode, reason: 'O problema voltou a acontecer.' });

export interface HarnessOptions {
  readonly outages?: OutagePlan;
  /** Envolve o serviço com `withRetry` (padrão: sim, sem espera real). */
  readonly retry?: boolean;
  /** Substitui o serviço de chamados (ex.: um que lança erro inesperado). */
  readonly ticketServiceOverride?: (real: TicketService) => TicketService;
  readonly sessionTtlSeconds?: number;
  readonly responder?: AgentResponder;
  readonly messageLimit?: number;
}

export async function buildHarness(options: HarnessOptions = {}) {
  const clock = { current: local('2026-11-02T10:00:00') };
  const now = () => clock.current;

  const store = createInMemoryTicketStore({ tickets: TICKETS, sequences: { INC: 20344, REQ: 10442 } });
  const drafts = createInMemoryDraftRepository(now);
  const realTickets = createTicketService({ store, confirmations: createDraftRepositoryGate(drafts), clock: { now } });

  let tickets: TicketService = realTickets;
  if (options.outages) tickets = withSimulatedOutages(tickets, options.outages);
  if (options.retry !== false) tickets = withRetry(tickets, { sleep: () => Promise.resolve() });
  if (options.ticketServiceOverride) tickets = options.ticketServiceOverride(tickets);

  const conversations = createInMemoryConversationRepository();
  const users = createInMemoryUserRepository(USERS);
  const auth = createAuthService({ users, secret: SECRET, sessionTtlSeconds: options.sessionTtlSeconds ?? 3600, now });
  const logger = { error: vi.fn() };
  const expressApp: Express = createApp({
    checkDatabase: async () => ({ status: 'up' }),
    version: 'test',
    startedAt: new Date(),
    logger,
    api: {
      auth,
      tickets,
      drafts: createDraftService({ drafts, tickets, now }),
      conversations: createConversationService({ conversations, now, ...(options.messageLimit ? { messageLimit: options.messageLimit } : {}) }),
      ...(options.responder ? { responder: options.responder } : {}),
    },
  });

  const app = await serve(expressApp);
  let counter = 0;
  return {
    app,
    express: expressApp,
    clock,
    drafts,
    conversations,
    logger,
    /** Serviço sem retry nem simulação de queda, para consultar o estado real. */
    realTickets,
    async login(user: User): Promise<string> {
      const res = await request(app).post('/api/auth/login').send({ email: user.email, password: 'qualquer' });
      return (res.body as { token: string }).token;
    },
    /** Registra um rascunho propondo `payload` (o que o agente faria). */
    addDraft(owner: User, payload: DraftPayload, conversationId = owner === BRUNO ? CONV_BRUNO : CONV_ANA, status: 'PENDING' | 'CONFIRMED' | 'DISCARDED' = 'PENDING') {
      const id = `drf_${++counter}`;
      drafts.addDraft({
        id,
        conversationId,
        employeeId: owner.id,
        operation: payload.operation,
        payload,
        status,
        createdAt: now(),
        conversationOwnerId: owner.id,
        conversationStatus: 'WITH_AGENT',
      });
      return id;
    },
  };
}

/** Lê um corpo `text/event-stream` em eventos `{ event, data }`. */
export function parseSse(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? '';
      const data = lines.find((l) => l.startsWith('data: '))?.slice(6) ?? '{}';
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

/** Alvo aceito pelo cliente de teste (`helpers/http.ts`): URL, servidor escutando ou app. */
export type RequestTarget = HttpTarget;

/**
 * Sobe UM servidor para uma rajada de requisições simultâneas. Com `request(app)`, cada chamada cria o
 * seu próprio servidor; dezenas ao mesmo tempo derrubavam o worker do Vitest no Windows.
 */
export async function withServer<T>(app: Express | string, work: (server: RequestTarget) => Promise<T>): Promise<T> {
  if (typeof app === 'string') return work(app); // já servido por `serve`
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await work(server);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const servers = { test: new Set<Server>(), file: new Set<Server>() };

async function closeAll(set: Set<Server>): Promise<void> {
  const open = [...set];
  set.clear();
  await Promise.all(
    open.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
}

afterEach(() => closeAll(servers.test));
afterAll(() => closeAll(servers.file));

/**
 * Serve o app em UM servidor HTTP e devolve a URL base. `request(url)` reaproveita esse servidor; com
 * `request(app)` o supertest sobe e derruba um servidor novo a cada chamada, e centenas deles por
 * arquivo causavam abortos nativos intermitentes do worker do Vitest no Windows.
 * `scope: 'test'` (padrão) fecha ao fim de cada teste; `'file'` fecha ao fim do arquivo.
 */
export async function serve(app: Express, scope: 'test' | 'file' = 'test'): Promise<string> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  servers[scope].add(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('servidor de teste não iniciou');
  return `http://127.0.0.1:${address.port}`;
}

export type Harness = Awaited<ReturnType<typeof buildHarness>>;

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
