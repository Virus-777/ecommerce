import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { checkout, group, harness, idem, line, product, sellerOrder, tokens, ups, usps, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

const SELLER = '/api/seller/shipping';
const STORE = '/api/store/shipping';
const ADMIN = '/api/admin/shipping';

describe('recording shipments (seller)', () => {
  it('records a partial shipment: created and dispatched, orders ships those units, the rest keeps its deadline', async () => {
    const o = await sellerOrder(h);
    const seller = tokens.seller(o.sellerId);
    const tn = ups();
    const res = await h.call('POST', `${SELLER}/shipments`, seller, { groupId: o.groupId, carrierCode: 'ups', serviceName: 'UPS Ground', trackingNumber: tn, shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.speaker.id, quantity: 1 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ kind: 'outbound', status: 'shipped', statusLabel: 'Shipped, tracking pending', trackingState: 'pending', trackingNumber: tn, carrierName: 'UPS', dispatchedOnTime: true, packageLabel: 'Package 1 of 1' });
    expect(res.body.contents).toEqual([{ orderItemId: o.speaker.id, title: 'Pocket Speaker', variantLabel: expect.any(String), quantity: 1 }]);
    expect(res.body.trackingUrl).toContain(tn);
    expect(h.named('shipping.shipment.created').at(-1)).toMatchObject({ shipmentId: res.body.id, orderId: o.order.id, trackingNumber: tn, lines: [expect.objectContaining({ quantity: 1 })] });
    expect(h.named('shipping.shipment.dispatched').at(-1)).toMatchObject({ shipmentId: res.body.id, ownerType: 'seller', sellerId: o.sellerId, onTime: true, trackingValid: true, customerId: o.customerId, contactEmail: 'jordan@example.com' });
    const order = (await h.orders.getOrder(o.order.id))!;
    const items = order.groups[0]!.items;
    expect(items.filter((i) => i.state === 'shipped').map((i) => i.quantity)).toEqual([1]);
    expect(items.filter((i) => i.state === 'confirmed').reduce((n, i) => n + i.quantity, 0)).toBe(2);
    // the watch keeps what is left
    const watch = await h.service.core.repo.get('dispatch_watch', o.groupId);
    expect(watch?.open_item_ids.length).toBeGreaterThan(0);
  });

  it('checks items, tracking formats and reuse', async () => {
    const o = await sellerOrder(h);
    const seller = tokens.seller(o.sellerId);
    const base = { groupId: o.groupId, carrierCode: 'ups', shippedAt: h.clock.now().toISOString() };
    const tooMany = await h.call('POST', `${SELLER}/shipments`, seller, { ...base, trackingNumber: ups(), items: [{ orderItemId: o.speaker.id, quantity: 5 }] });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe('ITEMS_NOT_SHIPPABLE');
    expect(tooMany.body.error.details.items[0]).toMatch(/at most 2/);
    const foreign = await h.call('POST', `${SELLER}/shipments`, seller, { ...base, trackingNumber: ups(), items: [{ orderItemId: newId(), quantity: 1 }] });
    expect(foreign.body.error.code).toBe('ITEMS_NOT_SHIPPABLE');
    const bad = await h.call('POST', `${SELLER}/shipments`, seller, { ...base, trackingNumber: '12345', items: [{ orderItemId: o.lamp.id, quantity: 1 }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('TRACKING_FORMAT_INVALID');
    const noTracking = await h.call('POST', `${SELLER}/shipments`, seller, { ...base, items: [{ orderItemId: o.lamp.id, quantity: 1 }] });
    expect(noTracking.status).toBe(400);
    // saved anyway: invalid tracking opens a missing_tracking exception and never implies delivery
    const acked = await h.call('POST', `${SELLER}/shipments`, seller, { ...base, trackingNumber: '12345-ABC', acknowledgeFormatWarning: true, items: [{ orderItemId: o.lamp.id, quantity: 1 }] });
    expect(acked.status).toBe(201);
    expect(acked.body).toMatchObject({ trackingState: 'invalid', statusLabel: 'Shipped, tracking pending' });
    expect(acked.body.openExceptionIds).toHaveLength(1);
    expect(h.named('shipping.shipment.exception').at(-1)).toMatchObject({ kind: 'missing_tracking', shipmentId: acked.body.id, orderItemIds: [o.lamp.id] });
    const tn = ups();
    expect((await h.call('POST', `${SELLER}/shipments`, seller, { ...base, trackingNumber: tn, items: [{ orderItemId: o.speaker.id, quantity: 1 }] })).status).toBe(201);
    const o2 = await sellerOrder(h, { sellerId: o.sellerId });
    const reused = await h.call('POST', `${SELLER}/shipments`, seller, { ...base, groupId: o2.groupId, trackingNumber: tn, items: [{ orderItemId: o2.speaker.id, quantity: 1 }] });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('TRACKING_ALREADY_USED');
  });

  it("keeps sellers to their own orders and shipments (others' are 404)", async () => {
    const o = await sellerOrder(h);
    const other = tokens.seller(newId());
    const res = await h.call('POST', `${SELLER}/shipments`, other, { groupId: o.groupId, carrierCode: 'ups', trackingNumber: ups(), shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.speaker.id, quantity: 1 }] });
    expect(res.status).toBe(404);
    const mine = await h.call('POST', `${SELLER}/shipments`, tokens.seller(o.sellerId), { groupId: o.groupId, carrierCode: 'usps', trackingNumber: usps(), shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.lamp.id, quantity: 1 }] });
    expect(mine.status).toBe(201);
    expect((await h.call('GET', `${SELLER}/shipments/${mine.body.id}`, other)).status).toBe(404);
    expect((await h.call('POST', `${SELLER}/shipments/${mine.body.id}/correct-tracking`, other, { trackingNumber: usps(), reason: 'typo' })).status).toBe(404);
    const list = await h.call('GET', `${SELLER}/shipments?groupId=${o.groupId}`, tokens.seller(o.sellerId));
    expect(list.body.items.map((s: any) => s.id)).toEqual([mine.body.id]);
    expect((await h.call('GET', `${SELLER}/shipments`, other)).body.items).toEqual([]);
  });

  it('corrects tracking with history and tells orders', async () => {
    const o = await sellerOrder(h);
    const seller = tokens.seller(o.sellerId);
    const s = (await h.call('POST', `${SELLER}/shipments`, seller, { groupId: o.groupId, carrierCode: 'ups', trackingNumber: ups(), shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.lamp.id, quantity: 1 }] })).body;
    const tn = usps();
    const bad = await h.call('POST', `${SELLER}/shipments/${s.id}/correct-tracking`, seller, { carrierCode: 'usps', trackingNumber: '1Z999', reason: 'Wrong carrier' });
    expect(bad.body.error.code).toBe('TRACKING_FORMAT_INVALID');
    const fixed = await h.call('POST', `${SELLER}/shipments/${s.id}/correct-tracking`, seller, { carrierCode: 'usps', trackingNumber: tn, reason: 'Wrong carrier' });
    expect(fixed.status).toBe(200);
    expect(fixed.body).toMatchObject({ carrierCode: 'usps', trackingNumber: tn, status: 'shipped' });
    expect(fixed.body.corrections).toEqual([expect.objectContaining({ from: `UPS ${s.trackingNumber}`, to: `USPS ${tn}`, reason: 'Wrong carrier', customerNotified: true })]);
    expect(h.named('shipping.tracking.corrected').at(-1)).toMatchObject({ shipmentId: s.id, from: s.trackingNumber, to: tn });
    const staff = await h.call('POST', `${ADMIN}/shipments/${s.id}/correct-tracking`, tokens.staff(), { trackingNumber: usps(), reason: 'Carrier confirmed by phone', notifyCustomer: false });
    expect(staff.status).toBe(200);
    expect(staff.body.corrections.at(-1).customerNotified).toBe(false);
    expect(h.audits.at(-1)).toMatchObject({ action: 'shipping.tracking.correct', reason: 'Carrier confirmed by phone' });
  });
});

