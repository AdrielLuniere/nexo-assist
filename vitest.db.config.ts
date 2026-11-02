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
  },
});
