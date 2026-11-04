# Entrega: auditoria final

Conferência do Nexo Assist contra o PRD v5, com a evidência de cada item. Estado auditado: commit
`df5b0ff` (branch `main`).

## 1. Resultado das verificações

| Verificação | Resultado | Fonte |
| --- | --- | --- |
| CI Linux do `df5b0ff` (run `41564698320`) | **verde**: typecheck, 30 arquivos / **435 testes**, build, **71** testes com PostgreSQL | `gh run view 41564698320` |
| `test:e2e` (navegador real, H1–H12) | 22/22 após o `df5b0ff`, no Windows (informado pelo responsável pela entrega; o CI não o executa) | [homologacao.md](homologacao.md) |
| Credenciais no repositório | **nenhuma** (arquivos versionados e histórico dos 11 commits) | varredura por padrões de chave; só `.env.example` é versionado e sem valores; `.env` está no `.gitignore` |
| Avaliação com **Claude real** | **não reproduzida nesta auditoria**: nenhum relatório de `test:live` está versionado. O responsável informa que o Claude real respondeu, preparou rascunho, justificou e consultou a base antes do `df5b0ff`; **não houve novo teste com Claude real depois da P0.8-D** | ver seção 4 |

Aviso do CI (não é falha): `checkout@v4` e `setup-node@v4` usam Node 20, que o GitHub força para Node 24.

## 2. Matriz PRD × evidências

**Classificação usada nas tabelas:** ✅ **implementado** (com evidência automatizada); 🟡 **parcial** (existe,
mas com limitação que o PRD cobre); ⛔ **pendente** (não feito). Diferenças visuais em relação aos protótipos
são **opcionais** e estão na seção 5, separadas dos requisitos.

**Legenda:** ✅ implementado · 🟡 parcial · ⛔ pendente. "Evidência" aponta arquivo, endpoint ou teste.

### Funcionário

| Requisito (PRD) | Estado | Evidência |
| --- | :-: | --- |
| História 1: tirar dúvida sem abrir chamado | ✅ | ferramenta `searchHelpCenter` (`packages/agent/src/tools.ts`); matriz `kb-duvida`; E2E H2 |
| História 2: status do chamado sem lembrar o número; saber se está atrasado | ✅ | `listMyTickets`/`getMyTicket`; `isOverdue` no contrato; cards com "prazo vencido"; `consulta-sem-numero`; E2E H3 |
| História 3: complementar um chamado aberto | ✅ | rascunho `UPDATE` (`proposeTicketDraft`); `atualizar`; E2E H5 |
| História 4: abrir chamado conversando e conferir antes de criar | ✅ | rascunho + `POST /api/conversations/:id/drafts/:id/confirm`; `apps/api/src/drafts/`; `tests/api-drafts.test.ts`; E2E H4 |
| História 5: falar com analista quando quiser ou se grave | ✅ | `POST /api/conversations/:id/handoff` (sem LLM); transferência pelo agente (pedido, crítico, vencido, baixa confiança); `tests/api-handoff-request.test.ts`; E2E H8 |
| História 6: voltar outro dia e continuar | ✅ | `GET /api/conversations`, `GET /api/conversations/:id`; `POST .../resume`; `tests/conversations.integration.test.ts`; E2E H9 |

### Analista (console)

| Requisito (PRD) | Estado | Evidência |
| --- | :-: | --- |
| Receber chamados com tipo, categoria e prioridade corretos | ✅ | prioridade calculada por `classifyPriority` (`packages/shared/src/domain/priority.ts`); `abrir-incidente`, `abrir-requisicao` |
| Ver conversas que precisam dele, inclusive baixa confiança | ✅ | `GET /api/console/conversations` (filtros, busca, motivo e resumo); `tests/api-console.test.ts`; E2E H8 |
| Assumir (agente pausado), devolver ao agente, encerrar | ✅ | `POST /api/console/conversations/:id/{assume,return,close}` com `expectedVersion`; `tests/console.integration.test.ts` (disputa em rajada N1×N2); E2E H8 |
| Painel com os chamados do funcionário | ✅ | `employeeTickets` no detalhe; `apps/web/src/console/ConsoleApp.tsx` |

