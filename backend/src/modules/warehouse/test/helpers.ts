/**
 * Warehouse behaviour tests: warehouse runs for real on PGlite; the neighbours whose answers the tests control
 * (orders' fulfillment task, inventory's discrepancies and SKU lookups, shipping's quotes and labels, returns,
 * media, audit, work queues) are stubbed. src/modules/warehouse/test/official-order.test.ts runs with real modules.
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { auth, buildTestApp, callers, movingClock } from '../../../testing/app.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type * as orders from '../../../spec/orders.js';
import type * as returns from '../../../spec/returns.js';
import type * as shipping from '../../../spec/shipping.js';
import type * as workqueues from '../../../spec/workqueues.js';
import type { WarehouseService } from '../service.js';

export const USD = (amount: number) => ({ amount, currency: 'USD' });
export const PORTLAND: common.Address = { name: 'Ana Lopez', line1: '1120 SW 5th Ave', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US' };
export const ADMIN = '/api/admin/warehouse';
const DAY = 86_400_000;

export interface StockRec {
  id: string;
  sku: string;
  label: string;
  /** Variant GTIN inventory returns from catalog */
  gtin?: string | null;
}

export interface Harness {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  service: WarehouseService;
  staff: string;
  locationId: string;
  stock: Map<string, StockRec>;
  tasks: Map<string, orders.FulfillmentTask>;
  discrepancies: any[];
  audits: audit.RecordInput[];
  raised: workqueues.RaiseInput[];
  resolved: string[];
  receipts: { returnId: string; trackingNumber: string | null }[];
  returns: Map<string, returns.ReturnDetail>;
  files: { fileName: string; contentType: string; text: string }[];
  labels: { input: shipping.LabelRequest; key: string; id: string; shipmentId: string; tracking: string; voided: boolean }[];
  /** media.attach calls: [assetId, usage, owner] */
  attached: unknown[][];
  knobs: { labelFails: boolean; slowServicesOnly: boolean };
  events: { name: string; payload: any }[];
  named(name: string): any[];
  call(method: string, path: string, body?: unknown, o?: { token?: string; headers?: Record<string, string> }): Promise<{ status: number; body: any }>;
  publish(source: string, name: string, payload: unknown): Promise<void>;
  /** A company stock item known to the inventory stubs */
  item(sku: string, label: string, gtin?: string): StockRec;
  /** Bins at the harness location; returns them by code */
  bins(codes: string[], kind?: string): Promise<Record<string, any>>;
  /** An accepted order with an Official Store group (and optionally a seller group): returns its fulfillment */
  order(lines: { item: StockRec; quantity: number }[], o?: { sellerGroup?: boolean; dispatchInHours?: number }): Promise<{ orderId: string; ref: string; groupId: string; itemIds: string[]; fulfillment: any }>;
  /** Order → wave → picking: the fulfillment ready to pick */
  picking(lines: { item: StockRec; quantity: number }[], o?: { sellerGroup?: boolean }): Promise<{ orderId: string; ref: string; groupId: string; itemIds: string[]; fulfillment: any; waveId: string }>;
  /** Picks every line with the right scans */
  pickAll(fulfillmentId: string): Promise<any>;
}

let refNo = 10000;

