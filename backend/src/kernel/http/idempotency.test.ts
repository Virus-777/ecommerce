/**
 * Idempotency-Key stores: the same contract in MongoDB (kernel.idempotency_keys) and MySQL
 * (`kernel_idempotency_keys`). The promises are the ones the middleware relies on — replay the first
 * result for the same request, refuse a key reused for a different one, say CONFLICT while a request with
 * that key is still running — and a module above cannot tell which store is underneath.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testMongo } from '../../testing/mongo.js';
import { testMysql } from '../../testing/mysql.js';
import type { MongoStore } from '../mongo/index.js';
import { migrateMongo } from '../mongo/schema.js';
import type { MysqlStore } from '../mysql/index.js';
import { hashRequest, mongoIdempotencyStore, mysqlIdempotencyStore, type IdempotencyStore } from './idempotency.js';

let now = Date.parse('2026-05-04T10:00:00Z');
const clock = { now: () => new Date(now) };

let mongo: MongoStore;
let mysql: MysqlStore;

beforeAll(async () => {
  mongo = await testMongo();
  await migrateMongo(mongo, []);
  mysql = await testMysql();
});
afterAll(async () => {
  await mongo?.close();
  await mysql?.close();
});

describe.each([
  ['mongo', () => mongoIdempotencyStore(mongo, clock)],
  ['mysql', () => mysqlIdempotencyStore(mysql, clock)],
])('%s store', (_name, make) => {
  let store: IdempotencyStore;
  beforeAll(() => {
    store = make();
  });

  const body = { order: 'a-1' };
  const hash = hashRequest(body);

  it('lets the first request run and replays its result for the next', async () => {
    expect(await store.begin('orders.create', 'k1', hash)).toBeNull();
    await store.complete('orders.create', 'k1', 201, { id: 'o-1' });
    expect(await store.begin('orders.create', 'k1', hash)).toEqual({ status: 201, body: { id: 'o-1' } });
  });

  it('replays a null body as null, not as a missing one', async () => {
    expect(await store.begin('orders.create', 'k-null', hash)).toBeNull();
    await store.complete('orders.create', 'k-null', 204, null);
    expect(await store.begin('orders.create', 'k-null', hash)).toEqual({ status: 204, body: null });
  });

  it('refuses the key when the request is a different one', async () => {
    expect(await store.begin('orders.create', 'k2', hash)).toBeNull();
    await store.complete('orders.create', 'k2', 201, { id: 'o-2' });
    await expect(store.begin('orders.create', 'k2', hashRequest({ order: 'something-else' }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('answers CONFLICT while the first request is still running', async () => {
    expect(await store.begin('orders.create', 'k3', hash)).toBeNull();
    await expect(store.begin('orders.create', 'k3', hash)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('frees the key when the request failed in a way worth retrying', async () => {
    expect(await store.begin('orders.create', 'k4', hash)).toBeNull();
    await store.release('orders.create', 'k4');
    expect(await store.begin('orders.create', 'k4', hash)).toBeNull();
  });

  it('keeps the scopes apart: the same key in two operations is two keys', async () => {
    expect(await store.begin('orders.create', 'shared', hash)).toBeNull();
    expect(await store.begin('payments.charge', 'shared', hash)).toBeNull();
  });

  it('takes the longest scope and key a request can arrive with', async () => {
    // scope = `<operationId>:<kind>:<accountId>:<sellerId>` (register.ts), key = the Idempotency-Key header,
    // which the route schema admits up to 255 characters. MongoDB has no lengths; MySQL's columns are sized
    // from this, and were both too short at first — every checkout in the suite answered 500
    const scope = `fulfillment-service.listFulfillmentRequests:customer:${'a'.repeat(36)}:${'b'.repeat(36)}`;
    const key = 'k'.repeat(255);
    expect(await store.begin(scope, key, hash)).toBeNull();
    await store.complete(scope, key, 201, { id: 'o-long' });
    expect(await store.begin(scope, key, hash)).toEqual({ status: 201, body: { id: 'o-long' } });
  });

  it('lets a key be used again once it is older than a day', async () => {
    now = Date.parse('2026-05-04T10:00:00Z');
    expect(await store.begin('orders.create', 'k5', hash)).toBeNull();
    await store.complete('orders.create', 'k5', 201, { id: 'o-5' });
    now = Date.parse('2026-05-05T10:00:01Z'); // a day and a second later
    // not a replay of the old result, and not a CONFLICT from the old row: a new request
    expect(await store.begin('orders.create', 'k5', hashRequest({ order: 'a-new-one' }))).toBeNull();
    now = Date.parse('2026-05-04T10:00:00Z');
  });
});
