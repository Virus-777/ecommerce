/**
 * A list holds a product and variant once, a product saved without a variant included:
 * a unique index on (list_id, product_id, variant_id), where MongoDB treats nulls as equal.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { isDuplicateKey } from '../../../kernel/mongo/index.js';
import { buildTestApp } from '../../../testing/app.js';
import { spec } from '../../../spec/wishlist.js';
import { schemas } from '../schema.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildTestApp({ only: ['wishlist'] });
});
afterAll(async () => {
  await app?.close();
});

const table = (name: 'lists' | 'items') => app.kernel.mongo.module('wishlist', spec.collections, schemas).table<Record<string, unknown>>(name);
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes));

async function list() {
  const customerId = newId();
  const id = newId();
  await table('lists').insert({ id, customer_id: customerId, name: 'Saved', is_default: false, share_token: null, created_at: at(0), updated_at: at(0) });
  return { id, customerId };
}
const item = (l: { id: string; customerId: string }, productId: string, over: Record<string, unknown> = {}) => ({
  id: newId(),
  list_id: l.id,
  customer_id: l.customerId,
  product_id: productId,
  variant_id: null,
  offer_id: null,
  price_when_saved: null,
  currency: 'USD',
  note: null,
  added_at: at(0),
  ...over,
});

describe('saved item key', () => {
  it('refuses the same product without a variant twice in a list', async () => {
    const l = await list();
    const productId = newId();
    await table('items').insert(item(l, productId));
    const err = await table('items')
      .insert(item(l, productId))
      .catch((e: unknown) => e);
    expect(isDuplicateKey(err)).toBe(true);
    // a variant of it, or another list, is another item
    await table('items').insert(item(l, productId, { variant_id: newId() }));
    await table('items').insert(item(await list(), productId));
  });
});
