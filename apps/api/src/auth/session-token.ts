import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Token de sessão assinado (HMAC-SHA256), no formato `v1.<payload>.<assinatura>`.
 *
 * O token só prova "quem" (`sub`) e "até quando" (`exp`). Papel e nível NÃO viajam nele: a cada
 * requisição o usuário é relido do banco, então rebaixar ou remover um usuário vale na hora e
 * nada que o cliente edite muda o que ele pode fazer.
 */

const VERSION = 'v1';

export type TokenFailure = 'malformed' | 'bad_signature' | 'expired';

export class SessionTokenError extends Error {
  override readonly name = 'SessionTokenError';

  constructor(readonly reason: TokenFailure) {
    super(`token de sessão inválido: ${reason}`);
  }
}

interface Payload {
  /** Id do usuário. */
  sub: string;
  /** Emitido em (segundos desde a época). */
  iat: number;
  /** Expira em (segundos desde a época). */
  exp: number;
}

const base64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

function sign(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function issueSessionToken(secret: string, userId: string, now: Date, ttlSeconds: number): { token: string; expiresAt: Date } {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ttlSeconds;
  const payload: Payload = { sub: userId, iat, exp };
  const body = `${VERSION}.${base64url(JSON.stringify(payload))}`;
  return { token: `${body}.${base64url(sign(secret, body))}`, expiresAt: new Date(exp * 1000) };
}

/** Valida formato, assinatura (tempo constante) e validade. Lança `SessionTokenError`. */
export function verifySessionToken(secret: string, token: string, now: Date): { userId: string } {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2]) throw new SessionTokenError('malformed');

  const body = `${parts[0]}.${parts[1]}`;
  const given = Buffer.from(parts[2], 'base64url');
  const expected = sign(secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new SessionTokenError('bad_signature');

  let payload: Partial<Payload>;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Partial<Payload>;
  } catch {
    throw new SessionTokenError('malformed');
  }
  if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.exp !== 'number') {
    throw new SessionTokenError('malformed');
  }
  if (Math.floor(now.getTime() / 1000) >= payload.exp) throw new SessionTokenError('expired');
  return { userId: payload.sub };
}
