import type { Kysely } from 'kysely';
import type { FulfillmentServiceDb } from '../../../../spec/fulfillment-service.js';
import type { FulfillmentServiceRepository } from '../../ports.js';

/** Postgres adapter for FulfillmentServiceRepository. `db` is scoped to the `fulfillment_service` schema. */
export function createPostgresFulfillmentServiceRepository(db: Kysely<FulfillmentServiceDb>): FulfillmentServiceRepository {
  void db;
  return {};
}
