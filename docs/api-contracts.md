# Contratos da API

A fonte da verdade é [`packages/shared/src/api/contracts.ts`](../packages/shared/src/api/contracts.ts):
schemas Zod usados pela API (validação) e pela web (parsing). Este documento é o resumo legível.

- Rotas de negócio ficam sob `/api`.
- Autenticação: `Authorization: Bearer <token>` (formato do token definido na P0.2).
- Privacidade: `/api/tickets` e `/api/conversations` sempre filtram pelo funcionário autenticado;
  o dono nunca vem do cliente nem do modelo. Chamado de outra pessoa responde 404, não 403.
- Erros: corpo `ApiErrorBody` com `requestId`.

## Rotas

| Método | Caminho | Acesso | Resposta | Status | Descrição |
| --- | --- | --- | --- | --- | --- |
| GET | `/health` | público | JSON | implementada | Saúde da API e do banco (200 ou 503) |
| POST | `/api/auth/login` | público | JSON | planejada | Login com e-mail corporativo (Tela 1) |
| GET | `/api/auth/me` | funcionário | JSON | planejada | Usuário autenticado |
| GET | `/api/conversations` | funcionário | JSON | planejada | Conversas do funcionário (continuar de onde parou) |
| POST | `/api/conversations` | funcionário | JSON | planejada | Nova conversa |
| GET | `/api/conversations/:conversationId` | funcionário | JSON | planejada | Histórico com decisões do agente |
| POST | `/api/conversations/:conversationId/messages` | funcionário | SSE | planejada | Envia mensagem; resposta em streaming |
| GET | `/api/conversations/:conversationId/events` | funcionário | SSE | planejada | Mensagens do analista e mudanças de estado |
| POST | `/api/conversations/:conversationId/drafts/:draftId/confirm` | funcionário | JSON | planejada | Confirma o rascunho e escreve no serviço de chamados (idempotente) |
| POST | `/api/conversations/:conversationId/drafts/:draftId/discard` | funcionário | JSON | planejada | Descarta o rascunho |
| POST | `/api/conversations/:conversationId/handoff` | funcionário | JSON | planejada | Pede um analista |
| GET | `/api/tickets` | funcionário | JSON | planejada | Chamados do funcionário |
| GET | `/api/tickets/:ticketCode` | funcionário | JSON | planejada | Detalhe de um chamado próprio |
| GET | `/api/console/conversations` | analista | JSON | planejada | Lista com filtros e status (Telas 4 e 5) |
| GET | `/api/console/conversations/:conversationId` | analista | JSON | planejada | Histórico, transferências e chamados do funcionário |
| POST | `/api/console/conversations/:conversationId/assume` | analista | JSON | planejada | Assume; agente pausado |
| POST | `/api/console/conversations/:conversationId/return` | analista | JSON | planejada | Devolve ao agente |
| POST | `/api/console/conversations/:conversationId/close` | analista | JSON | planejada | Encerra |
| POST | `/api/console/conversations/:conversationId/messages` | analista | JSON | planejada | Mensagem do analista |

O teste [`contracts.test.ts`](../packages/shared/src/api/contracts.test.ts) garante que o status
"implementada" corresponde ao que a API de fato expõe.

## Streaming (SSE)

`POST /api/conversations/:id/messages` emite `ChatStreamEvent`, na ordem típica:

```
message.accepted → agent.step* → agent.delta* → agent.message → done
```

- `agent.step`: cada passo do agente ("consultou seus chamados"), para a interface mostrar acima da resposta.
- `agent.delta`: pedaços do texto da resposta.
- `agent.message`: mensagem final com o `AgentDecision` completo.
- `conversation.status`: a conversa mudou de estado (ex.: transferida).
- `error`: falha com `ApiErrorBody`.

`GET /api/conversations/:id/events` emite `ConversationEvent` (`message.created`,
`conversation.status`) enquanto a conversa está com um analista.

## Estados da conversa

```
WITH_AGENT ──handoff──▶ WAITING_ANALYST ──assume──▶ WITH_ANALYST ──return──▶ WITH_AGENT
                                                        │
                                                        └──close──▶ CLOSED
```

Em `WAITING_ANALYST` e `WITH_ANALYST` o agente não responde. As ações do console enviam
`expectedVersion` (concorrência otimista).

## Idempotência

- Mensagens: `clientMessageId` (UUID gerado pelo cliente); reenvio não duplica.
- Confirmação de rascunho: confirmar duas vezes devolve o mesmo chamado.
