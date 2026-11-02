# Homologação

Roteiro, ambiente e resultados da validação da aplicação completa (web, API, agente e PostgreSQL).
A avaliação da qualidade do agente está em [avaliacao-agente.md](avaliacao-agente.md).

## Ambiente de demonstração

```
Navegador ──▶ Vite (apps/web, :5173) ──proxy──▶ API (Express, :3333) ──▶ PostgreSQL (docker, :5434)
                                                       └──▶ agente (Mastra) ──▶ modelo de linguagem do provedor
```

### Comandos mínimos

```bash
npm install                      # dependências e cliente Prisma
cp .env.example .env             # só na primeira vez
npm run db:up                    # PostgreSQL (docker) em 127.0.0.1:5434
npm run demo:check               # diagnóstico SOMENTE LEITURA: diz o que falta
npm run db:migrate               # altera o banco do .env (ver abaixo)
npm run db:seed -- --confirm     # altera o banco do .env: usuários, chamados e artigos de exemplo
npm run dev                      # API :3333 e web http://localhost:5173
```

Para o agente responder, acrescente ao `.env` (a chave nunca vai para o código):

```bash
AGENT_MODEL=anthropic/claude-haiku-5-5
ANTHROPIC_API_KEY=...
AUTH_SECRET=<32+ caracteres>     # opcional; evita perder a sessão a cada reinício da API
```

Entrar (qualquer senha): `ana.souza@nexo.com.br` (funcionária; chamados de exemplo com um vencido),
`bruno.lima@nexo.com.br` (outra funcionária, para testar privacidade), `marcos.oliveira@nexo.com.br`
(analista N1) e `paula.santos@nexo.com.br` (analista N2).

`npm run db:migrate` e `npm run db:seed` **alteram o banco** do `.env`. O seed recusa servidores não
locais e só insere o que ainda não existe. São sempre manuais.

### Estado verificado nesta fase

| Item | Estado |
| --- | --- |
| PostgreSQL local (container `nexo-assist-db`, `127.0.0.1:5434`) | de pé, saudável |
| Banco do `.env`: `nexo_assist` (**persistente**, volume do docker) | conecta, mas está **vazio: 0 de 2 migrations aplicadas, sem seed** |
| Migrations e seed | **não aplicados**: dependem de autorização para alterar o banco persistente |
| Modelo do agente (`AGENT_MODEL` e chave) | ausente no `.env`: o agente não responderia |
| `AUTH_SECRET` | ausente (a API usa um segredo efêmero em desenvolvimento) |

Para validar sem tocar no `nexo_assist`, a homologação no navegador usa um banco **descartável**
(`nexo_test_*`) com as mesmas migrations e o mesmo seed, e remove-o ao final.

## Roteiro executado no navegador real

`npm run test:e2e` (exige `npm run db:up`; Chrome ou Edge instalado, ou `E2E_BROWSER=<caminho>`). Sobe
a pilha completa (Vite com a web real, API real, regras e Mastra reais, PostgreSQL descartável com
migrations e seed reais) e dirige o navegador pelo protocolo DevTools, com **um contexto isolado por
pessoa** (a funcionária e o analista usam o sistema ao mesmo tempo). **Só o modelo de linguagem é
roteirizado** (sem custo): ferramentas, política, persistência, SSE e telas são as de produção. Capturas em
`test-results/e2e/`.

