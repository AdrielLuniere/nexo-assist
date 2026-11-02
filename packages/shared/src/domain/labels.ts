import type {
  AffectedScope,
  AgentAction,
  AgentIntent,
  DraftOperation,
  DraftStatus,
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

export const AGENT_INTENT_LABELS: Record<AgentIntent, string> = {
  ASK_QUESTION: 'Tirar uma dúvida',
  CHECK_TICKET_STATUS: 'Consultar um chamado',
  UPDATE_TICKET: 'Atualizar um chamado',
  OPEN_TICKET: 'Abrir um chamado',
  REOPEN_TICKET: 'Reabrir um chamado',
  TALK_TO_ANALYST: 'Falar com um analista',
  OUT_OF_SCOPE: 'Assunto fora de TI',
  SMALL_TALK: 'Conversa',
  UNCLEAR: 'Pedido pouco claro',
};

export const AFFECTED_SCOPE_LABELS: Record<AffectedScope, string> = {
  INDIVIDUAL: 'Somente você',
  TEAM: 'Sua equipe',
  COMPANY: 'Toda a empresa',
};

export const DRAFT_OPERATION_LABELS: Record<DraftOperation, string> = {
  CREATE: 'Novo chamado',
  UPDATE: 'Atualização de chamado',
  REOPEN: 'Reabertura de chamado',
};

export const DRAFT_STATUS_LABELS: Record<DraftStatus, string> = {
  PENDING: 'Aguardando confirmação',
  CONFIRMED: 'Confirmado',
  DISCARDED: 'Descartado',
  SUPERSEDED: 'Substituído por um rascunho mais novo',
};

/** Regras do Anexo A citadas nas decisões do agente (`RULE_REFS`). */
export const RULE_REF_LABELS: Record<string, string> = {
  'A.TIPO': 'Tipo: incidente ou requisição',
  'A.CATEGORIA': 'Categoria do chamado',
  'A.ABERTURA': 'Dados obrigatórios para abrir',
  'A.DUPLICIDADE': 'Sem chamados duplicados',
  'A.REABERTURA': 'Reabertura em até 7 dias',
  'A.TRANSFERENCIA': 'Quando transferir para um analista',
  'A.PRIVACIDADE': 'Privacidade dos chamados',
  'A.ESCOPO': 'Somente assuntos de TI',
  'A.PRIORIDADE_PRAZO': 'Prioridade e prazo',
};
