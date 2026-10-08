import type { Kysely } from 'kysely';
import type { CartDb } from '../../../../spec/cart.js';
import type { CartRepository } from '../../ports.js';

/** Postgres adapter for CartRepository. `db` is scoped to the `cart` schema. */
export function createPostgresCartRepository(db: Kysely<CartDb>): CartRepository {
  return {};
}
