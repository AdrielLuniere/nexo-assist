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
  /**
   * Modelo do agente no formato `provedor/modelo` do model router do Mastra (ex.: `anthropic/claude-haiku-5-5`).
   * A chave do provedor vem da variável dele (ex.: ANTHROPIC_API_KEY), lida pelo Mastra. Sem modelo, a API
   * funciona, as mensagens são gravadas e a resposta do agente fica pendente (AGENT_UNAVAILABLE).
   */
  AGENT_MODEL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().regex(/^[a-z0-9-]+\/[\w.:-]+$/i, 'AGENT_MODEL deve ter o formato provedor/modelo').optional(),
  ),
  /** Tempo máximo de uma resposta do agente (inclui ferramentas). */
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(45_000),
  /** Respostas do agente executando ao mesmo tempo neste processo (custo e cota do provedor). */
  AGENT_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  /**
   * Segredo que assina os tokens de sessão (mínimo 32 caracteres). Obrigatório em produção; fora dela,
   * se ausente, a API gera um segredo efêmero (as sessões não sobrevivem a um reinício).
   */
  AUTH_SECRET: z.preprocess(
    // `AUTH_SECRET=` vazio no .env conta como ausente.
    (value) => (value === '' ? undefined : value),
    z.string().min(32, 'AUTH_SECRET deve ter ao menos 32 caracteres').optional(),
  ),
  /** Duração da sessão demonstrativa, em minutos. */
  AUTH_SESSION_TTL_MINUTES: z.coerce.number().int().min(1).max(10_080).default(480),
}).superRefine((value, ctx) => {
  if (value.NODE_ENV === 'production' && !value.AUTH_SECRET) {
    ctx.addIssue({ code: 'custom', path: ['AUTH_SECRET'], message: 'AUTH_SECRET é obrigatória em produção' });
  }
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
