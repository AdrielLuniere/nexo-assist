import { existsSync, readdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createPrismaClient } from '../infra/prisma.js';

/**
 * `npm run demo:check`: diagnóstico SOMENTE LEITURA do ambiente de demonstração. Nunca cria, altera nem
 * apaga nada: só consulta o banco do `.env` e diz o que falta, com o comando exato para corrigir.
 */

const rootEnv = fileURLToPath(new URL('../../../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const migrationsDir = fileURLToPath(new URL('../../../../prisma/migrations', import.meta.url));
const EXPECTED = { users: ['ana.souza@nexo.com.br', 'bruno.lima@nexo.com.br', 'marcos.oliveira@nexo.com.br', 'paula.santos@nexo.com.br'], tickets: ['INC-20311', 'INC-20150', 'INC-19980', 'REQ-10442'] };
const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

interface Line {
  readonly ok: boolean | 'warn';
  readonly text: string;
  readonly fix?: string;
}
const lines: Line[] = [];
const add = (ok: Line['ok'], text: string, fix?: string) => lines.push({ ok, text, ...(fix ? { fix } : {}) });

const portOpen = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(1000);
    socket.on('connect', () => (socket.destroy(), resolve(true)));
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => (socket.destroy(), resolve(false)));
  });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    add(false, 'DATABASE_URL não definida no .env', 'cp .env.example .env');
  } else {
    const target = new URL(url);
    const dbName = decodeURIComponent(target.pathname.slice(1));
    add(true, `Banco de destino: ${dbName} em ${target.hostname}:${target.port || 5432} (${LOCAL.has(target.hostname) ? 'servidor local' : 'NÃO é local'})`);

    const reachable = await portOpen(target.hostname.replace(/^\[|\]$/g, ''), Number(target.port || 5432));
    if (!reachable) {
      add(false, 'PostgreSQL não responde nessa porta', 'npm run db:up');
    } else {
      const prisma = createPrismaClient(url);
      try {
        await prisma.$queryRaw`SELECT 1`;
        add(true, 'Conexão com o PostgreSQL: ok');

        const applied = await prisma
          .$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`
          .then((rows) => rows.map((r) => r.migration_name))
          .catch(() => [] as string[]);
        const all = readdirSync(migrationsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
        const pending = all.filter((name) => !applied.includes(name));
        if (pending.length === 0) add(true, `Migrations: ${all.length}/${all.length} aplicadas`);
        else add(false, `Migrations: ${applied.length}/${all.length} aplicadas (faltam ${pending.length})`, 'npm run db:migrate   (altera o banco acima)');

        if (pending.length === 0) {
          const users = await prisma.user.findMany({ select: { email: true } });
          const missingUsers = EXPECTED.users.filter((email) => !users.some((u) => u.email === email));
          const tickets = await prisma.ticket.findMany({ select: { code: true } });
          const missingTickets = EXPECTED.tickets.filter((code) => !tickets.some((t) => t.code === code));
          const articles = await prisma.helpArticle.count();
          if (missingUsers.length === 0 && missingTickets.length === 0 && articles > 0) {
            add(true, `Seed: ${users.length} usuários, ${tickets.length} chamados, ${articles} artigos da central de ajuda`);
          } else {
            add(false, `Seed incompleto (usuários ausentes: ${missingUsers.length}, chamados ausentes: ${missingTickets.length}, artigos: ${articles})`, 'npm run db:seed -- --confirm   (só insere; altera o banco acima)');
          }
        }
      } catch (error) {
        add(false, `Falha ao consultar o banco: ${error instanceof Error ? error.message.split('\n')[0] : 'erro desconhecido'}`);
      } finally {
        await prisma.$disconnect();
      }
    }
  }

  const model = process.env.AGENT_MODEL;
  if (!model) {
    add('warn', 'AGENT_MODEL ausente: o agente NÃO responde (as mensagens ficam pendentes)', 'defina AGENT_MODEL=anthropic/claude-haiku-5-5 e ANTHROPIC_API_KEY no .env');
  } else {
    const keyVar = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_GENERATIVE_AI_API_KEY' }[model.split('/')[0] ?? ''];
    if (keyVar && !process.env[keyVar]) add('warn', `AGENT_MODEL=${model}, mas ${keyVar} não está definida: as respostas vão falhar`, `defina ${keyVar} no .env`);
    else add(true, `Modelo do agente: ${model}${keyVar ? ` (${keyVar} definida)` : ''}`);
  }

  if (process.env.AUTH_SECRET) add(true, 'AUTH_SECRET definido (as sessões sobrevivem a reinícios da API)');
  else add('warn', 'AUTH_SECRET ausente: em desenvolvimento a API usa um segredo efêmero (as sessões caem a cada reinício)', 'opcional: defina AUTH_SECRET (32+ caracteres) no .env');

  const apiPort = Number(process.env.API_PORT ?? 3333);
  if (await portOpen('127.0.0.1', apiPort)) add('warn', `Porta ${apiPort} já está em uso (a API já está rodando?)`);
  if (await portOpen('127.0.0.1', 5173)) add('warn', 'Porta 5173 já está em uso (a web já está rodando?)');

  const mark = { true: '✔', false: '✘', warn: '!' } as const;
  console.log('\nVerificação do ambiente de demonstração (somente leitura)\n');
  for (const line of lines) {
    console.log(` ${mark[String(line.ok) as 'true' | 'false' | 'warn']} ${line.text}`);
    if (line.fix) console.log(`     → ${line.fix}`);
  }
  const blocking = lines.filter((l) => l.ok === false).length;
  console.log(blocking === 0 ? '\nPronto: npm run dev e abra http://localhost:5173\n' : `\n${blocking} pendência(s) impede(m) a demonstração.\n`);
  process.exitCode = blocking === 0 ? 0 : 1;
}

void main();
