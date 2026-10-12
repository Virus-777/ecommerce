/**
 * Fulfilled by Marketly (fulfillment-service, phase 4): groups with fulfilledBy marketly_service are a seller's
 * packages that Marketly's warehouse ships. Quotes follow the Official schedule from the service location, the
 * warehouse's package is recorded as the seller's shipment, the seller cannot act on it (409 FULFILLED_BY_MARKETLY),
 * exceptions are staff-owned, the seller's dispatch metrics leave the packages out, and fulfilled_by is required.
 * fulfillment-service.getServiceLocation is stubbed (h.serviceLocation): FS is built in parallel.
 */
import { marketDate } from '../../../testing/app.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { spec } from '../../../spec/shipping.js';
import { checkout, group, harness, idem, line, offer, product, sellerOrder, tokens, ups, USD, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});

const pkgItem = (orderItemId: string, quantity = 1) => ({ orderItemId, stockItemId: newId(), sku: 'SKU-1', label: 'Desk Lamp', quantity, scanned: quantity, serialNumbers: [] });
afterAll(async () => {
  await h?.app.close();
});

const SELLER = '/api/seller/shipping';
const ADMIN = '/api/admin/shipping';
const STORE = '/api/store/shipping';
const HOUR = 3_600_000;

const officialProfile = async () => (await h.service.getOfficialDefaultProfile())!;

