import { z } from 'zod';

/**
 * Enums de domínio. Os valores são estáveis (persistidos e trafegados pela API);
 * os rótulos em português ficam em `labels.ts` para a interface.
 *
 * Mantidos em sincronia com os enums de `prisma/schema.prisma`
 * (verificado por `tests/prisma-contracts.test.ts`).
 */

export const USER_ROLES = ['EMPLOYEE', 'ANALYST'] as const;
export const UserRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof UserRoleSchema>;

/** Suporte N1 e N2 (PRD, "Usuários e histórias"). */
export const ANALYST_LEVELS = ['N1', 'N2'] as const;
export const AnalystLevelSchema = z.enum(ANALYST_LEVELS);
export type AnalystLevel = z.infer<typeof AnalystLevelSchema>;

/** Anexo A: INC quando algo parou ou não funciona; REQ para pedidos de acesso, equipamento ou software. */
export const TICKET_TYPES = ['INC', 'REQ'] as const;
export const TicketTypeSchema = z.enum(TICKET_TYPES);
export type TicketType = z.infer<typeof TicketTypeSchema>;

/** Anexo A: Acesso, Rede e VPN, Hardware, Software, E-mail e Outros. */
export const TICKET_CATEGORIES = [
  'ACCESS',
  'NETWORK_VPN',
  'HARDWARE',
  'SOFTWARE',
  'EMAIL',
  'OTHER',
] as const;
export const TicketCategorySchema = z.enum(TICKET_CATEGORIES);
export type TicketCategory = z.infer<typeof TicketCategorySchema>;

/** Anexo A: Crítica, Alta, Média, Baixa. */
export const TICKET_PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export const TicketPrioritySchema = z.enum(TICKET_PRIORITIES);
export type TicketPriority = z.infer<typeof TicketPrioritySchema>;

/**
 * Status do chamado. "Aguardando analista", "Aprovado" e "Resolvido" vêm do Anexo B;
 * "Em atendimento" e "Fechado" são decisão técnica para completar o ciclo de vida.
 * "Vencido" não é status: é derivado do prazo (`slaDueAt`).
 */
export const TICKET_STATUSES = [
  'WAITING_ANALYST',
  'IN_PROGRESS',
  'APPROVED',
  'RESOLVED',
  'CLOSED',
] as const;
export const TicketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

/** Anexo A exige registrar "de quem é afetado"; o escopo alimenta o impacto na prioridade. */
export const AFFECTED_SCOPES = ['INDIVIDUAL', 'TEAM', 'COMPANY'] as const;
export const AffectedScopeSchema = z.enum(AFFECTED_SCOPES);
export type AffectedScope = z.infer<typeof AffectedScopeSchema>;

/**
 * Estado do atendimento da conversa (PRD: "com o agent ou com um analista").
 * Transições permitidas em `conversation.ts`.
 */
export const CONVERSATION_STATUSES = [
  'WITH_AGENT',
  'WAITING_ANALYST',
  'WITH_ANALYST',
  'CLOSED',
] as const;
export const ConversationStatusSchema = z.enum(CONVERSATION_STATUSES);
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

export const MESSAGE_ROLES = ['EMPLOYEE', 'AGENT', 'ANALYST', 'SYSTEM'] as const;
export const MessageRoleSchema = z.enum(MESSAGE_ROLES);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/** Quem executou uma ação registrada no histórico. */
export const ACTOR_TYPES = ['EMPLOYEE', 'AGENT', 'ANALYST', 'SYSTEM'] as const;
export const ActorTypeSchema = z.enum(ACTOR_TYPES);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const TICKET_EVENT_TYPES = [
  'CREATED',
  'UPDATED',
  'COMMENT_ADDED',
  'STATUS_CHANGED',
  'PRIORITY_CHANGED',
  'REOPENED',
  'TRANSFERRED',
] as const;
export const TicketEventTypeSchema = z.enum(TICKET_EVENT_TYPES);
export type TicketEventType = z.infer<typeof TicketEventTypeSchema>;

/** Operação que um rascunho propõe. Toda escrita no chamado passa por um rascunho confirmado. */
export const DRAFT_OPERATIONS = ['CREATE', 'UPDATE', 'REOPEN'] as const;
export const DraftOperationSchema = z.enum(DRAFT_OPERATIONS);
export type DraftOperation = z.infer<typeof DraftOperationSchema>;

export const DRAFT_STATUSES = ['PENDING', 'CONFIRMED', 'DISCARDED', 'SUPERSEDED'] as const;
export const DraftStatusSchema = z.enum(DRAFT_STATUSES);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;

/** Anexo A: motivos que disparam transferência para analista. */
export const HANDOFF_REASONS = [
  'EMPLOYEE_REQUEST',
  'CRITICAL_ISSUE',
  'OVERDUE_TICKET',
  'LOW_CONFIDENCE',
] as const;
export const HandoffReasonSchema = z.enum(HANDOFF_REASONS);
export type HandoffReason = z.infer<typeof HandoffReasonSchema>;

export const HANDOFF_STATUSES = ['WAITING', 'ASSUMED', 'RETURNED_TO_AGENT', 'CLOSED'] as const;
export const HandoffStatusSchema = z.enum(HANDOFF_STATUSES);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

/** O que o agente entendeu que o funcionário quer. */
export const AGENT_INTENTS = [
  'ASK_QUESTION',
  'CHECK_TICKET_STATUS',
  'UPDATE_TICKET',
  'OPEN_TICKET',
  'REOPEN_TICKET',
  'TALK_TO_ANALYST',
  'OUT_OF_SCOPE',
  'SMALL_TALK',
  'UNCLEAR',
] as const;
export const AgentIntentSchema = z.enum(AGENT_INTENTS);
export type AgentIntent = z.infer<typeof AgentIntentSchema>;

/** Ação que o agente escolheu como resposta. */
export const AGENT_ACTIONS = [
  'ANSWER_FROM_HELP_CENTER',
  'SHOW_TICKETS',
  'ASK_TICKET_SELECTION',
  'ASK_CLARIFICATION',
  'PROPOSE_TICKET_DRAFT',
  'PROPOSE_TICKET_UPDATE',
  'PROPOSE_TICKET_REOPEN',
  'TRANSFER_TO_ANALYST',
  'REDIRECT_OUT_OF_SCOPE',
  'REPLY',
] as const;
export const AgentActionSchema = z.enum(AGENT_ACTIONS);
export type AgentAction = z.infer<typeof AgentActionSchema>;
