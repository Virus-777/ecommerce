/**
 * Packing stations: packages with an item checklist by scan, box and weight, carrier services that keep the
 * customer's promise, labels bought through shipping, packing slips, and the hand-over to shipping.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { Principal } from '../../../spec/identity.js';
import type { FileLink, LabelResult, Package, PackageServiceOption, PackageUpdate } from '../../../spec/warehouse.js';
import type { LabelQuote } from '../../../spec/shipping.js';
import { renderPdf, type PdfLine } from '../domain/pdf.js';
import { actorText, itemMatches, matchesChoice, missingForLabel, parcelOf, plural, shortDay, validDimensions } from '../domain/rules.js';
import { packageMachine, warehouseFulfillmentMachine } from '../domain/state-machines.js';
import type { BoxRec, FulfillmentRec, LineRec, PackageItemRec, PackageRec, WarehouseRepository } from '../ports.js';
import { Batch, invalid, invalidField, notFound, unavailable, type By, type Core } from './core.js';
import type { Fulfillments } from './fulfillments.js';
import type { Views } from './views.js';

interface Loaded {
  p: PackageRec;
  f: FulfillmentRec;
  items: PackageItemRec[];
  lines: LineRec[];
}

const LABELLED: readonly string[] = ['labelled', 'packed', 'dispatched'];

export class Packing {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly fulfillments: Fulfillments,
  ) {}

  private get repo() {
    return this.core.repo;
  }

  private async load(id: string, tx: WarehouseRepository = this.repo, o: { forUpdate?: boolean } = {}): Promise<Loaded> {
    const p = await tx.get('packages', id, o);
    if (!p) throw notFound('Package');
    const f = await this.fulfillments.load(p.fulfillment_id, tx);
    const [items, lines] = await Promise.all([tx.find('package_items', { package_id: id }), tx.find('fulfillment_lines', { fulfillment_id: f.id })]);
    return { p, f, items, lines };
  }

  async view(id: string): Promise<Package> {
    const p = await this.repo.get('packages', id);
    if (!p) throw notFound('Package');
    const f = await this.fulfillments.load(p.fulfillment_id);
    const parts = await this.views.parts([f]);
    return this.views.pkg((parts.packages.get(f.id) ?? []).find((x) => x.id === id) ?? p, f, parts);
  }

  private onHold(f: FulfillmentRec) {
    if (f.status === 'on_hold') throw this.core.error('FULFILLMENT_ON_HOLD', `${f.hold_reason ?? `${f.order_ref} is on hold`} Do not pack it partly.`, { holdReason: f.hold_reason });
  }

  private illegal(message: string, from: string, event: string) {
    return new AppError('ILLEGAL_TRANSITION', message, { machine: 'Package', from, event, allowed: packageMachine.eventsFrom(from as never) });
  }

  private shipping() {
    const s = this.core.ctx.tryUse('shipping');
    if (!s) throw unavailable('Shipping labels');
    return s;
  }

  /** Box dimensions when the packer chose a box without measuring */
  private async dims(p: PackageRec) {
    if (p.dimensions) return p.dimensions;
    if (!p.box_type_id) return null;
    return (await this.repo.get('box_types', p.box_type_id))?.dimensions ?? null;
  }

  private static scanned = (items: PackageItemRec[]) => items.length > 0 && items.every((i) => i.scanned >= i.quantity);

  /* ---------------------------------------------------------------- packages */

  /** Opens a package at a station with the picked items not yet in a package (or the chosen ones) */
  async start(fulfillmentId: string, body: { orderItemIds?: string[] | null; station?: string | null }, by: By): Promise<Package> {
    const f = await this.fulfillments.load(fulfillmentId);
    this.onHold(f);
    if (f.status !== 'packing') warehouseFulfillmentMachine.next(f.status as never, 'startPacking');
    const station = body.station?.trim().slice(0, 60) || null;
    const order = await this.core.ctx
      .use('orders')
      .getOrder(f.order_id)
      .catch((err) => {
        if (!isAppError(err)) throw err;
        return null;
      });
    const groupPos = Math.max(1, (order?.groups.findIndex((g) => g.id === f.seller_group_id) ?? 0) + 1);
    const batch = new Batch(by);
    const id = await this.repo.transaction(async (tx) => {
      const fresh = await this.fulfillments.load(fulfillmentId, tx, { forUpdate: true });
      this.onHold(fresh);
      const lines = (await tx.find('fulfillment_lines', { fulfillment_id: f.id })).filter((l) => l.state === 'picked');
      const existing = (await tx.find('packages', { fulfillment_id: f.id })).filter((p) => p.status !== 'voided');
      const inBoxes = existing.length ? await tx.find('package_items', { package_id: existing.map((p) => p.id) }) : [];
      const packaged = (orderItemId: string) => inBoxes.filter((i) => i.order_item_id === orderItemId).reduce((n, i) => n + i.quantity, 0);
      const available = lines.map((l) => ({ l, qty: l.quantity - packaged(l.order_item_id) })).filter((x) => x.qty > 0);
      let chosen = available;
      const wanted = [...new Set(body.orderItemIds ?? [])];
      if (wanted.length) {
        const issues = wanted.flatMap((oid, i) => (available.some((x) => x.l.order_item_id === oid) ? [] : [{ path: `orderItemIds.${i}`, message: 'Not a picked item waiting for a package' }]));
        if (issues.length) throw invalid(issues);
        chosen = available.filter((x) => wanted.includes(x.l.order_item_id));
      }
      if (!chosen.length) {
        // back from a hold: the open package is still on the bench
        const open = existing.find((p) => p.status === 'open');
        if (open && fresh.status === 'picked') {
          await this.fulfillments.move(tx, fresh, 'startPacking', batch, { reason: `Packing ${station ? `at ${station}` : 'resumed'}` });
          return open.id;
        }
        throw invalidField('orderItemIds', 'Every picked item is already in a package');
      }
      const total = existing.length ? fresh.total_packages_in_order + 1 : fresh.total_packages_in_order;
      if (existing.length) {
        await tx.update('fulfillments', f.id, { total_packages_in_order: total, updated_at: this.core.now() });
        await tx.updateWhere('packages', { id: existing.map((p) => p.id) }, { of_in_order: total });
      }
      const pid = newId();
      await tx.insert('packages', {
        id: pid,
        fulfillment_id: f.id,
        index_in_order: groupPos + existing.length,
        of_in_order: total,
        status: packageMachine.initial,
        box_type_id: null,
        dimensions: null,
        weight: null,
        fragile: false,
        handling_note: null,
        carrier: null,
        service: null,
        tracking_number: null,
        label_media_id: null,
        label_idempotency_key: null,
        shipment_id: null,
        packed_by: null,
        packed_at: null,
        station,
      });
      await tx.insertMany(
        'package_items',
        chosen.map((x) => ({ package_id: pid, order_item_id: x.l.order_item_id, stock_item_id: x.l.stock_item_id, quantity: x.qty, scanned: 0, serial_numbers: [] })),
      );
      if (fresh.status === 'picked') await this.fulfillments.move(tx, fresh, 'startPacking', batch, { reason: station ? `Packing at ${station}` : 'Packing started' });
      return pid;
    });
    this.core.flush(batch);
    return this.view(id);
  }

  /** One scan = one unit into the checklist; wrong items and extra units are refused */
  async scan(id: string, body: { code: string; serialNumber?: string | null }, by: By): Promise<Package> {
    const { p, f, items, lines } = await this.load(id);
    this.onHold(f);
    if (p.status !== 'open') throw this.illegal(p.status === 'labelled' ? 'The package is labelled; void the label to change its contents' : `The package is ${p.status}`, p.status, 'scan');
    const code = body.code?.trim() ?? '';
    const lineOf = (orderItemId: string) => lines.find((l) => l.order_item_id === orderItemId);
    const bySku = (it: (typeof items)[number], gtin?: string) => itemMatches(code, { sku: lineOf(it.order_item_id)?.sku ?? '', stockItemId: it.stock_item_id, extraCodes: [gtin] });
    // the SKU label, else the variant GTIN (the manufacturer barcode)
    const gtins = items.some((it) => bySku(it)) ? new Map<string, string>() : await this.core.gtins(items.map((it) => it.stock_item_id));
    const matching = items.filter((it) => bySku(it, gtins.get(it.stock_item_id)));
    const target = matching.find((it) => it.scanned < it.quantity);
    const refuse = async (result: string, message: string, expected: unknown) => {
      await this.core.logScan({ context: 'pack', contextId: id, code, result, actor: by.actor, station: p.station });
      return this.core.error('SCAN_MISMATCH', message, { expected, scanned: code });
    };
    if (!matching.length) throw await refuse('wrong_item', 'Not in this package', items.map((it) => lineOf(it.order_item_id)?.sku ?? it.stock_item_id));
    if (!target) {
      const it = matching[0]!;
      throw await refuse('extra_unit', `All ${it.quantity} × ${lineOf(it.order_item_id)?.label ?? 'this item'} are already scanned`, it.quantity);
    }
    const serial = body.serialNumber?.trim() || null;
    if (serial && items.some((it) => (it.serial_numbers ?? []).includes(serial))) throw await refuse('duplicate_serial', `Serial ${serial} is already scanned`, null);
    await this.repo.transaction(async (tx) => {
      const locked = await tx.get('packages', id, { forUpdate: true });
      if (locked?.status !== 'open') throw this.illegal(`The package is ${locked?.status}`, locked?.status ?? 'open', 'scan');
      const it = (await tx.find('package_items', { package_id: id, order_item_id: target.order_item_id }))[0]!;
      if (it.scanned >= it.quantity) throw this.core.error('SCAN_MISMATCH', 'Every unit of this item is already scanned', { expected: it.quantity, scanned: code });
      await tx.updateWhere('package_items', { package_id: id, order_item_id: it.order_item_id }, { scanned: it.scanned + 1, serial_numbers: serial ? [...(it.serial_numbers ?? []), serial] : (it.serial_numbers ?? []) });
      await this.core.logScan({ context: 'pack', contextId: id, code, result: serial ? `scanned (serial ${serial})` : 'scanned', actor: by.actor, station: p.station }, tx);
    });
    return this.view(id);
  }

  async update(id: string, body: PackageUpdate, by: By): Promise<Package> {
    const { p, f, items } = await this.load(id);
    if (p.status !== 'open') throw this.illegal(p.status === 'labelled' ? 'Void the label before changing the box, weight or service' : `The package is ${p.status}`, p.status, 'update');
    const issues: { path: string; message: string }[] = [];
    let box: BoxRec | undefined;
    if (body.boxTypeId) {
      box = await this.repo.get('box_types', body.boxTypeId);
      if (!box?.active) issues.push({ path: 'boxTypeId', message: 'Choose one of the listed boxes' });
    }
    if (body.dimensions && !validDimensions(body.dimensions)) issues.push({ path: 'dimensions', message: 'Enter length, width and height above zero' });
    if (body.weight && !(Number.isFinite(body.weight.value) && body.weight.value > 0)) issues.push({ path: 'weight.value', message: 'Weigh the package (above zero)' });
    if (body.handlingNote && body.handlingNote.length > 500) issues.push({ path: 'handlingNote', message: 'At most 500 characters' });
    if (issues.length) throw invalid(issues);
    const patch: Partial<PackageRec> = {};
    if (body.boxTypeId !== undefined) patch.box_type_id = body.boxTypeId ?? null;
    if (body.dimensions !== undefined) patch.dimensions = body.dimensions ?? null;
    else if (box) patch.dimensions = box.dimensions;
    if (body.weight !== undefined) patch.weight = body.weight ?? null;
    if (body.fragile != null) patch.fragile = body.fragile;
    if (body.handlingNote !== undefined) patch.handling_note = body.handlingNote?.trim() || null;
    if (body.serviceCode === null || body.serviceCode === '') {
      patch.carrier = null;
      patch.service = null;
    } else if (body.serviceCode) {
      const merged = { ...p, ...patch } as PackageRec;
      const quotes = await this.quotes(merged, f, items);
      const q = quotes.find((x) => x.carrierServiceId === body.serviceCode);
      if (!q) throw invalidField('serviceCode', 'Choose one of the listed carrier services');
      if (!q.keepsPromise) throw this.core.error('SERVICE_BREAKS_PROMISE', `${q.serviceName} would arrive after the date the customer was promised`, { serviceCode: q.carrierServiceId, arrivesBy: q.estimatedArrival.to });
      patch.carrier = q.carrierName;
      patch.service = q.serviceName;
    }
    await this.repo.transaction(async (tx) => {
      const locked = await tx.get('packages', id, { forUpdate: true });
      if (locked?.status !== 'open') throw this.illegal(`The package is ${locked?.status}`, locked?.status ?? 'open', 'update');
      if (Object.keys(patch).length) await tx.update('packages', id, patch);
    });
    void by;
    return this.view(id);
  }

  /** Quotes from shipping for the package's parcel (keepsPromise against the customer's promised range) */
  private async quotes(p: PackageRec, f: FulfillmentRec, items: PackageItemRec[]): Promise<LabelQuote[]> {
    const shipping = this.shipping();
    const parcel = parcelOf(p.weight, await this.dims(p));
    return shipping.quoteLabelOptions({ groupId: f.seller_group_id, kind: 'outbound', items: items.map((i) => ({ orderItemId: i.order_item_id, quantity: i.quantity })), parcel, keepPromise: false, to: f.ship_to });
  }

  async serviceOptions(id: string): Promise<PackageServiceOption[]> {
    const { p, f, items } = await this.load(id);
    if (!['open', 'labelled'].includes(p.status)) throw this.illegal(`The package is ${p.status}`, p.status, 'service_options');
    const task = await this.core.ctx.use('orders').getFulfillmentTask(f.seller_group_id);
    const quotes = await this.quotes(p, f, items);
    const priced = Boolean(p.weight) && Boolean(p.dimensions || p.box_type_id);
    const options = quotes.map((q) => ({ q, matches: matchesChoice(q, task.delivery) }));
    const chosen = p.service ? options.find((o) => o.q.serviceName === p.service && o.q.carrierName === p.carrier) : (options.find((o) => o.matches && o.q.keepsPromise) ?? options.find((o) => o.q.keepsPromise));
    return options
      .map(({ q, matches }) => ({
        serviceCode: q.carrierServiceId,
        carrierServiceId: q.carrierServiceId,
        carrier: q.carrierName,
        service: q.serviceName,
        arrivesBy: q.estimatedArrival.to,
        arrivalLabel: `Arrives ${shortDay(q.estimatedArrival.to)}`,
        keepsPromise: q.keepsPromise,
        matchesCustomerChoice: matches,
        rate: priced ? q.cost : null,
        selected: chosen?.q.carrierServiceId === q.carrierServiceId,
      }))
      .sort((a, b) => Number(b.matchesCustomerChoice) - Number(a.matchesCustomerChoice) || Number(b.keepsPromise) - Number(a.keepsPromise) || a.arrivesBy.localeCompare(b.arrivesBy) || (a.rate?.amount ?? 0) - (b.rate?.amount ?? 0));
  }

  /* ---------------------------------------------------------------- labels */

  /** Buys the label through shipping with the chosen service (default: the customer's, when it keeps the promise) */
  async label(id: string, body: { printer?: string | null; format?: 'pdf' | 'zpl' | null }, idempotencyKey: string, by: By): Promise<LabelResult> {
    const cfg = await this.core.cfg();
    const { p, f, items } = await this.load(id);
    this.onHold(f);
    const key = `warehouse:${id}:${idempotencyKey}`;
    const shipping = this.shipping();
    if (p.status === 'labelled' && p.label_idempotency_key === key && p.shipment_id) {
      const s = await shipping.getShipment({ staff: true }, p.shipment_id);
      if (s?.label) return { trackingNumber: s.label.trackingNumber, carrier: s.label.carrierName, service: s.label.serviceName, labelUrl: s.label.labelUrl, format: s.label.format, arrivesBy: s.estimatedArrival?.to ?? null, package: await this.view(id) };
    }
    packageMachine.next(p.status as never, 'label');
    const dims = await this.dims(p);
    const missing = missingForLabel({ allScanned: Packing.scanned(items), hasBoxOrDims: Boolean(dims), hasWeight: Boolean(p.weight) }, cfg.requireItemScan);
    if (missing.length) throw this.core.error('PACKAGE_INCOMPLETE', `Before the label: ${missing.map((m) => (m === 'items' ? 'scan every item' : m === 'box' ? 'choose a box' : 'weigh the package')).join(', ')}`, { missing });
    const task = await this.core.ctx.use('orders').getFulfillmentTask(f.seller_group_id);
    const quotes = await this.quotes(p, f, items);
    let q: LabelQuote | undefined;
    if (p.service) {
      q = quotes.find((x) => x.serviceName === p.service && x.carrierName === p.carrier);
      if (!q) throw invalidField('serviceCode', `${p.service} cannot carry this package now; choose another service`);
      if (!q.keepsPromise) throw this.core.error('SERVICE_BREAKS_PROMISE', `${q.serviceName} would arrive after the date the customer was promised`, { serviceCode: q.carrierServiceId });
    } else q = quotes.find((x) => x.keepsPromise && matchesChoice(x, task.delivery)) ?? quotes.find((x) => x.keepsPromise);
    if (!q) throw this.core.error('SERVICE_BREAKS_PROMISE', 'No carrier service arrives by the date the customer was promised. Ask the Shipping Manager.', {});
    let result;
    try {
      result = await shipping.createLabel(
        // format: zpl for thermal printers, pdf otherwise; the label file comes back in that format
        { groupId: f.seller_group_id, kind: 'outbound', items: items.map((i) => ({ orderItemId: i.order_item_id, quantity: i.quantity })), parcel: parcelOf(p.weight, dims), carrierServiceId: q.carrierServiceId, keepPromise: true, to: f.ship_to, format: body.format ?? 'pdf' },
        key,
      );
    } catch (err) {
      if (isAppError(err) && err.code === 'LABEL_FAILED') throw this.core.error('LABEL_FAILED', err.message, err.details ?? { carrierMessage: null });
      throw err;
    }
    const { label, shipment } = result;
    await this.repo.transaction(async (tx) => {
      const locked = await tx.get('packages', id, { forUpdate: true });
      if (locked?.status === 'labelled' && locked.shipment_id === shipment.id) return;
      if (locked?.status !== 'open') throw this.illegal(`The package is ${locked?.status}`, locked?.status ?? 'open', 'label');
      await tx.update('packages', id, { status: packageMachine.next('open', 'label'), carrier: label.carrierName, service: label.serviceName, tracking_number: label.trackingNumber, shipment_id: shipment.id, label_idempotency_key: key, label_media_id: null });
      await this.core.logScan({ context: 'pack', contextId: id, code: label.trackingNumber, result: `label ${label.carrierName} ${label.serviceName}${body.format ? ` (${body.format})` : ''}`, actor: by.actor, station: body.printer?.trim() || p.station }, tx);
    });
    return { trackingNumber: label.trackingNumber, carrier: label.carrierName, service: label.serviceName, labelUrl: label.labelUrl, format: label.format, arrivesBy: shipment.estimatedArrival?.to ?? q.estimatedArrival.to, package: await this.view(id) };
  }

  /** Voids the carrier label (e.g. wrong service) before packing; the package is open again */
  async voidLabel(id: string, body: { reason: string }, by: By): Promise<Package> {
    const { p, f } = await this.load(id);
    packageMachine.next(p.status as never, 'voidLabel');
    const reason = body.reason?.trim();
    if (!reason) throw invalidField('reason', 'Say why the label is voided');
    const shipping = this.shipping();
    if (p.shipment_id) {
      const s = await shipping.getShipment({ staff: true }, p.shipment_id);
      if (s?.label && s.label.status !== 'voided') await shipping.voidLabel(s.label.id, reason);
    }
    await this.repo.transaction(async (tx) => {
      const locked = await tx.get('packages', id, { forUpdate: true });
      if (locked?.status !== 'labelled') return;
      await tx.update('packages', id, { status: packageMachine.next('labelled', 'voidLabel'), carrier: null, service: null, tracking_number: null, shipment_id: null, label_idempotency_key: null, label_media_id: null });
    });
    await this.core.audit(
      {
        action: 'warehouse.package.void_label',
        actionLabel: 'Voided a shipping label',
        category: 'orders',
        target: { type: 'order', id: f.order_id, ref: f.order_ref, label: `Package ${p.index_in_order} of ${p.of_in_order}`, screen: 'ops/pick-pack' },
        relatedTargets: p.shipment_id ? [{ type: 'shipment', id: p.shipment_id, ref: p.tracking_number }] : null,
        before: { status: p.status, carrier: p.carrier, service: p.service, trackingNumber: p.tracking_number },
        after: { status: 'open' },
        reason,
      },
      by,
    );
    return this.view(id);
  }

  async labelFile(id: string): Promise<FileLink> {
    const p = await this.repo.get('packages', id);
    if (!p) throw notFound('Package');
    if (!LABELLED.includes(p.status) || !p.shipment_id) throw this.core.error('LABEL_REQUIRED', 'The package has no label yet');
    const f = await this.fulfillments.load(p.fulfillment_id);
    const s = await this.shipping().getShipment({ staff: true }, p.shipment_id);
    if (!s?.label || s.label.status === 'voided') throw this.core.error('LABEL_REQUIRED', 'The package has no valid label');
    return { url: s.label.labelUrl, fileName: `label-${f.order_ref}-${s.label.trackingNumber}.${s.label.format}`, expiresAt: new Date(this.core.now().getTime() + 3_600_000).toISOString() };
  }

  /** Only this seller group's items, package n of N, other packages ship separately, returns note */
  async packingSlip(id: string, principal?: Principal | null): Promise<FileLink> {
    const { p, f, items, lines } = await this.load(id);
    const cfg = await this.core.cfg();
    const orders = this.core.ctx.use('orders');
    const soft = <T>(promise: Promise<T>) =>
      promise.catch((err) => {
        if (!isAppError(err)) throw err;
        return null;
      });
    const [task, order] = await Promise.all([soft(orders.getFulfillmentTask(f.seller_group_id)), cfg.packingSlipShowsPrices ? soft(orders.getOrder(f.order_id)) : Promise.resolve(null)]);
    const showPrices = cfg.packingSlipShowsPrices && !task?.hidePricesOnSlip && Boolean(order);
    const priceOf = (orderItemId: string) => order?.groups.flatMap((g) => g.items).find((i) => i.id === orderItemId)?.unitPrice;
    const a = f.ship_to;
    const fmt = (m: common.Money) => `$${(m.amount / 100).toFixed(2)}`;
    const body: PdfLine[] = [
      { text: 'Packing slip', bold: true, size: 14 },
      { text: `Order ${f.order_ref} - Package ${p.index_in_order} of ${p.of_in_order}` },
      { text: `Ship to ${a.name}, ${a.line1}${a.line2 ? `, ${a.line2}` : ''}, ${a.city}, ${a.region} ${a.postalCode}` },
      { text: 'Items in this package', bold: true, gap: 8 },
      ...items.map((it) => {
        const l = lines.find((x) => x.order_item_id === it.order_item_id);
        const price = showPrices ? priceOf(it.order_item_id) : undefined;
        return { text: `${it.quantity} x ${l?.label ?? 'Item'}  (${l?.sku ?? ''})${price ? `  ${fmt(price)} each` : ''}` };
      }),
    ];
    const ours = (await this.repo.find('packages', { fulfillment_id: f.id })).filter((x) => x.status !== 'voided').length;
    const others = Math.max(0, p.of_in_order - ours);
    if (others > 0) body.push({ text: `This order has ${plural(others, 'other package')} from other sellers. They ship separately.`, gap: 8 });
    if (task?.giftNote) body.push({ text: `Gift note: ${task.giftNote}`, gap: 8 });
    body.push({ text: 'Returns: start a return from your Marketly account within the return window shown on your order.', gap: 8, size: 9 });
    body.push({ text: 'Official Store items: Marketly handles the return and the refund.', size: 9 });
    return this.core.fileLink({ fileName: `packing-slip-${f.order_ref}-${p.index_in_order}.pdf`, contentType: 'application/pdf', bytes: renderPdf([body]), principal, reason: 'Packing slip' });
  }

  /* ---------------------------------------------------------------- pack and dispatch */

  /** Packed with its label: shipping takes the package for the carrier pickup */
  async pack(id: string, by: By): Promise<Package> {
    const cfg = await this.core.cfg();
    const { p, f, items, lines: fLines } = await this.load(id);
    this.onHold(f);
    const dims = await this.dims(p);
    if (p.status === 'open') {
      const missing = missingForLabel({ allScanned: Packing.scanned(items), hasBoxOrDims: Boolean(dims), hasWeight: Boolean(p.weight) }, cfg.requireItemScan);
      if (missing.length) throw this.core.error('PACKAGE_INCOMPLETE', 'Scan every item, choose a box and weigh the package, then print the label', { missing });
      throw this.core.error('LABEL_REQUIRED', 'Print the carrier label before packing');
    }
    packageMachine.next(p.status as never, 'pack');
    if (cfg.requireItemScan && !Packing.scanned(items)) throw this.core.error('PACKAGE_INCOMPLETE', 'Scan every item into the package', { missing: ['items'] });
    if (!p.tracking_number || !p.weight) throw this.core.error('LABEL_REQUIRED', 'The package has no valid label');
    const batch = new Batch(by);
    const now = this.core.now();
    let packedAll = false;
    await this.repo.transaction(async (tx) => {
      const fresh = await this.fulfillments.load(f.id, tx, { forUpdate: true });
      this.onHold(fresh);
      const locked = (await tx.get('packages', id, { forUpdate: true }))!;
      const status = packageMachine.next(locked.status as never, 'pack');
      const packed = await tx.update('packages', id, { status, packed_by: actorText(by.actor), packed_at: now });
      const pkgItems = (await tx.find('package_items', { package_id: id })).map((it) => {
        const l = fLines.find((x) => x.order_item_id === it.order_item_id);
        return { orderItemId: it.order_item_id, stockItemId: it.stock_item_id, sku: l?.sku ?? '', label: l?.label ?? '', image: null, quantity: it.quantity, scanned: it.scanned, serialNumbers: [...(it.serial_numbers ?? [])] };
      });
      batch.push('warehouse.package.packed', {
        packageId: id,
        fulfillmentId: f.id,
        orderId: f.order_id,
        sellerGroupId: f.seller_group_id,
        items: pkgItems,
        carrier: packed.carrier ?? '',
        service: packed.service ?? '',
        trackingNumber: packed.tracking_number!,
        weight: packed.weight!,
        dimensions: packed.dimensions ?? dims,
      });
      // the order is packed when every item still wanted is in a packed box and nothing is left on the bench
      const lines = (await tx.find('fulfillment_lines', { fulfillment_id: f.id })).filter((l) => l.state !== 'cancelled');
      const pkgs = (await tx.find('packages', { fulfillment_id: f.id })).filter((x) => x.status !== 'voided');
      const done = pkgs.filter((x) => ['packed', 'dispatched'].includes(x.status));
      const inDone = done.length ? await tx.find('package_items', { package_id: done.map((x) => x.id) }) : [];
      const covered = lines.every((l) => inDone.filter((i) => i.order_item_id === l.order_item_id).reduce((n, i) => n + i.quantity, 0) >= l.quantity);
      if (fresh.status === 'packing' && covered && pkgs.every((x) => ['packed', 'dispatched'].includes(x.status))) {
        await this.fulfillments.move(tx, fresh, 'finishPacking', batch, { reason: plural(pkgs.length, 'package') + ' packed' });
        packedAll = true;
        await this.fulfillments.settleWave(tx, fresh.wave_id);
      }
    });
    this.core.flush(batch);
    if (packedAll) await this.core.soft('workqueues', 'resolve at-risk item', (w) => w.resolveBySource(`pick_pack:${f.id}`, { note: 'Packed', by: by.actor }));
    return this.view(id);
  }

  /** shipping.shipment.dispatched: the package left with the carrier; the order is dispatched with its last package */
  async onShipmentDispatched(e: EventPayload<'shipping.shipment.dispatched'>): Promise<void> {
    if (e.kind === 'return' || e.ownerType !== 'official') return;
    const p = (await this.repo.find('packages', { shipment_id: e.shipmentId }))[0];
    if (!p) return;
    const batch = new Batch({ actor: { kind: 'system', id: null, name: 'Shipping' } });
    await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('packages', p.id, { forUpdate: true }))!;
      if (locked.status === 'dispatched') return;
      if (!packageMachine.can(locked.status as never, 'dispatch')) {
        this.core.ctx.log.warn({ packageId: p.id, status: locked.status }, 'warehouse: shipment dispatched before the package was packed');
        return;
      }
      await tx.update('packages', p.id, { status: packageMachine.next(locked.status as never, 'dispatch') });
      const f = await this.fulfillments.load(p.fulfillment_id, tx, { forUpdate: true });
      const pkgs = (await tx.find('packages', { fulfillment_id: f.id })).filter((x) => x.status !== 'voided');
      if (f.status === 'packed' && pkgs.every((x) => x.status === 'dispatched')) await this.fulfillments.move(tx, f, 'dispatch', batch, { reason: 'Handed to the carrier' });
    });
    this.core.flush(batch);
  }

  async shippedSerials(orderItemIds: string[]): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = Object.fromEntries(orderItemIds.map((id) => [id, [] as string[]]));
    const ids = [...new Set(orderItemIds)];
    if (!ids.length) return out;
    const items = await this.repo.find('package_items', { order_item_id: ids });
    if (!items.length) return out;
    const pkgs = await this.repo.find('packages', { id: [...new Set(items.map((i) => i.package_id))] });
    for (const it of items) {
      if (pkgs.find((x) => x.id === it.package_id)?.status === 'voided') continue;
      out[it.order_item_id] = [...new Set([...(out[it.order_item_id] ?? []), ...(it.serial_numbers ?? [])])];
    }
    return out;
  }
}
