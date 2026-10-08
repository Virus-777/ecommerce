/**
 * What the wishlist service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: wishlist.lists, wishlist.items, wishlist.alerts. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WishlistRepository {}
