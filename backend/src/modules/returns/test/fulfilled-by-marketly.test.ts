/**
 * Fulfilled by Marketly returns (decision D7): a return of a seller's item Marketly fulfilled is platform handled
 * from the request, uses the seller's terms and window, is approved automatically inside that window
 * (autoApproveServiceWithinWindow), goes to the Marketly returns dock, is received by the warehouse and
 * inspected by Marketly, and its refund is funded by the seller. The seller follows it read-only.
 * returns.return.requested / approved / received / inspected and ReturnCase carry fulfilledBy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { group, harness, idem, line, makeServiceGroup, now, placeOrder, product, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});
beforeEach(() => {
  h.settings.clear();
  h.authority.decision = 'allowed';
});

const staff = () => tokens.staff();

/** A delivered order with one seller group Marketly fulfilled */
async function serviceOrder() {
  const sellerId = newId();
  const p = product(h, { title: 'Desk lamp', price: 6000, sellerId, windowDays: 30 });
  const m = await placeOrder(h, [group(h, [line(p, 1)], { sellerId })]);
  await makeServiceGroup(h, m.order.groups[0]!.id);
  return { ...m, p, sellerId, token: tokens.customer(m.customerId), seller: tokens.seller(sellerId) };
}

async function request(m: Awaited<ReturnType<typeof serviceOrder>>, reason = 'defective') {
  const res = await h.call('POST', '/api/store/returns/requests', m.token, { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 1 }], reason, details: 'Flickers', remedy: 'refund' }, idem());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.returns[0];
}