### O que construir

| Item | Estado | Evidência |
| --- | :-: | --- |
| 1. Login (Tela 1), qualquer senha | ✅ | `LoginPage.tsx`; `apps/api/src/auth/`; `tests/api-auth.test.ts`; `auth.test.tsx`; H1 |
| 2. Chat: tempo real, cards, seleção, rascunho, opções rápidas, 30 mensagens | 🟡 | tudo implementado (`apps/web/src/employee/`, `components/`); "tempo real" = **passos do agente ao vivo (SSE) e resposta inteira ao final**, sem texto token a token (ver limitações). 30 mensagens: `MAX_EMPLOYEE_MESSAGES_PER_SESSION`, teste de 40 envios simultâneos aceitando exatamente 30 |
| 3. Agente decide e segue o Anexo A | ✅ | `packages/agent` (Mastra): `tools.ts`, `policy.ts`, `instructions.ts`; `runner.test.ts` (27 testes); matriz de 18 cenários |
| 4. Serviço de chamados simulado, separado, com dados do Anexo B | ✅ | `packages/ticket-service` (sem dependência do agente, garantido por `tests/architecture.test.ts`); seed: 7 usuários, 9 artigos, 10 chamados em situações variadas (`apps/api/src/seed/data.ts`) |
| 5. Transferência: marcada como aguardando; agente para | ✅ | `WAITING_ANALYST`; `agentCanRespond`; revalidação por versão na publicação (`agent-turn-store.ts`); H8 |
| 6. Console (Telas 4 e 5) | ✅ | ver tabela do analista |
| Visibilidade das decisões ("a parte mais importante") | ✅ | linha de ações acima da resposta + painel "Ver detalhes da decisão" (`components/decision.tsx`) com entendimento, intenção, ação, confiança, justificativa, regras e ferramentas com resultado; tudo de `AgentDecision` gravado; volta igual após recarregar (H2, `chat.test.tsx`) |

### Requisitos técnicos e expectativas

| Requisito | Estado | Evidência |
| --- | :-: | --- |
| TypeScript com tipagem estrita | ✅ | `strict`, `noUncheckedIndexedAccess` em `tsconfig.base.json`; `npm run typecheck` (inclui testes e web) |
| Agente Mastra | ✅ | `packages/agent` (Mastra 1.x) |
| Modelo explicado no README | ✅ | README, "Escolha do modelo" (`anthropic/claude-haiku-5-5`) e limites de custo |
| Persistência de conversas, chamados e estado sobrevivem a reinício | ✅ | PostgreSQL/Prisma; `console.integration.test.ts` ("sobrevive a um reinício") |
| Rodar localmente com poucos comandos; `.env.example` | ✅ | README "Demonstração em 6 comandos"; `npm run demo:check` (somente leitura); CI faz `npm ci` do zero |
| Arquitetura clara, decisões justificadas | ✅ | [architecture.md](architecture.md); fronteiras testadas |
| Testes onde fazem diferença; tratamento de erros | ✅ | 435 unitários/UI + 71 PostgreSQL + 22 E2E; erros estruturados com código (`ApiErrorBody`); recuperação de resposta pendente |
| Commits que contam a história | 🟡 | 11 commits, um por fase (`feat:`/`test:`/`fix:`); legíveis, porém grossos |
| Eficiência e custo por conversa | ✅ | limites: 6 chamadas ao modelo, 8 ferramentas, 1.500 tokens de saída, 24 mensagens de histórico, 45 s; busca na central de ajuda sem tokens |
| Chaves fora do código; privacidade entre funcionários | ✅ | nenhuma credencial versionada; portas do agente já vinculadas ao funcionário; testes `privacidade`, `injecao`, H11 |
| Prioridade e prazos (Anexo A) | ✅ | `SLA_BY_PRIORITY`; `packages/ticket-service/src/sla.ts` (horas úteis, 8h–18h, sem feriados: decisão documentada) |
| Regras do Anexo A: tipos, categorias, abertura, duplicidade, reabertura 7 dias, transferência, privacidade, escopo | ✅ | `rules.ts`, `duplicates.ts`, `policy.ts`; cenários `duplicidade`, `reabrir-na/fora-da-janela`, `critico`, `fora-de-escopo` |
| Resiliência a queda do sistema de chamados legado | ✅ | `withRetry` + escritas idempotentes; `resilience.test.ts`; H10 (perda de resposta no `create` sem duplicar) |

