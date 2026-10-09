/**
 * A list holds a product and variant once, a product saved without a variant included:
 * `unique nulls not distinct (list_id, product_id, variant_id)` (migration 0002, which merges existing duplicates).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { buildTestApp } from '../../../testing/app.js';
import { m0002ItemKeyNullsNotDistinct } from '../infra/postgres/migrations/0002_item_key_nulls_not_distinct.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildTestApp({ only: ['wishlist'] });
});
afterAll(async () => {
  await app?.close();
});

const db = () => app.kernel.database.kysely.withSchema('wishlist') as any;
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes));

async function list() {
  const customerId = newId();
  const id = newId();
  await db().insertInto('lists').values({ id, customer_id: customerId, name: 'Saved', is_default: false, share_token: null, created_at: at(0), updated_at: at(0) }).execute();
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
const alert = (l: { customerId: string }, itemId: string, productId: string, kind: string, minute: number) => ({
  id: newId(),
  customer_id: l.customerId,
  item_id: itemId,
  product_id: productId,
  variant_id: null,
  seller_id: null,
  kind,
  target_price: null,
  reference_price: 1000,
  state: 'active',
  triggered_at: null,
  triggered_price: null,
  paused_reason: null,
  last_notified_at: null,
  created_at: at(minute),
});

describe('saved item key', () => {
  it('refuses the same product without a variant twice in a list', async () => {
    const l = await list();
    const productId = newId();
    await db().insertInto('items').values(item(l, productId)).execute();
    const err = await db()
      .insertInto('items')
      .values(item(l, productId))
      .execute()
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('23505');
    // a variant of it, or another list, is another item
    await db().insertInto('items').values(item(l, productId, { variant_id: newId() })).execute();
    await db().insertInto('items').values(item(await list(), productId)).execute();
  });

  it('migration 0002 merges existing duplicates into the oldest item', async () => {
    const k = app.kernel.database;
    await k.exec(`drop index wishlist.items_key_idx;
create unique index items_old_key_idx on wishlist.items (list_id, product_id, variant_id);`);
    const l = await list();
    const productId = newId();
    const offerId = newId();
    const keeper = item(l, productId, { added_at: at(1) });
    const dupA = item(l, productId, { added_at: at(2), note: 'For the trip', offer_id: offerId, price_when_saved: 18900 });
    const dupB = item(l, productId, { added_at: at(3), note: 'Later note' });
    await db().insertInto('items').values([keeper, dupA, dupB]).execute();
    const keptDrop = alert(l, keeper.id, productId, 'price_drop', 1);
    const extraDrop = alert(l, dupA.id, productId, 'price_drop', 2);
    const stock = alert(l, dupB.id, productId, 'back_in_stock', 3);
    const removed = { ...alert(l, dupB.id, productId, 'price_drop', 4), state: 'removed' };
    await db().insertInto('alerts').values([keptDrop, extraDrop, stock, removed]).execute();

    await k.exec(`begin;\n${m0002ItemKeyNullsNotDistinct.sql}\ncommit;`);

    const items = await db().selectFrom('items').select(['id', 'note', 'offer_id', 'price_when_saved']).where('list_id', '=', l.id).execute();
    expect(items).toEqual([{ id: keeper.id, note: 'For the trip', offer_id: offerId, price_when_saved: 18900 }]);
    const alerts = await db().selectFrom('alerts').select(['id', 'item_id', 'state']).where('customer_id', '=', l.customerId).execute();
    const byId = new Map(alerts.map((a: any) => [a.id, a]));
    expect(byId.get(keptDrop.id)).toMatchObject({ item_id: keeper.id, state: 'active' });
    expect(byId.get(extraDrop.id)).toMatchObject({ item_id: null, state: 'removed' });
    expect(byId.get(stock.id)).toMatchObject({ item_id: keeper.id, state: 'active' });
    expect(byId.get(removed.id)).toMatchObject({ item_id: null, state: 'removed' });

    const indexes = await k.kysely.selectFrom('pg_indexes').select('indexname').where('schemaname', '=', 'wishlist').where('tablename', '=', 'items').execute();
    expect(indexes.map((i: any) => i.indexname)).toContain('items_key_idx');
    expect(indexes.map((i: any) => i.indexname)).not.toContain('items_old_key_idx');
    const err = await db()
      .insertInto('items')
      .values(item(l, productId))
      .execute()
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('23505');
  });
});
