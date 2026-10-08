import type { Kysely } from 'kysely';
import type { AdvertisingDb } from '../../../../spec/advertising.js';
import type { AdvertisingRepository } from '../../ports.js';

/** Postgres adapter for AdvertisingRepository. `db` is scoped to the `advertising` schema. */
export function createPostgresAdvertisingRepository(db: Kysely<AdvertisingDb>): AdvertisingRepository {
  return {};
}
