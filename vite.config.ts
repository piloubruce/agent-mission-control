import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // Tree-shaking ACTIVE (2026-08-07, audit dev) : les exports inutilises
      // (api.ts, helpers, icones) sont elimines -> bundle JS -48% (1.46 Mo ->
      // 764 Ko mesure a l'audit). Le commentaire precedent ("prevent tree-shaking
      // of conditionally rendered components") etait une erreur : treeshake ne
      // touche pas au rendu conditionnel, il ne retire que les exports morts.
      rollupOptions: {
        treeshake: true,
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
