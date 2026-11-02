import { describe, expect, it } from 'vitest';
import { BusyError, createKeyedLock, createSlots, createWriteSlots } from './write-slots.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('write slots', () => {
  it('nunca executa mais do que o limite ao mesmo tempo e atende todos', async () => {
    const slots = createWriteSlots(3);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        slots.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await tick();
          active--;
          return i;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('atende na ordem de chegada', async () => {
    const slots = createWriteSlots(1);
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4].map((n) => slots.run(async () => void (await tick(), order.push(n)))));
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('libera a vaga quando o trabalho falha, sem travar a fila', async () => {
    const slots = createWriteSlots(1);
    const failing = slots.run(async () => {
      throw new Error('falhou');
    });
    const next = slots.run(async () => 'ok');
    await expect(failing).rejects.toThrow('falhou');
    await expect(next).resolves.toBe('ok');
    await expect(slots.run(async () => 'livre')).resolves.toBe('livre');
  });
});

describe('prazo de espera nas filas locais', () => {
  it('quem espera além do prazo desiste com BusyError e a fila continua andando', async () => {
    const slots = createSlots({ max: 1, acquireTimeoutMs: 50, resource: 'database' });
    let release!: () => void;
    const holder = slots.run(() => new Promise<void>((resolve) => (release = resolve)));
    const waiter = slots.run(async () => 'nunca');
    await expect(waiter).rejects.toBeInstanceOf(BusyError);
    await expect(waiter).rejects.toMatchObject({ resource: 'database' });
    release();
    await holder;
    // A vaga do desistente não "vaza": a próxima execução entra na hora.
    await expect(slots.run(async () => 'livre')).resolves.toBe('livre');
  });

  it('trava por chave: serializa a mesma chave, libera chaves diferentes e respeita o prazo', async () => {
    const lock = createKeyedLock({ acquireTimeoutMs: 50, resource: 'agent' });
    const order: string[] = [];
    let release!: () => void;
    const first = lock.run('conv_a', () => new Promise<void>((resolve) => (release = () => (order.push('a1'), resolve()))));
    const other = lock.run('conv_b', async () => void order.push('b'));
    await other;
    const late = lock.run('conv_a', async () => void order.push('a2'));
    await expect(late).rejects.toMatchObject({ name: 'BusyError', resource: 'agent' });
    release();
    await first;
    await lock.run('conv_a', async () => void order.push('a3'));
    expect(order).toEqual(['b', 'a1', 'a3']);
  });
});
