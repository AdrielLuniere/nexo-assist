import { z } from 'zod';
import { DraftStatusSchema, TicketPrioritySchema } from './enums.js';
import { TicketCodeSchema, TicketFieldsSchema } from './ticket.js';
import { IdSchema, IsoDateTimeSchema } from './user.js';

/**
 * Rascunho de escrita no sistema de chamados.
 *
 * [PRD] O agente mostra um rascunho e só cria ou atualiza depois da confirmação do funcionário.
 * [Decisão] O agente apenas propõe rascunhos. A escrita acontece quando o funcionário confirma
 * pela API (`POST .../drafts/:draftId/confirm`); o servidor executa o rascunho no serviço de
 * chamados. O id do rascunho serve como chave de idempotência da confirmação.
 */

/** Como o agente chegou à prioridade (impacto x urgência), exibido no rascunho. */
export const PriorityAssessmentSchema = z.object({
  priority: TicketPrioritySchema,
  impact: z.string().min(1),
  urgency: z.string().min(1),
  rationale: z.string().min(1),
});
export type PriorityAssessment = z.infer<typeof PriorityAssessmentSchema>;

export const CreateDraftPayloadSchema = z.object({
  operation: z.literal('CREATE'),
  fields: TicketFieldsSchema,
  priorityAssessment: PriorityAssessmentSchema,
});

export const UpdateDraftPayloadSchema = z.object({
  operation: z.literal('UPDATE'),
  ticketCode: TicketCodeSchema,
  /** Informação nova que será registrada no histórico do chamado. */
  comment: z.string().trim().min(3).max(4000),
  /** Reavaliação de prioridade, se a informação nova mudar impacto ou urgência. */
  priorityAssessment: PriorityAssessmentSchema.optional(),
});

export const ReopenDraftPayloadSchema = z.object({
  operation: z.literal('REOPEN'),
  ticketCode: TicketCodeSchema,
  reason: z.string().trim().min(3).max(4000),
});

export const DraftPayloadSchema = z.discriminatedUnion('operation', [
  CreateDraftPayloadSchema,
  UpdateDraftPayloadSchema,
  ReopenDraftPayloadSchema,
]);
export type DraftPayload = z.infer<typeof DraftPayloadSchema>;

export const TicketDraftSchema = z.object({
  id: IdSchema,
  conversationId: IdSchema,
  status: DraftStatusSchema,
  payload: DraftPayloadSchema,
  /** Preenchido após confirmação bem-sucedida. */
  resultTicketCode: TicketCodeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  confirmedAt: IsoDateTimeSchema.nullable(),
});
export type TicketDraft = z.infer<typeof TicketDraftSchema>;
