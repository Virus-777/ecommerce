/** Inbound shipments: plan, edit, submit with labels, ship, cancel, arrive, receive into seller-owned stock, discrepancies. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { A, ADDRESS, arrivedInbound, boot, S, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const key = () => ({ 'idempotency-key': newId() });

describe('inbound shipments', () => {
  it('plans, edits, submits with labels, ships and cancels within the allowed states', async () => {
    const s = await k.enrolledSeller();
    const created = await k.call('POST', S('/inbound'), { token: s.token, body: { shipFrom: ADDRESS, lines: [{ skuEnrollmentId: s.skuId, quantity: 10 }], boxes: 2 } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ state: 'draft', sellerId: s.sellerId, boxes: 2, destination: { name: 'Marketly Fulfillment', city: 'Reno', region: 'NV' }, lines: [{ skuEnrollmentId: s.skuId, sku: s.sku, expected: 10, received: 0 }], labels: [] });
    expect(created.body.ref).toMatch(/^IB-\d{6}-\d{4}$/);
    const id = created.body.id;

    // another seller: 404 everywhere
    const other = await k.seller();
    expect((await k.call('GET', S(`/inbound/${id}`), { token: other.token })).status).toBe(404);
    expect((await k.call('POST', S(`/inbound/${id}/submit`), { token: other.token })).status).toBe(404);

    const edited = await k.call('PATCH', S(`/inbound/${id}`), { token: s.token, body: { shipFrom: ADDRESS, lines: [{ skuEnrollmentId: s.skuId, quantity: 12 }], boxes: 3, expectedArrival: '2099-01-10' } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ boxes: 3, expectedArrival: '2099-01-10', lines: [{ expected: 12 }] });

    // the storage allowance (100 cubic feet; 30×20×10 cm ≈ 0.21 ft³ per unit)
    const tooMuch = await k.call('POST', S('/inbound'), { token: s.token, body: { shipFrom: ADDRESS, lines: [{ skuEnrollmentId: s.skuId, quantity: 1000 }], boxes: 40 } });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe('CAPACITY_EXCEEDED');

    const submitted = await k.call('POST', S(`/inbound/${id}/submit`), { token: s.token });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.state).toBe('submitted');
    expect(submitted.body.labels).toHaveLength(1);
    expect(submitted.body.labels[0].url).toMatch(/^http/);
    expect(k.events('fulfillment-service.inbound.submitted').at(-1)).toEqual({ inboundId: id, sellerId: s.sellerId, units: 12, expectedArrival: '2099-01-10' });
    const sku = (await k.call('GET', S('/skus'), { token: s.token })).body.items.find((x: any) => x.id === s.skuId);
    expect(sku.stock.inbound).toBe(12);

    // after submitting only carrier, tracking and dates change
    const relines = await k.call('PATCH', S(`/inbound/${id}`), { token: s.token, body: { shipFrom: ADDRESS, lines: [{ skuEnrollmentId: s.skuId, quantity: 5 }], boxes: 3 } });
    expect(relines.status).toBe(409);
    const tracking = await k.call('PATCH', S(`/inbound/${id}`), { token: s.token, body: { shipFrom: ADDRESS, lines: [{ skuEnrollmentId: s.skuId, quantity: 12 }], boxes: 3, carrier: 'UPS' } });
    expect(tracking.body.carrier).toBe('UPS');

    expect((await k.call('POST', S(`/inbound/${id}/ship`), { token: s.token, body: { carrier: 'UPS', tracking: '' } })).status).toBe(400);
    const shipped = await k.call('POST', S(`/inbound/${id}/ship`), { token: s.token, body: { carrier: 'UPS', tracking: '1Z12345E0205271688' } });
    expect(shipped.body).toMatchObject({ state: 'in_transit', tracking: '1Z12345E0205271688' });
    // in transit can't be cancelled
    expect((await k.call('POST', S(`/inbound/${id}/cancel`), { token: s.token, body: {} })).status).toBe(409);

    const second = await k.call('POST', S('/inbound'), { token: s.token, body: { shipFrom: ADDRESS, lines: [{ skuEnrollmentId: s.skuId, quantity: 4 }], boxes: 1 } });
    await k.call('POST', S(`/inbound/${second.body.id}/submit`), { token: s.token });
    const cancelled = await k.call('POST', S(`/inbound/${second.body.id}/cancel`), { token: s.token, body: { reason: 'Wrong items' } });
    expect(cancelled.body.state).toBe('cancelled');
    expect(cancelled.body.timeline.map((t: any) => t.label)).toEqual(['Inbound shipment planned', 'Submitted', 'Cancelled']);
    const after = (await k.call('GET', S('/skus'), { token: s.token })).body.items.find((x: any) => x.id === s.skuId);
    expect(after.stock.inbound).toBe(12);

    const queue = await k.call('GET', A(`/inbound?sellerId=${s.sellerId}&state=in_transit&expectedFrom=2099-01-01&expectedTo=2099-01-31`));
    expect(queue.body.items.map((x: any) => x.id)).toEqual([id]);
    expect((await k.call('GET', A(`/inbound?sellerId=${s.sellerId}&expectedTo=2098-12-31`))).body.items).toHaveLength(0);
  });

  it('receives partially then completely into seller-owned stock (inventory too), with fees and a discrepancy the seller claims', async () => {
    const s = await k.enrolledSeller();
    const id = await arrivedInbound(k, s, 10);
    let view = await k.call('GET', S(`/inbound/${id}`), { token: s.token });
    expect(view.body.state).toBe('arrived');
    expect((await k.call('GET', S('/skus'), { token: s.token })).body.items[0].stock).toMatchObject({ inbound: 0, receiving: 10 });

    const bad = await k.call('POST', A(`/inbound/${id}/receive`), { body: { lines: [{ skuEnrollmentId: s.skuId, received: 2, damaged: 3 }], complete: false }, headers: key() });
    expect(bad.status).toBe(400);

    const partial = await k.call('POST', A(`/inbound/${id}/receive`), { body: { lines: [{ skuEnrollmentId: s.skuId, received: 5, damaged: 1 }], complete: false, note: 'Crushed corner' }, headers: key() });
    expect(partial.status, JSON.stringify(partial.body)).toBe(200);
    expect(partial.body).toMatchObject({ state: 'receiving', lines: [{ expected: 10, received: 5, damaged: 1, missing: 0 }] });
    expect(k.events('fulfillment-service.inbound.received').at(-1)).toEqual({ inboundId: id, sellerId: s.sellerId, received: 5, damaged: 1, complete: false });
    // 4 sellable units are seller-owned stock in inventory now; the SKU and the enrollment are active
    expect((await k.inventory.getAvailability([s.stockItemId]))[s.stockItemId]!.available).toBe(4);
    const sku = (await k.call('GET', S('/skus'), { token: s.token })).body.items[0];
    expect(sku).toMatchObject({ state: 'active', stock: { available: 4, unsellable: 1, receiving: 5 } });
    expect(sku.stock.agedDays['0-90']).toBe(10);
    expect((await k.call('GET', S('/enrollment'), { token: s.token })).body.state).toBe('active');

    const done = await k.call('POST', A(`/inbound/${id}/receive`), { body: { lines: [{ skuEnrollmentId: s.skuId, received: 3, damaged: 0 }], complete: true, evidenceIds: [] }, headers: key() });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ state: 'received', lines: [{ expected: 10, received: 8, damaged: 1, missing: 2, extra: 0 }], discrepancy: { sellerResponse: 'pending' } });
    expect(done.body.discrepancy.summary).toBe(`${s.sku}: 2 short, 1 damaged`);
    expect((await k.inventory.getAvailability([s.stockItemId]))[s.stockItemId]!.available).toBe(7);
    // receiving (8 units) and labelling (no barcode: 8 units) fees, per inbound
    expect(done.body.fees.map((f: any) => [f.type, f.units, f.amount.amount, f.state])).toEqual([
      ['receiving', 5, 125, 'accrued'],
      ['labelling', 5, 275, 'accrued'],
      ['receiving', 3, 75, 'accrued'],
      ['labelling', 3, 165, 'accrued'],
    ]);
    expect(done.body.timeline.map((t: any) => t.label)).toEqual(expect.arrayContaining(['Submitted', 'Arrived at the warehouse', 'Units received', 'Damaged units received', 'Units missing', 'Receiving completed']));
    expect((await k.call('POST', A(`/inbound/${id}/receive`), { body: { lines: [], complete: true }, headers: key() })).status).toBe(409);

    // only a claimed discrepancy can be decided
    expect((await k.call('POST', A(`/inbound/${id}/discrepancy-decision`), { body: { decision: 'reject', reason: 'x' }, headers: key() })).status).toBe(409);
    const claimed = await k.call('POST', S(`/inbound/${id}/discrepancy-response`), { token: s.token, body: { response: 'claimed', note: 'We packed 10, see the packing list' } });
    expect(claimed.body.discrepancy).toMatchObject({ sellerResponse: 'claimed', claimNote: 'We packed 10, see the packing list' });
    expect((await k.call('POST', S(`/inbound/${id}/discrepancy-response`), { token: s.token, body: { response: 'accepted' } })).status).toBe(409);
    const tooMany = await k.call('POST', A(`/inbound/${id}/discrepancy-decision`), { body: { decision: 'adjust_stock', units: 3, reason: 'Found' }, headers: key() });
    expect(tooMany.status).toBe(400);
    const adjusted = await k.call('POST', A(`/inbound/${id}/discrepancy-decision`), { body: { decision: 'adjust_stock', units: 1, reason: 'Found one unit in the next pallet' }, headers: key() });
    expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(200);
    expect(adjusted.body).toMatchObject({ state: 'closed', lines: [{ received: 9, missing: 1 }], discrepancy: { decidedBy: { kind: 'staff' } } });
    expect(adjusted.body.discrepancy.decision).toContain('1 unit added');
    expect((await k.inventory.getAvailability([s.stockItemId]))[s.stockItemId]!.available).toBe(8);

    const movements = await k.call('GET', S(`/skus/${s.skuId}/movements`), { token: s.token });
    expect(movements.body.items.map((m: any) => [m.movement, m.quantity, m.fromGroup, m.toGroup])).toEqual([
      ['adjusted', 1, null, 'available'],
      ['missing', 2, 'receiving', null],
      ['received', 3, 'receiving', 'available'],
      ['received_damaged', 1, 'receiving', 'unsellable'],
      ['received', 4, 'receiving', 'available'],
      ['arrived', 10, 'inbound', 'receiving'],
      ['inbound_expected', 10, null, 'inbound'],
    ]);
  });

  it('accepts a discrepancy, reimburses within or above the limit, and closes unanswered ones after discrepancyResponseDays', async () => {
    const s = await k.enrolledSeller();
    const short = async () => {
      const id = await arrivedInbound(k, s, 5);
      const r = await k.call('POST', A(`/inbound/${id}/receive`), { body: { lines: [{ skuEnrollmentId: s.skuId, received: 4, damaged: 0 }], complete: true }, headers: key() });
      expect(r.body.discrepancy.sellerResponse).toBe('pending');
      return id;
    };
    const a = await short();
    const accepted = await k.call('POST', S(`/inbound/${a}/discrepancy-response`), { token: s.token, body: { response: 'accepted' } });
    expect(accepted.body).toMatchObject({ state: 'closed', discrepancy: { sellerResponse: 'accepted' } });

    // reimbursement within the limit
    const b = await short();
    await k.call('POST', S(`/inbound/${b}/discrepancy-response`), { token: s.token, body: { response: 'claimed', note: 'Missing unit' } });
    expect((await k.call('POST', A(`/inbound/${b}/discrepancy-decision`), { body: { decision: 'reimburse', reason: 'Lost at the dock' }, headers: key() })).status).toBe(400);
    const paid = await k.call('POST', A(`/inbound/${b}/discrepancy-decision`), { body: { decision: 'reimburse', amount: { amount: 1800, currency: 'USD' }, reason: 'Lost at the dock' }, headers: key() });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.state).toBe('closed');
    expect(paid.body.fees.find((f: any) => f.type === 'reimbursement')).toMatchObject({ amount: { amount: -1800 }, state: 'accrued', reason: 'Lost at the dock' });

    // above the limit: approval, then access.approval.decided applies it
    const c = await short();
    await k.call('POST', S(`/inbound/${c}/discrepancy-response`), { token: s.token, body: { response: 'claimed', note: 'Missing unit' } });
    k.authority.set('fulfillment-service.reimbursements.approve', 'approval_required');
    const pending = await k.call('POST', A(`/inbound/${c}/discrepancy-decision`), { body: { decision: 'reimburse', amount: { amount: 90_000, currency: 'USD' }, reason: 'Pallet lost' }, headers: key() });
    k.authority.delete('fulfillment-service.reimbursements.approve');
    expect(pending.status).toBe(409);
    expect(pending.body.error.code).toBe('APPROVAL_REQUIRED');
    const req = k.approvals.at(-1)!;
    expect(req).toMatchObject({ action: 'fulfillment-service.reimbursements.approve', target: { type: 'inbound_discrepancy', id: c, sellerId: s.sellerId }, amount: { amount: 90_000 } });
    expect((await k.call('GET', S(`/inbound/${c}`), { token: s.token })).body.state).toBe('received');
    await k.publish('access', 'access.approval.decided', { requestId: pending.body.error.details.approvalRequestId, ref: 'AP-1', actionKey: req.action, module: 'fulfillment-service', target: req.target, outcome: 'approved', decidedBy: { kind: 'staff', id: newId(), name: 'Finance' }, reason: null, amount: { amount: 90_000, currency: 'USD' }, approverIds: [], requestedById: newId() });
    const decided = await k.call('GET', S(`/inbound/${c}`), { token: s.token });
    expect(decided.body.state).toBe('closed');
    expect(decided.body.discrepancy.decision).toContain('Reimbursed 900.00 USD');

    // nobody answers: closed by the daily job after 14 days
    const d = await short();
    k.clock.advance(15 * 86_400_000);
    await k.app.kernel.jobs.runNow('fulfillment-service.inbound-overdue');
    const auto = await k.call('GET', S(`/inbound/${d}`), { token: s.token });
    expect(auto.body).toMatchObject({ state: 'closed', discrepancy: { sellerResponse: 'accepted', decidedBy: { kind: 'system' } } });
    expect(auto.body.discrepancy.decision).toContain('after 14 days');
  });
});
