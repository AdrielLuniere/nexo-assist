import { createTool } from '@mastra/core/tools';
import {
  AffectedScopeSchema,
  CreateDraftPayloadSchema,
  type DraftPayload,
  HandoffReasonSchema,
  HANDOFF_REASON_LABELS,
  OPEN_TICKET_STATUSES,
  REOPEN_WINDOW_DAYS,
  RULE_REFS,
  ReopenDraftPayloadSchema,
  SLA_BY_PRIORITY,
  TICKET_CATEGORY_LABELS,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_TYPE_LABELS,
  TicketCategorySchema,
  type TicketCategory,
  TicketCodeSchema,
  type TicketDetail,
  type TicketPriority,
  type TicketSummary,
  TicketTypeSchema,
  URGENCY_LEVELS,
  UpdateDraftPayloadSchema,
  classifyPriority,
} from '@nexo/shared';
import { z } from 'zod';
import type { AgentReadPorts } from './ports.js';
import { AgentProposalSchema } from './proposal.js';
import { AGENT_INTERNAL_STEPS, AGENT_TOOLS, type AgentToolId } from './tool-catalog.js';
import { type TurnTrace, clip } from './trace.js';

/**
 * Ferramentas do agente, criadas a cada resposta e já vinculadas ao funcionário (via `ports`).
 *
 * Regras que valem para todas:
 * - Nenhuma recebe `employeeId`: o dono dos dados vem das portas, fixado pelo servidor.
 * - Argumentos são validados (Zod) antes de executar; argumento inválido volta ao modelo como erro.
 * - Cada execução vira um passo registrado (`TurnTrace.steps`) com status, resumo e duração. É isso
 *   que a interface mostra acima da resposta: o que de fato rodou, não o que o modelo diz ter feito.
 * - Falhas das portas não vazam detalhes ao modelo: ele recebe uma mensagem genérica e pode avisar
 *   o funcionário.
 * - `proposeTicketDraft` e `requestHandoff` não escrevem nada: só planejam o efeito, que a API grava
 *   junto com a resposta (ver `ports.ts`).
 */

export interface AgentToolContext {
  readonly ports: AgentReadPorts;
  readonly trace: TurnTrace;
  readonly now: Date;
  /** Teto de chamadas de ferramenta por resposta (exceto `submitResponse`). */
  readonly maxToolCalls: number;
}

type StepKind = AgentToolId | keyof typeof AGENT_INTERNAL_STEPS;
type StepStatus = 'OK' | 'ERROR' | 'SKIPPED';

const UNAVAILABLE = {
  help: 'A central de ajuda não respondeu agora. Tente responder sem ela ou peça para o funcionário tentar de novo.',
  tickets: 'O sistema de chamados está indisponível no momento (costuma voltar em alguns segundos). Avise o funcionário e sugira tentar de novo.',
} as const;

function labelOf(kind: StepKind): string {
  return kind in AGENT_TOOLS ? AGENT_TOOLS[kind as AgentToolId].label : AGENT_INTERNAL_STEPS[kind as keyof typeof AGENT_INTERNAL_STEPS];
}

function record(trace: TurnTrace, kind: StepKind, status: StepStatus, summary: string, durationMs?: number): void {
  trace.steps.push({
    kind,
    label: labelOf(kind),
    status,
    summary: clip(summary, 500),
    ...(durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(durationMs)) }),
  });
}

/** Conta a chamada; acima do teto, registra o passo como não executado e devolve o aviso ao modelo. */
function overBudget(ctx: AgentToolContext, kind: AgentToolId) {
  ctx.trace.toolCalls++;
  if (ctx.trace.toolCalls <= ctx.maxToolCalls) return null;
  record(ctx.trace, kind, 'SKIPPED', 'Não executado: limite de consultas desta resposta atingido.');
  return { ok: false, error: 'Limite de consultas desta resposta atingido. Chame submitResponse agora com o que já sabe.' } as const;
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await work();
  return { value, ms: performance.now() - started };
}

export function slaText(priority: TicketPriority): string {
  const rule = SLA_BY_PRIORITY[priority];
  const unit =
    rule.unit === 'CLOCK_HOURS' ? (rule.amount === 1 ? 'hora' : 'horas') : rule.unit === 'BUSINESS_HOURS' ? 'horas úteis' : 'dias úteis';
  return `${rule.amount} ${unit}`;
}