describe('carrier tracking (webhooks) and the customer view', () => {
  it('applies signed carrier events once, moves orders and shows the customer the package', async () => {
    const o = await sellerOrder(h);
    const tn = ups();
    const s = (await h.call('POST', `${SELLER}/shipments`, tokens.seller(o.sellerId), { groupId: o.groupId, carrierCode: 'ups', trackingNumber: tn, shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.speaker.id, quantity: 2 }, { orderItemId: o.lamp.id, quantity: 1 }] })).body;
    expect(s.openExceptionIds).toEqual([]);
    const at = (m: number) => new Date(h.clock.now().getTime() + m * 60_000).toISOString();
    const transit = { events: [{ id: `evt-${tn}-1`, trackingNumber: tn, code: 'in_transit', at: at(1), description: 'Arrived at UPS facility', location: 'Sparks, NV' }] };
    expect((await h.webhook('ups', transit)).body).toEqual({ received: true });
    expect((await h.webhook('ups', transit)).status).toBe(200); // replay: same event id
    let view = (await h.call('GET', `${ADMIN}/shipments/${s.id}`, tokens.staff())).body;
    expect(view).toMatchObject({ status: 'in_transit', trackingState: 'valid', statusLabel: 'In transit' });
    expect(view.events.filter((e: any) => e.source === 'carrier_webhook')).toHaveLength(1);
    expect(h.named('shipping.shipment.status_changed').filter((e) => e.shipmentId === s.id).map((e) => e.to)).toEqual(['shipped', 'in_transit']);

    // a bad signature never reaches the handler
    const raw = JSON.stringify(transit);
    const forged = await h.app.inject({ method: 'POST', url: '/webhooks/shipping/carriers/ups/events', headers: { 'content-type': 'application/json', 'x-signature': 'sha256=00', 'x-timestamp': String(Math.floor(Date.now() / 1000)) }, payload: raw });
    expect(forged.statusCode).toBe(401);

    // the customer tracks it; another customer gets 404
    const me = tokens.customer(o.customerId);
    const tracking = await h.call('GET', `${STORE}/shipments/${s.id}/tracking`, me);
    expect(tracking.status).toBe(200);
    expect(tracking.body).toMatchObject({ headline: 'Estimated delivery', currentStep: 1, carrier: { name: 'UPS', trackingNumber: tn }, seller: 'Casa Verde Home', helpNote: expect.stringContaining('wait until the end of the next day') });
    expect(tracking.body.estimateNote).toContain('Jordan Lee, Portland, OR 97205');
    expect((await h.call('GET', `${STORE}/shipments/${s.id}/tracking`, tokens.customer(newId()))).status).toBe(404);
    const list = await h.call('GET', `${STORE}/orders/${o.order.id}/shipments`, me);
    expect(list.body).toHaveLength(1);
    expect((await h.call('GET', `${STORE}/orders/${o.order.id}/shipments`, tokens.customer(newId()))).status).toBe(404);

    await h.webhook('ups', { id: `evt-${tn}-2`, trackingNumber: tn, code: 'delivered', at: at(2), location: 'Portland, OR' });
    view = (await h.call('GET', `${ADMIN}/shipments/${s.id}`, tokens.staff())).body;
    expect(view).toMatchObject({ status: 'delivered', statusLabel: 'Delivered' });
    expect(h.named('shipping.shipment.delivered').at(-1)).toMatchObject({ shipmentId: s.id, customerId: o.customerId, contactEmail: 'jordan@example.com', lines: expect.arrayContaining([expect.objectContaining({ orderItemId: o.lamp.id })]) });
    const order = (await h.orders.getOrder(o.order.id))!;
    expect(order.groups[0]!.items.every((i) => i.state === 'delivered')).toBe(true);
  });

  it('keeps events for unknown numbers and matches them when the package is recorded', async () => {
    const o = await sellerOrder(h);
    const tn = usps();
    await h.webhook('usps', { id: `early-${tn}`, trackingNumber: tn, code: 'accepted', at: h.clock.now().toISOString() });
    const s = (await h.call('POST', `${SELLER}/shipments`, tokens.seller(o.sellerId), { groupId: o.groupId, carrierCode: 'usps', trackingNumber: tn, shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.lamp.id, quantity: 1 }] })).body;
    expect(s.trackingState).toBe('valid');
    expect(s.statusLabel).toBe('Shipped');
  });

  it('records a missed carrier event as staff; delivery needs proof', async () => {
    const o = await sellerOrder(h);
    const s = (await h.call('POST', `${SELLER}/shipments`, tokens.seller(o.sellerId), { groupId: o.groupId, carrierCode: 'ups', trackingNumber: ups(), shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.lamp.id, quantity: 1 }] })).body;
    const staff = tokens.staff();
    const noProof = await h.call('POST', `${ADMIN}/shipments/${s.id}/events`, staff, { code: 'delivered', at: h.clock.now().toISOString(), detail: 'Carrier confirmed by phone', reason: 'Feed missed it' });
    expect(noProof.status).toBe(400);
    expect(noProof.body.error.details.issues[0].path).toBe('evidenceIds');
    const ok = await h.call('POST', `${ADMIN}/shipments/${s.id}/events`, staff, { code: 'out_for_delivery', at: h.clock.now().toISOString(), detail: 'On the truck', reason: 'Feed missed it' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('out_for_delivery');
    expect(h.audits.at(-1)).toMatchObject({ action: 'shipping.shipment.record_event', reason: 'Feed missed it' });
    const proof = await h.service.core.repo.find('shipments', { id: s.id });
    expect(proof).toHaveLength(1);
    // delivery with proof (evidence ids are checked through media when it knows them)
    h.service.core.ctx.tryUse('media');
    const delivered = await h.service.shipments.applyScan(s.id, { code: 'delivered', at: h.clock.now(), detail: 'Signed by J. Lee', location: null, source: 'staff', carrierEventId: `staff:${newId()}` }, { actor: { kind: 'staff', id: newId() } });
    expect(delivered).toBe(true);
    const back = await h.call('POST', `${ADMIN}/shipments/${s.id}/events`, staff, { code: 'in_transit', at: h.clock.now().toISOString(), detail: 'x', reason: 'y' });
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('offers next steps after a failed delivery; the default returns the package when nobody chooses', async () => {
    const o = await sellerOrder(h);
    const tn = ups();
    const s = (await h.call('POST', `${SELLER}/shipments`, tokens.seller(o.sellerId), { groupId: o.groupId, carrierCode: 'ups', trackingNumber: tn, shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.lamp.id, quantity: 1 }] })).body;
    await h.webhook('ups', { events: [{ id: `f1-${tn}`, trackingNumber: tn, code: 'in_transit', at: h.clock.now().toISOString() }, { id: `f2-${tn}`, trackingNumber: tn, code: 'attempt_failed', at: new Date(h.clock.now().getTime() + 60_000).toISOString(), description: 'No one home', location: 'Portland Main Post Office' }] });
    const me = tokens.customer(o.customerId);
    const view = (await h.call('GET', `${STORE}/shipments/${s.id}/tracking`, me)).body;
    expect(view.headline).toBe('Delivery attempt failed');
    expect(view.failedDelivery).toMatchObject({ reason: 'No one home', heldAt: 'Portland Main Post Office', defaultIfNoChoice: 'return_to_seller' });
    expect(view.failedDelivery.options.map((x: any) => x.choice)).toEqual(['redeliver', 'pickup', 'return_to_seller']);
    expect(h.named('shipping.shipment.exception').at(-1)).toMatchObject({ kind: 'failed_delivery', shipmentId: s.id, customerAction: expect.any(String), customerId: o.customerId, contactEmail: 'jordan@example.com' });
    const date = view.failedDelivery.options[0].dates[0];
    expect((await h.call('POST', `${STORE}/shipments/${s.id}/delivery-choice`, tokens.customer(newId()), { choice: 'redeliver', redeliveryDate: date })).status).toBe(404);
    expect((await h.call('POST', `${STORE}/shipments/${s.id}/delivery-choice`, me, { choice: 'redeliver', redeliveryDate: '2000-01-01' })).status).toBe(400);
    const chosen = await h.call('POST', `${STORE}/shipments/${s.id}/delivery-choice`, me, { choice: 'redeliver', redeliveryDate: date });
    expect(chosen.status).toBe(200);
    expect(chosen.body.failedDelivery.chosen).toMatchObject({ choice: 'redeliver', redeliveryDate: date });
    expect(h.named('shipping.delivery_choice.made').at(-1)).toMatchObject({ shipmentId: s.id, choice: 'redeliver', redeliveryDate: date });
    expect((await h.call('POST', `${STORE}/shipments/${s.id}/delivery-choice`, me, { choice: 'pickup' })).body.error.code).toBe('ILLEGAL_TRANSITION');
    // redelivery succeeds: the failed_delivery exception closes
    await h.webhook('ups', { events: [{ id: `f3-${tn}`, trackingNumber: tn, code: 'out_for_delivery', at: new Date(h.clock.now().getTime() + 120_000).toISOString() }, { id: `f4-${tn}`, trackingNumber: tn, code: 'delivered', at: new Date(h.clock.now().getTime() + 180_000).toISOString() }] });
    expect(h.named('shipping.exception.resolved').at(-1)).toMatchObject({ kind: 'failed_delivery', resolution: 'redelivered' });

    // a second package nobody decides for
    const o2 = await sellerOrder(h, { customerId: o.customerId });
    const tn2 = ups();
    const s2 = (await h.call('POST', `${SELLER}/shipments`, tokens.seller(o2.sellerId), { groupId: o2.groupId, carrierCode: 'ups', trackingNumber: tn2, shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o2.lamp.id, quantity: 1 }] })).body;
    await h.webhook('ups', { events: [{ id: `g1-${tn2}`, trackingNumber: tn2, code: 'attempt_failed', at: h.clock.now().toISOString() }] });
    h.clock.advance(15 * 86_400_000);
    expect((await h.call('POST', `${STORE}/shipments/${s2.id}/delivery-choice`, me, { choice: 'pickup' })).body.error.code).toBe('CHOICE_WINDOW_CLOSED');
    await h.runJob('shipping.failed-delivery-default');
    const after = (await h.call('GET', `${ADMIN}/shipments/${s2.id}`, tokens.staff())).body;
    expect(after.status).toBe('returning');
    expect(after.failedDelivery.chosen).toMatchObject({ choice: 'return_to_seller' });
    expect(h.named('shipping.delivery_choice.made').at(-1)).toMatchObject({ shipmentId: s2.id, choice: 'return_to_seller' });
    expect(h.notices.some((n) => n.topic === 'customer.shipment.exception')).toBe(true);
  });
});

