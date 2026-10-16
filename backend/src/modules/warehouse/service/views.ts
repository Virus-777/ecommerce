/** Rows → API types, in one place per type, with the batched lookups the views need. */
import type * as common from '../../../spec/common.js';
import type { Bin, BoxType, Fulfillment, FulfillmentLine, FulfillmentRow, Package, PackageItem, PutawayTask, ReturnParcel, Wave, WaveOrder } from '../../../spec/warehouse.js';
import { compareBinCodes, deadlineOf, parseActor, suggestBox, WAVE_DONE_STATUSES } from '../domain/rules.js';
import type { BinRec, BoxRec, FulfillmentRec, LineRec, PackageItemRec, PackageRec, ParcelRec, PutawayRec, WaveRec } from '../ports.js';
import { iso, type Core, type StockInfo } from './core.js';

/** Rows by key, in their order (Map.groupBy, which the ES2023 lib does not type yet) */
export function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

export const binView =(b: BinRec, assigned: number): Bin => ({ id: b.id, locationId: b.location_id, code: b.code, zone: b.zone, kind: b.kind as Bin['kind'], barcode: b.barcode, active: b.active, assignedItems: assigned });

export const boxView = (b: BoxRec): BoxType => ({ id: b.id, name: b.name, dimensions: b.dimensions, maxWeight: b.max_weight ?? null, kind: b.kind as BoxType['kind'], active: b.active });

export function lineView(l: LineRec): FulfillmentLine {
  return {
    id: l.id,
    orderItemId: l.order_item_id,
    stockItemId: l.stock_item_id,
    sku: l.sku,
    label: l.label,
    image: null,
    quantity: l.quantity,
    binCode: l.bin_code,
    picked: l.picked,
    short: l.short,
    state: l.state as FulfillmentLine['state'],
    pickedBy: parseActor(l.picked_by),
    pickedAt: iso(l.picked_at),
  };
}

/** Lines in walking order by bin (lines without a bin last) */
export const walkingOrder = (lines: LineRec[]) => [...lines].sort((a, b) => compareBinCodes(a.bin_code, b.bin_code) || a.sku.localeCompare(b.sku) || a.id.localeCompare(b.id));

export function packageView(p: PackageRec, items: PackageItemRec[], o: { orderRef: string; lines: LineRec[]; boxes: BoxRec[]; labelUrl: string | null }): Package {
  const byItem = new Map(o.lines.map((l) => [l.order_item_id, l]));
  const pitems: PackageItem[] = items.map((i) => {
    const l = byItem.get(i.order_item_id);
    return { orderItemId: i.order_item_id, stockItemId: i.stock_item_id, sku: l?.sku ?? '', label: l?.label ?? '', image: null, quantity: i.quantity, scanned: i.scanned, serialNumbers: [...(i.serial_numbers ?? [])] };
  });
  const units = items.reduce((n, i) => n + i.quantity, 0);
  return {
    id: p.id,
    fulfillmentId: p.fulfillment_id,
    orderRef: o.orderRef,
    index: p.index_in_order,
    of: p.of_in_order,
    status: p.status as Package['status'],
    items: pitems,
    allScanned: items.length > 0 && items.every((i) => i.scanned >= i.quantity),
    boxTypeId: p.box_type_id,
    suggestedBoxTypeId: suggestBox(o.boxes.map(boxView), units),
    dimensions: p.dimensions,
    weight: p.weight,
    fragile: p.fragile,
    handlingNote: p.handling_note,
    carrier: p.carrier,
    service: p.service,
    carrierServiceId: p.carrier_service_id,
    trackingNumber: p.tracking_number,
    labelUrl: p.tracking_number && ['labelled', 'packed', 'dispatched'].includes(p.status) ? o.labelUrl : null,
    packedBy: parseActor(p.packed_by),
    packedAt: iso(p.packed_at),
    shipmentId: p.shipment_id,
  };
}

export const putawayView = (t: PutawayRec, info: StockInfo | undefined): PutawayTask => ({
  id: t.id,
  receiptId: t.receipt_id,
  receiptRef: t.receipt_ref,
  stockItemId: t.stock_item_id,
  sku: info?.sku ?? '',
  label: info?.label ?? '',
  quantity: t.quantity,
  suggestedBinCode: t.suggested_bin_code,
  binCode: t.bin_code,
  status: t.status as PutawayTask['status'],
  doneBy: parseActor(t.done_by),
  doneAt: iso(t.done_at),
});

export const parcelView = (p: ParcelRec, photos: common.MediaRef[]): ReturnParcel => ({
  id: p.id,
  returnId: p.return_id,
  returnRef: p.return_ref,
  orderRef: p.order_ref,
  trackingNumber: p.tracking_number,
  status: p.status as ReturnParcel['status'],
  expectedBy: p.expected_by,
  expectedItems: p.expected_items ?? [],
  unexpected: p.unexpected,
  parcelCondition: (p.parcel_condition as ReturnParcel['parcelCondition']) ?? null,
  photos,
  note: p.note,
  receivedBy: parseActor(p.received_by),
  receivedAt: iso(p.received_at),
  handedOverTo: parseActor(p.handed_over_to),
  handedOverAt: iso(p.handed_over_at),
});