export async function harness(): Promise<Harness> {
  const clock = movingClock();
  const h = {
    stock: new Map<string, StockRec>(),
    tasks: new Map<string, orders.FulfillmentTask>(),
    orders: new Map<string, { id: string; ref: string; groups: { id: string; name: string; itemIds: string[] }[] }>(),
    discrepancies: [] as any[],
    audits: [] as audit.RecordInput[],
    raised: [] as workqueues.RaiseInput[],
    resolved: [] as string[],
    receipts: [] as { returnId: string; trackingNumber: string | null }[],
    returns: new Map<string, returns.ReturnDetail>(),
    files: [] as { fileName: string; contentType: string; text: string }[],
    labels: [] as Harness['labels'],
    attached: [] as unknown[][],
    knobs: { labelFails: false, slowServicesOnly: false },
    events: [] as { name: string; payload: any }[],
  };
  const day = (n: number) => new Date(clock.now().getTime() + n * DAY).toISOString().slice(0, 10);
  const SERVICES = [
    { id: '00000000-0000-4000-8000-000000000001', carrier: 'UPS', service: 'UPS Ground', days: 4, cost: 899 },
    { id: '00000000-0000-4000-8000-000000000002', carrier: 'UPS', service: 'UPS Next Day Air', days: 1, cost: 2999 },
    { id: '00000000-0000-4000-8000-000000000003', carrier: 'USPS', service: 'USPS Ground Advantage', days: 9, cost: 599 },
  ];
  const labelOf = (l: Harness['labels'][number], svc: (typeof SERVICES)[number]): shipping.Label => ({
    id: l.id,
    shipmentId: l.shipmentId,
    groupId: l.input.groupId,
    carrierName: svc.carrier,
    serviceName: svc.service,
    carrierServiceId: svc.id,
    cost: USD(svc.cost),
    trackingNumber: l.tracking,
    labelUrl: `https://files.test/labels/${l.id}.${l.input.format ?? 'pdf'}`,
    format: l.input.format ?? 'pdf',
    status: l.voided ? 'voided' : 'purchased',
    purchasedBy: { kind: 'system', id: null },
    purchasedAt: clock.now().toISOString(),
  });
  const svcOf = (l: Harness['labels'][number]) => SERVICES.find((s) => s.id === l.input.carrierServiceId) ?? SERVICES[0]!;
  const shipmentOf = (l: Harness['labels'][number]) => ({ id: l.shipmentId, groupId: l.input.groupId, label: labelOf(l, svcOf(l)), estimatedArrival: { from: day(svcOf(l).days - 1), to: day(svcOf(l).days) } }) as unknown as shipping.Shipment;
  const readStream = async (s: ReadableStream) => Buffer.from(await new Response(s).arrayBuffer()).toString('latin1');

  const app = await buildTestApp({
    only: ['warehouse', 'shipping', 'returns', 'audit', 'workqueues'],
    clock,
    config: { rateLimits: false },
    apiStubs: {
      orders: {
        getFulfillmentTask: async (groupId) => {
          const t = h.tasks.get(groupId);
          if (!t) throw new AppError('NOT_FOUND', 'Fulfillment task not found');
          return structuredClone(t);
        },
        getOrder: async (orderId) => {
          const o = h.orders.get(orderId);
          if (!o) return null;
          return { id: o.id, ref: o.ref, groups: o.groups.map((g) => ({ id: g.id, seller: { ownerType: g.name === 'Marketly Official Store' ? 'official' : 'seller', name: g.name, slug: 'x', verified: true }, items: g.itemIds.map((id) => ({ id, unitPrice: USD(2300) })) })) } as unknown as orders.OrderDetail;
        },
        canShipItems: async () => ({ ok: true, problems: [] }),
      },
      inventory: {
        getStockItems: async (ids) =>
          ids.flatMap((id) => {
            const s = h.stock.get(id);
            return s ? [{ id: s.id, sku: s.sku, label: s.label, ownerType: 'official' as const, sellerId: null, offerId: null, productId: newId(), variantId: newId(), condition: 'new', locationId: null, locationCode: null, binCode: null, gtin: s.gtin ?? null }] : [];
          }),
        findBySku: async (_owner, skus) =>
          [...h.stock.values()].filter((s) => skus.some((k) => k.trim().toUpperCase() === s.sku.toUpperCase())).map((s) => ({ id: s.id, ownerType: 'official', sku: s.sku, productId: newId(), variantId: newId(), condition: 'new', label: s.label, image: null, quantities: {}, state: 'in_stock', archived: false, updatedAt: clock.now().toISOString() }) as never),
        reportDiscrepancy: async (input) => {
          const d = { id: newId(), ...input, state: 'open' };
          h.discrepancies.push(d);
          return d as never;
        },
      },
      shipping: {
        quoteLabelOptions: async (input) =>
          SERVICES.filter((s) => !h.knobs.slowServicesOnly || s.days > 6).map((s) => ({
            id: newId(),
            carrierServiceId: s.id,
            carrierName: s.carrier,
            serviceName: s.service,
            cost: USD(s.cost + Math.round(input.parcel.weightGrams / 100)),
            estimatedArrival: { from: day(s.days - 1), to: day(s.days) },
            keepsPromise: s.days <= 6,
            expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
          })),
        createLabel: async (input, key) => {
          const existing = h.labels.find((l) => l.key === key);
          if (existing) return { label: labelOf(existing, svcOf(existing)), shipment: shipmentOf(existing) };
          if (h.knobs.labelFails) throw new AppError('LABEL_FAILED', 'The carrier did not sell the label', { carrierMessage: 'Address not found' }, 502);
          const l = { input, key, id: newId(), shipmentId: newId(), tracking: `1Z${String(h.labels.length + 1).padStart(16, '0')}`, voided: false };
          h.labels.push(l);
          return { label: labelOf(l, svcOf(l)), shipment: shipmentOf(l) };
        },
        getShipment: async (_viewer, id) => {
          const l = h.labels.find((x) => x.shipmentId === id);
          return l ? shipmentOf(l) : null;
        },
        voidLabel: async (labelId) => {
          const l = h.labels.find((x) => x.id === labelId)!;
          l.voided = true;
          return labelOf(l, svcOf(l));
        },
        listShipmentsForGroups: async (groupIds) => new Map(groupIds.map((g) => [g, h.labels.filter((l) => l.input.groupId === g).map(shipmentOf)])),
      },
      returns: {
        getReturn: async (returnId) => {
          const d = h.returns.get(returnId);
          return d ? ({ detail: d } as unknown as returns.ReturnCase) : null;
        },
        getReturnAdmin: async (ref) => {
          const d = [...h.returns.values()].find((r) => r.ref === ref);
          return d ? ({ detail: d } as unknown as returns.ReturnCase) : null;
        },
        recordWarehouseReceipt: async (returnId, _at, _by, trackingNumber) => {
          h.receipts.push({ returnId, trackingNumber });
          const d = h.returns.get(returnId);
          if (!d) throw new AppError('NOT_FOUND', 'Return not found');
          return d;
        },
      },
      media: {
        attach: async (...args: unknown[]) => void h.attached.push(args),
        refs: async (ids) => ids.map((id) => ({ id, url: `https://media.test/${id}.jpg` })),
        storeGeneratedFile: async (input) => {
          h.files.push({ fileName: input.fileName, contentType: input.contentType, text: await readStream(input.body) });
          return { id: newId(), fileName: input.fileName } as never;
        },
        signedDownload: async (assetId) => ({ url: `https://files.test/${assetId}`, expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(), fileName: h.files.at(-1)?.fileName ?? 'file', contentType: 'application/pdf', sizeBytes: 100 }),
      },
      audit: {
        record: async (entry) => {
          h.audits.push(entry);
          return newId();
        },
      },
      workqueues: {
        raise: async (input) => {
          h.raised.push(input);
          return { id: newId() } as never;
        },
        resolveBySource: async (key) => {
          h.resolved.push(key);
          return 1;
        },
      },
    },
  });
  for (const name of ['warehouse.fulfillment.created', 'warehouse.fulfillment.status_changed', 'warehouse.fulfillment.at_risk', 'warehouse.shortage.reported', 'warehouse.damage.reported', 'warehouse.package.packed', 'warehouse.bin.assigned', 'warehouse.return_parcel.received', 'warehouse.return_parcel.handed_over']) {
    app.kernel.events.subscribe('warehouse-test', name, (e) => void h.events.push({ name: e.name, payload: e.payload }));
  }
  const service = app.kernel.boot.apis.get('warehouse') as WarehouseService;
  const staffId = newId();
  const staff = callers.staff(undefined, { sub: staffId });
  const locationId = newId();

  const call: Harness['call'] = async (method, path, body, o = {}) => {
    const res = await app.inject({ method: method as never, url: path.startsWith('/api') ? path : `${ADMIN}${path}`, headers: { ...auth(o.token ?? staff), ...(o.headers ?? {}) }, ...(body !== undefined ? { payload: body as never } : {}) });
    await app.kernel.events.drain();
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const publish: Harness['publish'] = async (source, name, payload) => {
    app.kernel.events.publish(source as never, name as never, payload as never);
    await app.kernel.events.drain();
  };

  const self: Harness = {
    ...h,
    app,
    clock,
    service,
    staff,
    locationId,
    call,
    publish,
    named: (name) => h.events.filter((e) => e.name === name).map((e) => e.payload),
    item(sku, label, gtin?: string) {
      const s = { id: newId(), sku, label, gtin: gtin ?? null };
      h.stock.set(s.id, s);
      return s;
    },
    async bins(codes, kind = 'pick') {
      const r = await call('POST', '/bins', { locationId, codes, kind });
      if (r.status !== 201) throw new Error(JSON.stringify(r.body));
      return Object.fromEntries((r.body as any[]).map((b) => [b.code, b]));
    },
    async order(lines, o = {}) {
      const orderId = newId();
      const ref = `MK-261009-${++refNo}`;
      const groupId = newId();
      const itemIds = lines.map(() => newId());
      const now = clock.now();
      h.tasks.set(groupId, {
        groupId,
        orderId,
        orderRef: ref,
        seller: { ownerType: 'official', id: null, name: 'Marketly Official Store', slug: 'official', verified: true },
        fulfilledBy: 'official_warehouse',
        shipTo: PORTLAND,
        delivery: { methodName: 'Standard', carrier: 'UPS', service: 'Ground', price: USD(599), free: false, fundedBy: 'customer', arrival: { from: day(3), to: day(6) }, dispatchBy: new Date(now.getTime() + (o.dispatchInHours ?? 24) * 3_600_000).toISOString() },
        dispatchDeadline: { dueAt: new Date(now.getTime() + (o.dispatchInHours ?? 24) * 3_600_000).toISOString(), state: 'on_time' },
        giftNote: 'Happy birthday!',
        hidePricesOnSlip: false,
        openLines: lines.map((l, i) => ({ orderItemId: itemIds[i]!, stockItemId: l.item.id, offerId: newId(), title: l.item.label.split(', ')[0]!, variantLabel: l.item.label.split(', ')[1] ?? '', sellerSku: l.item.sku, quantityToShip: l.quantity })),
      });
      const groups: orders.PlacedGroup[] = [{ groupId, ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', dispatchBy: new Date(now.getTime() + DAY).toISOString(), itemIds, total: USD(4600) }];
      const orderGroups = [{ id: groupId, name: 'Marketly Official Store', itemIds }];
      if (o.sellerGroup) {
        const sg = newId();
        groups.push({ groupId: sg, ownerType: 'seller', sellerId: newId(), fulfilledBy: 'seller', dispatchBy: new Date(now.getTime() + DAY).toISOString(), itemIds: [newId()], total: USD(1000) });
        orderGroups.push({ id: sg, name: 'Pixel & Port', itemIds: [] });
      }
      h.orders.set(orderId, { id: orderId, ref, groups: orderGroups });
      const items = lines.map((l, i) => ({ orderItemId: itemIds[i]!, offerId: h.tasks.get(groupId)!.openLines[i]!.offerId, stockItemId: l.item.id, quantity: l.quantity }));
      await publish('orders', 'orders.order.accepted', { orderId, ref, customerId: null, contactEmail: 'ana@example.com', total: USD(5600), groups, items, acceptedAt: now.toISOString() });
      const fulfillment = (await service.getFulfillmentForOrder(orderId))!;
      return { orderId, ref, groupId, itemIds, fulfillment };
    },
    async picking(lines, o = {}) {
      const order = await self.order(lines, o);
      const wave = await call('POST', '/waves', { locationId: order.fulfillment.locationId, fulfillmentIds: [order.fulfillment.id] });
      if (wave.status !== 201) throw new Error(JSON.stringify(wave.body));
      const started = await call('POST', `/waves/${wave.body.id}/start`);
      if (started.status !== 200) throw new Error(JSON.stringify(started.body));
      return { ...order, fulfillment: (await call('GET', `/fulfillments/${order.fulfillment.id}`)).body, waveId: wave.body.id };
    },
    async pickAll(fulfillmentId) {
      const f = (await call('GET', `/fulfillments/${fulfillmentId}`)).body;
      for (const l of f.lines) {
        for (let n = l.picked; n < l.quantity; n++) {
          const r = await call('POST', `/pick-lines/${l.id}/pick`, { binCode: l.binCode ?? '', itemCode: l.sku, quantity: 1 });
          if (r.status !== 200) throw new Error(JSON.stringify(r.body));
        }
      }
      return (await call('GET', `/fulfillments/${fulfillmentId}`)).body;
    },
  };
  return self;
}