### Entregáveis

| Entregável | Estado | Observação |
| --- | :-: | --- |
| Repositório GitHub | ✅ | `AdrielLuniere/nexo-assist` |
| README: como rodar, arquitetura, como o agente decide, qualidade, trade-offs, o que faria com mais tempo | ✅ | **corrigido nesta auditoria**: faltavam trade-offs e "o que faria com mais tempo" (a seção estava vazia) e havia uma frase desatualizada sobre o console |
| Deploy (diferencial) | ✅ | a implantação e seus componentes estão descritos no README ("Como foi feito o deploy"); os arquivos de Nginx/systemd e as credenciais não estão versionados. Demonstração publicada em **https://nexo.aggu.com.br/** (VPS Linux, Nginx HTTPS, API como serviço systemd, PostgreSQL, Claude da Anthropic). Acesso protegido por usuário de avaliação e cookie temporário de 8 h; após expirar, o avaliador reautentica-se com as mesmas credenciais. Procedimento e acesso no README ("Demonstração online") |

## 3. Consistência de estados (chamado × conversa × rascunho)

| Situação | Comportamento verificado | Evidência |
| --- | --- | --- |
| Confirmar rascunho | cria o chamado uma só vez (duplo clique incluso); rascunho vira `CONFIRMED` com o código; mensagem de resultado entra no histórico | H4; `drafts` idempotente por id do rascunho |
| Recarregar depois de confirmar | o cartão mostra "Confirmado · INC-…", sem botões | H4; `chat.test.tsx` |
| Transferir → assumir → responder → devolver | `WAITING_ANALYST` → `WITH_ANALYST` → `WITH_AGENT`; responsável limpo na devolução; registros de transferência preservados (`RETURNED_TO_AGENT`) | `console.integration.test.ts`; H8 |
| Agente depois da devolução | recebe o **estado atual** dos rascunhos (confirmado, descartado, substituído) e as falas do analista; não pede para confirmar de novo | P0.8-D: `history.test.ts`, `api-agent-memory.test.ts`, `agent.integration.test.ts` (prompt inspecionado) |
| Resposta do agente em voo durante assumir+devolver | descartada por mudança de versão; mensagem fica pendente e é retomada com o contexto novo | `console.integration.test.ts` |
| Aviso "um analista vai assumir…" | só enquanto a conversa está com a equipe | `chat.test.tsx` |
| Conversa encerrada | sem mensagens nem confirmação de rascunho; "Nova conversa" | H8; `draft-service` |

Limite desta evidência: a regressão da P0.8-D foi provada com modelo **roteirizado** (o prompt recebido
contém o estado correto). Que o Claude real passe a se comportar bem nesse cenário **não foi medido**.

## 4. Homologação H1–H12: roteirizado × Claude real

Todos os 22 testes do `test:e2e` usam **modelo roteirizado**: ferramentas, política, persistência, SSE e
telas são reais, mas o "julgamento" do modelo é um roteiro. Eles provam a plataforma, não o LLM.

