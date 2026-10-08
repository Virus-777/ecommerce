/**
 * Public surface of the wallet module: the ONLY file other modules may import from this folder
 * (`npm run check:boundaries`). Types, event payloads and the public API come from the spec.
 */
export type { WalletPublicApi } from '../../spec/wallet.js';
export type * from '../../spec/wallet.js';
