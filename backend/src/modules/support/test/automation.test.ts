/**
 * Jobs (seller deadline, SLA timers, offer expiry, auto-close), consumers of other modules' events, the public
 * API other modules call and the GraphQL read layer.
 */
import { marketDate } from '../../../testing/app.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { DAY, harness, reportProblem, sellerOrder, tokens, USD, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const run = async (job: 'support.sla-timers' | 'support.seller-deadline' | 'support.offer-expiry' | 'support.auto-close') => {
  await h.app.kernel.jobs.runNow(job);
  await h.app.kernel.events.drain();
};

async function sellerCase(o: { deliver?: boolean } = {}) {
  const order = await sellerOrder(h, { deliver: o.deliver ?? true });
  const res = await reportProblem(h, { customerId: order.customerId, orderId: order.order.id, itemIds: [order.itemId], ...(o.deliver === false ? { category: 'delivery_not_arrived', problemType: 'not_arrived' } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { ...order, caseId: res.body.id as string, ref: res.body.ref as string };
}

describe('jobs', () => {
  it('Marketly steps in when the seller misses its reply deadline (support.seller-deadline)', async () => {
    const c = await sellerCase();
    await run('support.seller-deadline');
    expect((await h.call('GET', `/api/store/support/cases/${c.caseId}`, tokens.customer(c.customerId))).body.status).toBe('waiting_on_seller');
    h.clock.advance(6 * DAY);
    await run('support.seller-deadline');
    const view = await h.call('GET', `/api/store/support/cases/${c.caseId}`, tokens.customer(c.customerId));
    expect(view.body).toMatchObject({ kind: 'dispute', status: 'escalated', handledBy: { kind: 'marketplace_support' } });
    expect(h.named('support.case.escalated').find((e) => e.caseId === c.caseId)).toMatchObject({ to: 'customer_support', reason: 'seller_no_reply', sellerId: c.sellerId });
    const esc = await h.call('POST', `/api/store/support/cases/${c.caseId}/escalate`, tokens.customer(c.customerId), { reason: 'other' });
    expect(esc.status).toBe(409);
  });

  it('publishes support.case.overdue once per passed deadline (support.sla-timers)', async () => {
    const c = await sellerCase();
    h.clock.advance(6 * DAY);
    await run('support.sla-timers');
    await run('support.sla-timers');
    const overdue = h.named('support.case.overdue').filter((e) => e.caseId === c.caseId);
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatchObject({ whoMustAct: 'seller' });
    const row = (await h.call('GET', `/api/admin/support/cases?tab=overdue`, tokens.staff())).body.items.find((r: { id: string }) => r.id === c.caseId);
    expect(row.nextResponse.state).toBe('overdue');
    expect(row.deadlineLabel).toMatch(/^Overdue by/);
  });

  it('expires unanswered offers (support.offer-expiry) and refuses a late answer (OFFER_EXPIRED)', async () => {
    const c = await sellerCase();
    const reply = await h.call('POST', `/api/seller/support/cases/${c.caseId}/messages`, tokens.seller(c.sellerId), { body: 'We can send a new one', offer: { kind: 'replacement' } });
    const offerId = reply.body.offers[0].id;
    h.clock.advance(7 * DAY);
    const late = await h.call('POST', `/api/store/support/cases/${c.caseId}/offers/${offerId}/respond`, tokens.customer(c.customerId), { accept: true });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OFFER_EXPIRED');
    await run('support.offer-expiry');
    const view = await h.call('GET', `/api/store/support/cases/${c.caseId}`, tokens.customer(c.customerId));
    expect(view.body.offers[0].status).toBe('expired');
    expect(view.body.can.escalate).toBe(true);
  });

  it('closes resolved cases after autoCloseAfterDays and records the end of appeal windows (support.auto-close)', async () => {
    const c = await sellerCase();
    await h.call('POST', `/api/admin/support/cases/${c.caseId}/escalate`, tokens.staff(), { to: 'support_lead', reason: 'Lead review' });
    const decided = await h.call('POST', `/api/admin/support/cases/${c.caseId}/decide`, tokens.staff(), { outcome: 'information_only', remedies: [], reason: 'Explained the return route', notifyParties: true, appealDeadline: new Date(h.clock.now().getTime() + DAY).toISOString() }, { 'idempotency-key': newId() });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    h.clock.advance(2 * DAY);
    await run('support.auto-close');
    let detail = await h.call('GET', `/api/admin/support/cases/${c.caseId}`, tokens.staff());
    expect(detail.body.history.some((e: { label: string }) => e.label === 'The appeal window ended')).toBe(true);
    await h.call('POST', `/api/admin/support/cases/${c.caseId}/resolve`, tokens.staff(), { summary: 'Done' });
    h.clock.advance(8 * DAY);
    await run('support.auto-close');
    detail = await h.call('GET', `/api/admin/support/cases/${c.caseId}`, tokens.staff());
    expect(detail.body.case.status).toBe('closed');
    const store = await h.call('GET', `/api/store/support/cases?state=closed`, tokens.customer(c.customerId));
    expect(store.body.items[0]).toMatchObject({ id: c.caseId, open: false });
    expect(store.body.items[0].expectedReply).toMatch(/^Closed /);
  });

  it('an agreed ship-by date that passes unshipped falls back to a refund', async () => {
    const c = await sellerCase({ deliver: false });
    const shipBy = marketDate(h.clock.now(), 2);
    const reply = await h.call('POST', `/api/seller/support/cases/${c.caseId}/messages`, tokens.seller(c.sellerId), { body: 'It ships soon', offer: { kind: 'ship_by_date', shipBy } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const accepted = await h.call('POST', `/api/store/support/cases/${c.caseId}/offers/${reply.body.offers[0].id}/respond`, tokens.customer(c.customerId), { accept: true });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.remedies[0]).toMatchObject({ kind: 'ship_by_deadline', status: 'in_progress' });
    expect(accepted.body.status).toBe('waiting_on_seller');
    h.clock.advance(4 * DAY);
    await run('support.sla-timers');
    const view = await h.call('GET', `/api/store/support/cases/${c.caseId}`, tokens.customer(c.customerId));
    expect(view.body.remedies.map((r: { kind: string; status: string }) => [r.kind, r.status])).toEqual([
      ['ship_by_deadline', 'cancelled'],
      ['refund', 'pending_approval'],
    ]);
    expect(view.body.remedies[1].refundRequestId).toBeTruthy();
  });
});

describe('consumers', () => {
  it('a ship-by remedy completes when the item is delivered', async () => {
    const c = await sellerCase({ deliver: false });
    const shipBy = marketDate(h.clock.now(), 3);
    const reply = await h.call('POST', `/api/seller/support/cases/${c.caseId}/messages`, tokens.seller(c.sellerId), { body: 'Shipping Friday', offer: { kind: 'ship_by_date', shipBy } });
    await h.call('POST', `/api/store/support/cases/${c.caseId}/offers/${reply.body.offers[0].id}/respond`, tokens.customer(c.customerId), { accept: true });
    const lines = [{ orderItemId: c.itemId, quantity: 1, title: 'Linen Throw', variantLabel: '' }];
    await h.publish('shipping', 'shipping.shipment.delivered', { shipmentId: newId(), kind: 'outbound', orderId: c.order.id, groupId: c.order.groups[0]!.id, sellerId: c.sellerId, fulfilledBy: 'seller', lines, deliveredAt: h.clock.now().toISOString() });
    const view = await h.call('GET', `/api/store/support/cases/${c.caseId}`, tokens.customer(c.customerId));
    expect(view.body.remedies[0]).toMatchObject({ kind: 'ship_by_deadline', status: 'completed', statusLabel: 'Shipped' });
  });

  it('a refund that fails puts the case back in the queue', async () => {
    const c = await sellerCase();
    await h.call('POST', `/api/admin/support/cases/${c.caseId}/escalate`, tokens.staff(), { to: 'support_lead', reason: 'Review' });
    const decided = await h.call('POST', `/api/admin/support/cases/${c.caseId}/decide`, tokens.staff(), { outcome: 'customer_favored', remedies: [{ kind: 'refund' }], reason: 'Damaged', notifyParties: true }, { 'idempotency-key': newId() });
    const rrId = decided.body.case.remedies[0].refundRequestId as string;
    await h.call('POST', `/api/admin/returns/refunds/${rrId}/approve`, tokens.staff(), {}, { 'idempotency-key': newId() });
    await h.publish('payments', 'payments.refund.failed', { refundId: newId(), ref: 'RF-2', orderId: c.order.id, origin: 'case', originId: rrId, amount: USD(4900), reason: 'Card closed', attempts: 3, finalAttempt: true });
    const detail = await h.call('GET', `/api/admin/support/cases/${c.caseId}`, tokens.staff());
    expect(detail.body.case.remedies[0]).toMatchObject({ status: 'failed' });
    expect(detail.body.case.remedies[0].note).toMatch(/Card closed/);
    expect(detail.body.case.nextAction).toMatchObject({ whoMustAct: 'marketplace', label: 'Marketly support is fixing the refund' });
    expect(detail.body.case.expectedResponse).toBeTruthy();
    await run('support.sla-timers');
    expect(h.named('support.case.overdue').find((e) => e.caseId === c.caseId)).toMatchObject({ whoMustAct: 'marketplace' });
  });

  it('a dispatch overdue warning opens the customer escalation route', async () => {
    const c = await sellerCase({ deliver: false });
    expect((await h.call('POST', `/api/store/support/cases/${c.caseId}/escalate`, tokens.customer(c.customerId), { reason: 'other' })).status).toBe(409);
    await h.publish('shipping', 'shipping.dispatch.overdue', { orderId: c.order.id, orderRef: c.order.ref, groupId: c.order.groups[0]!.id, ownerType: 'seller', sellerId: c.sellerId, fulfilledBy: 'seller', orderItemIds: [c.itemId], dueAt: h.clock.now().toISOString(), exceptionId: newId() });
    const view = await h.call('GET', `/api/store/support/cases/${c.caseId}`, tokens.customer(c.customerId));
    expect(view.body.can.escalate).toBe(true);
    expect(view.body.timeline.some((t: { label: string }) => t.label === 'The seller missed the dispatch deadline')).toBe(true);
    const esc = await h.call('POST', `/api/store/support/cases/${c.caseId}/escalate`, tokens.customer(c.customerId), { reason: 'other', note: 'I need it for a gift' });
    expect(esc.status, JSON.stringify(esc.body)).toBe(200);
    expect(esc.body).toMatchObject({ status: 'escalated', kind: 'dispute' });
  });

  it('a lost package opens a case when the customer has none (shipping.shipment.exception)', async () => {
    const o = await sellerOrder(h, { deliver: false });
    // an exception raised from a customer's report (it already has its case) opens nothing, even with a package
    await h.publish('shipping', 'shipping.shipment.exception', { exceptionId: newId(), kind: 'lost_or_damaged', orderId: o.order.id, groupId: o.order.groups[0]!.id, shipmentId: newId(), sellerId: o.sellerId, fulfilledBy: 'seller', orderItemIds: [o.itemId], dueAt: h.clock.now().toISOString(), customerAction: null, source: 'customer_report', caseRef: 'CS-000999' });
    expect(await h.service.casesForOrder(o.order.id)).toHaveLength(0);
    // nor one opened from a case (caseRef) or reported by the seller
    await h.publish('shipping', 'shipping.shipment.exception', { exceptionId: newId(), kind: 'lost_or_damaged', orderId: o.order.id, groupId: o.order.groups[0]!.id, shipmentId: newId(), sellerId: o.sellerId, fulfilledBy: 'seller', orderItemIds: [o.itemId], dueAt: h.clock.now().toISOString(), customerAction: null, source: 'staff', caseRef: 'CS-000998' });
    await h.publish('shipping', 'shipping.shipment.exception', { exceptionId: newId(), kind: 'lost_or_damaged', orderId: o.order.id, groupId: o.order.groups[0]!.id, shipmentId: newId(), sellerId: o.sellerId, fulfilledBy: 'seller', orderItemIds: [o.itemId], dueAt: h.clock.now().toISOString(), customerAction: null, source: 'seller', caseRef: null });
    expect(await h.service.casesForOrder(o.order.id)).toHaveLength(0);
    await h.publish('shipping', 'shipping.shipment.exception', { exceptionId: newId(), kind: 'lost_or_damaged', orderId: o.order.id, groupId: o.order.groups[0]!.id, shipmentId: newId(), sellerId: o.sellerId, fulfilledBy: 'seller', orderItemIds: [o.itemId], dueAt: h.clock.now().toISOString(), customerAction: null, source: 'carrier', caseRef: null });
    const cases = await h.service.casesForOrder(o.order.id);
    expect(cases).toHaveLength(1);
    const opened = h.named('support.case.opened').find((e) => e.caseId === cases[0]!.caseId);
    expect(opened).toMatchObject({ kind: 'order_problem', category: 'item_damaged', customerId: o.customerId, orderItemIds: [o.itemId] });
    await h.publish('shipping', 'shipping.shipment.exception', { exceptionId: newId(), kind: 'lost_or_damaged', orderId: o.order.id, groupId: o.order.groups[0]!.id, shipmentId: newId(), sellerId: o.sellerId, fulfilledBy: 'seller', orderItemIds: [o.itemId], dueAt: h.clock.now().toISOString(), customerAction: null, source: 'system', caseRef: null });
    expect(await h.service.casesForOrder(o.order.id)).toHaveLength(1);
  });

  it('a restricted seller that cannot sell: its seller-handled cases go to Marketly support', async () => {
    const c = await sellerCase();
    await h.publish('sellers', 'sellers.seller.restricted', { sellerId: c.sellerId, restrictionId: newId(), reasonCode: 'policy', reason: 'Counterfeit reports', affectedActivities: ['sales', 'new_offers'], scope: {}, categoryIds: [], appealRoute: 'Seller Center', appealDeadline: h.clock.now().toISOString(), reviewDate: h.clock.now().toISOString().slice(0, 10) });
    const view = await h.call('GET', `/api/seller/support/cases/${c.caseId}`, tokens.seller(c.sellerId));
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ status: 'escalated', handledBy: { kind: 'marketplace_support' } });
  });

  it('openCase with a return links an open case on the same items and makes it the dispute; the same return gets the same case', async () => {
    const c = await sellerCase();
    const returnId = newId();
    const view = await h.service.openCase({ kind: 'dispute', category: 'return', orderId: c.order.id, orderItemIds: [c.itemId], customerId: c.customerId, sellerId: c.sellerId, returnId, subject: 'Return RT-1', message: 'The customer asked Marketly to step in', openedBy: { kind: 'customer', id: c.customerId } });
    expect(view.id).toBe(c.caseId);
    expect(view).toMatchObject({ kind: 'dispute', status: 'escalated', returnId });
    const again = await h.service.openCase({ kind: 'dispute', category: 'return', orderId: c.order.id, returnId, subject: 'x', message: 'y', openedBy: { kind: 'system' } });
    expect(again.id).toBe(c.caseId);
    const map = await h.service.getCasesForReturns([returnId, newId()], { area: 'seller', sellerId: c.sellerId });
    expect((map[returnId] as { id: string }).id).toBe(c.caseId);
    expect(await h.service.getCasesForReturns([returnId], { area: 'seller', sellerId: newId() })).toEqual({ [returnId]: null });
  });

  it('returns.return.escalated without a case opens a Returns-team dispute', async () => {
    const o = await sellerOrder(h);
    const returnId = newId();
    await h.publish('returns', 'returns.return.escalated', { returnId, ref: 'RT-000001-0001', orderId: o.order.id, orderRef: o.order.ref, ownerType: 'seller', sellerId: o.sellerId, reason: 'seller_no_response', by: { kind: 'system' } });
    const [k] = await h.service.casesForOrder(o.order.id);
    expect(k).toBeDefined();
    const admin = await h.service.getCaseAdmin(k!.ref);
    expect(admin).toMatchObject({ team: 'Returns', case: { kind: 'dispute', status: 'escalated', returnId } });
    await h.publish('returns', 'returns.return.escalated', { returnId, ref: 'RT-000001-0001', orderId: o.order.id, orderRef: o.order.ref, ownerType: 'seller', sellerId: o.sellerId, reason: 'seller_no_response', by: { kind: 'system' } });
    expect(await h.service.casesForOrder(o.order.id)).toHaveLength(1);
  });
});

describe('public API and GraphQL', () => {
  it('answers the in-process reads other modules use', async () => {
    const c = await sellerCase();
    const today = marketDate(h.clock.now());
    const stats = await h.service.sellerCaseStats(c.sellerId, { from: today, to: today });
    expect(stats).toMatchObject({ open: 1, unresolved: 1, decidedAgainstSeller: 0 });
    const other = newId();
    expect(await h.service.countOpenCasesForProducts([c.product.productId, other])).toEqual({ [c.product.productId]: 1, [other]: 0 });
    const page = await h.service.listCasesForSeller(c.sellerId, { open: true }, { limit: 10 });
    expect(page.items.map((r) => r.id)).toEqual([c.caseId]);
    expect((await h.service.listCasesForOrder(c.order.id, { area: 'store', customerId: c.customerId })).map((v) => v.id)).toEqual([c.caseId]);
    expect(await h.service.listCasesForOrder(c.order.id, { area: 'store', customerId: newId() })).toEqual([]);
    expect(await h.service.getCaseForSeller(newId(), c.ref)).toBeNull();
    expect((await h.service.getCaseForSeller(c.sellerId, c.ref))?.id).toBe(c.caseId);
    expect((await h.service.listCasesForCustomer(c.customerId, { open: true }, { limit: 5 })).items[0]?.id).toBe(c.caseId);
    const rows = await h.service.exportRows('support.admin.cases', { q: c.ref }, { kind: 'staff', accountId: newId() });
    expect(rows.rows).toEqual([expect.objectContaining({ ref: c.ref, seller: 'Casa Verde Home', orderRef: c.order.ref })]);
    await expect(h.service.exportRows('support.admin.cases', {}, { kind: 'seller', sellerId: c.sellerId })).rejects.toThrow();
  });

  it('serves Case through GraphQL with the same record scope', async () => {
    const c = await sellerCase();
    const q = `query($ref: String!) { case(ref: $ref) { id ref kind status statusLabel open handledBy { kind name } nextAction { whoMustAct youNeedToAct } items { orderItemId ownerType price { formatted } } messages { role audience } can { reply escalate } } }`;
    const mine = await h.gql('store', tokens.customer(c.customerId), q, { ref: c.ref });
    expect(mine.errors, JSON.stringify(mine.errors)).toBeUndefined();
    expect(mine.data.case).toMatchObject({ id: c.caseId, kind: 'ORDER_PROBLEM', status: 'WAITING_ON_SELLER', open: true, handledBy: { kind: 'SELLER' }, nextAction: { whoMustAct: 'SELLER', youNeedToAct: false }, items: [{ orderItemId: c.itemId, ownerType: 'SELLER', price: { formatted: '$49.00' } }] });
    const other = await h.gql('store', tokens.customer(newId()), q, { ref: c.ref });
    expect(other.data.case).toBeNull();
    const admin = await h.gql('admin', tokens.staff(), `query($ref: String!) { caseAdmin(ref: $ref) { ref team reopened customer { name } seller { name ownerType } purchaseTerms { item pricePaid { amount } } deadlines { label party } history { label } evidence { party } } }`, { ref: c.ref });
    expect(admin.errors, JSON.stringify(admin.errors)).toBeUndefined();
    expect(admin.data.caseAdmin).toMatchObject({ ref: c.ref, team: 'Customer Support', reopened: false, customer: { name: 'Sam Rivera' }, seller: { name: 'Casa Verde Home', ownerType: 'SELLER' }, purchaseTerms: { pricePaid: { amount: 4900 } } });
    expect(admin.data.caseAdmin.deadlines[0]).toMatchObject({ label: 'Seller reply due', party: 'SELLER' });
    const seller = await h.gql('seller', tokens.seller(c.sellerId), `query($ref: String!) { sellerCase(ref: $ref) { ref marketplaceInvolved evidence { party } } }`, { ref: c.ref });
    expect(seller.errors, JSON.stringify(seller.errors)).toBeUndefined();
    expect(seller.data.sellerCase).toMatchObject({ ref: c.ref, marketplaceInvolved: true });
    const notMine = await h.gql('seller', tokens.seller(newId()), `query($ref: String!) { sellerCase(ref: $ref) { ref } }`, { ref: c.ref });
    expect(notMine.data.sellerCase).toBeNull();
  });
});
