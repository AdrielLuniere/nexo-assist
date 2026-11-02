import {
  type AgentDecision,
  type AgentStep,
  type ChatStreamEvent,
  type ConversationDetail,
  type ConversationSummary,
  MAX_EMPLOYEE_MESSAGES_PER_SESSION,
  type Message,
  type TicketDraft,
} from '@nexo/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ApiClient, ApiError, errorMessage, isApiError } from '../lib/api';
import { type EventsConnection, watchConversation } from '../lib/conversation-events';
import { mergeMessages } from '../lib/format';

/**
 * Estado do chat do funcionário. A fonte da verdade é sempre a API: o histórico vem de
 * `GET /api/conversations/:id`, as respostas do agente chegam pelo stream de `messages`/`resume` e as
 * mensagens do analista e mudanças de estado pelo stream de eventos. A tela só junta (sem repetir, por
 * id) o que chega de cada lado.
 */

export interface ChatError {
  readonly message: string;
  /** O que o botão "Tentar de novo" faz. */
  readonly retry: 'resume' | 'send' | 'reload' | null;
}

interface PendingSend {
  readonly clientMessageId: string;
  readonly content: string;
}

export interface ChatController {
  readonly conversations: ConversationSummary[];
  readonly listState: 'loading' | 'ready' | 'error';
  readonly activeId: string | null;
  readonly detail: ConversationDetail | null;
  readonly detailState: 'idle' | 'loading' | 'ready' | 'error';
  readonly decisions: ReadonlyMap<string, AgentDecision>;
  /** O agente está respondendo agora; `steps` são os passos reais recebidos até aqui. */
  readonly live: { readonly steps: AgentStep[] } | null;
  /** Mensagem enviada e ainda não confirmada pelo servidor (aparece esmaecida). */
  readonly sending: PendingSend | null;
  readonly error: ChatError | null;
  readonly notice: string | null;
  readonly connection: EventsConnection;
  readonly draftBusy: { readonly draftId: string; readonly action: 'confirm' | 'discard' } | null;
  readonly handoffBusy: boolean;
  readonly remaining: number;
  open(id: string): void;
  startNew(): Promise<void>;
  send(text: string): Promise<void>;
  retry(): void;
  dismissError(): void;
  requestAnalyst(): Promise<void>;
  confirmDraft(draftId: string): Promise<void>;
  discardDraft(draftId: string): Promise<void>;
}

const newId = () => crypto.randomUUID();

function replaceDraft(messages: Message[], draft: TicketDraft): Message[] {
  return messages.map((message) =>
    message.blocks.some((b) => b.type === 'draft' && b.draft.id === draft.id)
      ? { ...message, blocks: message.blocks.map((b) => (b.type === 'draft' && b.draft.id === draft.id ? { ...b, draft: { ...b.draft, status: draft.status, resultTicketCode: draft.resultTicketCode, confirmedAt: draft.confirmedAt } } : b)) }
      : message,
  );
}

