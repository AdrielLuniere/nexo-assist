import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3333';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Consome o código-fonte TS dos pacotes do monorepo, sem build prévio.
    conditions: ['@nexo/source', ...defaultClientConditions],
  },
  server: {
    port: 5173,
    strictPort: true,
    // Em desenvolvimento a API fica atrás do proxy do Vite: mesma origem, sem CORS.
    proxy: {
      '/api': apiTarget,
      '/health': apiTarget,
    },
  },
});
