/** Seller enrollment under the service terms, staff decisions and status changes, and SKU enrollment. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { A, ADDRESS, arrivedInbound, boot, DIMS, receiveAll, S, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const application = (version: string, over: Record<string, unknown> = {}) => ({ expectedSkus: 3, expectedMonthlyUnits: 120, categories: [], termsVersion: 'FS-TERMS-1', feeScheduleVersion: version, acceptTerms: true, ...over });

describe('enrollment', () => {
  it('applies under the terms, asks for information, resubmits and is approved with a capacity', async () => {
    const s = await k.seller();
    const schedule = await k.call('GET', S('/fee-schedule'), { token: s.token });
    expect(schedule.status).toBe(200);
    expect(schedule.body.current).toMatchObject({ version: 'FS-EXAMPLE-2026', state: 'current', isExample: true });
    const version = schedule.body.current.version;

    expect((await k.call('GET', S('/enrollment'), { token: s.token })).status).toBe(404);
    const refused = await k.call('POST', S('/enrollment'), { token: s.token, body: application(version, { acceptTerms: false }) });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('TERMS_NOT_ACCEPTED');
    const wrongVersion = await k.call('POST', S('/enrollment'), { token: s.token, body: application('FS-OLD') });
    expect(wrongVersion.body.error.code).toBe('TERMS_NOT_ACCEPTED');

    const applied = await k.call('POST', S('/enrollment'), { token: s.token, body: application(version) });
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    expect(applied.body).toMatchObject({ sellerId: s.sellerId, state: 'applied', termsVersion: 'FS-TERMS-1', feeScheduleVersion: version, acceptedBy: { kind: 'seller' } });
    expect(k.events('fulfillment-service.enrollment.submitted').at(-1)).toEqual({ enrollmentId: applied.body.id, sellerId: s.sellerId });
    // applying again while applied is not a transition
    expect((await k.call('POST', S('/enrollment'), { token: s.token, body: application(version) })).body.error.code).toBe('ILLEGAL_TRANSITION');

    const info = await k.call('POST', A(`/enrollments/${applied.body.id}/decide`), { body: { decision: 'request_info', reason: 'Tell us about your categories' } });
    expect(info.body).toMatchObject({ state: 'information_required', reason: 'Tell us about your categories', reviewer: { kind: 'staff' } });
    const resubmitted = await k.call('POST', S('/enrollment'), { token: s.token, body: application(version, { contactNote: 'Home textiles' }) });
    expect(resubmitted.status).toBe(201);
    expect(resubmitted.body.state).toBe('applied');

    const approved = await k.call('POST', A(`/enrollments/${applied.body.id}/decide`), { body: { decision: 'approve', reason: 'Welcome', capacity: { maxCubicFeet: 50, maxSkus: 4, usedCubicFeet: 0, usedSkus: 0 } } });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ state: 'approved', capacity: { maxCubicFeet: 50, maxSkus: 4, usedSkus: 0, usedCubicFeet: 0 } });
    expect(k.events('fulfillment-service.enrollment.decided').at(-1)).toMatchObject({ enrollmentId: applied.body.id, state: 'approved', reason: 'Welcome' });

    // another seller does not see it
    const other = await k.seller();
    expect((await k.call('GET', S('/enrollment'), { token: other.token })).status).toBe(404);
    expect((await k.call('GET', S('/overview'), { token: other.token })).status).toBe(404);

    const list = await k.call('GET', A(`/enrollments?state=approved`));
    expect(list.body.items.map((e: any) => e.id)).toContain(applied.body.id);
    // rejecting an approved enrollment is not a transition
    expect((await k.call('POST', A(`/enrollments/${applied.body.id}/decide`), { body: { decision: 'reject', reason: 'No' } })).status).toBe(409);
  });

  it('suspends, reinstates, offboards and closes only once the stock is gone', async () => {
    const s = await k.enrolledSeller();
    const enrollment = (await k.call('GET', S('/enrollment'), { token: s.token })).body;
    // approved → suspend is not allowed before the first shipment is received (state approved)
    expect((await k.call('POST', A(`/enrollments/${enrollment.id}/status`), { body: { action: 'suspend', reason: 'Late dispatches' } })).status).toBe(409);
    const inbound = await arrivedInbound(k, s, 4);
    await receiveAll(k, inbound, s.skuId, 4);
    expect((await k.call('GET', S('/enrollment'), { token: s.token })).body.state).toBe('active');

    const suspended = await k.call('POST', A(`/enrollments/${enrollment.id}/status`), { body: { action: 'suspend', reason: 'Policy review', affectedActivity: 'new inbound shipments', appealRoute: 'Seller Support' } });
    expect(suspended.body).toMatchObject({ state: 'suspended' });
    expect(suspended.body.reason).toContain('Affects: new inbound shipments');
    expect(await k.api.isServiceOffer(s.offerId)).toBe(false);
    const blocked = await k.call('POST', S('/inbound'), { token: s.token, body: { shipFrom: ADDRESS, lines: [{ skuEnrollmentId: s.skuId, quantity: 1 }], boxes: 1 } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('suspended');
    const overview = await k.call('GET', S('/overview'), { token: s.token });
    expect(overview.body.alerts[0]).toContain('suspended');

    expect((await k.call('POST', A(`/enrollments/${enrollment.id}/status`), { body: { action: 'reinstate', reason: 'Resolved' } })).body.state).toBe('active');
    expect(await k.api.isServiceOffer(s.offerId)).toBe(true);

    // the seller leaves: removal orders for the stock, and close waits for the stock to go
    const offboarding = await k.call('POST', S('/enrollment/offboard'), { token: s.token, body: { reason: 'Shipping myself again', removal: 'return_to_seller' } });
    expect(offboarding.status, JSON.stringify(offboarding.body)).toBe(200);
    expect(offboarding.body.state).toBe('offboarding');
    const removals = await k.call('GET', S('/removals'), { token: s.token });
    expect(removals.body.items).toHaveLength(1);
    expect(removals.body.items[0]).toMatchObject({ kind: 'return_to_seller', state: 'requested', shipTo: ADDRESS, lines: [{ skuEnrollmentId: s.skuId, expected: 4 }] });
    const early = await k.call('POST', A(`/enrollments/${enrollment.id}/status`), { body: { action: 'close', reason: 'Done' } });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('STOCK_REMAINING');

    const removalId = removals.body.items[0].id;
    for (const action of ['approve', 'startProcessing']) expect((await k.call('POST', A(`/removals/${removalId}/transition`), { body: { action } })).status).toBe(200);
    expect((await k.call('POST', A(`/removals/${removalId}/transition`), { body: { action: 'ship', tracking: '1Z999' } })).status).toBe(200);
    expect((await k.call('POST', A(`/removals/${removalId}/transition`), { body: { action: 'complete' } })).status).toBe(200);
    const closed = await k.call('POST', A(`/enrollments/${enrollment.id}/status`), { body: { action: 'close', reason: 'Stock returned' } });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.state).toBe('closed');
    expect((await k.call('GET', S('/skus'), { token: s.token })).body.items[0].state).toBe('inactive');
    expect(k.events('fulfillment-service.enrollment.decided').filter((e) => e.enrollmentId === enrollment.id).map((e) => e.state)).toEqual(['approved', 'active', 'suspended', 'active', 'offboarding', 'closed']);
  });

  it('follows the sellers module: suspension and closure', async () => {
    const s = await k.enrolledSeller();
    const inbound = await arrivedInbound(k, s, 2);
    await receiveAll(k, inbound, s.skuId, 2);
    await k.publish('sellers', 'sellers.seller.suspended', { sellerId: s.sellerId, suspensionId: newId(), reasonCode: 'policy', reason: 'Counterfeit reports', reviewDate: '2026-12-01', openOrders: 'seller_keeps_fulfilling', appealDeadline: new Date(Date.now() + 86_400_000).toISOString(), trustReportId: null });
    expect((await k.call('GET', S('/enrollment'), { token: s.token })).body.state).toBe('suspended');
    await k.publish('sellers', 'sellers.seller.closed', { sellerId: s.sellerId, reasonCode: 'seller_request', closedBy: { kind: 'staff', id: newId(), name: 'Mia' } });
    expect((await k.call('GET', S('/enrollment'), { token: s.token })).body.state).toBe('offboarding');
    // an unknown seller is ignored
    await k.publish('sellers', 'sellers.seller.closed', { sellerId: newId(), reasonCode: 'seller_request', closedBy: { kind: 'system' } });
  });
});

describe('SKU enrollment', () => {
  it('enrolls an own offer with size tier and labelling, refuses restricted items and checks the SKU allowance', async () => {
    const s = await k.enrolledSeller({ capacity: { maxCubicFeet: 100, maxSkus: 2 } });
    const offer = await s.offer({ sku: 'CVH-LIN-02' });
    const hazmat = await k.call('POST', S('/skus'), { token: s.token, body: { offerId: offer.offerId, dimensionsCm: DIMS, weightGrams: 500, hazmat: true } });
    expect(hazmat.status).toBe(422);
    expect(hazmat.body.error.code).toBe('SKU_RESTRICTED');
    const huge = await k.call('POST', S('/skus'), { token: s.token, body: { offerId: offer.offerId, dimensionsCm: { length: 300, width: 20, height: 20 }, weightGrams: 500, hazmat: false } });
    expect(huge.body.error.code).toBe('SKU_RESTRICTED');
    const bad = await k.call('POST', S('/skus'), { token: s.token, body: { offerId: offer.offerId, dimensionsCm: { length: 0, width: 20, height: 20 }, weightGrams: 500, hazmat: false } });
    expect(bad.status).toBe(400);

    // another seller's offer is not found
    const other = await k.seller();
    const theirs = await other.offer();
    expect((await k.call('POST', S('/skus'), { token: s.token, body: { offerId: theirs.offerId, dimensionsCm: DIMS, weightGrams: 500, hazmat: false } })).status).toBe(404);

    const ok = await k.call('POST', S('/skus'), { token: s.token, body: { offerId: offer.offerId, dimensionsCm: { length: 25, width: 15, height: 3 }, weightGrams: 400, barcode: '0123456789012', hazmat: false } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ offerId: offer.offerId, sku: 'CVH-LIN-02', title: 'Linen throw CVH-LIN-02', sizeTier: 'small', labelRequired: false, state: 'pending', restricted: false, stock: { available: 0, inbound: 0 } });
    expect((await k.call('POST', S('/skus'), { token: s.token, body: { offerId: offer.offerId, dimensionsCm: DIMS, weightGrams: 500, hazmat: false } })).body.error.code).toBe('ILLEGAL_TRANSITION');
    const third = await s.offer();
    const full = await k.call('POST', S('/skus'), { token: s.token, body: { offerId: third.offerId, dimensionsCm: DIMS, weightGrams: 500, hazmat: false } });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('CAPACITY_EXCEEDED');

    // a pending SKU can't be deactivated or sent
    expect((await k.call('POST', S(`/skus/${ok.body.id}/deactivate`), { token: s.token })).status).toBe(409);
    const pendingLine = await k.call('POST', S('/inbound'), { token: s.token, body: { shipFrom: ADDRESS, lines: [{ skuEnrollmentId: ok.body.id, quantity: 1 }], boxes: 1 } });
    expect(pendingLine.status).toBe(400);

    const rejected = await k.call('POST', A(`/skus/${ok.body.id}/review`), { body: { approve: false, reason: 'Category not stored' } });
    expect(rejected.body).toMatchObject({ state: 'rejected', restricted: true, restrictionReason: 'Category not stored' });
    expect((await k.call('POST', A(`/skus/${ok.body.id}/review`), { body: { approve: true } })).status).toBe(409);

    const listed = await k.call('GET', S('/skus?q=lin-02'), { token: s.token });
    expect(listed.body.items.map((x: any) => x.id)).toEqual([ok.body.id]);
    expect((await k.call('GET', S(`/skus/${s.skuId}/movements`), { token: other.token })).status).toBe(404);
  });

  it('deactivates only without available stock (or with a removal order), and answers stockOwner', async () => {
    const s = await k.enrolledSeller();
    expect(await k.api.stockOwner(s.stockItemId)).toEqual({ kind: 'seller', sellerId: s.sellerId });
    expect(await k.api.stockOwner(newId())).toEqual({ kind: 'company' });
    const inbound = await arrivedInbound(k, s, 3);
    await receiveAll(k, inbound, s.skuId, 3);
    expect(await k.api.isServiceOffer(s.offerId)).toBe(true);
    const blocked = await k.call('POST', S(`/skus/${s.skuId}/deactivate`), { token: s.token });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('STOCK_REMAINING');
    const removal = await k.call('POST', S('/removals'), { token: s.token, body: { kind: 'dispose', lines: [{ skuEnrollmentId: s.skuId, quantity: 3 }], fromGroup: 'available' }, headers: { 'idempotency-key': newId() } });
    expect(removal.status, JSON.stringify(removal.body)).toBe(201);
    const off = await k.call('POST', S(`/skus/${s.skuId}/deactivate`), { token: s.token });
    expect(off.status).toBe(200);
    expect(off.body.state).toBe('inactive');
    expect(await k.api.isServiceOffer(s.offerId)).toBe(false);
    // a member without the permission is refused by the middleware
    expect((await k.call('POST', S(`/skus/${s.skuId}/deactivate`), { token: callers.seller({ sellerId: s.sellerId, permissions: [] }) })).status).toBe(403);
  });
});
