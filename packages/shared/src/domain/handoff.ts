import { z } from 'zod';
import { HandoffReasonSchema, HandoffStatusSchema } from './enums.js';
import { TicketCodeSchema } from './ticket.js';
import { IdSchema, IsoDateTimeSchema } from './user.js';

/**
 * Transferência para analista.
 * [PRD] Leva um resumo do caso; o agente não responde enquanto a conversa está com um analista.
 */
export const HandoffSchema = z.object({
  id: IdSchema,
  conversationId: IdSchema,
  reason: HandoffReasonSchema,
  status: HandoffStatusSchema,
  /** Resumo para o analista não precisar perguntar tudo de novo. */
  summary: z.string().min(1).max(2000),
  relatedTicketCode: TicketCodeSchema.nullable(),
  assumedById: IdSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  assumedAt: IsoDateTimeSchema.nullable(),
  endedAt: IsoDateTimeSchema.nullable(),
});
export type Handoff = z.infer<typeof HandoffSchema>;
