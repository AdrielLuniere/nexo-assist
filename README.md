# Nexo Assist

Agente de IA para o service desk de TI da Nexo (desafio técnico). O funcionário descreve o
problema no chat; o agente consulta os chamados dele, busca na central de ajuda, prepara
chamados para confirmação e chama um analista quando precisa.

> **Status: P0.5 (agente Mastra, ferramentas e explicabilidade).**
>
> | Implementado | Planejado |
> | --- | --- |
> | Monorepo, contratos, fronteiras entre pacotes, `GET /health` | Console do analista (`/api/console/*`): assumir, devolver, encerrar, responder |
> | Migrations e seed de exemplo | Mensagens do analista em tempo real (`/events`) |
> | Serviço de chamados (consultar, criar, atualizar, reabrir) com confirmação, duplicidade, prazos, isolamento, idempotência e retentativas | Telas do protótipo (chat e console) |
> | Persistência em PostgreSQL de chamados, conversas, mensagens, decisões, rascunhos e transferências | Rota para o funcionário pedir analista sem passar pelo agente |
> | Login demonstrativo com sessão assinada e papéis (funcionário, analista N1/N2) | Deploy |
> | Conversas: criar, listar, histórico, enviar mensagem (SSE) com idempotência, limite de 30 e agente pausado | |
> | **Agente Mastra** respondendo no stream: central de ajuda, chamados do funcionário, duplicidade, rascunhos (abrir, atualizar, reabrir) e transferência para analista | |
> | **Decisão registrada por resposta**: intenção, entendimento, ação, confiança, justificativa, regras, ferramentas executadas, modelo, tokens e latência | |
> | **Recuperação de resposta pendente** (`POST .../resume`) e publicação idempotente | |
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
| `npm test` | Testes unitários, de arquitetura e de API (sem banco). No Windows o worker do Vitest cai de vez em quando por um aborto nativo; se aparecer "Worker exited unexpectedly", rode de novo (detalhes em [docs/architecture.md](docs/architecture.md), seção Testes) |
| `npm run test:db` | Integração com PostgreSQL real em banco descartável, criado e removido a cada execução (exige `npm run db:up`); inclui o agente de ponta a ponta com LLM simulado |
| `npm run test:live` | Avaliação com o modelo **real** (opcional, custa tokens): só roda com `AGENT_LIVE_TEST=1`, `AGENT_MODEL` e a chave do provedor |
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
`npm run test:live` avalia o modelo real em cenários do PRD (verifica comportamento, não texto).

## Escolha do modelo

Padrão sugerido: **`anthropic/claude-haiku-5-5`**. O agente faz chamadas curtas com ferramentas e
uma resposta estruturada; um modelo rápido e barato com bom uso de ferramentas mantém a latência e o
custo por conversa baixos, e as regras críticas não dependem do modelo (estão em código). Qualquer
provedor do model router do Mastra funciona trocando `AGENT_MODEL` (ex.: `openai/gpt-5-mini`).

Custo controlado por resposta: até 6 chamadas ao modelo, 8 execuções de ferramenta, 1.500 tokens de
saída por chamada, histórico das últimas 24 mensagens, 45 s de tempo máximo e no máximo 4 respostas
simultâneas por processo (`AGENT_TIMEOUT_MS`, `AGENT_MAX_CONCURRENCY`).

## Ainda por escrever

Principais trade-offs e o que faria com mais tempo (próximas fases), além do console do analista.
