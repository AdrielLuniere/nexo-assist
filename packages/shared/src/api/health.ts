import { z } from 'zod';

export const DependencyCheckSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().int().nonnegative().optional(),
  /** Mensagem resumida, sem credenciais nem string de conexão. */
  error: z.string().optional(),
});
export type DependencyCheck = z.infer<typeof DependencyCheckSchema>;

/**
 * `GET /health`: 200 quando todas as dependências estão de pé; 503 com `status: "degraded"`
 * quando alguma está fora (semântica de readiness).
 */
export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal('nexo-assist-api'),
  version: z.string(),
  uptimeSeconds: z.number().int().nonnegative(),
  timestamp: z.iso.datetime({ offset: true }),
  checks: z.object({
    database: DependencyCheckSchema,
  }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
