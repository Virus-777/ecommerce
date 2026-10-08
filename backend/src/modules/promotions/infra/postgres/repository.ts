import type { Kysely } from 'kysely';
import type { PromotionsDb } from '../../../../spec/promotions.js';
import type { PromotionsRepository } from '../../ports.js';

/** Postgres adapter for PromotionsRepository. `db` is scoped to the `promotions` schema. */
export function createPostgresPromotionsRepository(db: Kysely<PromotionsDb>): PromotionsRepository {
  return {};
}
