import type { ConsoleConversationDetail, ConsoleConversationItem, ConversationStatus, Message, User } from '@nexo/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ApiClient, errorMessage, isApiError } from '../lib/api';
import { mergeMessages } from '../lib/format';

/**
 * Estado do console. Não há stream de eventos para o analista no contrato, então a fila e a conversa
 * aberta são relidas periodicamente (e logo depois de cada ação). Toda ação envia a `version` que o
 * analista está vendo; se a conversa mudou, a API recusa (409) e a tela recarrega o estado real.
 */

export type QueueFilter = 'ALL' | 'WAITING' | 'MINE' | 'IN_SERVICE' | 'WITH_AGENT' | 'CLOSED';

export const QUEUE_FILTERS: ReadonlyArray<{ id: QueueFilter; label: string }> = [
  { id: 'ALL', label: 'Todas' },
  { id: 'WAITING', label: 'Aguardando' },
  { id: 'MINE', label: 'Minhas' },
  { id: 'IN_SERVICE', label: 'Em atendimento' },
  { id: 'WITH_AGENT', label: 'Com o agente' },
  { id: 'CLOSED', label: 'Encerradas' },
];

const STATUS_OF: Record<QueueFilter, ConversationStatus | undefined> = {
  ALL: undefined,
  WAITING: 'WAITING_ANALYST',
  MINE: 'WITH_ANALYST',
  IN_SERVICE: 'WITH_ANALYST',
  WITH_AGENT: 'WITH_AGENT',
  CLOSED: 'CLOSED',
};

export interface ConsoleFeedback {
  readonly tone: 'error' | 'warning' | 'success';
  readonly message: string;
}

export function useConsole(client: ApiClient, me: User, pollMs: number) {
  const [filter, setFilter] = useState<QueueFilter>('ALL');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ConsoleConversationItem[]>([]);
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConsoleConversationDetail | null>(null);
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [busy, setBusy] = useState<'assume' | 'return' | 'close' | 'send' | null>(null);
  const [feedback, setFeedback] = useState<ConsoleFeedback | null>(null);
  const [failedSend, setFailedSend] = useState<{ clientMessageId: string; content: string } | null>(null);
  const selectedRef = useRef<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const status = STATUS_OF[filter];
      const page = await client.console.list({ ...(status ? { status } : {}), ...(query.trim() ? { q: query.trim() } : {}), limit: 100 });
      setItems(filter === 'MINE' ? page.items.filter((i) => i.assignedAnalystId === me.id) : page.items);
      setListState('ready');
    } catch {
      setListState((state) => (state === 'ready' ? state : 'error'));
    }
  }, [client, filter, query, me.id]);

  const loadDetail = useCallback(
    async (id: string) => {
      try {
        const loaded = await client.console.get(id);
        if (selectedRef.current !== id) return;
        setDetail((current) => (current?.id === id ? { ...loaded, messages: mergeMessages(current.messages, loaded.messages) } : loaded));
        setDetailState('ready');
      } catch (error) {
        if (selectedRef.current !== id) return;
        setDetailState((state) => (state === 'ready' ? state : 'error'));
        if (isApiError(error, 'NOT_FOUND')) setFeedback({ tone: 'error', message: 'Esta conversa não está mais disponível no console.' });
      }
    },
    [client],
  );

  // Fila: ao mudar filtro/busca (com uma pequena espera ao digitar) e periodicamente.
  useEffect(() => {
    const timer = setTimeout(() => void loadList(), query ? 250 : 0);
    const poll = setInterval(() => void loadList(), pollMs);
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
    };
  }, [loadList, pollMs, query]);

  useEffect(() => {
    if (!selectedId) return;
    const poll = setInterval(() => void loadDetail(selectedId), pollMs);
    return () => clearInterval(poll);
  }, [selectedId, loadDetail, pollMs]);

  const select = useCallback(
    (id: string | null) => {
      selectedRef.current = id;
      setSelectedId(id);
      setDetail(null);
      setFeedback(null);
      setFailedSend(null);
      setDetailState(id ? 'loading' : 'idle');
      if (id) void loadDetail(id);
    },
    [loadDetail],
  );

  const act = useCallback(
    async (action: 'assume' | 'return' | 'close') => {
      if (!detail) return;
      const id = detail.id;
      setBusy(action);
      setFeedback(null);
      try {
        await client.console.act(id, action, detail.version);
        const done = { assume: 'Você assumiu a conversa. O agente está pausado.', return: 'Conversa devolvida ao agente.', close: 'Atendimento encerrado.' } as const;
        setFeedback({ tone: 'success', message: done[action] });
      } catch (error) {
        if (isApiError(error, 'CONFLICT')) {
          setFeedback({ tone: 'warning', message: 'A conversa foi alterada por outra pessoa enquanto você a via. Atualizamos a tela com o estado atual.' });
        } else {
          setFeedback({ tone: 'error', message: errorMessage(error) });
        }
      } finally {
        setBusy(null);
        await loadDetail(id);
        void loadList();
      }
    },
    [client, detail, loadDetail, loadList],
  );

  const send = useCallback(
    async (content: string, retryOf?: { clientMessageId: string; content: string }) => {
      if (!detail) return false;
      const id = detail.id;
      const body = retryOf ?? { clientMessageId: crypto.randomUUID(), content: content.trim() };
      if (!body.content) return false;
      setBusy('send');
      setFeedback(null);
      try {
        const message: Message = await client.console.sendMessage(id, body);
        setFailedSend(null);
        setDetail((d) => (d?.id === id ? { ...d, messages: mergeMessages(d.messages, [message]) } : d));
        return true;
      } catch (error) {
        // Sem resposta da API: repetir com o mesmo id não duplica a mensagem.
        if (isApiError(error, 'NETWORK_ERROR')) setFailedSend(body);
        setFeedback({ tone: 'error', message: errorMessage(error) });
        void loadDetail(id);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [client, detail, loadDetail],
  );

  return {
    filter,
    setFilter,
    query,
    setQuery,
    items,
    listState,
    selectedId,
    select,
    detail,
    detailState,
    busy,
    feedback,
    dismissFeedback: () => setFeedback(null),
    failedSend,
    act,
    send,
    reload: () => {
      void loadList();
      if (selectedRef.current) void loadDetail(selectedRef.current);
    },
  };
}

export type ConsoleController = ReturnType<typeof useConsole>;