| # | Fluxo | Evidência de plataforma (roteirizado) | Evidência de julgamento (Claude real) |
| --- | --- | --- | --- |
| H1 | Login | ✅ | n/a |
| H2 | Dúvida pela central de ajuda | ✅ | informada pelo responsável; sem relatório versionado |
| H3 | Consulta e vencido | ✅ | idem |
| H4 | Abertura por rascunho | ✅ | informada (rascunho e justificativa); sem relatório |
| H5–H7 | Atualizar, reabrir, duplicidade | ✅ | **sem evidência com Claude real** |
| H8 | Analista | ✅ | n/a (sem LLM no pedido direto; devolução volta ao agente) |
| H9–H10 | Retomada e resiliência | ✅ | n/a |
| H11 | Privacidade | ✅ (as regras são de código) | sem evidência |
| H12 | Visual | ✅ | n/a |

Para fechar a lacuna sem custo descontrolado, rode um subconjunto dos cenários marcados `live: true` (o cenário `duplicidade` é `live: false` e não entra no modo real): `LIVE_ONLY=kb-duvida,abrir-incidente,atualizar,privacidade,pedido-analista npm run test:live`
(ver [avaliacao-agente.md](avaliacao-agente.md)), registrando o relatório (`LIVE_REPORT`). Depende de
autorização de custo.

### Demonstração manual com Claude real (registro do responsável técnico)

O responsável técnico realizou uma demonstração manual, pela interface, com o Claude real: consulta à
central de ajuda, abertura de rascunho, confirmação do chamado **INC-20353**, atendimento por um analista
N1, devolução ao agente e encerramento. As capturas dessa sessão foram verificadas externamente pelo
responsável. **Não constituem um relatório automatizado versionado**: não há arquivo de `test:live` nem
captura no repositório que comprove esses passos, e a afirmação não substitui essa evidência.

O mesmo fluxo foi o que motivou a correção da P0.8-D (o agente pedir confirmação de um rascunho já
confirmado). A correção foi comprovada com o modelo roteirizado; a ausência de reincidência com o Claude
real vem da demonstração manual acima, não de medição automatizada.

## 5. Interface × protótipos

Há **7 arquivos de imagem** em `docs/references/` (PNG de capturas de tela, sem o PRD). Entre eles há **1 duplicata**:
as capturas `220157` e `220221` mostram a mesma Tela 1 de login (a segunda traz o rótulo "Identificação (desktop)").
Logo, são **6 telas distintas**: login (`220157`), chat com novo chamado (`220241`), consulta e transferência
(`220255`), perfil (`220305`), console com conversa transferida (`220316`) e console com atendimento assumido (`220327`).
Esta tabela cobre as seis.

| Protótipo | Fidelidade | Diferenças registradas |
| --- | --- | --- |
| Tela 1 · Login | alta | Mesmo layout de duas colunas, título em serifa, campos com ícone, olho para mostrar a senha, "Manter conectado", "Ligue no ramal 4000". **Sem** as métricas do painel escuro ("8 s", "72%", "6 analistas online agora"): não há dado real; o exemplo de conversa fica marcado "Exemplo ilustrativo". Sem "Esqueci minha senha" (login demonstrativo). Acrescenta uma nota de ambiente de demonstração |
| Tela 2 · Chat, novo chamado | alta | Menu lateral, indicação de ações acima da resposta, opções rápidas, card de rascunho com tipo, categoria, prioridade com prazo e afetados, contador `n/30`. **Sem "Editar"** no rascunho: o botão do protótipo foi omitido (decisão registrada abaixo); "Cancelar" é "Descartar"; sem atalho "⌘↵"; cabeçalho mostra o estado da conversa ("Com o assistente") no lugar de "Assistente online" |
| Tela 3 · Consulta e transferência | alta | Seleção entre chamados (radio, status, "vencido"), card com prazo vencido e "há 6 dias", oferta "Chamar um analista" (opções rápidas), ações executadas acima da resposta. Texto "prazo vencido há N dias" no card |
| Meu perfil | média | Nome, e-mail ("Gerenciado pela TI") e departamento. **Sem "Redefinir senha"** nem "Alterada há 42 dias" (não existe no sistema; o login é demonstrativo): no lugar, aviso explicando |
| Tela 4 · Console, transferida | média-alta | Trilho, lista com busca e filtros, conversa com "Ana espera um atendente", "Assumir atendimento", painel de chamados ("Desta conversa" + outros). Filtros: "Todas / Aguardando / Minhas / Em atendimento / Com o agente / Encerradas" (o protótipo tem "Para você / Com o agent / Minhas" com contadores: **sem contadores nem "Disponível"/"digitando…"**, que exigiriam presença/estado em tempo real que não existe no contrato). **Sem** "Ver todos os chamados da Ana" (não há tela de chamados) |
| Tela 5 · Console, atendendo | alta | "Devolver ao agente", "Encerrar atendimento" (com confirmação extra), mensagens do analista em verde com "Você", marcadores "Transferida…" e "Você assumiu · agente pausado". Sem selo de nível ("Suporte N2") nas mensagens: o contrato não traz o nome nem o nível do autor |

