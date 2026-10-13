/**
 * Gap pass 3: daily sales from orders events (placed adds, cancelled subtracts, both once), the nightly 30-day
 * sum and 90-day prune, transit days as a setting, onSale on the facets context, audit entries and the ad
 * privacy context passed to advertising.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { spec, type SearchDb } from '../../../spec/search.js';
import { schemas } from '../schema.js';
import { boot, callers, newId, STORE, ADMIN, type Kit } from './helpers.js';

let k: Kit;
const table = <T extends keyof SearchDb & string>(name: T) => k.app.kernel.mongo.module('search', spec.collections, schemas).table<SearchDb[T]>(name);
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});

const today = () => dateInZone(new Date(), k.app.kernel.config.market.timeZone);
const daysAgo = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const placedEvent = (orderId: string) => ({ orderId, ref: 'MK-261010-00001', checkoutSessionId: newId(), customerId: null, guestEmail: 'g@example.com', paymentIntentId: newId(), paymentState: 'accepted', total: { amount: 1000, currency: 'USD' }, couponCodes: [], groups: [], placedAt: new Date().toISOString(), attemptNo: 1, contactName: 'Guest Shopper' });
const cancelledEvent = (orderId: string) => ({ orderId, ref: 'MK-261010-00001', reason: 'payment_declined', checkoutSessionId: newId() });
const dailyRows = (productId: string) => table('product_sales_daily').find({ product_id: productId }, { sort: { day: 1 } });
const sales30 = async (productId: string) => (await table('search_documents').get(productId))!.sales_30d;

async function listed(title: string) {
  const cat = k.world.category(`Cat ${newId().slice(-6)}`);
  const p = k.world.product({ title, categoryId: cat.id });
  const offer = k.world.offer(p.id, { price: 2500, sellerId: null });
  await k.index(p.id);
  return { p, cat, offer };
}

describe('daily sales (product_sales_daily)', () => {
  it('orders.order.placed adds units on the placed day once; orders.order.cancelled takes them off once', async () => {
    const { p } = await listed('Cast iron skillet');
    const orderId = newId();
    k.world.orders.set(orderId, [{ productId: p.id, quantity: 3 }]);
    await k.emit('orders', 'orders.order.placed', placedEvent(orderId));
    await k.emit('orders', 'orders.order.placed', placedEvent(orderId)); // redelivered: counted once
    expect(await dailyRows(p.id)).toEqual([expect.objectContaining({ day: today(), units: 3, orders: 1 })]);
    expect(await sales30(p.id)).toBe(3);

    await k.emit('orders', 'orders.order.cancelled', cancelledEvent(orderId));
    await k.emit('orders', 'orders.order.cancelled', cancelledEvent(orderId));
    expect(await dailyRows(p.id)).toEqual([expect.objectContaining({ units: 0, orders: 0 })]);
    expect(await sales30(p.id)).toBe(0);
  });

  it('a cancellation that arrives before the placement means the order never counts', async () => {
    const { p } = await listed('Enamel kettle');
    const orderId = newId();
    k.world.orders.set(orderId, [{ productId: p.id, quantity: 2 }]);
    await k.emit('orders', 'orders.order.cancelled', cancelledEvent(orderId));
    await k.emit('orders', 'orders.order.placed', placedEvent(orderId));
    expect(await dailyRows(p.id)).toEqual([]);
  });

  it('search.sales-counts sums the last 30 days into sales_30d and deletes rows older than 90 days', async () => {
    const { p } = await listed('Stoneware mug');
    const at = new Date();
    await table('product_sales_daily').insertMany([
      { product_id: p.id, day: daysAgo(0), units: 4, orders: 2, updated_at: at },
      { product_id: p.id, day: daysAgo(29), units: 6, orders: 1, updated_at: at },
      { product_id: p.id, day: daysAgo(40), units: 50, orders: 5, updated_at: at },
      { product_id: p.id, day: daysAgo(120), units: 70, orders: 7, updated_at: at },
    ]);
    await k.job('search.sales-counts');
    expect(await sales30(p.id)).toBe(10);
    expect((await dailyRows(p.id)).map((r) => r.day)).toEqual([daysAgo(40), daysAgo(29), daysAgo(0)]);
  });
});

describe('settings, context, audit and ads', () => {
  it('onSale narrows the facets context like GET /products', async () => {
    const a = await listed('Linen apron');
    const cat = a.cat;
    const b = k.world.product({ title: 'Linen tea towel', categoryId: cat.id });
    const bOffer = k.world.offer(b.id, { price: 1500, sellerId: null });
    k.world.promos.set(bOffer.id, { price: 1200, regular: 1500, endsAt: new Date(Date.now() + 86_400_000).toISOString() });
    await k.index(b.id);
    const all = await k.call('GET', `${STORE}/facets?q=linen`);
    expect(all.body.total).toBe(2);
    const sale = await k.call('GET', `${STORE}/facets?q=linen&onSale=true`);
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    expect(sale.body.total).toBe(1);
  });

  it('writes audit entries for synonym changes when audit is enabled', async () => {
    const created = await k.call('POST', `${ADMIN}/synonyms`, k.staff, { terms: ['sofa', 'couch'], kind: 'equivalent', note: 'Furniture' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(k.world.audits.at(-1)).toMatchObject({ action: 'search.synonym.create', module: 'search', target: { type: 'synonym', id: created.body.id } });
  });

  it('passes personalizationAllowed and customerId to advertising.sponsoredForResults', async () => {
    await listed('Walnut cutting board');
    await k.call('GET', `${STORE}/products?q=walnut`);
    expect(k.world.sponsoredCalls.at(-1)).toMatchObject({ personalizationAllowed: false });
    expect((k.world.sponsoredCalls.at(-1) as { customerId?: string }).customerId).toBeUndefined();

    const accountId = newId();
    const customerId = newId();
    k.world.customers.set(accountId, { id: customerId, recentSearches: false, personalized: true });
    await k.call('GET', `${STORE}/products?q=walnut`, callers.customer({ accountId }));
    expect(k.world.sponsoredCalls.at(-1)).toMatchObject({ personalizationAllowed: true, customerId });

    k.world.customers.set(accountId, { id: customerId, recentSearches: false, personalized: false });
    await k.call('GET', `${STORE}/products?q=walnut`, callers.customer({ accountId }));
    expect(k.world.sponsoredCalls.at(-1)).toMatchObject({ personalizationAllowed: false, customerId });
  });
});

describe('transitBusinessDays', () => {
  it('arrives-by and delivery cues use dispatch days + the transit setting', async () => {
    const fast = await boot({ settings: { transitBusinessDays: 0 } });
    try {
      for (const kit of [k, fast]) {
        const cat = kit.world.category('Kettles');
        const p = kit.world.product({ title: 'Speedy kettle', categoryId: cat.id });
        kit.world.offer(p.id, { price: 3000, sellerId: null, dispatchDays: 0, free: true });
        await kit.index(p.id);
      }
      const marketToday = dateInZone(new Date(), fast.app.kernel.config.market.timeZone);
      // transit 0: dispatched today arrives today; the default (3 business days) cannot arrive today
      const quick = await fast.call('GET', `${STORE}/products?q=speedy+kettle&arrivesBy=${marketToday}`);
      expect(quick.body.items.filter((h: any) => h.kind === 'organic')).toHaveLength(1);
      const slow = await k.call('GET', `${STORE}/products?q=speedy+kettle&arrivesBy=${marketToday}`);
      expect(slow.body.items.filter((h: any) => h.kind === 'organic')).toHaveLength(0);
      const cueFast = (await fast.call('GET', `${STORE}/products?q=speedy+kettle`)).body.items[0].product.deliveryCue;
      const cueDefault = (await k.call('GET', `${STORE}/products?q=speedy+kettle`)).body.items[0].product.deliveryCue;
      expect(cueFast).toMatch(/^Free delivery /);
      expect(cueDefault).toMatch(/^Free delivery /);
      expect(cueFast).not.toBe(cueDefault);
    } finally {
      await fast.close();
    }
  });
});
