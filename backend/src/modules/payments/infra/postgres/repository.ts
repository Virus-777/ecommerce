import type { Kysely } from 'kysely';
import type { PaymentsDb } from '../../../../spec/payments.js';
import type { PaymentsRepository } from '../../ports.js';

/** Postgres adapter for PaymentsRepository. `db` is scoped to the `payments` schema. */
export function createPostgresPaymentsRepository(db: Kysely<PaymentsDb>): PaymentsRepository {
  return {};
}
