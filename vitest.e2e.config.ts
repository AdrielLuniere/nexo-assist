import { existsSync } from 'node:fs';
import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Homologação no navegador real (Chrome/Edge via DevTools), com API real e PostgreSQL DESCARTÁVEL
// (nexo_test_*; o banco do .env só informa host e credenciais). Modelo de linguagem roteirizado, sem
// custo. `npm run test:e2e` (exige `npm run db:up`). Fora do `npm test`.
if (existsSync('.env')) process.loadEnvFile('.env');

const conditions = ['@nexo/source', ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