**Ausência da edição do rascunho (decisão e consequência).** O PRD pede "mostrar um rascunho e só criar
depois da confirmação" e "conferir os dados antes"; não exige edição em formulário. O fluxo de correção
é conversar: o funcionário diz o que mudar, o agente prepara um **novo rascunho** e o anterior fica
`SUBSTITUÍDO` (testado em `api-agent-memory.test.ts`). É uma diferença visível em relação ao protótipo e
deve ser dita na apresentação.

## 6. Riscos e limitações

| Risco | Gravidade | Mitigação / estado |
| --- | :-: | --- |
| O julgamento do Claude real não está medido de forma reproduzível (sem relatório) e não foi retestado após a P0.8-D | **alta** para a demonstração | rodar `test:live` selecionado (seção 4) antes de apresentar; roteiro tem plano B |
| Variabilidade do LLM ao vivo (redação, escolha de ferramenta) | média | regras críticas estão em código (política, duplicidade, janela de 7 dias, privacidade); o painel de decisão mostra o que ocorreu |
| Banco persistente `nexo_assist` pode estar sem migrations/seed na máquina de demonstração | média | `npm run demo:check` diz o que falta; migrar e semear exige decisão de quem opera |
| Sem texto em streaming: a resposta chega inteira (passos ao vivo) | baixa | documentado; custo de latência percebida |
| Console atualiza por consulta a cada 8 s (não há stream do analista no contrato) | baixa | o funcionário recebe ao vivo; ações do analista aplicam na hora |
| Eventos ao vivo são por processo (uma instância da API) | baixa p/ demo | recuperação por banco cobre queda e reinício; ver architecture.md |
| Instabilidade do Vitest no Windows (`0xC0000409`, worker cai sem asserção falhando) | baixa | documentada com medição; o Linux (CI) é estável; sem causa conhecida |
| `test:e2e` não roda no CI (exige navegador) | baixa | roda localmente; resultado informado acima |
| Busca na central de ajuda por palavras (sem sinônimos/semântica); SLA sem feriados | baixa | decisões documentadas |
| Sem limite de uso por usuário nem teto de gasto mensal com o provedor (o agente tem limites por resposta) | média, pelo custo | **P1 aberto** (ver "Achados P1"); a proteção de acesso externa mitiga o uso público, sem ser um controle de consumo da aplicação |
| Deploy em uma única VPS, sem redundância | baixa | aceitável para a avaliação |

### Achados P1 da auditoria final

Duas pendências relevantes foram identificadas na auditoria pré-entrega. Ambas são registradas aqui de forma
transparente:

1. **Ausência de teto global e de limite por usuário para o custo da IA (aberto).** A aplicação não tem limite
   de conversas novas por usuário, nem de mensagens por período, nem orçamento global de respostas. A única
   contenção de vazão no código é a concorrência de 4 respostas simultâneas por processo. O controle de acesso
   externo (usuário avaliador e cookie de 8 horas) reduz o risco de uso público, mas **não é uma limitação de
   consumo da aplicação**, e não comprovo sua configuração a partir do repositório. Continua pendente.
