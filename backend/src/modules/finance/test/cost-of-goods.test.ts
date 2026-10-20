/**
 * The cost of goods sold of Official Store items (2026-10-21): finance books a cost_of_goods trading entry with each
 * Official Store sale (inventory's unit cost × quantity), reverses it in proportion on cancellation, counts sales
 * without a cost as uncosted, and GET /trading takes the margin from it. The buying cost purchasing books when goods
 * are received is stock bought: it never moves the margin. Sales booked before cost_of_goods existed get theirs from
 * the migration's placeholders and fillPendingCosts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { costOfGoodsPending } from '../migrations.js';
import { ADMIN, boot, USD, type FakeOrder, type Kit } from './helpers.js';

let k: Kit;
/** inventory.getUnitCost answers from here (minor units per stock item); other stock items have no cost */
const unitCosts = new Map<string, number>();
const today = () => k.svc.core.today();
const trading = async () => {
  const r = await k.call('GET', `${ADMIN}/trading?from=${today()}&to=${today()}`, k.staff);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const amounts = (t: any) => ({ sales: t.productSales.amount, cogs: t.costOfGoodsSold.amount, uncosted: t.uncostedSales.amount, stock: t.stockBought.amount, gross: t.grossMargin.amount, net: t.netMargin.amount, buying: t.buyingCost.amount, dayMargin: t.daily.at(-1).margin.amount });
const diff = (a: ReturnType<typeof amounts>, b: ReturnType<typeof amounts>) => Object.fromEntries(Object.entries(b).map(([key, v]) => [key, v - a[key as keyof typeof a]]));
const entries = (orderId: string) => k.svc.core.repo.find('trading_entries', { order_id: orderId, kind: 'cost_of_goods' });
const cancel = (ord: FakeOrder, itemId: string, quantity: number, itemAmount: number, cancellationId = newId()) =>
  k.emit('orders.item.cancelled', { orderId: ord.id, ref: ord.ref, groupId: ord.groups[0]!.id, ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', itemId, offerId: newId(), stockItemId: newId(), quantity, cancellationId, initiatedBy: 'customer', reasonCode: 'changed_mind', beforeDispatch: true, countsAgainstSeller: false, refund: { itemAmount: USD(itemAmount), discountShare: USD(0), shippingRefund: USD(0), taxRefund: USD(0), total: USD(itemAmount) }, paymentIntentId: newId(), trustReportId: null, notifyCustomer: true });
/** An Official Store order of one line whose stock item costs `unit` (null: no cost) */
const officialOrder = (price: number, quantity: number, unit: number | null) => {
  const stockItemId = newId();
  if (unit !== null) unitCosts.set(stockItemId, unit);
  return k.order(null, [{ title: 'Marketly kettle', quantity, price, stockItemId }]);
};

beforeAll(async () => {
  k = await boot({ apiStubs: { inventory: { getUnitCost: async (id: string) => (unitCosts.has(id) ? USD(unitCosts.get(id)!) : null) } as any } });
});
afterAll(async () => {
  await k?.close();
});

describe('cost of goods sold', () => {
  it('books unit cost × quantity with an Official Store sale and takes it off the margin', async () => {
    const before = amounts(await trading());
    const ord = officialOrder(4_000, 3, 1_500);
    await k.accept(ord);
    await k.accept(ord); // redelivered: nothing twice
    const item = ord.groups[0]!.items[0]!;
    expect(await entries(ord.id)).toEqual([expect.objectContaining({ amount: 4_500, order_item_id: item.id, ref_kind: 'order_item', ref_id: item.id })]);
    const after = await trading();
    expect(diff(before, amounts(after))).toEqual({ sales: 12_000, cogs: 4_500, uncosted: 0, stock: 0, gross: 7_500, net: 7_500, buying: 4_500, dayMargin: 7_500 });
    expect(after.costBasis).toMatch(/weighted average/);
  });

  it('reverses the cost in proportion on cancellation, also on a line split off the sold one', async () => {
    const ord = officialOrder(2_000, 4, 900);
    await k.accept(ord);
    const sold = ord.groups[0]!.items[0]!;
    // the line was split: one unit moved to a new line, which is then cancelled
    const split = { ...sold, id: newId(), quantity: 1, splitFromItemId: sold.id };
    ord.groups[0]!.items.push(split);
    const before = amounts(await trading());
    const cancellationId = newId();
    await cancel(ord, split.id, 1, 2_000, cancellationId);
    await cancel(ord, split.id, 1, 2_000, cancellationId); // redelivered
    await cancel(ord, sold.id, 1, 2_000); // another unit, on the sold line itself
    const rows = await entries(ord.id);
    expect(rows.filter((r) => r.ref_kind === 'cancellation').map((r) => r.amount)).toEqual([-900, -900]);
    expect(diff(before, amounts(await trading()))).toMatchObject({ sales: -4_000, cogs: -1_800, uncosted: 0, gross: -2_200 });
  });

  it('books nothing when inventory has no cost and counts the sale as uncosted', async () => {
    const before = amounts(await trading());
    const ord = officialOrder(5_000, 2, null);
    await k.accept(ord);
    expect(await entries(ord.id)).toEqual([]);
    await cancel(ord, ord.groups[0]!.items[0]!.id, 1, 5_000);
    expect(await entries(ord.id)).toEqual([]);
    // the cancellation comes off the uncosted sales too
    expect(diff(before, amounts(await trading()))).toMatchObject({ sales: 5_000, cogs: 0, uncosted: 5_000, gross: 5_000 });
  });

  it('a goods receipt raises stock bought and leaves the margin alone', async () => {
    const before = amounts(await trading());
    // what purchasing books when goods are received from a supplier
    await k.svc.recordCompanyCost({ kind: 'buying_cost', amount: USD(124_200), reference: { kind: 'receipt', id: newId(), ref: 'GR-1' }, at: k.clock.now().toISOString() });
    expect(diff(before, amounts(await trading()))).toEqual({ sales: 0, cogs: 0, uncosted: 0, stock: 124_200, gross: 0, net: 0, buying: 0, dayMargin: 0 });
    // and it is no cost of goods in the company costs reports read
    const costs = await k.svc.companyCostsByDay({ from: today(), to: today() });
    expect(costs.map((c) => c.kind)).not.toContain('cost_of_goods');
  });
});

describe('cost_of_goods backfill (migration 2026-10-21-cost-of-goods-pending + fillPendingCosts)', () => {
  it('fills the cost of sales booked before cost_of_goods existed, reverses their cancellations, and is safe to run twice', async () => {
    const db = k.app.kernel.mongo.db;
    const costed = officialOrder(3_000, 2, 1_000);
    const uncosted = officialOrder(7_000, 1, null);
    await k.accept(costed);
    await k.accept(uncosted);
    const line = costed.groups[0]!.items[0]!;
    await cancel(costed, line.id, 1, 3_000);
    const reference = amounts(await trading());
    // as before cost_of_goods existed: the sales and the cancellation without their cost rows
    await k.svc.core.repo.removeWhere('trading_entries', { order_id: [costed.id, uncosted.id], kind: 'cost_of_goods' });
    // a later unit cost: the backfill uses the cost when it runs
    unitCosts.set(line.stockItemId!, 1_100);
    await costOfGoodsPending.up(db);
    await costOfGoodsPending.up(db);
    const pending = await k.svc.core.repo.find('trading_entries', { kind: 'cost_of_goods', ref_kind: 'cost_pending' });
    expect(pending.filter((p) => [costed.id, uncosted.id].includes(p.order_id!)).map((p) => p.amount)).toEqual([0, 0]);
    // while waiting, the sales count as uncosted
    expect(amounts(await trading()).uncosted - reference.uncosted).toBe(3_000);

    expect(await k.svc.ledger.fillPendingCosts()).toBeGreaterThanOrEqual(1);
    await k.svc.ledger.fillPendingCosts();
    expect((await entries(costed.id)).map((r) => [r.ref_kind, r.amount]).sort()).toEqual([['cancellation', -1_100], ['order_item', 2_200]]);
    expect(await entries(uncosted.id)).toEqual([]);
    expect(await k.svc.core.repo.count('trading_entries', { kind: 'cost_of_goods', ref_kind: 'cost_pending' })).toBe(0);
    expect(diff(reference, amounts(await trading()))).toMatchObject({ sales: 0, cogs: 1_100 - 1_000, uncosted: 0 });
  });

  it('keeps the placeholder of an order it cannot read for the next start', async () => {
    const ord = officialOrder(1_000, 1, 400);
    await k.accept(ord);
    await k.svc.core.repo.removeWhere('trading_entries', { order_id: ord.id, kind: 'cost_of_goods' });
    await costOfGoodsPending.up(k.app.kernel.mongo.db);
    k.orders.delete(ord.id); // orders.getOrder does not find it
    await k.svc.ledger.fillPendingCosts();
    expect((await entries(ord.id)).map((r) => [r.ref_kind, r.amount])).toEqual([['cost_pending', 0]]);
    k.orders.set(ord.id, ord);
    await k.svc.ledger.fillPendingCosts();
    expect((await entries(ord.id)).map((r) => [r.ref_kind, r.amount])).toEqual([['order_item', 400]]);
  });
});
