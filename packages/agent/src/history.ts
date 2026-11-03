import { DRAFT_OPERATIONS, type Message, type MessageBlock } from '@nexo/shared';

/**
 * Converte o histórico persistido da conversa em mensagens para o modelo.
 *
 * - Janela: só as últimas `limit` mensagens (custo por conversa previsível). O limite de 30 mensagens
 *   do funcionário por sessão mantém conversas curtas; a janela cobre a sessão inteira na prática.
 * - Funcionário → `user`; agente e analista → `assistant` (o analista identificado no texto).
 * - Blocos estruturados viram anotações curtas ("[cards: INC-20311]") para o modelo manter o contexto
 *   do que o funcionário viu sem reenviar os dados completos.
 * - Mensagens consecutivas do mesmo papel são unidas e a conversa sempre começa por `user`, como os
 *   provedores exigem.
 */

export type ModelTurn = { readonly role: 'user'; readonly content: string } | { readonly role: 'assistant'; readonly content: string };

const OPERATION_TEXT: Record<(typeof DRAFT_OPERATIONS)[number], string> = {
  CREATE: 'abertura',
  UPDATE: 'atualização',
  REOPEN: 'reabertura',
};

/**
 * Estado ATUAL do rascunho (a API o atualiza antes de montar o histórico). O modelo não pode deduzir isto
 * das mensagens antigas: um rascunho já confirmado continua aparecendo como "mostrado para confirmação"
 * em mensagens anteriores, e orientar a confirmá-lo de novo seria errado.
 */
const DRAFT_STATE_TEXT: Record<'PENDING' | 'CONFIRMED' | 'DISCARDED' | 'SUPERSEDED', (ticketCode: string | null) => string> = {
  PENDING: () => 'AGUARDANDO confirmação do funcionário; nada foi criado ainda',
  CONFIRMED: (code) => `JÁ CONFIRMADO${code ? `, chamado ${code} criado` : ''}; NÃO peça para confirmar de novo e não crie outro igual`,
  DISCARDED: () => 'DESCARTADO pelo funcionário; nada foi criado',
  SUPERSEDED: () => 'SUBSTITUÍDO por um rascunho mais novo; não vale mais',
};

function annotate(block: MessageBlock): string | null {
  switch (block.type) {
    case 'text':
      return null;
    case 'ticket_cards':
      return `[cards: ${block.tickets.map((t) => t.code).join(', ')}]`;
    case 'ticket_selection':
      return `[pediu para escolher entre: ${block.options.map((t) => t.code).join(', ')}]`;
    case 'draft': {
      const { payload, status, resultTicketCode } = block.draft;
      const target = payload.operation === 'CREATE' ? payload.fields.title : payload.ticketCode;
      return `[rascunho de ${OPERATION_TEXT[payload.operation]} (${target}): ${DRAFT_STATE_TEXT[status](resultTicketCode)}]`;
    }
    case 'quick_replies':
      return `[opções: ${block.options.map((o) => o.label).join(' | ')}]`;
    case 'handoff_notice':
      return '[conversa transferida para um analista]';
  }
}

function render(message: Message): ModelTurn | null {
  const notes = message.blocks.map(annotate).filter((note): note is string => note !== null);
  const text = [message.content.trim(), ...notes].filter(Boolean).join('\n');
  if (!text) return null;
  switch (message.role) {
    case 'EMPLOYEE':
      return { role: 'user', content: text };
    case 'AGENT':
      return { role: 'assistant', content: text };
    case 'ANALYST':
      return { role: 'assistant', content: `[mensagem do analista] ${text}` };
    case 'SYSTEM':
      return { role: 'assistant', content: `[aviso do sistema] ${text}` };
  }
}

export function toModelTurns(history: readonly Message[], limit: number): ModelTurn[] {
  const turns: ModelTurn[] = [];
  for (const message of history.slice(-limit)) {
    const turn = render(message);
    if (!turn) continue;
    const last = turns.at(-1);
    if (last && last.role === turn.role) turns[turns.length - 1] = { ...last, content: `${last.content}\n\n${turn.content}` };
    else turns.push(turn);
  }
  while (turns[0]?.role === 'assistant') turns.shift();
  return turns;
}
