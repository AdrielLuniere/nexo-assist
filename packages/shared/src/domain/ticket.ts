import { z } from 'zod';
import {
  ActorTypeSchema,
  AffectedScopeSchema,
  TicketCategorySchema,
  TicketEventTypeSchema,
  TicketPrioritySchema,
  TicketStatusSchema,
  TicketTypeSchema,
} from './enums.js';
import { TICKET_CODE_PATTERN } from './rules.js';
import { IdSchema, IsoDateTimeSchema } from './user.js';

export const TicketCodeSchema = z.string().regex(TICKET_CODE_PATTERN, 'Código de chamado inválido');
export type TicketCode = z.infer<typeof TicketCodeSchema>;

/**
 * Campos obrigatórios para abrir um chamado (Anexo A, "Abertura"):
 * título, descrição, tipo, categoria, prioridade e de quem é afetado.
 */
export const TicketFieldsSchema = z.object({
  type: TicketTypeSchema,
  title: z.string().trim().min(5).max(120),
  description: z.string().trim().min(10).max(4000),
  category: TicketCategorySchema,
  priority: TicketPrioritySchema,
  affectedScope: AffectedScopeSchema,
  affectedDescription: z.string().trim().min(2).max(200),
});
export type TicketFields = z.infer<typeof TicketFieldsSchema>;

/** Visão resumida, usada em cards de chamado e listas. */
export const TicketSummarySchema = z.object({
  code: TicketCodeSchema,
  type: TicketTypeSchema,
  title: z.string(),
  category: TicketCategorySchema,
  priority: TicketPrioritySchema,
  status: TicketStatusSchema,
  slaDueAt: IsoDateTimeSchema,
  /** Derivado: prazo passou e o chamado segue aberto. */
  isOverdue: z.boolean(),
  updatedAt: IsoDateTimeSchema,
});
export type TicketSummary = z.infer<typeof TicketSummarySchema>;

export const TicketEventSchema = z.object({
  id: IdSchema,
  type: TicketEventTypeSchema,
  actorType: ActorTypeSchema,
  comment: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type TicketEvent = z.infer<typeof TicketEventSchema>;

export const TicketDetailSchema = TicketSummarySchema.extend({
  description: z.string(),
  affectedScope: AffectedScopeSchema,
  affectedDescription: z.string(),
  createdAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable(),
  history: z.array(TicketEventSchema),
});
export type TicketDetail = z.infer<typeof TicketDetailSchema>;
