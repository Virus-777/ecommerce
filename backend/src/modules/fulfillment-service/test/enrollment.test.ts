/** Seller enrollment under the service terms, staff decisions and status changes, and SKU enrollment. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { A, ADDRESS, arrivedInbound, boot, DIMS, PROFILE, receiveAll, S, stocked, type Kit } from './helpers.js';

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
    expect((await k.call('POST', S('/enrollment'), { token: s.token, body: application(version, { categories: ['not-a-category'] }) })).status).toBe(400);

    const category = newId();
    const applied = await k.call('POST', S('/enrollment'), { token: s.token, body: application(version, { categories: [category], contactNote: 'Linen and cotton home goods' }) });
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    // the application keeps its own fields: no SKU allowance before approval, the note is not a staff reason
    expect(applied.body).toMatchObject({ sellerId: s.sellerId, state: 'applied', termsVersion: 'FS-TERMS-1', feeScheduleVersion: version, acceptedBy: { kind: 'seller' }, expectedSkus: 3, expectedMonthlyUnits: 120, categories: [category], contactNote: 'Linen and cotton home goods', reason: null, capacity: { maxSkus: 0, maxCubicFeet: 0 } });
    expect(k.events('fulfillment-service.enrollment.submitted').at(-1)).toEqual({ enrollmentId: applied.body.id, sellerId: s.sellerId });
    // the Seller Manager hears of it and it waits in fulfillment.enrollments; the application is audited
    expect(k.notices.find((n) => n.dedupeKey === `fs:enrollment:${applied.body.id}:submitted`)).toMatchObject({ topic: 'staff.fulfillment.enrollment_submitted', recipients: [{ kind: 'staff_role', roleKey: 'seller_manager' }] });
    expect(k.work.find((w) => w.dedupeKey === `fs_enrollment:${applied.body.id}`)).toMatchObject({ queueKey: 'fulfillment.enrollments', kind: 'application_waiting', sourceModule: 'fulfillment-service', subject: { type: 'application', id: applied.body.id } });
    expect(k.audits.find((a) => a.action === 'fulfillment-service.enrollment.apply' && a.target.id === applied.body.id)).toMatchObject({ module: 'fulfillment-service', actor: { kind: 'seller' }, visibleToSeller: true });
    // applying again while applied is not a transition
    expect((await k.call('POST', S('/enrollment'), { token: s.token, body: application(version) })).body.error.code).toBe('ILLEGAL_TRANSITION');

    const info = await k.call('POST', A(`/enrollments/${applied.body.id}/decide`), { body: { decision: 'request_info', reason: 'Tell us about your categories' } });
    expect(info.body).toMatchObject({ state: 'information_required', reason: 'Tell us about your categories', reviewer: { kind: 'staff' } });
    expect(k.notices.find((n) => n.dedupeKey === `fs:enrollment:${applied.body.id}:information_required`)).toMatchObject({ topic: 'seller.fulfillment.enrollment_decided', recipients: [{ kind: 'seller', sellerId: s.sellerId }], context: { enrollment: { state: 'information_required' }, reason: 'Tell us about your categories' } });
    const resubmitted = await k.call('POST', S('/enrollment'), { token: s.token, body: application(version, { expectedSkus: 4, contactNote: 'Home textiles' }) });
    expect(resubmitted.status).toBe(201);
    expect(resubmitted.body).toMatchObject({ state: 'applied', expectedSkus: 4, contactNote: 'Home textiles' });

    const approved = await k.call('POST', A(`/enrollments/${applied.body.id}/decide`), { body: { decision: 'approve', reason: 'Welcome', capacity: { maxCubicFeet: 50, maxSkus: 4, usedCubicFeet: 0, usedSkus: 0 } } });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ state: 'approved', expectedSkus: 4, capacity: { maxCubicFeet: 50, maxSkus: 4, usedSkus: 0, usedCubicFeet: 0 } });
    expect(k.events('fulfillment-service.enrollment.decided').at(-1)).toMatchObject({ enrollmentId: applied.body.id, state: 'approved', reason: 'Welcome' });
    expect(k.resolved).toContain(`fs_enrollment:${applied.body.id}`);
    expect(k.audits.find((a) => a.action === 'fulfillment-service.enrollment.decide' && a.after.state === 'approved')).toMatchObject({ target: { id: applied.body.id, sellerId: s.sellerId }, reason: 'Welcome' });

    // another seller does not see it
    const other = await k.seller();
    expect((await k.call('GET', S('/enrollment'), { token: other.token })).status).toBe(404);
    expect((await k.call('GET', S('/overview'), { token: other.token })).status).toBe(404);

    const list = await k.call('GET', A(`/enrollments?state=approved`));
    expect(list.body.items.map((e: any) => e.id)).toContain(applied.body.id);
    // rejecting an approved enrollment is not a transition
    expect((await k.call('POST', A(`/enrollments/${applied.body.id}/decide`), { body: { decision: 'reject', reason: 'No' } })).status).toBe(409);
  });

  it('suspends (offers stop selling, never seller-shipped), reinstates, offboards and closes only once the stock is gone', async () => {
    const s = await k.enrolledSeller();
    const enrollment = (await k.call('GET', S('/enrollment'), { token: s.token })).body;
    // approved → suspend is not allowed before the first stock is confirmed (state approved)
    expect((await k.call('POST', A(`/enrollments/${enrollment.id}/status`), { body: { action: 'suspend', reason: 'Late dispatches' } })).status).toBe(409);
    const inbound = await arrivedInbound(k, s, 4);
    await receiveAll(k, inbound, s.skuId, 4);
    expect((await k.call('GET', S('/enrollment'), { token: s.token })).body.state).toBe('active');
    const changed = () => k.events('fulfillment-service.offer.service_changed').filter((e) => e.offerId === s.offerId);
    expect(changed().map((e) => [e.reason, e.fulfilledBy, e.sellable])).toEqual([['sku_activated', 'marketly_service', true]]);

    const suspended = await k.call('POST', A(`/enrollments/${enrollment.id}/status`), { body: { action: 'suspend', reason: 'Policy review', affectedActivity: 'new inbound shipments', appealRoute: 'Seller Support' } });
    expect(suspended.body).toMatchObject({ state: 'suspended' });
    expect(suspended.body.reason).toContain('Affects: new inbound shipments');
    // Marketly still fulfils it (accepted orders go on) but it does not sell (decision D5)
    expect(await k.api.isServiceOffer(s.offerId)).toBe(true);
    expect((await k.api.getServiceTerms([s.offerId]))[s.offerId]).toMatchObject({ sellable: false, notSellableReason: 'enrollment_suspended' });
    expect(changed().at(-1)).toMatchObject({ reason: 'enrollment_suspended', fulfilledBy: 'marketly_service', sellable: false, sellerId: s.sellerId, skuEnrollmentId: s.skuId, stockItemId: s.stockItemId });
    expect(k.audits.find((a) => a.action === 'fulfillment-service.enrollment.suspend' && a.target.id === enrollment.id)).toMatchObject({ category: 'seller_enforcement' });
    const blocked = await k.call('POST', S('/inbound'), { token: s.token, body: { shipFrom: ADDRESS, lines: [{ skuEnrollmentId: s.skuId, quantity: 1 }], boxes: 1 } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('suspended');
    const overview = await k.call('GET', S('/overview'), { token: s.token });
    expect(overview.body.alerts[0]).toContain('suspended');

    expect((await k.call('POST', A(`/enrollments/${enrollment.id}/status`), { body: { action: 'reinstate', reason: 'Resolved' } })).body.state).toBe('active');
    expect((await k.api.getServiceTerms([s.offerId]))[s.offerId]).toMatchObject({ sellable: true, notSellableReason: null });
    expect(changed().at(-1)).toMatchObject({ reason: 'enrollment_reinstated', sellable: true });

    // the seller leaves: removal orders for the stock, and close waits for the stock to go
    const offboarding = await k.call('POST', S('/enrollment/offboard'), { token: s.token, body: { reason: 'Shipping myself again', removal: 'return_to_seller' } });
    expect(offboarding.status, JSON.stringify(offboarding.body)).toBe(200);
    expect(offboarding.body.state).toBe('offboarding');
    expect(changed().at(-1)).toMatchObject({ reason: 'enrollment_offboarding', sellable: false });
    const removals = await k.call('GET', S('/removals'), { token: s.token });
    expect(removals.body.items).toHaveLength(1);
    expect(removals.body.items[0]).toMatchObject({ kind: 'return_to_seller', state: 'requested', shipTo: ADDRESS, lines: [{ skuEnrollmentId: s.skuId, expected: 4 }] });
    expect(k.notices.find((n) => n.dedupeKey === `fs:offboarding:${enrollment.id}`)).toMatchObject({ topic: 'seller.fulfillment.offboarding', context: { removal: { refs: removals.body.items[0].ref } } });
    const early = await k.call('POST', A(`/enrollments/${enrollment.id}/status`), { body: { action: 'close', reason: 'Done' } });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('STOCK_REMAINING');

    const removalId = removals.body.items[0].id;
    for (const action of ['approve', 'startProcessing']) expect((await k.call('POST', A(`/removals/${removalId}/transition`), { body: { action } })).status).toBe(200);
    expect((await k.call('POST', A(`/removals/${removalId}/transition`), { body: { action: 'ship', tracking: '1Z999' } })).status).toBe(200);
    expect((await k.call('POST', A(`/removals/${removalId}/transition`), { body: { action: 'complete' } })).status).toBe(200);
    expect(k.inv.level(s.stockItemId)).toMatchObject({ available: 0, damagedHeld: 0 });
    const closed = await k.call('POST', A(`/enrollments/${enrollment.id}/status`), { body: { action: 'close', reason: 'Stock returned' } });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.state).toBe('closed');
    expect((await k.call('GET', S('/skus'), { token: s.token })).body.items[0].state).toBe('inactive');
    // the item sells from the seller's own location again, then offers hears it
    expect(k.inv.setCalls.filter((c) => c.stockItemId === s.stockItemId).map((c) => c.locationId)).toEqual([k.locationId, null]);
    expect(changed().at(-1)).toMatchObject({ reason: 'enrollment_closed', fulfilledBy: 'seller', sellable: true });
    expect(await k.api.isServiceOffer(s.offerId)).toBe(false);
    expect(k.events('fulfillment-service.enrollment.decided').filter((e) => e.enrollmentId === enrollment.id).map((e) => e.state)).toEqual(['approved', 'active', 'suspended', 'active', 'offboarding', 'closed']);
  });

  it('follows the sellers module: suspension, reinstatement of that suspension only, and closure', async () => {
    const s = await stocked(k, 2);
    const suspensionId = newId();
    const suspended = (id: string) => ({ sellerId: s.sellerId, suspensionId: id, reasonCode: 'policy', reason: 'Counterfeit reports', reviewDate: '2026-12-01', openOrders: 'seller_keeps_fulfilling', appealDeadline: new Date(Date.now() + 86_400_000).toISOString(), trustReportId: null });
    const reinstated = (endedSuspensionId: string) => ({ sellerId: s.sellerId, from: 'suspended', to: 'approved', endedSuspensionId, remainingRestrictionIds: [] });
    await k.publish('sellers', 'sellers.seller.suspended', suspended(suspensionId));
    expect((await k.call('GET', S('/enrollment'), { token: s.token })).body.state).toBe('suspended');
    // another suspension ending does not reinstate it
    await k.publish('sellers', 'sellers.seller.reinstated', reinstated(newId()));
    expect((await k.call('GET', S('/enrollment'), { token: s.token })).body.state).toBe('suspended');
    await k.publish('sellers', 'sellers.seller.reinstated', reinstated(suspensionId));
    expect((await k.call('GET', S('/enrollment'), { token: s.token })).body.state).toBe('active');
    expect(k.events('fulfillment-service.offer.service_changed').filter((e) => e.offerId === s.offerId).map((e) => e.reason)).toEqual(['sku_activated', 'enrollment_suspended', 'enrollment_reinstated']);

    // a staff suspension is not ended by the sellers module
    const enrollment = (await k.call('GET', S('/enrollment'), { token: s.token })).body;
    await k.call('POST', A(`/enrollments/${enrollment.id}/status`), { body: { action: 'suspend', reason: 'Warehouse audit' } });
    await k.publish('sellers', 'sellers.seller.reinstated', reinstated(suspensionId));
    expect((await k.call('GET', S('/enrollment'), { token: s.token })).body.state).toBe('suspended');

    await k.publish('sellers', 'sellers.seller.closed', { sellerId: s.sellerId, reasonCode: 'seller_request', closedBy: { kind: 'staff', id: newId(), name: 'Mia' } });
    expect((await k.call('GET', S('/enrollment'), { token: s.token })).body.state).toBe('offboarding');
    expect(k.notices.some((n) => n.dedupeKey === `fs:offboarding:${enrollment.id}`)).toBe(true);
    // an unknown seller is ignored
    await k.publish('sellers', 'sellers.seller.closed', { sellerId: newId(), reasonCode: 'seller_request', closedBy: { kind: 'system' } });
  });
});

describe('SKU enrollment', () => {
  it('enrolls an own offer with size tier, labelling and hazmat, refuses restricted items and checks the SKU allowance', async () => {
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

    const ok = await k.call('POST', S('/skus'), { token: s.token, body: { offerId: offer.offerId, dimensionsCm: { length: 25, width: 15, height: 3 }, weightGrams: 400, barcode: '0123456789012', hazmat: false, notes: 'Folded in a sleeve' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ offerId: offer.offerId, sku: 'CVH-LIN-02', title: 'Linen throw CVH-LIN-02', sizeTier: 'small', labelRequired: false, state: 'pending', restricted: false, hazmat: false, notes: 'Folded in a sleeve', stock: { available: 0, inbound: 0 } });
    expect(k.work.find((w) => w.dedupeKey === `fs_sku:${ok.body.id}`)).toMatchObject({ queueKey: 'fulfillment.enrollments', kind: 'application_waiting', sellerId: s.sellerId });
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
    expect(k.resolved).toContain(`fs_sku:${ok.body.id}`);
    expect(k.notices.find((n) => n.dedupeKey === `fs:sku:${ok.body.id}:review`)).toMatchObject({ topic: 'seller.fulfillment.sku_reviewed', context: { sku: 'CVH-LIN-02', approved: false, reason: 'Category not stored' } });
    expect(k.audits.find((a) => a.action === 'fulfillment-service.sku.review' && a.target.id === ok.body.id)).toMatchObject({ after: { state: 'rejected' } });
    expect((await k.call('POST', A(`/skus/${ok.body.id}/review`), { body: { approve: true } })).status).toBe(409);

    const listed = await k.call('GET', S('/skus?q=lin-02'), { token: s.token });
    expect(listed.body.items.map((x: any) => x.id)).toEqual([ok.body.id]);
    expect((await k.call('GET', S(`/skus/${s.skuId}/movements`), { token: other.token })).status).toBe(404);
  });

  it('deactivates only with no units available at the service location, and answers stockOwner, getServiceTerms and getServiceLocation', async () => {
    const s = await k.enrolledSeller();
    expect(await k.api.stockOwner(s.stockItemId)).toEqual({ kind: 'seller', sellerId: s.sellerId });
    expect(await k.api.stockOwner(newId())).toEqual({ kind: 'company' });
    expect(await k.api.getServiceLocation()).toEqual({ locationId: k.locationId, address: expect.objectContaining({ city: 'Reno', region: 'NV' }), shipsFrom: 'Reno, NV' });
    expect((await k.api.getServiceTerms([s.offerId]))[s.offerId]).toBeNull();
    const inbound = await arrivedInbound(k, s, 3);
    await receiveAll(k, inbound, s.skuId, 3);
    expect(await k.api.isServiceOffer(s.offerId)).toBe(true);
    const plain = newId();
    expect(await k.api.getServiceTerms([s.offerId, plain])).toEqual({
      [s.offerId]: { offerId: s.offerId, sellerId: s.sellerId, skuEnrollmentId: s.skuId, stockItemId: s.stockItemId, sellable: true, notSellableReason: null, locationId: k.locationId, shipsFrom: 'Reno, NV', dispatch: { businessDays: 1, sameDayCutoff: '14:00' }, shippingProfileId: PROFILE.profileId, parcel: { weightGrams: 800, dimensionsCm: DIMS } },
      [plain]: null,
    });
    const blocked = await k.call('POST', S(`/skus/${s.skuId}/deactivate`), { token: s.token });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('STOCK_REMAINING');
    // a requested removal is not enough: the units leave Available when staff approve it
    const removal = await k.call('POST', S('/removals'), { token: s.token, body: { kind: 'dispose', lines: [{ skuEnrollmentId: s.skuId, quantity: 3 }], fromGroup: 'available' }, headers: { 'idempotency-key': newId() } });
    expect(removal.status, JSON.stringify(removal.body)).toBe(201);
    expect((await k.call('POST', S(`/skus/${s.skuId}/deactivate`), { token: s.token })).status).toBe(409);
    expect((await k.call('POST', A(`/removals/${removal.body.id}/transition`), { body: { action: 'approve' } })).status).toBe(200);
    const off = await k.call('POST', S(`/skus/${s.skuId}/deactivate`), { token: s.token });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.state).toBe('inactive');
    expect(k.inv.setCalls.filter((c) => c.stockItemId === s.stockItemId).at(-1)).toEqual({ stockItemId: s.stockItemId, locationId: null });
    expect(k.events('fulfillment-service.offer.service_changed').filter((e) => e.offerId === s.offerId).at(-1)).toMatchObject({ reason: 'sku_deactivated', fulfilledBy: 'seller', sellable: true });
    expect(await k.api.isServiceOffer(s.offerId)).toBe(false);
    // a member without the permission is refused by the middleware
    expect((await k.call('POST', S(`/skus/${s.skuId}/deactivate`), { token: callers.seller({ sellerId: s.sellerId, permissions: [] }) })).status).toBe(403);
  });
});