/** Visão compacta para o modelo: só chamados do próprio funcionário chegam aqui. */
function ticketView(ticket: TicketSummary) {
  return {
    code: ticket.code,
    type: ticket.type,
    title: ticket.title,
    category: ticket.category,
    priority: TICKET_PRIORITY_LABELS[ticket.priority],
    status: TICKET_STATUS_LABELS[ticket.status],
    overdue: ticket.isOverdue,
    dueAt: ticket.slaDueAt,
    updatedAt: ticket.updatedAt,
  };
}

function detailView(ticket: TicketDetail) {
  return {
    ...ticketView(ticket),
    description: ticket.description,
    affected: ticket.affectedDescription,
    resolvedAt: ticket.resolvedAt,
    recentHistory: ticket.history.slice(-5).map((event) => ({ type: event.type, comment: event.comment, at: event.createdAt })),
  };
}

function observe(trace: TurnTrace, tickets: readonly TicketSummary[]): void {
  for (const ticket of tickets) trace.tickets.set(ticket.code, ticket);
}

function describeTickets(tickets: readonly TicketSummary[]): string {
  if (tickets.length === 0) return 'Nenhum chamado encontrado.';
  const overdue = tickets.filter((t) => t.isOverdue).length;
  const codes = tickets.slice(0, 6).map((t) => t.code).join(', ');
  return `${tickets.length} chamado(s): ${codes}${tickets.length > 6 ? '…' : ''}${overdue ? `; ${overdue} com prazo vencido` : ''}.`;
}

/** A janela de reabertura é contada como no serviço de chamados (resolução, ou última atualização). */
function insideReopenWindow(ticket: TicketDetail, now: Date): boolean {
  const resolvedAt = new Date(ticket.resolvedAt ?? ticket.updatedAt).getTime();
  return now.getTime() - resolvedAt <= REOPEN_WINDOW_DAYS * 24 * 3_600_000;
}

const DraftInputSchema = z.object({
  operation: z.enum(['CREATE', 'UPDATE', 'REOPEN']).describe('CREATE abre, UPDATE complementa um chamado aberto, REOPEN reabre um resolvido.'),
  type: TicketTypeSchema.optional().describe('CREATE: INC (algo parou ou não funciona) ou REQ (pedido de acesso, equipamento ou software).'),
  category: TicketCategorySchema.optional().describe('CREATE: categoria.'),
  title: z.string().trim().max(120).optional().describe('CREATE: título curto e específico.'),
  description: z.string().trim().max(4000).optional().describe('CREATE: descrição com o que o funcionário contou (sintoma, desde quando, o que já tentou).'),
  affectedScope: AffectedScopeSchema.optional().describe('CREATE (e UPDATE com reavaliação): INDIVIDUAL, TEAM ou COMPANY.'),
  affectedDescription: z.string().trim().max(200).optional().describe('CREATE: quem é afetado, ex.: "Somente a Ana" ou "Equipe de vendas (8 pessoas)".'),
  urgency: z
    .enum(URGENCY_LEVELS)
    .optional()
    .describe('BLOCKED (impede o trabalho), SAME_DAY_DEADLINE (compromisso hoje), HAS_WORKAROUND (há alternativa), NONE (sem urgência).'),
  notDuplicateConfirmed: z.boolean().optional().describe('CREATE: true só se o funcionário confirmou que é outro problema que não os chamados parecidos.'),
  ticketCode: TicketCodeSchema.optional().describe('UPDATE/REOPEN: código do chamado do funcionário.'),
  comment: z.string().trim().max(4000).optional().describe('UPDATE: informação nova a registrar no chamado.'),
  reason: z.string().trim().max(4000).optional().describe('REOPEN: por que o problema voltou.'),
});
type DraftInput = z.infer<typeof DraftInputSchema>;

const MISSING_LABELS: Partial<Record<keyof DraftInput, string>> = {
  type: 'tipo (INC ou REQ)',
  category: 'categoria',
  title: 'título',
  description: 'descrição',
  affectedScope: 'quem é afetado (uma pessoa, a equipe ou a empresa)',
  affectedDescription: 'descrição de quem é afetado',
  urgency: 'urgência',
  ticketCode: 'código do chamado',
  comment: 'informação nova',
  reason: 'motivo da reabertura',
};

