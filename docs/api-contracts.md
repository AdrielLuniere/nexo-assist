# Contratos da API

A fonte da verdade é [`packages/shared/src/api/contracts.ts`](../packages/shared/src/api/contracts.ts):
schemas Zod usados pela API (validação) e pela web (parsing). Este documento é o resumo legível.

- Rotas de negócio ficam sob `/api`.
- Autenticação: `Authorization: Bearer <token>`; o token é emitido por `/api/auth/login` (ver "Autenticação").
- Privacidade: `/api/tickets` e `/api/conversations` sempre filtram pelo funcionário autenticado;
  o dono nunca vem do cliente nem do modelo. Chamado de outra pessoa responde 404, não 403.
- Erros: corpo `ApiErrorBody` com `requestId`.

## Rotas

| Método | Caminho | Acesso | Resposta | Status | Descrição |
| --- | --- | --- | --- | --- | --- |
| GET | `/health` | público | JSON | implementada | Saúde da API e do banco (200 ou 503) |
| POST | `/api/auth/login` | público | JSON | **implementada** | Login com e-mail corporativo (Tela 1) |
| GET | `/api/auth/me` | qualquer usuário logado | JSON | **implementada** | Usuário autenticado (funcionário ou analista) |
| GET | `/api/conversations` | funcionário | JSON | **implementada** | Conversas do funcionário (continuar de onde parou) |
| POST | `/api/conversations` | funcionário | JSON | **implementada** | Nova conversa |
| GET | `/api/conversations/:conversationId` | funcionário | JSON | **implementada** | Histórico com decisões do agente |
| POST | `/api/conversations/:conversationId/messages` | funcionário | SSE | **implementada** | Grava a mensagem e transmite a resposta do agente |
| POST | `/api/conversations/:conversationId/resume` | funcionário | SSE | **implementada** | Retoma a resposta pendente do agente (idempotente) |
| GET | `/api/conversations/:conversationId/events` | funcionário | SSE | planejada | Mensagens do analista e mudanças de estado |
| POST | `/api/conversations/:conversationId/drafts/:draftId/confirm` | funcionário | JSON | **implementada** | Confirma o rascunho e escreve no serviço de chamados (idempotente) |
| POST | `/api/conversations/:conversationId/drafts/:draftId/discard` | funcionário | JSON | **implementada** | Descarta o rascunho |
| POST | `/api/conversations/:conversationId/handoff` | funcionário | JSON | planejada | Pede um analista |
| GET | `/api/tickets` | funcionário | JSON | **implementada** | Chamados do funcionário |
| GET | `/api/tickets/:ticketCode` | funcionário | JSON | **implementada** | Detalhe de um chamado próprio |
| GET | `/api/console/conversations` | analista | JSON | planejada | Lista com filtros e status (Telas 4 e 5) |
| GET | `/api/console/conversations/:conversationId` | analista | JSON | planejada | Histórico, transferências e chamados do funcionário |
| POST | `/api/console/conversations/:conversationId/assume` | analista | JSON | planejada | Assume; agente pausado |
| POST | `/api/console/conversations/:conversationId/return` | analista | JSON | planejada | Devolve ao agente |
| POST | `/api/console/conversations/:conversationId/close` | analista | JSON | planejada | Encerra |
| POST | `/api/console/conversations/:conversationId/messages` | analista | JSON | planejada | Mensagem do analista |

Continuam **planejadas**: `GET /api/conversations/:id/events` (mensagens do analista), a rota em que o
funcionário pede um analista diretamente (`POST .../handoff`) e todo o console do analista. A
transferência **pelo agente** já existe (ver "Transferência"). A consulta de duplicidades não é uma
rota: é a ferramenta `findDuplicateTickets` do agente, sobre `findPossibleDuplicates` do serviço; a
criação também recusa duplicados (`DUPLICATE_TICKET`).

Não existe rota de escrita direta de chamados (`POST/PUT/PATCH/DELETE /api/tickets`): chamados só
são criados, atualizados ou reabertos pela confirmação de um rascunho.

