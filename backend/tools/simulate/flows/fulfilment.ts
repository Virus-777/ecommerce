/**
 * Flow 5, fulfilment:
 *   - sellers start preparing their packages and record the shipment with a UPS tracking number;
 *   - the Official Store's packages go through the warehouse: a wave, picking from the bins, a package with a box
 *     and weight, a label bought through shipping, packed and handed to the carrier;
 *   - the carrier (this simulator, signing its webhooks) reports each parcel accepted, in transit, out for delivery
 *     and delivered.
 * A few orders are kept back on purpose: one for a cancellation before shipping (flow 6), one left open (its stock
 * stays allocated) and one left in transit.
 */
import type { OrderWorld, Sim } from '../sim.js';

type Group = OrderWorld['groups'][number];

/** Marks the orders later flows need in a given state */
function keepSome(orders: OrderWorld[]): void {
  const withSeller = orders.filter((o) => o.customer && o.groups.length === 1 && o.groups[0]!.fulfilledBy === 'seller');
  if (withSeller[1]) withSeller[1].keep = 'cancel';
  if (withSeller[2]) withSeller[2].keep = 'open';
  const last = orders.filter((o) => !o.keep).at(-1);
  if (last) last.keep = 'in_transit';
}

/** The carrier's tracking events for one parcel, signed like the carrier would (kernel/http/webhooks.ts) */
export async function carrierEvents(sim: Sim, tracking: string, codes: string[]): Promise<void> {
  for (const code of codes) {
    const body = { id: `evt-${tracking}-${code}`, trackingNumber: tracking, code, at: new Date().toISOString(), location: code === 'delivered' || code === 'out_for_delivery' ? 'Portland, OR' : 'Portland, OR, distribution center' };
    await sim.api.webhook('/webhooks/shipping/carriers/ups/events', body, sim.webhookSecret('ups'), body.id);
  }
}

async function shipSellerGroup(sim: Sim, o: OrderWorld, g: Group): Promise<string> {
  const { api, world: w, run } = sim;
  const seller = w.sellers.find((s) => s.sellerId === g.sellerId)!;
  if (!seller) run.fail({ step: 'seller of the group', message: `no seller ${g.sellerId} in this run for ${o.ref}` });
  const detail = await api.call(seller.session, 'GET', `/api/seller/orders/orders/${g.id}`);
  run.check(`${o.ref}: the seller sees the order`, JSON.stringify(detail).includes(o.ref), undefined);
  await api.call(seller.session, 'POST', `/api/seller/orders/orders/${g.id}/start-preparing`);
  const tracking = sim.tracking();
  await api.call(seller.session, 'POST', '/api/seller/shipping/shipments', {
    groupId: g.id,
    carrierCode: 'ups',
    serviceName: 'UPS Ground',
    trackingNumber: tracking,
    shippedAt: new Date().toISOString(),
    items: g.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
  });
  return tracking;
}

async function shipOfficialGroups(sim: Sim, orders: OrderWorld[]): Promise<Map<string, string>> {
  const { api, world: w, run } = sim;
  const wh = w.staff.operations!.session;
  const tracking = new Map<string, string>();
  const rows: { id: string; orderRef: string; status: string }[] = [];
  for (const o of orders) {
    const list = await api.call(wh, 'GET', `/api/admin/warehouse/fulfillments?q=${encodeURIComponent(o.ref)}`);
    const row = (list.items as { id: string; orderRef: string; status: string }[]).find((r) => r.orderRef === o.ref);
    run.check(`${o.ref}: the warehouse has its fulfillment`, Boolean(row), list.items);
    rows.push(row!);
  }
  if (!rows.length) return tracking;
  // one wave for all of them, picked bin by bin
  const wave = await api.call(wh, 'POST', '/api/admin/warehouse/waves', { locationId: w.locationId, fulfillmentIds: rows.map((r) => r.id) });
  await api.call(wh, 'POST', `/api/admin/warehouse/waves/${wave.id}/start`);
  const boxes = (await api.call(wh, 'GET', '/api/admin/warehouse/box-types')) as { id: string; name: string }[];
  const box = boxes.find((b) => b.name === 'M box') ?? boxes[0];
  for (const r of rows) {
    const ful = await api.call(wh, 'GET', `/api/admin/warehouse/fulfillments/${r.id}`);
    for (const l of ful.lines as { id: string; quantity: number; picked: number; binCode: string | null; sku: string }[]) {
      for (let n = l.picked; n < l.quantity; n++) await api.call(wh, 'POST', `/api/admin/warehouse/pick-lines/${l.id}/pick`, { binCode: l.binCode ?? 'A-01-1', itemCode: l.sku, quantity: 1 });
    }
    const pkg = await api.call(wh, 'POST', `/api/admin/warehouse/fulfillments/${r.id}/packages`, { station: 'PACK-1' });
    for (const l of ful.lines as { sku: string; quantity: number }[]) for (let n = 0; n < l.quantity; n++) await api.call(wh, 'POST', `/api/admin/warehouse/packages/${pkg.id}/scan`, { code: l.sku });
    await api.call(wh, 'PATCH', `/api/admin/warehouse/packages/${pkg.id}`, { boxTypeId: box?.id, weight: { value: 2, unit: 'lb' } });
    const label = await api.call(wh, 'POST', `/api/admin/warehouse/packages/${pkg.id}/label`, { format: 'pdf' });
    await api.call(wh, 'POST', `/api/admin/warehouse/packages/${pkg.id}/pack`);
    tracking.set(r.orderRef, label.trackingNumber);
  }
  return tracking;
}

export async function fulfilmentFlow(sim: Sim): Promise<void> {
  const { api, world: w, run } = sim;
  keepSome(w.orders);
  // sellers ship their packages
  for (const o of w.orders.filter((x) => x.keep !== 'cancel' && x.keep !== 'open')) {
    for (const g of o.groups.filter((x) => x.fulfilledBy === 'seller')) {
      const t = await run.attempt(`${o.ref}: seller ships`, () => shipSellerGroup(sim, o, g));
      if (t) o.tracking.push(t);
    }
  }
  // the warehouse ships the Official Store's packages
  const official = w.orders.filter((o) => o.keep !== 'cancel' && o.keep !== 'open' && o.groups.some((g) => g.fulfilledBy === 'official_warehouse'));
  const labels = await shipOfficialGroups(sim, official);
  for (const o of official) {
    const t = labels.get(o.ref);
    if (t) o.tracking.push(t);
  }
  // the carrier picks the parcels up and delivers them (one order stays in transit)
  for (const o of w.orders) {
    for (const t of o.tracking) await carrierEvents(sim, t, o.keep === 'in_transit' ? ['accepted', 'in_transit'] : ['accepted', 'in_transit', 'out_for_delivery', 'delivered']);
    if (o.tracking.length && o.keep !== 'in_transit') o.delivered = true;
  }
  // the customer sees it delivered
  for (const o of w.orders.filter((x) => x.delivered)) {
    const s = o.customer?.session ?? o.guest?.session;
    if (!s || !o.customer) continue;
    const order = await api.call(s, 'GET', `/api/store/orders/orders/${o.orderId}`);
    const states = (order.groups as { items: { state: string }[] }[]).flatMap((g) => g.items.map((i) => i.state));
    run.check(`${o.ref}: delivered`, states.every((x) => x === 'delivered'), states);
  }
  const shipments = await api.call(w.staff.orders!.session, 'GET', '/api/admin/shipping/shipments?limit=50');
  run.check('the Shipping Manager sees the shipments', (shipments.items as unknown[]).length > 0, undefined);
}
