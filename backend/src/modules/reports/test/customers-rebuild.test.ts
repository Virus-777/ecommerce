/**
 * The customers read model rebuild works in keyset batches of customers. Over more customers than one batch it must
 * write the rows the single aggregation it replaced wrote (pinned here as that aggregation), drop buyers without
 * item facts and correct rows that drifted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { spec } from '../../../spec/reports.js';
import { schemas } from '../schema.js';
import type { OrderItemFact } from '../ports.js';
import type { ReportsRepository } from '../repository.js';
import { harness, type Harness } from './harness.js';

let h: Harness;
let repo: ReportsRepository;
beforeAll(async () => {
  h = await harness();
  repo = h.service.core.repo;
});
afterAll(async () => {
  await h?.app.close();
});

const table = (name: string) => h.app.kernel.mongo.module('reports', spec.collections, schemas).table<any>(name);

function fact(over: Partial<OrderItemFact> & { customer_key: string; order_id: string; placed_at: Date }): OrderItemFact {
  return {
    order_item_id: newId(),
    owner_type: 'seller',
    seller_id: newId(),
    category_id: null,
    product_id: newId(),
    offer_id: newId(),
    quantity: 1,
    item_minor: 1000,
    shipping_minor: 0,
    discount_platform_minor: 0,
    discount_seller_minor: 0,
    tax_minor: 0,
    currency: 'USD',
    paid_at: null,
    shipped_at: null,
    delivered_at: null,
    completed_at: null,
    cancelled_at: null,
    cancelled_by: null,
    cancelled_minor: 0,
    refunded_minor: 0,
    last_refund_at: null,
    buying_cost_minor: null,
    accepted_at: over.placed_at,
    group_id: null,
    fulfilled_by: 'seller',
    ...over,
  } as OrderItemFact;
}

/** The rows the rebuild wrote before it was batched: one aggregation over every item fact */
async function singleAggregation() {
  const rows = await table('fact_order_items').aggregate<{ _id: string; first_order_at: Date; last_order_at: Date; orders: number; net_spend_minor: number }>([
    {
      $group: {
        _id: { k: '$customer_key', o: '$order_id' },
        first_order_at: { $min: '$placed_at' },
        last_order_at: { $max: '$placed_at' },
        net: { $sum: { $subtract: [{ $add: ['$item_minor', '$shipping_minor', '$tax_minor'] }, { $add: ['$cancelled_minor', '$refunded_minor'] }] } },
      },
    },
    { $group: { _id: '$_id.k', first_order_at: { $min: '$first_order_at' }, last_order_at: { $max: '$last_order_at' }, orders: { $sum: 1 }, net_spend_minor: { $sum: '$net' } } },
  ]);
  return rows.map((r) => ({ customer_key: r._id, first_order_at: r.first_order_at, last_order_at: r.last_order_at, orders: r.orders, net_spend_minor: r.net_spend_minor })).sort((a, b) => (a.customer_key < b.customer_key ? -1 : 1));
}

const stored = async () => (await table('fact_customers').find({}, { sort: { customer_key: 1 } })).map(({ _lock, ...r }: Record<string, unknown>) => r);

describe('customers rebuild in batches', () => {
  beforeAll(async () => {
    const facts: OrderItemFact[] = [];
    const base = Date.parse('2026-09-01T12:00:00Z');
    // 11 customers: some with several orders, orders with several items (one customer's items exceed a batch),
    // cancellations, refunds, shipping and tax
    for (let c = 0; c < 11; c++) {
      const key = `c-${String(c).padStart(2, '0')}`;
      for (let o = 0; o <= c % 3; o++) {
        const orderId = newId();
        const items = c === 4 ? 5 : 1 + (o % 2);
        for (let i = 0; i < items; i++) facts.push(fact({ customer_key: key, order_id: orderId, placed_at: new Date(base + (c * 7 + o) * 86_400_000 + i * 60_000), item_minor: 1000 + c * 10 + i, shipping_minor: o * 100, tax_minor: i * 5, cancelled_minor: c === 5 && o === 0 ? 1000 : 0, refunded_minor: c === 7 ? 200 : 0 }));
      }
    }
    await repo.insertOrderItems(facts);
    // rows the rebuild must correct or drop: a drifted buyer, and buyers without item facts before, between and after
    const customers = table('fact_customers');
    const at = new Date(base);
    await customers.insertMany([
      { customer_key: 'c-03', first_order_at: at, last_order_at: at, orders: 99, net_spend_minor: 1 },
      { customer_key: 'a-gone', first_order_at: at, last_order_at: at, orders: 1, net_spend_minor: 5 },
      { customer_key: 'c-05x', first_order_at: at, last_order_at: at, orders: 1, net_spend_minor: 5 },
      { customer_key: 'z-gone', first_order_at: at, last_order_at: at, orders: 1, net_spend_minor: 5 },
    ]);
  });

  it('batches of 3 item facts (many batches) write the rows of the single aggregation and drop the others', async () => {
    const want = await singleAggregation();
    expect(want).toHaveLength(11);
    expect(await repo.rebuildCustomers(3)).toBe(11);
    expect(await stored()).toEqual(want);
  });

  it('the default batch gives the same rows, and a rebuild with no item facts empties the table', async () => {
    const want = await singleAggregation();
    expect(await repo.rebuildCustomers()).toBe(11);
    expect(await stored()).toEqual(want);
    await table('fact_order_items').deleteMany({});
    expect(await repo.rebuildCustomers(3)).toBe(0);
    expect(await stored()).toEqual([]);
  });
});
