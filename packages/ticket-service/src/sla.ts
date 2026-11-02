import { OPEN_TICKET_STATUSES, SLA_BY_PRIORITY, type TicketPriority, type TicketStatus } from '@nexo/shared';
import { addBusinessDays, addBusinessHours } from './business-time.js';

/** Prazo (primeira resposta ou próxima atualização) contado a partir de `from`. Regras: `SLA_BY_PRIORITY`. */
export function computeSlaDueAt(priority: TicketPriority, from: Date): Date {
  const rule = SLA_BY_PRIORITY[priority];
  switch (rule.unit) {
    case 'CLOCK_HOURS':
      return new Date(from.getTime() + rule.amount * 3_600_000);
    case 'BUSINESS_HOURS':
      return addBusinessHours(from, rule.amount);
    case 'BUSINESS_DAYS':
      return addBusinessDays(from, rule.amount);
  }
}

export function isOpenStatus(status: TicketStatus): boolean {
  return OPEN_TICKET_STATUSES.includes(status);
}

/** Vencido = prazo passou e o chamado segue aberto. Resolvido/fechado nunca está vencido. */
export function isOverdue(ticket: { status: TicketStatus; slaDueAt: Date }, now: Date): boolean {
  return isOpenStatus(ticket.status) && now.getTime() > ticket.slaDueAt.getTime();
}
