import type { TicketPriority, TicketStatus } from './enums.js';

/**
 * Parâmetros das regras do service desk.
 *
 * [PRD] = regra obrigatória do Anexo A/PRD.
 * [Decisão] = decisão técnica proposta; ver docs/architecture.md, seção "Regras".
 */

export type SlaUnit = 'CLOCK_HOURS' | 'BUSINESS_HOURS' | 'BUSINESS_DAYS';

export interface SlaRule {
  readonly amount: number;
  readonly unit: SlaUnit;
}

/**
 * [PRD] Prazo por prioridade. Vale para a primeira resposta e para cada atualização;
 * passado o prazo, o chamado está vencido.
 * [Decisão] Crítica conta em horas corridas, pelo plantão 24h citado no Anexo B.
 */
export const SLA_BY_PRIORITY: Readonly<Record<TicketPriority, SlaRule>> = {
  CRITICAL: { amount: 1, unit: 'CLOCK_HOURS' },
  HIGH: { amount: 4, unit: 'BUSINESS_HOURS' },
  MEDIUM: { amount: 3, unit: 'BUSINESS_DAYS' },
  LOW: { amount: 5, unit: 'BUSINESS_DAYS' },
};

/**
 * [Decisão] Expediente usado no cálculo de horas/dias úteis: o horário do service desk
 * do artigo de exemplo do Anexo B (segunda a sexta, 8h às 18h). Feriados fora do escopo.
 */
export const BUSINESS_HOURS = {
  timeZone: 'America/Sao_Paulo',
  /** 1 = segunda ... 5 = sexta (ISO 8601). */
  weekdays: [1, 2, 3, 4, 5] as readonly number[],
  startHour: 8,
  endHour: 18,
} as const;

/** [PRD] Chamados resolvidos há até 7 dias podem ser reabertos. */
export const REOPEN_WINDOW_DAYS = 7;

/** [PRD] Limite de 30 mensagens por sessão no chat do funcionário. */
export const MAX_EMPLOYEE_MESSAGES_PER_SESSION = 30;

/**
 * [Decisão] Status considerados "aberto" para a regra de duplicidade.
 * Um chamado nesses status é atualizado em vez de duplicado.
 */
export const OPEN_TICKET_STATUSES: readonly TicketStatus[] = [
  'WAITING_ANALYST',
  'IN_PROGRESS',
  'APPROVED',
];

/** [PRD] Só chamados resolvidos (dentro da janela) podem ser reabertos. */
export const REOPENABLE_TICKET_STATUSES: readonly TicketStatus[] = ['RESOLVED'];

/**
 * [Decisão] Confiança mínima (0..1) para o agente agir sem transferir.
 * Abaixo disso, a regra "agent sem segurança" dispara transferência. Valor a calibrar na P0.3.
 */
export const MIN_AGENT_CONFIDENCE = 0.6;

/** [Decisão] Formato do código público do chamado, como nos exemplos do Anexo B (INC-20311). */
export const TICKET_CODE_PATTERN = /^(INC|REQ)-\d{5,}$/;
