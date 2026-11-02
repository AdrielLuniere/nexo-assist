import { existsSync } from 'node:fs';
import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Testes de integração usam o banco do .env (docker compose). Somente leitura.
if (existsSync('.env')) process.loadEnvFile('.env');

const conditions = ['@nexo/source', ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    environment: 'node',
    include: ['tests/**/*.integration.test.ts'],
    testTimeout: 15_000,
    // Cada arquivo cria seu banco descartável, roda migrations e dispara rajadas concorrentes no mesmo
    // servidor PostgreSQL. Em paralelo, a disputa por CPU/conexões gerava timeouts e quedas de worker
    // que nada têm a ver com o código testado. Em sequência o resultado é determinístico.
    fileParallelism: false,
  },
});