## Conversas e mensagens

Todas as rotas são de funcionário (analista recebe `403`) e só enxergam conversas do usuário da
sessão. Conversa inexistente e conversa de outra pessoa respondem o **mesmo** `404`; nenhum
identificador de funcionário, papel ou autor vindo do cliente é lido.

- `GET /api/conversations` devolve `{ items: ConversationSummary[] }`, da mais recente para a mais
  antiga (por `lastMessageAt`; conversas sem mensagens por último), no máximo 100.
- `POST /api/conversations` devolve `{ conversation }` (`ConversationDetail`). Responde `201` ao criar
  e `200` quando já existia uma conversa **vazia** do funcionário, que é reaproveitada: duplo clique
  ou duas abas não geram conversas vazias duplicadas.
- `GET /api/conversations/:id` devolve a conversa com todas as mensagens (em ordem de envio) e as
  decisões do agente. É o que permite "voltar outro dia e continuar de onde parou".
  `pendingAgentResponse` (`{ messageId }` ou `null`) indica a última mensagem do funcionário ainda sem
  resposta do agente; só existe com a conversa em `WITH_AGENT`.
- O título da conversa é a primeira mensagem do funcionário (até 60 caracteres, sem IA).

### Enviar mensagem (`POST .../messages`)

Corpo: `{ content, clientMessageId }` (texto de 1 a 2000 caracteres após `trim`; `clientMessageId` é
um UUID gerado pelo cliente).

Tudo que pode falhar é decidido **antes** de abrir o stream, então vira um erro JSON comum:

| Situação | Resposta |
| --- | --- |
| corpo inválido | `400 VALIDATION_ERROR` |
| conversa inexistente ou de outra pessoa | `404 NOT_FOUND` |
| conversa encerrada | `409 INVALID_STATE_TRANSITION` |
| 31ª mensagem do funcionário na conversa | `429 MESSAGE_LIMIT_REACHED` |

Se a mensagem é aceita, a resposta é `text/event-stream` com eventos `ChatStreamEvent`:

```
message.accepted → [conversation.status] → [agent.step* → agent.message → [conversation.status]] → [error] → done
```

- `message.accepted` traz a mensagem gravada (a do funcionário, com `id` e `createdAt` do servidor).
- `conversation.status` só aparece quando a conversa **não** está com o agente (`WAITING_ANALYST` ou
  `WITH_ANALYST`): a mensagem é gravada para o analista ler, o agente não responde, e a interface
  fica sabendo.
- Os eventos do agente só existem quando o agente responde: conversa `WITH_AGENT` e mensagem ainda
  sem resposta. `agent.step` chega a cada ferramenta concluída; `agent.message` traz a mensagem do
  agente e a decisão (`AgentDecision`) já gravadas. Se o agente transferiu a conversa, segue um
  `conversation.status` com `WAITING_ANALYST`. Cada evento é validado contra o contrato antes de sair.
- Falha do agente depois de aberto o stream vira o evento `error` seguido de `done`, sem detalhes
  internos: `AGENT_UNAVAILABLE` (modelo indisponível, tempo esgotado, resposta inválida, agente não
  configurado ou fila cheia) ou `DATABASE_UNAVAILABLE`, ambos repetíveis. A mensagem do funcionário
  continua gravada e fica **pendente** (ver "Retomar resposta pendente").
- Se o cliente desconecta no meio, a resposta termina e é gravada mesmo assim; aparece ao reabrir.

Regras garantidas no servidor:

- **Idempotência por `clientMessageId`** (único por conversa). Reenviar devolve a mensagem original,
  com o texto original (mesmo que o novo texto seja diferente), sem consumir o limite. O agente só é
  acionado de novo se aquela mensagem ainda for a resposta pendente (é a retomada); mensagem já
  respondida, ou que não é a última do funcionário, não aciona nada. O mesmo `clientMessageId` em
  outra conversa, ou de outro funcionário, é uma mensagem nova.
