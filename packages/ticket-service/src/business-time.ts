import { BUSINESS_HOURS } from '@nexo/shared';

/**
 * Aritmética de tempo útil no fuso do service desk (`BUSINESS_HOURS`): segunda a sexta, 8h às 18h.
 * Feriados estão fora do escopo (ver docs/architecture.md).
 */

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface CivilDay {
  year: number;
  month: number;
  day: number;
}

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_HOURS.timeZone,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

function localParts(date: Date): LocalParts {
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

/** Instante UTC em que o relógio do fuso marca a data/hora local informada. */
function zonedToUtc(day: CivilDay, hour: number, minute = 0): Date {
  const wanted = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
  let guess = wanted;
  // Duas passadas cobrem fusos com horário de verão; no fuso atual (sem DST) uma basta.
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess));
    guess += wanted - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  }
  return new Date(guess);
}

/** Dia da semana ISO (1 = segunda ... 7 = domingo) de uma data civil. */
function isoWeekday(day: CivilDay): number {
  const js = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
  return js === 0 ? 7 : js;
}

function isBusinessDay(day: CivilDay): boolean {
  return BUSINESS_HOURS.weekdays.includes(isoWeekday(day));
}

function nextCivilDay(day: CivilDay): CivilDay {
  const next = new Date(Date.UTC(day.year, day.month - 1, day.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function nextBusinessDay(day: CivilDay): CivilDay {
  let candidate = nextCivilDay(day);
  while (!isBusinessDay(candidate)) candidate = nextCivilDay(candidate);
  return candidate;
}

function civilDayOf(parts: LocalParts): CivilDay {
  return { year: parts.year, month: parts.month, day: parts.day };
}

/** Primeiro instante em expediente a partir de `from` (o próprio `from` se já estiver em expediente). */
export function alignToBusinessTime(from: Date): Date {
  const day = civilDayOf(localParts(from));
  if (isBusinessDay(day)) {
    const open = zonedToUtc(day, BUSINESS_HOURS.startHour);
    const close = zonedToUtc(day, BUSINESS_HOURS.endHour);
    if (from.getTime() < open.getTime()) return open;
    if (from.getTime() < close.getTime()) return from;
  }
  return zonedToUtc(nextBusinessDay(day), BUSINESS_HOURS.startHour);
}

/** Soma horas de expediente: o que não cabe no dia continua na próxima abertura. */
export function addBusinessHours(from: Date, hours: number): Date {
  let cursor = alignToBusinessTime(from);
  let remainingMs = hours * 3_600_000;
  for (;;) {
    const day = civilDayOf(localParts(cursor));
    const close = zonedToUtc(day, BUSINESS_HOURS.endHour);
    const available = close.getTime() - cursor.getTime();
    if (remainingMs <= available) return new Date(cursor.getTime() + remainingMs);
    remainingMs -= available;
    cursor = zonedToUtc(nextBusinessDay(day), BUSINESS_HOURS.startHour);
  }
}

/** Soma dias úteis mantendo o horário local (a partir do próximo instante em expediente). */
export function addBusinessDays(from: Date, days: number): Date {
  const start = alignToBusinessTime(from);
  const parts = localParts(start);
  let day = civilDayOf(parts);
  for (let i = 0; i < days; i++) day = nextBusinessDay(day);
  const base = zonedToUtc(day, parts.hour, parts.minute);
  return new Date(base.getTime() + parts.second * 1000 + (start.getTime() % 1000));
}
