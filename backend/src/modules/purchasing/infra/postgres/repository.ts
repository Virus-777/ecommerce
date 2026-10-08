import type { Kysely } from 'kysely';
import type { PurchasingDb } from '../../../../spec/purchasing.js';
import type { PurchasingRepository } from '../../ports.js';

/** Postgres adapter for PurchasingRepository. `db` is scoped to the `purchasing` schema. */
export function createPostgresPurchasingRepository(db: Kysely<PurchasingDb>): PurchasingRepository {
  void db;
  return {};
}
