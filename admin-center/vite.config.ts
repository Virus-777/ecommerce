import { defineConfig } from 'vite';
import { marketlyApp } from '@marketly/web-shared/vite';

export default defineConfig(marketlyApp({ app: 'admin', port: 3002, root: import.meta.url }));
