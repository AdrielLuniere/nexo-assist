import { TICKET_CODE_PATTERN } from '@nexo/shared';
import { isOverdue } from '@nexo/ticket-service';
import { describe, expect, it } from 'vitest';
import { buildSeedData } from './data.js';

const NOW = new Date('2026-11-02T13:00:00Z'); // segunda-feira, 10h em America/Sao_Paulo

describe('dados de exemplo', () => {
  const data = buildSeedData(NOW);
  const byCode = (code: string) => {
    const ticket = data.tickets.find((t) => t.code === code);
    if (!ticket) throw new Error(`chamado ${code} ausente do seed`);
    return ticket;
  };

  it('é determinístico para o mesmo instante de referência', () => {
    expect(buildSeedData(NOW)).toEqual(data);
  });

  it('traz funcionários, analistas N1/N2 e de 5 a 10 artigos (Anexo B)', () => {
    expect(data.users.filter((u) => u.role === 'EMPLOYEE').length).toBeGreaterThanOrEqual(4);
    expect(data.users.filter((u) => u.role === 'ANALYST').map((u) => u.analystLevel).sort()).toEqual(['N1', 'N2']);
    expect(data.helpArticles.length).toBeGreaterThanOrEqual(5);
    expect(data.helpArticles.length).toBeLessThanOrEqual(10);
    expect(data.users.every((u) => u.email.endsWith('@nexo.com.br'))).toBe(true);
  });

  it('inclui os exemplos do PRD', () => {
    expect(byCode('INC-20311')).toMatchObject({ title: 'Notebook lento após atualização do Windows', category: 'HARDWARE', priority: 'MEDIUM', status: 'WAITING_ANALYST' });
    expect(byCode('REQ-10442')).toMatchObject({ title: 'Segundo monitor para home office', category: 'HARDWARE', priority: 'LOW', status: 'APPROVED' });
    expect(byCode('INC-20150')).toMatchObject({ title: 'Senha do SAP bloqueada', category: 'ACCESS', priority: 'MEDIUM', status: 'RESOLVED' });
    expect(data.helpArticles.map((a) => a.body).join(' ')).toContain('erro 809');
    expect(data.helpArticles.map((a) => a.body).join(' ')).toContain('das 8h às 18h');
  });

  it('cobre aberto, vencido, resolvido recentemente, resolvido fora da janela e de outros funcionários', () => {
    expect(isOverdue(byCode('INC-20311'), NOW)).toBe(true);
    expect(isOverdue(byCode('INC-20352'), NOW)).toBe(true);
    expect(isOverdue(byCode('INC-20335'), NOW)).toBe(false);
    expect(isOverdue(byCode('INC-20344'), NOW)).toBe(false);

    const daysSinceResolved = (code: string) => (NOW.getTime() - (byCode(code).resolvedAt?.getTime() ?? NaN)) / 86_400_000;
    expect(daysSinceResolved('INC-20150')).toBeCloseTo(4, 5);
    expect(daysSinceResolved('INC-20290')).toBeLessThan(7);
    expect(daysSinceResolved('INC-19980')).toBeGreaterThan(7);

    expect(new Set(data.tickets.map((t) => t.requesterId)).size).toBeGreaterThanOrEqual(4);
  });

  it('códigos, ids e relações são consistentes', () => {
    expect(data.tickets.every((t) => TICKET_CODE_PATTERN.test(t.code))).toBe(true);
    expect(new Set(data.tickets.map((t) => t.code)).size).toBe(data.tickets.length);
    const userIds = new Set(data.users.map((u) => u.id));
    expect(data.tickets.every((t) => userIds.has(t.requesterId))).toBe(true);
    const ticketIds = new Set(data.tickets.map((t) => t.id));
    expect(data.events.every((e) => ticketIds.has(e.ticketId))).toBe(true);
    expect(new Set(data.events.map((e) => e.id)).size).toBe(data.events.length);
  });

  it('a sequência cobre o maior código de cada tipo', () => {
    for (const type of ['INC', 'REQ'] as const) {
      const max = Math.max(...data.tickets.filter((t) => t.type === type).map((t) => Number(t.code.slice(4))));
      expect(data.sequences[type]).toBe(max);
    }
  });
});
