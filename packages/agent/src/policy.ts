import {
  type AgentAction,
  type AgentStep,
  type ConfidenceLevel,
  type DraftPayload,
  type HandoffReason,
  HANDOFF_REASON_LABELS,
  type MessageBlock,
  MIN_AGENT_CONFIDENCE,
  type QuickReply,
  RULE_REFS,
  type RuleRef,
  type TicketCode,
  type TicketSummary,
  confidenceLevelOf,
} from '@nexo/shared';
import type { PlannedHandoff } from './ports.js';
import type { AgentProposal } from './proposal.js';
import { AGENT_INTERNAL_STEPS, AGENT_TOOLS } from './tool-catalog.js';
import { type TurnTrace, clip } from './trace.js';

/**
 * Política determinística aplicada a TODA resposta, depois do modelo e antes de publicar.
 *
 * O modelo propõe (intenção, ação, confiança, texto); a política confere a proposta contra o que as
 * ferramentas realmente fizeram (`TurnTrace`) e aplica as regras do Anexo A que não podem depender
 * do modelo. Cada correção vira uma nota legível na justificativa ("Ajustes automáticos: ...").
 *
 * Critérios (documentados em docs/architecture.md, "Agente"):
 * 1. Escopo: intenção fora de TI vira REDIRECT_OUT_OF_SCOPE e nunca carrega rascunho.
 * 2. Coerência: a ação declarada precisa de evidência. Rascunho declarado sem rascunho válido,
 *    resposta "da central de ajuda" sem artigo encontrado ou cards sem chamados consultados viram
 *    REPLY, com a confiança limitada a 0,7. Com rascunho válido, a ação é a do rascunho.
 * 3. Só aparecem cards de chamados devolvidos pelas ferramentas nesta resposta (privacidade).
 * 4. Transferência obrigatória: pedido do funcionário, chamado CRÍTICO proposto, ou confiança
 *    final abaixo de MIN_AGENT_CONFIDENCE (0,6). Se o modelo não a fez, a política faz.
 * 5. Chamado vencido exibido sem transferência: oferece "Chamar um analista" (Tela 3).
 */

export interface DecisionRecord {
  readonly intent: AgentProposal['intent'];
  readonly understanding: string;
  readonly action: AgentAction;
  readonly confidence: number;
  readonly confidenceLevel: ConfidenceLevel;
  readonly rationale: string;
  readonly ruleRefs: RuleRef[];
  readonly steps: AgentStep[];
}

export interface PolicyOutcome {
  readonly decision: DecisionRecord;
  /** Texto final e blocos de conteúdo (texto + cards/seleção). Rascunho e aviso de transferência são acrescentados ao publicar. */
  readonly reply: { readonly text: string; readonly blocks: MessageBlock[]; readonly quickReplies: QuickReply[] };
  readonly draft: DraftPayload | null;
  readonly handoff: PlannedHandoff | null;
  /** Passos acrescentados pela política (também presentes em `decision.steps`). */
  readonly policySteps: AgentStep[];
}

/** Teto de confiança quando a ação declarada não tem evidência nas ferramentas. */
export const UNSUPPORTED_ACTION_CONFIDENCE_CAP = 0.7;

const DRAFT_ACTIONS: Record<DraftPayload['operation'], AgentAction> = {
  CREATE: 'PROPOSE_TICKET_DRAFT',
  UPDATE: 'PROPOSE_TICKET_UPDATE',
  REOPEN: 'PROPOSE_TICKET_REOPEN',
};
const PROPOSE_ACTIONS = new Set<AgentAction>(Object.values(DRAFT_ACTIONS));
const RULE_ORDER = Object.values(RULE_REFS) as RuleRef[];

const HANDOFF_ADDENDUM: Record<HandoffReason, string> = {
  EMPLOYEE_REQUEST: 'Vou chamar um analista do service desk para continuar o atendimento. Ele recebe o resumo da nossa conversa.',
  CRITICAL_ISSUE: 'Como o caso é crítico, também chamei um analista do service desk, que já recebe o resumo da conversa.',
  OVERDUE_TICKET: 'Como o chamado está com o prazo vencido, chamei um analista do service desk para acompanhar.',
  LOW_CONFIDENCE: 'Para não te passar uma orientação errada, vou chamar um analista do service desk. Ele recebe o resumo da nossa conversa.',
};

