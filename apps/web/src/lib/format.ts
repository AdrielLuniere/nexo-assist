import { type ConfidenceLevel, type Message, SLA_BY_PRIORITY, type TicketPriority } from '@nexo/shared';

/** Datas e textos exibidos sempre no fuso do service desk (America/Sao_Paulo), em pt-BR. */
const TZ = 'America/Sao_Paulo';

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dayMonthFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', timeZone: TZ });
const fullFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dayKey = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ });

export const formatTime = (iso: string) => timeFormat.format(new Date(iso));
export const formatDayMonth = (iso: string) => dayMonthFormat.format(new Date(iso)).replace('.', '');
export const formatDateTime = (iso: string) => fullFormat.format(new Date(iso)).replace('.', '');

/** "10:05" se for hoje, "ontem", ou "16 out". */
export function formatListTime(iso: string, now = new Date()): string {
  const day = dayKey.format(new Date(iso));
  if (day === dayKey.format(now)) return formatTime(iso);
  if (day === dayKey.format(new Date(now.getTime() - 86_400_000))) return 'ontem';
  return formatDayMonth(iso);
}

/** "há 6 dias", "há 3 horas", "há 10 min", "agora". */
export function formatRelative(iso: string, now = new Date()): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
  const days = Math.round(hours / 24);
  return `há ${days} ${days === 1 ? 'dia' : 'dias'}`;
}

const SLA_UNIT_TEXT = { CLOCK_HOURS: ['hora', 'horas'], BUSINESS_HOURS: ['hora útil', 'horas úteis'], BUSINESS_DAYS: ['dia útil', 'dias úteis'] } as const;

/** Prazo da prioridade conforme o Anexo A, ex.: "4 horas úteis". */
export function slaText(priority: TicketPriority): string {
  const { amount, unit } = SLA_BY_PRIORITY[priority];
  return `${amount} ${SLA_UNIT_TEXT[unit][amount === 1 ? 0 : 1]}`;
}

/** Texto do prazo de um chamado: vencido ou "resposta até 13:43" / "até 16 out". */
export function dueText(slaDueAt: string, isOverdue: boolean, now = new Date()): string {
  if (isOverdue) return `prazo vencido ${formatRelative(slaDueAt, now)}`;
  const sameDay = dayKey.format(new Date(slaDueAt)) === dayKey.format(now);
  return `resposta até ${sameDay ? formatTime(slaDueAt) : formatDateTime(slaDueAt)}`;
}

export const CONFIDENCE_LEVEL_LABELS: Record<ConfidenceLevel, string> = { HIGH: 'Alta', MEDIUM: 'Média', LOW: 'Baixa' };

/** 0.85 → "0,85" (como a justificativa gravada pelo agente). */
export const formatConfidence = (value: number) => value.toFixed(2).replace('.', ',');

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** Junta mensagens novas ao histórico sem repetir (por id) e mantém a ordem de envio. */
export function mergeMessages(current: readonly Message[], incoming: readonly Message[]): Message[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