export interface FulfillmentParts {
  lines: Map<string, LineRec[]>;
  packages: Map<string, PackageRec[]>;
  items: Map<string, PackageItemRec[]>;
  boxes: BoxRec[];
  labelUrls: Map<string, string>;
  dueSoonMinutes: number;
}

export class Views {
  constructor(private readonly core: Core) {}

  /** Lines, packages, items, boxes and label links of a set of fulfillments (one query per table) */
  async parts(recs: FulfillmentRec[], o: { labels?: boolean } = {}): Promise<FulfillmentParts> {
    const ids = recs.map((r) => r.id);
    const [lines, packages, boxes, cfg] = await Promise.all([
      ids.length ? this.core.repo.find('fulfillment_lines', { fulfillment_id: ids }) : Promise.resolve([]),
      ids.length ? this.core.repo.find('packages', { fulfillment_id: ids }, { orderBy: [['index_in_order', 'asc']] }) : Promise.resolve([]),
      this.core.repo.find('box_types', { active: true }),
      this.core.cfg(),
    ]);
    const items = packages.length ? await this.core.repo.find('package_items', { package_id: packages.map((p) => p.id) }) : [];
    const labelUrls = new Map<string, string>();
    const labelled = packages.filter((p) => p.shipment_id && ['labelled', 'packed', 'dispatched'].includes(p.status));
    if (o.labels !== false && labelled.length) {
      const withLabels = new Set(labelled.map((p) => p.fulfillment_id));
      const groups = [...new Set(recs.filter((r) => withLabels.has(r.id)).map((r) => r.seller_group_id))];
      const shipments = await this.core.soft('shipping', 'label links', (s) => s.listShipmentsForGroups(groups));
      for (const list of shipments?.values() ?? []) for (const s of list) if (s.label?.labelUrl) labelUrls.set(s.id, s.label.labelUrl);
    }
    return { lines: groupBy(lines, (l) => l.fulfillment_id), packages: groupBy(packages, (p) => p.fulfillment_id), items: groupBy(items, (i) => i.package_id), boxes, labelUrls, dueSoonMinutes: cfg.atRiskMinutes };
  }

  pkg(p: PackageRec, f: FulfillmentRec, parts: FulfillmentParts): Package {
    return packageView(p, parts.items.get(p.id) ?? [], { orderRef: f.order_ref, lines: parts.lines.get(f.id) ?? [], boxes: parts.boxes, labelUrl: p.shipment_id ? (parts.labelUrls.get(p.shipment_id) ?? null) : null });
  }

  fulfillment(f: FulfillmentRec, parts: FulfillmentParts, o: { otherSellers?: string[] } = {}): Fulfillment {
    const now = this.core.now();
    const packages = (parts.packages.get(f.id) ?? []).filter((p) => p.status !== 'voided');
    const ours = Math.max(1, packages.length);
    const others = Math.max(0, f.total_packages_in_order - ours);
    let mixedOrderNote: string | null = null;
    if (others > 0) {
      const names = o.otherSellers?.length ? ` from ${o.otherSellers.join(' and ')}` : ' from other sellers';
      mixedOrderNote = others === 1 ? `This order also has 1 other package${names}. They ship it separately.` : `This order also has ${others} other packages${names}. They ship them separately.`;
    }
    return {
      id: f.id,
      orderId: f.order_id,
      orderRef: f.order_ref,
      sellerGroupId: f.seller_group_id,
      fulfilledBy: f.fulfilled_by,
      sellerId: f.seller_id,
      sellerName: f.seller_name,
      locationId: f.location_id,
      status: f.status as Fulfillment['status'],
      shipBy: f.ship_by.toISOString(),
      deadline: this.deadline(f, now, parts.dueSoonMinutes),
      deliveryChoice: f.delivery_choice,
      shipTo: f.ship_to,
      waveId: f.wave_id,
      lines: walkingOrder(parts.lines.get(f.id) ?? []).map(lineView),
      packages: (parts.packages.get(f.id) ?? []).map((p) => this.pkg(p, f, parts)),
      holdReason: f.hold_reason,
      dispatchOverdueAt: iso(f.dispatch_overdue_at),
      mixedOrderNote,
      totalPackagesInOrder: f.total_packages_in_order,
      createdAt: f.created_at.toISOString(),
    };
  }

  deadline(f: FulfillmentRec, now: Date, dueSoonMinutes: number): common.Deadline {
    const d = deadlineOf(f.ship_by, now, dueSoonMinutes);
    // packed or dispatched work is no longer at risk
    return ['packed', 'dispatched', 'cancelled'].includes(f.status) && d.state !== 'on_time' ? { ...d, state: 'on_time' } : d;
  }

  async fulfillments(recs: FulfillmentRec[], o: { labels?: boolean } = {}): Promise<Fulfillment[]> {
    if (!recs.length) return [];
    const parts = await this.parts(recs, o);
    return recs.map((f) => this.fulfillment(f, parts));
  }

