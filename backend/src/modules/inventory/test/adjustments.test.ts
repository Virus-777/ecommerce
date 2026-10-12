/** Company stock adjustments: reasons, review dates, group limits and second review through access. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { admin, eventsNamed, harness, ledgerMismatches, officialItem, quantities, sellerItem, table, warehouse, type Harness } from './helpers.js';

let h: Harness;
let loc: { id: string };

beforeAll(async () => {
  h = await harness();
  loc = await warehouse(h, 'RNO1');
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(async () => {
  await h.app.kernel.events.drain();
  h.events.length = 0;
  h.audits.length = 0;
  h.costs.length = 0;
  h.access.decision = 'allowed';
  h.access.requests.length = 0;
  h.access.cancelled.length = 0;
});

const decide = async (requestId: string, outcome: 'approved' | 'rejected' | 'cancelled' | 'expired') => {
  h.app.kernel.events.publish('access', 'access.approval.decided', {
    requestId,
    ref: 'AP-261009-0001',
    actionKey: 'inventory.adjustments.apply',
    module: 'inventory',
    target: { type: 'stock_adjustment', id: newId() },
    outcome,
    decidedBy: { kind: 'staff', id: newId(), name: 'Dana Ortiz' },
    reason: outcome === 'approved' ? 'Checked the count' : 'Recount first',
    approverIds: [],
    requestedById: newId(),
  });
  await h.app.kernel.events.drain();
};

describe('company stock adjustments', () => {
  it('applies within the limit: one movement, events and audit with before/after', async () => {
    const item = await officialItem(h, loc.id, 10);
    const res = await admin(h, 'POST', '/adjustments', { stockItemId: item.id, fromGroup: 'available', toGroup: 'damaged_held', quantity: 2, reasonCode: 'quality_hold', note: 'Scuffed boxes', reviewDate: '2026-11-01' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      state: 'applied',
      stockItemId: item.id,
      locationId: loc.id,
      fromGroup: 'available',
      toGroup: 'damaged_held',
      quantity: 2,
      reasonLabel: 'Quality hold',
      reviewDate: '2026-11-01',
      before: { available: 10, damagedHeld: 0 },
      after: { available: 8, damagedHeld: 2 },
      affectedReservedUnits: 0,
      approval: null,
      requestedBy: { kind: 'staff', name: 'Priya Nair' },
      appliedAt: expect.any(String),
    });
    expect(eventsNamed(h, 'inventory.adjustment.recorded')).toEqual([expect.objectContaining({ adjustmentId: res.json().id, ownerType: 'official', sellerId: null, fromGroup: 'available', toGroup: 'damaged_held', quantity: 2, reasonCode: 'quality_hold' })]);
    expect(eventsNamed(h, 'inventory.stock.changed').filter((e) => e.cause === 'adjustment')).toEqual([expect.objectContaining({ available: 8, previousAvailable: 10 })]);
    expect(h.audits.at(-1)).toMatchObject({ action: 'inventory.adjustment.apply', before: expect.objectContaining({ available: 10 }), after: expect.objectContaining({ available: 8 }), approvalNote: 'Within your 50 units limit' });

    // the held units come back out (oldest hold first) and found stock enters
    const back = await admin(h, 'POST', '/adjustments', { stockItemId: item.id, fromGroup: 'damaged_held', toGroup: 'available', quantity: 2, reasonCode: 'other' });
    expect(back.json().after).toMatchObject({ available: 10, damagedHeld: 0 });
    const found = await admin(h, 'POST', '/adjustments', { stockItemId: item.id, fromGroup: 'outside', toGroup: 'available', quantity: 3, reasonCode: 'found_stock' });
    expect(found.json().after).toMatchObject({ available: 13 });
    const list = (await admin(h, 'GET', `/adjustments?stockItemId=${item.id}`)).json();
    expect(list.items).toHaveLength(3);
    const ledger = (await admin(h, 'GET', `/movements?stockItemId=${item.id}&referenceKind=adjustment`)).json();
    expect(ledger.items).toHaveLength(3);
    expect(await ledgerMismatches(h)).toEqual([]);
  });

  it('validates groups, review dates and quantities', async () => {
    const item = await officialItem(h, loc.id, 2);
    const base = { stockItemId: item.id, quantity: 1, reasonCode: 'other' };
    const noDate = await admin(h, 'POST', '/adjustments', { ...base, fromGroup: 'available', toGroup: 'damaged_held' });
    expect(noDate.statusCode).toBe(400);
    expect(noDate.json().error.code).toBe('REVIEW_DATE_REQUIRED');
    const tooMany = await admin(h, 'POST', '/adjustments', { ...base, quantity: 3, fromGroup: 'available', toGroup: 'outside' });
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json().error).toMatchObject({ code: 'GROUP_QUANTITY_EXCEEDED', details: { group: 'available', quantity: 2 } });
    expect((await admin(h, 'POST', '/adjustments', { ...base, fromGroup: 'outside', toGroup: 'outside' })).statusCode).toBe(400);
    expect((await admin(h, 'POST', '/adjustments', { ...base, quantity: 0, fromGroup: 'available', toGroup: 'outside' })).statusCode).toBe(400);
    // reserved is not a group staff can adjust (refused by the request schema)
    expect((await admin(h, 'POST', '/adjustments', { ...base, fromGroup: 'reserved', toGroup: 'outside' })).statusCode).toBe(400);
    const sellers = await sellerItem(h, newId(), 3);
    expect((await admin(h, 'POST', '/adjustments', { ...base, stockItemId: sellers.id, fromGroup: 'available', toGroup: 'outside' })).statusCode).toBe(400);
    expect((await admin(h, 'POST', '/adjustments', { ...base, stockItemId: newId(), fromGroup: 'available', toGroup: 'outside' })).statusCode).toBe(404);
    h.access.decision = 'denied';
    expect((await admin(h, 'POST', '/adjustments', { ...base, fromGroup: 'available', toGroup: 'outside' })).statusCode).toBe(403);
    expect(await quantities(h, item.id)).toMatchObject({ available: 2 });
  });

  it('reports written-off company stock to finance at cost', async () => {
    const item = await officialItem(h, loc.id, 0);
    await table(h, 'stock_items').update(item.id, { unit_cost_amount: 4500 });
    await admin(h, 'POST', '/adjustments', { stockItemId: item.id, fromGroup: 'outside', toGroup: 'available', quantity: 4, reasonCode: 'found_stock' });
    await admin(h, 'POST', '/adjustments', { stockItemId: item.id, fromGroup: 'available', toGroup: 'outside', quantity: 2, reasonCode: 'theft_or_loss' });
    expect(h.costs).toEqual([expect.objectContaining({ kind: 'write_off', amount: { amount: 9000, currency: 'USD' }, reference: expect.objectContaining({ kind: 'adjustment' }) })]);
  });

  it('waits for a second reviewer above the limit; nothing moves until approved', async () => {
    const item = await officialItem(h, loc.id, 80);
    h.access.decision = 'approval_required';
    const secondReviewerId = newId();
    const res = await admin(h, 'POST', '/adjustments', { stockItemId: item.id, fromGroup: 'available', toGroup: 'outside', quantity: 60, reasonCode: 'count_correction', note: 'Cycle count', secondReviewerId });
    expect(res.statusCode, res.body).toBe(201);
    const adj = res.json();
    expect(adj).toMatchObject({ state: 'pending_review', before: { available: 80 }, after: { available: 20 }, approval: { required: true, approvalRequestId: h.access.lastRequestId, approvers: ['Dana Ortiz'] } });
    expect(h.access.requests[0]).toMatchObject({ action: 'inventory.adjustments.apply', quantity: 60, nominatedReviewerId: secondReviewerId, target: expect.objectContaining({ type: 'stock_adjustment', id: adj.id }), reason: 'Cycle count' });
    expect(await quantities(h, item.id)).toMatchObject({ available: 80 });
    expect(eventsNamed(h, 'inventory.adjustment.recorded')).toEqual([]);
    const pending = (await admin(h, 'GET', '/adjustments?state=pending_review')).json();
    expect(pending.items.map((a: { id: string }) => a.id)).toContain(adj.id);
    expect((await admin(h, 'GET', `/stock-items/${item.id}`)).json().pendingAdjustments.map((a: { id: string }) => a.id)).toEqual([adj.id]);

    await decide(h.access.lastRequestId!, 'approved');
    await decide(h.access.requests.length ? h.access.lastRequestId! : '', 'approved'); // replay: applied once
    expect(await quantities(h, item.id)).toMatchObject({ available: 20 });
    const after = (await admin(h, 'GET', `/adjustments?stockItemId=${item.id}`)).json().items[0];
    expect(after).toMatchObject({ state: 'applied', decidedBy: { name: 'Dana Ortiz' }, before: { available: 80 }, after: { available: 20 } });
    expect(eventsNamed(h, 'inventory.adjustment.recorded')).toEqual([expect.objectContaining({ adjustmentId: adj.id, quantity: 60, actor: expect.objectContaining({ name: 'Priya Nair' }) })]);
    const move = (await admin(h, 'GET', `/movements?stockItemId=${item.id}&reasonCode=count_correction`)).json().items[0];
    expect(move).toMatchObject({ actor: { name: 'Priya Nair' }, approvedBy: { name: 'Dana Ortiz' } });
    expect((await admin(h, 'POST', `/adjustments/${adj.id}/cancel`, { reason: 'late' })).statusCode).toBe(409);
  });

  it('marks rejected or withdrawn adjustments and leaves the stock alone', async () => {
    const item = await officialItem(h, loc.id, 70);
    h.access.decision = 'approval_required';
    const a = (await admin(h, 'POST', '/adjustments', { stockItemId: item.id, fromGroup: 'available', toGroup: 'outside', quantity: 55, reasonCode: 'write_off' })).json();
    await decide(h.access.lastRequestId!, 'rejected');
    expect((await admin(h, 'GET', `/adjustments?stockItemId=${item.id}&state=rejected`)).json().items.map((x: { id: string }) => x.id)).toEqual([a.id]);

    const b = (await admin(h, 'POST', '/adjustments', { stockItemId: item.id, fromGroup: 'available', toGroup: 'outside', quantity: 55, reasonCode: 'write_off' })).json();
    expect((await admin(h, 'POST', `/adjustments/${b.id}/cancel`, { reason: '' })).statusCode).toBe(400);
    const cancelled = await admin(h, 'POST', `/adjustments/${b.id}/cancel`, { reason: 'Found the units' });
    expect(cancelled.json()).toMatchObject({ state: 'cancelled' });
    expect(h.access.cancelled).toEqual([{ requestId: b.approval.approvalRequestId, reason: 'Found the units' }]);
    expect(h.audits.at(-1)).toMatchObject({ action: 'inventory.adjustment.cancel', reason: 'Found the units' });
    expect(await quantities(h, item.id)).toMatchObject({ available: 70 });
    expect((await admin(h, 'POST', `/adjustments/${newId()}/cancel`, { reason: 'x' })).statusCode).toBe(404);
  });

  it('rejects an approved adjustment that no longer fits the stock', async () => {
    const item = await officialItem(h, loc.id, 60);
    h.access.decision = 'approval_required';
    const a = (await admin(h, 'POST', '/adjustments', { stockItemId: item.id, fromGroup: 'available', toGroup: 'outside', quantity: 55, reasonCode: 'write_off' })).json();
    const requestId = h.access.lastRequestId!;
    await h.api.hold(`chk-${newId()}`, [{ stockItemId: item.id, quantity: 10 }]);
    await decide(requestId, 'approved');
    const after = (await admin(h, 'GET', `/adjustments?stockItemId=${item.id}`)).json().items.find((x: { id: string }) => x.id === a.id);
    expect(after.state).toBe('rejected');
    expect(await quantities(h, item.id)).toMatchObject({ available: 50, reserved: 10 });
  });
});
