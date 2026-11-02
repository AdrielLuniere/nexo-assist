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
