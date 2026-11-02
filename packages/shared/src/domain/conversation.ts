import { z } from 'zod';
import {
  type ConversationStatus,
  ConversationStatusSchema,
  HandoffReasonSchema,
  MessageRoleSchema,
} from './enums.js';
import { AgentDecisionSchema } from './agent-decision.js';
import { TicketDraftSchema } from './draft.js';
import { TicketCodeSchema, TicketSummarySchema } from './ticket.js';
import { IdSchema, IsoDateTimeSchema } from './user.js';

/**
 * Máquina de estados do atendimento.
 *
 *   WITH_AGENT ──transferir──▶ WAITING_ANALYST ──assumir──▶ WITH_ANALYST
 *        ▲                          │                          │  │
 *        └──────────devolver────────┼──────────────────────────┘  │
 *                                   └──encerrar──▶ CLOSED ◀──encerrar
 *
 * [PRD] O agente para de responder a partir da transferência e só volta quando liberado.
 */
export const CONVERSATION_TRANSITIONS: Readonly<Record<ConversationStatus, readonly ConversationStatus[]>> = {
  WITH_AGENT: ['WAITING_ANALYST', 'CLOSED'],
  WAITING_ANALYST: ['WITH_ANALYST', 'CLOSED'],
  WITH_ANALYST: ['WITH_AGENT', 'CLOSED'],
  CLOSED: [],
};

export function canTransition(from: ConversationStatus, to: ConversationStatus): boolean {
  return CONVERSATION_TRANSITIONS[from].includes(to);
}

/** Só no estado WITH_AGENT o agente pode responder. */
export function agentCanRespond(status: ConversationStatus): boolean {
  return status === 'WITH_AGENT';
}

/** O funcionário pode escrever enquanto a conversa não estiver encerrada. */
export function employeeCanWrite(status: ConversationStatus): boolean {
  return status !== 'CLOSED';
}

// ---------------------------------------------------------------------------
// Mensagens e blocos estruturados
// ---------------------------------------------------------------------------

export const QuickReplySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(60),
  /** Texto enviado como mensagem do funcionário ao clicar. */
  value: z.string().min(1).max(500),
});
export type QuickReply = z.infer<typeof QuickReplySchema>;

/**
 * Blocos que compõem uma mensagem além do texto: cards de chamado, seleção de chamado,
 * rascunho para confirmação, opções rápidas e aviso de transferência (Telas 2 e 3).
 */
export const MessageBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1) }),
  z.object({ type: z.literal('ticket_cards'), tickets: z.array(TicketSummarySchema).min(1) }),
  z.object({
    type: z.literal('ticket_selection'),
    prompt: z.string().min(1),
    options: z.array(TicketSummarySchema).min(2),
  }),
  z.object({ type: z.literal('draft'), draft: TicketDraftSchema }),
  z.object({ type: z.literal('quick_replies'), options: z.array(QuickReplySchema).min(1).max(6) }),
  z.object({
    type: z.literal('handoff_notice'),
    handoffId: IdSchema,
    reason: HandoffReasonSchema,
    relatedTicketCode: TicketCodeSchema.nullable(),
  }),
]);
export type MessageBlock = z.infer<typeof MessageBlockSchema>;

export const MessageSchema = z.object({
  id: IdSchema,
  conversationId: IdSchema,
  role: MessageRoleSchema,
  /** Autor humano (funcionário ou analista); nulo para AGENT e SYSTEM. */
  authorId: IdSchema.nullable(),
  /** Texto plano, sempre presente (histórico, resumo, acessibilidade). */
  content: z.string(),
  blocks: z.array(MessageBlockSchema),
  /** Decisão que gerou a mensagem (apenas mensagens do agente). */
  decisionId: IdSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type Message = z.infer<typeof MessageSchema>;

export const ConversationSummarySchema = z.object({
  id: IdSchema,
  employeeId: IdSchema,
  status: ConversationStatusSchema,
  title: z.string().nullable(),
  assignedAnalystId: IdSchema.nullable(),
  employeeMessageCount: z.number().int().nonnegative(),
  /** Versão para concorrência otimista nas ações do console. */
  version: z.number().int().nonnegative(),
  lastMessageAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationDetailSchema = ConversationSummarySchema.extend({
  messages: z.array(MessageSchema),
  decisions: z.array(AgentDecisionSchema),
  /**
   * Última mensagem do funcionário ainda sem resposta do agente (ex.: o modelo falhou depois de a
   * mensagem ser gravada). Só existe com a conversa em WITH_AGENT. A interface retoma a resposta com
   * `POST /api/conversations/:id/resume`.
   */
  pendingAgentResponse: z.object({ messageId: IdSchema }).nullable(),
});
export type ConversationDetail = z.infer<typeof ConversationDetailSchema>;
