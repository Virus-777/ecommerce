/**
 * Gap pass 3: remedies never stay pending for ever (goodwill needs wallet, guests get a partial refund, items
 * default to the case's, settle by staff, declined refunds cancel their remedy, ship-by remedies complete on
 * dispatch), replacements through returns.requestReplacement (with or without a return), notifyParties=false,
 * the exception loop, email replies joining the thread, and the new event fields and public API.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { harness, idem, sellerOrder, tokens, USD, type Harness } from './helpers.js';

let h: Harness;
let hw: Harness;
beforeAll(async () => {
  h = await harness();
  hw = await harness({ wallet: true });
});
afterAll(async () => {
  await h?.app.close();
  await hw?.app.close();
});

const DECIDER = newId();

/** A dispute opened by staff about one delivered seller item (guest: no customer) */
async function dispute(x: Harness, o: { guest?: boolean; returnId?: string; quantity?: number } = {}) {
  const order = await sellerOrder(x, { price: 4900, ...(o.guest ? { customerId: null } : {}), ...(o.quantity ? { quantity: o.quantity } : {}) });
  if (o.returnId) {
    const view = await x.service.openCase({ kind: 'dispute', category: 'return', orderId: order.order.id, orderItemIds: [order.itemId], ...(o.guest ? {} : { customerId: order.customerId }), sellerId: order.sellerId, returnId: o.returnId, subject: 'Return RT-1', message: 'Escalated', openedBy: { kind: 'system', id: null } });
    return { ...order, caseId: view.id, ref: view.ref };
  }
  const res = await x.call('POST', '/api/admin/support/cases', tokens.staff(), { kind: 'dispute', category: 'item_damaged', orderId: order.order.id, orderItemIds: [order.itemId], subject: 'Damaged', message: 'Arrived broken' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { ...order, caseId: res.body.case.id as string, ref: res.body.case.ref as string };
}

const decide = (x: Harness, caseId: string, remedies: unknown[], o: { notifyParties?: boolean } = {}) =>
  x.call('POST', `/api/admin/support/cases/${caseId}/decide`, tokens.staff(undefined, DECIDER), { outcome: 'customer_favored', remedies, reason: 'Covered by the purchase terms', notifyParties: o.notifyParties ?? true }, idem());

describe('goodwill (decision D-RT3)', () => {
  it('is refused while wallet is off, so no remedy waits for a credit that cannot exist', async () => {
    const d = await dispute(h);
    const res = await decide(h, d.caseId, [{ kind: 'goodwill_credit', amount: USD(1000) }]);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('GOODWILL_UNAVAILABLE');
    expect((await h.service.core.load(d.caseId))!.remedies).toHaveLength(0);
  });

  it("becomes a platform-funded partial refund of the case's items for a guest", async () => {
    const d = await dispute(h, { guest: true });
    const res = await decide(h, d.caseId, [{ kind: 'goodwill_credit', amount: USD(1000) }]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [remedy] = (await h.service.core.load(d.caseId))!.remedies;
    expect(remedy).toMatchObject({ kind: 'partial_refund', charged_to: 'platform', amount: 1000, order_item_ids: [d.itemId] });
    expect(remedy!.refund_request_id).toBeTruthy();
    const rr = (h.app.kernel.boot.apis.get('returns') as import('../../../spec/returns.js').ReturnsPublicApi).listRefundRequestsForCase(d.caseId);
    expect((await rr)[0]).toMatchObject({ source: 'case', breakdown: { total: { amount: 1000 } } });
  });

  it("takes the case's items when none are given (wallet on), and a pending grant cannot be settled", async () => {
    const order = await sellerOrder(hw, { price: 4900 });
    const res = await hw.call('POST', '/api/admin/support/cases', tokens.staff(), { kind: 'dispute', category: 'item_damaged', customerId: order.customerId, orderId: order.order.id, orderItemIds: [order.itemId], subject: 'Late', message: 'Late' });
    const caseId = res.body.case.id as string;
    const decided = await decide(hw, caseId, [{ kind: 'goodwill_credit', amount: USD(700) }]);
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const [remedy] = (await hw.service.core.load(caseId))!.remedies;
    expect(remedy).toMatchObject({ kind: 'goodwill_credit', status: 'pending_approval', order_item_ids: [order.itemId] });
    const settle = await hw.call('POST', `/api/admin/support/cases/${caseId}/remedies/${remedy!.id}/settle`, tokens.staff(), { outcome: 'completed', note: 'Paid by cheque' });
    expect(settle.status).toBe(409);
    expect(settle.body.error).toMatchObject({ code: 'REMEDY_NOT_SETTLEABLE', details: { status: 'pending_approval' } });
  });
});

describe('replacements (returns.requestReplacement)', () => {
  it('without a return on the case, returns creates a replacement without one; cancelling it cancels the remedy', async () => {
    const d = await dispute(h);
    h.stock.set(d.product.stockItemId, 2);
    const res = await decide(h, d.caseId, [{ kind: 'replacement' }]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const created = h.named('returns.replacement.created').find((e) => e.caseId === d.caseId);
    expect(created).toMatchObject({ returnId: null, orderItemId: d.itemId });
    const [remedy] = (await h.service.core.load(d.caseId))!.remedies;
    expect(remedy).toMatchObject({ kind: 'replacement', status: 'in_progress', replacement_id: created.replacementId });
    const cancelled = await h.call('POST', `/api/admin/returns/replacements/${created.replacementId}/cancel`, tokens.staff(), { reason: 'Out of stock after all' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const after = (await h.service.core.load(d.caseId))!;
    expect(after.remedies[0]).toMatchObject({ status: 'cancelled', note: 'Replacement cancelled: Out of stock after all' });
    expect(after.c.waiting_on).toBe('marketplace');
    expect(after.events.some((e) => e.label === 'The replacement was cancelled before it shipped')).toBe(true);
    // nothing pending any more: the case can be resolved
    expect((await h.call('POST', `/api/admin/support/cases/${d.caseId}/resolve`, tokens.staff(), { summary: 'Refund instead' })).status).toBe(200);
  });

  it("asks returns for the replacement on a case with a return and links it to the remedy", async () => {
    const d = await dispute(h, { returnId: newId() });
    const res = await decide(h, d.caseId, [{ kind: 'replacement' }]);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('REMEDY_NOT_AVAILABLE');
    h.stock.set(d.product.stockItemId, 3);
    const ok = await decide(h, d.caseId, [{ kind: 'replacement' }]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(h.calls.allocations.at(-1)).toMatchObject({ orderId: d.order.id, source: { kind: 'replacement' }, lines: [{ stockItemId: d.product.stockItemId, quantity: 1, orderItemId: d.itemId }] });
    const created = h.named('returns.replacement.created').find((e) => e.caseId === d.caseId);
    expect(created).toMatchObject({ orderId: d.order.id, orderItemId: d.itemId, kind: 'replacement' });
    const [remedy] = (await h.service.core.load(d.caseId))!.remedies;
    expect(remedy).toMatchObject({ kind: 'replacement', status: 'in_progress', replacement_id: created.replacementId });
    // a replacement still drives the remedy
    expect((await h.call('POST', `/api/admin/support/cases/${d.caseId}/remedies/${remedy!.id}/settle`, tokens.staff(), { outcome: 'completed', note: 'x' })).body.error.code).toBe('REMEDY_NOT_SETTLEABLE');
  });
});

describe('remedies that would stay pending', () => {
  it('a declined refund request cancels its remedy and puts the case back in the queue', async () => {
    const d = await dispute(h);
    const res = await decide(h, d.caseId, [{ kind: 'partial_refund', amount: USD(1500) }]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [remedy] = (await h.service.core.load(d.caseId))!.remedies;
    expect(remedy!.status).toBe('pending_approval');
    // the refund request drives the remedy
    expect((await h.call('POST', `/api/admin/support/cases/${d.caseId}/remedies/${remedy!.id}/settle`, tokens.staff(), { outcome: 'completed', note: 'x' })).body.error).toMatchObject({ code: 'REMEDY_NOT_SETTLEABLE', details: { drivenBy: 'refund_request' } });
    const declined = await h.call('POST', `/api/admin/returns/refunds/${remedy!.refund_request_id}/decline`, tokens.staff(), { reason: 'Amount not justified' });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    const after = (await h.service.core.load(d.caseId))!;
    expect(after.remedies[0]).toMatchObject({ status: 'cancelled', note: 'Declined by Finance: Amount not justified' });
    expect(after.c.waiting_on).toBe('marketplace');
    // nothing pending any more: the case can be resolved
    expect((await h.call('POST', `/api/admin/support/cases/${d.caseId}/resolve`, tokens.staff(), { summary: 'Closed after review' })).status).toBe(200);
  });

  it('staff settle a remedy nothing in the system can finish; then the case resolves', async () => {
    const d = await dispute(h);
    const due = new Date(h.clock.now().getTime() + 5 * 86_400_000).toISOString();
    expect((await decide(h, d.caseId, [{ kind: 'ship_by_deadline', dueAt: due }])).status).toBe(200);
    const [remedy] = (await h.service.core.load(d.caseId))!.remedies;
    expect((await h.call('POST', `/api/admin/support/cases/${d.caseId}/resolve`, tokens.staff(), { summary: 'x' })).body.error.code).toBe('REMEDY_PENDING');
    expect((await h.call('POST', `/api/admin/support/cases/${d.caseId}/remedies/${newId()}/settle`, tokens.staff(), { outcome: 'completed', note: 'x' })).status).toBe(404);
    expect((await h.call('POST', `/api/admin/support/cases/${d.caseId}/remedies/${remedy!.id}/settle`, tokens.staff(), { outcome: 'completed', note: ' ' })).status).toBe(400);
    const settled = await h.call('POST', `/api/admin/support/cases/${d.caseId}/remedies/${remedy!.id}/settle`, tokens.staff(), { outcome: 'completed', note: 'Seller shipped by courier', externalRef: 'TKT-42' });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.case.remedies[0]).toMatchObject({ status: 'completed' });
    expect(settled.body.history.some((e: { label: string; detail: string | null }) => e.detail?.includes('TKT-42'))).toBe(true);
    expect(h.audits.find((a) => a.action === 'support.remedy.settle' && a.target.id === d.caseId)).toMatchObject({ category: 'support', after: { externalRef: 'TKT-42' } });
    expect((await h.call('POST', `/api/admin/support/cases/${d.caseId}/remedies/${remedy!.id}/settle`, tokens.staff(), { outcome: 'cancelled', note: 'again' })).body.error).toMatchObject({ code: 'REMEDY_NOT_SETTLEABLE', details: { status: 'completed' } });
    const resolved = await h.call('POST', `/api/admin/support/cases/${d.caseId}/resolve`, tokens.staff(), { summary: 'Shipped' });
    expect(resolved.status).toBe(200);
    expect(h.named('support.case.resolved').find((e) => e.caseId === d.caseId)).toMatchObject({ orderId: d.order.id, orderItemIds: [d.itemId], customerId: d.customerId });
    const reopened = await h.call('POST', `/api/admin/support/cases/${d.caseId}/reopen`, tokens.staff(), { reason: 'Customer called back' });
    expect(reopened.status).toBe(200);
    expect(h.named('support.case.reopened').find((e) => e.caseId === d.caseId)).toMatchObject({ ref: d.ref, orderId: d.order.id, orderItemIds: [d.itemId], customerId: d.customerId, contactEmail: 'sam@example.com', sellerId: d.sellerId, reason: 'Customer called back' });
  });

  it('a ship-by remedy completes on a dispatch by the date, not on a later one', async () => {
    const late = await dispute(h, {});
    const onTime = await dispute(h, {});
    const due = new Date(h.clock.now().getTime() + 2 * 86_400_000).toISOString();
    for (const d of [late, onTime]) expect((await decide(h, d.caseId, [{ kind: 'ship_by_deadline', dueAt: due }])).status).toBe(200);
    const dispatched = (d: typeof late, at: Date) => h.publish('shipping', 'shipping.shipment.dispatched', { shipmentId: newId(), kind: 'outbound', orderId: d.order.id, groupId: d.order.groups[0]!.id, ownerType: 'seller', sellerId: d.sellerId, fulfilledBy: 'seller', lines: [{ orderItemId: d.itemId, title: 'x', variantLabel: '', quantity: 1 }], shippedAt: at.toISOString(), dispatchDueAt: null, onTime: true, trackingValid: true, estimatedArrival: null });
    await dispatched(onTime, new Date(h.clock.now().getTime() + 86_400_000));
    await dispatched(late, new Date(h.clock.now().getTime() + 3 * 86_400_000));
    expect((await h.service.core.load(onTime.caseId))!.remedies[0]!.status).toBe('completed');
    expect((await h.service.core.load(late.caseId))!.remedies[0]!.status).toBe('in_progress');
  });
});

describe('events and public API', () => {
  it('notifyParties=false records the decision with notified=false (no decision message)', async () => {
    const d = await dispute(h);
    const res = await decide(h, d.caseId, [], { notifyParties: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(h.named('support.case.decided').find((e) => e.caseId === d.caseId)).toMatchObject({ notified: false, final: false });
    const quiet = await dispute(h);
    await decide(h, quiet.caseId, [], { notifyParties: true });
    expect(h.named('support.case.decided').find((e) => e.caseId === quiet.caseId)).toMatchObject({ notified: true });
  });

  it('carries the Trust and Risk report and the owner on support.case.opened', async () => {
    const o = await sellerOrder(h, { deliver: false });
    const trustReportId = newId();
    const owner = newId();
    const res = await h.call('POST', '/api/admin/support/cases', tokens.staff(), { kind: 'customer_help', category: 'delivery_late', customerId: o.customerId, orderId: o.order.id, orderItemIds: [o.itemId], subject: 'About a seller you bought from', message: 'We are contacting you about your order', ownerId: owner, trustReportId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(h.named('support.case.opened').find((e) => e.caseId === res.body.case.id)).toMatchObject({ trustReportId, ownerStaffId: owner });
  });

  it('answers which customers have open cases', async () => {
    const d = await dispute(h);
    const other = newId();
    expect(await h.service.customerIdsWithOpenCases({ ids: [d.customerId, other] })).toEqual([d.customerId]);
    expect(await h.service.customerIdsWithOpenCases({})).toContain(d.customerId);
    expect(await h.service.customerIdsWithOpenCases({ ids: [] })).toEqual([]);
  });

  it('adds an email reply from the case customer to the thread once; other senders are dropped', async () => {
    const d = await dispute(h);
    const reply = (fromEmail: string, text: string) => ({ module: 'support', refId: d.caseId, fromEmail, accountId: null, text, attachmentAssetIds: [], receivedAt: h.clock.now().toISOString() });
    const count = async () => (await h.service.core.load(d.caseId))!.messages.filter((m) => m.role === 'customer').length;
    const before = await count();
    const envelope = h.app.kernel.events.publish('notifications', 'notifications.email_reply.received', reply('Sam@Example.com', 'Here are more photos'));
    await h.app.kernel.events.drain();
    expect(await count()).toBe(before + 1);
    // the same delivery again changes nothing (inbox)
    await h.service.onEmailReplyReceivedFromNotifications(reply('sam@example.com', 'Here are more photos') as never, envelope.id);
    expect(await count()).toBe(before + 1);
    await h.publish('notifications', 'notifications.email_reply.received', reply('someone@else.example', 'Spam'));
    await h.publish('notifications', 'notifications.email_reply.received', { ...reply('sam@example.com', 'For messaging'), module: 'messaging' });
    expect(await count()).toBe(before + 1);
  });

  it('records case actions in audit under category support', async () => {
    const o = await sellerOrder(h, { deliver: false });
    const res = await h.call('POST', '/api/admin/support/cases', tokens.staff(), { kind: 'customer_help', category: 'delivery_late', customerId: o.customerId, orderId: o.order.id, orderItemIds: [o.itemId], subject: 'Late', message: 'Late order' });
    expect(h.audits.find((a) => a.action === 'support.case.create' && a.target.id === res.body.case.id)).toMatchObject({ category: 'support' });
  });

  it('scales response targets by the priority factor (urgent halves them)', async () => {
    const cases = h.service.cases;
    const cat = (await h.service.core.category('item_damaged'))!;
    const from = new Date('2026-10-12T16:00:00Z');
    const medium = await cases.marketplaceDue(cat, 'medium', true, from);
    const urgent = await cases.marketplaceDue(cat, 'urgent', true, from);
    expect(urgent.getTime()).toBeLessThan(medium.getTime());
    expect(await cases.priorityFactor('urgent')).toBe(0.5);
    expect(await cases.priorityFactor('low')).toBe(1.5);
  });
});

