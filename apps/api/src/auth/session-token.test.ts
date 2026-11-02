import { describe, expect, it } from 'vitest';
import { SessionTokenError, issueSessionToken, verifySessionToken } from './session-token.js';

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres!!';
const NOW = new Date('2026-11-02T13:00:00Z');

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SessionTokenError) return error.reason;
    throw error;
  }
  return 'ok';
}

describe('token de sessão', () => {
  it('emite e valida, devolvendo só o id do usuário', () => {
    const { token, expiresAt } = issueSessionToken(SECRET, 'usr_ana', NOW, 3600);
    expect(expiresAt.toISOString()).toBe('2026-11-02T14:00:00.000Z');
    expect(verifySessionToken(SECRET, token, NOW)).toEqual({ userId: 'usr_ana' });
  });

  it('não carrega papel nem nível no payload', () => {
    const { token } = issueSessionToken(SECRET, 'usr_marcos', NOW, 3600);
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sub']);
  });

  it('expira exatamente no instante de expiração', () => {
    const { token } = issueSessionToken(SECRET, 'usr_ana', NOW, 60);
    expect(reasonOf(() => verifySessionToken(SECRET, token, new Date(NOW.getTime() + 59_000)))).toBe('ok');
    expect(reasonOf(() => verifySessionToken(SECRET, token, new Date(NOW.getTime() + 60_000)))).toBe('expired');
  });

  it('rejeita assinatura de outro segredo', () => {
    const { token } = issueSessionToken('outro-segredo-com-mais-de-32-caracteres!!!', 'usr_ana', NOW, 3600);
    expect(reasonOf(() => verifySessionToken(SECRET, token, NOW))).toBe('bad_signature');
  });

  it('rejeita payload adulterado (trocar o usuário)', () => {
    const { token } = issueSessionToken(SECRET, 'usr_ana', NOW, 3600);
    const [version, , signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'usr_marcos', iat: 0, exp: 9_999_999_999 })).toString('base64url');
    expect(reasonOf(() => verifySessionToken(SECRET, `${version}.${forged}.${signature}`, NOW))).toBe('bad_signature');
  });

  it.each(['', 'abc', 'a.b', 'v2.x.y', 'v1..', 'v1.x.', '....', 'Bearer x.y.z'])('rejeita token malformado %j', (token) => {
    expect(['malformed', 'bad_signature']).toContain(reasonOf(() => verifySessionToken(SECRET, token, NOW)));
  });

  it('rejeita assinatura de tamanho diferente sem lançar erro inesperado', () => {
    const { token } = issueSessionToken(SECRET, 'usr_ana', NOW, 3600);
    expect(reasonOf(() => verifySessionToken(SECRET, `${token}AAAA`, NOW))).toBe('bad_signature');
    expect(reasonOf(() => verifySessionToken(SECRET, token.slice(0, -4), NOW))).toBe('bad_signature');
  });
});
