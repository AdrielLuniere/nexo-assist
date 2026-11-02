import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './env.js';

const DATABASE_URL = 'postgresql://nexo:segredo@localhost:55432/nexo_assist';

describe('loadEnv', () => {
  it('aplica valores padrão', () => {
    const env = loadEnv({ DATABASE_URL });
    expect(env).toMatchObject({ NODE_ENV: 'development', API_HOST: '127.0.0.1', API_PORT: 3333 });
    expect(env.AGENT_MODEL).toBeUndefined();
  });

  it('converte números vindos como texto', () => {
    expect(loadEnv({ DATABASE_URL, API_PORT: '4000' }).API_PORT).toBe(4000);
  });

  it('falha sem DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);
  });

  it('AUTH_SECRET é opcional fora de produção e a sessão dura 8 horas por padrão', () => {
    const env = loadEnv({ DATABASE_URL });
    expect(env.AUTH_SECRET).toBeUndefined();
    expect(env.AUTH_SESSION_TTL_MINUTES).toBe(480);
  });

  it('AUTH_SECRET vazio conta como ausente (mas segue obrigatório em produção)', () => {
    expect(loadEnv({ DATABASE_URL, AUTH_SECRET: '' }).AUTH_SECRET).toBeUndefined();
    expect(() => loadEnv({ DATABASE_URL, NODE_ENV: 'production', AUTH_SECRET: '' })).toThrow(/AUTH_SECRET/);
  });

  it('exige AUTH_SECRET em produção', () => {
    expect(() => loadEnv({ DATABASE_URL, NODE_ENV: 'production' })).toThrow(/AUTH_SECRET/);
    expect(loadEnv({ DATABASE_URL, NODE_ENV: 'production', AUTH_SECRET: 'x'.repeat(32) }).AUTH_SECRET).toHaveLength(32);
  });

  it('recusa AUTH_SECRET curto sem expor o valor', () => {
    try {
      loadEnv({ DATABASE_URL, AUTH_SECRET: 'curto-demais' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as Error).message).toContain('AUTH_SECRET');
      expect((error as Error).message).not.toContain('curto-demais');
    }
  });

  it('não expõe valores na mensagem de erro', () => {
    try {
      loadEnv({ DATABASE_URL: 'mysql://user:senha-super-secreta@host/db' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as Error).message).toContain('DATABASE_URL');
      expect((error as Error).message).not.toContain('senha-super-secreta');
    }
  });
});
