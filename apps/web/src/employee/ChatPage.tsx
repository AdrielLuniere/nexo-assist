import { type AgentDecision, type ConversationStatus, MAX_EMPLOYEE_MESSAGES_PER_SESSION } from '@nexo/shared';
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { AgentStepsLine, DecisionPanel } from '../components/decision';
import { MessageView } from '../components/messages';
import { Banner, Button, Icons, Pill, Spinner, cx } from '../components/ui';
import type { ChatController } from './use-chat';

const STATUS_PILL: Record<ConversationStatus, { tone: 'green' | 'amber' | 'blue' | 'slate'; label: string }> = {
  WITH_AGENT: { tone: 'green', label: 'Com o assistente' },
  WAITING_ANALYST: { tone: 'amber', label: 'Aguardando atendente' },
  WITH_ANALYST: { tone: 'blue', label: 'Com um analista' },
  CLOSED: { tone: 'slate', label: 'Encerrada' },
};

const PAUSED_TEXT: Partial<Record<ConversationStatus, string>> = {
  WAITING_ANALYST: 'O assistente está pausado. Um analista vai assumir esta conversa; suas mensagens chegam até ele.',
  WITH_ANALYST: 'Você está falando com um analista do suporte. O assistente está pausado.',
  CLOSED: 'Este atendimento foi encerrado. Para continuar, inicie uma nova conversa.',
};

/** Telas 2 e 3: conversa com o agente (e com o analista, quando transferida). */
export function ChatPage({ chat, meId, onMenu }: { chat: ChatController; meId: string; onMenu: () => void }) {
  const [openDecision, setOpenDecision] = useState<AgentDecision | null>(null);
  const { detail } = chat;
  const status = detail?.status ?? null;
  const endRef = useRef<HTMLDivElement>(null);
  const messageCount = detail?.messages.length ?? 0;

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messageCount, chat.live?.steps.length, chat.sending]);

  const lastAgentMessageId = detail ? [...detail.messages].reverse().find((m) => m.role === 'AGENT')?.id : undefined;
  const lastMessageIsAgent = detail?.messages.at(-1)?.role === 'AGENT';
  const agentActive = status === 'WITH_AGENT' && !chat.live && !chat.sending;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 md:px-6">
        <button type="button" className="rounded-md p-1 text-slate-600 hover:bg-slate-100 md:hidden" onClick={onMenu} aria-label="Abrir menu">
          <Icons.menu className="size-5" />
        </button>
        <nav aria-label="Você está em" className="text-sm text-slate-500">
          Service desk de TI <span aria-hidden>›</span> <span className="font-medium text-slate-900">Atendimento</span>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {chat.connection === 'reconnecting' ? (
            <span role="status" className="text-xs text-amber-700">
              Reconectando…
            </span>
          ) : null}
          {status ? <Pill tone={STATUS_PILL[status].tone}>{STATUS_PILL[status].label}</Pill> : null}
          {status === 'WITH_AGENT' ? (
            <Button onClick={() => void chat.requestAnalyst()} busy={chat.handoffBusy} disabled={!!chat.live}>
              <Icons.headset /> Falar com um analista
            </Button>
          ) : null}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto bg-white" aria-live="polite" aria-busy={!!chat.live}>
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6 md:px-6">
          {chat.activeId === null ? (
            <EmptyState listState={chat.listState} onStart={() => void chat.startNew()} />
          ) : chat.detailState === 'loading' || !detail ? (
            chat.detailState === 'error' ? null : (
              <p className="flex items-center gap-2 text-sm text-slate-500">
                <Spinner /> Carregando a conversa…
              </p>
            )
          ) : (
            <>
              {detail.messages.length === 0 && !chat.sending ? <Intro /> : null}
              {detail.messages.map((message) => (
                <MessageView
                  key={message.id}
                  message={message}
                  decision={chat.decisions.get(message.id)}
                  perspective="employee"
                  meId={meId}
                  choicesEnabled={agentActive && lastMessageIsAgent && message.id === lastAgentMessageId}
                  draftsEnabled={status !== 'CLOSED' && !chat.live}
                  draftBusy={chat.draftBusy}
                  actions={{
                    send: (text) => void chat.send(text),
                    confirmDraft: (id) => void chat.confirmDraft(id),
                    discardDraft: (id) => void chat.discardDraft(id),
                    openDecision: setOpenDecision,
                  }}
                />
              ))}
              {chat.sending ? (
                <div className="flex justify-end">
                  <p className="max-w-[min(36rem,90%)] rounded-xl bg-ink/70 px-3.5 py-2 text-sm whitespace-pre-line text-white" aria-label="Enviando mensagem">
                    {chat.sending.content}
                  </p>
                </div>
              ) : null}
              {chat.live ? (
                <div className="flex flex-col gap-2" data-testid="agent-live">
                  <AgentStepsLine steps={chat.live.steps} live />
                </div>
              ) : null}
            </>
          )}
          <div ref={endRef} />
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white px-4 py-3 md:px-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          {chat.notice && (status === 'WAITING_ANALYST' || status === 'WITH_ANALYST') ? <Banner tone="success">{chat.notice}</Banner> : null}
          {status && PAUSED_TEXT[status] ? <Banner tone={status === 'CLOSED' ? 'info' : 'warning'}>{PAUSED_TEXT[status]}</Banner> : null}
          {chat.error ? (
            <Banner
              tone="error"
              action={
                <div className="flex gap-2">
                  {chat.error.retry ? (
                    <Button onClick={chat.retry} className="bg-white">
                      Tentar de novo
                    </Button>
                  ) : null}
                  <Button variant="ghost" onClick={chat.dismissError} aria-label="Fechar aviso">
                    <Icons.x />
                  </Button>
                </div>
              }
            >
              {chat.error.message}
            </Banner>
          ) : null}
          {status === 'CLOSED' ? (
            <Button variant="primary" className="self-start" onClick={() => void chat.startNew()}>
              <Icons.plus /> Nova conversa
            </Button>
          ) : (
            <Composer chat={chat} />
          )}
        </div>
      </footer>

      {openDecision ? <DecisionPanel decision={openDecision} onClose={() => setOpenDecision(null)} /> : null}
    </div>
  );
}

