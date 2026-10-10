import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { harness, type Harness, type StockRec } from './helpers.js';

let h: Harness;
let box: { id: string };
let mailer: { id: string };
beforeAll(async () => {
  h = await harness();
  await h.bins(['C-01-1', 'C-01-2']);
  box = { id: newId() };
  mailer = { id: newId() };
  const r = await h.call('PUT', '/box-types', {
    boxTypes: [
      { id: box.id, name: 'M box', kind: 'box', dimensions: { length: 12, width: 10, height: 6, unit: 'in' }, maxWeight: { value: 20, unit: 'lb' }, active: true },
      { id: mailer.id, name: 'Poly mailer', kind: 'mailer', dimensions: { length: 10, width: 13, height: 1, unit: 'in' }, active: true },
    ],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
});
afterAll(async () => {
  await h?.app.close();
});

async function stocked(sku: string, label: string, code = 'C-01-1'): Promise<StockRec> {
  const item = h.item(sku, label);
  const bin = (await h.call('GET', `/bins?q=${code}&locationId=${h.locationId}`)).body.items[0];
  expect((await h.call('PUT', `/stock-items/${item.id}/bins`, { bins: [{ binId: bin.id, primary: true }] })).status).toBe(200);
  return item;
}

async function picked(lines: { item: StockRec; quantity: number }[], o: { sellerGroup?: boolean } = {}) {
  const order = await h.picking(lines, o);
  await h.pickAll(order.fulfillment.id);
  return order;
}

const idem = () => ({ 'idempotency-key': newId() });

describe('packing station', () => {
  it('opens a package with the picked items, scans each unit (serials kept), sets box and weight', async () => {
    const a = await stocked('PK-PHONE', 'Phone, Graphite');
    const o = await picked([{ item: a, quantity: 2 }], { sellerGroup: true });
    const pkg = await h.call('POST', `/fulfillments/${o.fulfillment.id}/packages`, { station: 'Pack 1' });
    expect(pkg.status, JSON.stringify(pkg.body)).toBe(201);
    expect(pkg.body).toMatchObject({ fulfillmentId: o.fulfillment.id, orderRef: o.ref, index: 1, of: 2, status: 'open', allScanned: false, suggestedBoxTypeId: box.id, fragile: false });
    expect(pkg.body.items).toEqual([expect.objectContaining({ orderItemId: o.itemIds[0], sku: 'PK-PHONE', quantity: 2, scanned: 0, serialNumbers: [] })]);
    expect(h.named('warehouse.fulfillment.status_changed').at(-1)).toMatchObject({ from: 'picked', to: 'packing' });
    // everything picked is in the box: a second package has nothing to take
    expect((await h.call('POST', `/fulfillments/${o.fulfillment.id}/packages`, {})).status).toBe(400);
    const wrong = await h.call('POST', `/packages/${pkg.body.id}/scan`, { code: 'NOT-HERE' });
    expect(wrong.body.error).toMatchObject({ code: 'SCAN_MISMATCH', message: 'Not in this package' });
    expect((await h.call('POST', `/packages/${pkg.body.id}/scan`, { code: 'PK-PHONE', serialNumber: 'SN-1' })).status).toBe(200);
    expect((await h.call('POST', `/packages/${pkg.body.id}/scan`, { code: 'PK-PHONE', serialNumber: 'SN-1' })).body.error.code).toBe('SCAN_MISMATCH');
    const full = await h.call('POST', `/packages/${pkg.body.id}/scan`, { code: 'pk-phone', serialNumber: 'SN-2' });
    expect(full.body).toMatchObject({ allScanned: true, items: [expect.objectContaining({ scanned: 2, serialNumbers: ['SN-1', 'SN-2'] })] });
    expect((await h.call('POST', `/packages/${pkg.body.id}/scan`, { code: 'PK-PHONE' })).body.error.message).toMatch(/already scanned/);
    // no label without a box and a weight
    const early = await h.call('POST', `/packages/${pkg.body.id}/label`, {}, { headers: idem() });
    expect(early.body.error).toMatchObject({ code: 'PACKAGE_INCOMPLETE', details: { missing: ['box', 'weight'] } });
    expect((await h.call('POST', `/packages/${pkg.body.id}/pack`)).body.error.code).toBe('PACKAGE_INCOMPLETE');
    expect((await h.call('PATCH', `/packages/${pkg.body.id}`, { weight: { value: 0, unit: 'lb' } })).status).toBe(400);
    const set = await h.call('PATCH', `/packages/${pkg.body.id}`, { boxTypeId: box.id, weight: { value: 2.4, unit: 'lb', fromScale: true }, fragile: true, handlingNote: 'Glass screen' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ boxTypeId: box.id, dimensions: { length: 12, width: 10, height: 6, unit: 'in' }, weight: { value: 2.4, unit: 'lb', fromScale: true }, fragile: true, handlingNote: 'Glass screen' });
    expect(await h.service.getShippedSerials([o.itemIds[0]!])).toEqual({ [o.itemIds[0]!]: ['SN-1', 'SN-2'] });
  });

  it('lists carrier services with the customer choice first; slower ones break the promise', async () => {
    const a = await stocked('PK-CABLE', 'Cable, USB-C');
    const o = await picked([{ item: a, quantity: 1 }]);
    const pkg = (await h.call('POST', `/fulfillments/${o.fulfillment.id}/packages`, {})).body;
    const unpriced = await h.call('GET', `/packages/${pkg.id}/service-options`);
    expect(unpriced.status, JSON.stringify(unpriced.body)).toBe(200);
    expect(unpriced.body[0]).toMatchObject({ service: 'UPS Ground', carrier: 'UPS', matchesCustomerChoice: true, keepsPromise: true, selected: true, rate: null, arrivalLabel: expect.stringMatching(/^Arrives \w{3}, \w{3} \d+$/) });
    const slow = unpriced.body.find((x: any) => x.service === 'USPS Ground Advantage');
    expect(slow).toMatchObject({ keepsPromise: false, selected: false });
    const refused = await h.call('PATCH', `/packages/${pkg.id}`, { serviceCode: slow.serviceCode });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('SERVICE_BREAKS_PROMISE');
    await h.call('POST', `/packages/${pkg.id}/scan`, { code: 'PK-CABLE' });
    const fast = unpriced.body.find((x: any) => x.service === 'UPS Next Day Air');
    const chosen = await h.call('PATCH', `/packages/${pkg.id}`, { boxTypeId: mailer.id, weight: { value: 0.3, unit: 'kg' }, serviceCode: fast.serviceCode });
    expect(chosen.body).toMatchObject({ carrier: 'UPS', service: 'UPS Next Day Air' });
    const priced = await h.call('GET', `/packages/${pkg.id}/service-options`);
    expect(priced.body.find((x: any) => x.selected)).toMatchObject({ service: 'UPS Next Day Air', rate: { amount: expect.any(Number), currency: 'USD' } });
    const label = await h.call('POST', `/packages/${pkg.id}/label`, { format: 'pdf' }, { headers: idem() });
    expect(label.status, JSON.stringify(label.body)).toBe(200);
    expect(label.body).toMatchObject({ carrier: 'UPS', service: 'UPS Next Day Air', format: 'pdf', package: { status: 'labelled', service: 'UPS Next Day Air' } });
    expect(h.labels.at(-1)!.input).toMatchObject({ groupId: o.groupId, kind: 'outbound', keepPromise: true, carrierServiceId: fast.serviceCode, items: [{ orderItemId: o.itemIds[0], quantity: 1 }], parcel: { weightGrams: 300, lengthCm: 25.4, widthCm: 33, heightCm: 2.5 } });
  });

  it('buys the label once per key, reprints, voids before packing and refuses changes while labelled', async () => {
    const a = await stocked('PK-LAMP', 'Lamp, Linen');
    const o = await picked([{ item: a, quantity: 1 }]);
    const pkg = (await h.call('POST', `/fulfillments/${o.fulfillment.id}/packages`, {})).body;
    await h.call('POST', `/packages/${pkg.id}/scan`, { code: 'PK-LAMP' });
    await h.call('PATCH', `/packages/${pkg.id}`, { boxTypeId: box.id, weight: { value: 3, unit: 'lb' } });
    expect((await h.call('GET', `/packages/${pkg.id}/label`)).body.error.code).toBe('LABEL_REQUIRED');
    expect((await h.call('POST', `/packages/${pkg.id}/pack`)).body.error.code).toBe('LABEL_REQUIRED');
    // the carrier refuses: 502, nothing changes, retry with the same key
    h.knobs.labelFails = true;
    const key = idem();
    const failed = await h.call('POST', `/packages/${pkg.id}/label`, {}, { headers: key });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toMatchObject({ code: 'LABEL_FAILED', details: { carrierMessage: 'Address not found' } });
    h.knobs.labelFails = false;
    const bought = await h.call('POST', `/packages/${pkg.id}/label`, {}, { headers: key });
    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
    expect(bought.body).toMatchObject({ carrier: 'UPS', service: 'UPS Ground', trackingNumber: expect.stringMatching(/^1Z/), labelUrl: expect.stringMatching(/^https:/), package: { status: 'labelled', trackingNumber: bought.body.trackingNumber, labelUrl: bought.body.labelUrl } });
    const count = h.labels.length;
    expect((await h.call('PATCH', `/packages/${pkg.id}`, { fragile: true })).status).toBe(409);
    expect((await h.call('POST', `/packages/${pkg.id}/scan`, { code: 'PK-LAMP' })).status).toBe(409);
    const reprint = await h.call('GET', `/packages/${pkg.id}/label`);
    expect(reprint.body).toMatchObject({ url: bought.body.labelUrl, fileName: `label-${o.ref}-${bought.body.trackingNumber}.pdf` });
    expect((await h.call('POST', `/packages/${pkg.id}/void-label`, { reason: ' ' })).status).toBe(400);
    const voided = await h.call('POST', `/packages/${pkg.id}/void-label`, { reason: 'Wrong service' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body).toMatchObject({ status: 'open', trackingNumber: null, shipmentId: null, labelUrl: null });
    expect(h.labels.at(-1)!.voided).toBe(true);
    expect(h.audits.at(-1)).toMatchObject({ action: 'warehouse.package.void_label', reason: 'Wrong service', target: { type: 'order', id: o.orderId, ref: o.ref } });
    expect((await h.call('POST', `/packages/${pkg.id}/void-label`, { reason: 'Again' })).body.error.code).toBe('ILLEGAL_TRANSITION');
    const again = await h.call('POST', `/packages/${pkg.id}/label`, {}, { headers: idem() });
    expect(again.status).toBe(200);
    expect(h.labels.length).toBe(count + 1);
  });

  it('refuses a label when no service keeps the promise', async () => {
    const a = await stocked('PK-RUG', 'Rug, Jute');
    const o = await picked([{ item: a, quantity: 1 }]);
    const pkg = (await h.call('POST', `/fulfillments/${o.fulfillment.id}/packages`, {})).body;
    await h.call('POST', `/packages/${pkg.id}/scan`, { code: 'PK-RUG' });
    await h.call('PATCH', `/packages/${pkg.id}`, { boxTypeId: box.id, weight: { value: 8, unit: 'lb' } });
    h.knobs.slowServicesOnly = true;
    const r = await h.call('POST', `/packages/${pkg.id}/label`, {}, { headers: idem() });
    h.knobs.slowServicesOnly = false;
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SERVICE_BREAKS_PROMISE');
  });

  it('prints a packing slip with only this group, package n of N and the returns note', async () => {
    const a = await stocked('PK-MUG', 'Mug, Teal');
    const o = await picked([{ item: a, quantity: 2 }], { sellerGroup: true });
    const pkg = (await h.call('POST', `/fulfillments/${o.fulfillment.id}/packages`, {})).body;
    const slip = await h.call('GET', `/packages/${pkg.id}/packing-slip`);
    expect(slip.status, JSON.stringify(slip.body)).toBe(200);
    expect(slip.body).toMatchObject({ url: expect.stringMatching(/^https:/), fileName: `packing-slip-${o.ref}-1.pdf` });
    const pdf = h.files.at(-1)!;
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.text).toContain(`Order ${o.ref} - Package 1 of 2`);
    expect(pdf.text).toContain('2 x Mug, Teal  \\(PK-MUG\\)');
    expect(pdf.text).toContain('1 other package from other sellers');
    expect(pdf.text).toContain('Gift note: Happy birthday!');
    expect(pdf.text).toContain('Returns: start a return');
    expect(pdf.text).not.toContain('$23.00');
  });

  it('packs, hands the package to shipping and is dispatched with the carrier scan', async () => {
    const a = await stocked('PK-BOOK', 'Book, Hardcover');
    const o = await picked([{ item: a, quantity: 1 }]);
    const pkg = (await h.call('POST', `/fulfillments/${o.fulfillment.id}/packages`, {})).body;
    await h.call('POST', `/packages/${pkg.id}/scan`, { code: 'PK-BOOK', serialNumber: 'ISBN-1' });
    await h.call('PATCH', `/packages/${pkg.id}`, { boxTypeId: box.id, weight: { value: 1.2, unit: 'lb' } });
    const label = (await h.call('POST', `/packages/${pkg.id}/label`, {}, { headers: idem() })).body;
    const packed = await h.call('POST', `/packages/${pkg.id}/pack`);
    expect(packed.status, JSON.stringify(packed.body)).toBe(200);
    expect(packed.body).toMatchObject({ status: 'packed', packedBy: expect.objectContaining({ kind: 'staff' }), packedAt: expect.any(String) });
    expect(h.named('warehouse.package.packed').at(-1)).toEqual({
      packageId: pkg.id,
      fulfillmentId: o.fulfillment.id,
      orderId: o.orderId,
      sellerGroupId: o.groupId,
      ownerType: 'official',
      sellerId: null,
      fulfilledBy: 'official_warehouse',
      items: [{ orderItemId: o.itemIds[0], stockItemId: a.id, sku: 'PK-BOOK', label: 'Book, Hardcover', image: null, quantity: 1, scanned: 1, serialNumbers: ['ISBN-1'] }],
      carrier: 'UPS',
      service: 'UPS Ground',
      trackingNumber: label.trackingNumber,
      weight: { value: 1.2, unit: 'lb' },
      dimensions: { length: 12, width: 10, height: 6, unit: 'in' },
    });
    expect(h.named('warehouse.fulfillment.status_changed').at(-1)).toMatchObject({ fulfillmentId: o.fulfillment.id, from: 'packing', to: 'packed' });
    expect(h.resolved).toContain(`pick_pack:${o.fulfillment.id}`);
    expect((await h.call('GET', `/waves/${o.waveId}`)).body).toMatchObject({ status: 'completed', packedOrderCount: 1 });
    expect((await h.call('POST', `/packages/${pkg.id}/pack`)).body.error.code).toBe('ILLEGAL_TRANSITION');
    const shipmentId = h.labels.at(-1)!.shipmentId;
    const dispatched = { shipmentId, kind: 'outbound', orderId: o.orderId, groupId: o.groupId, returnId: null, ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', lines: [{ orderItemId: o.itemIds[0], title: 'Book', variantLabel: 'Hardcover', quantity: 1 }], shippedAt: h.clock.now().toISOString(), dispatchDueAt: null, onTime: true, trackingValid: true, estimatedArrival: null };
    await h.publish('shipping', 'shipping.shipment.dispatched', dispatched);
    await h.publish('shipping', 'shipping.shipment.dispatched', dispatched);
    const f = (await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body;
    expect(f).toMatchObject({ status: 'dispatched', packages: [expect.objectContaining({ status: 'dispatched' })] });
    expect(h.named('warehouse.fulfillment.status_changed').filter((e) => e.fulfillmentId === o.fulfillment.id && e.to === 'dispatched')).toHaveLength(1);
    expect((await h.call('GET', `/fulfillments?status=dispatched`)).body.items.map((r: any) => r.id)).toContain(o.fulfillment.id);
    expect((await h.service.getTodaySummary()).dispatchedToday).toBeGreaterThanOrEqual(1);
  });

  it('a cancelled item flags a labelled box to be reopened', async () => {
    const a = await stocked('PK-PEN', 'Pen, Black');
    const o = await picked([{ item: a, quantity: 1 }]);
    const pkg = (await h.call('POST', `/fulfillments/${o.fulfillment.id}/packages`, {})).body;
    await h.call('POST', `/packages/${pkg.id}/scan`, { code: 'PK-PEN' });
    await h.call('PATCH', `/packages/${pkg.id}`, { boxTypeId: mailer.id, weight: { value: 0.1, unit: 'lb' } });
    await h.call('POST', `/packages/${pkg.id}/label`, {}, { headers: idem() });
    const zero = { amount: 0, currency: 'USD' };
    await h.publish('orders', 'orders.item.cancelled', { orderId: o.orderId, ref: o.ref, groupId: o.groupId, ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', itemId: o.itemIds[0], offerId: newId(), stockItemId: a.id, quantity: 1, cancellationId: newId(), initiatedBy: 'staff', reasonCode: 'out_of_stock', beforeDispatch: true, countsAgainstSeller: false, refund: { itemAmount: zero, discountShare: zero, shippingRefund: zero, taxRefund: zero, total: zero }, paymentIntentId: newId(), notifyCustomer: true });
    const f = (await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body;
    expect(f.status).toBe('packing');
    expect(f.lines[0].state).toBe('cancelled');
    expect(f.packages[0].handlingNote).toMatch(/^Reopen: 1 × Pen, Black cancelled/);
  });
});