2. **Falta anterior de detalhamento do deploy (resolvido no README).** Antes, o README só citava VPS, Nginx,
   systemd e PostgreSQL, sem procedimento. A seção "Como foi feito o deploy" do README descreve os fatos da
   implantação. Mesmo assim, os arquivos de Nginx e systemd e as credenciais **não estão versionados**, portanto
   o deploy não é reproduzível somente com o repositório.

## 7. Roteiro de demonstração (3 a 5 minutos)

**Antes (1 min, fora da apresentação):** `npm run db:up`, `npm run demo:check` (sem pendências), `npm run dev`,
duas janelas do navegador (uma anônima, para a sessão do analista): Ana na primeira, Marcos na segunda.
Teste uma pergunta curta para confirmar que o modelo responde.

| Tempo | Quem | O que mostrar | O que dizer |
| --- | --- | --- | --- |
| 0:00 | Ana | Login. "Minha VPN está dando erro 809, uso Windows 10" | Dúvida resolvida **sem chamado** pela central de ajuda. |
| 0:40 | Ana | **Ver detalhes da decisão** | Transparência: entendimento, intenção, confiança, justificativa, regra e a ferramenta usada com o resultado real. Está gravado: recarrega igual. |
| 1:10 | Ana | "Como está meu chamado do notebook lento?" | Acha sem número, mostra **vencido** e o SLA; oferece analista. |
| 1:50 | Ana | "Meu notebook não conecta na VPN, erro 809, Windows 11, tenho reunião às 14h" | O agente prepara o **rascunho** (tipo, categoria, prioridade Alta pela regra impacto × urgência). **Nada foi criado.** Confirmar (uma vez) → chamado criado. |
| 2:40 | Ana | Peça de novo algo parecido com o INC-20311 | **Sem duplicidade**: propõe atualizar o existente. |
| 3:10 | Ana → Marcos | **Falar com um analista** (Ana). Na outra janela, Marcos vê a fila | Transferência com resumo e motivo, **sem LLM**; agente pausado. |
| 3:40 | Marcos | Assumir, responder; Ana vê a mensagem **ao vivo**; **Devolver ao agente** | Só o responsável age; conflito de versão protegido. |
| 4:20 | Ana | Nova mensagem: "o que falta eu confirmar?" | O agente sabe que o chamado **já foi criado**: contexto atual (a correção da P0.8-D). |
| 4:45 | — | Fechamento | Regras críticas em código; custo limitado; 435 + 71 + 22 testes. Diga a limitação: sem edição do rascunho (corrige-se conversando) e sem streaming de texto. |

**Plano B se o modelo falhar ao vivo:** a tela mostra o erro com "Tentar de novo" e a mensagem fica
gravada (recuperação de resposta pendente: isso também é um ponto de demonstração). Se a rede cair, mostre o
console e o painel de decisões de conversas já gravadas, e o `npm run test:e2e` como evidência.

## 8. Veredito

**Pronto para entrega, com demonstração online publicada.** O desafio ainda não foi enviado formalmente à empresa. A demonstração está em https://nexo.aggu.com.br/. Todos os requisitos obrigatórios do PRD estão implementados e com evidência
automatizada, o CI Linux do `df5b0ff` está verde, não há credenciais versionadas e a explicabilidade (o
critério que o PRD chama de mais importante) está completa e persistida. As diferenças para os protótipos são
conscientes e documentadas (seção 5). O único requisito classificado como parcial é o "tempo real" do chat
(passos ao vivo, resposta inteira). O deploy está feito; o que segue pendente são os limites de custo e uso.

**Condições antes de apresentar (não bloqueiam o envio do repositório):** (1) rodar um subconjunto do
`test:live` com a chave real e guardar o relatório, porque o Claude real não foi retestado depois da
P0.8-D e não há relatório versionado; (2) `npm run demo:check` sem pendências na máquina da demonstração.
