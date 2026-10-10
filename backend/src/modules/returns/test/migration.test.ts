/**
 * Migration 0004 (gap pass 4) backfills what pass 3 kept in jsonb and marker rows: returns.received_at from the
 * 'received_at' timeline rows, the refund request columns, items and history from refund_requests.deductions and
 * order_item_ids. Run against that state: the 0004 objects are dropped, legacy rows inserted, and the migration's
 * SQL applied again. Migration 0005 (returns.fulfilled_by, Fulfilled by Marketly) is run the same way: its column
 * dropped, the SQL applied again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { m0004Pass4 } from '../infra/postgres/migrations/0004_pass4.js';
import { m0005FulfilledBy } from '../infra/postgres/migrations/0005_fulfilled_by.js';
import { group, harness, idem, line, placeOrder, product, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

const DROP_0004 = `
drop table returns.refund_request_items; drop table returns.refund_request_events;
alter table returns.refund_requests drop column customer_id, drop column contact_email, drop column customer_name, drop column seller_name, drop column order_ref,
  drop column tax_refund, drop column max_refundable, drop column destination, drop column destination_label, drop column remedy_kind,
  drop column approved_at, drop column sent_at, drop column note, add column order_item_ids jsonb not null default '[]';
alter table returns.returns drop column received_at;`;

describe('migration 0004', () => {
  it('backfills received_at, the refund request columns, items and history', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Chair', price: 8000, sellerId });
    const m = await placeOrder(h, [group(h, [line(p, 2)], { sellerId })]);
    const res = await h.call('POST', '/api/store/returns/requests', tokens.customer(m.customerId), { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 2 }], reason: 'damaged', details: 'Leg broken', remedy: 'refund' }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const returnId = res.body.returns[0].id;
    const db = h.app.kernel.database;
    await db.exec(DROP_0004);

    const receivedAt = '2026-09-02T10:00:00.000Z';
    const legacyId = newId();
    const exceptionId = newId();
    const itemA = m.items[0]![0]!;
    const itemB = newId();
    const customerId = newId();
    const deductions = (x: Record<string, unknown>) => JSON.stringify(x).replace(/'/g, "''");
    await db.exec(`
insert into returns.return_events (id, return_id, kind, label, detail, visibility, actor_kind, actor_id, at)
  values ('${newId()}', '${returnId}', 'received_at', 'Parcel received', '${receivedAt}', 'staff', 'seller', null, '${receivedAt}');
insert into returns.refund_requests (id, ref, source, return_id, case_id, order_id, order_item_ids, owner_type, seller_id, status, item_amount, discount_share, shipping_refund, return_shipping_deduction, deductions, total, currency, funded_by, proposed_by, created_at, updated_at)
values
  ('${legacyId}', 'RF-LEGACY-1', 'return', '${returnId}', null, '${m.order.id}', '["${itemA}"]', 'seller', '${sellerId}', 'sent', 16000, 0, 0, 0,
   '${deductions({ list: [{ label: 'Scratch', amount: { amount: 500, currency: 'USD' }, reason: 'Scratched' }], destination: 'store_credit', destinationLabel: 'Marketly store credit', maxRefundable: 16000, kind: 'store_credit', perItem: [{ orderItemId: itemA, amount: 15500 }], items: [{ orderItemId: itemA, quantity: 2 }], customerId: m.customerId, contactEmail: 'sam@example.com', customerName: 'Sam', sellerName: 'Chairs Inc', orderRef: m.order.ref, approvedAt: '2026-09-03T10:00:00.000Z', sentAt: '2026-09-03T10:00:05.000Z', history: [{ at: '2026-09-03T10:00:00.000Z', label: 'Refund approved', detail: null, actor: { kind: 'staff', id: 'S1', name: 'Fay' } }, { at: '2026-09-03T10:00:05.000Z', label: 'Store credit issued', detail: null, actor: { kind: 'system', id: null } }] })}'::jsonb,
   15500, 'USD', 'seller', '{"kind":"staff","id":null}', now(), now()),
  ('${exceptionId}', 'RF-LEGACY-2', 'exception', null, null, '${m.order.id}', '["${itemA}", "${itemB}"]', 'seller', '${sellerId}', 'under_review', 3000, 0, 0, 0,
   '${deductions({ list: [], destination: 'original_method', destinationLabel: 'Visa', maxRefundable: 9000, kind: 'exception', perItem: [], customerId, contactEmail: null, history: [] })}'::jsonb,
   3000, 'USD', 'platform', '{"kind":"staff","id":null}', now(), now());
`);

    await db.exec(m0004Pass4.sql);

    const repo = h.service.core.repo;
    expect((await repo.get('returns', returnId))!.received_at).toEqual(new Date(receivedAt));
    expect(await repo.find('return_events', { return_id: returnId, kind: 'received_at' })).toEqual([]);
    const legacy = (await repo.get('refund_requests', legacyId))!;
    expect(legacy).toMatchObject({
      destination: 'store_credit',
      destination_label: 'Marketly store credit',
      max_refundable: 16000,
      remedy_kind: 'store_credit',
      customer_id: m.customerId,
      contact_email: 'sam@example.com',
      seller_name: 'Chairs Inc',
      order_ref: m.order.ref,
      approved_at: new Date('2026-09-03T10:00:00.000Z'),
      sent_at: new Date('2026-09-03T10:00:05.000Z'),
      deductions: [{ label: 'Scratch', amount: { amount: 500, currency: 'USD' }, reason: 'Scratched' }],
      items: [{ orderItemId: itemA, quantity: 2, amount: 15500 }],
      order_item_ids: [itemA],
    });
    expect(legacy.history).toEqual([
      { at: '2026-09-03T10:00:00.000Z', label: 'Refund approved', detail: null, actor: { kind: 'staff', id: 'S1', name: 'Fay' } },
      { at: '2026-09-03T10:00:05.000Z', label: 'Store credit issued', detail: null, actor: { kind: 'system', id: null } },
    ]);
    // no per-item split: the whole total on the first item; quantities unknown (the returned units)
    const exception = (await repo.get('refund_requests', exceptionId))!;
    expect(exception).toMatchObject({ customer_id: customerId, destination: 'original_method', remedy_kind: 'exception', history: [] });
    expect(exception.items).toEqual([
      { orderItemId: itemA, quantity: null, amount: 3000 },
      { orderItemId: itemB, quantity: null, amount: 0 },
    ]);
    // a migrated request keeps working: its history grows in the new table
    await repo.addRefundEvents(exceptionId, [{ at: new Date().toISOString(), label: 'Refund sent back', detail: 'Check the amount', actor: null }]);
    expect((await repo.get('refund_requests', exceptionId))!.history.map((e) => e.label)).toEqual(['Refund sent back']);
  });
});

describe('migration 0005 (Fulfilled by Marketly)', () => {
  it('copies fulfilledBy on new returns and backfills older ones from the owner', async () => {
    const official = product(h, { title: 'Kettle', price: 5000, ownerType: 'official' });
    const o = await placeOrder(h, [group(h, [line(official, 1)], { ownerType: 'official' })]);
    const a = await h.call('POST', '/api/store/returns/requests', tokens.customer(o.customerId), { orderId: o.order.id, items: [{ orderItemId: o.items[0]![0]!, quantity: 1 }], reason: 'defective', details: 'Cold', remedy: 'refund' }, idem());
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const sellerId = newId();
    const own = product(h, { title: 'Vase', price: 4000, sellerId });
    const s = await placeOrder(h, [group(h, [line(own, 1)], { sellerId })]);
    const b = await h.call('POST', '/api/store/returns/requests', tokens.customer(s.customerId), { orderId: s.order.id, items: [{ orderItemId: s.items[0]![0]!, quantity: 1 }], reason: 'damaged', details: 'Cracked', remedy: 'refund' }, idem());
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const officialId = a.body.returns[0].id;
    const sellerReturnId = b.body.returns[0].id;
    const repo = h.service.core.repo;
    const db = h.app.kernel.database;

    // fresh install: the column is filled at request and only takes the three values
    expect((await repo.get('returns', officialId))!.fulfilled_by).toBe('official_warehouse');
    expect((await repo.get('returns', sellerReturnId))!.fulfilled_by).toBe('seller');
    await expect(db.exec(`update returns.returns set fulfilled_by = 'drone' where id = '${sellerReturnId}'`)).rejects.toThrow();
    await expect(db.exec(`update returns.returns set fulfilled_by = null where id = '${sellerReturnId}'`)).rejects.toThrow();

    // an install from before: no column, then the migration
    await db.exec('alter table returns.returns drop constraint returns_fulfilled_by_check; alter table returns.returns drop column fulfilled_by;');
    await db.exec(m0005FulfilledBy.sql);
    expect((await repo.get('returns', officialId))!.fulfilled_by).toBe('official_warehouse');
    expect((await repo.get('returns', sellerReturnId))!.fulfilled_by).toBe('seller');
    const view = await h.call('GET', `/api/admin/returns/requests/${sellerReturnId}`, tokens.staff());
    expect(view.body.fulfilledBy).toBe('seller');
  });
});
