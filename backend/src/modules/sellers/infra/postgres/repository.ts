import type { Kysely } from 'kysely';
import type { SellersDb } from '../../../../spec/sellers.js';
import type { SellersRepository } from '../../ports.js';

/** Postgres adapter for SellersRepository. `db` is scoped to the `sellers` schema. */
export function createPostgresSellersRepository(db: Kysely<SellersDb>): SellersRepository {
  return {};
}
