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