| # | Cenário | O que é conferido | Resultado |
| --- | --- | --- | --- |
| H1 | Login | funcionária e analista entram e caem na área certa; credencial desconhecida é recusada com mensagem clara | aprovado |
| H2 | Dúvida pela central de ajuda | resposta do artigo, ferramenta usada, painel com a decisão gravada; nenhum chamado criado; igual após recarregar | aprovado |
| H3 | Consulta de chamado próprio e vencido | card com prazo vencido, SLA de 3 dias úteis, oferta de analista; nenhum dado de outros funcionários | aprovado |
| H4 | Abertura por rascunho | nada é escrito antes de confirmar; **duplo clique em Confirmar cria um único chamado** com prioridade calculada (Alta); estado "Confirmado" volta ao recarregar; descartar não cria nada | aprovado |
| H5 | Atualização | só a confirmação registra a informação no histórico do chamado aberto | aprovado |
| H6 | Reabertura | reabre o resolvido há 4 dias; recusa o de 12 dias, sem rascunho e sem alterar o chamado | aprovado |
| H7 | Duplicidade | com chamado aberto parecido, a abertura é recusada pela ferramenta (resultado real exibido na decisão) e o agente propõe atualizar | aprovado |
| H8 | Analista | pedido direto **sem chamar o modelo**; resumo e chamados no console; assumir; resposta chega ao vivo; agente pausado de fato; devolver (agente volta a responder); N2 encerra e a funcionária deixa de poder escrever; **dois analistas assumindo: um vence, o outro é avisado** | aprovado |
| H9 | Retomada | após falha persistente do modelo, a mensagem fica gravada e a resposta pendente é retomada ao recarregar | aprovado |
| H10 | Resiliência | modelo indisponível com "Tentar de novo"; **queda do sistema de chamados que perde a resposta de `create`: não duplica**; consulta com o sistema fora: a falha aparece no passo e o agente não inventa dados; reenvio não duplica | aprovado |
| H11 | Privacidade | outro funcionário não vê conversas nem chamados da Ana | aprovado |
| H12 | Visual (desktop 1440, tablet 820, celular 390) | login, chat com rascunho, painel da decisão, fila e conversa do console: sem rolagem horizontal e com os controles principais visíveis (verificado por código nos três tamanhos) | aprovado |

### Bloqueados

| Cenário | Motivo | Como destravar |
| --- | --- | --- |
| Qualquer cenário com o **modelo real** | sem chave e sem autorização para chamadas pagas | `npm run test:live` e roteiro manual em [avaliacao-agente.md](avaliacao-agente.md) |
| Demonstração no banco persistente `nexo_assist` | banco sem migrations nem seed; alterá-lo exige autorização | autorizar `npm run db:migrate` e `npm run db:seed -- --confirm` |

## Problemas encontrados e correções

| Onde | Problema | Correção | Teste |
| --- | --- | --- | --- |
| Chat | Ao clicar em "Nova conversa", o campo continuava habilitado e uma mensagem digitada logo em seguida ia para a conversa **antiga**. Achado pelo navegador real. | A conversa atual é solta imediatamente e o campo fica bloqueado até a nova abrir | `chat.test.tsx` (falha sem a correção, confirmado por mutação) |
| Console (celular) | A barra "Ana espera um atendente" espremia o texto ao lado dos botões ("atendent/e") | os botões quebram de linha em telas estreitas | capturas e verificação de layout nos 3 tamanhos |
| Console | Um efeito devolvia a Promise de `scrollIntoView` e derrubava a tela (P0.7) | efeito em bloco; os testes agora imitam o navegador | `console.test.tsx` |
| Avaliação | As portas falsas marcavam qualquer texto com "notebook" como duplicado | as portas de avaliação usam a regra real de similaridade | `agent-eval-live-runner.test.ts` |

Comportamento observado e mantido: quando a resposta do agente falha, a tela tenta **uma vez** retomá-la
sozinha antes de mostrar o aviso com "Tentar de novo" (e retoma ao reabrir a conversa). Não duplica
mensagem nem decisão (idempotência por mensagem).

## O que a homologação não cobre

- O julgamento de um LLM de verdade (ver [avaliacao-agente.md](avaliacao-agente.md)).
- Outros navegadores além do Chromium (Chrome/Edge); Safari e Firefox não foram testados.
- Leitor de tela e conformidade de acessibilidade além de rótulos, teclado e foco do painel.
- Carga e várias instâncias da API (os eventos ao vivo são por processo; ver [architecture.md](architecture.md)).
- Linux para os testes de navegador: rodaram no Windows; o CI Linux executa `typecheck`, `npm test`, build e
  `test:db`, mas não `test:e2e`.
