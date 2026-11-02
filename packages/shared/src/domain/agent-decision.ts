import { z } from 'zod';
import { AgentActionSchema, AgentIntentSchema } from './enums.js';
import { MIN_AGENT_CONFIDENCE } from './rules.js';
import { IdSchema, IsoDateTimeSchema } from './user.js';

/**
 * Registro de decisão do agente: base da "visibilidade das decisões" (PRD, item 7).
 * Para cada resposta: o que entendeu, que ação tomou, com que segurança e por quê,
 * além dos passos executados (exibidos acima da resposta, ex.: "consultou seus chamados").
 */

export const AGENT_STEP_STATUSES = ['OK', 'ERROR', 'SKIPPED'] as const;

export const AgentStepSchema = z.object({
  /** Identificador estável do passo (id da ferramenta ou etapa interna, ex.: `listMyTickets`). */
  kind: z.string().min(1),
  /** Rótulo legível exibido na interface, ex.: "consultou seus chamados". */
  label: z.string().min(1),
  status: z.enum(AGENT_STEP_STATUSES),
  /** Resumo do resultado, sem dados de outros funcionários. */
  summary: z.string().max(500).optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type AgentStep = z.infer<typeof AgentStepSchema>;

export const CONFIDENCE_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const ConfidenceLevelSchema = z.enum(CONFIDENCE_LEVELS);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

export const AgentDecisionSchema = z.object({
  id: IdSchema,
  conversationId: IdSchema,
  /** Mensagem do agente produzida por esta decisão. */
  messageId: IdSchema.nullable(),
  intent: AgentIntentSchema,
  /** Paráfrase curta do que o agente entendeu. */
  understanding: z.string().min(1).max(500),
  action: AgentActionSchema,
  /** 0..1, informado pelo modelo e ajustado por regras determinísticas. */
  confidence: z.number().min(0).max(1),
  confidenceLevel: ConfidenceLevelSchema,
  /** Justificativa legível, citando regras quando aplicável. */
  rationale: z.string().min(1).max(1000),
  /** Regras do Anexo A consideradas, ex.: `A.ABERTURA`, `A.DUPLICIDADE` (ver RULE_REFS). */
  ruleRefs: z.array(z.string()),
  steps: z.array(AgentStepSchema),
  /** Telemetria de custo e latência. */
  model: z.string().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

/** Referências estáveis às regras do Anexo A, citadas nas decisões. */
export const RULE_REFS = {
  TYPE: 'A.TIPO',
  CATEGORY: 'A.CATEGORIA',
  OPENING: 'A.ABERTURA',
  NO_DUPLICATES: 'A.DUPLICIDADE',
  REOPEN: 'A.REABERTURA',
  HANDOFF: 'A.TRANSFERENCIA',
  PRIVACY: 'A.PRIVACIDADE',
  SCOPE: 'A.ESCOPO',
  PRIORITY_SLA: 'A.PRIORIDADE_PRAZO',
} as const;
export type RuleRef = (typeof RULE_REFS)[keyof typeof RULE_REFS];

/** Abaixo de MEDIUM a confiança é baixa e a regra de transferência por insegurança se aplica. */
export function confidenceLevelOf(confidence: number): ConfidenceLevel {
  if (confidence >= 0.8) return 'HIGH';
  if (confidence >= MIN_AGENT_CONFIDENCE) return 'MEDIUM';
  return 'LOW';
}
