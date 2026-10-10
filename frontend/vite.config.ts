import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // IPv4 explicitly: on this machine Chrome cannot reach Vite's default [::1] bind.
  server: { host: '127.0.0.1', port: 5173 },
});
