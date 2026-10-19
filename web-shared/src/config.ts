/** Placeholder brand (plan ch. 21): one constant, overridable per build with VITE_BRAND. */
export const BRAND: string = import.meta.env.VITE_BRAND ?? 'Marketly';

/** Seller id of the Official Store wherever the API needs a seller id (backend spec/common.ts). */
export const OFFICIAL_STORE_ID = '00000000-0000-7000-8000-000000000001';
/** Display name of the Official Store (backend spec/common.ts). */
export const OFFICIAL_STORE_NAME = 'Marketly Official Store';
