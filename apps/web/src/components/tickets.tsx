import {
  TICKET_CATEGORY_LABELS,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_TYPE_LABELS,
  type TicketPriority,
  type TicketStatus,
  type TicketSummary,
} from '@nexo/shared';
import { useId } from 'react';
import { dueText, formatDayMonth, formatRelative, slaText } from '../lib/format';
import { Dot, cx } from './ui';

export const STATUS_TONE: Record<TicketStatus, string> = {
  WAITING_ANALYST: 'bg-amber-500',
  IN_PROGRESS: 'bg-sky-500',
  APPROVED: 'bg-emerald-500',
  RESOLVED: 'bg-slate-400',
  CLOSED: 'bg-slate-300',
};

export const PRIORITY_TONE: Record<TicketPriority, string> = {
  CRITICAL: 'bg-rose-600',
  HIGH: 'bg-amber-500',
  MEDIUM: 'bg-sky-500',
  LOW: 'bg-slate-400',
};

export function TicketStatus({ status, className }: { status: TicketStatus; className?: string }) {
  return (
    <Dot tone={STATUS_TONE[status]} className={cx('text-xs font-medium text-slate-700', className)}>
      {TICKET_STATUS_LABELS[status]}
    </Dot>
  );
}

export function PriorityLabel({ priority }: { priority: TicketPriority }) {
  return <Dot tone={PRIORITY_TONE[priority]}>{TICKET_PRIORITY_LABELS[priority]}</Dot>;
}

/** Card de chamado (Tela 3): código, status, título, categoria, prioridade e prazo. */
export function TicketCard({ ticket, now = new Date() }: { ticket: TicketSummary; now?: Date }) {
  return (
    <article aria-label={`Chamado ${ticket.code}`} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>
          {TICKET_TYPE_LABELS[ticket.type]} · <span className="font-mono">{ticket.code}</span>
        </span>
        <TicketStatus status={ticket.status} />
      </div>
      <h3 className="mt-1 font-semibold text-slate-900">{ticket.title}</h3>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-slate-500">Categoria</dt>
          <dd className="text-slate-800">{TICKET_CATEGORY_LABELS[ticket.category]}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Prioridade</dt>
          <dd className="text-slate-800">
            <PriorityLabel priority={ticket.priority} /> <span className="text-xs text-slate-500">· {slaText(ticket.priority)}</span>
          </dd>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-xs text-slate-500">Última atualização</dt>
          <dd className={cx(ticket.isOverdue ? 'font-medium text-amber-700' : 'text-slate-800')}>
            {formatRelative(ticket.updatedAt, now)}
            {ticket.isOverdue ? (
              <span className="mt-0.5 flex items-center gap-1 text-xs font-medium text-rose-700">
                <span aria-hidden>●</span> {dueText(ticket.slaDueAt, true, now)}
              </span>
            ) : (
              <span className="block text-xs text-slate-500">{dueText(ticket.slaDueAt, false, now)}</span>
            )}
          </dd>
        </div>
      </dl>
    </article>
  );
}

/**
 * Seleção entre chamados (Tela 3). Escolher envia a mensagem "INC-20311 · título", como no protótipo;
 * só a última mensagem do agente aceita escolha.
 */
export function TicketSelection({ prompt, options, disabled, onSelect }: { prompt: string; options: TicketSummary[]; disabled: boolean; onSelect: (ticket: TicketSummary) => void }) {
  const name = useId();
  return (
    <fieldset className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm" disabled={disabled}>
      <legend className="sr-only">{prompt}</legend>
      {options.map((ticket) => (
        <label
          key={ticket.code}
          className={cx('flex cursor-pointer items-center gap-3 border-b border-slate-100 px-4 py-2.5 text-sm last:border-b-0', disabled ? 'cursor-default opacity-70' : 'hover:bg-slate-50')}
        >
          <input type="radio" name={name} className="accent-brand" disabled={disabled} onChange={() => onSelect(ticket)} />
          <span className="w-20 shrink-0 font-mono text-xs text-slate-500">{ticket.code}</span>
          <span className="min-w-0 flex-1 truncate text-slate-800">{ticket.title}</span>
          <TicketStatus status={ticket.status} className="hidden sm:inline-flex" />
          {ticket.isOverdue ? <span className="text-xs font-medium text-rose-700">vencido</span> : null}
          <span className="hidden w-14 text-right text-xs whitespace-nowrap text-slate-500 md:inline">{formatDayMonth(ticket.updatedAt)}</span>
        </label>
      ))}
    </fieldset>
  );
}
