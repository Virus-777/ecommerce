/**
 * Gap pass 4: event-fed facts in orders.order_facts (with the 0004 backfill from the old flags jsonb), flag kinds
 * in orders.flag_kinds, the masked contact email for staff without the contact permission, and the export hook.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { m0004OrderFacts } from '../infra/postgres/migrations/0004_order_facts.js';
import { checkout, group, harness, line, product, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

const at = () => new Date().toISOString();

describe('order facts', () => {
  it('records captures, chargebacks, cases and delivery issues once each, and derives the flags from them', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Chair', price: 9000, sellerId });
    const order = await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId })], { customerId: newId() }));
    const captureId = newId();
    const capture = { intentId: order.paymentIntentId!, captureId, orderId: order.id, groupId: null, amount: { amount: 9000, currency: 'USD' }, allocations: [], capturedAt: at() };
    await h.publish('payments', 'payments.payment.captured', capture);
    await h.publish('payments', 'payments.payment.captured', capture);
    const disputeId = newId();
    await h.publish('payments', 'payments.chargeback.opened', { disputeId, ref: 'DP-1', kind: 'fraud', orderId: order.id, groupId: order.groups[0]!.id, sellerId: null, amount: { amount: 9000, currency: 'USD' }, evidenceDueAt: null });
    const caseId = newId();
    await h.publish('support', 'support.case.opened', { caseId, ref: 'CS-1', kind: 'order', category: 'not_received', priority: 'normal', customerId: null, sellerId: null, orderId: order.id, orderItemIds: [order.groups[0]!.items[0]!.id], handler: 'seller', nextResponseDueAt: at() });
    await h.app.kernel.events.drain();

    const facts = await h.service.core.repo.find('order_facts', { order_id: order.id });
    expect(facts.filter((f) => f.kind === 'capture')).toEqual([expect.objectContaining({ source_id: captureId, amount: 9000 })]);
    expect(facts.find((f) => f.kind === 'chargeback')).toMatchObject({ source_id: disputeId, subkind: 'fraud', ref: 'DP-1' });
    expect(facts.find((f) => f.kind === 'case')).toMatchObject({ source_id: caseId, ref: 'CS-1', status: 'open' });
    const row = (await h.service.core.repo.get('orders', order.id))!;
    expect(row.captured_total).toBe(9000);
    expect(row.flag_kinds).toEqual(expect.arrayContaining(['chargeback', 'case_open']));
    const listed = await h.service.listOrdersAdmin({ flag: 'chargeback' }, { limit: 50 });
    expect(listed.items.map((o) => o.order.id)).toContain(order.id);
  });
});

describe('migration 0004', () => {
  it('backfills order_facts and flag_kinds from the old flags jsonb', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Desk', price: 12000, sellerId });
    const order = await h.service.createOrder(checkout([group(h, [line(p, 2)], { sellerId })], { customerId: newId() }));
    const itemId = order.groups[0]!.items[0]!.id;
    const groupId = order.groups[0]!.id;
    const ids = { capture: newId(), dispute: newId(), case: newId(), refund: newId(), approval: newId(), exception: newId() };
    const flags = {
      kinds: ['case_open', 'chargeback', 'delivery_issue'],
      captures: [{ captureId: ids.capture, amount: 12000, at: '2026-09-01T10:00:00.000Z' }, { captureId: 'not-an-id', amount: 1, at: 'x' }],
      chargebacks: [{ disputeId: ids.dispute, kind: 'fraud', groupId, at: '2026-09-02T10:00:00.000Z' }],
      cases: [{ caseId: ids.case, ref: 'CS-9', itemIds: [itemId], status: 'open', nextUpdateBy: '2026-09-05T10:00:00.000Z' }],
      refundsSent: [ids.refund],
      refundApprovals: [{ id: ids.approval, returnRef: 'RT-9', amount: 500, itemIds: [itemId] }],
      deliveryIssues: [{ exceptionId: ids.exception, kind: 'failed_delivery', groupId, shipmentId: null, dueAt: '2026-09-03T10:00:00.000Z', customerAction: 'Pick a new day', at: '2026-09-02T12:00:00.000Z' }],
      restrictedGroups: [groupId],
      confirmationsResent: 2,
    };

    const db = h.app.kernel.database;
    // the state before 0004: facts in orders.flags, no order_facts table, no flag_kinds
    await db.exec(`drop table orders.order_facts; alter table orders.orders add column flags jsonb; alter table orders.orders drop column flag_kinds`);
    await sql`update orders.orders set flags = ${JSON.stringify(flags)}::jsonb where id = ${order.id}`.execute(db.kysely);
    await sql`update orders.orders set flags = '{"kinds":[]}'::jsonb where flags is null`.execute(db.kysely);
    await db.exec(`alter table orders.orders alter column flags set not null`);

    await db.exec(m0004OrderFacts.sql);

    const facts = await h.service.core.repo.find('order_facts', { order_id: order.id });
    const of = (kind: string) => facts.filter((f) => f.kind === kind);
    expect(of('capture')).toEqual([expect.objectContaining({ source_id: ids.capture, amount: 12000, at: new Date('2026-09-01T10:00:00.000Z') })]);
    expect(of('chargeback')[0]).toMatchObject({ source_id: ids.dispute, subkind: 'fraud', group_id: groupId });
    expect(of('case')[0]).toMatchObject({ source_id: ids.case, ref: 'CS-9', item_ids: [itemId], status: 'open', due_at: new Date('2026-09-05T10:00:00.000Z') });
    expect(of('refund_sent')[0]).toMatchObject({ source_id: ids.refund });
    expect(of('refund_approval')[0]).toMatchObject({ source_id: ids.approval, ref: 'RT-9', amount: 500, item_ids: [itemId], status: 'approved' });
    expect(of('delivery_issue')[0]).toMatchObject({ source_id: ids.exception, subkind: 'failed_delivery', group_id: groupId, customer_action: 'Pick a new day' });
    expect(of('seller_restricted')[0]).toMatchObject({ source_id: groupId, group_id: groupId });
    expect(of('confirmation_resent')).toHaveLength(2);
    const row = (await h.service.core.repo.get('orders', order.id))!;
    expect(row.flag_kinds).toEqual(['case_open', 'chargeback', 'delivery_issue']);
    expect('flags' in row).toBe(false);

    // the views read the backfilled facts
    const detail = (await h.service.getOrder(order.id))!;
    expect(detail.cases).toEqual([expect.objectContaining({ caseId: ids.case, ref: 'CS-9' })]);
    expect(detail.totals.expectedRefunds).toEqual(expect.arrayContaining([expect.objectContaining({ ref: 'RT-9', status: 'approved' })]));
  });
});

describe('admin contact and the export hook', () => {
  it('masks the contact email as a plain string for staff without the contact permission', async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Lamp', price: 3000, sellerId });
    const order = await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId })], { customerId: newId(), email: 'sam.rivera@example.com' }));
    const masked = (await h.service.getOrderAdmin(order.ref))!;
    expect(masked.order.contact.email).toBe('s***@example.com');
    expect(masked.customer.email).toBe('s***@example.com');
  });

  it('exports every order of the customer without screen-only fields', async () => {
    const sellerId = newId();
    const customerId = newId();
    const p = product(h, { title: 'Rug', price: 4000, sellerId });
    const a = await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId })], { customerId }));
    const b = await h.service.createOrder(checkout([group(h, [line(p, 2)], { sellerId })], { customerId }));
    await h.service.createOrder(checkout([group(h, [line(p, 1)], { sellerId })], { customerId: newId() }));
    const [section, ...rest] = await h.service.exportCustomerData({ customerId, accountId: newId() });
    expect(rest).toHaveLength(0);
    expect(section).toMatchObject({ key: 'orders', module: 'orders' });
    expect(section!.records.map((r) => (r as { ref: string }).ref).sort()).toEqual([a.ref, b.ref].sort());
    expect(section!.records[0]).not.toHaveProperty('allowedActions');
    expect(section!.records[0]).not.toHaveProperty('paymentIntentId');
    expect(await h.service.exportCustomerData({ customerId: newId(), accountId: newId() })).toEqual([{ key: 'orders', title: 'Orders', module: 'orders', records: [] }]);
  });
});
