import type { ConversationStatus } from '@nexo/shared';
import { describe, expect, it } from 'vitest';
import { encodeCursor, decodeCursor } from './console-service.js';
import { escapeLike } from './console-repository.js';
import { type ConsoleAction, type ConversationState, decidePost, decideTransition } from './console-rules.js';

const state = (status: ConversationStatus, assignedAnalystId: string | null = null, version = 4): ConversationState => ({ status, version, assignedAnalystId });
const ME = 'usr_marcos';
const OTHER = 'usr_paula';

describe('decideTransition', () => {
  const kind = (s: ConversationState, action: ConsoleAction, analyst = ME, expected = s.version) => decideTransition(s, action, analyst, expected).kind;

  it('assumir: só a partir de WAITING_ANALYST, por qualquer analista', () => {
    expect(decideTransition(state('WAITING_ANALYST'), 'assume', ME, 4)).toEqual({
      kind: 'apply',
      to: 'WITH_ANALYST',
      assignedAnalystId: ME,
      handoff: { from: ['WAITING'], to: 'ASSUMED' },
    });
    expect(kind(state('WAITING_ANALYST'), 'assume', OTHER)).toBe('apply');
    for (const status of ['WITH_AGENT', 'CLOSED'] as const) expect(kind(state(status), 'assume')).toBe('invalid_state');
    expect(kind(state('WITH_ANALYST', OTHER), 'assume')).toBe('invalid_state');
  });

  it('devolver: só o responsável, a partir de WITH_ANALYST, e limpa o responsável', () => {
    expect(decideTransition(state('WITH_ANALYST', ME), 'return', ME, 4)).toEqual({
      kind: 'apply',
      to: 'WITH_AGENT',
      assignedAnalystId: null,
      handoff: { from: ['ASSUMED'], to: 'RETURNED_TO_AGENT' },
    });
    expect(kind(state('WITH_ANALYST', OTHER), 'return')).toBe('not_owner');
    for (const status of ['WAITING_ANALYST', 'WITH_AGENT', 'CLOSED'] as const) expect(kind(state(status), 'return')).toBe('invalid_state');
  });

  it('encerrar: qualquer analista se aguarda; só o responsável se em atendimento; mantém quem atendeu', () => {
    expect(decideTransition(state('WAITING_ANALYST'), 'close', OTHER, 4)).toMatchObject({ kind: 'apply', to: 'CLOSED', assignedAnalystId: null, handoff: { from: ['WAITING'], to: 'CLOSED' } });
    expect(decideTransition(state('WITH_ANALYST', ME), 'close', ME, 4)).toMatchObject({ kind: 'apply', to: 'CLOSED', assignedAnalystId: ME, handoff: { from: ['ASSUMED'], to: 'CLOSED' } });
    expect(kind(state('WITH_ANALYST', OTHER), 'close')).toBe('not_owner');
    for (const status of ['WITH_AGENT', 'CLOSED'] as const) expect(kind(state(status), 'close')).toBe('invalid_state');
  });

  it('versão: divergência é conflito, e o responsável vem antes da versão', () => {
    expect(kind(state('WAITING_ANALYST'), 'assume', ME, 3)).toBe('stale');
    expect(kind(state('WAITING_ANALYST'), 'close', ME, 9)).toBe('stale');
    expect(kind(state('WITH_ANALYST', OTHER), 'return', ME, 1)).toBe('not_owner'); // mesmo com versão velha
    expect(kind(state('WITH_ANALYST', OTHER), 'assume', ME, 4)).toBe('invalid_state');
  });

  it('repetir o próprio "assumir" é idempotente; qualquer outra coisa com versão velha é conflito', () => {
    expect(kind(state('WITH_ANALYST', ME, 5), 'assume', ME, 4)).toBe('replay');
    expect(kind(state('WITH_ANALYST', ME, 6), 'assume', ME, 4)).toBe('stale'); // houve mais mudanças no meio
    expect(kind(state('WITH_ANALYST', OTHER, 5), 'assume', ME, 4)).toBe('stale'); // outro assumiu
    expect(kind(state('WITH_ANALYST', ME, 5), 'return', ME, 4)).toBe('stale');
  });
});

describe('decidePost', () => {
  it('só o responsável, e só com a conversa em atendimento humano', () => {
    expect(decidePost(state('WITH_ANALYST', ME), ME).kind).toBe('allow');
    expect(decidePost(state('WITH_ANALYST', OTHER), ME).kind).toBe('not_owner');
    for (const status of ['WAITING_ANALYST', 'WITH_AGENT', 'CLOSED'] as const) expect(decidePost(state(status, ME), ME).kind).toBe('invalid_state');
  });
});

describe('escapeLike', () => {
  it('torna literais os curingas do LIKE e a própria barra', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('c:\\dir')).toBe('c:\\\\dir');
    expect(escapeLike('texto comum')).toBe('texto comum');
  });
});

describe('cursor de paginação', () => {
  it('vai e volta sem perder a precisão do instante', () => {
    const at = new Date('2026-11-02T10:05:00.123Z');
    expect(decodeCursor(encodeCursor(at, 'conv_1'))).toEqual({ updatedAt: at, id: 'conv_1' });
  });

  it('recusa lixo, formato errado e datas inválidas', () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const cursor of ['lixo', '', encode(['x']), encode([1, 'a']), encode(['2026-11-02T10:05:00Z', '']), encode(['não-é-data', 'a']), encode({ a: 1 }), encode(['2026-11-02T10:05:00Z', 'x'.repeat(65)])]) {
      expect(() => decodeCursor(cursor), cursor).toThrow('Cursor de paginação inválido.');
    }
  });
});
