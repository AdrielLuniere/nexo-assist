import { type FormEvent, useId, useState } from 'react';
import { Banner, Button, Icons, Logo } from './components/ui';
import { errorMessage, isApiError } from './lib/api';
import { useSession } from './session';

/** Tela 1: e-mail corporativo e senha, com a apresentação do Nexo Assist. */
export function LoginPage({ reason }: { reason: 'expired' | 'logout' | null }) {
  const { login } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password, remember);
    } catch (err) {
      setError(isApiError(err, 'INVALID_CREDENTIALS') || isApiError(err, 'VALIDATION_ERROR') ? 'E-mail ou senha inválidos.' : errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh bg-white lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden flex-col justify-between bg-ink px-12 py-10 text-white lg:flex" aria-label="Sobre o Nexo Assist">
        <Logo tone="light" />
        <div className="max-w-xl">
          <p className="text-xs text-slate-400">Service desk de TI da Nexo</p>
          <h1 className="mt-3 font-display text-5xl leading-tight">Seu problema de TI, resolvido em uma conversa.</h1>
          <p className="mt-5 text-sm text-slate-300">
            Descreva o que está acontecendo. O assistente consulta seus chamados, busca na central de ajuda e chama um analista quando precisa.
          </p>
          <figure className="mt-10 max-w-md rounded-2xl border border-white/10 bg-white/5 p-4 text-xs" aria-label="Exemplo de conversa">
            <p className="ml-auto w-fit rounded-lg bg-white px-3 py-1.5 text-slate-800">Meu notebook não conecta na VPN. Erro 809.</p>
            <p className="mt-3 text-slate-400">
              <span className="font-semibold text-slate-200">Nexo Assist</span> · consultou seus chamados · criou um chamado
            </p>
            <p className="mt-1 w-fit rounded-lg bg-white/10 px-3 py-1.5 text-slate-100">Pronto: abri o chamado com prioridade alta. Um analista fala com você em até 4 h úteis.</p>
            <figcaption className="mt-3 text-[10px] text-slate-500">Exemplo ilustrativo</figcaption>
          </figure>
        </div>
        <p className="text-xs text-slate-500">Atendimento com o assistente e com a equipe de suporte N1 e N2.</p>
      </section>

      <section className="flex flex-col px-6 py-6 sm:px-12">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span className="lg:hidden">
            <Logo />
          </span>
          <span className="ml-auto">
            Problema para entrar? <span className="font-medium text-brand">Ligue no ramal 4000</span>
          </span>
        </div>

        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">
          <h2 className="font-display text-4xl text-slate-900">Entrar</h2>
          <p className="mt-2 text-sm text-slate-500">Use seu e-mail corporativo e a senha da rede Nexo.</p>

          {reason === 'expired' ? (
            <div className="mt-5">
              <Banner tone="warning">Sua sessão expirou. Entre novamente para continuar.</Banner>
            </div>
          ) : null}

          <form className="mt-6 flex flex-col gap-4" onSubmit={submit} noValidate aria-describedby={error ? errorId : undefined}>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={emailId} className="text-sm font-medium text-slate-800">
                E-mail corporativo
              </label>
              <div className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
                <Icons.mail className="size-4 text-slate-400" />
                <input
                  id={emailId}
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="nome.sobrenome@nexo.com.br"
                  className="h-10 flex-1 bg-transparent text-sm outline-none"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={passwordId} className="text-sm font-medium text-slate-800">
                Senha
              </label>
              <div className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
                <Icons.lock className="size-4 text-slate-400" />
                <input
                  id={passwordId}
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-10 flex-1 bg-transparent text-sm outline-none"
                />
                <button type="button" onClick={() => setShowPassword((v) => !v)} className="rounded p-1 text-slate-400 hover:text-slate-600" aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'} aria-pressed={showPassword}>
                  <Icons.eye />
                </button>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="size-4 accent-brand" />
              Manter conectado neste computador
            </label>

            {error ? (
              <p id={errorId} role="alert" className="text-sm text-rose-700">
                {error}
              </p>
            ) : null}

            <Button type="submit" variant="primary" className="h-11 text-sm" busy={busy} disabled={!email.trim() || !password}>
              Entrar <span aria-hidden>→</span>
            </Button>
          </form>

          <p className="mt-6 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Ambiente de demonstração: use um usuário de exemplo (ex.: ana.souza@nexo.com.br, funcionária, ou marcos.oliveira@nexo.com.br, analista) e qualquer senha.
          </p>
        </div>

        <div className="flex justify-between text-xs text-slate-400">
          <span>© 2026 Nexo · Service desk de TI</span>
          <span>Privacidade e uso de dados</span>
        </div>
      </section>
    </div>
  );
}
