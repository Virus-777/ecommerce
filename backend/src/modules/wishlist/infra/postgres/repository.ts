import type { Kysely } from 'kysely';
import type { WishlistDb } from '../../../../spec/wishlist.js';
import type { WishlistRepository } from '../../ports.js';

/** Postgres adapter for WishlistRepository. `db` is scoped to the `wishlist` schema. */
export function createPostgresWishlistRepository(db: Kysely<WishlistDb>): WishlistRepository {
  void db;
  return {};
}
