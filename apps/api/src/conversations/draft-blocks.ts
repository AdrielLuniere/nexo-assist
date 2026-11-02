import type { Message, MessageBlock } from '@nexo/shared';
import type { DraftRecord } from '../drafts/draft-repository.js';

/** Leitura do estado gravado de um rascunho (as duas implementações de `DraftRepository` atendem). */
export interface DraftLookup {
  findById(id: string): Promise<DraftRecord | null>;
}

/**
 * O bloco `draft` de uma mensagem é o retrato do rascunho no momento em que o agente o propôs
 * (`PENDING`). Ao ler o histórico, troca status, chamado resultante e data de confirmação pelo estado
 * atual, para que a interface não ofereça "Confirmar" num rascunho já confirmado, descartado ou
 * substituído. O conteúdo proposto (payload) não muda. Rascunho de outra conversa é ignorado.
 */
export async function withCurrentDrafts(messages: Message[], drafts: DraftLookup | undefined): Promise<Message[]> {
  if (!drafts) return messages;
  const ids = new Set(messages.flatMap((m) => m.blocks.flatMap((b) => (b.type === 'draft' ? [b.draft.id] : []))));
  if (ids.size === 0) return messages;

  const current = new Map<string, DraftRecord>();
  await Promise.all(
    [...ids].map(async (id) => {
      const record = await drafts.findById(id);
      if (record) current.set(id, record);
    }),
  );

  const refresh = (message: Message, block: MessageBlock): MessageBlock => {
    if (block.type !== 'draft') return block;
    const record = current.get(block.draft.id);
    if (!record || record.conversationId !== message.conversationId) return block;
    return {
      ...block,
      draft: {
        ...block.draft,
        status: record.status,
        resultTicketCode: record.resultTicketCode,
        confirmedAt: record.confirmedAt?.toISOString() ?? null,
      },
    };
  };
  return messages.map((message) =>
    message.blocks.some((b) => b.type === 'draft') ? { ...message, blocks: message.blocks.map((b) => refresh(message, b)) } : message,
  );
}