/** A seller with saved settings (2 handling days, noon cutoff) and its own profile */
async function sellerWithProfile() {
  const sellerId = newId();
  const token = tokens.seller(sellerId);
  const methods = (await h.call('GET', `${SELLER}/methods`, token)).body as { id: string; code: string }[];
  const standard = methods.find((m) => m.code === 'standard')!.id;
  const settings = await h.call('PUT', `${SELLER}/settings`, token, {
    coverage: { area: 'contiguous_48_dc', zoneIds: [], excluded: ['po_box'] },
    dispatch: { handlingDays: 3, sameDayCutoff: '09:00', businessDays: ['mon', 'tue', 'wed', 'thu', 'fri'] },
    buyLabelsInSellerCenter: true,
    effectiveFrom: null,
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const p = await h.call('POST', `${SELLER}/profiles`, token, { name: 'Default', methods: [{ methodId: standard, enabled: true, rateType: 'flat_per_package', tiers: [{ price: USD(799) }] }], freeShippingThreshold: null, freeShippingMethodCode: 'standard', effectiveFrom: null });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  return { sellerId, token, profileId: p.body.id as string };
}

const item = (profileId: string, o: { lineId?: string; value?: number; businessDays?: number } = {}) => ({
  lineId: o.lineId ?? newId(),
  profileId,
  parcel: { weightGrams: 1000 },
  quantity: 1,
  value: USD(o.value ?? 2000),
  dispatch: { businessDays: o.businessDays ?? 1, shipsFrom: 'Somewhere, CA' },
});

describe('getOfficialDefaultProfile', () => {
  it('answers the Official default profile with the Official handling days and cutoff', async () => {
    const p = await officialProfile();
    const owners = await h.service.getProfileOwners([p.profileId]);
    expect(owners[p.profileId]).toMatchObject({ ownerType: 'official', sellerId: null, status: 'active' });
    expect(p).toEqual({ profileId: p.profileId, handlingDays: 0, sameDayCutoff: '14:00' });
  });
});

describe('quotes (G1)', () => {
  it('quotes a Marketly package with the Official schedule, the profile-owner check as official and the service location', async () => {
    const official = await officialProfile();
    const s = await sellerWithProfile();
    const destination = { postalCode: '97205', country: 'US' };

    // a mixed cart: the service package (Official profile) and the seller's own package quote separately
    const service = await h.service.quoteOptions({ ownerType: 'seller', sellerId: s.sellerId, fulfilledBy: 'marketly_service', shipsFrom: 'Somewhere, CA', destination, items: [item(official.profileId, { value: 2000 })] });
    const own = await h.service.quoteOptions({ ownerType: 'seller', sellerId: s.sellerId, fulfilledBy: 'seller', shipsFrom: 'Somewhere, CA', destination, items: [item(s.profileId)] });
    const asOfficial = await h.service.quoteOptions({ ownerType: 'official', shipsFrom: 'Reno, NV', destination, items: [item(official.profileId, { value: 2000 })] });
    expect(service.shipsToLocation).toBe(true);
    expect(own.shipsToLocation).toBe(true);
    // the Official schedule (cutoff, business days, closures), not the seller's 09:00 cutoff
    expect(service.default!.dispatchBy).toBe(asOfficial.default!.dispatchBy);
    expect(service.default!.cutoffAt).toBe(asOfficial.default!.cutoffAt);
    expect(service.options.map((o) => [o.methodCode, o.price.amount])).toEqual(asOfficial.options.map((o) => [o.methodCode, o.price.amount]));
    // shipped from the service location
    expect(service.default!.dispatchLabel).toContain('Reno, NV (Marketly warehouse)');

    // the profile-owner check is the Official one: a seller profile cannot ride in a Marketly package, and an
    // Official profile cannot in the seller's own package
    const wrong = await h.service.quoteOptions({ ownerType: 'seller', sellerId: s.sellerId, fulfilledBy: 'marketly_service', shipsFrom: 'x', destination, items: [item(s.profileId, { lineId: 'own' }), item(official.profileId, { lineId: 'svc' })] });
    expect(wrong).toMatchObject({ shipsToLocation: true, notShippableLineIds: ['own'] });
    const sellerPkg = await h.service.quoteOptions({ ownerType: 'seller', sellerId: s.sellerId, shipsFrom: 'x', destination, items: [item(official.profileId, { lineId: 'svc' })] });
    expect(sellerPkg).toMatchObject({ shipsToLocation: false, notShippableLineIds: ['svc'] });
  });

  it("uses the service profile's free-shipping threshold, funded by the seller", async () => {
    const official = await officialProfile();
    const sellerId = newId();
    const pkg = await h.service.quoteOptions({ ownerType: 'seller', sellerId, fulfilledBy: 'marketly_service', shipsFrom: 'x', destination: { postalCode: '97205', country: 'US' }, items: [item(official.profileId, { value: 5000 })] });
    expect(pkg.default).toMatchObject({ methodCode: 'standard', free: true, fundedBy: 'seller', price: USD(0) });
    const below = await h.service.quoteOptions({ ownerType: 'seller', sellerId, fulfilledBy: 'marketly_service', shipsFrom: 'x', destination: { postalCode: '97205', country: 'US' }, items: [item(official.profileId, { value: 1000 })] });
    expect(below.default).toMatchObject({ free: false, fundedBy: 'customer' });
  });

  it('falls back to the shipsFrom given when there is no service location', async () => {
    const official = await officialProfile();
    const kept = h.serviceLocation;
    h.serviceLocation = null;
    try {
      const pkg = await h.service.quoteOptions({ ownerType: 'seller', sellerId: newId(), fulfilledBy: 'marketly_service', shipsFrom: 'x', destination: { postalCode: '97205', country: 'US' }, items: [item(official.profileId)] });
      expect(pkg.default!.dispatchLabel).toContain('Somewhere, CA');
    } finally {
      h.serviceLocation = kept;
    }
  });

  it('estimates offers through Offer.shipping', async () => {
    const official = await officialProfile();
    // the offer's own profile is unknown; its effective shipping is the service profile
    const o = offer(h, { profileId: newId(), sellerId: newId(), shipping: { fulfilledBy: 'marketly_service', profileId: official.profileId, dispatch: { businessDays: 1, sameDayCutoff: null, shipsFrom: 'Reno, NV (Marketly warehouse)', label: 'Ships in 1 business day' } } });
    const legacy = offer(h, { profileId: newId(), sellerId: newId() });
    const est = await h.call('GET', `${STORE}/estimates?offerIds=${o.id},${legacy.id}&postalCode=97205`, tokens.visitor());
    expect(est.status).toBe(200);
    expect(est.body[0]).toMatchObject({ offerId: o.id, shipsToLocation: true, option: { methodCode: 'standard', dispatchLabel: expect.stringContaining('Marketly warehouse') } });
    expect(est.body[1]).toMatchObject({ offerId: legacy.id, shipsToLocation: false, option: null });
  });
});

describe('dispatch watch (G3)', () => {
  it('stores fulfilledBy on the watch', async () => {
    const o = await sellerOrder(h, { fulfilledBy: 'marketly_service' });
    expect(await h.service.core.repo.get('dispatch_watch', o.groupId)).toMatchObject({ owner_type: 'seller', seller_id: o.sellerId, fulfilled_by: 'marketly_service' });
    const own = await sellerOrder(h);
    expect(await h.service.core.repo.get('dispatch_watch', own.groupId)).toMatchObject({ fulfilled_by: 'seller' });
  });

  it('recalculates a late acceptance on the Official schedule, not the seller closures', async () => {
    const sellerId = newId();
    const token = tokens.seller(sellerId);
    // the seller is closed for a month: its own schedule would push the deadline past it
    const from = marketDate(h.clock.now(), -2);
    const to = marketDate(h.clock.now(), 30);
    expect((await h.call('POST', `${SELLER}/closures`, token, { name: 'Away', from, to })).status).toBe(201);
    const a = product(h, { title: 'Kettle', price: 4000, sellerId });
    const input = checkout([group(h, [line(a, 1)], { sellerId, fulfilledBy: 'marketly_service' })], { customerId: newId(), pending: true });
    const placed = await h.orders.createOrder(input);
    await h.app.kernel.events.drain();
    h.clock.advance(3 * 24 * HOUR);
    await h.orders.acceptOrder(placed.id, input.paymentIntentId);
    await h.app.kernel.events.drain();
    const watch = (await h.service.core.repo.get('dispatch_watch', placed.groups[0]!.id))!;
    expect(watch.fulfilled_by).toBe('marketly_service');
    expect(watch.due_at.getTime()).toBeGreaterThan(new Date(placed.groups[0]!.delivery.dispatchBy).getTime());
    expect(marketDate(watch.due_at) <= to).toBe(true);
    expect(watch.due_at.getTime()).toBeLessThan(h.clock.now().getTime() + 10 * 24 * HOUR);
  });
});

describe('the warehouse ships a Marketly package (G4, G5)', () => {
  it('buys the label billed to the seller from the service location, hands over as the seller, dispatched.fulfilledBy marketly_service', async () => {
    const o = await sellerOrder(h, { fulfilledBy: 'marketly_service' });
    const rate = vi.spyOn(h.service.core.carriers, 'rate');
    const buy = vi.spyOn(h.service.core.carriers, 'buyLabel');
    const label = await h.service.createLabel({ groupId: o.groupId, kind: 'outbound', items: [{ orderItemId: o.speaker.id, quantity: 2 }, { orderItemId: o.lamp.id, quantity: 1 }], parcel: { weightGrams: 2500 }, keepPromise: false }, `wh-${newId()}`);
    expect(rate.mock.calls.at(-1)![0]).toMatchObject({ fromPostalCode: '89502' });
    expect(buy.mock.calls.at(-1)![0]).toMatchObject({ from: { line1: '400 Dock St', postalCode: '89502' } });
    rate.mockRestore();
    buy.mockRestore();
    await h.app.kernel.events.drain();
    expect(await h.service.core.repo.get('labels', label.label.id)).toMatchObject({ billed_to: 'seller' });
    expect(h.named('shipping.label.purchased').at(-1)).toMatchObject({ groupId: o.groupId, sellerId: o.sellerId, billedTo: 'seller' });
    expect(h.named('shipping.shipment.created').at(-1)).toMatchObject({ shipmentId: label.shipment.id, sellerId: o.sellerId, fulfilledBy: 'marketly_service' });
    expect(await h.service.core.repo.get('shipments', label.shipment.id)).toMatchObject({ owner_type: 'seller', seller_id: o.sellerId, fulfilled_by: 'marketly_service' });

    // the seller sees the package but cannot hand it over, correct it or void its label
    const seller = tokens.seller(o.sellerId);
    expect((await h.call('GET', `${SELLER}/shipments/${label.shipment.id}`, seller)).status).toBe(200);
    const handOver = await h.call('POST', `${SELLER}/shipments/${label.shipment.id}/hand-over`, seller, {});
    expect(handOver.status).toBe(409);
    expect(handOver.body.error.code).toBe('FULFILLED_BY_MARKETLY');
    const corrected = await h.call('POST', `${SELLER}/shipments/${label.shipment.id}/correct-tracking`, seller, { trackingNumber: ups(), reason: 'typo' });
    expect(corrected.body.error.code).toBe('FULFILLED_BY_MARKETLY');
    const voided = await h.call('POST', `${SELLER}/labels/${label.label.id}/void`, seller, { reason: 'Wrong service chosen' }, idem());
    expect(voided.body.error.code, JSON.stringify(voided.body)).toBe('FULFILLED_BY_MARKETLY');
    // another seller still gets 404
    expect((await h.call('POST', `${SELLER}/shipments/${label.shipment.id}/hand-over`, tokens.seller(newId()), {})).status).toBe(404);

    await h.publish('warehouse', 'warehouse.package.packed', { packageId: newId(), fulfillmentId: newId(), orderId: o.order.id, sellerGroupId: o.groupId, ownerType: 'seller', sellerId: o.sellerId, fulfilledBy: 'marketly_service', items: [], carrier: 'ups', service: 'Ground', trackingNumber: label.label.trackingNumber, weight: { value: 2.5, unit: 'kg' }, dimensions: null });
    expect((await h.service.core.repo.get('shipments', label.shipment.id))!.status).toBe('shipped');
    expect(h.named('shipping.shipment.dispatched').at(-1)).toMatchObject({ shipmentId: label.shipment.id, ownerType: 'seller', sellerId: o.sellerId, fulfilledBy: 'marketly_service' });
    expect(await h.service.core.repo.get('dispatch_watch', o.groupId)).toBeUndefined();
  });

  it('records a packed package without a known label with the payload owner (never a hard-coded official one)', async () => {
    const o = await sellerOrder(h, { fulfilledBy: 'marketly_service' });
    const tn = ups();
    await h.publish('warehouse', 'warehouse.package.packed', { packageId: newId(), fulfillmentId: newId(), orderId: o.order.id, sellerGroupId: o.groupId, ownerType: 'seller', sellerId: o.sellerId, fulfilledBy: 'marketly_service', items: [pkgItem(o.lamp.id)], carrier: 'UPS', service: 'Ground', trackingNumber: tn, weight: { value: 1, unit: 'kg' }, dimensions: null });
    const rows = await h.service.core.repo.find('shipments', { group_id: o.groupId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner_type: 'seller', seller_id: o.sellerId, fulfilled_by: 'marketly_service', tracking_number: tn, status: 'shipped' });
    expect(h.named('shipping.shipment.created').at(-1)).toMatchObject({ shipmentId: rows[0]!.id, fulfilledBy: 'marketly_service' });
    expect(h.named('shipping.shipment.dispatched').at(-1)).toMatchObject({ shipmentId: rows[0]!.id, ownerType: 'seller', fulfilledBy: 'marketly_service' });

    // Official Store packages keep recording as official
    const off = await sellerOrder(h, { ownerType: 'official' });
    await h.publish('warehouse', 'warehouse.package.packed', { packageId: newId(), fulfillmentId: newId(), orderId: off.order.id, sellerGroupId: off.groupId, ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', items: [pkgItem(off.lamp.id)], carrier: 'ups', service: 'Ground', trackingNumber: ups(), weight: { value: 1, unit: 'kg' }, dimensions: null });
    expect((await h.service.core.repo.find('shipments', { group_id: off.groupId }))[0]).toMatchObject({ owner_type: 'official', seller_id: null, fulfilled_by: 'official_warehouse' });
    expect(h.named('shipping.shipment.dispatched').at(-1)).toMatchObject({ ownerType: 'official', fulfilledBy: 'official_warehouse' });
  });

  it("leaves Marketly's packages out of the seller's dispatch metrics", async () => {
    const sellerId = newId();
    const svc = await sellerOrder(h, { sellerId, fulfilledBy: 'marketly_service' });
    await h.publish('warehouse', 'warehouse.package.packed', { packageId: newId(), fulfillmentId: newId(), orderId: svc.order.id, sellerGroupId: svc.groupId, ownerType: 'seller', sellerId, fulfilledBy: 'marketly_service', items: [pkgItem(svc.lamp.id)], carrier: 'ups', service: 'Ground', trackingNumber: ups(), weight: { value: 1, unit: 'kg' }, dimensions: null });
    const own = await sellerOrder(h, { sellerId });
    const res = await h.call('POST', `${SELLER}/shipments`, tokens.seller(sellerId), { groupId: own.groupId, carrierCode: 'ups', trackingNumber: ups(), shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: own.lamp.id, quantity: 1 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const today = h.service.core.today();
    const m = await h.service.dispatchMetrics(sellerId, { from: today, to: today });
    expect(m.dispatched).toBe(1);
  });
});

describe('seller endpoints refuse Marketly packages (G6)', () => {
  it('answers 409 FULFILLED_BY_MARKETLY to record, quote and buy', async () => {
    const o = await sellerOrder(h, { fulfilledBy: 'marketly_service' });
    const seller = tokens.seller(o.sellerId);
    const recorded = await h.call('POST', `${SELLER}/shipments`, seller, { groupId: o.groupId, carrierCode: 'ups', trackingNumber: ups(), shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.lamp.id, quantity: 1 }] });
    expect(recorded.status).toBe(409);
    expect(recorded.body.error.code).toBe('FULFILLED_BY_MARKETLY');
    const quoted = await h.call('POST', `${SELLER}/labels/quotes`, seller, { groupId: o.groupId, items: [{ orderItemId: o.lamp.id, quantity: 1 }], parcel: { weightGrams: 1000 } });
    expect(quoted.status).toBe(409);
    expect(quoted.body.error.code).toBe('FULFILLED_BY_MARKETLY');
    // a quote taken on the group (e.g. before it became Marketly's) cannot be bought by the seller either
    const quote = await h.service.core.repo.insert('label_quotes', { id: newId(), group_id: o.groupId, carrier_service_id: (await h.service.core.repo.find('carrier_services', { label_supported: true }))[0]!.id, cost: 900, parcel: { weightGrams: 1000 }, estimated_arrival: { from: today(), to: today() }, keeps_promise: true, expires_at: new Date(h.clock.now().getTime() + HOUR) });
    const bought = await h.call('POST', `${SELLER}/labels`, seller, { quoteId: quote.id, items: [{ orderItemId: o.lamp.id, quantity: 1 }] }, idem());
    expect(bought.status).toBe(409);
    expect(bought.body.error.code).toBe('FULFILLED_BY_MARKETLY');
    // another seller: still 404
    expect((await h.call('POST', `${SELLER}/shipments`, tokens.seller(newId()), { groupId: o.groupId, carrierCode: 'ups', trackingNumber: ups(), shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.lamp.id, quantity: 1 }] })).status).toBe(404);
    expect(await h.service.core.repo.find('shipments', { group_id: o.groupId })).toEqual([]);
  });
});

const today = () => h.service.core.today();

describe('exceptions on Marketly packages (G5)', () => {
  it('opens overdue as a staff-owned exception without seller notice; the seller cannot respond', async () => {
    const o = await sellerOrder(h, { dispatchInHours: 2, fulfilledBy: 'marketly_service' });
    const noticesBefore = h.notices.length;
    h.clock.advance(3 * HOUR);
    await h.runJob('shipping.detect-late-dispatch');
    const overdue = h.named('shipping.dispatch.overdue').filter((e) => e.groupId === o.groupId);
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatchObject({ ownerType: 'seller', sellerId: o.sellerId, fulfilledBy: 'marketly_service' });
    const row = (await h.service.core.repo.get('exceptions', overdue[0].exceptionId))!;
    expect(row).toMatchObject({ kind: 'late_dispatch', fulfilled_by: 'marketly_service', seller_notified_at: null, next_step: expect.stringContaining('Fulfilled by Marketly') });
    expect(h.notices.slice(noticesBefore).filter((n) => n.recipients.some((r) => r.kind === 'seller'))).toEqual([]);

    const staff = tokens.staff();
    const ex = (await h.call('GET', `${ADMIN}/exceptions/${row.id}`, staff)).body;
    expect(ex).toMatchObject({ sellerNotifiedAt: null, requiredResponse: expect.stringContaining('Marketly warehouse') });
    // not in the seller's to-do list; answering it is refused
    const seller = tokens.seller(o.sellerId);
    expect((await h.call('GET', `${SELLER}/exceptions`, seller)).body.items.map((x: any) => x.id)).not.toContain(row.id);
    const answered = await h.call('POST', `${SELLER}/exceptions/${row.id}/respond`, seller, { action: 'other', note: 'x' });
    expect(answered.status).toBe(409);
    expect(answered.body.error.code).toBe('FULFILLED_BY_MARKETLY');
    // staff cannot remind a seller who has nothing to do
    expect((await h.call('POST', `${ADMIN}/exceptions/${row.id}/notify-seller`, staff, {})).status).toBe(400);

    // a second missed deadline stays with shipping: no escalation to the Seller Manager
    const dueAt = new Date(h.clock.now().getTime() + HOUR).toISOString();
    await h.publish('orders', 'orders.dispatch_deadline.changed', { orderId: o.order.id, groupId: o.groupId, dueAt, previousDueAt: overdue[0].dueAt, reason: 'Warehouse backlog', by: { kind: 'staff', id: newId() } });
    h.clock.advance(2 * HOUR);
    await h.runJob('shipping.detect-late-dispatch');
    expect(h.named('shipping.dispatch.overdue').filter((e) => e.groupId === o.groupId)).toHaveLength(2);
    expect(await h.service.core.repo.get('exceptions', row.id)).toMatchObject({ status: 'open', escalated_to: null, seller_notified_at: null });
  });

  it('carries fulfilledBy on shipment.exception', async () => {
    const o = await sellerOrder(h, { fulfilledBy: 'marketly_service' });
    const opened = await h.call('POST', `${ADMIN}/exceptions`, tokens.staff(), { kind: 'lost_or_damaged', groupId: o.groupId, orderItemIds: [o.lamp.id], situation: 'Crushed at the dock' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(h.named('shipping.shipment.exception').at(-1)).toMatchObject({ exceptionId: opened.body.id, sellerId: o.sellerId, fulfilledBy: 'marketly_service' });
    const own = await sellerOrder(h);
    await h.call('POST', `${ADMIN}/exceptions`, tokens.staff(), { kind: 'lost_or_damaged', groupId: own.groupId, situation: 'Crushed' });
    expect(h.named('shipping.shipment.exception').at(-1)).toMatchObject({ sellerId: own.sellerId, fulfilledBy: 'seller' });
  });
});

describe('fulfilled_by', () => {
  it('is a required field of the three collections, set on new rows; other values are refused', async () => {
    const cols = Object.entries(spec.collections as Record<string, { columns: readonly string[]; nullable: readonly string[] }>).filter(([, c]) => c.columns.includes('fulfilled_by'));
    expect(cols.map(([name, c]) => ({ name, nullable: c.nullable.includes('fulfilled_by') })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'dispatch_watch', nullable: false },
      { name: 'exceptions', nullable: false },
      { name: 'shipments', nullable: false },
    ]);

    const seller = await sellerOrder(h, { dispatchInHours: 1 });
    const official = await sellerOrder(h, { ownerType: 'official' });
    const s1 = await h.call('POST', `${SELLER}/shipments`, tokens.seller(seller.sellerId), { groupId: seller.groupId, carrierCode: 'ups', trackingNumber: ups(), shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: seller.lamp.id, quantity: 1 }] });
    expect(s1.status).toBe(201);
    await h.publish('warehouse', 'warehouse.package.packed', { packageId: newId(), fulfillmentId: newId(), orderId: official.order.id, sellerGroupId: official.groupId, ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', items: [pkgItem(official.lamp.id)], carrier: 'ups', service: 'Ground', trackingNumber: ups(), weight: { value: 1, unit: 'kg' }, dimensions: null });
    const s2 = (await h.service.core.repo.find('shipments', { group_id: official.groupId }))[0]!;
    const ex = await h.call('POST', `${ADMIN}/exceptions`, tokens.staff(), { kind: 'lost_or_damaged', groupId: official.groupId, situation: 'Crushed' });
    expect(ex.status).toBe(201);


    expect(await h.service.core.repo.get('shipments', s1.body.id)).toMatchObject({ owner_type: 'seller', fulfilled_by: 'seller' });
    expect(await h.service.core.repo.get('shipments', s2.id)).toMatchObject({ owner_type: 'official', fulfilled_by: 'official_warehouse' });
    expect(await h.service.core.repo.get('dispatch_watch', seller.groupId)).toMatchObject({ fulfilled_by: 'seller' });
    expect(await h.service.core.repo.get('exceptions', ex.body.id)).toMatchObject({ owner_type: 'official', fulfilled_by: 'official_warehouse' });
    const shipments = h.app.kernel.mongo.db.collection('shipping.shipments');
    await expect(shipments.updateOne({ _id: s1.body.id }, { $set: { fulfilled_by: 'robot' } })).rejects.toThrow();
    await expect(shipments.updateOne({ _id: s1.body.id }, { $set: { fulfilled_by: null } })).rejects.toThrow();
  });
});
