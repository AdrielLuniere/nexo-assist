# Arquitetura do Nexo Assist

Documento vivo. Descreve as fronteiras entre módulos, de onde vem cada regra e as decisões
técnicas tomadas até aqui. As fases (P0.1, P0.2, P0.3) aparecem nos comentários do código.

## Visão geral

```
apps/web  ──HTTP/SSE──▶  apps/api  ──▶  packages/agent (Mastra)
(React)                  (Express)        │ só fala por portas (AgentToolPorts)
                            │             ▼
                            ├──────▶  packages/ticket-service  (sistema de chamados simulado)
                            │
                            └──────▶  PostgreSQL (Prisma)
                  packages/shared: contratos Zod e regras usados por todos
```

| Pacote | Responsabilidade | Não pode depender de |
| --- | --- | --- |
| `packages/shared` | Tipos de domínio, schemas Zod, contratos HTTP, parâmetros das regras do Anexo A | nenhum pacote interno, Prisma, Express, Mastra |
| `packages/ticket-service` | Contrato e regras do sistema de chamados "legado": privacidade, duplicidade, reabertura, prazos | agente, API, web, Prisma, Express, Mastra |
| `packages/agent` | Agente Mastra: instruções, catálogo de ferramentas, portas | serviço de chamados, API, web, Prisma, Express |
| `apps/api` | Raiz de composição: autenticação, persistência, orquestração, streaming | — |
| `apps/web` | Chat do funcionário e console do analista | qualquer pacote interno além de `@nexo/shared` |

As fronteiras são verificadas automaticamente em [`tests/architecture.test.ts`](../tests/architecture.test.ts)
(dependências declaradas e imports). Os enums do Prisma são comparados aos de `packages/shared`
em [`tests/prisma-contracts.test.ts`](../tests/prisma-contracts.test.ts).

### Por que o agente não acessa o banco

O agente só age por `AgentToolPorts` ([`ports.ts`](../packages/agent/src/ports.ts)). A API cria
as portas **por requisição**, já vinculadas ao funcionário autenticado e à conversa. Nenhuma
ferramenta recebe `employeeId`, então o modelo não consegue pedir dados de outra pessoa, mesmo
sob prompt injection. A privacidade não depende do prompt.

### Por que o agente não escreve chamados

As ferramentas de "escrita" do agente (`proposeTicketDraft`, `requestHandoff`) apenas registram
um rascunho ou uma transferência. A escrita no serviço de chamados só acontece quando o
funcionário confirma o rascunho pela API (`POST .../drafts/:draftId/confirm`), e o serviço exige
um `confirmedDraftId`. Isso implementa a regra "só cria ou atualiza depois da confirmação" em código.

## Persistência

PostgreSQL via Prisma 7 (driver adapter `@prisma/adapter-pg`). Esquema em
[`prisma/schema.prisma`](../prisma/schema.prisma). Conversas, mensagens, rascunhos, decisões do
agente, transferências e chamados ficam no banco, então sobrevivem a reinícios (requisito do PRD).

Propriedade das tabelas (por código, não por permissão de banco):

- serviço de chamados: `tickets`, `ticket_events`, `ticket_sequences`;
- API: `users`, `conversations`, `messages`, `ticket_drafts`, `agent_decisions`, `handoffs`, `help_articles`.

Concorrência no console (assumir, devolver, encerrar) usa `conversations.version`
(concorrência otimista): a ação envia a versão vista e falha se outro analista agiu antes.

## Regras

Parâmetros em [`packages/shared/src/domain/rules.ts`](../packages/shared/src/domain/rules.ts).
Cada um é marcado como **[PRD]** (obrigatório pelo Anexo A) ou **[Decisão]** (escolha técnica
onde o PRD não especifica).

| Regra | Origem | Valor |
| --- | --- | --- |
| Prazo por prioridade | [PRD] | Crítica 1 h, Alta 4 h úteis, Média 3 dias úteis, Baixa 5 dias úteis |
| Crítica em horas corridas | [Decisão] | o artigo de horário cita plantão 24 h para críticos |
| Expediente para horas/dias úteis | [Decisão] | seg–sex, 8h–18h, `America/Sao_Paulo`, sem feriados |
| Janela de reabertura | [PRD] | 7 dias após a resolução |
| Limite de mensagens | [PRD] | 30 mensagens do funcionário por sessão |
| Status "aberto" para duplicidade | [Decisão] | `WAITING_ANALYST`, `IN_PROGRESS`, `APPROVED` |
| Status reabríveis | [PRD] | `RESOLVED` (dentro da janela) |
| Confiança mínima para agir | [Decisão] | 0,6; abaixo disso a regra "agent sem segurança" transfere (calibrar na P0.3) |
| Formato do código do chamado | [Decisão] | `INC-20311`, `REQ-10442` (como no Anexo B) |

As regras críticas (privacidade, confirmação, duplicidade, reabertura, prazo) são aplicadas em
código no serviço de chamados e na API. As instruções do agente
([`instructions.ts`](../packages/agent/src/instructions.ts)) orientam o modelo, mas não são a
única barreira.

## Transparência das decisões

Cada resposta do agente gera um `AgentDecision`
([`agent-decision.ts`](../packages/shared/src/domain/agent-decision.ts)): intenção entendida,
paráfrase, ação, confiança (0..1 e nível), justificativa, regras do Anexo A citadas
(`A.DUPLICIDADE`, `A.PRIORIDADE_PRAZO`…), passos executados com rótulo legível
("consultou seus chamados") e telemetria de custo (modelo, tokens, latência). A interface mostra
os passos acima da resposta e o detalhe ao expandir.

## Erros e observabilidade

- Erros HTTP têm corpo padronizado (`ApiErrorBodySchema`) e `requestId` (cabeçalho `x-request-id`).
- Logs em JSON por linha; valores de ambiente nunca aparecem em mensagens de erro.
- `GET /health` responde 503 (`degraded`) quando o banco está fora, sem vazar a string de conexão.
- O sistema de chamados "legado" fica indisponível por alguns segundos de vez em quando (PRD):
  tratamento de falha transitória entra junto com a implementação do serviço (P0.2).
