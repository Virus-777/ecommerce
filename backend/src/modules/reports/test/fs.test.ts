/**
 * Fulfilled by Marketly (fulfillment-service, phase 4): fact_order_items.fulfilled_by, Marketly's dispatches kept in
 * fact_marketly_fulfillment_daily (never the seller's service row), service fees from fulfillment-service fee events,
 * the two seeded metrics, the seller dashboard's service-fees line, the four dataset keys and migration 0005.
 * fulfillment-service itself is off here: its events are published with the contract payloads.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { m0005FulfilledByMarketly } from '../infra/postgres/migrations/0005_fulfilled_by_marketly.js';
import { harness, usd, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const kpi = (body: any, key: string) => body.kpis.find((k: any) => k.metricKey === key);
const db = () => h.app.kernel.database.kysely;
const factsOf = async (orderId: string) =>
  (await sql<{ order_item_id: string; owner_type: string; fulfilled_by: string | null }>`select order_item_id, owner_type, fulfilled_by from reports.fact_order_items where order_id = ${orderId}`.execute(db())).rows;
const serviceRow = async (sellerId: string) => (await sql<{ dispatched: number; dispatched_on_time: number; overdue: number }>`select dispatched, dispatched_on_time, overdue from reports.fact_service_daily where seller_id = ${sellerId}`.execute(db())).rows;
const marketlyRow = async (sellerId: string) => (await sql<{ dispatched: number; dispatched_on_time: number; overdue: number }>`select dispatched, dispatched_on_time, overdue from reports.fact_marketly_fulfillment_daily where seller_id = ${sellerId}`.execute(db())).rows;

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
    await sql`update reports.fact_order_items set fulfilled_by = null where order_id = ${o.id}`.execute(db());
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
    await h.drain();

    expect(await serviceRow(sellerId)).toEqual([{ dispatched: 1, dispatched_on_time: 1, overdue: 0 }]);
    expect(await marketlyRow(sellerId)).toEqual([{ dispatched: 2, dispatched_on_time: 1, overdue: 1 }]);
    // the shipment date basis still fills for the service items
    const shipped = (await sql<{ shipped_at: Date | null }>`select shipped_at from reports.fact_order_items where order_id = ${service.id}`.execute(db())).rows;
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
    expect(kpi(staff.body, 'service.marketly_on_time_dispatch')).toMatchObject({ value: 50, note: '1 of 2 packages · 1 overdue' });
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
    expect(list.body.find((m: any) => m.key === 'marketly_fulfillment')).toMatchObject({ sourceEvents: ['shipping.shipment.dispatched', 'shipping.dispatch.overdue'], rebuildable: false });
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
    const rows = (await sql<{ service_fees_minor: string }>`select service_fees_minor::text from reports.fact_marketplace_finance_daily where seller_id = ${sellerId}`.execute(db())).rows;
    expect(rows.map((r) => Number(r.service_fees_minor))).toEqual([1250]);

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

describe('migration 0005 on an install from before it', () => {
  it('adds the columns and the table, filling fulfilled_by from the owner and service fees with 0', async () => {
    const sellerId = newId();
    const own = h.order({ sellerId });
    const official = h.order({ sellerId: null });
    h.placed(own);
    h.placed(official);
    await h.drain();
    h.publish('finance', 'finance.payout.paid', { payoutId: newId(), ref: 'PO-1', sellerId, amount: usd(7000), paidAt: h.clock.now().toISOString() });
    await h.drain();

    // back to the 0004 schema, as an older install has it
    await h.app.kernel.database.exec(`
alter table reports.fact_order_items drop column fulfilled_by;
alter table reports.fact_marketplace_finance_daily drop column service_fees_minor;
drop table reports.fact_marketly_fulfillment_daily;`);
    await h.app.kernel.database.exec(m0005FulfilledByMarketly.sql!);

    expect((await factsOf(own.id)).map((r) => r.fulfilled_by)).toEqual(['seller']);
    expect((await factsOf(official.id)).map((r) => r.fulfilled_by)).toEqual(['official_warehouse']);
    const fin = (await sql<{ service_fees_minor: string }>`select service_fees_minor::text from reports.fact_marketplace_finance_daily where seller_id = ${sellerId}`.execute(db())).rows;
    expect(fin.map((r) => Number(r.service_fees_minor))).toEqual([0]);
    expect(await marketlyRow(sellerId)).toEqual([]);
    // the read models keep working on the migrated schema
    h.publish('fulfillment-service', 'fulfillment-service.fee.charged', { chargeId: newId(), sellerId, type: 'storage', amount: usd(300), reference: null, period: '2026-10' });
    await h.drain();
    const after = (await sql<{ service_fees_minor: string }>`select service_fees_minor::text from reports.fact_marketplace_finance_daily where seller_id = ${sellerId}`.execute(db())).rows;
    expect(after.map((r) => Number(r.service_fees_minor))).toEqual([300]);
  });
});
