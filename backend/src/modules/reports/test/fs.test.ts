/**
 * Fulfilled by Marketly (fulfillment-service, phase 4): fact_order_items.fulfilled_by, Marketly's dispatches kept in
 * fact_marketly_fulfillment_daily (never the seller's service row), service fees from fulfillment-service fee events,
 * the two seeded metrics, the seller dashboard's service-fees line and the four dataset keys.
 * fulfillment-service itself is off here: its events are published with the contract payloads.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { spec } from '../../../spec/reports.js';
import { schemas } from '../infra/mongo/schema.js';
import { harness, usd, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const kpi = (body: any, key: string) => body.kpis.find((k: any) => k.metricKey === key);
const table = (name: string) => h.app.kernel.mongo.module('reports', spec.collections, schemas).table<any>(name);
const factsOf = async (orderId: string) =>
  (await table('fact_order_items').find({ order_id: orderId })).map((r) => ({ order_item_id: r.order_item_id as string, owner_type: r.owner_type as string, fulfilled_by: r.fulfilled_by as string | null }));
const counters = (r: any) => ({ dispatched: r.dispatched, dispatched_on_time: r.dispatched_on_time, overdue: r.overdue, delivery_exceptions: r.delivery_exceptions });
const serviceRow = async (sellerId: string) => (await table('fact_service_daily').find({ seller_id: sellerId })).map(counters);
const marketlyRow = async (sellerId: string) => (await table('fact_marketly_fulfillment_daily').find({ seller_id: sellerId })).map(counters);
const serviceFees = async (sellerId: string) => (await table('fact_marketplace_finance_daily').find({ seller_id: sellerId })).map((r) => Number(r.service_fees_minor));

function dispatched(o: { id: string; groups: { id: string; items: { id: string }[] }[] }, sellerId: string, fulfilledBy: 'seller' | 'marketly_service', onTime: boolean) {
  const now = h.clock.now().toISOString();
  const g = o.groups[0]!;
  return {
    shipmentId: newId(), kind: 'outbound', orderId: o.id, groupId: g.id, ownerType: 'seller', sellerId, fulfilledBy,
    lines: g.items.map((i) => ({ orderItemId: i.id, title: 'Lamp', variantLabel: 'Silver', quantity: 1 })), shippedAt: now, dispatchDueAt: now, onTime, trackingValid: true,
  };
}

describe('fact_order_items.fulfilled_by', () => {
  it('keeps the group fulfilledBy of every order: Marketly-fulfilled, seller-shipped and Official Store rows', async () => {
    const sellerId = newId();
    const service = h.order({ sellerId, fulfilledBy: 'marketly_service' });
    const own = h.order({ sellerId });
    const official = h.order({ sellerId: null });
    for (const o of [service, own, official]) h.placed(o);
    await h.drain();
    expect((await factsOf(service.id)).map((r) => r.fulfilled_by)).toEqual(['marketly_service']);
    expect((await factsOf(own.id)).map((r) => r.fulfilled_by)).toEqual(['seller']);
    expect((await factsOf(official.id)).map((r) => r.fulfilled_by)).toEqual(['official_warehouse']);
  });

  it('fills a row recorded without it from the placement event (rows kept before)', async () => {
    const o = h.order({ sellerId: newId(), fulfilledBy: 'marketly_service' });
    h.placed(o);
    await h.drain();
    await table('fact_order_items').updateMany({ order_id: o.id }, { fulfilled_by: null });
    h.placed(o); // redelivered: the facts exist, only the missing fulfilled_by is filled
    await h.drain();
    expect((await factsOf(o.id)).map((r) => r.fulfilled_by)).toEqual(['marketly_service']);
  });
});

describe("Marketly's dispatches", () => {
  it("go to fact_marketly_fulfillment_daily for the seller of record, never to the seller's service row (once per shipment and exception)", async () => {
    const sellerId = newId();
    const own = h.order({ sellerId });
    const service = h.order({ sellerId, fulfilledBy: 'marketly_service' });
    const late = h.order({ sellerId, fulfilledBy: 'marketly_service' });
    h.placed(own);
    h.placed(service);
    h.placed(late);
    await h.drain();
    h.publish('shipping', 'shipping.shipment.dispatched', dispatched(own, sellerId, 'seller', true));
    const svc = dispatched(service, sellerId, 'marketly_service', true);
    h.publish('shipping', 'shipping.shipment.dispatched', svc);
    h.publish('shipping', 'shipping.shipment.dispatched', svc); // redelivered
    h.publish('shipping', 'shipping.shipment.dispatched', dispatched(late, sellerId, 'marketly_service', false));
    const overdue = { orderId: late.id, orderRef: late.ref, groupId: late.groups[0]!.id, ownerType: 'seller', sellerId, fulfilledBy: 'marketly_service', orderItemIds: [late.groups[0]!.items[0]!.id], dueAt: h.clock.now().toISOString(), exceptionId: newId() };
    h.publish('shipping', 'shipping.dispatch.overdue', overdue);
    h.publish('shipping', 'shipping.dispatch.overdue', overdue);
    // delivery issues: Marketly's package counts in the Marketly row, the seller's own in its row
    const exception = (o: typeof own, fulfilledBy: 'seller' | 'marketly_service') => ({ exceptionId: newId(), kind: 'lost_or_damaged', orderId: o.id, groupId: o.groups[0]!.id, shipmentId: newId(), sellerId, fulfilledBy, orderItemIds: [o.groups[0]!.items[0]!.id], dueAt: h.clock.now().toISOString(), customerAction: null, source: 'carrier', caseRef: null });
    const lost = exception(service, 'marketly_service');
    h.publish('shipping', 'shipping.shipment.exception', lost);
    h.publish('shipping', 'shipping.shipment.exception', lost); // redelivered
    h.publish('shipping', 'shipping.shipment.exception', exception(own, 'seller'));
    await h.drain();

    expect(await serviceRow(sellerId)).toEqual([{ dispatched: 1, dispatched_on_time: 1, overdue: 0, delivery_exceptions: 1 }]);
    expect(await marketlyRow(sellerId)).toEqual([{ dispatched: 2, dispatched_on_time: 1, overdue: 1, delivery_exceptions: 1 }]);
    // the shipment date basis still fills for the service items
    const shipped = await table('fact_order_items').find({ order_id: service.id });
    expect(shipped[0]!.shipped_at).not.toBeNull();

    // the seller's own service report only counts what the seller shipped
    const seller = await h.call('POST', '/api/seller/reports/reports/seller.service_performance/query', h.tokens.seller(sellerId), { preset: 'today' });
    expect(seller.status).toBe(200);
    expect(kpi(seller.body, 'service.on_time_dispatch')).toMatchObject({ value: 100, note: '1 of 1 packages' });
    expect(kpi(seller.body, 'service.marketly_on_time_dispatch')).toBeUndefined();

    // staff see Marketly's own figure next to the sellers'
    const staff = await h.call('POST', '/api/admin/reports/reports/service.sellers/query', h.tokens.staff(), { preset: 'today', sellerId });
    expect(staff.status).toBe(200);
    expect(kpi(staff.body, 'service.on_time_dispatch')).toMatchObject({ value: 100 });
    expect(kpi(staff.body, 'service.overdue_dispatch').value).toBe(0);
    expect(kpi(staff.body, 'service.marketly_on_time_dispatch')).toMatchObject({ value: 50, note: '1 of 2 packages · 1 overdue · 1 delivery issues' });
    expect(staff.body.definitions.map((d: any) => d.key)).toContain('service.marketly_on_time_dispatch');
    expect(staff.body.unavailable).not.toContain('service.marketly_on_time_dispatch');
  });

  it('staff service report without any Marketly dispatch (fulfillment-service off) marks the figure unavailable', async () => {
    const r = await h.call('POST', '/api/admin/reports/reports/service.sellers/query', h.tokens.staff(), { preset: 'today', sellerId: newId() });
    expect(r.status).toBe(200);
    expect(kpi(r.body, 'service.marketly_on_time_dispatch')).toBeUndefined();
    expect(r.body.unavailable).toContain('service.marketly_on_time_dispatch');
  });

  it('lists the read model with its rows', async () => {
    const list = await h.call('GET', '/api/admin/reports/read-models', h.tokens.staff());
    expect(list.status).toBe(200);
    expect(list.body.find((m: any) => m.key === 'marketly_fulfillment')).toMatchObject({ sourceEvents: ['shipping.shipment.dispatched', 'shipping.dispatch.overdue', 'shipping.shipment.exception'], rebuildable: false });
  });
});

describe('service fees', () => {
  it('fee.charged adds and fee.reversed subtracts service_fees_minor, once per chargeId; the fees report and the seller dashboard show them', async () => {
    const sellerId = newId();
    const charge = (amount: number) => ({ chargeId: newId(), sellerId, type: 'pick_pack', amount: usd(amount), reference: 'FR-1', period: null });
    const a = charge(1250);
    const b = charge(400);
    h.publish('fulfillment-service', 'fulfillment-service.fee.charged', a);
    h.publish('fulfillment-service', 'fulfillment-service.fee.charged', a); // redelivered
    h.publish('fulfillment-service', 'fulfillment-service.fee.charged', b);
    await h.drain();
    const reversal = { chargeId: b.chargeId, sellerId, amount: usd(400), reason: 'Charged twice', period: null };
    h.publish('fulfillment-service', 'fulfillment-service.fee.reversed', reversal);
    h.publish('fulfillment-service', 'fulfillment-service.fee.reversed', reversal);
    await h.drain();
    expect(await serviceFees(sellerId)).toEqual([1250]);

    const fees = await h.call('POST', '/api/admin/reports/reports/marketplace.fees/query', h.tokens.staff(), { preset: 'today', sellerId });
    expect(fees.status).toBe(200);
    expect(kpi(fees.body, 'marketplace.service_fees')).toMatchObject({ value: 1250, money: usd(1250), note: 'Fulfilled by Marketly' });
    expect(fees.body.table.totals.serviceFees).toEqual(usd(1250));
    expect(fees.body.table.columns.map((c: any) => c.key)).toContain('serviceFees');
    expect(fees.body.unavailable).not.toContain('marketplace.service_fees');

    const dash = await h.call('GET', '/api/seller/reports/dashboard', h.tokens.seller(sellerId));
    expect(dash.status).toBe(200);
    expect(dash.body.sales.serviceFees).toMatchObject({ amount: usd(1250), label: 'Fulfilled by Marketly fees' });

    // a member who may not view service fees gets no line
    const hidden = await h.call('GET', '/api/seller/reports/dashboard', h.tokens.seller(sellerId, ['reports.seller.view']));
    expect(hidden.status).toBe(200);
    expect(hidden.body.sales.serviceFees).toBeNull();

    // GraphQL: the line is a KPI with its definition
    const g = await h.gql('seller', h.tokens.seller(sellerId), '{ sellerDashboard { kpis { metricKey value } definitions { key } } }');
    expect(g.data.sellerDashboard.kpis).toContainEqual({ metricKey: 'marketplace.service_fees', value: 1250 });
    expect(g.data.sellerDashboard.definitions.map((d: any) => d.key)).toContain('marketplace.service_fees');
  });

  it('a seller without service fees (fulfillment-service off) sees no line', async () => {
    const dash = await h.call('GET', '/api/seller/reports/dashboard', h.tokens.seller(newId()));
    expect(dash.status).toBe(200);
    expect(dash.body.sales.serviceFees).toBeNull();
  });
});

describe('seeded definitions and datasets', () => {
  it("seeds 'Service fees' and 'Fulfilled by Marketly on-time dispatch'", async () => {
    const r = await h.call('GET', '/api/admin/reports/metrics', h.tokens.staff());
    expect(r.status).toBe(200);
    const items = Array.isArray(r.body) ? r.body : r.body.items;
    expect(items.find((m: any) => m.key === 'marketplace.service_fees')).toMatchObject({ name: 'Service fees', group: 'marketplace_finance', unit: 'money', status: 'published' });
    expect(items.find((m: any) => m.key === 'service.marketly_on_time_dispatch')).toMatchObject({ name: 'Fulfilled by Marketly on-time dispatch', group: 'service_sellers', unit: 'percent' });
  });

  it('has the four fulfillment-service datasets in the registry (unavailable while fulfillment-service is off)', async () => {
    const all = await h.call('GET', '/api/admin/reports/export-datasets?all=true', h.tokens.staff());
    expect(all.status).toBe(200);
    const fs = all.body.filter((d: any) => d.owner === 'fulfillment-service');
    expect(fs.map((d: any) => [d.key, d.permission, d.audience]).sort()).toEqual([
      ['fulfillment-service.admin.fees', 'fulfillment-service.fees.manage', 'staff'],
      ['fulfillment-service.admin.stock_by_owner', 'fulfillment-service.operations.view', 'staff'],
      ['fulfillment-service.seller.fees', 'fulfillment-service.fees.view', 'seller'],
      ['fulfillment-service.seller.stock', 'fulfillment-service.inbound.manage', 'seller'],
    ]);
    expect(fs.every((d: any) => d.available === false && d.phase === 4)).toBe(true);
  });
});
