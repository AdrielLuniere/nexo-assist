import { describe, expect, it } from 'vitest';
import { DraftPayloadSchema } from './draft.js';
import { TicketCodeSchema } from './ticket.js';

const validCreate = {
  operation: 'CREATE',
  fields: {
    type: 'INC',
    title: 'VPN não conecta (erro 809)',
    description: 'Desde hoje cedo a VPN retorna erro 809 no Windows 11.',
    category: 'NETWORK_VPN',
    priority: 'HIGH',
    affectedScope: 'INDIVIDUAL',
    affectedDescription: 'Somente o solicitante',
  },
  priorityAssessment: {
    priority: 'HIGH',
    impact: 'Uma pessoa',
    urgency: 'Impede de trabalhar',
    rationale: 'Sem VPN o funcionário não acessa os sistemas internos.',
  },
};

describe('rascunho de chamado (Anexo A, "Abertura")', () => {
  it('aceita rascunho de criação completo', () => {
    expect(DraftPayloadSchema.parse(validCreate).operation).toBe('CREATE');
  });

  it.each(['type', 'title', 'description', 'category', 'priority', 'affectedScope', 'affectedDescription'])(
    'rejeita criação sem o campo obrigatório %s',
    (field) => {
      const fields: Record<string, unknown> = { ...validCreate.fields };
      delete fields[field];
      expect(DraftPayloadSchema.safeParse({ ...validCreate, fields }).success).toBe(false);
    },
  );

  it('atualização exige código de chamado válido', () => {
    const update = { operation: 'UPDATE', ticketCode: 'INC-20311', comment: 'Agora também trava ao abrir o Teams.' };
    expect(DraftPayloadSchema.safeParse(update).success).toBe(true);
    expect(DraftPayloadSchema.safeParse({ ...update, ticketCode: '20311' }).success).toBe(false);
  });
});

describe('código de chamado', () => {
  it('segue o formato do Anexo B', () => {
    expect(TicketCodeSchema.safeParse('REQ-10442').success).toBe(true);
    expect(TicketCodeSchema.safeParse('INC-1').success).toBe(false);
    expect(TicketCodeSchema.safeParse('ABC-12345').success).toBe(false);
  });
});
