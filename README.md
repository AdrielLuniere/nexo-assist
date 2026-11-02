# Nexo Assist

Agente de IA para o service desk de TI da Nexo (desafio técnico). O funcionário descreve o
problema no chat; o agente consulta os chamados dele, busca na central de ajuda, prepara
chamados para confirmação e chama um analista quando precisa.

> **Status: P0.1 (fundação).** Monorepo, esquema do banco, contratos, fronteiras entre pacotes,
> `GET /health` e página provisória na web. Serviço de chamados, rotas `/api`, agente com
> ferramentas e telas do protótipo entram nas próximas fases.

## Como rodar

Pré-requisitos: Node.js 24 (`.nvmrc`; mínimo 22.13) e Docker.

```bash
npm install            # instala dependências e gera o cliente Prisma
cp .env.example .env   # configuração local (sem segredos reais)
npm run db:up          # PostgreSQL em 127.0.0.1:5434
npm run dev            # API em :3333 e web em http://localhost:5173
```

A página da web mostra se a API e o banco estão de pé.

| Comando | O que faz |
| --- | --- |
| `npm run dev` | API (tsx watch) e web (Vite) juntas |
| `npm test` | Testes unitários e de arquitetura (sem banco) |
| `npm run test:db` | Integração com o PostgreSQL local (exige `npm run db:up`) |
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

- **O agente não acessa o banco** nem o serviço de chamados: age só por portas injetadas por
  requisição, já vinculadas ao funcionário autenticado. O modelo não tem como pedir chamados de
  outra pessoa.
- **O agente não escreve chamados**: propõe um rascunho; a escrita só acontece quando o
  funcionário confirma pela API.
- **Fronteiras testadas**: `tests/architecture.test.ts` falha se um pacote importar o que não deve.

Detalhes e decisões: [docs/architecture.md](docs/architecture.md).
Rotas e eventos de streaming: [docs/api-contracts.md](docs/api-contracts.md).
Requisitos do desafio: [docs/references/](docs/references/).

## Ainda por escrever

Seções exigidas pelo PRD que dependem das próximas fases: como o agente decide o que fazer,
como a qualidade das decisões foi garantida, escolha do modelo, principais trade-offs e o que
faria com mais tempo.
