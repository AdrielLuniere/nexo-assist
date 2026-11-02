import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

const conditions = ['@nexo/source', ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'apps/api/src/**/*.test.ts', 'apps/web/src/**/*.test.tsx', 'tests/**/*.test.ts'],
    // Integração com banco real: `npm run test:db` (vitest.db.config.ts).
    // Modelo de linguagem real: `npm run test:live` (vitest.live.config.ts).
    exclude: ['**/node_modules/**', '**/*.integration.test.ts', '**/*.live.test.ts'],
    restoreMocks: true,
    // Um worker por arquivo de teste (17+) subindo ao mesmo tempo derrubava processos no Windows
    // (código 0xC0000409 "durante o início"), de forma intermitente e sem relação com os testes.
    maxWorkers: 4,
  },
});
