/**
 * The repository's aggregates on MongoDB, pinned by hand-computed figures: market-time buckets (day, week from
 * Monday, month) across the end of daylight saving time, distinct orders and buyers, costed sales, the row order of
 * grouped figures (keys ascending, null last), one row of zeros for an ungrouped total over nothing, daily counters
 * (json counters merged, open cases carried to the next day) and the case backlog.
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

const TZ = 'America/Los_Angeles';
const table = (name: string) => h.app.kernel.mongo.module('reports', spec.collections, schemas).table<any>(name);

function fact(over: Partial<OrderItemFact> & { placed_at: Date }): OrderItemFact {
  return {
    order_item_id: newId(),
    order_id: newId(),
    owner_type: 'seller',
    seller_id: newId(),
    customer_key: 'c-x',
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

describe('salesAgg', () => {
  const productId = newId();
  const range = { basis: 'placed_at' as const, start: new Date('2026-10-20T00:00:00Z'), end: new Date('2026-11-10T00:00:00Z'), timeZone: TZ, productId };

  beforeAll(async () => {
    const [o1, o2, o3] = [newId(), newId(), newId()];
    await repo.insertOrderItems([
      // Sat 31 Oct 23:30 PDT
      fact({ order_id: o1, product_id: productId, customer_key: 'c-x', placed_at: new Date('2026-11-01T06:30:00Z'), quantity: 2, item_minor: 4000, buying_cost_minor: 2500 }),
      fact({ order_id: o1, product_id: productId, customer_key: 'c-x', placed_at: new Date('2026-11-01T06:30:00Z'), item_minor: 1000 }),
      // Sun 1 Nov 01:30 PDT (an hour before the clocks go back)
      fact({ order_id: o2, product_id: productId, customer_key: 'c-x', placed_at: new Date('2026-11-01T08:30:00Z'), item_minor: 3000, tax_minor: 240 }),
      // Mon 2 Nov 01:00 PST
      fact({ order_id: o3, product_id: productId, customer_key: 'c-y', placed_at: new Date('2026-11-02T09:00:00Z'), item_minor: 500, discount_platform_minor: 100, discount_seller_minor: 50 }),
    ]);
  });

  it('totals: distinct orders and buyers, units, costed sales and cost', async () => {
    expect(await repo.salesAgg(range, 'none')).toEqual([
      { key: null, gross: 8500, tax: 240, cancelled: 0, refunded: 0, orders: 3, units: 5, costedSales: 4000, cost: 2500, buyers: 2, platformDiscount: 100, sellerDiscount: 50 },
    ]);
  });

  it('buckets by market day, week from Monday and month', async () => {
    const pick = (rows: Awaited<ReturnType<ReportsRepository['salesAgg']>>) => rows.map((r) => [r.key, r.gross, r.orders]);
    expect(pick(await repo.salesAgg(range, 'bucket', 'day'))).toEqual([['2026-10-31', 5000, 1], ['2026-11-01', 3000, 1], ['2026-11-02', 500, 1]]);
    expect(pick(await repo.salesAgg(range, 'bucket', 'week'))).toEqual([['2026-10-26', 8000, 2], ['2026-11-02', 500, 1]]);
    expect(pick(await repo.salesAgg(range, 'bucket', 'month'))).toEqual([['2026-10-01', 5000, 1], ['2026-11-01', 3500, 2]]);
  });

  it('groups ascending with null last; an ungrouped total over nothing is one row of zeros', async () => {
    const categoryId = newId();
    const [a, b] = ['00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000bb'];
    const at = new Date('2026-10-21T18:00:00Z');
    await repo.insertOrderItems([
      fact({ category_id: categoryId, owner_type: 'official', seller_id: null, placed_at: at, item_minor: 700 }),
      fact({ category_id: categoryId, seller_id: b, placed_at: at, item_minor: 200 }),
      fact({ category_id: categoryId, seller_id: a, placed_at: at, item_minor: 300 }),
    ]);
    const f = { ...range, productId: undefined, categoryId };
    expect((await repo.salesAgg(f, 'seller_id')).map((r) => [r.key, r.gross])).toEqual([[a, 300], [b, 200], [null, 700]]);
    expect((await repo.salesAgg(f, 'owner_type')).map((r) => [r.key, r.gross])).toEqual([['official', 700], ['seller', 500]]);
    expect(await repo.salesAgg({ ...f, categoryId: newId() }, 'none')).toEqual([
      { key: null, gross: 0, tax: 0, cancelled: 0, refunded: 0, orders: 0, units: 0, costedSales: 0, cost: 0, buyers: 0, platformDiscount: 0, sellerDiscount: 0 },
    ]);
    expect(await repo.salesAgg({ ...f, categoryId: newId() }, 'seller_id')).toEqual([]);
  });
});

describe('daily counters', () => {
  it('bumpService carries open cases from the previous day and merges json counters; caseBacklog sums each seller\'s latest day', async () => {
    const seller = newId();
    await repo.bumpService(seller, '2026-10-05', { cases_opened: 3, cases_open_eod: 3 }, 'late_delivery');
    await repo.bumpService(seller, '2026-10-05', { cases_opened: 1, cases_open_eod: 1 }, 'late_delivery');
    await repo.bumpService(seller, '2026-10-07', { cases_open_eod: -5 }, 'damaged');
    const rows = await table('fact_service_daily').find({ seller_id: seller }, { sort: { day: 1 } });
    expect(rows.map((r) => [r.day, r.cases_opened, r.cases_open_eod, r.complaints_by_category])).toEqual([
      ['2026-10-05', 4, 4, { late_delivery: 2 }],
      ['2026-10-07', 0, -1, { damaged: 1 }],
    ]);
    expect(await repo.caseBacklog('2026-10-06', seller)).toBe(4);
    expect(await repo.caseBacklog('2026-10-07', seller)).toBe(0);

    await repo.bumpDaily('fact_campaigns_daily', { campaign_kind: 'promotion', campaign_id: seller, day: '2026-10-05' }, { redemptions: 1, sales_minor: 900 }, {}, { column: 'funded_by', add: { platform: 500 } });
    await repo.bumpDaily('fact_campaigns_daily', { campaign_kind: 'promotion', campaign_id: seller, day: '2026-10-05' }, { redemptions: 1, sales_minor: 100 }, {}, { column: 'funded_by', add: { platform: 50, seller: 25 } });
    const sums = await repo.dailySums('fact_campaigns_daily', { from: '2026-10-01', to: '2026-10-31', campaignKind: 'promotion' }, ['redemptions', 'sales_minor'], 'campaign');
    expect(sums.find((s) => s.key === `promotion:${seller}`)).toEqual({ key: `promotion:${seller}`, redemptions: 2, sales_minor: 1000 });
    const [doc] = await table('fact_campaigns_daily').find({ campaign_id: seller });
    expect(doc!.funded_by).toEqual({ platform: 550, seller: 25 });
  });
});
