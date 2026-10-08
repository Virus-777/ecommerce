import type { Kysely } from 'kysely';
import type { OffersDb } from '../../../../spec/offers.js';
import type { OffersRepository } from '../../ports.js';

/** Postgres adapter for OffersRepository. `db` is scoped to the `offers` schema. */
export function createPostgresOffersRepository(db: Kysely<OffersDb>): OffersRepository {
  return {};
}
