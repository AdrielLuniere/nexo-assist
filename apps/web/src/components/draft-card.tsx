import {
  AFFECTED_SCOPE_LABELS,
  DRAFT_OPERATION_LABELS,
  DRAFT_STATUS_LABELS,
  TICKET_CATEGORY_LABELS,
  TICKET_TYPE_LABELS,
  type TicketDraft,
} from '@nexo/shared';
import { slaText } from '../lib/format';
import { PriorityLabel } from './tickets';
import { Button, Pill } from './ui';

const STATUS_PILL = { PENDING: 'amber', CONFIRMED: 'green', DISCARDED: 'slate', SUPERSEDED: 'slate' } as const;

/**
 * Rascunho proposto pelo agente (Tela 2). Nada é escrito no sistema de chamados até "Confirmar".
 * O status vem do servidor (estado atual do rascunho), então um rascunho já confirmado ou descartado
 * não oferece os botões de novo, inclusive depois de recarregar a página.
 */
export function DraftCard({
  draft,
  actionable,
  busy,
  onConfirm,
  onDiscard,
}: {
  draft: TicketDraft;
  /** Só o funcionário, com a conversa aberta, pode confirmar ou descartar. */
  actionable: boolean;
  busy: 'confirm' | 'discard' | null;
  onConfirm?: () => void;
  onDiscard?: () => void;
}) {
  const { payload } = draft;
  const pending = draft.status === 'PENDING';
  const title = payload.operation === 'CREATE' ? payload.fields.title : `${payload.operation === 'UPDATE' ? 'Atualizar' : 'Reabrir'} ${payload.ticketCode}`;

  return (
    <article aria-label={`${DRAFT_OPERATION_LABELS[payload.operation]}: ${title}`} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span>
            {DRAFT_OPERATION_LABELS[payload.operation]} · Rascunho
          </span>
          <Pill tone={STATUS_PILL[draft.status]}>
            {DRAFT_STATUS_LABELS[draft.status]}
            {draft.resultTicketCode ? ` · ${draft.resultTicketCode}` : ''}
          </Pill>
        </div>
        <h3 className="mt-1 text-lg font-semibold text-slate-900">{title}</h3>

        {payload.operation === 'CREATE' ? (
          <>
            <p className="mt-1 text-sm whitespace-pre-line text-slate-600">{payload.fields.description}</p>
            <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-slate-500">Tipo</dt>
                <dd>{TICKET_TYPE_LABELS[payload.fields.type]}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Categoria</dt>
                <dd>{TICKET_CATEGORY_LABELS[payload.fields.category]}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Prioridade</dt>
                <dd>
                  <PriorityLabel priority={payload.fields.priority} />
                  <span className="block text-xs text-slate-500">resposta em até {slaText(payload.fields.priority)}</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Afetados</dt>
                <dd>{payload.fields.affectedScope === 'INDIVIDUAL' ? AFFECTED_SCOPE_LABELS.INDIVIDUAL : payload.fields.affectedDescription}</dd>
              </div>
            </dl>
            <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <span className="font-medium text-slate-700">Por que essa prioridade:</span> {payload.priorityAssessment.rationale}
            </p>
          </>
        ) : (
          <p className="mt-1 text-sm whitespace-pre-line text-slate-600">{payload.operation === 'UPDATE' ? payload.comment : payload.reason}</p>
        )}
      </div>

      {pending && actionable ? (
        <div className="flex flex-wrap gap-2 border-t border-slate-100 bg-slate-50 px-4 py-3">
          <Button variant="primary" onClick={onConfirm} busy={busy === 'confirm'} disabled={busy !== null}>
            Confirmar
          </Button>
          <Button variant="ghost" onClick={onDiscard} busy={busy === 'discard'} disabled={busy !== null}>
            Descartar
          </Button>
        </div>
      ) : null}
    </article>
  );
}
