import type { Kysely } from 'kysely';
import type { ShippingDb } from '../../../../spec/shipping.js';
import type { ShippingRepository } from '../../ports.js';

/** Postgres adapter for ShippingRepository. `db` is scoped to the `shipping` schema. */
export function createPostgresShippingRepository(db: Kysely<ShippingDb>): ShippingRepository {
  return {};
}
