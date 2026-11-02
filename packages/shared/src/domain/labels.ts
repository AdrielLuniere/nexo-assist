import type {
  AgentAction,
  ConversationStatus,
  HandoffReason,
  TicketCategory,
  TicketPriority,
  TicketStatus,
  TicketType,
} from './enums.js';

/** Rótulos exibidos na interface (pt-BR). */

export const TICKET_TYPE_LABELS: Record<TicketType, string> = {
  INC: 'Incidente',
  REQ: 'Requisição',
};

export const TICKET_CATEGORY_LABELS: Record<TicketCategory, string> = {
  ACCESS: 'Acesso',
  NETWORK_VPN: 'Rede e VPN',
  HARDWARE: 'Hardware',
  SOFTWARE: 'Software',
  EMAIL: 'E-mail',
  OTHER: 'Outros',
};

export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  CRITICAL: 'Crítica',
  HIGH: 'Alta',
  MEDIUM: 'Média',
  LOW: 'Baixa',
};

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  WAITING_ANALYST: 'Aguardando analista',
  IN_PROGRESS: 'Em atendimento',
  APPROVED: 'Aprovado',
  RESOLVED: 'Resolvido',
  CLOSED: 'Fechado',
};

export const CONVERSATION_STATUS_LABELS: Record<ConversationStatus, string> = {
  WITH_AGENT: 'Com o agente',
  WAITING_ANALYST: 'Aguardando atendente',
  WITH_ANALYST: 'Em atendimento',
  CLOSED: 'Encerrada',
};

export const HANDOFF_REASON_LABELS: Record<HandoffReason, string> = {
  EMPLOYEE_REQUEST: 'Pedido do funcionário',
  CRITICAL_ISSUE: 'Caso crítico',
  OVERDUE_TICKET: 'Chamado vencido',
  LOW_CONFIDENCE: 'Agente sem segurança para decidir',
};

export const AGENT_ACTION_LABELS: Record<AgentAction, string> = {
  ANSWER_FROM_HELP_CENTER: 'Respondeu com a central de ajuda',
  SHOW_TICKETS: 'Mostrou seus chamados',
  ASK_TICKET_SELECTION: 'Pediu para escolher um chamado',
  ASK_CLARIFICATION: 'Pediu mais informações',
  PROPOSE_TICKET_DRAFT: 'Preparou um rascunho de chamado',
  PROPOSE_TICKET_UPDATE: 'Preparou uma atualização de chamado',
  PROPOSE_TICKET_REOPEN: 'Preparou a reabertura de um chamado',
  TRANSFER_TO_ANALYST: 'Transferiu para um analista',
  REDIRECT_OUT_OF_SCOPE: 'Redirecionou assunto fora de TI',
  REPLY: 'Respondeu',
};
