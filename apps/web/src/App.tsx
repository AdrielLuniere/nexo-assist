import { ConsoleApp } from './console/ConsoleApp';
import { Spinner } from './components/ui';
import { EmployeeApp } from './employee/EmployeeApp';
import { LoginPage } from './LoginPage';
import { SessionProvider, useSession } from './session';

export interface AppProps {
  /** Origem da API; em produção a mesma origem (proxy do Vite em desenvolvimento). */
  readonly baseUrl?: string;
  /** Esperas entre reconexões e consultas do console (ms). Testes usam valores curtos. */
  readonly timings?: { readonly retryDelays?: readonly number[]; readonly consolePollMs?: number };
  /** Relógio usado para a validade da sessão (testes com horário fixo). */
  readonly now?: () => Date;
}

export function App({ baseUrl, timings, now }: AppProps) {
  return (
    <SessionProvider {...(baseUrl === undefined ? {} : { baseUrl })} {...(now ? { now } : {})}>
      <Routes {...(timings ? { timings } : {})} />
    </SessionProvider>
  );
}

/** Direciona pelo papel que a API informa: funcionário vai para o chat; analista, para o console. */
function Routes({ timings }: Pick<AppProps, 'timings'>) {
  const { state } = useSession();
  if (state.kind === 'checking') {
    return (
      <p className="flex min-h-dvh items-center justify-center gap-2 text-sm text-slate-500" role="status">
        <Spinner /> Verificando sua sessão…
      </p>
    );
  }
  if (state.kind === 'signed-out') return <LoginPage reason={state.reason} />;
  if (state.user.role === 'ANALYST') return <ConsoleApp user={state.user} {...(timings?.consolePollMs ? { pollMs: timings.consolePollMs } : {})} />;
  return <EmployeeApp key={state.user.id} user={state.user} {...(timings?.retryDelays ? { retryDelays: timings.retryDelays } : {})} />;
}
