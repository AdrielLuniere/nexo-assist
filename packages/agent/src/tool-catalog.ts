/**
 * Catálogo das ferramentas do agente. O `label` é o texto exibido acima da resposta
 * ("consultou seus chamados"), conforme o protótipo.
 *
 * `writes: true` não significa que o agente escreve no sistema de chamados: essas ferramentas
 * apenas registram um rascunho ou uma transferência. A escrita em chamados só acontece
 * quando o funcionário confirma o rascunho pela API.
 */
export const AGENT_TOOLS = {
  searchHelpCenter: {
    label: 'buscou na central de ajuda',
    writes: false,
  },
  listMyTickets: {
    label: 'consultou seus chamados',
    writes: false,
  },
  getMyTicket: {
    label: 'abriu o chamado',
    writes: false,
  },
  findDuplicateTickets: {
    label: 'verificou chamados parecidos',
    writes: false,
  },
  proposeTicketDraft: {
    label: 'preparou um rascunho para você conferir',
    writes: true,
  },
  requestHandoff: {
    label: 'chamou um analista',
    writes: true,
  },
} as const satisfies Record<string, { label: string; writes: boolean }>;

export type AgentToolId = keyof typeof AGENT_TOOLS;

/** Passos determinísticos (sem ferramenta) que também aparecem para o usuário. */
export const AGENT_INTERNAL_STEPS = {
  classifyType: 'identificou o tipo do chamado',
  classifyCategory: 'classificou a categoria',
  classifyPriority: 'classificou a prioridade',
  checkScope: 'verificou se o assunto é de TI',
} as const;
