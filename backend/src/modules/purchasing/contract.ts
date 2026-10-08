/**
 * Public surface of the purchasing module: the ONLY file other modules may import from this folder
 * (`npm run check:boundaries`). Types, event payloads and the public API come from the spec.
 */
export type { PurchasingPublicApi } from '../../spec/purchasing.js';
export type * from '../../spec/purchasing.js';
