import type { Message } from '@nexo/shared';
import { describe, expect, it } from 'vitest';
import { ANA_TICKETS } from './agent.fixtures.js';
import { toModelTurns } from './history.js';

const message = (role: Message['role'], content: string, blocks: Message['blocks'] = []): Message => ({
  id: `msg_${Math.random().toString(36).slice(2)}`,
  conversationId: 'conv',
  role,
  authorId: null,
  content,
  blocks,
  decisionId: null,
  createdAt: new Date().toISOString(),
});

describe('rascunhos no histórico enviado ao modelo', () => {
  const payload = { operation: 'CREATE', fields: { type: 'INC', title: 'VPN não conecta', description: 'Descrição longa o bastante.', category: 'NETWORK_VPN', priority: 'HIGH', affectedScope: 'INDIVIDUAL', affectedDescription: 'Somente a Ana' }, priorityAssessment: { priority: 'HIGH', impact: 'i', urgency: 'u', rationale: 'r' } } as const;
  const draftMessage = (status: 'PENDING' | 'CONFIRMED' | 'DISCARDED' | 'SUPERSEDED', resultTicketCode: string | null) =>
    message('AGENT', 'Confira o rascunho.', [{ type: 'draft', draft: { id: 'drf_1', conversationId: 'conv', status, payload, resultTicketCode, createdAt: new Date().toISOString(), confirmedAt: null } }]);
  const note = (status: 'PENDING' | 'CONFIRMED' | 'DISCARDED' | 'SUPERSEDED', code: string | null = null) =>
    toModelTurns([message('EMPLOYEE', 'oi'), draftMessage(status, code)], 10)[1]?.content ?? '';

  it('o modelo recebe o estado atual: aguardando, confirmado (com o chamado), descartado e substituído', () => {
    expect(note('PENDING')).toContain('AGUARDANDO confirmação');
    expect(note('CONFIRMED', 'INC-20353')).toContain('JÁ CONFIRMADO, chamado INC-20353 criado; NÃO peça para confirmar de novo');
    expect(note('DISCARDED')).toContain('DESCARTADO');
    expect(note('SUPERSEDED')).toContain('SUBSTITUÍDO');
  });

  it('rascunho confirmado nunca é anotado como "mostrado para confirmação"', () => {
    expect(note('CONFIRMED', 'INC-1')).not.toMatch(/mostrado para confirmação|AGUARDANDO/);
  });
});

describe('histórico enviado ao modelo', () => {
  it('mapeia papéis, anota blocos e une mensagens seguidas do mesmo papel', () => {
    const turns = toModelTurns(
      [
        message('EMPLOYEE', 'Meus chamados?'),
        message('AGENT', 'Aqui estão.', [{ type: 'ticket_cards', tickets: [ANA_TICKETS[0]!] }]),
        message('ANALYST', 'Oi, sou o Marcos.'),
        message('EMPLOYEE', 'Obrigada'),
      ],
      20,
    );
    expect(turns).toEqual([
      { role: 'user', content: 'Meus chamados?' },
      { role: 'assistant', content: 'Aqui estão.\n[cards: INC-20311]\n\n[mensagem do analista] Oi, sou o Marcos.' },
      { role: 'user', content: 'Obrigada' },
    ]);
  });

  it('respeita a janela e sempre começa pelo funcionário', () => {
    const history = [message('EMPLOYEE', 'a'), message('AGENT', 'b'), message('EMPLOYEE', 'c'), message('AGENT', 'd'), message('EMPLOYEE', 'e')];
    expect(toModelTurns(history, 2)).toEqual([{ role: 'user', content: 'e' }]);
    expect(toModelTurns(history, 3).map((t) => t.content)).toEqual(['c', 'd', 'e']);
  });
});
