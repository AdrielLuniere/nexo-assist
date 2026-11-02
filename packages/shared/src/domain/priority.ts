import type { AffectedScope, TicketPriority } from './enums.js';
import type { PriorityAssessment } from './draft.js';

/**
 * Classificação de prioridade (Anexo A): combina impacto (quantas pessoas) e urgência
 * (compromisso em risco). Função pura, compartilhada: o agente a usa para propor a prioridade
 * e o serviço de chamados a usa para validar a consistência do que foi confirmado.
 */

/** Urgência percebida. [Decisão] Quatro níveis que mapeiam as linhas da tabela do Anexo A. */
export const URGENCY_LEVELS = ['BLOCKED', 'SAME_DAY_DEADLINE', 'HAS_WORKAROUND', 'NONE'] as const;
export type Urgency = (typeof URGENCY_LEVELS)[number];

const IMPACT_TEXT: Record<AffectedScope, string> = {
  INDIVIDUAL: 'Afeta uma pessoa',
  TEAM: 'Afeta uma equipe',
  COMPANY: 'Afeta a empresa toda',
};

const URGENCY_TEXT: Record<Urgency, string> = {
  BLOCKED: 'Impede o trabalho (algo parou)',
  SAME_DAY_DEADLINE: 'Há compromisso no mesmo dia',
  HAS_WORKAROUND: 'Atrapalha, mas existe alternativa',
  NONE: 'Sem urgência (pedido ou melhoria)',
};

export function classifyPriority(input: { affectedScope: AffectedScope; urgency: Urgency }): PriorityAssessment {
  const { affectedScope, urgency } = input;
  const wide = affectedScope !== 'INDIVIDUAL';

  let priority: TicketPriority;
  let rationale: string;
  switch (urgency) {
    case 'BLOCKED':
      priority = wide ? 'CRITICAL' : 'HIGH';
      rationale = wide
        ? 'Algo parado para uma equipe ou para a empresa: prioridade Crítica.'
        : 'Impede uma pessoa de trabalhar: prioridade Alta.';
      break;
    case 'SAME_DAY_DEADLINE':
      priority = 'HIGH';
      rationale = 'Há compromisso no mesmo dia: prioridade Alta.';
      break;
    case 'HAS_WORKAROUND':
      priority = 'MEDIUM';
      rationale = 'Atrapalha, mas há alternativa: prioridade Média.';
      break;
    case 'NONE':
      priority = 'LOW';
      rationale = 'Pedido ou melhoria sem urgência: prioridade Baixa.';
      break;
  }

  return { priority, impact: IMPACT_TEXT[affectedScope], urgency: URGENCY_TEXT[urgency], rationale };
}

/**
 * Anexo A: Crítica é "algo parado para uma equipe ou para a empresa". Crítica para um chamado
 * individual contradiz a regra; devolve a mensagem do problema ou `null` quando está coerente.
 */
export function priorityScopeConflict(priority: TicketPriority, affectedScope: AffectedScope): string | null {
  if (priority === 'CRITICAL' && affectedScope === 'INDIVIDUAL') {
    return 'Prioridade Crítica exige impacto em uma equipe ou na empresa; para uma pessoa use Alta.';
  }
  return null;
}
