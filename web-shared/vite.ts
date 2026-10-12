import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import type { UserConfig } from 'vite';

const SHARED_DIR = fileURLToPath(new URL('.', import.meta.url));
/** The extracted design export (npm run design:extract), used by /design/check. Forward slashes for /@fs/ URLs. */
const DESIGN_DIR = fileURLToPath(new URL('./.design', import.meta.url)).split('\\').join('/').replace(/\/$/, '');

/**
 * Vite config shared by the three web apps. Each app passes its identity and port:
 *   export default marketlyApp({ app: 'seller', port: 3001, root: import.meta.url })
 * Ports match the backend's STORE_URL / SELLER_URL / ADMIN_URL defaults (3000 / 3001 / 3002).
 */
export function marketlyApp({ app, port, root }: { app: 'store' | 'seller' | 'admin'; port: number; root: string }): UserConfig {
  return {
    plugins: [react()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', root)) } },
    define: {
      __APP__: JSON.stringify(app),
      __DESIGN_DIR__: JSON.stringify(DESIGN_DIR),
    },
    // IPv4 explicitly: on this machine Chrome cannot reach Vite's default [::1] bind.
    server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [fileURLToPath(new URL('.', root)), SHARED_DIR] } },
    preview: { host: '127.0.0.1', port },
  };
}
