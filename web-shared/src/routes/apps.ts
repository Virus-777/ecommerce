import type { App } from './catalogue';

/** The app this bundle is (set per project in vite.config.ts with `define: { __APP__ }`). */
export const CURRENT_APP: App = __APP__;

/**
 * Base URLs of the three web apps, for links that cross apps (store ↔ Seller Center ↔ Admin Center).
 * Defaults match the backend's STORE_URL / SELLER_URL / ADMIN_URL ports; override per build with
 * VITE_STORE_URL, VITE_SELLER_URL, VITE_ADMIN_URL.
 */
export const APP_URLS: Record<App, string> = {
  store: (import.meta.env.VITE_STORE_URL as string | undefined) ?? 'http://127.0.0.1:3000',
  seller: (import.meta.env.VITE_SELLER_URL as string | undefined) ?? 'http://127.0.0.1:3001',
  admin: (import.meta.env.VITE_ADMIN_URL as string | undefined) ?? 'http://127.0.0.1:3002',
};

export const APP_NAMES: Record<App, string> = { store: 'Customer Store', seller: 'Seller Center', admin: 'Admin Center' };
