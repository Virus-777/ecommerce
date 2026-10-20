/**
 * A seller's product cost in the order facts (docs/09 §3.3): the unit cost in force when the order was placed
 * (offers.unitCostsAt), re-costed when the seller changes a cost (offers.offer.cost_changed: rows from the day the
 * cost starts, a later cost kept), costed again by a rebuild, and the cost in force now in Profit by product.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { marketDay } from '../domain/rules.js';
import { harness, usd, type Harness } from './harness.js';

let h: Harness;
const DAY = 86_400_000;
const S = newId();
const OFFER = newId();
const PRODUCT = newId();
const at = (daysAgo: number) => new Date(h.clock.now().getTime() - daysAgo * DAY);
const fact = async (itemId: string) => (await h.service.core.repo.getOrderItemsByIds([itemId]))[0];

/** A seller order of `quantity` units of OFFER placed `daysAgo` days ago, as orders publishes it */
async function sold(daysAgo: number, quantity = 1) {
  const o = h.order({ sellerId: S, placedAt: at(daysAgo).toISOString(), items: [{ offerId: OFFER, productId: PRODUCT, quantity, unit: 5_000, shipping: 0, tax: 0 }] });
  h.placed(o);
  await h.drain();
  return o.groups[0]!.items[0]!.id;
}

beforeAll(async () => {
  h = await harness();
  h.products.set(PRODUCT, { title: 'Clay vase' });
});
afterAll(async () => {
  await h?.app.close();
});

describe('seller unit costs in the order facts', () => {
  let early: string;
  let late: string;

  it('a seller row gets the unit cost in force when the order was placed, times the quantity', async () => {
    h.offerCosts.set(OFFER, [
      { from: at(10).toISOString(), amount: 1_000 },
      { from: at(2).toISOString(), amount: 1_200 },
    ]);
    early = await sold(5, 2);
    late = await sold(1, 1);
    expect((await fact(early))?.buying_cost_minor).toBe(2_000);
    expect((await fact(late))?.buying_cost_minor).toBe(1_200);
    // an offer without a cost: no product cost
    const o = h.order({ sellerId: S, items: [{ unit: 1_000, tax: 0 }] });
    h.placed(o);
    await h.drain();
    expect((await fact(o.groups[0]!.items[0]!.id))?.buying_cost_minor).toBeNull();
  });

  it('a cost change re-costs the rows from the day it starts and keeps a later cost', async () => {
    // the seller corrects the first cost (900 from ten days ago); the cost from two days ago stays 1,200
    h.offerCosts.set(OFFER, [
      { from: at(10).toISOString(), amount: 900 },
      { from: at(2).toISOString(), amount: 1_200 },
    ]);
    const tz = (await h.service.core.cfg()).timeZone;
    const payload = { offerId: OFFER, sellerId: S, productId: PRODUCT, unitCost: usd(900), effectiveFrom: marketDay(at(10), tz) };
    h.publish('offers', 'offers.offer.cost_changed', payload);
    await h.drain();
    expect((await fact(early))?.buying_cost_minor).toBe(1_800);
    expect((await fact(late))?.buying_cost_minor).toBe(1_200);
    // the same event again changes nothing
    h.publish('offers', 'offers.offer.cost_changed', payload);
    await h.drain();
    expect((await fact(early))?.buying_cost_minor).toBe(1_800);
  });

  it('a cost from a later day does not touch earlier rows', async () => {
    h.offerCosts.set(OFFER, [
      { from: at(10).toISOString(), amount: 900 },
      { from: at(2).toISOString(), amount: 1_300 },
    ]);
    const tz = (await h.service.core.cfg()).timeZone;
    h.publish('offers', 'offers.offer.cost_changed', { offerId: OFFER, sellerId: S, productId: PRODUCT, unitCost: usd(1_300), effectiveFrom: marketDay(at(2), tz) });
    await h.drain();
    expect((await fact(early))?.buying_cost_minor).toBe(1_800);
    expect((await fact(late))?.buying_cost_minor).toBe(1_300);
  });

  it('Profit by product shows the unit cost in force now', async () => {
    const res = await h.call('POST', `/api/seller/reports/reports/seller.profit_by_product/query`, h.tokens.seller(S), { preset: 'last_30_days' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.table.rows.find((r: { offerId: string }) => r.offerId === OFFER)).toMatchObject({ product: 'Clay vase', units: 3, productCost: usd(1_800 + 1_300), costSet: true, unitCost: usd(1_300) });
  });

  it('a rebuild of the order facts costs the seller rows again from offers', async () => {
    h.offerCosts.set(OFFER, [{ from: at(30).toISOString(), amount: 700 }]);
    const res = await h.call('POST', '/api/admin/reports/read-models/order_items/rebuild', h.tokens.staff(), { reason: 'Costs changed' });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    await h.app.kernel.jobs.runNow('reports.check-lag');
    expect((await fact(early))?.buying_cost_minor).toBe(1_400);
    expect((await fact(late))?.buying_cost_minor).toBe(700);
  });
});
