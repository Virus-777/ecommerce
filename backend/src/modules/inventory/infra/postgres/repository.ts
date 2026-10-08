import type { Kysely } from 'kysely';
import type { InventoryDb } from '../../../../spec/inventory.js';
import type { InventoryRepository } from '../../ports.js';

/** Postgres adapter for InventoryRepository. `db` is scoped to the `inventory` schema. */
export function createPostgresInventoryRepository(db: Kysely<InventoryDb>): InventoryRepository {
  void db;
  return {};
}
