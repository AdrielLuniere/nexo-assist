import type { User, UserRole } from '@nexo/shared';
import type { RequestHandler } from 'express';
import type { AuthService } from '../../auth/auth-service.js';
import { AppError } from '../app-error.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Definido por `authenticate`. Sempre vem do servidor (token assinado + banco), nunca do cliente. */
    user?: User;
  }
}

const MAX_TOKEN_LENGTH = 2048;
const BEARER = /^Bearer\s+(\S+)$/i;

/** Exige `Authorization: Bearer <token>` válido e carrega o usuário em `req.user`. */
export function authenticate(auth: AuthService): RequestHandler {
  return async (req, res, next) => {
    const token = BEARER.exec(req.header('authorization') ?? '')?.[1];
    res.setHeader('www-authenticate', 'Bearer');
    if (!token || token.length > MAX_TOKEN_LENGTH) {
      next(new AppError('UNAUTHENTICATED', 'Autenticação necessária.'));
      return;
    }
    try {
      req.user = await auth.authenticate(token);
      res.removeHeader('www-authenticate');
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Restringe a rota a papéis específicos. Deve vir depois de `authenticate`. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      next(new AppError('UNAUTHENTICATED', 'Autenticação necessária.'));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new AppError('FORBIDDEN', 'Você não tem permissão para acessar este recurso.'));
      return;
    }
    next();
  };
}

/**
 * Restringe a rota a analistas de suporte (N1 ou N2). Papel e nível vêm do banco (ver `authenticate`);
 * um usuário marcado como analista sem nível definido é dado inconsistente e também é recusado.
 */
export const requireAnalyst: RequestHandler = (req, res, next) => {
  requireRole('ANALYST')(req, res, (error?: unknown) => {
    if (error) {
      next(error);
      return;
    }
    if (req.user?.analystLevel == null) {
      next(new AppError('FORBIDDEN', 'Você não tem permissão para acessar este recurso.'));
      return;
    }
    next();
  });
};

/** Usuário autenticado da requisição; falha se a rota esqueceu de passar por `authenticate`. */
export function currentUser(req: { user?: User }): User {
  if (!req.user) throw new AppError('UNAUTHENTICATED', 'Autenticação necessária.');
  return req.user;
}
