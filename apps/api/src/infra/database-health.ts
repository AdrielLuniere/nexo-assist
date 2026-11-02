import type { DependencyCheck } from '@nexo/shared';
import type { PrismaClient } from './prisma.js';

export type DatabaseCheck = () => Promise<DependencyCheck>;

/** `SELECT 1` com tempo limite. A mensagem de erro é genérica para não vazar host ou credenciais. */
export function createDatabaseCheck(prisma: PrismaClient, timeoutMs: number): DatabaseCheck {
  return async () => {
    const startedAt = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
      return { status: 'up', latencyMs: Math.round(performance.now() - startedAt) };
    } catch (error) {
      const reason = error instanceof Error && error.message === 'timeout' ? 'tempo esgotado' : 'falha de conexão';
      return { status: 'down', latencyMs: Math.round(performance.now() - startedAt), error: reason };
    } finally {
      clearTimeout(timer);
    }
  };
}