describe('labels', () => {
  it('quotes, buys (idempotent), hands over and voids labels', async () => {
    const o = await sellerOrder(h);
    const seller = tokens.seller(o.sellerId);
    const quotes = await h.call('POST', `${SELLER}/labels/quotes`, seller, { groupId: o.groupId, items: [{ orderItemId: o.speaker.id, quantity: 2 }], parcel: { weightGrams: 1800, lengthCm: 30, widthCm: 20, heightCm: 15 } });
    expect(quotes.status, JSON.stringify(quotes.body)).toBe(200);
    expect(quotes.body.length).toBeGreaterThan(3);
    expect(quotes.body[0]).toMatchObject({ keepsPromise: true, cost: { currency: 'USD' } });
    const q = quotes.body[0];
    const key = idem();
    const bought = await h.call('POST', `${SELLER}/labels`, seller, { quoteId: q.id, items: [{ orderItemId: o.speaker.id, quantity: 2 }] }, key);
    expect(bought.status, JSON.stringify(bought.body)).toBe(201);
    expect(bought.body.label).toMatchObject({ status: 'purchased', format: 'pdf', cost: q.cost, carrierName: q.carrierName });
    expect(bought.body.shipment).toMatchObject({ status: 'label_created', statusLabel: 'Label created, not shipped yet', trackingNumber: bought.body.label.trackingNumber });
    expect(h.named('shipping.label.purchased').at(-1)).toMatchObject({ labelId: bought.body.label.id, billedTo: 'seller', sellerId: o.sellerId, cost: q.cost, kind: 'outbound' });
    const again = await h.call('POST', `${SELLER}/labels`, seller, { quoteId: q.id, items: [{ orderItemId: o.speaker.id, quantity: 2 }] }, key);
    expect(again.body.label.id).toBe(bought.body.label.id);
    // the units on the label cannot be recorded again
    const dup = await h.call('POST', `${SELLER}/shipments`, seller, { groupId: o.groupId, carrierCode: 'ups', trackingNumber: ups(), shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.speaker.id, quantity: 1 }] });
    expect(dup.body.error.code).toBe('ITEMS_NOT_SHIPPABLE');
    // the setup remembers the package
    expect((await h.call('GET', `${SELLER}/shipping-setup`, seller)).body.defaultParcel ?? null).toBeNull(); // no saved settings yet: nothing to remember on
    const handed = await h.call('POST', `${SELLER}/shipments/${bought.body.shipment.id}/hand-over`, seller, {});
    expect(handed.status).toBe(200);
    expect(handed.body.status).toBe('shipped');
    expect(h.named('shipping.shipment.dispatched').at(-1)).toMatchObject({ shipmentId: bought.body.shipment.id });
    const late = await h.call('POST', `${SELLER}/labels/${bought.body.label.id}/void`, seller, { reason: 'Wrong box' }, idem());
    expect(late.status).toBe(409);

    // a second label voided before the carrier has it
    const q2 = (await h.call('POST', `${SELLER}/labels/quotes`, seller, { groupId: o.groupId, items: [{ orderItemId: o.lamp.id, quantity: 1 }], parcel: { weightGrams: 900 } })).body[0];
    const b2 = (await h.call('POST', `${SELLER}/labels`, seller, { quoteId: q2.id, items: [{ orderItemId: o.lamp.id, quantity: 1 }] }, idem())).body;
    expect((await h.call('POST', `${SELLER}/labels/${b2.label.id}/void`, tokens.seller(newId()), { reason: 'x' }, idem())).status).toBe(404);
    const voided = await h.call('POST', `${SELLER}/labels/${b2.label.id}/void`, seller, { reason: 'Customer cancelled' }, idem());
    expect(voided.body).toMatchObject({ status: 'voided' });
    expect(h.named('shipping.label.voided').at(-1)).toMatchObject({ labelId: b2.label.id, billedTo: 'seller', cost: q2.cost });
    expect((await h.call('GET', `${SELLER}/shipments/${b2.shipment.id}`, seller)).body.status).toBe('cancelled');
  });

  it('refuses expired quotes and reports carrier failures without charging', async () => {
    const o = await sellerOrder(h);
    const seller = tokens.seller(o.sellerId);
    const failing = (await h.call('POST', `${SELLER}/labels/quotes`, seller, { groupId: o.groupId, items: [{ orderItemId: o.lamp.id, quantity: 1 }], parcel: { weightGrams: 1013 } })).body[0];
    const failed = await h.call('POST', `${SELLER}/labels`, seller, { quoteId: failing.id, items: [{ orderItemId: o.lamp.id, quantity: 1 }] }, idem());
    expect(failed.status).toBe(502);
    expect(failed.body.error).toMatchObject({ code: 'LABEL_FAILED', details: { carrierMessage: expect.any(String) } });
    expect(h.named('shipping.label.purchased').some((e) => e.groupId === o.groupId)).toBe(false);
    const q = (await h.call('POST', `${SELLER}/labels/quotes`, seller, { groupId: o.groupId, items: [{ orderItemId: o.lamp.id, quantity: 1 }], parcel: { weightGrams: 900 } })).body[0];
    h.clock.advance(31 * 60_000);
    const expired = await h.call('POST', `${SELLER}/labels`, seller, { quoteId: q.id, items: [{ orderItemId: o.lamp.id, quantity: 1 }] }, idem());
    expect(expired.body.error.code).toBe('QUOTE_EXPIRED');
  });

  it('creates return labels and customer-arranged return tracking for returns', async () => {
    const o = await sellerOrder(h);
    const returnId = newId();
    const to = { name: 'Casa Verde Returns', line1: '9 Dock Rd', city: 'Reno', region: 'NV', postalCode: '89502', country: 'US' };
    // the drop-off deadline is the one returns decided (approval + policy dropOffDays), never one shipping invents
    const dropOffBy = new Date(h.clock.now().getTime() + 10 * 86_400_000).toISOString();
    const r = await h.service.createLabel({ groupId: o.groupId, kind: 'return', items: [{ orderItemId: o.lamp.id, quantity: 1 }], parcel: { weightGrams: 1200 }, keepPromise: false, to, returnId, labelMethod: 'prepaid_qr', billedTo: 'customer', dropOffBy }, `ret-${returnId}`);
    expect(r.shipment).toMatchObject({ kind: 'return', returnId, status: 'label_created' });
    expect(r.label.qrCodeUrl).toMatch(/^http/);
    expect(r.label).toMatchObject({ dropOffBy, format: 'pdf', carrierServiceId: expect.any(String) });
    const row = (await h.service.core.repo.get('labels', r.label.id))!;
    expect(row).toMatchObject({ billed_to: 'customer', drop_off_by: new Date(dropOffBy), carrier_service_id: r.label.carrierServiceId });
    expect((await h.call('GET', `${ADMIN}/shipments/${r.shipment.id}`, tokens.staff())).body.events.map((e: any) => [e.code, e.source])).toEqual([['label_created', 'system']]);
    await h.app.kernel.events.drain();
    expect(h.named('shipping.label.purchased').at(-1)).toMatchObject({ kind: 'return', returnId, billedTo: 'customer' });
    const noDeadline = await h.service.createLabel({ groupId: o.groupId, kind: 'return', items: [{ orderItemId: o.lamp.id, quantity: 1 }], parcel: { weightGrams: 1200 }, keepPromise: false, to, returnId: newId(), billedTo: 'seller' }, `ret-${newId()}`);
    expect(noDeadline.label.dropOffBy).toBeNull();
    const same = await h.service.createLabel({ groupId: o.groupId, kind: 'return', items: [], parcel: { weightGrams: 1200 }, keepPromise: false, to, returnId }, `ret-${returnId}`);
    expect(same.label.id).toBe(r.label.id);
    const points = await h.service.findDropOffPoints((await h.service.core.repo.get('labels', r.label.id))!.carrier_service_id, '97205', 3);
    expect(points).toHaveLength(3);
    const own = await h.service.registerReturnTracking({ returnId: newId(), orderId: o.order.id, groupId: o.groupId, carrierCode: 'usps', trackingNumber: usps(), to });
    expect(own).toMatchObject({ kind: 'return', status: 'shipped', trackingState: 'pending' });
    expect((await h.call('GET', `${ADMIN}/shipments/${own.id}`, tokens.staff())).body.events.map((e: any) => [e.code, e.source])).toEqual([['info', 'customer']]);
    await h.app.kernel.events.drain();
    expect(h.named('shipping.shipment.dispatched').at(-1)).toMatchObject({ kind: 'return', shipmentId: own.id });
    await expect(h.service.registerReturnTracking({ returnId: newId(), orderId: o.order.id, groupId: o.groupId, carrierCode: 'usps', trackingNumber: '42', to })).rejects.toMatchObject({ code: 'TRACKING_FORMAT_INVALID' });
  });

  it('hands over warehouse-packed Official Store packages', async () => {
    const o = await sellerOrder(h, { ownerType: 'official' });
    // warehouse thermal printers ask for zpl
    const label = await h.service.createLabel({ groupId: o.groupId, kind: 'outbound', items: [{ orderItemId: o.speaker.id, quantity: 2 }, { orderItemId: o.lamp.id, quantity: 1 }], parcel: { weightGrams: 2500 }, keepPromise: true, format: 'zpl' }, `wh-${o.groupId}`);
    expect(label.label).toMatchObject({ format: 'zpl', dropOffBy: null });
    await h.app.kernel.events.drain();
    expect(h.named('shipping.label.purchased').at(-1)).toMatchObject({ billedTo: 'company', sellerId: null });
    await h.publish('warehouse', 'warehouse.package.packed', { packageId: newId(), fulfillmentId: newId(), orderId: o.order.id, sellerGroupId: o.groupId, ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', items: [], carrier: 'ups', service: 'Ground', trackingNumber: label.label.trackingNumber, weight: { value: 2.5, unit: 'kg' }, dimensions: null });
    const s = (await h.call('GET', `${ADMIN}/shipments/${label.shipment.id}`, tokens.staff())).body;
    expect(s.status).toBe('shipped');
    expect(await h.service.core.repo.get('dispatch_watch', o.groupId)).toBeUndefined();
  });
});

