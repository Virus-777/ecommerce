import type { Kysely } from 'kysely';
import type { CheckoutDb } from '../../../../spec/checkout.js';
import type { CheckoutRepository } from '../../ports.js';

/** Postgres adapter for CheckoutRepository. `db` is scoped to the `checkout` schema. */
export function createPostgresCheckoutRepository(db: Kysely<CheckoutDb>): CheckoutRepository {
  return {};
}
