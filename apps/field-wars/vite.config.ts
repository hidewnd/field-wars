import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { randomUUID } from 'node:crypto';

export default defineConfig(({ command }) => {
  const version = command === 'build' ? randomUUID() : 'development';
  return {
    root: 'apps/field-wars',
    base: './',
    define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(version) },
    plugins: [vue(), {
      name: 'frontend-version',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version }) });
      },
    }],
    build: { outDir: 'dist', emptyOutDir: true },
    server: {
      port: 5173,
      proxy: {
        '/api': { target: 'http://127.0.0.1:3000', ws: true },
      },
    },
  };
});
