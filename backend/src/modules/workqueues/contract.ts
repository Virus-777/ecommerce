/**
 * Public surface of the workqueues module: the ONLY file other modules may import from this folder
 * (`npm run check:boundaries`). Types, event payloads and the public API come from the spec.
 */
export type { WorkqueuesPublicApi } from '../../spec/workqueues.js';
export type * from '../../spec/workqueues.js';