/** Número com vírgula, como o funcionário e o analista leem. */
const decimal = (value: number) => value.toFixed(2).replace('.', ',');

/** Corta no limite preservando as quebras de linha (o resumo da transferência é lido pelo analista). */
const truncate = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

export function finalizeTurn(trace: TurnTrace, proposal: AgentProposal): PolicyOutcome {
  const notes: string[] = [];
  const policySteps: AgentStep[] = [];
  const refs = new Set<RuleRef>(trace.ruleRefs);
  for (const ref of proposal.ruleRefs ?? []) if (RULE_ORDER.includes(ref as RuleRef)) refs.add(ref as RuleRef);

  let action = proposal.action;
  let confidence = Math.min(1, Math.max(0, proposal.confidence));
  let draft = trace.draft;
  let handoff = trace.handoff;
  let quickReplies = proposal.quickReplies ?? [];
  let text = proposal.reply.trim();

  const cap = (limit: number, note: string) => {
    if (confidence > limit) confidence = limit;
    notes.push(note);
  };

  // 1. Escopo
  if (proposal.intent === 'OUT_OF_SCOPE') {
    refs.add(RULE_REFS.SCOPE);
    if (draft) {
      draft = null;
      cap(0.5, 'rascunho descartado porque o assunto foi classificado como fora de TI');
    }
    action = 'REDIRECT_OUT_OF_SCOPE';
    policySteps.push({ kind: 'checkScope', label: AGENT_INTERNAL_STEPS.checkScope, status: 'OK', summary: 'Assunto fora de TI: orientado a procurar a área responsável.' });
  }

  // 2. Coerência entre a ação declarada e o que as ferramentas fizeram
  if (draft) {
    action = DRAFT_ACTIONS[draft.operation];
  } else if (PROPOSE_ACTIONS.has(action)) {
    action = 'REPLY';
    cap(UNSUPPORTED_ACTION_CONFIDENCE_CAP, 'a ação declarada era um rascunho, mas nenhum rascunho válido foi preparado');
  }
  if (action === 'ANSWER_FROM_HELP_CENTER' && trace.articles.length === 0) {
    action = 'REPLY';
    cap(UNSUPPORTED_ACTION_CONFIDENCE_CAP, 'nenhum artigo da central de ajuda foi encontrado nesta resposta');
  }

  // 3. Cards e seleção: só chamados devolvidos pelas ferramentas nesta resposta
  const known = (codes: readonly TicketCode[] | undefined): TicketSummary[] => {
    const seen = new Set<string>();
    const result: TicketSummary[] = [];
    for (const code of codes ?? []) {
      const ticket = trace.tickets.get(code);
      if (ticket && !seen.has(code)) {
        seen.add(code);
        result.push(ticket);
      }
    }
    return result;
  };
  const requested = (proposal.showTickets?.length ?? 0) + (proposal.ticketSelection?.ticketCodes.length ?? 0);
  let cards = known(proposal.showTickets);
  let selection = proposal.ticketSelection ? known(proposal.ticketSelection.ticketCodes) : [];
  if (cards.length + selection.length < requested) {
    refs.add(RULE_REFS.PRIVACY);
    notes.push('chamados não consultados nesta resposta foram omitidos');
  }
  if (selection.length === 1) {
    cards = [...cards, ...selection.filter((t) => !cards.some((c) => c.code === t.code))];
    selection = [];
  }
  if (action === 'ASK_TICKET_SELECTION' && selection.length < 2) {
    action = cards.length > 0 ? 'SHOW_TICKETS' : 'REPLY';
    cap(UNSUPPORTED_ACTION_CONFIDENCE_CAP, 'a seleção de chamado precisa de ao menos dois chamados consultados');
  }
  if (action === 'SHOW_TICKETS' && cards.length === 0 && selection.length === 0) {
    action = 'REPLY';
    cap(UNSUPPORTED_ACTION_CONFIDENCE_CAP, 'nenhum chamado consultado para exibir');
  }

  // 4. Transferências obrigatórias
  const stage = (reason: HandoffReason, relatedTicketCode: TicketCode | null, note: string) => {
    handoff = {
      reason,
      relatedTicketCode,
      requestedBy: reason === 'EMPLOYEE_REQUEST' ? 'EMPLOYEE' : 'AGENT',
      automatic: true,
      summary: truncate(
        [
          `Pedido: ${proposal.understanding}`,
          `Motivo da transferência: ${HANDOFF_REASON_LABELS[reason]}.`,
          relatedTicketCode ? `Chamado relacionado: ${relatedTicketCode}.` : null,
          `O que o agente já fez: ${trace.steps.filter((s) => s.status === 'OK').map((s) => s.summary ?? s.label).join(' ') || 'nenhuma consulta.'}`,
        ]
          .filter(Boolean)
          .join('\n'),
        2000,
      ),
    };
    notes.push(note);
    policySteps.push({
      kind: 'requestHandoff',
      label: AGENT_TOOLS.requestHandoff.label,
      status: 'OK',
      summary: `Motivo: ${HANDOFF_REASON_LABELS[reason]}${relatedTicketCode ? ` (${relatedTicketCode})` : ''}. Transferência automática pela regra do service desk.`,
    });
  };

  const overdueShown = [...cards, ...selection, ...trace.details.values()].find((t) => t.isOverdue);
  if (!handoff && (proposal.intent === 'TALK_TO_ANALYST' || action === 'TRANSFER_TO_ANALYST')) {
    if (proposal.intent === 'TALK_TO_ANALYST') stage('EMPLOYEE_REQUEST', overdueShown?.code ?? null, 'o funcionário pediu um analista');
    else if (overdueShown) stage('OVERDUE_TICKET', overdueShown.code, 'a resposta declarou transferência por chamado vencido');
    else stage('LOW_CONFIDENCE', null, 'a resposta declarou transferência sem registrá-la');
  }
  if (!handoff && draft?.operation === 'CREATE' && draft.fields.priority === 'CRITICAL') {
    stage('CRITICAL_ISSUE', null, 'caso crítico: transferência obrigatória (Anexo A)');
  }
  if (!handoff && confidence < MIN_AGENT_CONFIDENCE) {
    stage('LOW_CONFIDENCE', null, `confiança ${decimal(confidence)} abaixo do mínimo ${decimal(MIN_AGENT_CONFIDENCE)}`);
  }

  const planned = handoff as PlannedHandoff | null;
  if (planned) {
    action = 'TRANSFER_TO_ANALYST';
    refs.add(RULE_REFS.HANDOFF);
    // Depois da transferência o agente para de responder: opções rápidas não fariam sentido.
    quickReplies = [];
    if (planned.automatic && !/analista/i.test(text)) text = `${text}\n\n${HANDOFF_ADDENDUM[planned.reason]}`;
  } else if (overdueShown && !quickReplies.some((q) => /analista/i.test(q.label))) {
    // 5. Chamado vencido: oferece o analista (o funcionário decide).
    refs.add(RULE_REFS.PRIORITY_SLA).add(RULE_REFS.HANDOFF);
    quickReplies = [
      ...quickReplies.slice(0, 3),
      { label: 'Chamar um analista', value: `Quero falar com um analista sobre o chamado ${overdueShown.code}, que está com o prazo vencido.` },
    ];
  }

  const blocks: MessageBlock[] = [{ type: 'text', text }];
  if (cards.length > 0) blocks.push({ type: 'ticket_cards', tickets: cards });
  if (selection.length >= 2) blocks.push({ type: 'ticket_selection', prompt: proposal.ticketSelection?.prompt ?? 'Qual destes chamados?', options: selection });

  const rationale = clip(notes.length === 0 ? proposal.rationale : `${proposal.rationale} Ajustes automáticos: ${notes.join('; ')}.`, 1000);
  const steps = [...trace.steps, ...policySteps];
  const finalConfidence = Math.round(confidence * 100) / 100;

  return {
    decision: {
      intent: proposal.intent,
      understanding: clip(proposal.understanding, 500),
      action,
      confidence: finalConfidence,
      confidenceLevel: confidenceLevelOf(finalConfidence),
      rationale,
      ruleRefs: RULE_ORDER.filter((ref) => refs.has(ref)),
      steps,
    },
    reply: {
      text,
      blocks,
      quickReplies: quickReplies.map((reply, index) => ({ id: `qr_${index + 1}`, label: reply.label, value: reply.value })),
    },
    draft,
    handoff: planned,
    policySteps,
  };
}
