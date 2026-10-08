import type { Kysely } from 'kysely';
import type { ReviewsDb } from '../../../../spec/reviews.js';
import type { ReviewsRepository } from '../../ports.js';

/** Postgres adapter for ReviewsRepository. `db` is scoped to the `reviews` schema. */
export function createPostgresReviewsRepository(db: Kysely<ReviewsDb>): ReviewsRepository {
  void db;
  return {};
}
