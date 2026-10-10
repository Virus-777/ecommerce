/**
 * Migration 0004 (Fulfilled by Marketly): on a fresh install the new columns and tables exist; on data from before
 * it, the 0004 objects are dropped, legacy rows inserted, and the migration's SQL applied again to check the backfills.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { m0004FulfilledByMarketly } from '../infra/postgres/migrations/0004_fulfilled_by_marketly.js';
import { boot, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const DROP_0004 = `
alter table fulfillment_service.enrollments drop column expected_skus, drop column expected_monthly_units, drop column categories, drop column contact_note, drop column seller_suspension_id;
alter table fulfillment_service.sku_enrollments drop column hazmat, drop column notes;
alter table fulfillment_service.inbound_shipments add column warehouse_receipt_id uuid;
drop table fulfillment_service.inbound_receipts;
alter table fulfillment_service.fulfillment_requests drop column order_ref, drop column short_reported_at;
alter table fulfillment_service.service_returns drop column return_ref, drop column order_item_id, drop column proposed_outcome;
alter table fulfillment_service.removal_orders drop column reason, drop column fee_amount, drop column approved_at, drop column completed_at;
drop table fulfillment_service.stock_differences;`;

describe('migration 0004', () => {
  it('creates the new columns and tables on a fresh install', async () => {
    const rows = await sql<{ table_name: string; column_name: string }>`select table_name, column_name from information_schema.columns where table_schema = 'fulfillment_service'`.execute(k.app.kernel.database.kysely);
    const cols = new Set(rows.rows.map((r) => `${r.table_name}.${r.column_name}`));
    for (const c of ['enrollments.expected_skus', 'enrollments.categories', 'enrollments.seller_suspension_id', 'sku_enrollments.hazmat', 'inbound_receipts.lines', 'fulfillment_requests.order_ref', 'service_returns.order_item_id', 'removal_orders.fee_amount', 'stock_differences.inventory']) expect(cols.has(c), c).toBe(true);
    expect(cols.has('inbound_shipments.warehouse_receipt_id')).toBe(false);
  });

  it('backfills applications, SKUs, requests, service returns and removals made before it', async () => {
    const db = k.app.kernel.database;
    const repo = (k.api as any).core.repo;
    await db.exec(DROP_0004);
    const at = '2026-09-01T12:00:00.000Z';
    const ids = { applied: newId(), active: newId(), seller: newId(), seller2: newId(), sku: newId(), request: newId(), shipped: newId(), ret: newId(), removal: newId(), order: newId() };
    const items = (orderRef: string) => JSON.stringify([{ orderItemId: newId(), offerId: newId(), skuEnrollmentId: ids.sku, stockItemId: null, sku: 'S1', title: 'T', sizeTier: 'standard', quantity: 3, cancelled: 1, picked: 2, reserved: 0, orderRef }]);
    await db.exec(`
insert into fulfillment_service.enrollments (id, seller_id, state, terms_version, fee_schedule_version, accepted_at, accepted_by, max_cubic_feet, max_skus, reason, reviewer_id, created_at, decided_at) values
  ('${ids.applied}', '${ids.seller}', 'applied', 'T1', 'FS-EXAMPLE-2026', '${at}', null, 0, 7, 'Home textiles, 7 SKUs', null, '${at}', null),
  ('${ids.active}', '${ids.seller2}', 'active', 'T1', 'FS-EXAMPLE-2026', '${at}', null, 100, 20, 'Welcome', null, '${at}', '${at}');
insert into fulfillment_service.sku_enrollments (id, seller_id, offer_id, product_id, sku, dimensions, weight_grams, size_tier, barcode, label_required, restricted, restriction_reason, state, inventory_item_id) values
  ('${ids.sku}', '${ids.seller2}', '${newId()}', '${newId()}', 'S1', '{"length":1,"width":1,"height":1}', 100, 'standard', null, true, false, null, 'active', null);
insert into fulfillment_service.fulfillment_requests (id, order_id, seller_group_id, seller_id, state, items, warehouse_task_id, shipment_id, dispatch_by, created_at) values
  ('${ids.shipped}', '${ids.order}', '${newId()}', '${ids.seller2}', 'shipped', '${items('MK-260901-00001')}', null, null, '${at}', '${at}'),
  ('${ids.request}', '${newId()}', '${newId()}', '${ids.seller2}', 'open', '${items('MK-260901-00002')}', null, null, '${at}', '${at}');
insert into fulfillment_service.service_returns (id, return_id, seller_id, sku_enrollment_id, quantity, outcome, inspection_note, evidence_media_ids, inspected_at) values
  ('${ids.ret}', '${newId()}', '${ids.seller2}', '${ids.sku}', 1, 'pending', null, '[]', null);
insert into fulfillment_service.ownership_ledger (id, seller_id, sku_enrollment_id, movement, quantity, from_group, to_group, reference, actor_kind, actor_id, reason, at) values
  ('${ids.ret}', '${ids.seller2}', '${ids.sku}', 'returned', 1, null, 'returned', 'RT-260901-0001', 'system', null, null, '${at}'),
  ('${newId()}', '${ids.seller2}', '${ids.sku}', 'removal_reserved', 2, 'available', 'removal_pending', 'RM-260901-0001', 'staff', null, null, '2026-09-02T10:00:00.000Z'),
  ('${newId()}', '${ids.seller2}', '${ids.sku}', 'removed', 2, 'removal_pending', null, 'RM-260901-0001', 'staff', null, null, '2026-09-05T10:00:00.000Z');
insert into fulfillment_service.removal_orders (id, ref, seller_id, kind, state, lines, ship_to, tracking, created_at) values
  ('${ids.removal}', 'RM-260901-0001', '${ids.seller2}', 'return_to_seller', 'completed', '[]', null, '1Z', '${at}');
insert into fulfillment_service.fee_charges (id, seller_id, type, period, reference, units, rate, amount, currency, state, posted_at, ledger_entry_id, reason, idempotency_key) values
  ('${newId()}', '${ids.seller2}', 'removal', '2026-09', 'RM-260901-0001', 2, 97, 194, 'USD', 'accrued', null, null, null, 'mig:${ids.removal}');
`);
    await db.exec(m0004FulfilledByMarketly.sql);

    // the applicant's note leaves reason; the expected SKU count comes from max_skus
    expect(await repo.get('enrollments', ids.applied)).toMatchObject({ expected_skus: 7, expected_monthly_units: 0, categories: [], contact_note: 'Home textiles, 7 SKUs', reason: null, seller_suspension_id: null });
    expect(await repo.get('enrollments', ids.active)).toMatchObject({ expected_skus: 20, contact_note: null, reason: 'Welcome' });
    expect(await repo.get('sku_enrollments', ids.sku)).toMatchObject({ hazmat: false, notes: null });
    // requests: order_ref from the items; shipped per item (every uncancelled unit of a shipped request)
    const shipped = await repo.get('fulfillment_requests', ids.shipped);
    expect(shipped).toMatchObject({ order_ref: 'MK-260901-00001', short_reported_at: null });
    expect(shipped.items[0]).toMatchObject({ shipped: 2, quantity: 3, cancelled: 1 });
    expect((await repo.get('fulfillment_requests', ids.request)).items[0].shipped).toBe(0);
    // service return: the return ref from its ledger movement; the order item unknown (its own id)
    expect(await repo.get('service_returns', ids.ret)).toMatchObject({ return_ref: 'RT-260901-0001', order_item_id: ids.ret, proposed_outcome: null });
    // removal: dates from the ledger, the fee from its charges
    const removal = await repo.get('removal_orders', ids.removal);
    expect(removal).toMatchObject({ reason: null, fee_amount: 194 });
    expect(removal.approved_at.toISOString()).toBe('2026-09-02T10:00:00.000Z');
    expect(removal.completed_at.toISOString()).toBe('2026-09-05T10:00:00.000Z');
    expect(await repo.find('stock_differences', {})).toEqual([]);
    expect(await repo.find('inbound_receipts', {})).toEqual([]);
    // running it again changes nothing
    await db.exec(m0004FulfilledByMarketly.sql.replace(/alter table fulfillment_service.inbound_shipments drop column if exists warehouse_receipt_id;/, ''));
    expect(await repo.get('enrollments', ids.applied)).toMatchObject({ contact_note: 'Home textiles, 7 SKUs', reason: null });
  });
});
