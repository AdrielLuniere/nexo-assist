import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createPrismaClient } from '../../apps/api/src/infra/prisma.js';

/**
 * Banco PostgreSQL descartável para testes de integração.
 *
 * Cria um banco novo (`nexo_test_<aleatório>`) no servidor local, aplica `prisma/migrations` nele
 * (o mesmo caminho de produção, `migrate deploy`) e o remove ao final. O banco de desenvolvimento
 * (o do `.env`) nunca é lido nem alterado: só serve para descobrir host, porta e credenciais.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const NAME_PATTERN = /^nexo_test_[a-f0-9]{12}$/;

export interface DisposableDatabase {
  readonly url: string;
  readonly name: string;
  drop(): Promise<void>;
}

export async function createDisposableDatabase(): Promise<DisposableDatabase> {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error('DATABASE_URL não definida (necessária para localizar o servidor local).');

  const base = new URL(baseUrl);
  if (!LOCAL_HOSTS.has(base.hostname)) {
    throw new Error(`Recusado: testes de integração só criam bancos em servidor local (host: ${base.hostname}).`);
  }

  const name = `nexo_test_${randomBytes(6).toString('hex')}`;
  if (!NAME_PATTERN.test(name)) throw new Error('Nome de banco de teste inválido.');

  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${name}`;

  const admin = createPrismaClient(adminUrl.toString());
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.$disconnect();
  }

  const drop = async () => {
    const client = createPrismaClient(adminUrl.toString());
    try {
      await client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await client.$disconnect();
    }
  };

  try {
    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: testUrl.toString() },
      stdio: 'pipe',
    });
  } catch (error) {
    await drop();
    throw error;
  }

  return { url: testUrl.toString(), name, drop };
}
