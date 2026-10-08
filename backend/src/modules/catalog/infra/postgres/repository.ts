import type { Kysely } from 'kysely';
import type { CatalogDb } from '../../../../spec/catalog.js';
import type { CatalogRepository } from '../../ports.js';

/** Postgres adapter for CatalogRepository. `db` is scoped to the `catalog` schema. */
export function createPostgresCatalogRepository(db: Kysely<CatalogDb>): CatalogRepository {
  void db;
  return {};
}
