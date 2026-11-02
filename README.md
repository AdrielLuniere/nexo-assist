# Nexo Assist

Agente de IA para o service desk de TI da Nexo (desafio técnico). O funcionário descreve o
problema no chat; o agente consulta os chamados dele, busca na central de ajuda, prepara
chamados para confirmação e chama um analista quando precisa.

> **Status: P0.8 (homologação: validação no navegador real e avaliação do agente).**
>
> | Implementado | Planejado |
> | --- | --- |
> | Monorepo, contratos, fronteiras entre pacotes, `GET /health`, migrations e seed de exemplo | Deploy |
> | Serviço de chamados (consultar, criar, atualizar, reabrir) com confirmação, duplicidade, prazos, isolamento, idempotência e retentativas | |
> | Persistência em PostgreSQL de chamados, conversas, mensagens, decisões, rascunhos e transferências | |
> | Login demonstrativo com sessão assinada e papéis (funcionário, analista N1/N2) | |
> | Conversas: criar, listar, histórico, enviar mensagem (SSE) com idempotência, limite de 30 e agente pausado | |
> | **Agente Mastra** respondendo no stream: central de ajuda, chamados do funcionário, duplicidade, rascunhos (abrir, atualizar, reabrir) e transferência para analista | |
> | **Decisão registrada por resposta**: intenção, entendimento, ação, confiança, justificativa, regras, ferramentas executadas, modelo, tokens e latência | |
> | **Recuperação de resposta pendente** (`POST .../resume`) e publicação idempotente | |
> | **Console do analista** (`/api/console/*`): fila de transferidas com filtros e busca, histórico com decisões do agente, chamados do funcionário, assumir, responder, devolver ao agente e encerrar, com concorrência segura | |
> | **Pedido direto de analista** pelo funcionário (`POST .../handoff`), sem LLM, atômico e idempotente | |
> | **Eventos em tempo real para o funcionário** (`GET .../events`): mensagens do analista e mudanças de estado, com recuperação na reconexão | |
> | **Interface web** (React): login (Tela 1), chat com cards, seleção, rascunhos, respostas rápidas e pedido de analista (Telas 2 e 3), painel de decisões do agente, perfil e console do analista (Telas 4 e 5), responsiva | |
>
> A lista completa de rotas, implementadas e planejadas, está em [docs/api-contracts.md](docs/api-contracts.md).

## Como rodar

Pré-requisitos: Node.js 24 (`.nvmrc`; mínimo 22.13) e Docker.

```bash
npm install            # instala dependências e gera o cliente Prisma
cp .env.example .env   # configuração local (sem segredos reais)
npm run db:up          # PostgreSQL em 127.0.0.1:5434
npm run db:migrate     # cria as tabelas (prisma migrate deploy)
npm run db:seed -- --confirm   # dados de exemplo (opcional, só insere)
npm run dev            # API em :3333 e web em http://localhost:5173
```

O login é demonstrativo (qualquer senha não vazia para os usuários de exemplo; exige banco migrado e com o seed). Em produção defina
`AUTH_SECRET` (mínimo 32 caracteres); em desenvolvimento, sem ele, a API usa um segredo efêmero.

Para o agente responder, defina o modelo e a chave do provedor no `.env` (a chave nunca vai para o código):

```bash
AGENT_MODEL=anthropic/claude-haiku-5-5
ANTHROPIC_API_KEY=...
```

Sem `AGENT_MODEL`, a API funciona normalmente: as mensagens são gravadas, o stream devolve
`AGENT_UNAVAILABLE` (repetível) e a resposta fica pendente até ser retomada.

```bash
curl -s localhost:3333/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"ana.souza@nexo.com.br","password":"qualquer"}'      # devolve { token, expiresAt, user }
curl -s localhost:3333/api/tickets -H "authorization: Bearer $TOKEN"
```

`db:migrate` e `db:seed` alteram o banco do `.env` e por isso são sempre manuais. O seed recusa
bancos não locais e mantém linhas que já existem. `SEED_NOW=<ISO 8601>` fixa o instante de
referência para gerar dados idênticos entre execuções. Usuários de exemplo: `ana.souza@nexo.com.br` (funcionária) e `marcos.oliveira@nexo.com.br` (analista).

A página da web mostra se a API e o banco estão de pé.

