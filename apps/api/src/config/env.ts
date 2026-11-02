import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL é obrigatória')
    .refine((value) => /^postgres(ql)?:\/\//.test(value), 'DATABASE_URL deve usar postgres:// ou postgresql://'),
  /** Tempo máximo da checagem de banco no /health. */
  HEALTH_DB_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
  /** Modelo do agente (`provedor/modelo`). Opcional na P0.1: o agente ainda não é invocado. */
  AGENT_MODEL: z.string().min(3).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';

  constructor(readonly issues: string[]) {
    super(`Configuração inválida:\n- ${issues.join('\n- ')}`);
  }
}

/** Valida as variáveis de ambiente. Nunca inclui valores (podem ser segredos) nas mensagens. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`),
    );
  }
  return result.data;
}
