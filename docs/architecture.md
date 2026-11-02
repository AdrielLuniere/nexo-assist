# Arquitetura do Nexo Assist

Documento vivo. Descreve as fronteiras entre módulos, de onde vem cada regra e as decisões
técnicas tomadas até aqui. As fases (P0.1, P0.2, P0.3) aparecem nos comentários do código.

## Visão geral

```
apps/web  ──HTTP/SSE──▶  apps/api  ──▶  packages/agent (Mastra)
(React)                  (Express)        │ só lê por portas (AgentReadPorts)
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
| `packages/agent` | Agente Mastra: instruções, ferramentas, política determinística, execução de uma resposta | serviço de chamados, API, web, Prisma, Express |
| `apps/api` | Raiz de composição: autenticação, persistência, orquestração, streaming | — |
| `apps/web` | Chat do funcionário e console do analista | qualquer pacote interno além de `@nexo/shared` |

As fronteiras são verificadas automaticamente em [`tests/architecture.test.ts`](../tests/architecture.test.ts)
(dependências declaradas e imports). Os enums do Prisma são comparados aos de `packages/shared`
em [`tests/prisma-contracts.test.ts`](../tests/prisma-contracts.test.ts).

### Por que o agente não acessa o banco

O agente só lê por `AgentReadPorts` ([`ports.ts`](../packages/agent/src/ports.ts)). A API cria
as portas **por resposta**, já vinculadas ao funcionário autenticado
([`agent-ports.ts`](../apps/api/src/agent/agent-ports.ts)). Nenhuma ferramenta recebe `employeeId`
(argumentos extras são descartados na validação), então o modelo não consegue pedir dados de outra
pessoa, mesmo sob prompt injection. A privacidade não depende do prompt.

### Por que o agente não escreve chamados

As ferramentas de "escrita" do agente (`proposeTicketDraft`, `requestHandoff`) não gravam nada:
validam e **planejam** o efeito, que a API grava junto com a resposta (ver "Agente"). O rascunho
nasce `PENDING`; a escrita no serviço de chamados só acontece quando o funcionário confirma pela API
(`POST .../drafts/:draftId/confirm`), e o serviço exige um `confirmedDraftId`. Isso implementa a regra
"só cria ou atualiza depois da confirmação" em código.

## Persistência

PostgreSQL via Prisma 7 (driver adapter `@prisma/adapter-pg`). Esquema em
[`prisma/schema.prisma`](../prisma/schema.prisma). Conversas, mensagens, rascunhos, decisões do
agente, transferências e chamados ficam no banco, então sobrevivem a reinícios (requisito do PRD).

Propriedade das tabelas (por código, não por permissão de banco):

- serviço de chamados: `tickets`, `ticket_events`, `ticket_sequences`;
- API: `users`, `conversations`, `messages`, `ticket_drafts`, `agent_decisions`, `handoffs`, `help_articles`.

A migration inicial está em [`prisma/migrations/`](../prisma/migrations) (gerada a partir do
schema, sem conexão com o banco). Ela é aplicada com `npm run db:migrate`, sempre por decisão
explícita de quem roda; nada a aplica automaticamente.

Concorrência no console (assumir, devolver, encerrar) usa `conversations.version`
(concorrência otimista): a ação envia a versão vista e falha se outro analista agiu antes. Detalhes em
"Console do analista e transferência (P0.6)".

## Serviço de chamados (P0.2)

Implementação em [`packages/ticket-service`](../packages/ticket-service/src), que não conhece
Prisma, HTTP nem o agente. Ele depende de duas portas, implementadas em `apps/api/src/infra`:

| Porta | Para quê | Implementação real | Implementação de teste |
| --- | --- | --- | --- |
| `TicketStore` | persistência transacional | `prisma-ticket-store.ts` (PostgreSQL) | `in-memory.ts` |
| `ConfirmationGate` | "o funcionário confirmou este rascunho com este conteúdo?" | `prisma-confirmation-gate.ts` (`ticket_drafts`) | `in-memory.ts` |

Como cada requisito do PRD é garantido:

- **Confirmação obrigatória.** `create`, `addUpdate` e `reopen` consultam o `ConfirmationGate` antes
  de qualquer escrita. Ele exige rascunho `CONFIRMED`, do mesmo funcionário, da mesma conversa e com
  o mesmo conteúdo que será escrito (`draftMatchesCheck`), então o que é gravado é o que o
  funcionário viu.
- **Isolamento.** O solicitante vem de `RequesterContext` (sessão), nunca do comando. Todo acesso a
  chamado confere o dono; chamado alheio dá `FORBIDDEN` e inexistente dá `NOT_FOUND`, e a API
  responde 404 aos dois.
- **Idempotência.** O id do rascunho é a chave. Há índice único `(draftId, type)` em
  `ticket_events`: confirmações repetidas ou simultâneas colidem no banco, a transação perdedora é
  desfeita e o serviço devolve o resultado já gravado (`StoreConflictError` e releitura).
- **Sem duplicidade, sem corrida.** As escritas de um mesmo solicitante são serializadas por
  `pg_advisory_xact_lock`; a checagem de duplicidade e a criação ocorrem na mesma transação.
- **Códigos sem buracos nem repetição.** `ticket_sequences` é incrementada atomicamente na
  transação da criação; se a criação falha, o número volta.
- **Indisponibilidade do legado.** Erros transitórios do banco viram `UNAVAILABLE`
  (`mapPrismaError`). O decorador `withRetry` repete com espera crescente. Repetir é seguro por causa
  da idempotência acima, inclusive quando a falha ocorre depois de gravar e a resposta se perde.
  `withSimulatedOutages` reproduz as duas quedas nos testes.

Duplicidade ([`duplicates.ts`](../packages/ticket-service/src/duplicates.ts)): sem modelo, por
similaridade de palavras (títulos e descrição, sem acentos e sem palavras vazias), apenas entre
chamados abertos do mesmo funcionário e da mesma categoria. `findPossibleDuplicates` sugere a
partir de 0,34; `create` recusa a partir de 0,6 com `DUPLICATE_OPEN_TICKET` apontando o chamado a
atualizar. Limitação conhecida: textos muito diferentes sobre o mesmo problema não são detectados;
nesse caso a decisão fica com o agente e o funcionário.

## API HTTP e autenticação (P0.3)

Camadas em `apps/api/src`, de fora para dentro: `http/` (Express: rotas, middlewares, erros) →
serviços (`auth/`, `drafts/`, `@nexo/ticket-service`) → repositórios Prisma (`infra/`). As rotas só
traduzem HTTP; nenhuma regra do Anexo A vive nelas.

- **Identidade só no backend.** `authenticate` valida o token e carrega o usuário do banco em
  `req.user`; as rotas leem `currentUser(req)`. Nenhum `employeeId` vindo do cliente é lido em lugar
  algum, e o serviço de chamados recebe o solicitante como `RequesterContext`.
- **Duas camadas contra escrita sem confirmação.** (1) Não há rota de escrita direta. (2) Mesmo que
  houvesse, o serviço de chamados consulta o `ConfirmationGate`
  ([`draft-gate.ts`](../apps/api/src/drafts/draft-gate.ts)) antes de escrever, e ele só libera
  rascunho `CONFIRMED`, do mesmo funcionário e conversa, com o mesmo conteúdo.
- **Máquina de estados do rascunho** em [`draft-service.ts`](../apps/api/src/drafts/draft-service.ts),
  com transições compare-and-swap no banco. A idempotência reaproveita a do serviço de chamados
  (índice único em `ticket_events`) e a da mensagem de resultado (`clientMessageId` único por
  conversa). Detalhes e decisões em `docs/api-contracts.md`, seção "Confirmação de rascunhos".
- **Sessão**: token HMAC com expiração; papel relido do banco a cada requisição (ver
  `docs/api-contracts.md`, seção "Autenticação").

## Conversas e persistência do chat (P0.4)

Módulo [`apps/api/src/conversations/`](../apps/api/src/conversations): serviço
(`conversation-service.ts`), repositório (`conversation-repository.ts`, Prisma e em memória) e escritor
de mensagens (`message-writer.ts`). Usa as tabelas que já existiam (`conversations`, `messages`,
`agent_decisions`); não há estrutura paralela.

- **Uma trava por conversa.** Toda escrita em `messages` roda numa transação que começa com
  `SELECT ... FOR UPDATE` na linha da conversa. Isso dá, de uma vez: contador de mensagens e limite
  corretos sem corrida, idempotência por `clientMessageId` (checada já sob a trava) e `createdAt`
  estritamente crescente. O fluxo de rascunhos usa o mesmo escritor.
- **Esperar a trava não pode esgotar o pool.** Uma transação que espera `FOR UPDATE` ou advisory lock
  segura uma conexão. Em rajadas (40 envios simultâneos na mesma conversa) isso esgotava o pool de 10
  conexões e devolvia `503` para a maioria, mesmo com os dados corretos. `infra/write-slots.ts` limita a
  5 as transações com trava em andamento por cliente Prisma; as demais esperam em memória, sem
  conexão, e sobra pool para leituras. Vale para conversas, rascunhos e o serviço de chamados. A trava
  do banco segue sendo a garantia entre processos.
- **Dono na própria consulta.** O repositório sempre filtra por `employeeId` da sessão (inclusive na
  trava), então a conversa de outra pessoa nem chega a ser lida.
- **Estado.** `employeeCanWrite` e `agentCanRespond` (shared) decidem se grava e se o agente pode
  responder. A mudança de estado em si é do agente (transferir) e do console (assumir, devolver,
  encerrar; ver "Console do analista e transferência (P0.6)").
- **Porta do agente.** `AgentResponder` devolve eventos de streaming; a rota só a aciona para
  mensagem ainda sem resposta em conversa `WITH_AGENT`. A implementação real é da P0.5 (abaixo);
  `noAgentResponder` segue como padrão quando nenhum respondedor é injetado (testes).
- **Dado corrompido não derruba.** Blocos de mensagem que não validam são lidos como lista vazia (o
  texto da mensagem permanece).

## Agente (P0.5)

Pacote [`packages/agent`](../packages/agent/src) (Mastra, sem banco) e orquestração em
[`apps/api/src/agent/`](../apps/api/src/agent).

```
POST .../messages ou .../resume
  └─ AgentResponder (fila por conversa + teto global, com prazo de espera)
       ├─ já respondida? devolve a resposta gravada (sem modelo)
       ├─ conversa fora de WITH_AGENT? não chama o modelo
       ├─ runAgentTurn (packages/agent): Mastra + ferramentas, SÓ LEITURA
       │     ferramentas registram passos reais (TurnTrace) → agent.step em tempo real
       │     submitResponse → proposta do modelo
       │     finalizeTurn (policy.ts) → decisão final, rascunho e transferência planejados
       └─ publish (uma transação, conversa travada)
             revalida estado → rascunho PENDING + Handoff + mensagem + AgentDecision
