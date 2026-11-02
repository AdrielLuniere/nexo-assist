import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_TRANSITIONS,
  MessageBlockSchema,
  agentCanRespond,
  canTransition,
  employeeCanWrite,
} from './conversation.js';
import { CONVERSATION_STATUSES } from './enums.js';

describe('máquina de estados da conversa', () => {
  it('define transições para todos os estados', () => {
    expect(Object.keys(CONVERSATION_TRANSITIONS).sort()).toEqual([...CONVERSATION_STATUSES].sort());
  });

  it('segue o fluxo transferir → assumir → devolver/encerrar', () => {
    expect(canTransition('WITH_AGENT', 'WAITING_ANALYST')).toBe(true);
    expect(canTransition('WAITING_ANALYST', 'WITH_ANALYST')).toBe(true);
    expect(canTransition('WITH_ANALYST', 'WITH_AGENT')).toBe(true);
    expect(canTransition('WITH_ANALYST', 'CLOSED')).toBe(true);
  });

  it('não permite pular etapas nem sair de CLOSED', () => {
    expect(canTransition('WITH_AGENT', 'WITH_ANALYST')).toBe(false);
    expect(canTransition('WAITING_ANALYST', 'WITH_AGENT')).toBe(false);
    for (const status of CONVERSATION_STATUSES) {
      expect(canTransition('CLOSED', status)).toBe(false);
    }
  });

  it('agente responde somente quando a conversa está com ele', () => {
    expect(CONVERSATION_STATUSES.filter(agentCanRespond)).toEqual(['WITH_AGENT']);
  });

  it('funcionário escreve enquanto a conversa não está encerrada', () => {
    expect(employeeCanWrite('WAITING_ANALYST')).toBe(true);
    expect(employeeCanWrite('CLOSED')).toBe(false);
  });
});

describe('blocos de mensagem', () => {
  it('aceita opções rápidas', () => {
    const block = {
      type: 'quick_replies',
      options: [{ id: 'me', label: 'Só eu', value: 'Afeta só a mim' }],
    };
    expect(MessageBlockSchema.parse(block)).toEqual(block);
  });

  it('exige ao menos duas opções na seleção de chamado', () => {
    const ticket = {
      code: 'INC-20311',
      type: 'INC',
      title: 'Notebook lento após atualização do Windows',
      category: 'HARDWARE',
      priority: 'MEDIUM',
      status: 'WAITING_ANALYST',
      slaDueAt: '2026-10-29T12:00:00.000Z',
      isOverdue: true,
      updatedAt: '2026-10-26T12:00:00.000Z',
    };
    const result = MessageBlockSchema.safeParse({ type: 'ticket_selection', prompt: 'Qual?', options: [ticket] });
    expect(result.success).toBe(false);
  });

  it('rejeita tipo de bloco desconhecido', () => {
    expect(MessageBlockSchema.safeParse({ type: 'html', html: '<b>x</b>' }).success).toBe(false);
  });
});
