import { z } from 'zod';
import { AgentDecisionSchema, AgentStepSchema } from '../domain/agent-decision.js';
import {
  ConversationDetailSchema,
  ConversationSummarySchema,
  MessageSchema,
} from '../domain/conversation.js';
import { TicketDraftSchema } from '../domain/draft.js';
import { ConversationStatusSchema } from '../domain/enums.js';
import { HandoffSchema } from '../domain/handoff.js';
import { TicketDetailSchema, TicketSummarySchema } from '../domain/ticket.js';
import { UserSchema } from '../domain/user.js';
import { ApiErrorBodySchema } from './errors.js';
import { HealthResponseSchema } from './health.js';

/**
 * Contratos HTTP da API. Rotas de negócio ficam sob `/api`.
 * Autenticação: `Authorization: Bearer <token>`; token assinado (HMAC-SHA256) com expiração, emitido por `/api/auth/login`.
 *
 * Regra de privacidade aplicada no servidor: rotas `/api/tickets` e `/api/conversations`
 * sempre filtram pelo funcionário autenticado; o id do dono nunca vem do cliente nem do modelo.
 */

// --- Auth -------------------------------------------------------------------

/** [PRD] Login com e-mail corporativo; aceita os funcionários dos dados de exemplo com qualquer senha. */
export const LoginRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  user: UserSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// --- Conversas (funcionário) -----------------------------------------------

export const SendMessageRequestSchema = z.object({
  content: z.string().trim().min(1).max(2000),
  /** Gerado pelo cliente; reenvios com o mesmo id não duplicam a mensagem. */
  clientMessageId: z.uuid(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/**
 * Eventos SSE de `POST /api/conversations/:id/messages` (resposta em tempo real).
 * Ordem típica: message.accepted → agent.step* → agent.delta* → agent.message → done.
 */
export const ChatStreamEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('message.accepted'), data: z.object({ message: MessageSchema }) }),
  z.object({ event: z.literal('agent.step'), data: z.object({ step: AgentStepSchema }) }),
  z.object({ event: z.literal('agent.delta'), data: z.object({ text: z.string() }) }),
  z.object({
    event: z.literal('agent.message'),
    data: z.object({ message: MessageSchema, decision: AgentDecisionSchema }),
  }),
  z.object({
    event: z.literal('conversation.status'),
    data: z.object({ status: ConversationStatusSchema, version: z.number().int().nonnegative() }),
  }),
  z.object({ event: z.literal('error'), data: ApiErrorBodySchema }),
  z.object({ event: z.literal('done'), data: z.object({}) }),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;

/**
 * Eventos SSE de `GET /api/conversations/:id/events`: mensagens do analista e mudanças de estado
 * enquanto o agente está pausado.
 */
export const ConversationEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('message.created'), data: z.object({ message: MessageSchema }) }),
  z.object({
    event: z.literal('conversation.status'),
    data: z.object({ status: ConversationStatusSchema, version: z.number().int().nonnegative() }),
  }),
]);
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;

export const DraftConfirmationResponseSchema = z.object({
  draft: TicketDraftSchema,
  ticket: TicketDetailSchema,
  /** Mensagem do agente registrando o resultado na conversa. */
  message: MessageSchema,
});
export type DraftConfirmationResponse = z.infer<typeof DraftConfirmationResponseSchema>;

export const RequestHandoffRequestSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

export const HandoffResponseSchema = z.object({
  handoff: HandoffSchema,
  conversation: ConversationSummarySchema,
});

// --- Console do analista ----------------------------------------------------

export const ConsoleConversationFilterSchema = z.object({
  status: ConversationStatusSchema.optional(),
  /** Busca por nome/e-mail do funcionário ou título. */
  q: z.string().trim().max(100).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ConsoleConversationFilter = z.infer<typeof ConsoleConversationFilterSchema>;

export const ConsoleConversationItemSchema = ConversationSummarySchema.extend({
  employee: UserSchema.pick({ id: true, name: true, email: true, department: true }),
  activeHandoff: HandoffSchema.nullable(),
});

export const ConsoleConversationDetailSchema = ConversationDetailSchema.extend({
  employee: UserSchema,
  handoffs: z.array(HandoffSchema),
  /** Painel com os chamados do funcionário (Tela 4). */
  employeeTickets: z.array(TicketSummarySchema),
});

/** Ações do console exigem a versão vista pelo analista (concorrência otimista). */
export const ConsoleActionRequestSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
});

export const AnalystMessageRequestSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  clientMessageId: z.uuid(),
});

// --- Catálogo de rotas ------------------------------------------------------

export type HttpMethod = 'GET' | 'POST';
/** `authenticated`: qualquer usuário logado (funcionário ou analista). */
export type RouteAuth = 'public' | 'authenticated' | 'employee' | 'analyst';
export type RouteStatus = 'implemented' | 'planned';
export type RouteResponse = 'json' | 'sse';

export interface RouteContract {
  readonly method: HttpMethod;
  readonly path: string;
  readonly auth: RouteAuth;
  readonly status: RouteStatus;
  readonly response: RouteResponse;
  readonly summary: string;
  readonly body?: z.ZodType;
  readonly query?: z.ZodType;
  readonly success?: z.ZodType;
}

const ListOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });
const PagedListOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const API_ROUTES = {
  health: {
    method: 'GET',
    path: '/health',
    auth: 'public',
    status: 'implemented',
    response: 'json',
    summary: 'Saúde da API e conectividade com o banco.',
    success: HealthResponseSchema,
  },

  login: {
    method: 'POST',
    path: '/api/auth/login',
    auth: 'public',
    status: 'implemented',
    response: 'json',
    summary: 'Login com e-mail corporativo (Tela 1).',
    body: LoginRequestSchema,
    success: LoginResponseSchema,
  },
  me: {
    method: 'GET',
    path: '/api/auth/me',
    auth: 'authenticated',
    status: 'implemented',
    response: 'json',
    summary: 'Usuário autenticado.',
    success: z.object({ user: UserSchema }),
  },

  listMyConversations: {
    method: 'GET',
    path: '/api/conversations',
    auth: 'employee',
    status: 'planned',
    response: 'json',
    summary: 'Conversas do funcionário, a mais recente primeiro (continuar de onde parou).',
    success: ListOf(ConversationSummarySchema),
  },
  createConversation: {
    method: 'POST',
    path: '/api/conversations',
    auth: 'employee',
    status: 'planned',
    response: 'json',
    summary: 'Inicia nova conversa com o agente.',
    success: z.object({ conversation: ConversationDetailSchema }),
  },
  getConversation: {
    method: 'GET',
    path: '/api/conversations/:conversationId',
    auth: 'employee',
    status: 'planned',
    response: 'json',
    summary: 'Histórico completo, com decisões do agente.',
    success: z.object({ conversation: ConversationDetailSchema }),
  },
  sendMessage: {
    method: 'POST',
    path: '/api/conversations/:conversationId/messages',
    auth: 'employee',
    status: 'planned',
    response: 'sse',
    summary: 'Envia mensagem; resposta do agente em streaming (ChatStreamEvent).',
    body: SendMessageRequestSchema,
  },
  conversationEvents: {
    method: 'GET',
    path: '/api/conversations/:conversationId/events',
    auth: 'employee',
    status: 'planned',
    response: 'sse',
    summary: 'Mensagens do analista e mudanças de estado (ConversationEvent).',
  },
  confirmDraft: {
    method: 'POST',
    path: '/api/conversations/:conversationId/drafts/:draftId/confirm',
    auth: 'employee',
    status: 'implemented',
    response: 'json',
    summary: 'Confirma o rascunho e executa a escrita no serviço de chamados (idempotente).',
    success: DraftConfirmationResponseSchema,
  },
  discardDraft: {
    method: 'POST',
    path: '/api/conversations/:conversationId/drafts/:draftId/discard',
    auth: 'employee',
    status: 'implemented',
    response: 'json',
    summary: 'Descarta o rascunho.',
    success: z.object({ draft: TicketDraftSchema }),
  },
  requestHandoff: {
    method: 'POST',
    path: '/api/conversations/:conversationId/handoff',
    auth: 'employee',
    status: 'planned',
    response: 'json',
    summary: 'Funcionário pede para falar com um analista.',
    body: RequestHandoffRequestSchema,
    success: HandoffResponseSchema,
  },

  listMyTickets: {
    method: 'GET',
    path: '/api/tickets',
    auth: 'employee',
    status: 'implemented',
    response: 'json',
    summary: 'Chamados do funcionário autenticado.',
    success: ListOf(TicketSummarySchema),
  },
  getMyTicket: {
    method: 'GET',
    path: '/api/tickets/:ticketCode',
    auth: 'employee',
    status: 'implemented',
    response: 'json',
    summary: 'Detalhe de um chamado do próprio funcionário (404 para chamados de terceiros).',
    success: z.object({ ticket: TicketDetailSchema }),
  },

  consoleListConversations: {
    method: 'GET',
    path: '/api/console/conversations',
    auth: 'analyst',
    status: 'planned',
    response: 'json',
    summary: 'Lista de conversas com filtros e status (Telas 4 e 5).',
    query: ConsoleConversationFilterSchema,
    success: PagedListOf(ConsoleConversationItemSchema),
  },
  consoleGetConversation: {
    method: 'GET',
    path: '/api/console/conversations/:conversationId',
    auth: 'analyst',
    status: 'planned',
    response: 'json',
    summary: 'Histórico, transferências e chamados do funcionário.',
    success: z.object({ conversation: ConsoleConversationDetailSchema }),
  },
  consoleAssume: {
    method: 'POST',
    path: '/api/console/conversations/:conversationId/assume',
    auth: 'analyst',
    status: 'planned',
    response: 'json',
    summary: 'Analista assume; agente pausado (WAITING_ANALYST → WITH_ANALYST).',
    body: ConsoleActionRequestSchema,
    success: z.object({ conversation: ConversationSummarySchema }),
  },
  consoleReturnToAgent: {
    method: 'POST',
    path: '/api/console/conversations/:conversationId/return',
    auth: 'analyst',
    status: 'planned',
    response: 'json',
    summary: 'Devolve ao agente (WITH_ANALYST → WITH_AGENT).',
    body: ConsoleActionRequestSchema,
    success: z.object({ conversation: ConversationSummarySchema }),
  },
  consoleClose: {
    method: 'POST',
    path: '/api/console/conversations/:conversationId/close',
    auth: 'analyst',
    status: 'planned',
    response: 'json',
    summary: 'Encerra a conversa.',
    body: ConsoleActionRequestSchema,
    success: z.object({ conversation: ConversationSummarySchema }),
  },
  consoleSendMessage: {
    method: 'POST',
    path: '/api/console/conversations/:conversationId/messages',
    auth: 'analyst',
    status: 'planned',
    response: 'json',
    summary: 'Mensagem do analista (somente em WITH_ANALYST).',
    body: AnalystMessageRequestSchema,
    success: z.object({ message: MessageSchema }),
  },
} as const satisfies Record<string, RouteContract>;

export type ApiRouteName = keyof typeof API_ROUTES;