describe('Fulfilled by Marketly returns', () => {
  it('shows the Marketly returns dock and Marketly as the responder before the request', async () => {
    const m = await serviceOrder();
    const res = await h.call('POST', '/api/store/returns/eligibility', m.token, { orderId: m.order.id, items: [{ orderItemId: m.items[0]![0]!, quantity: 1 }], reason: 'defective' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const dock = await h.service.core.officialReturnAddress();
    expect(res.body.groups[0]).toMatchObject({ ownerType: 'seller', sellerId: m.sellerId, responseBy: 'Marketly', destination: { kind: 'marketly_warehouse', address: { line1: dock.line1 } } });
  });

  it('is platform handled from the request and approved automatically, with a label to the Marketly dock', async () => {
    const m = await serviceOrder();
    const ret = await request(m);
    expect(ret).toMatchObject({ status: 'approved', handledBy: 'marketplace_support', seller: { ownerType: 'seller', id: m.sellerId } });
    expect(h.named('returns.return.requested').find((e) => e.returnId === ret.id)).toMatchObject({ ownerType: 'seller', sellerId: m.sellerId, fulfilledBy: 'marketly_service' });
    expect(h.named('returns.return.approved').find((e) => e.returnId === ret.id)).toMatchObject({ ownerType: 'seller', sellerId: m.sellerId, fulfilledBy: 'marketly_service', platformDecision: true, withoutReturn: false });

    // the label: from the customer to the Marketly returns dock, paid as the seller's terms say (not by the company)
    const dock = await h.service.core.officialReturnAddress();
    const label = h.calls.labels.find((l) => l.returnId === ret.id)!;
    expect(label).toMatchObject({ kind: 'return', from: { line1: '1 Main St', city: 'Portland' }, to: { line1: dock.line1, city: dock.city } });
    expect(label.billedTo).not.toBe('company');

    const row = (await h.service.core.repo.get('returns', ret.id))!;
    expect(row).toMatchObject({ fulfilled_by: 'marketly_service', platform_handling: true, handled_by: 'marketplace_support', decision: { kind: 'approved', platformDecision: true } });

    const admin = await h.call('GET', `/api/admin/returns/requests/${ret.id}`, staff());
    expect(admin.body).toMatchObject({ fulfilledBy: 'marketly_service' });
    expect(admin.body.flags.map((f: any) => f.kind)).toContain('platform_took_over');
  });

  it('waits for Marketly staff when automatic approval is off; the seller cannot decide it', async () => {
    h.settings.set('returns.autoApproveServiceWithinWindow', false);
    const m = await serviceOrder();
    const ret = await request(m, 'changed_mind');
    expect(ret.status).toBe('requested');
    expect(h.named('returns.return.approved').find((e) => e.returnId === ret.id)).toBeUndefined();

    // read-only for the seller: no actions, and every decision is refused with a message naming Marketly
    const view = await h.call('GET', `/api/seller/returns/requests/${ret.id}`, m.seller);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ fulfilledBy: 'marketly_service', allowedActions: ['evidence'], detail: { handledBy: 'marketplace_support' } });
    for (const [path, body] of [
      ['approve', { labelMethod: 'prepaid_qr' }],
      ['request-info', { question: 'Which bulb?' }],
      ['reject', { reasonCode: 'other', explanation: 'No' }],
      ['approve-without-return', { reasonCode: 'return_cost_exceeds_value', details: 'Keep it', remedy: { kind: 'full_refund' } }],
    ] as const) {
      const res = await h.call('POST', `/api/seller/returns/requests/${ret.id}/${path}`, m.seller, body, idem());
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(409);
      expect(res.body.error.code).toBe('ILLEGAL_TRANSITION');
      expect(res.body.error.message).toMatch(/Marketly handles/);
    }
    // not a response the seller owes: no respond-by reminder, not awaiting the seller, not a dispute
    const counts = await h.call('GET', '/api/seller/returns/requests/counts', m.seller);
    expect(counts.body).toMatchObject({ awaitingResponse: 0, responseOverdue: 0, toInspect: 0, tabs: { disputes: 0 } });
    const list = await h.call('GET', '/api/seller/returns/requests?tab=requests', m.seller);
    expect(list.body.items.find((r: any) => r.id === ret.id)).toMatchObject({ statusLabel: 'Return requested', platformInvolved: true });

    // Marketly decides it as the platform
    const approved = await h.call('POST', `/api/admin/returns/requests/${ret.id}/approve`, staff(), { labelMethod: 'prepaid_qr' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(h.named('returns.return.approved').find((e) => e.returnId === ret.id)).toMatchObject({ fulfilledBy: 'marketly_service', platformDecision: true });
  });

  it('is received at the dock, inspected by Marketly and refunded with seller funding', async () => {
    const m = await serviceOrder();
    const ret = await request(m);

    // the dock's inspection queue lists it next to Official Store returns
    const arriving = await h.call('GET', '/api/admin/returns/inspections?tab=arriving', staff());
    expect(arriving.body.items.map((r: any) => r.returnId)).toContain(ret.id);

    // the seller does not receive or inspect it
    const sellerReceive = await h.call('POST', `/api/seller/returns/requests/${ret.id}/receive`, m.seller, {});
    expect(sellerReceive.status).toBe(409);

    const scanned = await h.service.recordWarehouseReceipt(ret.id, now(), { kind: 'staff', id: newId(), name: 'Dock' }, null);
    expect(scanned.status).toBe('received');
    await h.app.kernel.events.drain();
    expect(h.named('returns.return.received').find((e) => e.returnId === ret.id)).toMatchObject({ ownerType: 'seller', sellerId: m.sellerId, fulfilledBy: 'marketly_service', items: [{ orderItemId: m.items[0]![0]!, quantity: 1, stockItemId: m.p.stockItemId }] });
    const received = await h.call('GET', '/api/admin/returns/inspections?tab=received', staff());
    expect(received.body.items.map((r: any) => r.returnId)).toContain(ret.id);
    const stats = await h.call('GET', '/api/admin/returns/inspections/stats', staff());
    expect(stats.body.waiting).toBeGreaterThanOrEqual(1);
    const sellerCounts = await h.call('GET', '/api/seller/returns/requests/counts', m.seller);
    expect(sellerCounts.body.toInspect).toBe(0);

    const sellerInspect = await h.call('POST', `/api/seller/returns/requests/${ret.id}/inspection`, m.seller, { conditionOutcome: 'as_described', grade: 'like_new', proposedStockOutcome: 'restock', checks: [] });
    expect(sellerInspect.status).toBe(409);
    const inspected = await h.call('POST', `/api/admin/returns/requests/${ret.id}/inspection`, staff(), { conditionOutcome: 'as_described', grade: 'like_new', proposedStockOutcome: 'restock', checks: [{ label: 'Lights up', passed: true }] });
    expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
    expect(h.named('returns.return.inspected').find((e) => e.returnId === ret.id)).toMatchObject({ ownerType: 'seller', fulfilledBy: 'marketly_service', proposedStockOutcome: 'restock', stockItemId: m.p.stockItemId, quantity: 1 });

    // Marketly decides the remedy; the refund goes to Finance and is funded by the seller (seller of record)
    const sellerRemedy = await h.call('POST', `/api/seller/returns/requests/${ret.id}/remedy`, m.seller, { kind: 'full_refund' }, idem());
    expect(sellerRemedy.status).toBe(409);
    const remedy = await h.call('POST', `/api/admin/returns/requests/${ret.id}/remedy`, staff(), { kind: 'full_refund' }, idem());
    expect(remedy.status, JSON.stringify(remedy.body)).toBe(200);
    expect(remedy.body.refundRequest).toMatchObject({ source: 'return', status: 'under_review', fundedBy: 'seller', ownerType: 'seller', sellerId: m.sellerId });
    const ok = await h.call('POST', `/api/admin/returns/refunds/${remedy.body.refundRequest.id}/approve`, staff(), {}, idem());
    expect(ok.body.status).toBe('processing');
    expect(h.named('returns.refund.approved').find((e) => e.refundRequestId === remedy.body.refundRequest.id)).toMatchObject({ ownerType: 'seller', fundedBy: 'seller' });

    // the seller sees it all read-only, with the earnings impact of the refund it funds
    const view = await h.call('GET', `/api/seller/returns/requests/${ret.id}`, m.seller);
    expect(view.body).toMatchObject({ fulfilledBy: 'marketly_service', refundRequest: { fundedBy: 'seller' }, earningsImpact: { refundToCustomer: { amount: 6000 } } });
    expect(view.body.allowedActions).toEqual(['evidence']);
  });

  it('keeps fulfilledBy official_warehouse and seller on other returns', async () => {
    const official = product(h, { title: 'Kettle', price: 5000, ownerType: 'official' });
    const o = await placeOrder(h, [group(h, [line(official, 1)], { ownerType: 'official' })]);
    const a = await h.call('POST', '/api/store/returns/requests', tokens.customer(o.customerId), { orderId: o.order.id, items: [{ orderItemId: o.items[0]![0]!, quantity: 1 }], reason: 'defective', details: 'x', remedy: 'refund' }, idem());
    expect(h.named('returns.return.requested').find((e) => e.returnId === a.body.returns[0].id)).toMatchObject({ ownerType: 'official', fulfilledBy: 'official_warehouse' });
    expect(h.named('returns.return.approved').find((e) => e.returnId === a.body.returns[0].id)).toMatchObject({ fulfilledBy: 'official_warehouse', platformDecision: false });

    const sellerId = newId();
    const own = product(h, { title: 'Vase', price: 4000, sellerId });
    const s = await placeOrder(h, [group(h, [line(own, 1)], { sellerId })]);
    const b = await h.call('POST', '/api/store/returns/requests', tokens.customer(s.customerId), { orderId: s.order.id, items: [{ orderItemId: s.items[0]![0]!, quantity: 1 }], reason: 'damaged', details: 'x', remedy: 'refund' }, idem());
    const ret = b.body.returns[0];
    expect(ret).toMatchObject({ status: 'requested', handledBy: 'seller' });
    expect(h.named('returns.return.requested').find((e) => e.returnId === ret.id)).toMatchObject({ ownerType: 'seller', fulfilledBy: 'seller' });
    const view = await h.call('GET', `/api/seller/returns/requests/${ret.id}`, tokens.seller(sellerId));
    expect(view.body).toMatchObject({ fulfilledBy: 'seller' });
    expect(view.body.allowedActions).toContain('approve');
  });
});
