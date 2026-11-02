import type { LoginResponse, User } from '@nexo/shared';
import { AppError } from '../http/app-error.js';
import { SessionTokenError, issueSessionToken, verifySessionToken } from './session-token.js';
import type { UserRepository } from './user-repository.js';

export interface AuthServiceOptions {
  readonly users: UserRepository;
  readonly secret: string;
  readonly sessionTtlSeconds: number;
  readonly now?: () => Date;
}

export interface AuthService {
  /** Login demonstrativo: e-mail de usuário cadastrado + qualquer senha não vazia (PRD, Tela 1). */
  login(email: string, password: string): Promise<LoginResponse>;
  /** Resolve o usuário a partir do token. Lança `AppError` UNAUTHENTICATED. */
  authenticate(token: string): Promise<User>;
}

/** Mesma resposta para e-mail desconhecido e qualquer outra falha de credencial. */
const INVALID_CREDENTIALS = () => new AppError('INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const now = options.now ?? (() => new Date());

  return {
    async login(email, password) {
      if (password.trim() === '') throw INVALID_CREDENTIALS();
      const user = await options.users.findByEmail(normalizeEmail(email));
      if (!user) throw INVALID_CREDENTIALS();

      const { token, expiresAt } = issueSessionToken(options.secret, user.id, now(), options.sessionTtlSeconds);
      return { token, expiresAt: expiresAt.toISOString(), user };
    },

    async authenticate(token) {
      let userId: string;
      try {
        userId = verifySessionToken(options.secret, token, now()).userId;
      } catch (error) {
        if (error instanceof SessionTokenError && error.reason === 'expired') {
          throw new AppError('UNAUTHENTICATED', 'Sessão expirada. Entre novamente.');
        }
        throw new AppError('UNAUTHENTICATED', 'Sessão inválida. Entre novamente.');
      }
      // Papel e nível vêm sempre do banco, nunca do token.
      const user = await options.users.findById(userId);
      if (!user) throw new AppError('UNAUTHENTICATED', 'Sessão inválida. Entre novamente.');
      return user;
    },
  };
}
