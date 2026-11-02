import type { HealthResponse } from '@nexo/shared';
import { useEffect, useState } from 'react';
import { fetchHealth } from './lib/api';

type HealthState =
  | { kind: 'loading' }
  | { kind: 'loaded'; health: HealthResponse }
  | { kind: 'error'; message: string };

/** Página provisória da P0.1: confirma que web, API e banco conversam. As telas do protótipo vêm depois. */
export function App() {
  const [state, setState] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((health) => setState({ kind: 'loaded', health }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: 'error', message: error instanceof Error ? error.message : 'Falha desconhecida' });
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <div className="mx-auto flex max-w-xl flex-col gap-6 px-4 py-16">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium tracking-wide text-indigo-600 uppercase">Service desk de TI</p>
          <h1 className="text-3xl font-semibold">Nexo Assist</h1>
          <p className="text-slate-600">
            Tire dúvidas, acompanhe e abra chamados conversando com o agente. Esta é uma página provisória da
            fundação do projeto.
          </p>
        </header>

        <section aria-live="polite" className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Estado do sistema</h2>
          <HealthPanel state={state} />
        </section>
      </div>
    </main>
  );
}

function HealthPanel({ state }: { state: HealthState }) {
  if (state.kind === 'loading') {
    return <p className="text-sm text-slate-500">Verificando a API…</p>;
  }
  if (state.kind === 'error') {
    return (
      <p className="text-sm text-red-700">
        Não foi possível falar com a API ({state.message}). Verifique se ela está rodando com{' '}
        <code className="rounded bg-slate-100 px-1">npm run dev</code>.
      </p>
    );
  }

  const { health } = state;
  return (
    <dl className="grid grid-cols-2 gap-y-2 text-sm">
      <dt className="text-slate-500">API</dt>
      <dd>
        <StatusBadge ok={health.status === 'ok'} okLabel="Operando" failLabel="Degradada" />
      </dd>
      <dt className="text-slate-500">Banco de dados</dt>
      <dd>
        <StatusBadge ok={health.checks.database.status === 'up'} okLabel="Conectado" failLabel="Indisponível" />
      </dd>
      <dt className="text-slate-500">Versão</dt>
      <dd className="font-mono">{health.version}</dd>
    </dl>
  );
}

function StatusBadge({ ok, okLabel, failLabel }: { ok: boolean; okLabel: string; failLabel: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
        ok ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'
      }`}
    >
      <span aria-hidden className={`size-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />
      {ok ? okLabel : failLabel}
    </span>
  );
}
