import { defineConfig } from 'vite';
import { marketlyApp } from '@marketly/web-shared/vite';

export default defineConfig(marketlyApp({ app: 'store', port: 3000, root: import.meta.url }));
