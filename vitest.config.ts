import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

const conditions = ['@nexo/source', ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'apps/api/src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Integração com banco real: `npm run test:db` (vitest.db.config.ts).
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
    restoreMocks: true,
  },
});