| Comando | O que faz |
| --- | --- |
| `npm run dev` | API (tsx watch) e web (Vite) juntas |
| `npm test` | Testes unitários, de arquitetura, de API e **de interface** (sem banco; a interface roda em jsdom contra a API real em memória, com o agente e um modelo roteirizado). No Windows o worker do Vitest cai de vez em quando por um aborto nativo; se aparecer "Worker exited unexpectedly", rode de novo (detalhes em [docs/architecture.md](docs/architecture.md), seção Testes) |
| `npm run test:db` | Integração com PostgreSQL real em banco descartável, criado e removido a cada execução (exige `npm run db:up`); inclui o agente de ponta a ponta com LLM simulado e o console do analista (concorrência) |
| `npm run test:live` | Avaliação com o modelo **real** (opcional, custa tokens): só roda com `AGENT_LIVE_TEST=1`, `AGENT_MODEL` e a chave do provedor, com teto de tokens. Procedimento em [docs/avaliacao-agente.md](docs/avaliacao-agente.md) |
| `npm run test:e2e` | Homologação no **navegador real** (Chrome/Edge) com API real e PostgreSQL descartável; só o modelo é roteirizado (sem custo). Exige `npm run db:up`. Roteiro em [docs/homologacao.md](docs/homologacao.md) |
| `npm run demo:check` | Diagnóstico **somente leitura** do ambiente de demonstração: banco de destino, migrations, seed, modelo e portas, com o comando para corrigir cada pendência |
| `npm run db:migrate` | Aplica as migrations ao banco do `.env` |
| `npm run db:seed -- --confirm` | Insere os dados de exemplo no banco do `.env` |
| `npm run typecheck` | Tipagem estrita de todos os pacotes e testes |
| `npm run build` | Build de produção |
| `npm run db:down` | Para o banco (os dados ficam no volume) |

## Arquitetura

```
apps/web (React + Vite)  ──▶  apps/api (Express)  ──▶  packages/agent (Mastra)
                                   ├──▶  packages/ticket-service (sistema de chamados simulado)
                                   └──▶  PostgreSQL (Prisma 7)
packages/shared: contratos Zod e regras do service desk, usados por todos
```

- **O agente não acessa o banco** nem o serviço de chamados: lê só por portas injetadas por
  requisição, já vinculadas ao funcionário autenticado. O modelo não tem como pedir chamados de
  outra pessoa.
- **O agente não escreve nada durante a resposta**: rascunho e transferência são só planejados e a
  API os grava junto com a resposta, numa transação. Chamado só é criado ou alterado quando o
  funcionário confirma o rascunho.
- **Fronteiras testadas**: `tests/architecture.test.ts` falha se um pacote importar o que não deve.

Detalhes e decisões: [docs/architecture.md](docs/architecture.md).
Rotas e eventos de streaming: [docs/api-contracts.md](docs/api-contracts.md).
Requisitos do desafio: [docs/references/](docs/references/).

## Como o agente decide

A cada mensagem, o agente (Mastra) recebe o histórico recente da conversa e um conjunto de
ferramentas já restritas ao funcionário:

| Ferramenta | O que faz |
| --- | --- |
| `searchHelpCenter` | busca na central de ajuda (determinística, sem custo de tokens) |
| `listMyTickets` / `getMyTicket` | chamados do próprio funcionário, com status e prazo vencido |
| `findDuplicateTickets` | chamados abertos parecidos (regra "sem duplicidade") |
| `proposeTicketDraft` | prepara rascunho de abertura, atualização ou reabertura; tipo, categoria e prioridade são validados e a prioridade é calculada pela regra de impacto × urgência |
| `requestHandoff` | transfere para um analista, com resumo do caso |
| `submitResponse` | entrega a resposta com intenção, ação, confiança e justificativa |

O modelo **propõe**; uma política determinística ([policy.ts](packages/agent/src/policy.ts)) confere a
proposta contra o que as ferramentas realmente fizeram: ação sem evidência é corrigida, só aparecem
chamados consultados nesta resposta, assunto fora de TI é redirecionado, e a transferência é
obrigatória quando o funcionário pede, quando o caso é crítico ou quando a confiança fica abaixo de
0,6. Cada correção aparece na justificativa ("Ajustes automáticos: ...").

**Transparência.** Cada resposta grava uma decisão (`AgentDecision`) com intenção, entendimento,
ação, confiança (número e nível), justificativa curta, regras do Anexo A aplicadas, passos executados
(ferramenta, resultado resumido, duração) e telemetria (modelo, tokens, latência). Os passos chegam
pelo stream enquanto acontecem (`agent.step`). Não guardamos raciocínio interno do modelo, só fatos
das ferramentas e a justificativa objetiva que o modelo entrega.

**Qualidade das decisões.** Testes determinísticos rodam o Mastra de verdade com um provedor de LLM
simulado (roteirizado): dúvida pela central de ajuda, consulta sem número, chamado alheio,
rascunho, duplicidade, reabertura, baixa confiança, fora de escopo, falhas do provedor, limites e
tempo máximo. A integração com PostgreSQL cobre publicação, confirmação, recuperação e transferência.
Uma **matriz de 18 cenários** do PRD e do Anexo A (intenção, ferramenta, classificação, perguntas,
confirmação, privacidade, encaminhamento e justificativa) roda sem custo com o modelo roteirizado e, com
chave, com o modelo real (`npm run test:live`, verifica comportamento, não texto, com teto de tokens).
O que cada execução prova e o que não prova: [docs/avaliacao-agente.md](docs/avaliacao-agente.md).

