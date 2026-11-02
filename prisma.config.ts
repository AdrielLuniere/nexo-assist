import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 não carrega .env automaticamente.
if (existsSync('.env')) process.loadEnvFile('.env');

const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  // Sem DATABASE_URL, comandos que não tocam o banco (generate, validate, format) seguem funcionando.
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
