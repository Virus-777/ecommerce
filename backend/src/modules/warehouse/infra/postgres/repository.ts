import type { Kysely } from 'kysely';
import type { WarehouseDb } from '../../../../spec/warehouse.js';
import type { WarehouseRepository } from '../../ports.js';

/** Postgres adapter for WarehouseRepository. `db` is scoped to the `warehouse` schema. */
export function createPostgresWarehouseRepository(db: Kysely<WarehouseDb>): WarehouseRepository {
  return {};
}