- **Limite de 30 mensagens do funcionário por conversa** ("sessão" = conversa). Vale sob concorrência:
  40 envios simultâneos aceitam exatamente 30. Mensagens do agente e do analista não contam.
- **Ordenação estável:** as escritas de uma conversa são serializadas e `createdAt` é estritamente
  crescente dentro dela, mesmo com relógio parado ou escritas simultâneas (inclusive a mensagem de
  resultado de um rascunho). O histórico é lido por `createdAt`.
- O funcionário pode escrever enquanto a conversa não está encerrada, inclusive durante o
  atendimento humano.

## Autenticação

Demonstrativa, conforme o PRD (Tela 1): vale o e-mail de um usuário dos dados de exemplo com
**qualquer senha não vazia**. Não há senha armazenada nem autenticação corporativa real.

- `POST /api/auth/login` recebe `{ email, password }` e devolve `{ token, expiresAt, user }`. O e-mail
  ignora caixa. E-mail desconhecido e senha só com espaços recebem a mesma resposta (`401
  INVALID_CREDENTIALS`), sem dizer qual dado falhou.
- O token é assinado com HMAC-SHA256 (`AUTH_SECRET`) e expira em `AUTH_SESSION_TTL_MINUTES` (padrão
  8 h). Ele carrega apenas o id do usuário e as datas; **papel e nível não viajam no token**: a cada
  requisição o usuário é relido do banco, então rebaixar ou remover alguém vale na hora.
- Papéis: `EMPLOYEE` e `ANALYST` (níveis N1/N2). Rotas de funcionário respondem `403 FORBIDDEN` a
  analistas. As rotas do console (planejadas) usarão `requireRole('ANALYST')`, já testado.
- Sem token, token malformado, adulterado ou de usuário removido: `401 UNAUTHENTICATED` com
  `WWW-Authenticate: Bearer`. Token vencido: o mesmo código, com mensagem de sessão expirada.

## Confirmação de rascunhos

`POST .../drafts/:draftId/confirm` e `.../discard`:

- O rascunho, a conversa e o usuário da sessão precisam coincidir. Qualquer divergência (rascunho de
  outra pessoa, conversa errada, id inexistente) responde o **mesmo** `404`. Nada do corpo, da query
  ou de cabeçalhos é usado para identificar o funcionário.
- Estados: `PENDING → CONFIRMED` (confirmar) ou `PENDING → DISCARDED` (descartar). Descartar um
  rascunho já descartado é idempotente; descartar um confirmado, ou confirmar um descartado,
  responde `409 DRAFT_NOT_PENDING`. Conversa encerrada responde `409 INVALID_STATE_TRANSITION`.
- A passagem a `CONFIRMED` é atômica (compare-and-swap): em confirmações simultâneas só uma
  transita, e todas recebem o mesmo chamado e a mesma mensagem.
- **Falha entre marcar e efetivar:** confirmar de novo um rascunho `CONFIRMED` reexecuta a operação,
  que é idempotente no serviço de chamados (chave = id do rascunho). Se o chamado já tinha sido
  gravado e só a resposta se perdeu, nada é duplicado.
- **Recusa de negócio** (duplicidade, janela de reabertura, status incompatível): o rascunho volta a
  `PENDING`, porque nada foi escrito, e a resposta traz o erro. **Falha transitória ou inesperada**
  mantém `CONFIRMED` para a retentativa concluir.
- A resposta é `DraftConfirmationResponse`: rascunho, chamado e a mensagem do agente registrada na
  conversa (idempotente por rascunho).

## Erros

Mapeamento dos erros do serviço de chamados (`TicketServiceError`) para a API:

| Serviço | API | HTTP |
| --- | --- | --- |
| `NOT_FOUND`, `FORBIDDEN` | `NOT_FOUND` (não revela que o chamado existe) | 404 |
| `DUPLICATE_OPEN_TICKET` | `DUPLICATE_TICKET` | 409 |
| `REOPEN_WINDOW_EXPIRED` | `REOPEN_WINDOW_EXPIRED` | 422 |
| `INVALID_STATUS` | `CONFLICT` | 409 |
| `CONFIRMATION_REQUIRED` | `DRAFT_NOT_PENDING` | 409 |
| `INVALID_INPUT` | `VALIDATION_ERROR` | 400 |
| `UNAVAILABLE` (após as tentativas) | `TICKET_SERVICE_UNAVAILABLE` | 503 |