  async rows(recs: FulfillmentRec[]): Promise<FulfillmentRow[]> {
    if (!recs.length) return [];
    const [lines, cfg] = await Promise.all([this.core.repo.find('fulfillment_lines', { fulfillment_id: recs.map((r) => r.id) }), this.core.cfg()]);
    const waveIds = [...new Set(recs.map((r) => r.wave_id).filter((x): x is string => Boolean(x)))];
    const waves = new Map((waveIds.length ? await this.core.repo.find('waves', { id: waveIds }) : []).map((w) => [w.id, w]));
    const byFulfillment = groupBy(lines, (l) => l.fulfillment_id);
    const now = this.core.now();
    return recs.map((f) => {
      const own = (byFulfillment.get(f.id) ?? []).filter((l) => l.state !== 'cancelled');
      return {
        id: f.id,
        orderRef: f.order_ref,
        fulfilledBy: f.fulfilled_by,
        sellerName: f.seller_name,
        status: f.status as FulfillmentRow['status'],
        deadline: this.deadline(f, now, cfg.atRiskMinutes),
        shipBy: f.ship_by.toISOString(),
        itemCount: own.reduce((n, l) => n + l.quantity, 0),
        pickedCount: own.reduce((n, l) => n + l.picked, 0),
        waveRef: (f.wave_id ? waves.get(f.wave_id)?.ref : null) ?? null,
        holdReason: f.hold_reason,
      };
    });
  }

  async waves(recs: WaveRec[]): Promise<Wave[]> {
    if (!recs.length) return [];
    const ids = recs.map((w) => w.id);
    const fulfillments = await this.core.repo.find('fulfillments', { wave_id: ids }, { orderBy: [['ship_by', 'asc']] });
    const [lines, cfg] = await Promise.all([fulfillments.length ? this.core.repo.find('fulfillment_lines', { fulfillment_id: fulfillments.map((f) => f.id) }) : Promise.resolve([]), this.core.cfg()]);
    const now = this.core.now();
    const byWave = groupBy(fulfillments, (f) => f.wave_id ?? '');
    const byFulfillment = groupBy(lines, (l) => l.fulfillment_id);
    return recs.map((w) => {
      const fs = byWave.get(w.id) ?? [];
      const orders: WaveOrder[] = fs.map((f) => ({
        fulfillmentId: f.id,
        orderRef: f.order_ref,
        deadline: this.deadline(f, now, cfg.atRiskMinutes),
        status: f.status,
        lines: walkingOrder(byFulfillment.get(f.id) ?? []).map(lineView),
      }));
      // the wave's lines in the order they were read (fulfillment ids are unique to one wave)
      const own = new Set(fs.map((f) => f.id));
      const live = lines.filter((l) => own.has(l.fulfillment_id) && l.state !== 'cancelled');
      const units = live.reduce((n, l) => n + l.quantity, 0);
      const picked = live.reduce((n, l) => n + Math.min(l.picked, l.quantity), 0);
      const held = new Set(fs.filter((f) => f.status === 'on_hold').map((f) => f.id));
      const pending = walkingOrder(live.filter((l) => l.state === 'pending' && !held.has(l.fulfillment_id)));
      const alerts: string[] = [];
      for (const f of fs) {
        if (f.status === 'on_hold') alerts.push(f.hold_reason?.startsWith('Damage') ? `Damage reported on ${f.order_ref}` : `Shortage reported on ${f.order_ref}`);
        else if (!WAVE_DONE_STATUSES.includes(f.status) && f.ship_by.getTime() < now.getTime()) alerts.push(`Dispatch overdue on ${f.order_ref}`);
      }
      return {
        id: w.id,
        ref: w.ref,
        locationId: w.location_id,
        status: w.status as Wave['status'],
        carrierPickupAt: iso(w.carrier_pickup_at),
        orderCount: fs.length,
        pickedOrderCount: fs.filter((f) => ['picked', 'packing', 'packed', 'dispatched'].includes(f.status)).length,
        packedOrderCount: fs.filter((f) => ['packed', 'dispatched'].includes(f.status)).length,
        progressPct: units ? Math.floor((picked / units) * 100) : w.status === 'completed' ? 100 : 0,
        nextBinCode: w.status === 'picking' || w.status === 'open' ? (pending[0]?.bin_code ?? null) : null,
        alerts,
        orders,
        createdBy: parseActor(w.created_by) ?? { kind: 'system', id: null, name: 'Warehouse' },
        createdAt: w.created_at.toISOString(),
      };
    });
  }

  async parcels(recs: ParcelRec[]): Promise<ReturnParcel[]> {
    const ids = [...new Set(recs.flatMap((p) => p.photo_media_ids ?? []))];
    const refs = await this.core.photos(ids);
    const byId = new Map(refs.map((r) => [r.id, r]));
    return recs.map((p) => parcelView(p, (p.photo_media_ids ?? []).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))));
  }

  async putaways(recs: PutawayRec[]): Promise<PutawayTask[]> {
    const info = await this.core.stockInfo(recs.map((t) => t.stock_item_id));
    return recs.map((t) => putawayView(t, info.get(t.stock_item_id)));
  }
}
