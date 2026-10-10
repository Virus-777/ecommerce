import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import { addProduct, addSeller, asStaff, call, DAY, emit, eventsNamed, harness, profile, sellerOffer, sku, staffHeaders, warehouse, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await warehouse(h);
});
afterAll(async () => {
  await h?.app.close();
});

const officialInput = (productId: string, variantId: string, over: Record<string, unknown> = {}) => ({
  productId,
  variantId,
  condition: 'new',
  price: { amount: 19900, currency: 'USD' },
  sku: sku('HAL'),
  dispatchBusinessDays: 0,
  shippingProfileId: profile(h, 0, 2, null),
  returnTerms: { kind: 'extended', windowDays: 60, freeReturnShipping: true },
  warranty: { kind: 'manufacturer', months: 24 },
  ...over,
});

async function official(over: Record<string, unknown> = {}) {
  const p = addProduct(h);
  const res = await asStaff(h, 'POST', '/official/offers', officialInput(p.id, p.variants[0]!, over));
  expect(res.statusCode, res.body).toBe(201);
  return { p, id: res.json().offer.id as string, body: res.json() };
}

describe('Official Store offers', () => {
  it('creates an offer with a company stock item, publishes it and audits both', async () => {
    const { id, body } = await official();
    expect(body.offer).toMatchObject({ ownerType: 'official', sellerId: null, sellerName: OFFICIAL_STORE_NAME, status: 'draft', returnTerms: { kind: 'extended', windowDays: 60, freeReturnShipping: true }, warranty: { handledBy: 'manufacturer' } });
    expect(body.seller).toMatchObject({ official: true, name: OFFICIAL_STORE_NAME });
    // ships from the inventory default location (decision O3); the title is denormalised from catalog
    expect(body.offer.dispatch.shipsFrom).toBe('Reno, NV');
    expect(body.offer.title).toBe('Halden Aurora ANC Headphones – Black');
    const pub = await asStaff(h, 'POST', `/official/offers/${id}/publish`);
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.json().offer.status).toBe('out_of_stock'); // company stock starts at 0
    expect(h.audits.filter((a) => a.target.id === id).map((a) => a.action)).toEqual(['offers.official.create', 'offers.official.publish']);
    const list = await asStaff(h, 'GET', '/official/offers');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items.some((r: { offer: { id: string } }) => r.offer.id === id)).toBe(true);
  });

  it('refuses price edits on the offer itself; terms edits bump the terms version once published', async () => {
    const { id } = await official({ publish: true });
    expect((await asStaff(h, 'PATCH', `/official/offers/${id}`, { price: { amount: 100, currency: 'USD' } })).statusCode).toBe(400);
    const res = await asStaff(h, 'PATCH', `/official/offers/${id}`, { purchaseLimit: 3 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().offer).toMatchObject({ purchaseLimit: 3, termsVersion: 2 });
    expect(h.audits.some((a) => a.action === 'offers.official.update' && a.target.id === id)).toBe(true);
  });

  it('applies changes within the caller limit and schedules future ones', async () => {
    h.access.decision = 'allowed';
    const { id } = await official({ publish: true });
    const now = await asStaff(h, 'POST', `/official/offers/${id}/price-changes`, { price: { amount: 18900, currency: 'USD' }, reason: 'Match market' });
    expect(now.statusCode, now.body).toBe(201);
    expect(now.json()).toMatchObject({ state: 'applied', source: 'official', from: { amount: 19900 }, to: { amount: 18900 }, changePct: -5.03 });
    expect(eventsNamed(h, 'offers.offer.price_changed').filter((e) => e.offerId === id).at(-1)).toMatchObject({ to: { amount: 18900 }, ownerType: 'official', sellerId: null });

    const startsAt = new Date(h.clock.now().getTime() + DAY).toISOString();
    const endsAt = new Date(h.clock.now().getTime() + 3 * DAY).toISOString();
    const later = await asStaff(h, 'POST', `/official/offers/${id}/price-changes`, { price: { amount: 16900, currency: 'USD' }, startsAt, endsAt, reason: 'Weekend event' });
    expect(later.json()).toMatchObject({ state: 'scheduled', startsAt });
    const pending = await asStaff(h, 'POST', `/official/offers/${id}/price-changes`, { price: { amount: 17900, currency: 'USD' }, reason: 'Again' });
    expect(pending.statusCode).toBe(409);
    expect(pending.json().error).toMatchObject({ code: 'PRICE_CHANGE_PENDING', details: { priceChangeId: later.json().id } });

    h.clock.advance(DAY + 60_000);
    await h.app.kernel.jobs.runNow('offers.apply-price-schedule');
    await h.app.kernel.events.drain();
    expect((await h.api.getOffer(id))?.price.amount).toBe(16900);
    h.clock.advance(2 * DAY);
    await h.app.kernel.jobs.runNow('offers.apply-price-schedule');
    await h.app.kernel.events.drain();
    expect((await h.api.getOffer(id))?.price.amount).toBe(18900);
    const changes = await asStaff(h, 'GET', `/price-changes?offerId=${id}`);
    expect(changes.json().items.map((c: { state: string }) => c.state)).toEqual(['reverted', 'applied']);
    h.clock.set(new Date());
  });

  it('sends changes above the limit for approval and applies them when approved', async () => {
    const { id } = await official({ publish: true });
    h.access.decision = 'approval_required';
    const res = await asStaff(h, 'POST', `/official/offers/${id}/price-changes`, { price: { amount: 9900, currency: 'USD' }, reason: 'Clearance' });
    h.access.decision = 'allowed';
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ state: 'pending_approval', approval: { required: true, approvers: ['Olivia Owner'] } });
    const request = h.access.requests.at(-1)!;
    expect(request).toMatchObject({ action: 'offers.prices.change', target: { type: 'price_change', id: res.json().id } });
    expect((await h.api.getOffer(id))?.price.amount).toBe(19900);
    const approvalId = res.json().approval.approvalRequestId;
    const decided = { requestId: approvalId, ref: 'AP-1', actionKey: 'offers.prices.change', module: 'offers', target: request.target, outcome: 'approved', decidedBy: { kind: 'staff', id: newId() }, reason: null, amount: null, approverIds: [], requestedById: newId() };
    await emit(h, 'access.approval.decided', decided);
    await emit(h, 'access.approval.decided', decided); // delivered twice: same result
    expect((await h.api.getOffer(id))?.price.amount).toBe(9900);
    const after = await asStaff(h, 'GET', `/offers/${id}`);
    expect(after.json().priceChanges[0]).toMatchObject({ state: 'applied' });
  });

  it('cancels a pending change and refuses callers without authority', async () => {
    const { id } = await official({ publish: true });
    h.access.decision = 'approval_required';
    const res = await asStaff(h, 'POST', `/official/offers/${id}/price-changes`, { price: { amount: 9900, currency: 'USD' }, reason: 'Clearance' });
    h.access.decision = 'denied';
    const denied = await asStaff(h, 'POST', `/official/offers/${id}/price-changes`, { price: { amount: 9800, currency: 'USD' }, reason: 'x' });
    expect(denied.statusCode).toBe(409); // the pending change is checked first
    h.access.decision = 'allowed';
    const cancel = await asStaff(h, 'POST', `/price-changes/${res.json().id}/cancel`, { reason: 'Wrong price' });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json().state).toBe('cancelled');
    expect(h.access.cancelled).toContain(res.json().approval.approvalRequestId);
    expect((await asStaff(h, 'POST', `/price-changes/${res.json().id}/cancel`, { reason: 'Again' })).statusCode).toBe(409);
    h.access.decision = 'denied';
    expect((await asStaff(h, 'POST', `/official/offers/${id}/price-changes`, { price: { amount: 9800, currency: 'USD' }, reason: 'x' })).statusCode).toBe(403);
    h.access.decision = 'allowed';
  });
});

