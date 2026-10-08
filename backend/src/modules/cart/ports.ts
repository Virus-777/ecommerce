/**
 * What the cart service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: cart.carts, cart.cart_items, cart.cart_item_notices, cart.saved_items, cart.cart_merges, cart.recheck_queue. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CartRepository {}