```

**Por que nada é gravado durante a execução.** Uma resposta pode falhar em qualquer ponto (provedor,
tempo, queda do processo). Se as ferramentas gravassem rascunho ou transferência na hora, uma falha
deixaria efeitos sem a mensagem que os explica, e a retentativa duplicaria. Planejando os efeitos e
gravando tudo de uma vez: falha antes da publicação = nada gravado, mensagem pendente; publicação =
tudo ou nada. `agent_decisions.triggerMessageId` (único, migration `20261102000000`) e a trava da
conversa garantem uma publicação por mensagem, mesmo entre processos.

**Revalidação antes de publicar.** A transação confere de novo o estado da conversa. Se ela saiu de
`WITH_AGENT` durante a execução (transferida, assumida, encerrada), a resposta é descartada: o agente
nunca fala depois da transferência.

**Recuperação.** Mensagem pendente = a última mensagem do funcionário sem decisão. Aparece em
`pendingAgentResponse` e é retomada por `POST .../resume` ou pelo reenvio do mesmo
`clientMessageId`. A retomada é sob demanda (quando o funcionário volta à conversa): não há
reprocessamento automático em segundo plano, para não gastar modelo sem ninguém esperando.

**Ferramentas** ([`tools.ts`](../packages/agent/src/tools.ts)): argumentos validados por Zod (inválido
volta ao modelo como erro e ele corrige), falhas das portas viram mensagem genérica (nada interno chega
ao modelo), cada execução vira um passo com status, resumo e duração. Regras aplicadas em código:

| Ferramenta | Regra garantida em código |
| --- | --- |
| `getMyTicket` | inexistente e alheio são iguais: "não está entre os seus" (`A.PRIVACIDADE`) |
| `proposeTicketDraft` CREATE | todos os campos do Anexo A obrigatórios; prioridade **calculada** por `classifyPriority` (impacto × urgência), não escolhida pelo modelo; verificação de duplicidade automática: com chamado aberto parecido, recusa e orienta atualizar |
| `proposeTicketDraft` UPDATE | só chamado próprio e aberto; resolvido orienta reabrir |
| `proposeTicketDraft` REOPEN | só `RESOLVED` dentro de 7 dias (mesma conta do serviço de chamados) |
| `requestHandoff` | chamado relacionado precisa ser do funcionário; "chamado vencido" exige chamado de fato vencido |

O serviço de chamados repete as mesmas validações na confirmação: o agente não é a última barreira.

**Política determinística** ([`policy.ts`](../packages/agent/src/policy.ts)), aplicada a toda
resposta sobre a proposta do modelo (`submitResponse`):

1. Intenção fora de TI → `REDIRECT_OUT_OF_SCOPE`; rascunho é descartado (contradição, confiança ≤ 0,5).
2. Ação precisa de evidência: com rascunho válido a ação é a do rascunho; rascunho declarado sem
   rascunho, "central de ajuda" sem artigo encontrado ou cards sem chamados consultados viram `REPLY`
   com confiança limitada a 0,7.
3. Cards e seleção só com chamados devolvidos pelas ferramentas nesta resposta (outros são omitidos).
4. Transferência obrigatória (se o modelo não fez, a política faz e acrescenta um aviso ao texto):
   pedido do funcionário (`TALK_TO_ANALYST`), rascunho com prioridade Crítica, confiança final < 0,6.
5. Chamado vencido exibido sem transferência → opção rápida "Chamar um analista" (Tela 3).

Cada correção entra na justificativa ("Ajustes automáticos: ...") e as regras aplicadas em `ruleRefs`
(as citadas pelo modelo só entram se existirem).

**Critérios de confiança.** O modelo estima a confiança na **ação** com uma escala nas instruções
(≥ 0,9 pedido claro e confirmado pelas ferramentas; 0,7–0,89 com suposição razoável; 0,6–0,69
ambiguidade com ação segura, como perguntar; < 0,6 não sabe o que fazer). A política só reduz (nunca
aumenta) e o nível é derivado: `HIGH` ≥ 0,8, `MEDIUM` ≥ 0,6, `LOW` abaixo, que transfere.
Perguntar o que falta é uma ação segura; por isso falta de informação não gera transferência.

**Explicabilidade sem raciocínio privado.** A decisão registra o que o modelo entregou como
justificativa objetiva (1–2 frases) e os fatos das ferramentas; não pedimos nem guardamos cadeia de
raciocínio. Os passos exibidos vêm do que rodou de fato, não do texto do modelo.

**Modelo e custo.** `AGENT_MODEL` (`provedor/modelo`, model router do Mastra; padrão sugerido
`anthropic/claude-haiku-5-5`), chave na variável do provedor. Por resposta: `toolChoice: required` (toda
etapa termina em ferramenta; texto solto não é resposta), até 6 chamadas ao modelo, 8 ferramentas,
1.500 tokens de saída por chamada, 1 retentativa do provedor, 45 s no total, últimas 24 mensagens de
histórico. Memória do Mastra não é usada: o histórico vem do banco, a fonte de verdade.

**Concorrência.** Uma resposta por conversa de cada vez (na ordem) e até `AGENT_MAX_CONCURRENCY` (4)
respostas simultâneas por processo; esperar mais de 20 s numa dessas filas, ou mais de 10 s pelas
vagas de escrita no banco, desiste com 503 repetível (`BusyError`) em vez de acumular requisições. A
execução não depende da conexão: se o cliente sai, a resposta é gravada mesmo assim.

**Limitações conhecidas.**

- Sem streaming do texto (`agent.delta`): a resposta é estruturada e chega inteira; o tempo real
  está nos passos.
- Sem resumo de conversas longas (`conversations.summary` não é usado); a janela de 24 mensagens
  cobre a sessão de 30 mensagens na prática.
- Busca na central de ajuda por palavras (sem sinônimos ou semântica).
- A qualidade da classificação (intenção, tipo, categoria, urgência) depende do modelo; as regras de
  segurança e o cálculo de prioridade não. A avaliação com o modelo real (`npm run test:live`) existe,
  mas não roda sem chave.

## Console do analista e transferência (P0.6)

Código em [`apps/api/src/console/`](../apps/api/src/console) (regras, repositório, serviço), rotas em
`http/routes/console.ts` e `http/routes/events.ts`. Contrato em [api-contracts.md](api-contracts.md).

```
agente transfere ─▶ WAITING_ANALYST ─assume─▶ WITH_ANALYST ─return─▶ WITH_AGENT (pode transferir de novo)
(Handoff WAITING)   (fila do console)  (ASSUMED, responsável)   │     (RETURNED_TO_AGENT)
                          │                                     └─close─▶ CLOSED (Handoff CLOSED)
                          └─close (qualquer analista)─▶ CLOSED
