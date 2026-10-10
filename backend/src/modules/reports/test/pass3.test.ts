/** Pass 3: refunds split per seller with after_payout (D5), event-only read models refuse rebuilds */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import { splitRefund } from '../domain/rules.js';
import { harness, usd, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

const refundRows = async (refundId: string) =>
  (await (h.app.kernel.database.kysely.withSchema('reports') as any).selectFrom('fact_refunds').selectAll().where('refund_id', '=', refundId).orderBy('amount_minor', 'desc').execute()).map((r: any) => ({ sellerId: r.seller_id, ownerType: r.owner_type, amount: Number(r.amount_minor), afterPayout: r.after_payout }));

describe('refunds over several sellers (D5)', () => {
  it('splitRefund: named items to their sellers, the rest by item amounts, shares add up exactly', () => {
    const a = 'a';
    const b = 'b';
    expect([...splitRefund(6000, [{ sellerId: a, amount: 2000 }], [{ sellerId: a, weight: 10000 }, { sellerId: b, weight: 30000 }])]).toEqual([[a, 3000], [b, 3000]]);
    const odd = splitRefund(1000, [], [{ sellerId: a, weight: 1 }, { sellerId: b, weight: 2 }]);
    expect(odd.get(a)! + odd.get(b)!).toBe(1000);
    expect(splitRefund(500, [{ sellerId: a, amount: 400 }, { sellerId: b, amount: 400 }], [])).toEqual(new Map([[a, 250], [b, 250]]));
  });

  it('bug (pass 3): a multi-seller refund went to the first seller with after_payout false; now one row per seller', async () => {
    const sellerA = newId();
    const sellerB = newId();
    const oa = h.order({ sellerId: sellerA, items: [{ unit: 10000, shipping: 0, tax: 0 }] });
    const ob = h.order({ sellerId: sellerB, items: [{ unit: 30000, shipping: 0, tax: 0 }] });
    const official = h.order({ sellerId: null, items: [{ unit: 0, shipping: 0, tax: 0 }] });
    // one order with both sellers' packages (and an Official Store line worth nothing, which gets no share)
    const o = { ...oa, groups: [...oa.groups, ...ob.groups, ...official.groups] } as typeof oa;
    h.ordersById.set(o.id, o);
    h.placed(o);
    await h.drain();
    const itemA = oa.groups[0]!.items[0]!;
    const itemB = ob.groups[0]!.items[0]!;
    const deliveredAt = h.clock.now().toISOString();
    for (const [g, i, s] of [[oa.groups[0]!, itemA, sellerA], [ob.groups[0]!, itemB, sellerB]] as const) {
      h.publish('orders', 'orders.item.delivered', { orderId: o.id, groupId: g.id, ownerType: 'seller', sellerId: s, itemId: i.id, quantity: 1, deliveredAt, returnWindowEndsAt: deliveredAt, customerId: null, contactEmail: 'ben@example.com' });
    }
    // seller A was paid out after delivery: A's share may already have been paid out
    h.publish('finance', 'finance.payout.paid', { payoutId: newId(), ref: 'PO-1', sellerId: sellerA, amount: usd(7000), paidAt: h.clock.now().toISOString() });
    await h.drain();
    h.clock.advance(60_000);
    const refund = { refundId: newId(), ref: 'RF-2', orderId: o.id, origin: 'return', originId: null, amount: usd(6000), items: [{ orderItemId: itemA.id, title: 'Lamp', groupId: oa.groups[0]!.id, sellerId: sellerA, amount: usd(2000) }], destination: 'card', sentAt: h.clock.now().toISOString() };
    h.publish('payments', 'payments.refund.sent', refund);
    h.publish('payments', 'payments.refund.sent', refund);
    await h.drain();
    expect(await refundRows(refund.refundId)).toEqual([
      { sellerId: sellerA, ownerType: 'seller', amount: 3000, afterPayout: true },
      { sellerId: sellerB, ownerType: 'seller', amount: 3000, afterPayout: false },
    ]);
    // counted as one refund
    const refunds = await h.call('POST', '/api/admin/reports/reports/commerce.refunds/query', h.tokens.staff(), { preset: 'today', sellerId: sellerB });
    expect(refunds.body.kpis.find((k: any) => k.metricKey === 'commerce.refunds')).toMatchObject({ value: 3000 });
  });

  it('an Official Store refund carries OFFICIAL_STORE_ID', async () => {
    const o = h.order({ sellerId: null, items: [{ unit: 5000 }] });
    h.placed(o);
    await h.drain();
    const refund = { refundId: newId(), ref: 'RF-3', orderId: o.id, origin: 'return', originId: null, amount: usd(5000), items: [{ orderItemId: o.groups[0]!.items[0]!.id, title: 'Lamp', groupId: o.groups[0]!.id, sellerId: null, amount: usd(5000) }], destination: 'card', sentAt: h.clock.now().toISOString() };
    h.publish('payments', 'payments.refund.sent', refund);
    await h.drain();
    expect(await refundRows(refund.refundId)).toEqual([{ sellerId: OFFICIAL_STORE_ID, ownerType: 'official', amount: 5000, afterPayout: false }]);
  });
});

describe('read model rebuilds', () => {
  it('event-only read models say so and refuse a rebuild (REBUILD_UNAVAILABLE)', async () => {
    const list = (await h.call('GET', '/api/admin/reports/read-models', h.tokens.staff())).body;
    expect(list.find((m: any) => m.key === 'refunds')).toMatchObject({ rebuildable: false, rebuildNote: expect.stringContaining('events only') });
    expect(list.find((m: any) => m.key === 'order_items')).toMatchObject({ rebuildable: true, rebuildNote: expect.stringContaining('orders') });
    for (const key of ['refunds', 'returns', 'service']) {
      const res = await h.call('POST', `/api/admin/reports/read-models/${key}/rebuild`, h.tokens.staff(), { reason: 'x' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('REBUILD_UNAVAILABLE');
    }
  });
});