const REQUIRED_BY_OPERATION: Record<DraftInput['operation'], Array<keyof DraftInput>> = {
  CREATE: ['type', 'category', 'title', 'description', 'affectedScope', 'affectedDescription', 'urgency'],
  UPDATE: ['ticketCode', 'comment'],
  REOPEN: ['ticketCode', 'reason'],
};

export function createAgentTools(ctx: AgentToolContext) {
  const { ports, trace, now } = ctx;
  const duplicateChecks = new Map<string, TicketSummary[]>();

  /** Verificação de duplicidade, reaproveitada quando o mesmo problema já foi verificado nesta resposta. */
  async function checkDuplicates(input: { category: TicketCategory; title: string; description: string }) {
    const key = `${input.category}|${input.title.toLowerCase()}`;
    const cached = duplicateChecks.get(key);
    if (cached) return cached;
    const { value, ms } = await timed(() => ports.findDuplicateTickets(input));
    duplicateChecks.set(key, value);
    observe(trace, value);
    for (const ticket of value) if (!trace.duplicates.some((d) => d.code === ticket.code)) trace.duplicates.push(ticket);
    trace.ruleRefs.add(RULE_REFS.NO_DUPLICATES);
    record(
      trace,
      'findDuplicateTickets',
      'OK',
      value.length === 0 ? 'Nenhum chamado parecido em aberto.' : `${value.length} parecido(s) em aberto: ${value.map((t) => t.code).join(', ')}.`,
      ms,
    );
    return value;
  }

  /** Chamado do próprio funcionário, ou `null` (não existe ou é de outra pessoa). */
  async function loadOwnTicket(code: string): Promise<TicketDetail | null> {
    const cached = trace.details.get(code);
    if (cached) return cached;
    const detail = await ports.getMyTicket(code);
    if (detail) {
      trace.details.set(detail.code, detail);
      observe(trace, [detail]);
    } else {
      trace.ruleRefs.add(RULE_REFS.PRIVACY);
    }
    return detail;
  }

  function planDraftFailure(summary: string, message: string, extra: Record<string, unknown> = {}) {
    record(trace, 'proposeTicketDraft', 'SKIPPED', `Rascunho não preparado: ${summary}`);
    return { ok: false, staged: false, error: message, ...extra };
  }

  function stageDraft(payload: DraftPayload, summary: string) {
    trace.draft = payload;
    trace.ruleRefs.add(RULE_REFS.OPENING);
    record(trace, 'proposeTicketDraft', 'OK', summary);
    return {
      ok: true,
      staged: true,
      note: 'O rascunho aparece para o funcionário conferir e confirmar. Nada foi criado ou alterado ainda: não diga que o chamado foi aberto ou atualizado.',
    };
  }

  const searchHelpCenter = createTool({
    id: 'searchHelpCenter',
    description: 'Busca artigos curtos da central de ajuda de TI. Use primeiro em dúvidas e problemas comuns, antes de propor chamado.',
    inputSchema: z.object({ query: z.string().trim().min(2).max(200).describe('Palavras-chave do problema, ex.: "vpn erro 809".') }),
    execute: async ({ query }) => {
      const over = overBudget(ctx, 'searchHelpCenter');
      if (over) return over;
      try {
        const { value: articles, ms } = await timed(() => ports.searchHelpCenter(query, 3));
        for (const article of articles) if (!trace.articles.some((a) => a.id === article.id)) trace.articles.push(article);
        record(
          trace,
          'searchHelpCenter',
          'OK',
          articles.length === 0 ? `Nenhum artigo para "${query}".` : `${articles.length} artigo(s): ${articles.map((a) => a.title).join('; ')}.`,
          ms,
        );
        return { ok: true, articles: articles.map((a) => ({ slug: a.slug, title: a.title, body: a.body, category: a.category })) };
      } catch {
        record(trace, 'searchHelpCenter', 'ERROR', 'Central de ajuda indisponível.');
        return { ok: false, error: UNAVAILABLE.help };
      }
    },
  });

  const listMyTickets = createTool({
    id: 'listMyTickets',
    description: 'Lista os chamados do funcionário que está conversando (somente os dele), com status e se o prazo venceu.',
    inputSchema: z.object({ onlyOpen: z.boolean().optional().describe('true para listar só os chamados em aberto.') }),
    execute: async ({ onlyOpen }) => {
      const over = overBudget(ctx, 'listMyTickets');
      if (over) return over;
      try {
        const { value: tickets, ms } = await timed(() => ports.listMyTickets(onlyOpen === undefined ? {} : { onlyOpen }));
        observe(trace, tickets);
        if (tickets.some((t) => t.isOverdue)) trace.ruleRefs.add(RULE_REFS.PRIORITY_SLA);
        record(trace, 'listMyTickets', 'OK', describeTickets(tickets), ms);
        return { ok: true, tickets: tickets.map(ticketView) };
      } catch {
        record(trace, 'listMyTickets', 'ERROR', 'Sistema de chamados indisponível.');
        return { ok: false, error: UNAVAILABLE.tickets };
      }
    },
  });

  const getMyTicket = createTool({
    id: 'getMyTicket',
    description: 'Abre um chamado do funcionário pelo código, com descrição e histórico recente. Chamados de outras pessoas não são acessíveis.',
    inputSchema: z.object({ code: TicketCodeSchema.describe('Código do chamado, ex.: INC-20311.') }),
    execute: async ({ code }) => {
      const over = overBudget(ctx, 'getMyTicket');
      if (over) return over;
      try {
        const { value: detail, ms } = await timed(() => loadOwnTicket(code));
        if (!detail) {
          record(trace, 'getMyTicket', 'OK', `${code}: não está entre os chamados do funcionário.`, ms);
          return {
            ok: false,
            found: false,
            error: 'Este código não está entre os chamados deste funcionário. Não confirme nem negue que ele exista para outra pessoa.',
          };
        }
        if (detail.isOverdue) trace.ruleRefs.add(RULE_REFS.PRIORITY_SLA);
        record(trace, 'getMyTicket', 'OK', `${detail.code}: ${TICKET_STATUS_LABELS[detail.status]}${detail.isOverdue ? ', prazo vencido' : ''}.`, ms);
        return { ok: true, ticket: detailView(detail) };
      } catch {
        record(trace, 'getMyTicket', 'ERROR', 'Sistema de chamados indisponível.');
        return { ok: false, error: UNAVAILABLE.tickets };
      }
    },
  });

  const findDuplicateTickets = createTool({
    id: 'findDuplicateTickets',
    description: 'Procura chamados ABERTOS do funcionário sobre o mesmo problema. Use antes de propor um chamado novo.',
    inputSchema: z.object({
      category: TicketCategorySchema,
      title: z.string().trim().min(3).max(120),
      description: z.string().trim().min(3).max(4000),
    }),
    execute: async (input) => {
      const over = overBudget(ctx, 'findDuplicateTickets');
      if (over) return over;
      try {
        const candidates = await checkDuplicates(input);
        return { ok: true, openSimilarTickets: candidates.map(ticketView) };
      } catch {
        record(trace, 'findDuplicateTickets', 'ERROR', 'Sistema de chamados indisponível.');
        return { ok: false, error: UNAVAILABLE.tickets };
      }
    },
  });

  const proposeTicketDraft = createTool({
    id: 'proposeTicketDraft',
    description:
      'Prepara um RASCUNHO de abertura (CREATE), atualização (UPDATE) ou reabertura (REOPEN) para o funcionário conferir. ' +
      'Não cria nem altera chamado: a escrita só acontece quando o funcionário confirma. A prioridade é calculada pela regra ' +
      'de impacto x urgência a partir de affectedScope e urgency. Um rascunho por resposta.',
    inputSchema: DraftInputSchema,
    execute: async (input) => {
      const over = overBudget(ctx, 'proposeTicketDraft');
      if (over) return over;
      if (trace.draft) return planDraftFailure('já existe um rascunho nesta resposta.', 'Já existe um rascunho nesta resposta.');

      const missing = REQUIRED_BY_OPERATION[input.operation].filter((field) => input[field] === undefined || input[field] === '');
      if (missing.length > 0) {
        const names = missing.map((field) => MISSING_LABELS[field] ?? field);
        return planDraftFailure(`faltam ${names.join(', ')}.`, 'Faltam informações. Pergunte ao funcionário antes de preparar o rascunho.', {
          missing: names,
        });
      }

      try {
        if (input.operation === 'CREATE') {
          const type = input.type!;
          const category = input.category!;
          const assessment = classifyPriority({ affectedScope: input.affectedScope!, urgency: input.urgency! });
          trace.ruleRefs.add(RULE_REFS.TYPE).add(RULE_REFS.CATEGORY).add(RULE_REFS.PRIORITY_SLA);
          record(trace, 'classifyType', 'OK', `${TICKET_TYPE_LABELS[type]} (${type === 'INC' ? 'algo parou ou não funciona' : 'pedido de acesso, equipamento ou software'}).`);
          record(trace, 'classifyCategory', 'OK', TICKET_CATEGORY_LABELS[category]);
          record(
            trace,
            'classifyPriority',
            'OK',
            `${TICKET_PRIORITY_LABELS[assessment.priority]}: ${assessment.impact}; ${assessment.urgency}. Prazo: ${slaText(assessment.priority)}.`,
          );

          const parsed = CreateDraftPayloadSchema.safeParse({
            operation: 'CREATE',
            fields: {
              type,
              title: input.title,
              description: input.description,
              category,
              priority: assessment.priority,
              affectedScope: input.affectedScope,
              affectedDescription: input.affectedDescription,
            },
            priorityAssessment: assessment,
          });
          if (!parsed.success) {
            const problems = parsed.error.issues.map((issue) => `${issue.path.slice(1).join('.') || issue.path.join('.')}: ${issue.message}`);
            return planDraftFailure('campos inválidos.', 'Campos inválidos no rascunho.', { problems });
          }

          const similar = await checkDuplicates({ category, title: parsed.data.fields.title, description: parsed.data.fields.description });
          if (similar.length > 0 && !input.notDuplicateConfirmed) {
            return planDraftFailure(`possível duplicidade com ${similar.map((t) => t.code).join(', ')}.`, 'Já existe chamado aberto parecido. Pela regra, atualize o existente em vez de duplicar: ofereça UPDATE (ou peça para o funcionário escolher, se houver mais de um).', {
              openSimilarTickets: similar.map(ticketView),
            });
          }
          const { fields } = parsed.data;
          return stageDraft(
            parsed.data,
            `${TICKET_TYPE_LABELS[fields.type]} · ${TICKET_CATEGORY_LABELS[fields.category]} · prioridade ${TICKET_PRIORITY_LABELS[fields.priority]} (prazo ${slaText(fields.priority)}): ${fields.title}`,
          );
        }

        const ticket = await loadOwnTicket(input.ticketCode!);
        if (!ticket) {
          return planDraftFailure(`${input.ticketCode} não está entre os chamados do funcionário.`, 'Chamado não encontrado entre os chamados deste funcionário.');
        }

        if (input.operation === 'UPDATE') {
          if (!OPEN_TICKET_STATUSES.includes(ticket.status)) {
            const hint = ticket.status === 'RESOLVED' ? ' Ele está resolvido: se o problema voltou, proponha REOPEN.' : '';
            return planDraftFailure(`${ticket.code} não está aberto.`, `Só chamados abertos podem ser atualizados.${hint}`);
          }
          trace.ruleRefs.add(RULE_REFS.NO_DUPLICATES);
          const reassessment =
            input.affectedScope && input.urgency ? classifyPriority({ affectedScope: input.affectedScope, urgency: input.urgency }) : undefined;
          if (reassessment) {
            trace.ruleRefs.add(RULE_REFS.PRIORITY_SLA);
            record(
              trace,
              'classifyPriority',
              'OK',
              `${TICKET_PRIORITY_LABELS[reassessment.priority]}: ${reassessment.impact}; ${reassessment.urgency}. Prazo: ${slaText(reassessment.priority)}.`,
            );
          }
          const parsed = UpdateDraftPayloadSchema.safeParse({
            operation: 'UPDATE',
            ticketCode: ticket.code,
            comment: input.comment,
            ...(reassessment && reassessment.priority !== ticket.priority ? { priorityAssessment: reassessment } : {}),
          });
          if (!parsed.success) return planDraftFailure('informação nova inválida.', 'Informação nova inválida (mínimo de 3 caracteres).');
          return stageDraft(parsed.data, `Atualizar ${ticket.code}: ${parsed.data.comment}`);
        }

        trace.ruleRefs.add(RULE_REFS.REOPEN);
        if (ticket.status !== 'RESOLVED') {
          return planDraftFailure(`${ticket.code} não está resolvido.`, 'Só chamados resolvidos podem ser reabertos. Se ele está aberto, proponha UPDATE.');
        }
        if (!insideReopenWindow(ticket, now)) {
          return planDraftFailure(
            `${ticket.code} foi resolvido há mais de ${REOPEN_WINDOW_DAYS} dias.`,
            `Chamados só podem ser reabertos até ${REOPEN_WINDOW_DAYS} dias após a resolução. Proponha abrir um chamado novo (CREATE) citando ${ticket.code}.`,
          );
        }
        const parsed = ReopenDraftPayloadSchema.safeParse({ operation: 'REOPEN', ticketCode: ticket.code, reason: input.reason });
        if (!parsed.success) return planDraftFailure('motivo inválido.', 'Motivo da reabertura inválido (mínimo de 3 caracteres).');
        return stageDraft(parsed.data, `Reabrir ${ticket.code}: ${parsed.data.reason}`);
      } catch {
        record(trace, 'proposeTicketDraft', 'ERROR', 'Sistema de chamados indisponível.');
        return { ok: false, staged: false, error: UNAVAILABLE.tickets };
      }
    },
  });

  const requestHandoff = createTool({
    id: 'requestHandoff',
    description:
      'Transfere a conversa para um analista humano ao final desta resposta. Use quando o funcionário pedir, em caso crítico, ' +
      'em chamado vencido ou quando você não tiver segurança. Depois disso você para de responder nesta conversa.',
    inputSchema: z.object({
      reason: HandoffReasonSchema.describe('EMPLOYEE_REQUEST, CRITICAL_ISSUE, OVERDUE_TICKET ou LOW_CONFIDENCE.'),
      summary: z
        .string()
        .trim()
        .min(20)
        .max(1500)
        .describe('Resumo para o analista: o pedido, o que já foi verificado e o que falta.'),
      relatedTicketCode: TicketCodeSchema.optional().describe('Chamado do funcionário relacionado, se houver.'),
    }),
    execute: async ({ reason, summary, relatedTicketCode }) => {
      const over = overBudget(ctx, 'requestHandoff');
      if (over) return over;
      if (trace.handoff) return { ok: true, staged: true, note: 'A transferência já foi registrada nesta resposta.' };
      try {
        if (relatedTicketCode) {
          const ticket = await loadOwnTicket(relatedTicketCode);
          if (!ticket) {
            record(trace, 'requestHandoff', 'SKIPPED', `Não transferido: ${relatedTicketCode} não está entre os chamados do funcionário.`);
            return { ok: false, error: 'Chamado relacionado não encontrado entre os chamados deste funcionário. Transfira sem ele, se for o caso.' };
          }
          if (reason === 'OVERDUE_TICKET' && !ticket.isOverdue) {
            record(trace, 'requestHandoff', 'SKIPPED', `Não transferido: ${ticket.code} não está com o prazo vencido.`);
            return { ok: false, error: `${ticket.code} não está vencido. Use outro motivo, se a transferência ainda fizer sentido.` };
          }
        } else if (reason === 'OVERDUE_TICKET') {
          record(trace, 'requestHandoff', 'SKIPPED', 'Não transferido: motivo "chamado vencido" sem o chamado.');
          return { ok: false, error: 'Informe relatedTicketCode do chamado vencido.' };
        }
      } catch {
        record(trace, 'requestHandoff', 'ERROR', 'Sistema de chamados indisponível.');
        return { ok: false, error: UNAVAILABLE.tickets };
      }

      trace.handoff = {
        reason,
        summary,
        relatedTicketCode: relatedTicketCode ?? null,
        requestedBy: reason === 'EMPLOYEE_REQUEST' ? 'EMPLOYEE' : 'AGENT',
        automatic: false,
      };
      trace.ruleRefs.add(RULE_REFS.HANDOFF);
      record(trace, 'requestHandoff', 'OK', `Motivo: ${HANDOFF_REASON_LABELS[reason]}${relatedTicketCode ? ` (${relatedTicketCode})` : ''}.`);
      return {
        ok: true,
        staged: true,
        note: 'A conversa vai para a fila dos analistas junto com esta resposta. Avise o funcionário que um analista vai assumir.',
      };
    },
  });

  const submitResponse = createTool({
    id: 'submitResponse',
    description: 'Entrega a resposta ao funcionário com o registro da decisão. Chame exatamente uma vez, por último.',
    inputSchema: AgentProposalSchema,
    execute: async (proposal) => {
      trace.submission ??= proposal;
      return { ok: true };
    },
  });

  return { searchHelpCenter, listMyTickets, getMyTicket, findDuplicateTickets, proposeTicketDraft, requestHandoff, submitResponse };
}

export const SUBMIT_TOOL = 'submitResponse';
