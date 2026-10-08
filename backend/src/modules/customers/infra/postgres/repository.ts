import type { Kysely } from 'kysely';
import type { CustomersDb } from '../../../../spec/customers.js';
import type { CustomersRepository } from '../../ports.js';

/** Postgres adapter for CustomersRepository. `db` is scoped to the `customers` schema. */
export function createPostgresCustomersRepository(db: Kysely<CustomersDb>): CustomersRepository {
  void db;
  return {};
}
