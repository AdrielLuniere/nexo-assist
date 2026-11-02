import type { HelpArticle, Message, TicketDetail, TicketSummary } from '@nexo/shared';
import { vi } from 'vitest';
import type { AgentReadPorts } from './ports.js';

/**
 * Dados e portas falsas para os testes do pacote (não entra no build: só arquivos de teste importam).
 * Funcionária: Ana. "Agora" é segunda, 02/11/2026, 09h em Brasília.
 */

export const NOW = new Date('2026-11-02T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function detail(summary: Omit<TicketSummary, 'updatedAt'> & Partial<TicketDetail>): TicketDetail {
  return {
    updatedAt: days(6),
    description: 'Descrição registrada no chamado.',
    affectedScope: 'INDIVIDUAL',
    affectedDescription: 'Somente a Ana',
    createdAt: days(10),
    resolvedAt: null,
    history: [],
    ...summary,
  };
}

export const ANA_TICKETS: TicketDetail[] = [
  detail({ code: 'INC-20311', type: 'INC', title: 'Notebook lento após atualização do Windows', category: 'HARDWARE', priority: 'MEDIUM', status: 'WAITING_ANALYST', slaDueAt: days(3), isOverdue: true }),
  detail({ code: 'INC-20150', type: 'INC', title: 'Senha do SAP bloqueada', category: 'ACCESS', priority: 'MEDIUM', status: 'RESOLVED', slaDueAt: days(5), isOverdue: false, resolvedAt: days(4), updatedAt: days(4) }),
  detail({ code: 'INC-19980', type: 'INC', title: 'VPN caindo toda hora', category: 'NETWORK_VPN', priority: 'MEDIUM', status: 'RESOLVED', slaDueAt: days(14), isOverdue: false, resolvedAt: days(12), updatedAt: days(12) }),
  detail({ code: 'REQ-10442', type: 'REQ', title: 'Segundo monitor para home office', category: 'HARDWARE', priority: 'LOW', status: 'APPROVED', slaDueAt: days(-2), isOverdue: false }),
];

/** Chamado de outra pessoa: nunca deve aparecer para a Ana. */
export const FOREIGN_TICKET = detail({ code: 'INC-20344', type: 'INC', title: 'Sem acesso ao CRM', category: 'ACCESS', priority: 'HIGH', status: 'WAITING_ANALYST', slaDueAt: days(-1), isOverdue: false });

export const ARTICLES: HelpArticle[] = [
  {
    id: 'kb_vpn_erro_809',
    slug: 'vpn-erro-809',
    title: 'VPN com erro 809',
    body: 'Reinstale o cliente de VPN pelo portal de softwares e reinicie. Vale apenas para Windows 10; no Windows 11, abra um chamado.',
    category: 'NETWORK_VPN',
    tags: ['vpn'],
  },
  { id: 'kb_notebook_lento', slug: 'notebook-lento', title: 'Notebook lento', body: 'Reinicie e confira atualizações.', category: 'HARDWARE', tags: ['notebook'] },
];

const summaryOf = ({ description: _d, affectedScope: _s, affectedDescription: _a, createdAt: _c, resolvedAt: _r, history: _h, ...summary }: TicketDetail): TicketSummary =>
  summary;

export interface FakePorts extends AgentReadPorts {
  readonly searchHelpCenter: ReturnType<typeof vi.fn<AgentReadPorts['searchHelpCenter']>>;
  readonly listMyTickets: ReturnType<typeof vi.fn<AgentReadPorts['listMyTickets']>>;
  readonly getMyTicket: ReturnType<typeof vi.fn<AgentReadPorts['getMyTicket']>>;
  readonly findDuplicateTickets: ReturnType<typeof vi.fn<AgentReadPorts['findDuplicateTickets']>>;
}

/** Portas da Ana. Duplicidade: qualquer coisa com "notebook" ou "lento" bate com INC-20311. */
export function fakePorts(): FakePorts {
  return {
    searchHelpCenter: vi.fn(async (query: string) => {
      const q = query.toLowerCase();
      return ARTICLES.filter((a) => q.split(/\s+/).some((word) => word.length > 2 && `${a.title} ${a.body}`.toLowerCase().includes(word)));
    }),
    listMyTickets: vi.fn(async (options?: { onlyOpen?: boolean }) =>
      ANA_TICKETS.filter((t) => !options?.onlyOpen || ['WAITING_ANALYST', 'IN_PROGRESS', 'APPROVED'].includes(t.status)).map(summaryOf),
    ),
    getMyTicket: vi.fn(async (code: string) => ANA_TICKETS.find((t) => t.code === code) ?? null),
    findDuplicateTickets: vi.fn(async ({ title, description }: { title: string; description: string }) =>
      /notebook|lento/i.test(`${title} ${description}`) ? [summaryOf(ANA_TICKETS[0]!)] : [],
    ),
  };
}

let sequence = 0;
export function employeeMessage(content: string, minutesAgo = 0): Message {
  return {
    id: `msg_${++sequence}`,
    conversationId: 'conv_ana',
    role: 'EMPLOYEE',
    authorId: 'usr_ana',
    content,
    blocks: [],
    decisionId: null,
    createdAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  };
}

/** Proposta final mínima e válida; os testes sobrescrevem o que importa. */
export const proposal = (overrides: Record<string, unknown> = {}) => ({
  intent: 'ASK_QUESTION',
  understanding: 'Pergunta de TI.',
  action: 'REPLY',
  confidence: 0.9,
  rationale: 'Resposta direta.',
  reply: 'Certo!',
  ...overrides,
});
