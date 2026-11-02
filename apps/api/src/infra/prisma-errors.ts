import { Prisma } from '../generated/prisma/client.js';

/** Códigos do Prisma que indicam banco inacessível ou ocupado: transitórios, a chamada pode ser repetida. */
const TRANSIENT_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']);

export function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return TRANSIENT_CODES.has(error.code);
  return error instanceof Prisma.PrismaClientInitializationError;
}