describe('staff actions on any offer', () => {
  it('holds, releases, removes and reinstates with reasons; each is audited and visible to the seller', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const reviewDate = new Date(h.clock.now().getTime() + 7 * DAY).toISOString().slice(0, 10);
    const held = await asStaff(h, 'POST', `/offers/${o.id}/hold`, { reason: 'Counterfeit report', reviewDate, reference: 'TR-261007-004' });
    expect(held.statusCode, held.body).toBe(200);
    expect(held.json().offer).toMatchObject({ status: 'ineligible', statusReason: { code: 'staff_hold', reviewDate }, featuredEligibility: { eligible: false, reasons: [expect.objectContaining({ code: 'staff_hold' })] } });
    expect((await asStaff(h, 'POST', `/offers/${o.id}/hold`, { reason: 'Again', reviewDate })).statusCode).toBe(409);
    const released = await asStaff(h, 'POST', `/offers/${o.id}/release-hold`, { reason: 'Authentic' });
    expect(released.json().offer).toMatchObject({ status: 'active', statusReason: null });
    const removed = await asStaff(h, 'POST', `/offers/${o.id}/remove`, { reasonCode: 'misleading_condition', reason: 'Listed as new, sold used' });
    expect(removed.json().offer).toMatchObject({ status: 'removed', statusReason: { code: 'removed_by_staff', appealRoute: expect.any(String) } });
    const back = await asStaff(h, 'POST', `/offers/${o.id}/reinstate`, { reason: 'Appeal upheld' });
    expect(back.json().offer.status).toBe('paused');
    expect(h.audits.filter((a) => a.target.id === o.id).map((a) => a.action)).toEqual(['offers.offer.hold', 'offers.offer.release_hold', 'offers.offer.remove', 'offers.offer.reinstate']);
    expect(h.audits.filter((a) => a.target.id === o.id).every((a) => a.visibleToSeller)).toBe(true);
  });

  it('lists all offers with filters', async () => {
    const sellerId = addSeller(h);
    const p = addProduct(h);
    const o = await sellerOffer(h, sellerId, p.id, p.variants[0]!);
    const res = await asStaff(h, 'GET', `/offers?sellerId=${sellerId}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items).toEqual([expect.objectContaining({ offer: expect.objectContaining({ id: o.id }), seller: expect.objectContaining({ sellerId }), sellerStatus: 'approved' })]);
    expect((await asStaff(h, 'GET', `/offers?sellerId=${sellerId}&featuredEligible=false`)).json().items).toEqual([]);
    expect((await call(h, 'GET', `/api/admin/offers/offers/${o.id}`, staffHeaders(['offers.offers.view']))).statusCode).toBe(200);
  });
});

describe('the featured-offer rule', () => {
  it('serves version 1 and publishes new versions that take effect later', async () => {
    const store = await call(h, 'GET', '/api/store/offers/featured-offer-rule', { authorization: (await import('./helpers.js')).visitorHeaders().authorization });
    expect(store.statusCode, store.body).toBe(200);
    expect(store.json()).toMatchObject({ version: 1, parameters: { competingConditions: ['new'], minOnTimeDispatchPct: 90 } });
    const effectiveFrom = new Date(h.clock.now().getTime() + 7 * DAY).toISOString();
    const res = await asStaff(h, 'POST', '/featured-rule/versions', { text: 'New wording', steps: ['Eligible', 'Cheapest'], parameters: { minOnTimeDispatchPct: 92, performanceWindowDays: 90, deliveryDayAdjustmentPct: 1.5, competingConditions: ['new'], tieBreakers: [] }, effectiveFrom, reason: 'Stricter dispatch' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ version: 2, effectiveFrom });
    expect(eventsNamed(h, 'offers.featured_rule.published')).toEqual([{ version: 2, effectiveFrom }]);
    const admin = await asStaff(h, 'GET', '/featured-rule');
    expect(admin.json()).toMatchObject({ current: { version: 1 }, scheduled: { version: 2 } });
    expect((await asStaff(h, 'POST', '/featured-rule/versions', { text: 'x', steps: ['x'], parameters: { minOnTimeDispatchPct: 92, performanceWindowDays: 90, deliveryDayAdjustmentPct: 1, competingConditions: ['new'], tieBreakers: [] }, effectiveFrom, reason: 'x' })).statusCode).toBe(409);
    h.clock.advance(8 * DAY);
    expect((await asStaff(h, 'GET', '/featured-rule')).json()).toMatchObject({ current: { version: 2 }, scheduled: null, history: [{ version: 1 }] });
    h.clock.set(new Date());
  });
});