## Escolha do modelo

Padrão sugerido: **`anthropic/claude-haiku-5-5`**. O agente faz chamadas curtas com ferramentas e
uma resposta estruturada; um modelo rápido e barato com bom uso de ferramentas mantém a latência e o
custo por conversa baixos, e as regras críticas não dependem do modelo (estão em código). Qualquer
provedor do model router do Mastra funciona trocando `AGENT_MODEL` (ex.: `openai/gpt-5-mini`).

Custo controlado por resposta: até 6 chamadas ao modelo, 8 execuções de ferramenta, 1.500 tokens de
saída por chamada, histórico das últimas 24 mensagens, 45 s de tempo máximo e no máximo 4 respostas
simultâneas por processo (`AGENT_TIMEOUT_MS`, `AGENT_MAX_CONCURRENCY`).

## Demonstração em 6 comandos

```bash
npm install && cp .env.example .env     # primeira vez
npm run db:up                           # PostgreSQL
npm run demo:check                      # o que falta? (não altera nada)
npm run db:migrate && npm run db:seed -- --confirm   # ALTERA o banco do .env
npm run dev                             # http://localhost:5173
```

Entre com `ana.souza@nexo.com.br` (funcionária) ou `marcos.oliveira@nexo.com.br` (analista), qualquer
senha. Para o agente responder, defina `AGENT_MODEL` e a chave do provedor no `.env`. Detalhes e o estado
verificado: [docs/homologacao.md](docs/homologacao.md).

## A interface

`npm run dev` sobe a API e a web (http://localhost:5173). Entre com um usuário de exemplo (qualquer
senha): `ana.souza@nexo.com.br` vai para o chat; `marcos.oliveira@nexo.com.br` (N1) ou
`paula.santos@nexo.com.br` (N2), para o console. Tudo o que a tela mostra vem da API: histórico,
cards, rascunhos, decisões, fila e chamados; nada é simulado no front.

- **Chat (Telas 2 e 3):** lista de conversas e nova conversa, histórico persistido, resposta do agente
  por SSE com os passos reais aparecendo enquanto ele trabalha, cards de chamado com prioridade, prazo
  e aviso de vencido, seleção de chamado, respostas rápidas, rascunhos com Confirmar e Descartar,
  "Falar com um analista", contador de 30 mensagens, estados de carregamento, erro e indisponibilidade
  com "Tentar de novo".
- **Transparência:** acima de cada resposta, as ações executadas ("✓ consultou seus chamados");
  "Ver detalhes da decisão" abre o registro gravado: o que entendeu, intenção, ação, confiança, justificativa,
  regras do Anexo A e ferramentas com resultado e duração, além de modelo, tokens e latência.
- **Tempo real:** mensagens do analista e mudanças de estado chegam sem recarregar; a conexão se
  refaz sozinha e recupera o que perdeu sem duplicar; resposta pendente do agente é retomada ao
  reabrir a conversa.
- **Console (Telas 4 e 5):** fila com filtros e busca, resumo e motivo da transferência, histórico com as
  decisões do agente, chamados do funcionário, assumir, responder, devolver e encerrar; conflitos de
  versão (outro analista agiu antes) avisam e recarregam o estado real.

Sem streaming de texto: a resposta do agente chega inteira; o tempo real está nos passos.

## Transferência e console do analista

Quando o agente transfere (pedido do funcionário, caso crítico, chamado vencido a pedido ou confiança
abaixo de 0,6), a conversa vai para `WAITING_ANALYST` com um resumo do caso e o agente para de
responder. Pelas rotas `/api/console/*`, um analista N1 ou N2:

1. vê a **fila** (filtros por status, busca por funcionário, paginação), com motivo e resumo;
2. abre a conversa: histórico, **decisões do agente** e os chamados do funcionário atendido;
3. **assume** (só um analista consegue, mesmo em disputa), **responde**, e **devolve** ao agente ou
   **encerra**. Só quem assumiu responde, devolve ou encerra;
4. o funcionário acompanha mensagens e mudanças de estado em `GET /api/conversations/:id/events`, que
   se recupera sozinho depois de queda ou reinício.

Toda ação informa a versão que o analista viu (`expectedVersion`) e roda com a conversa travada no
banco; o agente também não publica se o estado da conversa mudou durante a execução. Os registros de
transferência nunca são apagados. Regras, erros e limites: [docs/api-contracts.md](docs/api-contracts.md)
e [docs/architecture.md](docs/architecture.md). Ainda não há interface do console: só a API.

## Ainda por escrever

Principais trade-offs e o que faria com mais tempo (próximas fases), além das telas.