export function useChat(client: ApiClient, options: { retryDelays?: readonly number[] } = {}): ChatController {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [listState, setListState] = useState<ChatController['listState']>('loading');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [detailState, setDetailState] = useState<ChatController['detailState']>('idle');
  const [live, setLive] = useState<ChatController['live']>(null);
  const [sending, setSending] = useState<PendingSend | null>(null);
  const [error, setError] = useState<ChatError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connection, setConnection] = useState<EventsConnection>('stopped');
  const [draftBusy, setDraftBusy] = useState<ChatController['draftBusy']>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);

  const activeRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const lastFailedSend = useRef<PendingSend | null>(null);
  const autoResumed = useRef(new Set<string>());
  /** Maior versão da conversa aberta já vista (ignora eventos de estado antigos ou repetidos). */
  const versionRef = useRef(-1);

  const refreshList = useCallback(async () => {
    try {
      const items = await client.listConversations();
      setConversations(items);
      setListState('ready');
      return items;
    } catch {
      setListState((state) => (state === 'loading' ? 'error' : state));
      return null;
    }
  }, [client]);

  const loadDetail = useCallback(
    async (id: string) => {
      try {
        const loaded = await client.getConversation(id);
        if (activeRef.current !== id) return null;
        setDetail((current) => (current && current.id === id ? { ...loaded, messages: mergeMessages(current.messages, loaded.messages) } : loaded));
        setDetailState('ready');
        return loaded;
      } catch (err) {
        if (activeRef.current === id) {
          setDetailState((state) => (state === 'ready' ? state : 'error'));
          setError({ message: errorMessage(err), retry: 'reload' });
        }
        return null;
      }
    },
    [client],
  );

  /** Aplica um evento do stream de resposta (envio ou retomada). */
  const applyStream = useCallback(
    (id: string, event: ChatStreamEvent) => {
      if (activeRef.current !== id) return;
      switch (event.event) {
        case 'message.accepted':
          setSending(null);
          setDetail((d) =>
            d && d.id === id
              ? {
                  ...d,
                  messages: mergeMessages(d.messages, [event.data.message]),
                  employeeMessageCount: d.messages.some((m) => m.id === event.data.message.id) ? d.employeeMessageCount : d.employeeMessageCount + 1,
                  title: d.title ?? event.data.message.content.slice(0, 60),
                }
              : d,
          );
          return;
        case 'agent.step':
          setLive((current) => ({ steps: [...(current?.steps ?? []), event.data.step] }));
          return;
        case 'agent.delta':
          return; // contrato previsto, não emitido pelo servidor: o texto chega inteiro em agent.message
        case 'agent.message':
          setLive(null);
          setDetail((d) =>
            d && d.id === id
              ? {
                  ...d,
                  messages: mergeMessages(d.messages, [event.data.message]),
                  decisions: d.decisions.some((x) => x.id === event.data.decision.id) ? d.decisions : [...d.decisions, event.data.decision],
                  pendingAgentResponse: null,
                }
              : d,
          );
          return;
        case 'conversation.status':
          setLive(null);
          setDetail((d) => (d && d.id === id && event.data.version >= d.version ? { ...d, status: event.data.status, version: event.data.version, pendingAgentResponse: event.data.status === 'WITH_AGENT' ? d.pendingAgentResponse : null } : d));
          return;
        case 'error':
          setLive(null);
          setError({ message: event.data.error.message, retry: event.data.error.retryable ? 'resume' : null });
          return;
        case 'done':
          setLive(null);
          return;
      }
    },
    [],
  );

  const runStream = useCallback(
    async (id: string, start: (onEvent: (e: ChatStreamEvent) => void) => Promise<void>) => {
      busyRef.current = true;
      setLive({ steps: [] });
      try {
        await start((event) => applyStream(id, event));
      } finally {
        busyRef.current = false;
        setLive(null);
        if (activeRef.current === id) {
          void loadDetail(id);
          void refreshList();
        }
      }
    },
    [applyStream, loadDetail, refreshList],
  );

  const resume = useCallback(
    async (id: string) => {
      if (busyRef.current) return;
      setError(null);
      try {
        await runStream(id, (onEvent) => client.resume(id, onEvent));
      } catch (err) {
        setError({ message: errorMessage(err), retry: isApiError(err) && err.retryable ? 'resume' : null });
      }
    },
    [client, runStream],
  );

  // Retoma uma resposta pendente (ex.: o modelo falhou ou a página foi fechada no meio), uma vez por mensagem.
  useEffect(() => {
    const pending = detail?.pendingAgentResponse?.messageId;
    if (!detail || !pending || detail.status !== 'WITH_AGENT' || busyRef.current || autoResumed.current.has(pending)) return;
    autoResumed.current.add(pending);
    void resume(detail.id);
  }, [detail, resume]);

  // Lista inicial: abre a conversa mais recente que ainda não foi encerrada.
  useEffect(() => {
    void refreshList().then((items) => {
      if (activeRef.current || !items) return;
      const latest = items.find((c) => c.status !== 'CLOSED') ?? items[0];
      if (latest) open(latest.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshList]);

  const open = useCallback(
    (id: string) => {
      if (activeRef.current === id) return;
      activeRef.current = id;
      versionRef.current = -1;
      setActiveId(id);
      setDetail(null);
      setDetailState('loading');
      setError(null);
      setNotice(null);
      setLive(null);
      setSending(null);
      void loadDetail(id);
    },
    [loadDetail],
  );

  // Eventos da conversa aberta: mensagens do analista e mudanças de estado, com reconexão.
  const detailLoaded = detailState === 'ready' && detail?.id === activeId;
  const lastLoadedMessageId = useRef<string | null>(null);
  if (detailLoaded && detail) {
    lastLoadedMessageId.current = detail.messages.at(-1)?.id ?? null;
    versionRef.current = Math.max(versionRef.current, detail.version);
  }
  useEffect(() => {
    if (!activeId || !detailLoaded) return;
    const id = activeId;
    const stop = watchConversation(client, id, {
      after: lastLoadedMessageId.current,
      ...(options.retryDelays ? { retryDelays: options.retryDelays } : {}),
      onConnection: setConnection,
      onEvent: (event) => {
        if (activeRef.current !== id) return;
        if (event.event === 'message.created') {
          setDetail((d) => (d && d.id === id ? { ...d, messages: mergeMessages(d.messages, [event.data.message]) } : d));
          return;
        }
        if (event.data.version <= versionRef.current) return; // estado que a tela já tem (ex.: o da conexão)
        versionRef.current = event.data.version;
        setDetail((d) => (d && d.id === id && event.data.version > d.version ? { ...d, status: event.data.status, version: event.data.version } : d));
        // Mudou de estado (assumida, devolvida, encerrada): relê para alinhar responsável e pendência.
        void loadDetail(id).then(() => void refreshList());
      },
    });
    return stop;
    // A assinatura acompanha a conversa aberta; mensagens novas não reabrem a conexão.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, activeId, detailLoaded]);

  const startNew = useCallback(async () => {
    setError(null);
    // Solta a conversa atual já: até a nova abrir, o campo fica desabilitado e nada é enviado à antiga.
    activeRef.current = null;
    setDetail(null);
    setDetailState('loading');
    setLive(null);
    setSending(null);
    try {
      const conversation = await client.startConversation();
      activeRef.current = conversation.id;
      versionRef.current = conversation.version;
      setActiveId(conversation.id);
      setDetail(conversation);
      setDetailState('ready');
      setNotice(null);
      await refreshList();
    } catch (err) {
      setDetailState('error');
      setError({ message: errorMessage(err), retry: null });
    }
  }, [client, refreshList]);

  const sendWith = useCallback(
    async (id: string, pending: PendingSend) => {
      if (busyRef.current) return;
      setError(null);
      setSending(pending);
      lastFailedSend.current = null;
      try {
        await runStream(id, (onEvent) => client.sendMessage(id, pending, onEvent));
      } catch (err) {
        setSending(null);
        if (isApiError(err, 'NETWORK_ERROR')) {
          // Pode ter chegado ou não: repetir com o mesmo id não duplica (idempotência do servidor).
          lastFailedSend.current = pending;
          setError({ message: err.message, retry: 'send' });
        } else {
          setError({ message: errorMessage(err), retry: err instanceof ApiError && err.retryable ? 'resume' : null });
        }
      }
    },
    [client, runStream],
  );

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || !activeRef.current) return;
      await sendWith(activeRef.current, { clientMessageId: newId(), content });
    },
    [sendWith],
  );

  const retry = useCallback(() => {
    const id = activeRef.current;
    if (!id || !error) return;
    if (error.retry === 'send' && lastFailedSend.current) void sendWith(id, lastFailedSend.current);
    else if (error.retry === 'resume') void resume(id);
    else if (error.retry === 'reload') {
      setError(null);
      void loadDetail(id);
    }
  }, [error, sendWith, resume, loadDetail]);

  const requestAnalyst = useCallback(async () => {
    const id = activeRef.current;
    if (!id) return;
    setHandoffBusy(true);
    setError(null);
    try {
      const { conversation } = await client.requestHandoff(id);
      setDetail((d) => (d && d.id === id ? { ...d, status: conversation.status, version: conversation.version, pendingAgentResponse: null } : d));
      setNotice('Pronto: um analista vai assumir esta conversa e já recebe um resumo do caso.');
      void refreshList();
    } catch (err) {
      setError({ message: errorMessage(err), retry: null });
      void loadDetail(id);
    } finally {
      setHandoffBusy(false);
    }
  }, [client, refreshList, loadDetail]);

  const draftAction = useCallback(
    async (draftId: string, action: 'confirm' | 'discard') => {
      const id = activeRef.current;
      if (!id) return;
      setDraftBusy({ draftId, action });
      setError(null);
      try {
        if (action === 'confirm') {
          const result = await client.confirmDraft(id, draftId);
          setDetail((d) => (d && d.id === id ? { ...d, messages: mergeMessages(replaceDraft(d.messages, result.draft), [result.message]) } : d));
        } else {
          const draft = await client.discardDraft(id, draftId);
          setDetail((d) => (d && d.id === id ? { ...d, messages: replaceDraft(d.messages, draft) } : d));
        }
      } catch (err) {
        setError({ message: errorMessage(err), retry: null });
        // O rascunho pode ter mudado (confirmado em outra aba, substituído): mostra o estado real.
        if (isApiError(err, 'DRAFT_NOT_PENDING')) void loadDetail(id);
      } finally {
        setDraftBusy(null);
      }
    },
    [client, loadDetail],
  );

  const decisions = useMemo(() => new Map((detail?.decisions ?? []).flatMap((d) => (d.messageId ? [[d.messageId, d] as const] : []))), [detail?.decisions]);

  return {
    conversations,
    listState,
    activeId,
    detail,
    detailState,
    decisions,
    live,
    sending,
    error,
    notice,
    connection,
    draftBusy,
    handoffBusy,
    remaining: Math.max(0, MAX_EMPLOYEE_MESSAGES_PER_SESSION - (detail?.employeeMessageCount ?? 0)),
    open,
    startNew,
    send,
    retry,
    dismissError: () => setError(null),
    requestAnalyst,
    confirmDraft: (draftId) => draftAction(draftId, 'confirm'),
    discardDraft: (draftId) => draftAction(draftId, 'discard'),
  };
}
