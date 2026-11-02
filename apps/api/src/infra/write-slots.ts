import type { PrismaClient } from './prisma.js';

/**
 * Limita quantas transações "de escrita com trava" (que esperam uma trava de linha ou advisory lock
 * no PostgreSQL) podem ocupar o pool de conexões ao mesmo tempo.
 *
 * Sem isso, uma rajada de requisições na mesma conversa ou do mesmo funcionário põe cada transação
 * para esperar a trava SEGURANDO uma conexão: o pool (10 por padrão) se esgota, as transações
 * estouram `maxWait` e até leituras simples de outros usuários ficam sem conexão (503).
 *
 * Aqui a espera acontece em memória, sem conexão. O limite fica abaixo do tamanho do pool para
 * sempre sobrar conexão para leituras (login, listagens). A trava no banco continua sendo a garantia
 * de correção entre processos; este limite só protege a disponibilidade dentro de um processo.
 *
 * Regra de uso: quem está dentro de `run` não pode chamar `run` de novo (risco de deadlock).
 */
export interface WriteSlots {
  run<T>(work: () => Promise<T>): Promise<T>;
}

/** Pool padrão do `pg` é 10 conexões; metade fica reservada para leituras. */
export const DEFAULT_WRITE_SLOTS = 5;

export function createWriteSlots(max: number = DEFAULT_WRITE_SLOTS): WriteSlots {
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  return {
    async run(work) {
      if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
      else active++;
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}

const registry = new WeakMap<object, WriteSlots>();

/** Uma instância por `PrismaClient` (cada cliente tem o seu pool). */
export function writeSlotsFor(prisma: PrismaClient): WriteSlots {
  let slots = registry.get(prisma);
  if (!slots) {
    slots = createWriteSlots();
    registry.set(prisma, slots);
  }
  return slots;
}
