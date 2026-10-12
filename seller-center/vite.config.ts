import { defineConfig } from 'vite';
import { marketlyApp } from '@marketly/web-shared/vite';

export default defineConfig(marketlyApp({ app: 'seller', port: 3001, root: import.meta.url }));
