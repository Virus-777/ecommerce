/**
 * Gap pass 4: packages.carrier_service_id (the chosen shipping service, used for the label), fulfillments.dispatch_overdue_at,
 * idempotency through the kernel inbox instead of scan_log rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { spec } from '../../../spec/warehouse.js';
import { schemas } from '../schema.js';
import { harness, type Harness, type StockRec } from './helpers.js';

let h: Harness;
let box: { id: string };
beforeAll(async () => {
  h = await harness();
  await h.bins(['P4-01-1']);
  box = { id: newId() };
  const r = await h.call('PUT', '/box-types', { boxTypes: [{ id: box.id, name: 'S box', kind: 'box', dimensions: { length: 10, width: 8, height: 4, unit: 'in' }, maxWeight: { value: 20, unit: 'lb' }, active: true }] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
});
afterAll(async () => {
  await h?.app.close();
});

const table = (name: string) => h.app.kernel.mongo.module('warehouse', spec.collections, schemas).table<any>(name);
const inboxKeys = async () => ((await h.app.kernel.mongo.kernel('processed_events').find({ module: 'warehouse' }).lean()) as unknown as { key: string }[]).map((r) => r.key);

async function stocked(sku: string, label: string): Promise<StockRec> {
  const item = h.item(sku, label);
  const bin = (await h.call('GET', `/bins?q=P4-01-1&locationId=${h.locationId}`)).body.items[0];
  expect((await h.call('PUT', `/stock-items/${item.id}/bins`, { bins: [{ binId: bin.id, primary: true }] })).status).toBe(200);
  return item;
}

const overdue = (o: { orderId: string; ref: string; groupId: string; itemIds: string[] }, exceptionId: string, dueAt: string) =>
  h.publish('shipping', 'shipping.dispatch.overdue', { orderId: o.orderId, orderRef: o.ref, groupId: o.groupId, ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', orderItemIds: o.itemIds, dueAt, exceptionId });

describe('fulfillments.dispatch_overdue_at', () => {
  it('is set once by shipping.dispatch.overdue (inbox: a redelivery changes nothing)', async () => {
    const o = await h.order([{ item: h.item('P4-RUG', 'Rug, Jute'), quantity: 1 }], { dispatchInHours: 72 });
    expect((await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body.dispatchOverdueAt).toBeNull();
    const exceptionId = newId();
    const dueAt = new Date(h.clock.now().getTime() - 3_600_000).toISOString();
    await overdue(o, exceptionId, dueAt);
    const first = (await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body;
    expect(first).toMatchObject({ dispatchOverdueAt: expect.any(String), shipBy: dueAt });
    await overdue(o, exceptionId, new Date(h.clock.now().getTime() - 7_200_000).toISOString());
    expect((await h.call('GET', `/fulfillments/${o.fulfillment.id}`)).body).toMatchObject({ dispatchOverdueAt: first.dispatchOverdueAt, shipBy: dueAt });
    expect(await inboxKeys()).toContain(`dispatch-overdue:${exceptionId}`);
    // scan_log keeps one troubleshooting row, but it is no longer what makes the consumer idempotent
    expect(await table('scan_log').find({ context: 'overdue', context_id: exceptionId })).toHaveLength(1);
  });
});

describe('packages.carrier_service_id', () => {
  it('keeps the chosen service; the label is bought with it', async () => {
    const a = await stocked('P4-CABLE', 'Cable, USB-C');
    const o = await h.picking([{ item: a, quantity: 1 }]);
    await h.pickAll(o.fulfillment.id);
    const pkg = (await h.call('POST', `/fulfillments/${o.fulfillment.id}/packages`, {})).body;
    const options = (await h.call('GET', `/packages/${pkg.id}/service-options`)).body;
    const fast = options.find((x: any) => x.service === 'UPS Next Day Air');
    const chosen = await h.call('PATCH', `/packages/${pkg.id}`, { boxTypeId: box.id, weight: { value: 1, unit: 'lb' }, serviceCode: fast.serviceCode });
    expect(chosen.body).toMatchObject({ service: 'UPS Next Day Air', carrierServiceId: fast.carrierServiceId });
    expect((await h.call('PATCH', `/packages/${pkg.id}`, { serviceCode: null })).body).toMatchObject({ carrierServiceId: null, service: null });
    await h.call('PATCH', `/packages/${pkg.id}`, { serviceCode: fast.serviceCode });
    await h.call('POST', `/packages/${pkg.id}/scan`, { code: 'P4-CABLE' });
    const label = await h.call('POST', `/packages/${pkg.id}/label`, { format: 'pdf' }, { headers: { 'idempotency-key': newId() } });
    expect(label.status, JSON.stringify(label.body)).toBe(200);
    expect(h.labels.at(-1)!.input).toMatchObject({ carrierServiceId: fast.carrierServiceId });
  });
});
