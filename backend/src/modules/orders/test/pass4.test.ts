/**
 * Gap pass 4: event-fed facts in orders.order_facts, flag kinds
 * in orders.flag_kinds, the masked contact email for staff without the contact permission, and the export hook.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
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
