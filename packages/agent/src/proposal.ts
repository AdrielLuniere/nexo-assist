import { AgentActionSchema, AgentIntentSchema, TicketCodeSchema } from '@nexo/shared';
import { z } from 'zod';

/**
 * O que o modelo entrega ao terminar cada resposta, pela ferramenta `submitResponse`. É uma PROPOSTA:
 * a política determinística (`policy.ts`) confere a proposta contra o que as ferramentas realmente
 * fizeram, corrige incoerências e decide transferências antes de virar a decisão registrada.
 *
 * `rationale` é uma justificativa curta e objetiva para o funcionário e o analista lerem, não o
 * raciocínio interno do modelo (que não é pedido nem guardado).
 */
export const AgentProposalSchema = z.object({
  intent: AgentIntentSchema.describe('O que o funcionário quer nesta mensagem.'),
  understanding: z
    .string()
    .trim()
    .min(3)
    .max(300)
    .describe('Paráfrase curta do pedido, em português, como o funcionário reconheceria.'),
  action: AgentActionSchema.describe('A ação que esta resposta realiza.'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Segurança na ação escolhida, de 0 a 1, conforme a escala das instruções.'),
  rationale: z
    .string()
    .trim()
    .min(3)
    .max(600)
    .describe('Por que esta ação, em 1 ou 2 frases objetivas, citando o que as ferramentas mostraram.'),
  ruleRefs: z
    .array(z.string())
    .max(9)
    .optional()
    .describe('Regras do service desk aplicadas (A.TIPO, A.CATEGORIA, A.ABERTURA, ...).'),
  reply: z.string().trim().min(1).max(1500).describe('Texto da resposta ao funcionário.'),
  showTickets: z
    .array(TicketCodeSchema)
    .max(5)
    .optional()
    .describe('Códigos de chamados a exibir como cards. Só chamados devolvidos pelas ferramentas nesta resposta.'),
  ticketSelection: z
    .object({
      prompt: z.string().trim().min(3).max(200),
      ticketCodes: z.array(TicketCodeSchema).min(2).max(6),
    })
    .optional()
    .describe('Quando houver mais de um chamado possível, peça para o funcionário escolher.'),
  quickReplies: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(40),
        value: z.string().trim().min(1).max(300),
      }),
    )
    .max(4)
    .optional()
    .describe('Opções rápidas para a próxima mensagem do funcionário (ex.: respostas de uma pergunta).'),
});
export type AgentProposal = z.infer<typeof AgentProposalSchema>;
