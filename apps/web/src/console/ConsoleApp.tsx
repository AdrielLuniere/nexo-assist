import {
  type AgentDecision,
  type ConsoleConversationDetail,
  type ConsoleConversationItem,
  type ConversationStatus,
  HANDOFF_REASON_LABELS,
  OPEN_TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  type User,
} from '@nexo/shared';
import { type FormEvent, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { DecisionPanel } from '../components/decision';
import { MessageView } from '../components/messages';
import { STATUS_TONE } from '../components/tickets';
import { Avatar, Banner, Button, Dot, Icons, LogoMark, Pill, Spinner, cx } from '../components/ui';
import { firstName, formatListTime, formatTime } from '../lib/format';
import { useSession } from '../session';
import { QUEUE_FILTERS, type ConsoleController, useConsole } from './use-console';

const DEFAULT_POLL_MS = 8_000;

const STATUS_PILL: Record<ConversationStatus, { tone: 'green' | 'amber' | 'blue' | 'slate'; label: string }> = {
  WAITING_ANALYST: { tone: 'amber', label: 'Aguardando atendente' },
  WITH_ANALYST: { tone: 'blue', label: 'Em atendimento' },
  WITH_AGENT: { tone: 'green', label: 'Com o agente' },
  CLOSED: { tone: 'slate', label: 'Encerrada' },
};

/** Telas 4 e 5: console do analista. */
export function ConsoleApp({ user, pollMs = DEFAULT_POLL_MS }: { user: User; pollMs?: number }) {
  const { client, logout } = useSession();
  const consoleState = useConsole(client, user, pollMs);
  const [showTickets, setShowTickets] = useState(false);
  const { selectedId, detail } = consoleState;

  return (
    <div className="flex h-dvh bg-slate-50 text-slate-900">
      <nav className="hidden w-14 shrink-0 flex-col items-center gap-3 border-r border-slate-200 bg-white py-4 md:flex" aria-label="Navegação do console">
        <LogoMark className="size-6 text-brand" />
        <span className="mt-2 rounded-lg bg-sky-50 p-2 text-brand" aria-current="page" title="Conversas">
          <Icons.chat className="size-5" />
          <span className="sr-only">Conversas</span>
        </span>
        <div className="mt-auto flex flex-col items-center gap-2">
          <span title={`${user.name} · Suporte ${user.analystLevel ?? ''}`}>
            <Avatar name={user.name} size="sm" />
          </span>
          <button type="button" onClick={logout} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Sair">
            <Icons.logout />
          </button>
        </div>
      </nav>

      <aside className={cx('w-full shrink-0 flex-col border-r border-slate-200 bg-white lg:flex lg:w-80', selectedId ? 'hidden' : 'flex')} aria-label="Fila de conversas">
        <Queue state={consoleState} user={user} onLogout={logout} />
      </aside>

      <main className={cx('min-w-0 flex-1 flex-col', selectedId ? 'flex' : 'hidden lg:flex')}>
        {selectedId ? (
          <ConversationView state={consoleState} user={user} onBack={() => consoleState.select(null)} onTickets={() => setShowTickets(true)} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-slate-500">
            <p>Selecione uma conversa da fila para ver o histórico, o resumo da transferência e os chamados do funcionário.</p>
          </div>
        )}
      </main>

      {detail ? (
        <>
          <aside className="hidden w-80 shrink-0 border-l border-slate-200 bg-white xl:block" aria-label={`Chamados de ${firstName(detail.employee.name)}`}>
            <TicketsPanel detail={detail} user={user} />
          </aside>
          {showTickets ? (
            <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30 xl:hidden" role="dialog" aria-modal="true" aria-label={`Chamados de ${firstName(detail.employee.name)}`}>
              <div className="h-full w-80 max-w-[90%] bg-white shadow-xl">
                <TicketsPanel detail={detail} user={user} onClose={() => setShowTickets(false)} />
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Queue({ state, user, onLogout }: { state: ConsoleController; user: User; onLogout: () => void }) {
  const searchId = useId();
  return (
    <>
      <div className="flex items-center justify-between px-4 pt-4">
        <h1 className="text-lg font-semibold">Conversas</h1>
        <div className="flex items-center gap-2">
          <Pill tone="green">Suporte {user.analystLevel}</Pill>
          <button type="button" onClick={onLogout} className="rounded-md p-1 text-slate-500 hover:bg-slate-100 md:hidden" aria-label="Sair">
            <Icons.logout />
          </button>
        </div>
      </div>
      <div className="px-4 pt-3">
        <label htmlFor={searchId} className="sr-only">
          Pesquisar conversa por funcionário ou título
        </label>
        <div className="flex items-center gap-2 rounded-lg bg-slate-100 px-3">
          <Icons.search className="size-4 text-slate-400" />
          <input
            id={searchId}
            type="search"
            value={state.query}
            onChange={(event) => state.setQuery(event.target.value)}
            maxLength={100}
            placeholder="Pesquisar funcionário ou título"
            className="h-9 flex-1 bg-transparent text-sm outline-none"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 px-4 py-3" role="group" aria-label="Filtrar por estado">
        {QUEUE_FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => state.setFilter(option.id)}
            aria-pressed={state.filter === option.id}
            className={cx('rounded-full px-2.5 py-1 text-xs font-medium', state.filter === option.id ? 'bg-sky-100 text-brand' : 'bg-slate-100 text-slate-600 hover:bg-slate-200')}
          >
            {option.label}
          </button>
        ))}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Conversas">
        {state.listState === 'loading' ? (
          <li className="flex items-center gap-2 px-3 py-2 text-sm text-slate-500">
            <Spinner /> Carregando a fila…
          </li>
        ) : null}
        {state.listState === 'error' ? (
          <li className="px-3 py-2">
            <Banner tone="error" action={<Button onClick={state.reload}>Tentar de novo</Button>}>
              Não foi possível carregar a fila.
            </Banner>
          </li>
        ) : null}
        {state.listState === 'ready' && state.items.length === 0 ? <li className="px-3 py-6 text-center text-sm text-slate-500">Nenhuma conversa neste filtro.</li> : null}
        {state.items.map((item) => (
          <li key={item.id}>
            <QueueItem item={item} me={user} selected={state.selectedId === item.id} onSelect={() => state.select(item.id)} />
          </li>
        ))}
      </ul>
    </>
  );
}

function QueueItem({ item, me, selected, onSelect }: { item: ConsoleConversationItem; me: User; selected: boolean; onSelect: () => void }) {
  const line = (() => {
    if (item.status === 'WAITING_ANALYST' && item.activeHandoff) {
      return { tone: 'bg-rose-500', text: `Transferida · ${HANDOFF_REASON_LABELS[item.activeHandoff.reason]}${item.activeHandoff.relatedTicketCode ? ` · ${item.activeHandoff.relatedTicketCode}` : ''}` };
    }
    if (item.status === 'WITH_ANALYST') return { tone: 'bg-sky-500', text: item.assignedAnalystId === me.id ? 'Você está atendendo' : 'Em atendimento por outro analista' };
    if (item.status === 'WITH_AGENT') return { tone: 'bg-emerald-500', text: 'Agente atendendo' };
    return { tone: 'bg-slate-400', text: 'Encerrada' };
  })();
  const when = item.lastMessageAt ?? item.updatedAt;
  return (
    <button type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined} className={cx('flex w-full gap-3 rounded-xl px-3 py-2.5 text-left', selected ? 'bg-slate-100' : 'hover:bg-slate-50')}>
      <Avatar name={item.employee.name} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{item.employee.name}</span>
          <span className={cx('shrink-0 text-xs', item.status === 'WAITING_ANALYST' ? 'font-medium text-brand' : 'text-slate-400')}>{formatListTime(when)}</span>
        </span>
        <span className="block truncate text-xs text-slate-600">{item.title ?? 'Sem título'}</span>
        <Dot tone={line.tone} className="mt-0.5 text-[11px] text-slate-600">
          {line.text}
        </Dot>
      </span>
    </button>
  );
}

type TimelineEntry = { kind: 'message'; at: string; id: string } | { kind: 'marker'; at: string; id: string; text: string };

function timelineOf(detail: ConsoleConversationDetail, me: User): TimelineEntry[] {
  const entries: TimelineEntry[] = detail.messages.map((m) => ({ kind: 'message', at: m.createdAt, id: m.id }));
  for (const handoff of detail.handoffs) {
    // A transferência feita pelo agente é gravada junto com a mensagem que a anuncia: o marcador vem
    // logo depois dela, mesmo que os horários difiram por milissegundos.
    const notice = detail.messages.find((m) => m.blocks.some((b) => b.type === 'handoff_notice' && b.handoffId === handoff.id));
    const createdAt = notice && notice.createdAt > handoff.createdAt ? notice.createdAt : handoff.createdAt;
    entries.push({ kind: 'marker', at: createdAt, id: `${handoff.id}-created`, text: `Transferida para atendimento · ${HANDOFF_REASON_LABELS[handoff.reason]} · ${formatTime(handoff.createdAt)}` });
    if (handoff.assumedAt) {
      entries.push({
        kind: 'marker',
        at: handoff.assumedAt > createdAt ? handoff.assumedAt : createdAt,
        id: `${handoff.id}-assumed`,
        text: `${handoff.assumedById === me.id ? 'Você assumiu' : 'Assumida por um analista'} · agente pausado · ${formatTime(handoff.assumedAt)}`,
      });
    }
    if (handoff.endedAt) {
      const text = handoff.status === 'RETURNED_TO_AGENT' ? 'Devolvida ao agente' : 'Atendimento encerrado';
      entries.push({ kind: 'marker', at: handoff.endedAt, id: `${handoff.id}-ended`, text: `${text} · ${formatTime(handoff.endedAt)}` });
    }
  }
  // No mesmo instante, a mensagem vem antes do marcador (a transferência é gravada junto com a resposta).
  return entries.sort((a, b) => a.at.localeCompare(b.at) || (a.kind === b.kind ? 0 : a.kind === 'message' ? -1 : 1));
}

function ConversationView({ state, user, onBack, onTickets }: { state: ConsoleController; user: User; onBack: () => void; onTickets: () => void }) {
  const { detail } = state;
  const [openDecision, setOpenDecision] = useState<AgentDecision | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const count = detail?.messages.length ?? 0;
  // Corpo em bloco: `scrollIntoView` devolve uma Promise nos navegadores atuais, e o React trataria o
  // retorno como função de limpeza.
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [count]);
  useEffect(() => {
    setConfirmClose(false);
  }, [detail?.id, detail?.status]);

  const decisions = useMemo(() => new Map((detail?.decisions ?? []).flatMap((d) => (d.messageId ? [[d.messageId, d] as const] : []))), [detail?.decisions]);
  const messages = useMemo(() => new Map((detail?.messages ?? []).map((m) => [m.id, m])), [detail?.messages]);

  if (!detail) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
        {state.detailState === 'error' ? (
          <Banner tone="error" action={<Button onClick={state.reload}>Tentar de novo</Button>}>
            {state.feedback?.message ?? 'Não foi possível abrir a conversa.'}
          </Banner>
        ) : (
          <span className="flex items-center gap-2">
            <Spinner /> Abrindo a conversa…
          </span>
        )}
      </div>
    );
  }

  const mine = detail.status === 'WITH_ANALYST' && detail.assignedAnalystId === user.id;
  const activeHandoff = [...detail.handoffs].reverse().find((h) => h.status === 'WAITING' || h.status === 'ASSUMED');
  const name = firstName(detail.employee.name);

  return (
    <>
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <button type="button" onClick={onBack} className="rounded-md p-1 text-slate-600 hover:bg-slate-100 lg:hidden" aria-label="Voltar para a fila">
          <Icons.back className="size-5" />
        </button>
        <Avatar name={detail.employee.name} size="sm" />
        <div className="min-w-0">
          <h2 className="truncate font-semibold">{detail.employee.name}</h2>
          <p className="truncate text-xs text-slate-500">
            {[detail.employee.department, activeHandoff?.relatedTicketCode].filter(Boolean).join(' · ') || detail.employee.email}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {mine ? (
            <>
              <Button onClick={() => void state.act('return')} busy={state.busy === 'return'} disabled={state.busy !== null}>
                <Icons.transfer /> Devolver ao agente
              </Button>
              {confirmClose ? (
                <Button variant="danger" onClick={() => void state.act('close')} busy={state.busy === 'close'} disabled={state.busy !== null}>
                  Confirmar encerramento
                </Button>
              ) : (
                <Button variant="danger" onClick={() => setConfirmClose(true)} disabled={state.busy !== null}>
                  Encerrar atendimento
                </Button>
              )}
            </>
          ) : (
            <Pill tone={STATUS_PILL[detail.status].tone}>{STATUS_PILL[detail.status].label}</Pill>
          )}
          <Button variant="ghost" className="xl:hidden" onClick={onTickets}>
            <Icons.tickets /> Chamados
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50" aria-live="polite">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-5">
          {activeHandoff ? (
            <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm" aria-label="Resumo da transferência">
              <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-amber-900">
                <Icons.transfer className="size-3.5" /> Transferência · {HANDOFF_REASON_LABELS[activeHandoff.reason]}
                {activeHandoff.relatedTicketCode ? <span className="font-mono">· {activeHandoff.relatedTicketCode}</span> : null}
                <span className="font-normal text-amber-800">· {formatTime(activeHandoff.createdAt)}</span>
              </p>
              <p className="mt-2 whitespace-pre-line text-slate-800">{activeHandoff.summary}</p>
            </section>
          ) : null}

          {timelineOf(detail, user).map((entry) =>
            entry.kind === 'marker' ? (
              <p key={entry.id} className="flex items-center gap-2 text-xs text-slate-500">
                <span className="h-px flex-1 bg-slate-200" aria-hidden />
                <Icons.transfer className="size-3.5" />
                {entry.text}
                <span className="h-px flex-1 bg-slate-200" aria-hidden />
              </p>
            ) : (
              (() => {
                const message = messages.get(entry.id);
                return message ? (
                  <MessageView
                    key={entry.id}
                    message={message}
                    decision={decisions.get(message.id)}
                    perspective="analyst"
                    meId={user.id}
                    choicesEnabled={false}
                    draftsEnabled={false}
                    draftBusy={null}
                    actions={{ openDecision: setOpenDecision }}
                  />
                ) : null;
              })()
            ),
          )}
          <div ref={endRef} />
        </div>
      </div>

      <footer className="border-t border-slate-200 bg-white px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          {state.feedback ? (
            <Banner tone={state.feedback.tone} action={<Button variant="ghost" onClick={state.dismissFeedback} aria-label="Fechar aviso"><Icons.x /></Button>}>
              {state.feedback.message}
            </Banner>
          ) : null}
          {detail.status === 'WAITING_ANALYST' ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-amber-700">
                <Icons.headset className="size-5" />
              </span>
              <div className="min-w-[11rem] flex-1">
                <p className="text-sm font-semibold">{name} espera um atendente</p>
                <p className="text-xs text-slate-500">Agente pausado{activeHandoff ? ` desde ${formatTime(activeHandoff.createdAt)}` : ''}</p>
              </div>
              <div className="flex w-full justify-end gap-2 sm:w-auto">
              <Button onClick={() => void state.act('close')} busy={state.busy === 'close'} disabled={state.busy !== null}>
                Encerrar
              </Button>
              <Button variant="primary" onClick={() => void state.act('assume')} busy={state.busy === 'assume'} disabled={state.busy !== null}>
                <Icons.headset /> Assumir atendimento
              </Button>
              </div>
            </div>
          ) : mine ? (
            <AnalystComposer state={state} name={name} />
          ) : (
            <p className="text-sm text-slate-500">
              {detail.status === 'WITH_ANALYST'
                ? 'Outro analista está atendendo esta conversa. Só quem assumiu pode responder.'
                : detail.status === 'WITH_AGENT'
                  ? 'A conversa está com o agente. Se ela voltar a precisar de um analista, aparece de novo como aguardando.'
                  : 'Esta conversa está encerrada.'}
            </p>
          )}
        </div>
      </footer>

      {openDecision ? <DecisionPanel decision={openDecision} onClose={() => setOpenDecision(null)} /> : null}
    </>
  );
}

