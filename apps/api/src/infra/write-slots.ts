import type { PrismaClient } from './prisma.js';

/**
 * Filas locais (em memória, por processo) que limitam quantos trabalhos rodam ao mesmo tempo.
 *
 * Toda espera tem prazo: quem passa de `acquireTimeoutMs` na fila desiste com `BusyError` (a API
 * responde 503 repetível) em vez de ficar pendurado indefinidamente sob carga.
 *
 * Usos:
 * - `writeSlotsFor(prisma)`: transações "de escrita com trava" (que esperam uma trava de linha ou
 *   advisory lock no PostgreSQL). Sem o limite, uma rajada na mesma conversa põe cada transação para
 *   esperar a trava SEGURANDO uma conexão: o pool (10 por padrão) se esgota e até leituras simples de
 *   outros usuários ficam sem conexão. Aqui a espera acontece sem conexão, e o limite fica abaixo do
 *   pool para sempre sobrar conexão para leituras. A trava no banco continua sendo a garantia de
 *   correção entre processos; o limite só protege a disponibilidade dentro de um processo.
 * - Respostas do agente: uma por conversa de cada vez (`createKeyedLock`) e um teto global de
 *   execuções simultâneas do modelo (custo e cota do provedor).
 *
 * Regra de uso: quem está dentro de `run` não pode chamar `run` da MESMA fila de novo (deadlock).
 */

/** Recurso que estava ocupado; a camada HTTP escolhe o código de erro. */
export type BusyResource = 'database' | 'agent';

export class BusyError extends Error {
  override readonly name = 'BusyError';

  constructor(readonly resource: BusyResource) {
    super(`fila local de ${resource} ocupada: tempo de espera esgotado`);
  }
}

export interface Slots {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export interface SlotsOptions {
  readonly max: number;
  readonly acquireTimeoutMs: number;
  readonly resource: BusyResource;
}

export function createSlots(options: SlotsOptions): Slots {
  let active = 0;
  const waiting: Array<() => void> = [];

  // A vaga passa direto para o próximo da fila (sem decrementar), preservando a ordem de chegada.
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  const acquire = () =>
    new Promise<void>((resolve, reject) => {
      if (active < options.max) {
        active++;
        resolve();
        return;
      }
      const grant = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = waiting.indexOf(grant);
        if (index >= 0) waiting.splice(index, 1);
        reject(new BusyError(options.resource));
      }, options.acquireTimeoutMs);
      waiting.push(grant);
    });

  return {
    async run(work) {
      await acquire();
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}

export interface KeyedLock {
  /** Executa `work` com exclusividade para `key` (ex.: uma resposta do agente por conversa). */
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
}

export function createKeyedLock(options: Omit<SlotsOptions, 'max'>): KeyedLock {
  const locks = new Map<string, { slots: Slots; users: number }>();
  return {
    async run(key, work) {
      let entry = locks.get(key);
      if (!entry) {
        entry = { slots: createSlots({ ...options, max: 1 }), users: 0 };
        locks.set(key, entry);
      }
      entry.users++;
      try {
        return await entry.slots.run(work);
      } finally {
        entry.users--;
        if (entry.users === 0) locks.delete(key);
      }
    },
  };
}

/** Pool padrão do `pg` é 10 conexões; metade fica reservada para leituras. */
export const DEFAULT_WRITE_SLOTS = 5;

/** Mesmo prazo do `maxWait` das transações: além disso, a requisição desiste com 503 repetível. */
export const DEFAULT_WRITE_WAIT_MS = 10_000;

export function createWriteSlots(max: number = DEFAULT_WRITE_SLOTS, acquireTimeoutMs: number = DEFAULT_WRITE_WAIT_MS): Slots {
  return createSlots({ max, acquireTimeoutMs, resource: 'database' });
}

/** Mantido pelo nome usado nas fases anteriores. */
export type WriteSlots = Slots;

const registry = new WeakMap<object, Slots>();

/** Uma instância por `PrismaClient` (cada cliente tem o seu pool). */
export function writeSlotsFor(prisma: PrismaClient): Slots {
  let slots = registry.get(prisma);
  if (!slots) {
    slots = createWriteSlots();
    registry.set(prisma, slots);
  }
  return slots;
}
