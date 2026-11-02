/**
 * Logger mínimo em JSON por linha. Suficiente na P0.1; troca por pino é simples se precisar.
 * Nunca registre conteúdo de mensagens de funcionários nem segredos.
 */
type Level = 'info' | 'warn' | 'error';

function write(level: Level, message: string, context: Record<string, unknown>): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), message, ...context });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const logger = {
  info: (message: string, context: Record<string, unknown> = {}) => write('info', message, context),
  warn: (message: string, context: Record<string, unknown> = {}) => write('warn', message, context),
  error: (message: string, context: Record<string, unknown> = {}) => write('error', message, context),
};
