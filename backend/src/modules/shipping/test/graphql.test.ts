import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { auth } from '../../../testing/app.js';
import { harness, sellerOrder, tokens, ups, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

const gql = (area: string, token: string, query: string, variables: Record<string, unknown> = {}) =>
  h.app.inject({ method: 'POST', url: `/graphql/${area}`, headers: { ...auth(token), 'content-type': 'application/json' }, payload: { query, variables } }).then((r) => JSON.parse(r.body));

const SHIPMENT = `id kind status statusLabel steps currentStep packageLabel carrierName trackingNumber contents { orderItemId title quantity } events { code label }`;

describe('GraphQL read layer', () => {
  it('store: the customer’s own package with the tracking view; others get null', async () => {
    const o = await sellerOrder(h);
    const tn = ups();
    const s = (await h.call('POST', '/api/seller/shipping/shipments', tokens.seller(o.sellerId), { groupId: o.groupId, carrierCode: 'ups', trackingNumber: tn, shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.lamp.id, quantity: 1 }] })).body;
    const q = `query($id: UUID!) { shipment(id: $id) { ${SHIPMENT} headline estimateNote helpNote notices { id } estimateLabel } }`;
    const mine = await gql('store', tokens.customer(o.customerId), q, { id: s.id });
    expect(mine.errors).toBeUndefined();
    expect(mine.data.shipment).toMatchObject({ id: s.id, kind: 'OUTBOUND', status: 'SHIPPED', statusLabel: 'Shipped, tracking pending', currentStep: 0, headline: 'Estimated delivery', carrierName: 'UPS', trackingNumber: tn });
    expect(mine.data.shipment.estimateNote).toContain('Portland, OR 97205');
    expect((await gql('store', tokens.customer(newId()), q, { id: s.id })).data.shipment).toBeNull();

    const seller = await gql('seller', tokens.seller(o.sellerId), `query($id: UUID!) { shipment(id: $id) { id trackingState dispatchedOnTime corrections { from } openExceptions { id } recordedBy { kind } } }`, { id: s.id });
    expect(seller.errors).toBeUndefined();
    expect(seller.data.shipment).toMatchObject({ trackingState: 'PENDING', dispatchedOnTime: true, recordedBy: { kind: 'SELLER' } });
    expect((await gql('seller', tokens.seller(newId()), `query($id: UUID!) { shipment(id: $id) { id } }`, { id: s.id })).data.shipment).toBeNull();
    const admin = await gql('admin', tokens.staff(), `query($id: UUID!) { shipmentAdmin(id: $id) { id label { id } events { source } } }`, { id: s.id });
    expect(admin.errors).toBeUndefined();
    expect(admin.data.shipmentAdmin.id).toBe(s.id);
  });

  it('admin: exceptions with filters and counts; seller: the setup form', async () => {
    const o = await sellerOrder(h);
    await h.call('POST', '/api/admin/shipping/exceptions', tokens.staff(), { kind: 'missing_tracking', groupId: o.groupId, situation: 'No tracking yet' });
    const res = await gql('admin', tokens.staff(), `{ deliveryExceptions(filter: { kind: MISSING_TRACKING, sellerType: MARKETPLACE }) { items { id kind status deadline { state } sellerName history { label } openedBy { kind } } total } deliveryExceptionCounts { missingTracking customerNotNotified } }`);
    expect(res.errors).toBeUndefined();
    expect(res.data.deliveryExceptions.items[0]).toMatchObject({ kind: 'MISSING_TRACKING', status: 'OPEN', deadline: { state: 'ON_TIME' }, openedBy: { kind: 'STAFF' } });
    expect(res.data.deliveryExceptionCounts.missingTracking).toBeGreaterThanOrEqual(1);
    const setup = await gql('seller', tokens.seller(o.sellerId), `{ myShippingSetup { carriers { code services { name transitMinDays labelSupported trackingPattern } } labelPurchaseAvailable labelUnavailableReason dispatchLabel } }`);
    expect(setup.errors).toBeUndefined();
    expect(setup.data.myShippingSetup).toMatchObject({ labelPurchaseAvailable: false, labelUnavailableReason: 'Turn on Buy labels in Shipping settings' });
    expect(setup.data.myShippingSetup.carriers.map((c: any) => c.code)).toEqual(expect.arrayContaining(['ups', 'usps']));
  });
});