function Composer({ chat }: { chat: ChatController }) {
  const [text, setText] = useState('');
  const inputId = useId();
  const used = chat.detail?.employeeMessageCount ?? 0;
  const limitReached = chat.remaining === 0;
  const disabled = !chat.detail || !!chat.live || !!chat.sending || limitReached;
  const placeholder = chat.detail?.status === 'WITH_AGENT' ? 'Escreva para o Nexo…' : 'Escreva para o analista…';

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (disabled || !text.trim()) return;
    void chat.send(text);
    setText('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <div className={cx('flex items-end gap-2 rounded-xl border bg-white p-2 shadow-sm', limitReached ? 'border-slate-200 bg-slate-50' : 'border-slate-300 focus-within:border-brand')}>
        <label htmlFor={inputId} className="sr-only">
          Mensagem
        </label>
        <textarea
          id={inputId}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          maxLength={2000}
          disabled={!chat.detail || limitReached}
          placeholder={limitReached ? 'Limite de mensagens atingido' : placeholder}
          className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-slate-400 disabled:cursor-not-allowed"
        />
        <Button type="submit" variant="primary" disabled={disabled || !text.trim()}>
          <Icons.send /> Enviar
        </Button>
      </div>
      <p className={cx('text-right text-xs', limitReached ? 'font-medium text-rose-700' : 'text-slate-500')}>
        {limitReached
          ? `Você chegou ao limite de ${MAX_EMPLOYEE_MESSAGES_PER_SESSION} mensagens desta sessão. Inicie uma nova conversa para continuar.`
          : `${used}/${MAX_EMPLOYEE_MESSAGES_PER_SESSION} mensagens nesta sessão`}
      </p>
    </form>
  );
}

function Intro() {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center">
      <h2 className="font-display text-2xl text-slate-900">Como posso ajudar?</h2>
      <p className="mt-2 text-sm text-slate-600">
        Descreva o que está acontecendo. O assistente consulta seus chamados, busca na central de ajuda, prepara um chamado para você confirmar e chama um
        analista quando precisa.
      </p>
    </div>
  );
}

function EmptyState({ listState, onStart }: { listState: ChatController['listState']; onStart: () => void }) {
  if (listState === 'loading') {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner /> Carregando suas conversas…
      </p>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <h2 className="font-display text-2xl text-slate-900">Seu problema de TI, resolvido em uma conversa.</h2>
      <p className="max-w-md text-sm text-slate-600">
        {listState === 'error' ? 'Não consegui carregar suas conversas agora.' : 'Você ainda não tem conversas.'} Comece uma nova para falar com o assistente.
      </p>
      <Button variant="primary" onClick={onStart}>
        <Icons.plus /> Nova conversa
      </Button>
    </div>
  );
}
