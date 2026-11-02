import { classifyPriority, priorityScopeConflict } from '@nexo/shared';
import { describe, expect, it } from 'vitest';
import { addBusinessDays, addBusinessHours, alignToBusinessTime } from './business-time.js';
import { computeSlaDueAt, isOverdue } from './sla.js';

// America/Sao_Paulo = UTC-3 (sem horário de verão). Helper: horário local -> instante UTC.
const local = (iso: string) => new Date(`${iso}-03:00`);

describe('tempo útil (seg-sex, 8h-18h, America/Sao_Paulo)', () => {
  it('mantém instantes dentro do expediente', () => {
    expect(alignToBusinessTime(local('2026-11-02T10:30:00')).toISOString()).toBe(local('2026-11-02T10:30:00').toISOString());
  });

  it('antes da abertura vai para as 8h do mesmo dia', () => {
    expect(alignToBusinessTime(local('2026-11-02T06:00:00')).toISOString()).toBe(local('2026-11-02T08:00:00').toISOString());
  });

  it('depois do expediente vai para as 8h do próximo dia útil', () => {
    expect(alignToBusinessTime(local('2026-11-02T19:00:00')).toISOString()).toBe(local('2026-11-03T08:00:00').toISOString());
  });

  it('fim de semana vai para a segunda às 8h', () => {
    // 2026-11-07 é sábado
    expect(alignToBusinessTime(local('2026-11-07T11:00:00')).toISOString()).toBe(local('2026-11-09T08:00:00').toISOString());
  });

  it('soma horas úteis no mesmo dia', () => {
    expect(addBusinessHours(local('2026-11-02T09:00:00'), 4).toISOString()).toBe(local('2026-11-02T13:00:00').toISOString());
  });

  it('horas úteis atravessam o fim do expediente', () => {
    // 16h + 4h úteis = 2h hoje + 2h amanhã -> 10h do dia seguinte
    expect(addBusinessHours(local('2026-11-02T16:00:00'), 4).toISOString()).toBe(local('2026-11-03T10:00:00').toISOString());
  });

  it('horas úteis atravessam o fim de semana', () => {
    // sexta 2026-11-06 às 17h + 4h = 1h na sexta + 3h na segunda -> segunda 11h
    expect(addBusinessHours(local('2026-11-06T17:00:00'), 4).toISOString()).toBe(local('2026-11-09T11:00:00').toISOString());
  });

  it('pedido fora do expediente começa a contar na abertura seguinte', () => {
    // sábado 10h + 4h úteis -> segunda 12h
    expect(addBusinessHours(local('2026-11-07T10:00:00'), 4).toISOString()).toBe(local('2026-11-09T12:00:00').toISOString());
  });

  it('soma dias úteis pulando fim de semana e mantendo o horário', () => {
    // quinta 14h + 3 dias úteis = sexta, segunda, terça -> terça 14h
    expect(addBusinessDays(local('2026-11-05T14:00:00'), 3).toISOString()).toBe(local('2026-11-10T14:00:00').toISOString());
  });

  it('dias úteis a partir do fim de semana contam da segunda às 8h', () => {
    expect(addBusinessDays(local('2026-11-07T10:00:00'), 3).toISOString()).toBe(local('2026-11-12T08:00:00').toISOString());
  });
});

describe('prazos por prioridade (Anexo A)', () => {
  const from = local('2026-11-02T10:00:00'); // segunda 10h

  it('Crítica: 1 hora corrida (inclusive fora do expediente)', () => {
    expect(computeSlaDueAt('CRITICAL', from).toISOString()).toBe(local('2026-11-02T11:00:00').toISOString());
    const night = local('2026-11-07T23:30:00');
    expect(computeSlaDueAt('CRITICAL', night).toISOString()).toBe(local('2026-11-08T00:30:00').toISOString());
  });

  it('Alta: 4 horas úteis', () => {
    expect(computeSlaDueAt('HIGH', from).toISOString()).toBe(local('2026-11-02T14:00:00').toISOString());
  });

  it('Média: 3 dias úteis', () => {
    expect(computeSlaDueAt('MEDIUM', from).toISOString()).toBe(local('2026-11-05T10:00:00').toISOString());
  });

  it('Baixa: 5 dias úteis', () => {
    expect(computeSlaDueAt('LOW', from).toISOString()).toBe(local('2026-11-09T10:00:00').toISOString());
  });
});

describe('vencimento', () => {
  const due = local('2026-11-02T14:00:00');

  it('aberto e passado do prazo está vencido', () => {
    expect(isOverdue({ status: 'WAITING_ANALYST', slaDueAt: due }, local('2026-11-02T14:00:01'))).toBe(true);
  });

  it('no instante exato do prazo ainda não venceu', () => {
    expect(isOverdue({ status: 'IN_PROGRESS', slaDueAt: due }, due)).toBe(false);
  });

  it('resolvido e fechado nunca estão vencidos', () => {
    const later = local('2026-12-01T10:00:00');
    expect(isOverdue({ status: 'RESOLVED', slaDueAt: due }, later)).toBe(false);
    expect(isOverdue({ status: 'CLOSED', slaDueAt: due }, later)).toBe(false);
  });
});

describe('classificação de prioridade (impacto x urgência)', () => {
  it.each([
    ['COMPANY', 'BLOCKED', 'CRITICAL'],
    ['TEAM', 'BLOCKED', 'CRITICAL'],
    ['INDIVIDUAL', 'BLOCKED', 'HIGH'],
    ['INDIVIDUAL', 'SAME_DAY_DEADLINE', 'HIGH'],
    ['TEAM', 'SAME_DAY_DEADLINE', 'HIGH'],
    ['INDIVIDUAL', 'HAS_WORKAROUND', 'MEDIUM'],
    ['TEAM', 'HAS_WORKAROUND', 'MEDIUM'],
    ['INDIVIDUAL', 'NONE', 'LOW'],
  ] as const)('%s + %s => %s', (affectedScope, urgency, expected) => {
    const result = classifyPriority({ affectedScope, urgency });
    expect(result.priority).toBe(expected);
    expect(result.rationale.length).toBeGreaterThan(0);
  });

  it('Crítica para uma pessoa contradiz o Anexo A', () => {
    expect(priorityScopeConflict('CRITICAL', 'INDIVIDUAL')).not.toBeNull();
    expect(priorityScopeConflict('CRITICAL', 'TEAM')).toBeNull();
    expect(priorityScopeConflict('HIGH', 'INDIVIDUAL')).toBeNull();
  });
});
