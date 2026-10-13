/**
 * Fulfilled by Marketly (fulfillment-service, phase 4): the warehouse picks and packs a seller's group Marketly
 * fulfils from seller-owned stock at the service location. fulfillment-service.getServiceLocation is stubbed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import type * as returns from '../../../spec/returns.js';
import { spec } from '../../../spec/warehouse.js';
import { schemas } from '../schema.js';
import { harness, RENO, USD, type Harness, type ServiceSeller, type StockRec } from './helpers.js';

let h: Harness;
let box: { id: string };
const seller: ServiceSeller = { sellerId: newId(), name: 'Pixel & Port' };
const zero = USD(0);

beforeAll(async () => {
  h = await harness({ fulfillmentService: true });
  await h.bins(['S-01-1', 'S-01-2', 'S-02-1']);
  await h.bins(['S-QA-1'], 'quarantine');
  h.serviceLocation = { locationId: h.locationId, address: RENO, shipsFrom: 'Reno, NV (Marketly warehouse)' };
  box = { id: newId() };
  const r = await h.call('PUT', '/box-types', { boxTypes: [{ id: box.id, name: 'M box', kind: 'box', dimensions: { length: 12, width: 10, height: 6, unit: 'in' }, maxWeight: { value: 20, unit: 'lb' }, active: true }] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
});
afterAll(async () => {
  await h?.app.close();
});

const table = (name: string) => h.app.kernel.mongo.module('warehouse', spec.collections, schemas).table<any>(name);

async function stocked(sku: string, label: string, code = 'S-01-1'): Promise<StockRec> {
  const item = h.item(sku, label);
  const bin = (await h.call('GET', `/bins?q=${code}&locationId=${h.locationId}`)).body.items[0];
  expect((await h.call('PUT', `/stock-items/${item.id}/bins`, { bins: [{ binId: bin.id, primary: true }] })).status).toBe(200);
  return item;
}

const cancelled = (o: { orderId: string; ref: string; groupId: string }, itemId: string, stockItemId: string, quantity: number) =>
  h.publish('orders', 'orders.item.cancelled', {
    orderId: o.orderId,
    ref: o.ref,
    groupId: o.groupId,
    ownerType: 'seller',
    sellerId: seller.sellerId,
    fulfilledBy: 'marketly_service',
    itemId,
    offerId: newId(),
    stockItemId,
    quantity,
    cancellationId: newId(),
    initiatedBy: 'customer',
    reasonCode: 'changed_mind',
    beforeDispatch: true,
    countsAgainstSeller: false,
    refund: { itemAmount: zero, discountShare: zero, shippingRefund: zero, taxRefund: zero, total: zero },
    paymentIntentId: newId(),
    notifyCustomer: true,
  });

describe('Fulfilled by Marketly orders', () => {
  it('an accepted service group gets a fulfilment at the service location with the seller; seller-shipped groups get none', async () => {
    const item = await stocked('FBM-MUG', 'Mug, Blue');
    const before = h.events.length;
    const o = await h.order([{ item, quantity: 2 }], { service: seller, sellerGroup: true });
    expect(o.fulfillment).toMatchObject({ fulfilledBy: 'marketly_service', sellerId: seller.sellerId, sellerName: 'Pixel & Port', locationId: h.locationId, status: 'awaiting_pick', totalPackagesInOrder: 2 });
    expect(o.fulfillment.lines).toEqual([expect.objectContaining({ stockItemId: item.id, sku: 'FBM-MUG', quantity: 2, binCode: 'S-01-1' })]);
    // only the service group: the other group's seller ships it
    expect((await h.service.getTasksForOrderGroups([o.groupId]))[o.groupId]).toMatchObject({ id: o.fulfillment.id });
    expect(await table('fulfillments').find({ order_id: o.orderId })).toHaveLength(1);
    expect(h.events.slice(before).filter((e) => e.name === 'warehouse.fulfillment.created').map((e) => e.payload)).toEqual([
      { fulfillmentId: o.fulfillment.id, orderId: o.orderId, sellerGroupId: o.groupId, fulfilledBy: 'marketly_service', sellerId: seller.sellerId, shipBy: o.fulfillment.shipBy },
    ]);
  });

  it('lists can show Official Store or Fulfilled by Marketly orders only', async () => {
    const official = await h.order([{ item: await stocked('FBM-OFF', 'Kettle, Steel'), quantity: 1 }]);
    const service = await h.order([{ item: await stocked('FBM-LIST', 'Bowl, Green'), quantity: 1 }], { service: seller });
    const ids = async (q: string) => (await h.call('GET', `/fulfillments${q}`)).body.items.map((r: any) => r.id);
    expect(await ids('?fulfilledBy=marketly_service')).toContain(service.fulfillment.id);
    expect(await ids('?fulfilledBy=marketly_service')).not.toContain(official.fulfillment.id);
    expect(await ids('?fulfilledBy=official_warehouse')).toContain(official.fulfillment.id);
    expect(await ids('?fulfilledBy=official_warehouse')).not.toContain(service.fulfillment.id);
    const all = (await h.call('GET', '/fulfillments')).body.items;
    expect(all.find((r: any) => r.id === service.fulfillment.id)).toMatchObject({ fulfilledBy: 'marketly_service', sellerName: 'Pixel & Port' });
    expect(all.find((r: any) => r.id === official.fulfillment.id)).toMatchObject({ fulfilledBy: 'official_warehouse', sellerName: null });
    expect((await h.call('GET', '/fulfillments?fulfilledBy=seller')).status).toBe(400);
  });

  it('without a service location the fulfilment is at the default location', async () => {
    const saved = h.serviceLocation;
    h.serviceLocation = null;
    try {
      const o = await h.order([{ item: await stocked('FBM-DEF', 'Cup, Red'), quantity: 1 }], { service: seller });
      expect(o.fulfillment).toMatchObject({ fulfilledBy: 'marketly_service', locationId: h.locationId });
      // labels then leave from that location's address (inventory)
      expect(await h.service.core.labelOrigin({ fulfilled_by: 'marketly_service', location_id: h.locationId })).toEqual(RENO);
      expect(await h.service.core.labelOrigin({ fulfilled_by: 'official_warehouse', location_id: h.locationId })).toBeNull();
    } finally {
      h.serviceLocation = saved;
    }
  });

  it('pick, pack and label: from the warehouse address, billed to the seller; the slip and the packed event name the seller', async () => {
    const item = await stocked('FBM-LAMP', 'Lamp, Brass', 'S-01-2');
    const o = await h.picking([{ item, quantity: 1 }], { service: seller });
    expect(h.named('warehouse.fulfillment.status_changed').at(-1)).toMatchObject({ fulfillmentId: o.fulfillment.id, fulfilledBy: 'marketly_service', sellerId: seller.sellerId, to: 'picking' });
    await h.pickAll(o.fulfillment.id);
    const pkg = (await h.call('POST', `/fulfillments/${o.fulfillment.id}/packages`, {})).body;
    expect((await h.call('POST', `/packages/${pkg.id}/scan`, { code: 'FBM-LAMP', serialNumber: 'SN-77' })).status).toBe(200);
    expect((await h.call('PATCH', `/packages/${pkg.id}`, { boxTypeId: box.id, weight: { value: 2, unit: 'lb' } })).status).toBe(200);
    expect((await h.call('GET', `/packages/${pkg.id}/service-options`)).status).toBe(200);
    expect(h.quotes.at(-1)).toMatchObject({ groupId: o.groupId, from: RENO });
    const label = await h.call('POST', `/packages/${pkg.id}/label`, {}, { headers: { 'idempotency-key': newId() } });
    expect(label.status, JSON.stringify(label.body)).toBe(200);
    expect(h.labels.at(-1)!.input).toMatchObject({ groupId: o.groupId, kind: 'outbound', from: RENO, billedTo: 'seller' });

    expect((await h.call('GET', `/packages/${pkg.id}/packing-slip`)).status).toBe(200);
    const slip = h.files.at(-1)!.text;
    expect(slip).toContain('Sold by Pixel & Port - Fulfilled by Marketly');
    expect(slip).toContain('Fulfilled by Marketly items: Marketly handles the return');
    expect(slip).not.toContain('Official Store items');

    expect((await h.call('POST', `/packages/${pkg.id}/pack`)).status).toBe(200);
    expect(h.named('warehouse.package.packed').at(-1)).toMatchObject({ packageId: pkg.id, sellerGroupId: o.groupId, ownerType: 'seller', sellerId: seller.sellerId, fulfilledBy: 'marketly_service', items: [expect.objectContaining({ serialNumbers: ['SN-77'] })] });
    expect(await h.service.getShippedSerials([o.itemIds[0]!])).toEqual({ [o.itemIds[0]!]: ['SN-77'] });

    // shipping reports the hand-over of the seller-owned shipment
    const shipmentId = h.labels.at(-1)!.shipmentId;
    await h.publish('shipping', 'shipping.shipment.dispatched', { shipmentId, kind: 'outbound', orderId: o.orderId, groupId: o.groupId, returnId: null, ownerType: 'seller', sellerId: seller.sellerId, fulfilledBy: 'marketly_service', lines: [{ orderItemId: o.itemIds[0], title: 'Lamp', variantLabel: 'Brass', quantity: 1 }], shippedAt: h.clock.now().toISOString(), dispatchDueAt: null, onTime: true, trackingValid: true, estimatedArrival: null });
    expect((await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body).toMatchObject({ status: 'dispatched', packages: [expect.objectContaining({ status: 'dispatched' })] });
    expect(h.named('warehouse.fulfillment.status_changed').at(-1)).toMatchObject({ fulfillmentId: o.fulfillment.id, fulfilledBy: 'marketly_service', sellerId: seller.sellerId, to: 'dispatched' });
  });

  it('an Official Store label keeps shipping defaults (no origin, no billing override)', async () => {
    const o = await h.picking([{ item: await stocked('FBM-OFF2', 'Vase, Glass', 'S-02-1'), quantity: 1 }]);
    await h.pickAll(o.fulfillment.id);
    const pkg = (await h.call('POST', `/fulfillments/${o.fulfillment.id}/packages`, {})).body;
    await h.call('POST', `/packages/${pkg.id}/scan`, { code: 'FBM-OFF2' });
    await h.call('PATCH', `/packages/${pkg.id}`, { boxTypeId: box.id, weight: { value: 1, unit: 'lb' } });
    expect((await h.call('POST', `/packages/${pkg.id}/label`, {}, { headers: { 'idempotency-key': newId() } })).status).toBe(200);
    const input = h.labels.at(-1)!.input;
    expect(input.from).toBeUndefined();
    expect(input.billedTo).toBeUndefined();
    await h.call('POST', `/packages/${pkg.id}/pack`);
    expect(h.named('warehouse.package.packed').at(-1)).toMatchObject({ ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse' });
  });

  it('cancelling a service item cancels its line; a dispatch overdue flags the fulfilment', async () => {
    const a = await stocked('FBM-CXL-A', 'Plate, White');
    const b = await stocked('FBM-CXL-B', 'Fork, Steel', 'S-01-2');
    const o = await h.order([{ item: a, quantity: 2 }, { item: b, quantity: 1 }], { service: seller, dispatchInHours: 72 });
    await cancelled(o, o.itemIds[0]!, a.id, 2);
    const f = (await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body;
    expect(f.lines.find((l: any) => l.sku === 'FBM-CXL-A')).toMatchObject({ state: 'cancelled' });
    expect(f.status).toBe('awaiting_pick');

    const dueAt = new Date(h.clock.now().getTime() - 3_600_000).toISOString();
    await h.publish('shipping', 'shipping.dispatch.overdue', { orderId: o.orderId, orderRef: o.ref, groupId: o.groupId, ownerType: 'seller', sellerId: seller.sellerId, fulfilledBy: 'marketly_service', orderItemIds: o.itemIds, dueAt, exceptionId: newId() });
    expect((await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body).toMatchObject({ dispatchOverdueAt: expect.any(String), shipBy: dueAt });

    await cancelled(o, o.itemIds[1]!, b.id, 1);
    expect((await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body.status).toBe('cancelled');
    expect(h.named('warehouse.fulfillment.status_changed').at(-1)).toMatchObject({ fulfillmentId: o.fulfillment.id, fulfilledBy: 'marketly_service', sellerId: seller.sellerId, to: 'cancelled' });
  });
});

describe('Fulfilled by Marketly put-away (fulfillment-service.inbound.received)', () => {
  it('creates put-away tasks per receiving record: sellable to the suggested bin, damaged to quarantine; once per receiptId', async () => {
    const a = await stocked('FBM-IN-A', 'Towel, Grey', 'S-02-1');
    const b = h.item('FBM-IN-B', 'Towel, White');
    const receiptId = newId();
    const event = {
      inboundId: newId(),
      ref: 'IB-261011-0001',
      receiptId,
      sellerId: seller.sellerId,
      locationId: h.locationId,
      received: 13,
      damaged: 1,
      complete: true,
      lines: [
        { skuEnrollmentId: newId(), stockItemId: a.id, sku: 'FBM-IN-A', label: 'Towel, Grey', received: 10, damaged: 1 },
        { skuEnrollmentId: newId(), stockItemId: b.id, sku: 'FBM-IN-B', label: 'Towel, White', received: 3, damaged: 0 },
      ],
    };
    await h.publish('fulfillment-service', 'fulfillment-service.inbound.received', event);
    await h.publish('fulfillment-service', 'fulfillment-service.inbound.received', event);
    const tasks = (await h.call('GET', `/putaway-tasks?receiptId=${receiptId}`)).body.items;
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t: any) => t.receiptRef === 'IB-261011-0001' && t.receiptId === receiptId && t.status === 'open')).toBe(true);
    expect(tasks.find((t: any) => t.stockItemId === a.id && t.quantity === 9)).toMatchObject({ suggestedBinCode: 'S-02-1', sku: 'FBM-IN-A' });
    expect(tasks.find((t: any) => t.stockItemId === a.id && t.quantity === 1)).toMatchObject({ suggestedBinCode: 'S-QA-1' });
    expect(tasks.find((t: any) => t.stockItemId === b.id)).toMatchObject({ quantity: 3 });
    const rows = await table('putaway_tasks').find({ receipt_id: receiptId });
    expect(rows.every((r: any) => r.location_id === h.locationId)).toBe(true);
    const sellable = tasks.find((t: any) => t.stockItemId === a.id && t.quantity === 9);
    expect((await h.call('POST', `/putaway-tasks/${sellable.id}/complete`, { binCode: 'S-02-1', quantity: 9 })).body).toMatchObject({ status: 'done', binCode: 'S-02-1' });
  });
});

describe('Fulfilled by Marketly return parcels', () => {
  const approved = (returnId: string, ref: string, fulfilledBy: 'marketly_service' | 'seller') => ({
    returnId,
    ref,
    orderId: newId(),
    orderRef: 'MK-261011-20001',
    customerId: newId(),
    ownerType: 'seller' as const,
    sellerId: seller.sellerId,
    fulfilledBy,
    items: [{ orderItemId: newId(), quantity: 1 }],
    withoutReturn: false,
    platformDecision: true,
    dropOffBy: null,
    trackingNumber: `94001${ref.replace(/\D/g, '')}`,
  });
  const detail = (id: string, ref: string, fulfilledBy: 'marketly_service' | 'seller') =>
    ({
      id,
      ref,
      orderId: newId(),
      orderRef: 'MK-261011-20001',
      seller: { ownerType: 'seller', id: seller.sellerId, name: seller.name },
      status: 'in_transit',
      items: [{ orderItemId: newId(), productId: newId(), variantId: newId(), title: 'Mug', options: { Color: 'Blue' }, quantity: 1, unitPrice: USD(1500) }],
      shipment: { trackingNumber: null },
      fulfilledBy,
    }) as unknown as returns.ReturnDetail;

  it('expects a Fulfilled by Marketly return and receives it; a seller-shipped return is not expected', async () => {
    const returnId = newId();
    h.returns.set(returnId, detail(returnId, 'RT-261011-0501', 'marketly_service'));
    await h.publish('returns', 'returns.return.approved', approved(returnId, 'RT-261011-0501', 'marketly_service'));
    await h.publish('returns', 'returns.return.approved', approved(newId(), 'RT-261011-0502', 'seller'));
    const expected = (await h.call('GET', '/return-parcels?q=RT-261011-05')).body.items;
    expect(expected).toEqual([expect.objectContaining({ returnId, returnRef: 'RT-261011-0501', status: 'expected', unexpected: false, expectedItems: ['Mug, Blue × 1'] })]);
    const r = await h.call('POST', '/return-parcels', { code: 'RT-261011-0501', parcelCondition: 'intact' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ id: expected[0].id, returnId, status: 'received', unexpected: false });
    expect(h.receipts.at(-1)).toMatchObject({ returnId });
  });

  it('a Fulfilled by Marketly return that arrives before it was expected is still received for its return', async () => {
    const returnId = newId();
    h.returns.set(returnId, detail(returnId, 'RT-261011-0601', 'marketly_service'));
    const r = await h.call('POST', '/return-parcels', { code: 'RT-261011-0601', parcelCondition: 'intact' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ returnId, unexpected: false });
    // a seller-shipped return arriving here is unexpected
    const other = newId();
    h.returns.set(other, detail(other, 'RT-261011-0602', 'seller'));
    const u = await h.call('POST', '/return-parcels', { code: 'RT-261011-0602', parcelCondition: 'intact' });
    expect(u.body).toMatchObject({ returnId: null, unexpected: true });
  });
});

describe('fulfillments.fulfilled_by', () => {
  it('says who fulfils each fulfilment (seller of record for marketly_service); the collection refuses anything else', async () => {
    const o = await h.order([{ item: h.item('FBM-MIG', 'Spoon, Steel'), quantity: 1 }]);
    const s = await h.order([{ item: h.item('FBM-MIG-S', 'Knife, Steel'), quantity: 1 }], { service: seller });
    expect(await table('fulfillments').get(o.fulfillment.id)).toMatchObject({ fulfilled_by: 'official_warehouse', seller_id: null, seller_name: null });
    expect(await table('fulfillments').get(s.fulfillment.id)).toMatchObject({ fulfilled_by: 'marketly_service', seller_id: seller.sellerId });
    // fresh rows must say who fulfils them
    const fulfillments = h.app.kernel.mongo.db.collection('warehouse.fulfillments');
    await expect(fulfillments.updateOne({ _id: o.fulfillment.id }, { $set: { fulfilled_by: 'seller' } })).rejects.toThrow();
    const now = new Date();
    await expect(fulfillments.insertOne({ _id: newId(), order_id: newId(), order_ref: 'MK-1', seller_group_id: newId(), location_id: h.locationId, status: 'awaiting_pick', ship_by: now, delivery_choice: 'Standard', ship_to: {}, discrepancy_ids: [], total_packages_in_order: 1, created_at: now, updated_at: now } as never)).rejects.toThrow();
    expect((await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body).toMatchObject({ fulfilledBy: 'official_warehouse', sellerId: null, sellerName: null });
  });
});