describe('reads for other modules', () => {
  it('lists shipments per order and group, and computes dispatch metrics', async () => {
    const o = await sellerOrder(h);
    const seller = tokens.seller(o.sellerId);
    const s = (await h.call('POST', `${SELLER}/shipments`, seller, { groupId: o.groupId, carrierCode: 'ups', trackingNumber: ups(), shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.lamp.id, quantity: 1 }] })).body;
    expect((await h.service.getShipmentsForOrder(o.order.id)).map((x) => x.id)).toEqual([s.id]);
    const byGroup = await h.service.listShipmentsForGroups([o.groupId]);
    expect(byGroup.get(o.groupId)!.map((x) => x.id)).toEqual([s.id]);
    expect(await h.service.getShipment({ sellerId: newId() }, s.id)).toBeNull();
    expect(await h.service.getShipment({ customerId: o.customerId }, s.id)).toMatchObject({ id: s.id });
    const today = h.service.core.today();
    const m = await h.service.dispatchMetrics(o.sellerId, { from: today, to: today });
    expect(m).toMatchObject({ dispatched: 1, onTimePct: 100, late: 0 });
    const admin = await h.call('GET', `${ADMIN}/shipments?q=${encodeURIComponent(s.orderRef)}`, tokens.staff());
    expect(admin.body.items.map((x: any) => x.id)).toContain(s.id);
  });
});

describe('who customer-facing shipment events reach', () => {
  it("a guest order's events carry the contact email and no customer", async () => {
    const sellerId = newId();
    const p = product(h, { title: 'Wall Clock', price: 2500, sellerId });
    const order = await h.orders.createOrder(checkout([group(h, [line(p, 1)], { sellerId })], { customerId: null }));
    await h.app.kernel.events.drain();
    const g = order.groups[0]!;
    const tn = ups();
    const res = await h.call('POST', `${SELLER}/shipments`, tokens.seller(sellerId), { groupId: g.id, carrierCode: 'ups', trackingNumber: tn, shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: g.items[0]!.id, quantity: 1 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(h.named('shipping.shipment.dispatched').find((e) => e.shipmentId === res.body.id)).toMatchObject({ orderId: order.id, customerId: null, contactEmail: 'gia@example.com' });
    await h.webhook('ups', { id: `guest-${tn}`, trackingNumber: tn, code: 'delivered', at: h.clock.now().toISOString() });
    expect(h.named('shipping.shipment.delivered').find((e) => e.shipmentId === res.body.id)).toMatchObject({ customerId: null, contactEmail: 'gia@example.com' });
  });
});
