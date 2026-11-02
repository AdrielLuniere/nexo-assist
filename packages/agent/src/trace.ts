import type { AgentStep, DraftPayload, HelpArticle, RuleRef, TicketCode, TicketDetail, TicketSummary } from '@nexo/shared';
import type { PlannedHandoff } from './ports.js';
import type { AgentProposal } from './proposal.js';

/**
 * Registro de uma resposta em andamento: o que as ferramentas realmente executaram e devolveram.
 * É a fonte de verdade da explicabilidade (os passos exibidos vêm daqui, não do texto do modelo) e
 * a base da política determinística, que confere a proposta do modelo contra estes fatos.
 */
export interface TurnTrace {
  readonly steps: AgentStep[];
  /** Chamados do próprio funcionário devolvidos pelas ferramentas nesta resposta. */
  readonly tickets: Map<TicketCode, TicketSummary>;
  /** Chamados abertos em detalhe nesta resposta. */
  readonly details: Map<TicketCode, TicketDetail>;
  readonly articles: HelpArticle[];
  readonly duplicates: TicketSummary[];
  readonly ruleRefs: Set<RuleRef>;
  draft: DraftPayload | null;
  handoff: PlannedHandoff | null;
  submission: AgentProposal | null;
  /** Chamadas de ferramenta (exceto `submitResponse`), para o limite por resposta. */
  toolCalls: number;
  /** Devolve os passos registrados desde a última chamada (para o streaming). */
  takeNewSteps(): AgentStep[];
}

export function createTurnTrace(): TurnTrace {
  let emitted = 0;
  const trace: TurnTrace = {
    steps: [],
    tickets: new Map(),
    details: new Map(),
    articles: [],
    duplicates: [],
    ruleRefs: new Set(),
    draft: null,
    handoff: null,
    submission: null,
    toolCalls: 0,
    takeNewSteps() {
      const fresh = trace.steps.slice(emitted);
      emitted = trace.steps.length;
      return fresh;
    },
  };
  return trace;
}

/** Resumos de passo têm teto de 500 caracteres no contrato. */
export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}
