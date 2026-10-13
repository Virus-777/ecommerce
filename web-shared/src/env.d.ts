/// <reference types="vite/client" />

/** Which web app this bundle is; defined per project in vite.config.ts. */
declare const __APP__: 'store' | 'seller' | 'admin';

/** Absolute path of the extracted design export (dev only, for /design/check); defined in vite.config.ts. */
declare const __DESIGN_DIR__: string;

/** Absolute path of the seed output folder web-shared/.seed (dev only, for /design/check samples); defined in vite.config.ts. */
declare const __SEED_DIR__: string;

interface ImportMetaEnv {
  readonly VITE_BRAND?: string;
  readonly VITE_STORE_URL?: string;
  readonly VITE_SELLER_URL?: string;
  readonly VITE_ADMIN_URL?: string;
}
