/**
 * Carriers a seller ships with itself: kept in the seller's own list, offered next to Marketly's when recording a
 * shipment, never shown to staff or customers as platform carriers, and copied onto a package so removing one
 * never rewrites a shipment that already went out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { harness, sellerOrder, tokens, ups, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

const SELLER = '/api/seller/shipping';
const ADMIN = '/api/admin/shipping';
const STORE = '/api/store/shipping';

const add = (sellerId: string, body: unknown) => h.call('POST', `${SELLER}/carriers`, tokens.seller(sellerId), body);

describe("a seller's own carriers", () => {
  it('adds, renames and removes one, and keeps the names apart', async () => {
    const sellerId = newId();
    const seller = tokens.seller(sellerId);
    expect((await h.call('GET', `${SELLER}/carriers`, seller)).body).toEqual([]);

    const made = await add(sellerId, { name: 'Speedy Local Courier', trackingUrlTemplate: 'https://speedy.example/track/{n}', trackingPattern: '^SP\\d{6}$' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ name: 'Speedy Local Courier', trackingUrlTemplate: 'https://speedy.example/track/{n}', trackingPattern: '^SP\\d{6}$' });
    expect(made.body.code).toMatch(/^own-/);

    const again = await add(sellerId, { name: ' speedy local courier ' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT');

    const renamed = await h.call('PATCH', `${SELLER}/carriers/${made.body.id}`, seller, { name: 'Speedy Courier', trackingUrlTemplate: null, trackingPattern: null });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ id: made.body.id, code: made.body.code, name: 'Speedy Courier', trackingUrlTemplate: null, trackingPattern: null });

    const second = await add(sellerId, { name: 'Our Own Van' });
    expect(second.status).toBe(201);
    expect((await h.call('GET', `${SELLER}/carriers`, seller)).body.map((c: any) => c.name)).toEqual(['Speedy Courier', 'Our Own Van']);

    expect((await h.call('DELETE', `${SELLER}/carriers/${second.body.id}`, seller)).status).toBe(204);
    expect((await h.call('GET', `${SELLER}/carriers`, seller)).body.map((c: any) => c.name)).toEqual(['Speedy Courier']);
  });

  it('checks the name, the tracking link and the number format', async () => {
    const sellerId = newId();
    const blank = await add(sellerId, { name: '  ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error.details.issues[0]).toMatchObject({ path: 'name' });
    expect((await add(sellerId, { name: 'x'.repeat(61) })).status).toBe(400);

    const http = await add(sellerId, { name: 'Courier', trackingUrlTemplate: 'http://courier.example/track/{n}' });
    expect(http.body.error.details.issues[0]).toMatchObject({ path: 'trackingUrlTemplate', message: expect.stringContaining('https://') });
    const noPlaceholder = await add(sellerId, { name: 'Courier', trackingUrlTemplate: 'https://courier.example/track' });
    expect(noPlaceholder.body.error.details.issues[0].message).toContain('{n}');
    const badPattern = await add(sellerId, { name: 'Courier', trackingPattern: '^SP(\\d{6}$' });
    expect(badPattern.body.error.details.issues[0]).toMatchObject({ path: 'trackingPattern' });
  });

  it("keeps each seller's carriers to itself, and off the staff and storefront lists", async () => {
    const mine = newId();
    const other = newId();
    const made = await add(mine, { name: 'Night Owl Delivery' });
    expect(made.status).toBe(201);

    // another seller sees nothing of it, and cannot rename or remove it
    expect((await h.call('GET', `${SELLER}/carriers`, tokens.seller(other))).body).toEqual([]);
    expect((await h.call('PATCH', `${SELLER}/carriers/${made.body.id}`, tokens.seller(other), { name: 'Theirs' })).status).toBe(404);
    expect((await h.call('DELETE', `${SELLER}/carriers/${made.body.id}`, tokens.seller(other))).status).toBe(404);

    // staff see the platform's carriers; a seller's own courier is not one of them
    const staffList = await h.call('GET', `${ADMIN}/carriers`, tokens.staff(['shipping.settings.view']));
    expect(staffList.status).toBe(200);
    expect(staffList.body.map((c: any) => c.name)).not.toContain('Night Owl Delivery');
  });

  it('is offered next to the platform carriers when recording a shipment', async () => {
    const sellerId = newId();
    const seller = tokens.seller(sellerId);
    const made = await add(sellerId, { name: 'Harbor Runners' });
    expect(made.status).toBe(201);

    const setup = await h.call('GET', `${SELLER}/shipping-setup`, seller);
    expect(setup.status).toBe(200);
    const own = setup.body.carriers.find((c: any) => c.code === made.body.code);
    expect(own).toMatchObject({ name: 'Harbor Runners', accountLabel: 'Your own carrier', trackingMode: 'manual', trackingConnected: false });
    expect(own.services).toEqual([expect.objectContaining({ name: 'Harbor Runners', labelSupported: false })]);
    // the familiar names still come first
    expect(setup.body.carriers.length).toBeGreaterThan(1);
    expect(setup.body.carriers.at(-1).code).toBe(made.body.code);

    const list = await h.call('GET', `${SELLER}/carrier-services`, seller);
    expect(list.body.map((c: any) => c.code)).toContain(made.body.code);
    // a seller with no own carriers sees only the platform's
    expect((await h.call('GET', `${SELLER}/carrier-services`, tokens.seller(newId()))).body.map((c: any) => c.code)).not.toContain(made.body.code);
  });

  it('records a shipment with the tracking link from the template, and with no tracking at all', async () => {
    const o = await sellerOrder(h);
    const seller = tokens.seller(o.sellerId);
    const made = await add(o.sellerId, { name: 'Speedy Local Courier', trackingUrlTemplate: 'https://speedy.example/track/{n}', trackingPattern: '^SP\\d{6}$' });
    const base = { groupId: o.groupId, carrierCode: made.body.code, shippedAt: h.clock.now().toISOString() };

    const wrongFormat = await h.call('POST', `${SELLER}/shipments`, seller, { ...base, trackingNumber: '12345', items: [{ orderItemId: o.speaker.id, quantity: 1 }] });
    expect(wrongFormat.status).toBe(422);
    expect(wrongFormat.body.error.code).toBe('TRACKING_FORMAT_INVALID');
    expect(wrongFormat.body.error.message).toContain('Speedy Local Courier');

    const res = await h.call('POST', `${SELLER}/shipments`, seller, { ...base, trackingNumber: 'SP123456', items: [{ orderItemId: o.speaker.id, quantity: 1 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'shipped', carrierCode: made.body.code, carrierName: 'Speedy Local Courier', trackingNumber: 'SP123456', trackingUrl: 'https://speedy.example/track/SP123456' });

    // it carries the one service, named after itself, which would read "Speedy · Speedy": the package has none
    expect(res.body.serviceName).toBeNull();

    // the buyer tracks it by the seller's own name, with the link the seller gave
    const tracking = await h.call('GET', `${STORE}/shipments/${res.body.id}/tracking`, tokens.customer(o.customerId));
    expect(tracking.status, JSON.stringify(tracking.body)).toBe(200);
    expect(tracking.body.carrier).toMatchObject({ name: 'Speedy Local Courier', trackingNumber: 'SP123456', externalUrl: 'https://speedy.example/track/SP123456' });
    const summaries = await h.call('GET', `${STORE}/orders/${o.order.id}/shipments`, tokens.customer(o.customerId));
    expect(summaries.body[0]).toMatchObject({ carrierName: 'Speedy Local Courier' });

    // its own courier may have no tracking number, as 'other' does; that still opens a missing-tracking exception
    const noTracking = await h.call('POST', `${SELLER}/shipments`, seller, { ...base, items: [{ orderItemId: o.lamp.id, quantity: 1 }] });
    expect(noTracking.status, JSON.stringify(noTracking.body)).toBe(201);
    expect(noTracking.body).toMatchObject({ trackingState: 'missing', carrierName: 'Speedy Local Courier', trackingNumber: null, trackingUrl: null });
    expect(h.named('shipping.shipment.exception').at(-1)).toMatchObject({ kind: 'missing_tracking', shipmentId: noTracking.body.id });
  });

  it('takes any number when the seller gives no format, and refuses another seller‘s code', async () => {
    const o = await sellerOrder(h);
    const seller = tokens.seller(o.sellerId);
    const mine = await add(o.sellerId, { name: 'Our Own Van' });
    const theirs = await add(newId(), { name: 'Their Van' });

    const loose = await h.call('POST', `${SELLER}/shipments`, seller, { groupId: o.groupId, carrierCode: mine.body.code, trackingNumber: 'anything-goes-7', shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.speaker.id, quantity: 1 }] });
    expect(loose.status, JSON.stringify(loose.body)).toBe(201);
    expect(loose.body).toMatchObject({ trackingState: 'pending', trackingNumber: 'ANYTHINGGOES7', trackingUrl: null });

    const foreign = await h.call('POST', `${SELLER}/shipments`, seller, { groupId: o.groupId, carrierCode: theirs.body.code, trackingNumber: 'x1', shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.lamp.id, quantity: 1 }] });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.details.issues[0]).toMatchObject({ path: 'carrierCode' });
  });

  it('corrects the tracking number of a package sent with an own carrier, and keeps the name after it is removed', async () => {
    const o = await sellerOrder(h);
    const seller = tokens.seller(o.sellerId);
    const made = await add(o.sellerId, { name: 'Speedy Local Courier', trackingUrlTemplate: 'https://speedy.example/track/{n}' });
    const res = await h.call('POST', `${SELLER}/shipments`, seller, { groupId: o.groupId, carrierCode: made.body.code, trackingNumber: 'SP000001', shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.speaker.id, quantity: 1 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const fixed = await h.call('POST', `${SELLER}/shipments/${res.body.id}/correct-tracking`, seller, { trackingNumber: 'SP000002', reason: 'typed the wrong number' });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect(fixed.body).toMatchObject({ carrierCode: made.body.code, carrierName: 'Speedy Local Courier', trackingNumber: 'SP000002', trackingUrl: 'https://speedy.example/track/SP000002' });
    expect(fixed.body.corrections.at(-1)).toMatchObject({ from: 'Speedy Local Courier SP000001', to: 'Speedy Local Courier SP000002' });
    // and back to one of Marketly's
    const toUps = await h.call('POST', `${SELLER}/shipments/${res.body.id}/correct-tracking`, seller, { carrierCode: 'ups', trackingNumber: ups(), reason: 'went with UPS in the end' });
    expect(toUps.status, JSON.stringify(toUps.body)).toBe(200);
    expect(toUps.body).toMatchObject({ carrierCode: 'ups', carrierName: 'UPS' });

    // a package already sent keeps the name and link of a carrier the seller then removes
    const kept = await h.call('POST', `${SELLER}/shipments`, seller, { groupId: o.groupId, carrierCode: made.body.code, trackingNumber: 'SP000003', shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.lamp.id, quantity: 1 }] });
    expect(kept.status).toBe(201);
    expect((await h.call('DELETE', `${SELLER}/carriers/${made.body.id}`, seller)).status).toBe(204);
    const after = await h.call('GET', `${SELLER}/shipments/${kept.body.id}`, seller);
    expect(after.body).toMatchObject({ carrierName: 'Speedy Local Courier', trackingUrl: 'https://speedy.example/track/SP000003' });
  });
});
