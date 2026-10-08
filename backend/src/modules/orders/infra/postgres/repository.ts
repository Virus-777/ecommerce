import type { Kysely } from 'kysely';
import type { OrdersDb } from '../../../../spec/orders.js';
import type { OrdersRepository } from '../../ports.js';

/** Postgres adapter for OrdersRepository. `db` is scoped to the `orders` schema. */
export function createPostgresOrdersRepository(db: Kysely<OrdersDb>): OrdersRepository {
  return {};
}
