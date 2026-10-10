/**
 * Fulfilled by Marketly (fulfillment-service, phase 4): the products_inventory template grants the seller's
 * service keys, and Marketly's dispatches of a seller's groups never count toward the seller's performance.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ROLE_TEMPLATES } from '../domain/catalogue.js';
import { approvedSeller, boot, SELLER, type Kit } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(async () => kit?.close());

const money = { amount: 5000, currency: 'USD' };

async function acceptedGroup(sellerId: string, fulfilledBy: 'seller' | 'marketly_service') {
  const groupId = newId();
  await kit.emit('orders', 'orders.order.accepted', {
    orderId: newId(),
    ref: 'MK-FS',
    contactEmail: 'a@example.com',
    total: money,
    groups: [{ groupId, ownerType: 'seller', sellerId, fulfilledBy, dispatchBy: kit.clock.now().toISOString(), itemIds: [newId()], total: money }],
    items: [],
    acceptedAt: kit.clock.now().toISOString(),
  });
  return groupId;
}

function dispatched(sellerId: string, groupId: string, fulfilledBy: 'seller' | 'marketly_service', o: { onTime: boolean; trackingValid: boolean }) {
  return { shipmentId: newId(), kind: 'outbound', orderId: newId(), groupId, ownerType: 'seller', sellerId, fulfilledBy, lines: [], shippedAt: kit.clock.now().toISOString(), ...o };
}

describe('products_inventory template', () => {
  it('grants fulfillment-service.inbound.manage and fees.view (listed only while fulfillment-service runs)', async () => {
    expect(ROLE_TEMPLATES.products_inventory).toEqual(expect.arrayContaining(['fulfillment-service.inbound.manage', 'fulfillment-service.fees.view']));
    expect(ROLE_TEMPLATES.products_inventory).not.toContain('fulfillment-service.enrollment.manage');
    // fulfillment-service is off in this app: the template offered to owners leaves its keys out
    const s = await approvedSeller(kit);
    const roles = await kit.call('GET', `${SELLER}/roles`, s.sellerToken);
    const pi = roles.body.roles.find((r: any) => r.key === 'products_inventory');
    expect(pi.permissions).toContain('media.assets.upload');
    expect(pi.permissions.filter((k: string) => k.startsWith('fulfillment-service.'))).toEqual([]);
  });
});

describe('performance with Fulfilled by Marketly groups', () => {
  it('a Marketly dispatch, overdue or delivery of a service group adds no dispatch or tracking fact for the seller', async () => {
    const s = await approvedSeller(kit);
    // the seller's own group: dispatched on time with valid tracking
    const own = await acceptedGroup(s.sellerId, 'seller');
    const ownShipment = dispatched(s.sellerId, own, 'seller', { onTime: true, trackingValid: true });
    await kit.emit('shipping', 'shipping.shipment.dispatched', ownShipment);
    await kit.svc.computePerformance();
    const before = (await kit.call('GET', `${SELLER}/performance`, s.sellerToken)).body;
    const metric = (body: any, key: string) => body.metrics.find((m: any) => m.key === key);
    expect(metric(before, 'dispatch_reliability')).toMatchObject({ numerator: 1, denominator: 1 });
    expect(metric(before, 'valid_tracking')).toMatchObject({ value: 100 });

    // Marketly's group of the same seller: late dispatch, invalid tracking, overdue, then delivered
    const service = await acceptedGroup(s.sellerId, 'marketly_service');
    const svcShipment = dispatched(s.sellerId, service, 'marketly_service', { onTime: false, trackingValid: false });
    await kit.emit('shipping', 'shipping.dispatch.overdue', {
      orderId: newId(), orderRef: 'MK-FS', groupId: service, ownerType: 'seller', sellerId: s.sellerId, fulfilledBy: 'marketly_service', orderItemIds: [], dueAt: kit.clock.now().toISOString(), exceptionId: newId(),
    });
    await kit.emit('shipping', 'shipping.shipment.dispatched', svcShipment);
    await kit.emit('shipping', 'shipping.shipment.delivered', {
      shipmentId: svcShipment.shipmentId, kind: 'outbound', orderId: svcShipment.orderId, groupId: service, sellerId: s.sellerId, lines: [], deliveredAt: kit.clock.now().toISOString(),
    });
    const facts = await kit.svc.core.repo.find('performance_events', { seller_id: s.sellerId });
    expect(facts.some((f) => ['dispatched', 'dispatched_late', 'tracking_valid', 'tracking_missing'].includes(f.kind) && (f.subject_id === service || f.subject_id === svcShipment.shipmentId))).toBe(false);

    await kit.svc.computePerformance();
    const after = (await kit.call('GET', `${SELLER}/performance`, s.sellerToken)).body;
    expect(metric(after, 'dispatch_reliability')).toMatchObject({ numerator: 1, denominator: 1, value: 100 });
    expect(metric(after, 'valid_tracking')).toMatchObject({ value: 100 });

    // the seller's own delivered shipment still confirms its tracking
    await kit.emit('shipping', 'shipping.shipment.delivered', {
      shipmentId: ownShipment.shipmentId, kind: 'outbound', orderId: ownShipment.orderId, groupId: own, sellerId: s.sellerId, lines: [], deliveredAt: kit.clock.now().toISOString(),
    });
    const ownFacts = await kit.svc.core.repo.find('performance_events', { seller_id: s.sellerId, subject_id: ownShipment.shipmentId });
    expect(ownFacts.map((f) => f.kind)).toEqual(['tracking_valid']);
  });

  it('confirms tracking on delivery of a seller shipment first recorded without valid tracking', async () => {
    const s = await approvedSeller(kit);
    const own = await acceptedGroup(s.sellerId, 'seller');
    const shipment = dispatched(s.sellerId, own, 'seller', { onTime: true, trackingValid: false });
    await kit.emit('shipping', 'shipping.shipment.dispatched', shipment);
    await kit.emit('shipping', 'shipping.shipment.delivered', { shipmentId: shipment.shipmentId, kind: 'outbound', orderId: shipment.orderId, groupId: own, sellerId: s.sellerId, lines: [], deliveredAt: kit.clock.now().toISOString() });
    const facts = await kit.svc.core.repo.find('performance_events', { seller_id: s.sellerId, subject_id: shipment.shipmentId });
    expect(facts.map((f) => f.kind).sort()).toEqual(['tracking_missing', 'tracking_valid']);
  });
});