function AnalystComposer({ state, name }: { state: ConsoleController; name: string }) {
  const [text, setText] = useState('');
  const inputId = useId();
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!text.trim() || state.busy) return;
    if (await state.send(text)) setText('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };
  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <label htmlFor={inputId} className="sr-only">
        Mensagem para {name}
      </label>
      <textarea
        id={inputId}
        rows={1}
        value={text}
        maxLength={4000}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={`Responder para ${name}…`}
        className="max-h-40 min-h-10 flex-1 resize-none rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand"
      />
      {state.failedSend ? (
        <Button onClick={() => void state.send('', state.failedSend ?? undefined)} busy={state.busy === 'send'}>
          Reenviar
        </Button>
      ) : null}
      <Button type="submit" variant="primary" busy={state.busy === 'send'} disabled={!text.trim() || state.busy !== null} aria-label="Enviar mensagem">
        <Icons.send /> Enviar
      </Button>
    </form>
  );
}

function TicketsPanel({ detail, user, onClose }: { detail: ConsoleConversationDetail; user: User; onClose?: () => void }) {
  const name = firstName(detail.employee.name);
  const open = detail.employeeTickets.filter((t) => OPEN_TICKET_STATUSES.includes(t.status));
  const relatedCode = [...detail.handoffs].reverse().find((h) => h.relatedTicketCode)?.relatedTicketCode ?? null;
  const related = detail.employeeTickets.find((t) => t.code === relatedCode);
  const activeHandoff = [...detail.handoffs].reverse().find((h) => h.status === 'WAITING' || h.status === 'ASSUMED');
  const others = detail.employeeTickets.filter((t) => t.code !== related?.code);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-2 border-b border-slate-200 px-4 py-4">
        <div>
          <h2 className="font-semibold">Chamados de {name}</h2>
          <p className="text-xs text-slate-500">
            {open.length} {open.length === 1 ? 'aberto' : 'abertos'} · {detail.employeeTickets.length - open.length} encerrados
          </p>
        </div>
        {onClose ? (
          <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-500 hover:bg-slate-100" aria-label="Fechar chamados">
            <Icons.x />
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {related ? (
          <section aria-label="Desta conversa">
            <h3 className="mb-2 text-xs font-medium text-slate-500">Desta conversa</h3>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-mono text-slate-500">{related.code}</span>
                <Dot tone={STATUS_TONE[related.status]} className="font-medium text-slate-700">
                  {TICKET_STATUS_LABELS[related.status]}
                </Dot>
              </div>
              <p className="mt-1 font-semibold text-slate-900">{related.title}</p>
              {related.isOverdue ? <p className="mt-1 text-xs font-medium text-rose-700">Prazo vencido</p> : null}
              {activeHandoff ? (
                <p className="mt-2 flex items-center gap-1.5 border-t border-slate-200 pt-2 text-xs text-slate-600">
                  <Icons.transfer className="size-3.5" />
                  {activeHandoff.status === 'ASSUMED' ? (activeHandoff.assumedById === user.id ? 'Assumido por você' : 'Assumido por um analista') : 'Transferido para um analista'}
                  <span className="ml-auto">{formatTime(activeHandoff.assumedAt ?? activeHandoff.createdAt)}</span>
                </p>
              ) : null}
            </div>
          </section>
        ) : null}
        <section className="mt-5" aria-label="Outros chamados">
          <h3 className="mb-1 text-xs font-medium text-slate-500">{related ? 'Outros chamados' : 'Chamados'}</h3>
          {others.length === 0 ? <p className="text-sm text-slate-500">Nenhum outro chamado.</p> : null}
          <ul className="divide-y divide-slate-100">
            {others.map((ticket) => (
              <li key={ticket.code} className="py-2.5 text-sm">
                <Dot tone={STATUS_TONE[ticket.status]} className="font-medium text-slate-800">
                  <span className="truncate">{ticket.title}</span>
                </Dot>
                <p className="ml-3 text-xs text-slate-500">
                  <span className="font-mono">{ticket.code}</span> · {TICKET_STATUS_LABELS[ticket.status]}
                  {ticket.isOverdue ? <span className="font-medium text-rose-700"> · vencido</span> : null}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
