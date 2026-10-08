/**
 * Public surface of the access module: the ONLY file other modules may import from this folder
 * (`npm run check:boundaries`). Types, event payloads and the public API come from the spec.
 */
export type { AccessPublicApi } from '../../spec/access.js';
export type * from '../../spec/access.js';
