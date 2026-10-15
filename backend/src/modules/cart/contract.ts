/**
 * Public surface of the cart module: the ONLY file other modules may import from this folder
 * (`npm run check:boundaries`). Types, event payloads and the public API come from the spec.
 * couponNotCovered: the coupon "not covered" wording checkout shares with the cart.
 */
export type * from '../../spec/cart.js';
export { couponNotCovered } from './domain/coupons.js';