### Retomar resposta pendente (`POST .../resume`)

Se a mensagem foi gravada mas o agente não respondeu (provedor fora, tempo esgotado, servidor
reiniciado), `GET /api/conversations/:id` mostra `pendingAgentResponse`. `POST
/api/conversations/:id/resume` (sem corpo) abre o mesmo stream de `messages`, sem `message.accepted`:

- com pendência: o agente responde à última mensagem do funcionário;
- já respondida (ex.: outra aba retomou antes): devolve a resposta gravada, sem chamar o modelo;
- sem pendência: só `done`; conversa fora do agente: `conversation.status` e `done`.

Conversa inexistente ou de outra pessoa: `404` antes de abrir o stream; analista: `403`.

**Sem duplicar.** O agente não grava nada enquanto executa; tudo (mensagem, decisão, rascunho,
transferência) é gravado numa única transação, com a conversa travada e no máximo uma decisão por
mensagem do funcionário (`agent_decisions.triggerMessageId` é único). Retomadas simultâneas, inclusive
em processos diferentes, publicam uma única resposta; as demais devolvem a mesma.

### Transferência

O agente transfere quando o funcionário pede, em caso crítico, em chamado vencido (a pedido) ou com
confiança abaixo de 0,6. Na mesma transação da resposta: cria o `Handoff` (`WAITING`, com o resumo do
caso), leva a conversa para `WAITING_ANALYST` (incrementa `version`) e a mensagem do agente traz o bloco
`handoff_notice`. A partir daí o agente não responde; as mensagens do funcionário são gravadas para o
analista. Se a conversa sai de `WITH_AGENT` **durante** a execução (ex.: um analista assume), a resposta
é descartada na publicação e o stream informa o novo estado. Assumir, devolver e encerrar são do
console (planejado).

### Rascunhos propostos pelo agente

O rascunho chega no bloco `draft` da mensagem do agente, com status `PENDING`. Um novo rascunho na
mesma conversa marca o pendente anterior como `SUPERSEDED` (no máximo um pendente por conversa).
Confirmar ou descartar segue em "Confirmação de rascunhos".

Banco inacessível fora do serviço de chamados (login, rascunhos) responde `503
DATABASE_UNAVAILABLE`. Respostas 503 repetíveis trazem `Retry-After`. Erros inesperados viram
`500 INTERNAL_ERROR` genérico; detalhes, SQL e credenciais só vão para o log do servidor, que não
registra tokens nem senhas. Respostas autenticadas e de erro levam `Cache-Control: no-store`.

O teste [`contracts.test.ts`](../packages/shared/src/api/contracts.test.ts) garante que o status
"implementada" corresponde ao que a API de fato expõe.

## Streaming (SSE)

`POST /api/conversations/:id/messages` e `.../resume` emitem `ChatStreamEvent`, na ordem típica:

```
message.accepted → agent.step* → agent.message → [conversation.status] → done
```

- `agent.step`: cada passo do agente ("consultou seus chamados"), com status (`OK`, `ERROR`,
  `SKIPPED`), resumo do resultado e duração, para a interface mostrar acima da resposta.
- `agent.delta`: previsto no contrato, **não emitido** hoje: o texto chega inteiro em `agent.message`
  (a resposta é estruturada; o tempo real fica nos passos).
- `agent.message`: mensagem final com o `AgentDecision` completo, ambos já gravados.
- `conversation.status`: a conversa mudou de estado (ex.: transferida) ou não está com o agente.
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
- Respostas do agente: uma decisão por mensagem do funcionário (`triggerMessageId` único); retomar ou
  reenviar não duplica mensagem, rascunho nem transferência.
- Confirmação de rascunho: confirmar duas vezes devolve o mesmo chamado.
