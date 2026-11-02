import {
  AGENT_ACTION_LABELS,
  AGENT_INTENT_LABELS,
  type AgentDecision,
  type AgentStep,
  RULE_REF_LABELS,
} from '@nexo/shared';
import { useEffect, useId, useRef } from 'react';
import { CONFIDENCE_LEVEL_LABELS, formatConfidence, formatDateTime } from '../lib/format';
import { Icons, Spinner, cx } from './ui';

/**
 * Transparência das decisões do agente (PRD, item 7). Tudo aqui vem do `AgentDecision` gravado pela
 * API para aquela resposta (ou, durante a resposta, dos eventos `agent.step` reais). Nada é
 * inferido pela interface, e não existe "raciocínio interno" do modelo: só o que as ferramentas
 * fizeram e a justificativa objetiva registrada.
 */

const STEP_ICON: Record<AgentStep['status'], { icon: keyof typeof Icons; tone: string; label: string }> = {
  OK: { icon: 'check', tone: 'text-emerald-600', label: 'concluído' },
  ERROR: { icon: 'alert', tone: 'text-rose-600', label: 'falhou' },
  SKIPPED: { icon: 'x', tone: 'text-slate-400', label: 'não executado' },
};

function StepIcon({ status }: { status: AgentStep['status'] }) {
  const { icon, tone, label } = STEP_ICON[status];
  const Icon = Icons[icon];
  return (
    <span className={cx('inline-flex', tone)} title={label}>
      <Icon className="size-3.5" />
      <span className="sr-only">({label})</span>
    </span>
  );
}

/** Ações executadas, acima da resposta: "Nexo Assist ✓ consultou seus chamados ✓ calculou o prazo". */
export function AgentStepsLine({ steps, live, onDetails }: { steps: readonly AgentStep[]; live?: boolean; onDetails?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
      <span className="font-semibold text-slate-800">Nexo Assist</span>
      <ul className="contents" aria-label="Ações executadas pelo agente">
        {steps.map((step, index) => (
          <li key={`${step.kind}-${index}`} className="inline-flex items-center gap-1">
            <StepIcon status={step.status} />
            {step.label}
          </li>
        ))}
      </ul>
      {live ? (
        <span className="inline-flex items-center gap-1.5 text-slate-500" role="status">
          <Spinner className="size-3" /> trabalhando…
        </span>
      ) : null}
      {onDetails ? (
        <button type="button" onClick={onDetails} className="font-medium text-brand underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand">
          Ver detalhes da decisão
        </button>
      ) : null}
    </div>
  );
}

const LEVEL_STYLE = { HIGH: 'bg-emerald-500', MEDIUM: 'bg-amber-500', LOW: 'bg-rose-500' } as const;

export function ConfidenceMeter({ decision }: { decision: AgentDecision }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-2 w-32 overflow-hidden rounded-full bg-slate-200"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={decision.confidence}
        aria-label="Grau de confiança"
      >
        <div className={cx('h-full rounded-full', LEVEL_STYLE[decision.confidenceLevel])} style={{ width: `${Math.round(decision.confidence * 100)}%` }} />
      </div>
      <span className="text-sm font-medium text-slate-800">
        {formatConfidence(decision.confidence)} · {CONFIDENCE_LEVEL_LABELS[decision.confidenceLevel]}
      </span>
    </div>
  );
}

/** Painel com o registro completo da decisão. Fecha com Esc, com o botão ou clicando fora. */
export function DecisionPanel({ decision, onClose }: { decision: AgentDecision; onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section role="dialog" aria-modal="true" aria-labelledby={titleId} className="flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-xl">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">Decisão do agente</p>
            <h2 id={titleId} className="text-lg font-semibold text-slate-900">
              {AGENT_ACTION_LABELS[decision.action]}
            </h2>
            <p className="text-xs text-slate-500">Registrada em {formatDateTime(decision.createdAt)}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="rounded-md p-1 text-slate-500 hover:bg-slate-100" aria-label="Fechar detalhes">
            <Icons.x />
          </button>
        </header>

        <dl className="flex flex-col gap-5 px-5 py-5 text-sm">
          <Item label="O que o agente entendeu">{decision.understanding}</Item>
          <div className="grid grid-cols-2 gap-4">
            <Item label="Intenção">{AGENT_INTENT_LABELS[decision.intent]}</Item>
            <Item label="Ação tomada">{AGENT_ACTION_LABELS[decision.action]}</Item>
          </div>
          <Item label="Grau de confiança">
            <ConfidenceMeter decision={decision} />
          </Item>
          <Item label="Justificativa">
            <span className="whitespace-pre-line">{decision.rationale}</span>
          </Item>
          <Item label="Regras aplicadas">
            {decision.ruleRefs.length === 0 ? (
              <span className="text-slate-500">Nenhuma regra específica citada.</span>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {decision.ruleRefs.map((ref) => (
                  <li key={ref} className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs text-slate-700">
                    <span className="font-mono text-slate-500">{ref}</span> {RULE_REF_LABELS[ref] ?? ''}
                  </li>
                ))}
              </ul>
            )}
          </Item>
          <Item label="Ferramentas e etapas executadas">
            {decision.steps.length === 0 ? (
              <span className="text-slate-500">Nenhuma ferramenta foi necessária.</span>
            ) : (
              <ol className="flex flex-col gap-2">
                {decision.steps.map((step, index) => (
                  <li key={`${step.kind}-${index}`} className="rounded-lg border border-slate-200 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <StepIcon status={step.status} />
                      <span className="font-medium text-slate-800">{step.label}</span>
                      {step.durationMs !== undefined ? <span className="ml-auto text-xs text-slate-400">{step.durationMs} ms</span> : null}
                    </div>
                    {step.summary ? <p className="mt-1 text-xs text-slate-600">{step.summary}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </Item>
        </dl>

        <footer className="mt-auto border-t border-slate-200 bg-slate-50 px-5 py-3 text-xs text-slate-500">
          <p>
            Modelo {decision.model ?? 'não informado'}
            {decision.inputTokens !== null ? ` · ${decision.inputTokens} tokens de entrada` : ''}
            {decision.outputTokens !== null ? ` · ${decision.outputTokens} de saída` : ''}
            {decision.latencyMs !== null ? ` · ${(decision.latencyMs / 1000).toFixed(1).replace('.', ',')} s` : ''}
          </p>
          <p className="mt-1">Registro gravado pelo sistema para esta resposta. Não inclui raciocínio interno do modelo.</p>
        </footer>
      </section>
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="mb-1 text-xs font-medium text-slate-500">{label}</dt>
      <dd className="text-slate-800">{children}</dd>
    </div>
  );
}
