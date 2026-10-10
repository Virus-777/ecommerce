/**
 * Public surface of the sellers module: the ONLY file other modules may import from this folder
 * (`npm run check:boundaries`). Types, event payloads and the public API come from the spec.
 * Shared GraphQL mappers: other modules' resolvers build the seller's public card (Seller) and
 * public profile with them, from the sellers public API, so every schema gets the same shape.
 */
export type * from '../../spec/sellers.js';
export { sellerCardOut, sellerPublicProfileOut, type PublicProfileSource } from './graphql/cards.js';
