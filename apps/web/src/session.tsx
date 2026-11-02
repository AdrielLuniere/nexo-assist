import { type LoginResponse, LoginResponseSchema, type User } from '@nexo/shared';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { type ApiClient, type ApiError, createApiClient } from './lib/api';

/**
 * Sessão do usuário. O token fica no `localStorage` ("Manter conectado") ou no `sessionStorage` (some
 * ao fechar o navegador). Papel e nível sempre são relidos da API (`/api/auth/me`) ao abrir o app; o
 * que está guardado serve só para não piscar a tela de login.
 */

const STORAGE_KEY = 'nexo-assist.session';

export type SessionState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'signed-out'; readonly reason: 'expired' | 'logout' | null }
  | { readonly kind: 'signed-in'; readonly user: User; readonly expiresAt: string };

interface SessionContextValue {
  readonly state: SessionState;
  readonly client: ApiClient;
  login(email: string, password: string, remember: boolean): Promise<User>;
  logout(): void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function readStored(): LoginResponse | null {
  for (const storage of [safeStorage('local'), safeStorage('session')]) {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) continue;
    try {
      const parsed = LoginResponseSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // ignorado: sessão corrompida conta como ausente
    }
  }
  return null;
}

function safeStorage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function clearStored() {
  safeStorage('local')?.removeItem(STORAGE_KEY);
  safeStorage('session')?.removeItem(STORAGE_KEY);
}

export interface SessionProviderProps {
  readonly children: ReactNode;
  /** Origem da API (testes). Em produção, a mesma origem. */
  readonly baseUrl?: string;
  readonly now?: () => Date;
}

export function SessionProvider({ children, baseUrl, now = () => new Date() }: SessionProviderProps) {
  const tokenRef = useRef<string | null>(readStored()?.token ?? null);
  const [state, setState] = useState<SessionState>(() => (tokenRef.current ? { kind: 'checking' } : { kind: 'signed-out', reason: null }));

  const expire = useCallback(() => {
    tokenRef.current = null;
    clearStored();
    setState({ kind: 'signed-out', reason: 'expired' });
  }, []);

  const client = useMemo(
    () =>
      createApiClient({
        ...(baseUrl === undefined ? {} : { baseUrl }),
        getToken: () => tokenRef.current,
        onUnauthorized: (_error: ApiError) => expire(),
      }),
    [baseUrl, expire],
  );

  // Ao abrir: confere a sessão guardada com a API (papel e nível vêm do servidor).
  useEffect(() => {
    const stored = readStored();
    if (!stored) return;
    if (new Date(stored.expiresAt).getTime() <= now().getTime()) {
      expire();
      return;
    }
    let cancelled = false;
    client
      .me()
      .then((user) => {
        if (!cancelled) setState({ kind: 'signed-in', user, expiresAt: stored.expiresAt });
      })
      .catch(() => {
        // 401 já tratado por `onUnauthorized`; outros erros (API fora): volta ao login sem apagar nada.
        if (!cancelled && tokenRef.current) setState({ kind: 'signed-out', reason: null });
      });
    return () => {
      cancelled = true;
    };
    // Só na montagem.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Expira no horário do token, mesmo sem nenhuma requisição.
  useEffect(() => {
    if (state.kind !== 'signed-in') return;
    const ms = new Date(state.expiresAt).getTime() - now().getTime();
    const timer = setTimeout(expire, Math.max(0, Math.min(ms, 2_147_000_000)));
    return () => clearTimeout(timer);
  }, [state, expire, now]);

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      client,
      async login(email, password, remember) {
        const response = await client.login(email, password);
        tokenRef.current = response.token;
        clearStored();
        (remember ? safeStorage('local') : safeStorage('session'))?.setItem(STORAGE_KEY, JSON.stringify(response));
        setState({ kind: 'signed-in', user: response.user, expiresAt: response.expiresAt });
        return response.user;
      },
      logout() {
        tokenRef.current = null;
        clearStored();
        setState({ kind: 'signed-out', reason: 'logout' });
      },
    }),
    [state, client],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession fora de SessionProvider');
  return value;
}

/** Usuário logado (só dentro das áreas autenticadas). */
export function useUser(): User {
  const { state } = useSession();
  if (state.kind !== 'signed-in') throw new Error('useUser sem sessão');
  return state.user;
}
