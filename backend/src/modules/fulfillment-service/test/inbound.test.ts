/**
 * Inbound shipments: plan, edit, submit (inventory Incoming), ship, cancel, arrive, receiving records submitted to
 * inventory as service receipts, the Inventory Manager's confirmation (decision D3), discrepancies.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { A, ADDRESS, arrivedInbound, boot, decideCredit, S, WAREHOUSE, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const key = () => ({ 'idempotency-key': newId() });
const sku = async (s: { token: string; skuId: string }) => (await k.call('GET', S('/skus'), { token: s.token })).body.items.find((x: any) => x.id === s.skuId);

describe('inbound shipments', () => {
  it('plans to the service location, edits, submits (inventory expects the units), ships and cancels within the allowed states', async () => {
    const s = await k.enrolledSeller();
    const created = await k.call('POST', S('/inbound'), { token: s.token, body: { shipFrom: ADDRESS, lines: [{ skuEnrollmentId: s.skuId, quantity: 10 }], boxes: 2 } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // the destination is the service location's address (decision D12)
    expect(created.body).toMatchObject({ state: 'draft', sellerId: s.sellerId, boxes: 2, destination: WAREHOUSE, lines: [{ skuEnrollmentId: s.skuId, sku: s.sku, expected: 10, received: 0 }], receipts: [], labels: [] });
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
    expect((await sku(s)).stock.inbound).toBe(12);
    // inventory: Incoming at the service location; the Warehouse Manager hears of it
    expect(k.inv.level(s.stockItemId).incoming).toBe(12);
    expect(k.notices.find((n) => n.dedupeKey === `fs:inbound:${id}:submitted`)).toMatchObject({ topic: 'staff.fulfillment.inbound_submitted', recipients: [{ kind: 'staff_role', roleKey: 'warehouse_manager' }], link: { ref: submitted.body.ref } });

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
    expect(k.inv.level(s.stockItemId).incoming).toBe(16);
    const cancelled = await k.call('POST', S(`/inbound/${second.body.id}/cancel`), { token: s.token, body: { reason: 'Wrong items' } });
    expect(cancelled.body.state).toBe('cancelled');
    expect(cancelled.body.timeline.map((t: any) => t.label)).toEqual(['Inbound shipment planned', 'Submitted', 'Cancelled']);
    expect((await sku(s)).stock.inbound).toBe(12);
    expect(k.inv.level(s.stockItemId).incoming).toBe(12);

    const queue = await k.call('GET', A(`/inbound?sellerId=${s.sellerId}&state=in_transit&expectedFrom=2099-01-01&expectedTo=2099-01-31`));
    expect(queue.body.items.map((x: any) => x.id)).toEqual([id]);
    expect((await k.call('GET', A(`/inbound?sellerId=${s.sellerId}&expectedTo=2098-12-31`))).body.items).toHaveLength(0);
  });

  it('counts units into Receiving, submits each record to inventory and makes them available only when the Inventory Manager confirms', async () => {
    const s = await k.enrolledSeller();
    const id = await arrivedInbound(k, s, 10);
    const view = await k.call('GET', S(`/inbound/${id}`), { token: s.token });
    expect(view.body.state).toBe('arrived');
    expect((await sku(s)).stock).toMatchObject({ inbound: 0, receiving: 10 });
    expect(k.audits.find((a) => a.action === 'fulfillment-service.inbound.arrive' && a.target.id === id)).toMatchObject({ after: { state: 'arrived', boxesArrived: 1 } });

    const bad = await k.call('POST', A(`/inbound/${id}/receive`), { body: { lines: [{ skuEnrollmentId: s.skuId, received: 2, damaged: 3 }], complete: false }, headers: key() });
    expect(bad.status).toBe(400);

    const partial = await k.call('POST', A(`/inbound/${id}/receive`), { body: { lines: [{ skuEnrollmentId: s.skuId, received: 5, damaged: 1 }], complete: false, note: 'Crushed corner' }, headers: key() });
    expect(partial.status, JSON.stringify(partial.body)).toBe(200);
    expect(partial.body).toMatchObject({ state: 'receiving', lines: [{ expected: 10, received: 5, damaged: 1, missing: 0 }], receipts: [{ seq: 1, state: 'submitted', received: 5, damaged: 1, countedBy: { kind: 'staff' }, confirmedAt: null }] });
    const first = partial.body.receipts[0].id;
    // the record went to inventory's confirmation queue and to warehouse put-away (counts of this record only)
    expect(k.inv.receipts.get(first)!.input).toMatchObject({ receiptId: first, inboundId: id, inboundRef: partial.body.ref, sellerId: s.sellerId, locationId: k.locationId, lines: [{ stockItemId: s.stockItemId, expected: 10, received: 5, damaged: 1 }] });
    expect(k.events('fulfillment-service.inbound.received').at(-1)).toEqual({ inboundId: id, ref: partial.body.ref, receiptId: first, sellerId: s.sellerId, locationId: k.locationId, received: 5, damaged: 1, complete: false, lines: [{ skuEnrollmentId: s.skuId, stockItemId: s.stockItemId, sku: s.sku, label: `Linen throw ${s.sku}`, received: 5, damaged: 1 }] });
    // nothing is sellable yet (decision D3)
    expect((await sku(s))).toMatchObject({ state: 'approved', stock: { available: 0, unsellable: 0, receiving: 10 } });
    expect((await k.call('GET', S('/enrollment'), { token: s.token })).body.state).toBe('approved');
    expect(k.inv.setCalls.filter((c) => c.stockItemId === s.stockItemId)).toEqual([]);

    // the Inventory Manager confirms the first record
    await k.inv.confirm(first);
    let after = await sku(s);
    expect(after).toMatchObject({ state: 'active', stock: { available: 4, unsellable: 1, receiving: 5 } });
    expect(after.stock.agedDays['0-90']).toBe(10);
    expect((await k.call('GET', S('/enrollment'), { token: s.token })).body.state).toBe('active');
    expect(k.inv.setCalls.filter((c) => c.stockItemId === s.stockItemId)).toEqual([{ stockItemId: s.stockItemId, locationId: k.locationId }]);
    expect(k.events('fulfillment-service.offer.service_changed').filter((e) => e.offerId === s.offerId)).toEqual([{ offerId: s.offerId, sellerId: s.sellerId, skuEnrollmentId: s.skuId, stockItemId: s.stockItemId, fulfilledBy: 'marketly_service', sellable: true, reason: 'sku_activated', at: expect.any(String) }]);
    expect(k.notices.find((n) => n.dedupeKey === `fs:receipt:${first}:confirmed`)).toMatchObject({ topic: 'seller.fulfillment.stock_available', context: { inbound: { ref: partial.body.ref }, units: 4 } });
    expect(k.inv.level(s.stockItemId)).toMatchObject({ available: 4, damagedHeld: 1, incoming: 5 });
    // delivered twice: applied once
    await k.publish('inventory', 'inventory.receipt.confirmed', { inboundId: k.inv.receipts.get(first)!.id, receiptId: first, source: { kind: 'service_inbound', id, ref: partial.body.ref }, ownerType: 'seller', sellerId: s.sellerId, purchaseOrderId: null, locationId: k.locationId, lines: [], confirmedBy: { kind: 'staff', id: newId(), name: 'IM' } });
    expect((await sku(s)).stock).toMatchObject({ available: 4, unsellable: 1 });

    const done = await k.call('POST', A(`/inbound/${id}/receive`), { body: { lines: [{ skuEnrollmentId: s.skuId, received: 3, damaged: 0 }], complete: true, evidenceIds: [] }, headers: key() });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ state: 'received', lines: [{ expected: 10, received: 8, damaged: 1, missing: 2, extra: 0 }], discrepancy: { sellerResponse: 'pending' } });
    expect(done.body.receipts.map((r: any) => [r.seq, r.state])).toEqual([
      [1, 'confirmed'],
      [2, 'submitted'],
    ]);
    expect(done.body.discrepancy.summary).toBe(`${s.sku}: 2 short, 1 damaged`);
    // the open Incoming is cancelled; the counted units wait for their confirmation
    expect(k.inv.level(s.stockItemId).incoming).toBe(3);
    expect((await sku(s)).stock).toMatchObject({ available: 4, receiving: 3 });
    expect(k.notices.find((n) => n.dedupeKey === `fs:inbound:${id}:received`)).toMatchObject({ topic: 'seller.fulfillment.inbound_received', context: { inbound: { ref: done.body.ref }, received: 8, damaged: 1, discrepancy: `${s.sku}: 2 short, 1 damaged` } });
    // receiving and labelling (no barcode) fees per receiving record
    expect(done.body.fees.map((f: any) => [f.type, f.units, f.amount.amount, f.state])).toEqual([
      ['receiving', 5, 125, 'accrued'],
      ['labelling', 5, 275, 'accrued'],
      ['receiving', 3, 75, 'accrued'],
      ['labelling', 3, 165, 'accrued'],
    ]);
    expect((await k.call('POST', A(`/inbound/${id}/receive`), { body: { lines: [], complete: true }, headers: key() })).status).toBe(409);
    expect(k.audits.filter((a) => a.action === 'fulfillment-service.inbound.receive' && a.target.id === id)).toHaveLength(2);

    // the Inventory Manager accepts only 2 of the 3 units: the third leaves the ledger
    const second = done.body.receipts[1].id;
    await k.inv.confirm(second, { [s.stockItemId]: { sellable: 2, damaged: 0 } });
    expect((await sku(s)).stock).toMatchObject({ available: 6, unsellable: 1, receiving: 0 });
    const confirmed = await k.call('GET', S(`/inbound/${id}`), { token: s.token });
    expect(confirmed.body.receipts.map((r: any) => r.state)).toEqual(['confirmed', 'confirmed']);
    expect(confirmed.body.timeline.map((t: any) => t.label)).toEqual(expect.arrayContaining(['Submitted', 'Arrived at the warehouse', 'Units counted', 'Units received', 'Damaged units received', 'Units missing', 'Units not accepted', 'Receiving completed']));

    // only a claimed discrepancy can be decided
    expect((await k.call('POST', A(`/inbound/${id}/discrepancy-decision`), { body: { decision: 'reject', reason: 'x' }, headers: key() })).status).toBe(409);
    const claimed = await k.call('POST', S(`/inbound/${id}/discrepancy-response`), { token: s.token, body: { response: 'claimed', note: 'We packed 10, see the packing list' } });
    expect(claimed.body.discrepancy).toMatchObject({ sellerResponse: 'claimed', claimNote: 'We packed 10, see the packing list' });
    expect(k.notices.find((n) => n.dedupeKey === `fs:inbound:${id}:claimed`)).toMatchObject({ topic: 'staff.fulfillment.discrepancy_claimed', link: { ref: done.body.ref } });
    expect(k.work.find((w) => w.dedupeKey === `fs_discrepancy:${id}`)).toMatchObject({ queueKey: 'fulfillment.receiving', kind: 'receiving', sellerId: s.sellerId });
    expect((await k.call('POST', S(`/inbound/${id}/discrepancy-response`), { token: s.token, body: { response: 'accepted' } })).status).toBe(409);
    const tooMany = await k.call('POST', A(`/inbound/${id}/discrepancy-decision`), { body: { decision: 'adjust_stock', units: 3, reason: 'Found' }, headers: key() });
    expect(tooMany.status).toBe(400);
    const adjusted = await k.call('POST', A(`/inbound/${id}/discrepancy-decision`), { body: { decision: 'adjust_stock', units: 1, reason: 'Found one unit in the next pallet' }, headers: key() });
    expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(200);
    expect(adjusted.body).toMatchObject({ state: 'closed', lines: [{ received: 9, missing: 1 }], discrepancy: { decidedBy: { kind: 'staff' } } });
    expect(adjusted.body.discrepancy.decision).toContain('1 unit added');
    // the found unit enters inventory at the service location (service_found)
    expect(k.inv.moves().find((m) => m.key === `fs:found:${id}:${s.skuId}`)).toMatchObject({ from: null, to: 'available', quantity: 1, reasonCode: 'service_found', locationId: k.locationId });
    expect(k.inv.level(s.stockItemId).available).toBe(7);
    expect(k.resolved).toContain(`fs_discrepancy:${id}`);
    expect(k.notices.find((n) => n.dedupeKey === `fs:discrepancy:${id}`)).toMatchObject({ topic: 'seller.fulfillment.discrepancy_decided', context: { inbound: { ref: done.body.ref } } });

    const movements = await k.call('GET', S(`/skus/${s.skuId}/movements`), { token: s.token });
    expect(movements.body.items.map((m: any) => [m.movement, m.quantity, m.fromGroup, m.toGroup])).toEqual([
      ['adjusted', 1, null, 'available'],
      ['not_accepted', 1, 'receiving', null],
      ['received', 2, 'receiving', 'available'],
      ['missing', 2, 'receiving', null],
      ['received_damaged', 1, 'receiving', 'unsellable'],
      ['received', 4, 'receiving', 'available'],
      ['arrived', 10, 'inbound', 'receiving'],
      ['inbound_expected', 10, null, 'inbound'],
    ]);
  });

  it('adds extra units at confirmation and ignores purchase-order receipts', async () => {
    const s = await k.enrolledSeller();
    const id = await arrivedInbound(k, s, 2);
    const r = await k.call('POST', A(`/inbound/${id}/receive`), { body: { lines: [{ skuEnrollmentId: s.skuId, received: 3, damaged: 1 }], complete: true }, headers: key() });
    expect(r.body).toMatchObject({ state: 'received', lines: [{ expected: 2, received: 3, extra: 1, missing: 0 }], discrepancy: { summary: `${s.sku}: 1 damaged, 1 extra` } });
    await k.publish('inventory', 'inventory.receipt.confirmed', { inboundId: newId(), receiptId: newId(), source: { kind: 'purchase_order', id: newId(), ref: 'PO-1' }, ownerType: 'official', sellerId: null, purchaseOrderId: newId(), locationId: k.locationId, lines: [], confirmedBy: { kind: 'staff', id: newId(), name: 'IM' } });
    await k.inv.confirmAll(id);
    expect((await sku(s)).stock).toMatchObject({ available: 2, unsellable: 1, receiving: 0 });
    const movements = (await k.call('GET', S(`/skus/${s.skuId}/movements`), { token: s.token })).body.items.map((m: any) => [m.movement, m.quantity, m.fromGroup, m.toGroup, m.reason]);
    expect(movements).toEqual(expect.arrayContaining([['received', 2, 'receiving', 'available', null], ['received_damaged', 1, null, 'unsellable', 'Damaged on arrival']]));
  });

  it('accepts a discrepancy, reimburses within or above the limit (finance credits read back, withdrawn), flags overdue shipments and closes unanswered discrepancies', async () => {
    const s = await k.enrolledSeller();
    const short = async () => {
      const id = await arrivedInbound(k, s, 5);
      const r = await k.call('POST', A(`/inbound/${id}/receive`), { body: { lines: [{ skuEnrollmentId: s.skuId, received: 4, damaged: 0 }], complete: true }, headers: key() });
      expect(r.body.discrepancy.sellerResponse).toBe('pending');
      return id;
    };
    const claim = (id: string) => k.call('POST', S(`/inbound/${id}/discrepancy-response`), { token: s.token, body: { response: 'claimed', note: 'Missing unit' } });
    const a = await short();
    const accepted = await k.call('POST', S(`/inbound/${a}/discrepancy-response`), { token: s.token, body: { response: 'accepted' } });
    expect(accepted.body).toMatchObject({ state: 'closed', discrepancy: { sellerResponse: 'accepted' } });

    // reimbursement within the limit
    const b = await short();
    await claim(b);
    expect((await k.call('POST', A(`/inbound/${b}/discrepancy-decision`), { body: { decision: 'reimburse', reason: 'Lost at the dock' }, headers: key() })).status).toBe(400);
    const paid = await k.call('POST', A(`/inbound/${b}/discrepancy-decision`), { body: { decision: 'reimburse', amount: { amount: 80, currency: 'USD' }, reason: 'Lost at the dock' }, headers: key() });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.state).toBe('closed');
    const reimbursement = paid.body.fees.find((f: any) => f.type === 'reimbursement');
    expect(reimbursement).toMatchObject({ amount: { amount: -80 }, state: 'accrued', reason: 'Lost at the dock' });
    expect(k.audits.find((x) => x.action === 'fulfillment-service.inbound.discrepancy_decide' && x.target.id === b)).toMatchObject({ category: 'financial', after: { decision: 'reimburse' } });

    // above the limit: approval, then access.approval.decided applies it
    const c = await short();
    await claim(c);
    k.authority.set('fulfillment-service.reimbursements.approve', 'approval_required');
    const pending = await k.call('POST', A(`/inbound/${c}/discrepancy-decision`), { body: { decision: 'reimburse', amount: { amount: 90_000, currency: 'USD' }, reason: 'Pallet lost' }, headers: key() });
    k.authority.delete('fulfillment-service.reimbursements.approve');
    expect(pending.status).toBe(409);
    expect(pending.body.error.code).toBe('APPROVAL_REQUIRED');
    const req = k.approvals.at(-1)!;
    expect(req).toMatchObject({ action: 'fulfillment-service.reimbursements.approve', target: { type: 'inbound_discrepancy', id: c, sellerId: s.sellerId }, amount: { amount: 90_000 } });
    expect((await k.call('GET', S(`/inbound/${c}`), { token: s.token })).body.state).toBe('received');
    const decided = { requestId: pending.body.error.details.approvalRequestId, ref: 'AP-1', actionKey: req.action, module: 'fulfillment-service', target: req.target, outcome: 'approved', decidedBy: { kind: 'staff', id: newId(), name: 'Finance' }, reason: null, amount: { amount: 90_000, currency: 'USD' }, approverIds: [], requestedById: newId() };
    await k.publish('access', 'access.approval.decided', decided);
    const after = await k.call('GET', S(`/inbound/${c}`), { token: s.token });
    expect(after.body.state).toBe('closed');
    expect(after.body.discrepancy.decision).toContain('Reimbursed $900.00');
    // delivered twice: one reimbursement
    await k.publish('access', 'access.approval.decided', decided);
    expect((await k.call('GET', S(`/inbound/${c}`), { token: s.token })).body.fees.filter((f: any) => f.type === 'reimbursement')).toHaveLength(1);

    // posting: fees go to the ledger as service_fee; a reimbursement is a seller credit without an original charge
    await k.app.kernel.jobs.runNow('fulfillment-service.post-fees');
    const bFees = (await k.call('GET', S(`/inbound/${b}`), { token: s.token })).body.fees as any[];
    expect(bFees.find((f) => f.id === reimbursement.id)).toMatchObject({ state: 'posted' });
    const key80 = `fulfillment-service:reimbursement:${reimbursement.id}`;
    expect(k.financeLedger.filter((e) => e.type === 'seller_credit' && e.sellerId === s.sellerId)).toEqual([
      expect.objectContaining({ amount: { amount: 80, currency: 'USD' }, reason: 'Lost at the dock', idempotencyKey: key80, reference: { kind: 'fulfillment_service', id: reimbursement.id, ref: expect.any(String) } }),
    ]);
    expect(k.events('fulfillment-service.fee.charged')).toEqual(expect.arrayContaining([expect.objectContaining({ chargeId: reimbursement.id, type: 'reimbursement', amount: { amount: -80, currency: 'USD' }, period: reimbursement.period })]));

    // above finance's threshold the credit waits for Finance: later runs read it back (getSellerCredit), never ask again
    const cCharge = () => k.call('GET', S(`/inbound/${c}`), { token: s.token }).then((r) => (r.body.fees as any[]).find((f) => f.type === 'reimbursement'));
    expect(await cCharge()).toMatchObject({ amount: { amount: -90_000 }, state: 'accrued' });
    const cCredit = k.financeCredits.find((x) => x.amount.amount === 90_000 && x.sellerId === s.sellerId)!;
    expect(cCredit).toMatchObject({ status: 'pending_approval', idempotencyKey: `fulfillment-service:reimbursement:${(await cCharge()).id}` });
    const asked = k.financeCalls.creditSeller;
    await k.app.kernel.jobs.runNow('fulfillment-service.post-fees');
    expect(k.financeCalls.creditSeller).toBe(asked);
    expect(await cCharge()).toMatchObject({ state: 'accrued' });
    decideCredit(k.financeLedger, cCredit, 'posted');
    await k.app.kernel.jobs.runNow('fulfillment-service.post-fees');
    expect(await cCharge()).toMatchObject({ state: 'posted' });
    expect(k.financeLedger.filter((e) => e.type === 'seller_credit' && e.idempotencyKey === cCredit.idempotencyKey)).toHaveLength(1);

    // a credit Finance rejects reverses the reimbursement
    const e = await short();
    await claim(e);
    expect((await k.call('POST', A(`/inbound/${e}/discrepancy-decision`), { body: { decision: 'reimburse', amount: { amount: 60_000, currency: 'USD' }, reason: 'Crushed carton' }, headers: key() })).status).toBe(200);
    await k.app.kernel.jobs.runNow('fulfillment-service.post-fees');
    const eCredit = k.financeCredits.find((x) => x.amount.amount === 60_000 && x.sellerId === s.sellerId)!;
    expect(eCredit.status).toBe('pending_approval');
    decideCredit(k.financeLedger, eCredit, 'rejected');
    await k.app.kernel.jobs.runNow('fulfillment-service.post-fees');
    const eCharge = ((await k.call('GET', S(`/inbound/${e}`), { token: s.token })).body.fees as any[]).find((f) => f.type === 'reimbursement');
    expect(eCharge).toMatchObject({ state: 'reversed', reason: 'Finance did not approve the reimbursement' });
    expect(k.events('fulfillment-service.fee.reversed')).toEqual(expect.arrayContaining([expect.objectContaining({ chargeId: eCharge.id, amount: { amount: -60_000, currency: 'USD' }, period: eCharge.period })]));

    // staff reverse an accrued reimbursement whose credit waits for Finance: the credit is withdrawn
    const f = await short();
    await claim(f);
    await k.call('POST', A(`/inbound/${f}/discrepancy-decision`), { body: { decision: 'reimburse', amount: { amount: 70_000, currency: 'USD' }, reason: 'Crushed carton' }, headers: key() });
    await k.app.kernel.jobs.runNow('fulfillment-service.post-fees');
    const fCredit = k.financeCredits.find((x) => x.amount.amount === 70_000 && x.sellerId === s.sellerId)!;
    const fCharge = ((await k.call('GET', S(`/inbound/${f}`), { token: s.token })).body.fees as any[]).find((x) => x.type === 'reimbursement');
    const reversed = await k.call('POST', A(`/fees/${fCharge.id}/reverse`), { body: { reason: 'Unit found after all' }, headers: key() });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(reversed.body.state).toBe('reversed');
    expect(fCredit.status).toBe('withdrawn');

    // an overdue shipment raises a receiving work item; nobody answers a discrepancy: closed after 14 days
    const late = await k.call('POST', S('/inbound'), { token: s.token, body: { shipFrom: ADDRESS, lines: [{ skuEnrollmentId: s.skuId, quantity: 1 }], boxes: 1, expectedArrival: new Date(k.clock.now().getTime() + 2 * 86_400_000).toISOString().slice(0, 10) } });
    await k.call('POST', S(`/inbound/${late.body.id}/submit`), { token: s.token });
    const d = await short();
    // The job closes what has waited more than 14 market days, so the advance has to clear 14 calendar days.
    // 15 x 24 h does not, in the week before a DST change: started just after local midnight it lands at 23:00 on
    // day 14. 16 x 24 h clears it either way round.
    k.clock.advance(16 * 86_400_000);
    await k.app.kernel.jobs.runNow('fulfillment-service.inbound-overdue');
    expect(k.work.find((w) => w.dedupeKey === `fs_inbound_overdue:${late.body.id}`)).toMatchObject({ queueKey: 'fulfillment.receiving', kind: 'receiving', subject: { ref: late.body.ref } });
    const auto = await k.call('GET', S(`/inbound/${d}`), { token: s.token });
    expect(auto.body).toMatchObject({ state: 'closed', discrepancy: { sellerResponse: 'accepted', decidedBy: { kind: 'system' } } });
    expect(auto.body.discrepancy.decision).toContain('after 14 days');
    expect((await k.call('POST', A(`/inbound/${late.body.id}/arrive`), { body: { boxesArrived: 1 } })).status).toBe(200);
    expect(k.resolved).toContain(`fs_inbound_overdue:${late.body.id}`);
  });
});