```

**Quem pode o quê.** `requireAnalyst` (papel `ANALYST` **e** nível N1/N2, lidos do banco a cada
requisição). N1 e N2 têm as mesmas permissões: o PRD fala em "Suporte N1 e N2", mas não atribui poderes
diferentes, e inventar uma hierarquia seria ampliar o escopo. Quem assume é o **responsável**: só ele
responde, devolve ou encerra a conversa em atendimento. Qualquer analista pode encerrar uma conversa
que ainda aguarda (ninguém é responsável). O console só vê conversas com ao menos uma transferência.

**Regras puras, uma só decisão.** [`console-rules.ts`](../apps/api/src/console/console-rules.ts)
decide cada ação (`apply`, `replay`, `not_owner`, `stale`, `invalid_state`) sem acessar dados; o
repositório PostgreSQL e o em memória aplicam exatamente essa decisão. Ordem: responsável → versão →
estado. Teste em tabela em `console-rules.test.ts`.

**Concorrência.** Toda alteração acontece numa transação que trava a linha da conversa
(`SELECT ... FOR UPDATE`, a mesma trava das mensagens do funcionário e da publicação do agente) e
confere `expectedVersion` já com a trava. Assim, dois analistas assumindo, assumir × encerrar, mensagem
do analista × devolução, mensagem do funcionário × transferência pelo agente e qualquer outra mistura
são serializados pelo banco, também entre processos. Mutação confirmada: sem a trava, a disputa entre
N1 e N2 passa a ter mais de um vencedor (o teste falha). `version` só muda em transições, nunca em
mensagens.

**O agente e a versão.** A publicação do agente compara a `version` da conversa com a que existia
quando o histórico foi lido. Antes só o *status* era revalidado; agora, se a conversa passou por
qualquer transição durante a execução (inclusive assumir + devolver, que a deixa de novo em
`WITH_AGENT`), a resposta é descartada sem gravar nada e a mensagem fica pendente para a retomada,
que roda com o contexto atual. Mutação confirmada: sem essa comparação o teste do cenário publica a
resposta de um contexto que já não vale.

**Resposta pendente e atendimento humano.** `pendingAgentResponse` é a última mensagem do funcionário
sem decisão **e sem mensagem de analista depois dela**. Sem essa segunda condição, ao devolver a
conversa o agente "responderia de novo" algo que o analista já tratou. Se o funcionário escreveu com o
analista e ninguém respondeu antes da devolução, a mensagem continua pendente e o agente a atende. Essa
é uma decisão de comportamento (o PRD não a especifica): documentada aqui e testada.

**Eventos para o funcionário.** [`conversation-events.ts`](../apps/api/src/conversations/conversation-events.ts)
é um barramento em memória por conversa. Console publica **depois** de gravar. O stream
(`GET .../events`) assina antes de ler o banco, envia estado + mensagens perdidas (por `Last-Event-ID`
ou `?after=`) + o que chegou no meio, sem repetir. Perder um evento (queda, reinício) nunca deixa a
tela errada: a reconexão reconstrói do PostgreSQL. Há keep-alive, limite de 5 conexões por funcionário
e fechamento ordenado no encerramento da API.

**Privacidade.** Funcionário não entra no console (403); a conversa de outro funcionário e a que nunca
foi transferida são 404 indistinguíveis de inexistente; o stream de eventos só serve ao dono; o painel
de chamados vem de `conversation.employeeId` (servidor), nunca de parâmetro; nenhum identificador de
analista ou papel é lido do corpo, cabeçalhos ou URL; o token não aparece em respostas, URLs nem logs.
O console não escreve em chamados (nenhuma rota do console usa o serviço de chamados além de listar).

**Decisões e limitações.**

- Ordem da fila: atividade mais recente primeiro (`updatedAt`); não há prioridade por urgência nem
  SLA de atendimento humano (fora do PRD).
- A busca ignora maiúsculas, mas não acentos (`ILIKE`); `%` e `_` são literais.
- Entrega ao vivo por processo. Com mais de uma instância da API, os eventos ao vivo só chegam a quem
  está conectado à instância que gravou; a recuperação por banco cobre o resto (LISTEN/NOTIFY resolveria).
- O pedido direto de analista (`POST .../handoff`, P0.6-A) vive em `conversations/handoff-request.ts`: mesma trava de linha, sem LLM, idempotente (ver api-contracts.md).
- O funcionário vê o `authorId` do analista, não o nome (o contrato de mensagem não tem nome).
- Rascunhos pendentes continuam confirmáveis pelo funcionário enquanto a conversa não está encerrada
  (regra da P0.3, inalterada).
- Se o sistema de chamados estiver fora, o detalhe do console responde 503 repetível (o painel é parte
  do contrato do detalhe).

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
| Confiança mínima para agir | [Decisão] | 0,6; abaixo disso a regra "agent sem segurança" transfere automaticamente (P0.5) |
| Caso crítico | [PRD] | rascunho com prioridade Crítica transfere para analista na mesma resposta |
| Chamado vencido | [Decisão] | do protótipo (Tela 3): o agente **oferece** chamar um analista; transfere se o funcionário aceitar |
| Rascunhos pendentes | [Decisão] | no máximo um por conversa; um novo marca o anterior como `SUPERSEDED` |
| Formato do código do chamado | [Decisão] | `INC-20311`, `REQ-10442` (como no Anexo B) |
| Classificação de prioridade | [Decisão] | `classifyPriority`: bloqueado + equipe/empresa = Crítica; bloqueado + 1 pessoa ou compromisso no dia = Alta; com alternativa = Média; sem urgência = Baixa |
| Crítica exige equipe ou empresa | [Decisão] | do Anexo A ("parado para uma equipe ou para a empresa"); o serviço recusa Crítica para 1 pessoa |
| Prazo reinicia a cada atualização | [Decisão] | do Anexo A ("cada atualização"); chamado já vencido mantém o prazo vencido, para a atualização não esconder o atraso |
| Reabertura | [Decisão] | só `RESOLVED`, até 7 dias × 24 h após `resolvedAt` (limite inclusivo); volta a `WAITING_ANALYST` com novo prazo |
| Atualizar chamado resolvido ou fechado | [Decisão] | recusado (`INVALID_STATUS`); o caminho é reabrir |

As regras críticas (privacidade, confirmação, duplicidade, reabertura, prazo) são aplicadas em
código no serviço de chamados e na API. As instruções do agente
([`instructions.ts`](../packages/agent/src/instructions.ts)) orientam o modelo, mas não são a
única barreira.

## Transparência das decisões

Cada resposta do agente gera um `AgentDecision`
([`agent-decision.ts`](../packages/shared/src/domain/agent-decision.ts)), gravado com a mensagem e
ligado a ela (`messageId`) e à mensagem do funcionário que a disparou (`triggerMessageId`): intenção
entendida, paráfrase, ação, confiança (0..1 e nível), justificativa, regras do Anexo A aplicadas
(`A.DUPLICIDADE`, `A.PRIORIDADE_PRAZO`…), passos executados com rótulo legível ("consultou seus
chamados"), status, resumo do resultado e duração, e telemetria (modelo, tokens de entrada e saída,
latência). Exemplo real, gerado pelo agente com o provedor simulado (por isso o `model`):

```json
{
  "intent": "CHECK_TICKET_STATUS",
  "understanding": "Quer saber do chamado do notebook lento.",
  "action": "SHOW_TICKETS",
  "confidence": 0.92,
  "confidenceLevel": "HIGH",
  "rationale": "A consulta mostrou o INC-20311 aguardando analista e vencido.",
  "ruleRefs": ["A.TRANSFERENCIA", "A.PRIORIDADE_PRAZO"],
  "steps": [
    { "kind": "listMyTickets", "label": "consultou seus chamados", "status": "OK",
      "summary": "2 chamado(s): INC-20311, REQ-10442; 1 com prazo vencido.", "durationMs": 1 }
  ],
  "model": "teste/roteirizado", "inputTokens": 240, "outputTokens": 60, "latencyMs": 383
}
```

A resposta desse exemplo também ganhou, pela política, a opção rápida "Chamar um analista" (chamado
vencido). A interface (fase futura) mostra os passos acima da resposta e o detalhe ao expandir.

## Erros e observabilidade

- Erros HTTP têm corpo padronizado (`ApiErrorBodySchema`) e `requestId` (cabeçalho `x-request-id`).
- Logs em JSON por linha; valores de ambiente nunca aparecem em mensagens de erro.
- `GET /health` responde 503 (`degraded`) quando o banco está fora, sem vazar a string de conexão.
- O sistema de chamados "legado" fica indisponível por alguns segundos de vez em quando (PRD):
  tratado com `UNAVAILABLE`, `withRetry` e escritas idempotentes (ver "Serviço de chamados").
  Esgotadas as tentativas, a API (planejada) responde 503 `TICKET_SERVICE_UNAVAILABLE` (retryable).

## Testes

- `npm test`: unitários, de arquitetura e HTTP, sem banco (serviços sobre repositórios em memória).
  Inclui o agente: o Mastra roda de verdade com um **provedor de LLM simulado**
  ([`scripted-model.ts`](../packages/agent/src/testing/scripted-model.ts), exportado como
  `@nexo/agent/testing`), que implementa a interface de modelo do AI SDK e devolve chamadas de
  ferramenta roteirizadas. Ferramentas, validação, política, limites e telemetria são o código real.
- Os testes de API usam um cliente fino sobre `fetch` ([`tests/helpers/http.ts`](../tests/helpers/http.ts),
  mesma sintaxe do supertest) e servem cada app em um único servidor (`serve` em
  `tests/helpers/api-harness.ts`).
- **Limitação conhecida do ambiente (Windows).** O worker do Vitest às vezes é encerrado pelo sistema
  com código nativo `0xC0000409` ("Worker exited unexpectedly"), sem erro de JavaScript nem falha de
  asserção. Medido nesta máquina: supertest + um Express vazio caía em 5 de 40 execuções; com `fetch`,
  o mesmo volume caiu em 0 de 40; a suíte completa atual fecha limpa em ~96% das execuções (24/25).
  Não é uma falha dos testes nem da API: basta rodar de novo. Se aparecer em CI, rode em Linux.
  **P0.6, medido:** com o arquivo `api-console.test.ts` (51 testes, vários streams SSE) a taxa subiu: 3
  quedas em 11 execuções completas de `npm test`; isolado, 2/12 (arquivo inteiro), 0/12 (só os testes de
  SSE) e 1/12 (tudo menos SSE). Houve ainda 1 queda em `console.integration.test.ts` (`test:db`). Em
  nenhuma delas houve falha de asserção, e em nenhuma o Linux caiu (3 execuções de `npm test` e 2 de
  `test:db` em container). A causa **não é conhecida**: o recorte por SSE não a explica, e as amostras
  são pequenas. Uma queda deixa banco descartável órfão (`nexo_test_*`), que pode ser removido.
- `npm run test:db`: integração com PostgreSQL real (serviço de chamados, API e conversas), com os
  arquivos em sequência (`fileParallelism: false`): em paralelo, a disputa por CPU e conexões no mesmo
  servidor gerava timeouts e quedas de worker alheios ao código. Cada
  arquivo cria um banco descartável
  (`nexo_test_<aleatório>`) no servidor local, aplica a migration nele com `prisma migrate deploy`,
  roda o seed e remove o banco ao final. O banco do `.env` nunca é tocado.
  [`agent.integration.test.ts`](../tests/agent.integration.test.ts) cobre o agente de ponta a ponta
  (rota SSE, ferramentas sobre o seed, publicação, confirmação, recuperação, retomadas simultâneas em
  dois "processos", transferência e descarte após assumir).
  [`console.integration.test.ts`](../tests/console.integration.test.ts) cobre o console sobre
  PostgreSQL: o fluxo completo com o agente real (pedido → fila → assumir → atender → devolver → agente
  volta → nova transferência → encerrar), disputas em rajada entre N1 e N2, assumir × encerrar,
  mensagens × devolução, `clientMessageId` repetido, agente × transferência, o cenário assumir +
  devolver durante a execução do modelo, reinício da aplicação, reconexão do stream, busca com `%`/`_`,
  paginação e privacidade. [`api-console.test.ts`](../tests/api-console.test.ts) cobre a mesma API em
  memória (autorização, validação, N1/N2, eventos); `console-rules.test.ts`, a tabela de decisões.
- `npm run test:live`: cenários do PRD contra o modelo **real**; fora das outras suítes e só com
  `AGENT_LIVE_TEST=1`, `AGENT_MODEL` e a chave do provedor. Nenhum teste automatizado usa credencial real.
- CI em Linux: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) roda typecheck, `npm test`,
  build e `test:db` com PostgreSQL 17 do próprio job.

