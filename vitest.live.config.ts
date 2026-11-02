import { existsSync } from 'node:fs';
import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Avaliação com o modelo de linguagem REAL: `npm run test:live` com AGENT_LIVE_TEST=1, AGENT_MODEL e a
// chave do provedor. Fica fora de `npm test` e `npm run test:db` (custo, rede e respostas não determinísticas).
if (existsSync('.env')) process.loadEnvFile('.env');

const conditions = ['@nexo/source', ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    environment: 'node',
    include: ['tests/**/*.live.test.ts'],
    testTimeout: 90_000,
    fileParallelism: false,
  },
});
