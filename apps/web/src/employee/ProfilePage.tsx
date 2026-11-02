import type { User } from '@nexo/shared';
import { Icons } from '../components/ui';

/** Tela "Meu perfil": dados de acesso vindos da sessão (API). */
export function ProfilePage({ user, onMenu }: { user: User; onMenu: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 md:px-6">
        <button type="button" className="rounded-md p-1 text-slate-600 hover:bg-slate-100 md:hidden" onClick={onMenu} aria-label="Abrir menu">
          <Icons.menu className="size-5" />
        </button>
        <nav aria-label="Você está em" className="text-sm text-slate-500">
          Service desk de TI <span aria-hidden>›</span> <span className="font-medium text-slate-900">Meu perfil</span>
        </nav>
      </header>
      <main className="flex-1 overflow-y-auto bg-white">
        <div className="mx-auto max-w-xl px-4 py-10">
          <h1 className="font-display text-3xl text-slate-900">Meu perfil</h1>
          <p className="mt-1 text-sm text-slate-500">Seus dados de acesso ao service desk de TI.</p>

          <dl className="mt-6 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm">
            <Row label="Nome">{user.name}</Row>
            <Row label="E-mail corporativo" note="Gerenciado pela TI">
              {user.email}
            </Row>
            {user.department ? <Row label="Departamento">{user.department}</Row> : null}
          </dl>

          <div className="mt-4 flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            <Icons.lock className="mt-0.5 size-4 shrink-0" />
            <p>A senha é a da rede Nexo e é gerenciada pela TI. Neste ambiente de demonstração, o acesso aceita os usuários de exemplo com qualquer senha.</p>
          </div>
        </div>
      </main>
    </div>
  );
}

function Row({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-3 text-sm">
      <dt className="w-40 text-slate-500">{label}</dt>
      <dd className="flex-1 font-medium text-slate-900">{children}</dd>
      {note ? (
        <span className="inline-flex items-center gap-1 text-xs text-slate-500">
          <Icons.lock className="size-3" /> {note}
        </span>
      ) : null}
    </div>
  );
}
