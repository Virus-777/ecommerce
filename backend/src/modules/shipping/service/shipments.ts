/**
 * Shipments: recorded by sellers, bought as labels (sellers, warehouse, returns), handed to the carrier, tracked
 * from carrier webhooks and polling through one status model, corrected with history, and the failed-delivery
 * choice. Missing tracking never implies delivery; deliver only comes from a carrier event or a staff record with proof.
 */
import { zonedDayRange } from '../../../kernel/lib/clock.js';
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { money } from '../../../kernel/lib/money.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type * as orders from '../../../spec/orders.js';
import type {
  DeliveryChoiceOption,
  DispatchMetrics,
  FailedDeliveryInfo,
  Label,
  LabelQuote,
  LabelRequest,
  LabelResult,
  OtherPackage,
  Parcel,
  RecordShipmentInput,
  Shipment,
  ShipmentLineInput,
  ShipmentSummary,
  TrackingView,
} from '../../../spec/shipping.js';
import { addDays, arrivalRange, HOUR_MS, DAY_MS, MON_FRI, onOrAfter, type DayRules } from '../domain/calendar.js';
import { labelMachine, shipmentMachine } from '../domain/state-machines.js';
import { EVENT_LABELS, formatOk, MOVING, normalizeCode, normalizeTracking, pathFor, STEPS, stepOf, statusLabel, trackingUrlOf, type ShipmentStatus, type TrackingCode } from '../domain/tracking.js';
import { CarrierRefused, type CarrierRec, type CarrierScan, type LabelRec, type LineRec, type ServiceRec, type ShipmentRec } from '../ports.js';
import { Batch, byMarketly, fulfilledByOf, invalid, iso, notFound, SYSTEM, type By, type Core, type FulfilledBy } from './core.js';
import type { Estimates, Owner } from './estimates.js';
import type { Exceptions } from './exceptions.js';
import type { Profiles } from './profiles.js';
import { carrierNameOf, labelCarrier, type BilledTo, type Views } from './views.js';

export interface GroupCtx {
  task: orders.FulfillmentTask;
  order: orders.OrderDetail | null;
  group: orders.SellerGroup | null;
  owner: Owner;
  /** marketly_service: a seller's package Marketly's warehouse ships (the seller owns it but has no part in dispatch) */
  fulfilledBy: FulfilledBy;
}

export interface ShopperViewer {
  customerId?: string | null;
  guestSessionId?: string | null;
}

const WEEKDAYS_ONLY: DayRules = { days: MON_FRI, closed: () => false };
const QUOTE_TTL_MS = 30 * 60_000;
const ACTIVE_FOR_TRACKING = ['label_created', 'shipped', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'held_for_pickup', 'returning', 'returned_to_sender', 'lost'];
export const HELP_NOTE = "If tracking shows delivered but you don't have it, wait until the end of the next day, then report it.";

export class Shipments {
  exceptions!: Exceptions;

  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly estimates: Estimates,
    private readonly profiles: Profiles,
  ) {}

  private get repo() {
    return this.core.repo;
  }
  private get orders() {
    return this.core.ctx.use('orders');
  }

  /* ---------------------------------------------------------------- loading */

  async groupContext(groupId: string, owner?: Owner): Promise<GroupCtx> {
    let task: orders.FulfillmentTask;
    try {
      task = await this.orders.getFulfillmentTask(groupId);
    } catch (err) {
      if (isAppError(err) && err.status === 404) throw notFound('Order');
      throw err;
    }
    const ownerType = task.seller.ownerType;
    const sellerId = ownerType === 'official' ? null : (task.seller.id ?? null);
    if (owner && (owner.ownerType !== ownerType || (owner.ownerType === 'seller' && owner.sellerId !== sellerId))) throw notFound('Order');
    const order = await this.orders.getOrder(task.orderId).catch(() => null);
    return { task, order, group: order?.groups.find((g) => g.id === groupId) ?? null, owner: { ownerType, sellerId }, fulfilledBy: fulfilledByOf(ownerType, task.fulfilledBy) };
  }

  async load(id: string): Promise<ShipmentRec> {
    const s = await this.repo.get('shipments', id);
    if (!s) throw notFound('Shipment');
    return s;
  }

  /** A shipment of the seller (another seller's or the Official Store's: NOT_FOUND) */
  async own(id: string, sellerId: string): Promise<ShipmentRec> {
    const s = await this.repo.get('shipments', id);
    if (!s || s.owner_type !== 'seller' || s.seller_id !== sellerId) throw notFound('Shipment');
    return s;
  }

  async visibleToShopper(orderId: string, viewer: ShopperViewer): Promise<boolean> {
    const order = await this.orders.getOrder(orderId).catch(() => null);
    if (!order) return false;
    if (viewer.customerId && order.contact.customerId === viewer.customerId) return true;
    if (viewer.guestSessionId) return Boolean(await this.core.soft('identity', 'guest order access', (i) => i.hasGuestOrderAccess(viewer.guestSessionId!, orderId)));
    return false;
  }

  async carrierByCode(code: string): Promise<CarrierRec | undefined> {
    await this.core.ensureSeeded();
    return (await this.repo.find('carriers', { code: code.trim().toLowerCase() }))[0];
  }

  /* ---------------------------------------------------------------- views */

  async view(s: ShipmentRec, principal?: Principal | null): Promise<Shipment> {
    return (await this.views.shipments([s], principal))[0]!;
  }

  async listSeller(sellerId: string, q: { status?: string | null; q?: string | null; groupId?: string | null }, page: PageRequest): Promise<common.Page<ShipmentSummary>> {
    const r = await this.repo.page(
      'shipments',
      { owner_type: 'seller', seller_id: sellerId, ...(q.status ? { status: q.status } : {}), ...(q.groupId ? { group_id: q.groupId } : {}) },
      page,
      { order: { column: 'created_at', direction: 'desc' }, ...(q.q ? { search: { columns: ['order_ref', 'tracking_number'], term: q.q } } : {}) },
    );
    return { ...r, items: await this.views.summaries(r.items) };
  }

  async listAdmin(q: { q?: string | null; carrierCode?: string | null; status?: string | null; sellerType?: string | null; sellerId?: string | null; kind?: string | null }, page: PageRequest): Promise<common.Page<ShipmentSummary>> {
    const r = await this.repo.page(
      'shipments',
      {
        ...(q.carrierCode ? { carrier_code: q.carrierCode } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.sellerType === 'official' ? { owner_type: 'official' } : q.sellerType === 'marketplace' ? { owner_type: 'seller' } : {}),
        ...(q.sellerId ? { seller_id: q.sellerId } : {}),
        ...(q.kind ? { kind: q.kind } : {}),
      },
      page,
      { order: { column: 'created_at', direction: 'desc' }, ...(q.q ? { search: { columns: ['order_ref', 'tracking_number'], term: q.q } } : {}) },
    );
    return { ...r, items: await this.views.summaries(r.items) };
  }

  async forOrder(orderId: string): Promise<ShipmentSummary[]> {
    const rows = await this.repo.find('shipments', { order_id: orderId }, { orderBy: [['package_no', 'asc'], ['created_at', 'asc']] });
    return this.views.summaries(rows);
  }

  async forGroups(groupIds: string[], kinds: string[] = ['outbound', 'replacement'], principal?: Principal | null): Promise<Map<string, Shipment[]>> {
    const out = new Map<string, Shipment[]>(groupIds.map((g) => [g, []]));
    if (!groupIds.length) return out;
    const rows = await this.repo.find('shipments', { group_id: groupIds, kind: kinds }, { orderBy: [['package_no', 'asc'], ['created_at', 'asc']] });
    for (const s of await this.views.shipments(rows, principal)) out.get(s.groupId)?.push(s);
    return out;
  }

  /** Tracking view for the store: headline, estimate, steps, other packages and notices */
  async trackingView(s: ShipmentRec): Promise<TrackingView> {
    const parts = await this.views.parts([s]);
    const summary = this.views.summary(s, parts);
    const order = await this.orders.getOrder(s.order_id).catch(() => null);
    const others = await this.repo.find('shipments', { order_id: s.order_id, kind: ['outbound', 'replacement'], status: { op: '<>', value: 'cancelled' } }, { orderBy: [['package_no', 'asc']] });
    const otherParts = await this.views.parts(others);
    const otherPackages: OtherPackage[] = others
      .filter((o) => o.id !== s.id)
      .map((o) => ({ shipmentId: o.id, label: this.views.packageLabel(o, otherParts), sellerName: this.core.nameOf(otherParts.names, o.owner_type, o.seller_id), status: statusLabel(o.status, o.tracking_state, o.kind) }));
    for (const g of order?.groups ?? []) {
      if (g.status === 'cancelled' || others.some((o) => o.group_id === g.id)) continue;
      otherPackages.push({ shipmentId: null, label: g.packageLabel, sellerName: g.seller.name, status: g.statusLabel || 'Not shipped yet' });
    }
    const to = s.to_address;
    const notices = await this.estimates.activeNotices(to.postalCode ?? undefined, s.carrier_code ? [s.carrier_code] : undefined, 'tracking');
    return {
      shipment: summary,
      orderRef: s.order_ref,
      carrier: { name: carrierNameOf(s.carrier_code) ?? 'Carrier not set', trackingNumber: s.tracking_number, externalUrl: trackingUrlOf(s.carrier_code, s.tracking_number) },
      headline: headlineOf(s),
      estimate: s.status === 'delivered' ? null : s.estimated_arrival,
      estimateNote: estimateNoteOf(s),
      steps: STEPS,
      currentStep: stepOf(s.status),
      failedDelivery: s.failed_delivery,
      events: (parts.events.get(s.id) ?? []).map((e) => this.views.event(e)),
      contents: this.views.contents(parts.lines.get(s.id) ?? []),
      seller: this.core.nameOf(parts.names, s.owner_type, s.seller_id),
      shipsFrom: s.ship_from,
      otherPackages,
      notices,
      helpNote: HELP_NOTE,
    };
  }

  async shopperShipment(id: string, viewer: ShopperViewer): Promise<ShipmentRec> {
    const s = await this.repo.get('shipments', id);
    if (!s || !(await this.visibleToShopper(s.order_id, viewer))) throw notFound('Shipment');
    return s;
  }

  async getForViewer(viewer: { customerId?: string; guestSessionId?: string; sellerId?: string; staff?: boolean }, id: string, principal?: Principal | null): Promise<Shipment | null> {
    const s = await this.repo.get('shipments', id);
    if (!s) return null;
    if (viewer.staff) return this.view(s, principal);
    if (viewer.sellerId) return s.owner_type === 'seller' && s.seller_id === viewer.sellerId ? this.view(s, principal) : null;
    if ((viewer.customerId || viewer.guestSessionId) && (await this.visibleToShopper(s.order_id, viewer))) return this.view(s, principal);
    return null;
  }

  /**
   * The replacement shipment of each replacement: by its return, or, for a replacement decided on a case (no
   * return), by the replacement's order items on the shipment's lines. Newest first; cancelled shipments never count.
   */
  async forReplacements(replacements: { replacementId: string; returnId: string | null; orderItemIds?: string[] | null }[]): Promise<Record<string, Shipment | null>> {
    const out: Record<string, Shipment | null> = {};
    for (const r of replacements) out[r.replacementId] = null;
    const returnIds = [...new Set(replacements.map((r) => r.returnId).filter((x): x is string => Boolean(x)))];
    const itemIds = [...new Set(replacements.filter((r) => !r.returnId).flatMap((r) => r.orderItemIds ?? []))];
    const live = { kind: 'replacement', status: { op: '<>', value: 'cancelled' } } as const;
    const byReturn = returnIds.length ? await this.repo.find('shipments', { ...live, return_id: returnIds }, { orderBy: [['created_at', 'desc']] }) : [];
    const lines = itemIds.length ? await this.repo.find('shipment_lines', { order_item_id: itemIds }) : [];
    const byItems = lines.length ? await this.repo.find('shipments', { ...live, id: [...new Set(lines.map((l) => l.shipment_id))] }, { orderBy: [['created_at', 'desc']] }) : [];
    const rows = [...byReturn, ...byItems.filter((s) => !byReturn.some((x) => x.id === s.id))].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    if (!rows.length) return out;
    const views = new Map((await this.views.shipments(rows)).map((v) => [v.id, v]));
    for (const r of replacements) {
      const match = r.returnId
        ? rows.find((s) => s.return_id === r.returnId)
        : rows.find((s) => lines.some((l) => l.shipment_id === s.id && (r.orderItemIds ?? []).includes(l.order_item_id)));
      out[r.replacementId] = match ? (views.get(match.id) ?? null) : null;
    }
    return out;
  }

  /* ---------------------------------------------------------------- items and package facts */

  /** Units already on labels that are not handed over yet, per order item */
  private async pendingUnits(groupId: string, exceptShipmentId?: string): Promise<Map<string, number>> {
    const waiting = (await this.repo.find('shipments', { group_id: groupId, status: 'label_created', kind: ['outbound', 'replacement'] })).filter((s) => s.id !== exceptShipmentId);
    const out = new Map<string, number>();
    if (!waiting.length) return out;
    for (const l of await this.repo.find('shipment_lines', { shipment_id: waiting.map((s) => s.id) })) out.set(l.order_item_id, (out.get(l.order_item_id) ?? 0) + l.quantity);
    return out;
  }

  /** Items belong to the group, are unshipped and the quantities fit (orders.canShipItems plus units on unused labels) */
  async checkItems(g: GroupCtx, items: readonly ShipmentLineInput[], exceptShipmentId?: string) {
    const problems: string[] = [];
    if (!items.length) problems.push('Choose the items in this package');
    const r = items.length ? await this.orders.canShipItems(g.task.groupId, items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity }))) : { ok: false, problems: [] };
    problems.push(...r.problems);
    if (!problems.length) {
      const pending = await this.pendingUnits(g.task.groupId, exceptShipmentId);
      const wanted = new Map<string, number>();
      for (const i of items) wanted.set(i.orderItemId, (wanted.get(i.orderItemId) ?? 0) + i.quantity);
      for (const [id, qty] of wanted) {
        const open = g.task.openLines.find((l) => l.orderItemId === id);
        const waiting = pending.get(id) ?? 0;
        if (open && waiting && qty + waiting > open.quantityToShip) problems.push(`${open.title}: ${waiting} already on a label, at most ${Math.max(0, open.quantityToShip - waiting)} left to ship`);
      }
    }
    if (problems.length) throw this.core.error('ITEMS_NOT_SHIPPABLE', problems[0] ?? 'These items cannot ship', { items: problems });
  }

  linesOf(g: GroupCtx, items: readonly ShipmentLineInput[], shipmentId: string): LineRec[] {
    const merged = new Map<string, number>();
    for (const i of items) merged.set(i.orderItemId, (merged.get(i.orderItemId) ?? 0) + i.quantity);
    return [...merged].map(([id, quantity]) => {
      const open = g.task.openLines.find((l) => l.orderItemId === id);
      const item = g.group?.items.find((x) => x.id === id);
      return { shipment_id: shipmentId, order_item_id: id, title: open?.title ?? item?.title ?? 'Item', variant_label: open?.variantLabel ?? item?.variantLabel ?? '', quantity };
    });
  }

  /** Replacement parcels: the items are replacements of returned items */
  kindOf(g: GroupCtx, items: readonly ShipmentLineInput[]): { kind: 'outbound' | 'replacement'; returnId: string | null } {
    const all = g.order?.groups.flatMap((x) => x.items) ?? [];
    for (const i of items) {
      const item = all.find((x) => x.id === i.orderItemId);
      if (item?.replacementOfItemId) {
        const original = all.find((x) => x.id === item.replacementOfItemId);
        return { kind: 'replacement', returnId: original?.afterSales.returnId ?? null };
      }
    }
    return { kind: 'outbound', returnId: null };
  }

  async nextPackageNo(orderId: string): Promise<number> {
    return (await this.repo.count('shipments', { order_id: orderId, kind: ['outbound', 'replacement'] })) + 1;
  }

  estimateAfter(shippedAt: Date, transit: { min: number; max: number } | null, fallback: common.DateRange | null | undefined): common.DateRange | null {
    if (!transit) return fallback ?? null;
    return arrivalRange(onOrAfter(this.core.today(shippedAt), WEEKDAYS_ONLY), transit, WEEKDAYS_ONLY, WEEKDAYS_ONLY).range;
  }

  private async servicesOfCarrier(carrierId: string): Promise<ServiceRec[]> {
    return this.repo.find('carrier_services', { carrier_id: carrierId });
  }

  /** Format check against the service's pattern (or any of the carrier's) */
  checkFormat(trackingNumber: string, services: readonly ServiceRec[], service: ServiceRec | null): boolean {
    return formatOk(trackingNumber, service ? [service.tracking_pattern] : services.map((s) => s.tracking_pattern));
  }

  async assertUnused(carrierCode: string, trackingNumber: string, exceptId?: string) {
    const same = (await this.repo.find('shipments', { carrier_code: carrierCode, tracking_number: trackingNumber, status: ACTIVE_FOR_TRACKING })).filter((s) => s.id !== exceptId);
    if (same.length) throw this.core.error('TRACKING_ALREADY_USED', 'This tracking number is already on another package. Check the number.');
  }

  /* ---------------------------------------------------------------- dispatch */

  /** Dispatch facts and events once a package is with the carrier (inside the transaction) */
  private dispatched(batch: Batch, s: ShipmentRec, lines: readonly LineRec[]) {
    batch.push('shipping.shipment.dispatched', {
      shipmentId: s.id,
      kind: s.kind as 'outbound',
      orderId: s.order_id,
      groupId: s.group_id,
      returnId: s.return_id,
      ownerType: s.owner_type as 'seller',
      sellerId: s.seller_id,
      fulfilledBy: fulfilledByOf(s.owner_type, s.fulfilled_by),
      lines: this.views.contents(lines),
      shippedAt: (s.shipped_at ?? this.core.now()).toISOString(),
      dispatchDueAt: iso(s.dispatch_due_at),
      onTime: s.dispatched_on_time,
      trackingValid: s.tracking_state === 'valid' || s.tracking_state === 'pending',
      estimatedArrival: s.estimated_arrival,
    });
  }

  private created(batch: Batch, s: ShipmentRec, lines: readonly LineRec[], packageLabel: string) {
    batch.push('shipping.shipment.created', {
      shipmentId: s.id,
      kind: s.kind as 'outbound',
      orderId: s.order_id,
      groupId: s.group_id,
      returnId: s.return_id,
      sellerId: s.seller_id,
      fulfilledBy: fulfilledByOf(s.owner_type, s.fulfilled_by),
      packageLabel,
      carrierCode: s.carrier_code,
      carrierName: carrierNameOf(s.carrier_code),
      serviceName: s.service_name,
      trackingNumber: s.tracking_number,
      trackingUrl: trackingUrlOf(s.carrier_code, s.tracking_number),
      lines: this.views.contents(lines),
      status: s.status,
    });
  }

  private statusChanged(batch: Batch, s: ShipmentRec, from: string, to: string, at: Date) {
    batch.push('shipping.shipment.status_changed', {
      shipmentId: s.id,
      kind: s.kind as 'outbound',
      orderId: s.order_id,
      groupId: s.group_id,
      returnId: s.return_id,
      from,
      to,
      statusLabel: statusLabel(to, s.tracking_state, s.kind),
      estimatedArrival: s.estimated_arrival,
      at: at.toISOString(),
    });
  }

  /** After a dispatch: the watch keeps what is left to ship; late dispatch closes when nothing is left */
  async afterDispatch(s: ShipmentRec, g?: GroupCtx) {
    if (s.kind === 'return') return;
    const task = g?.task ?? (await this.orders.getFulfillmentTask(s.group_id).catch(() => null));
    if (!task) return;
    const lines = await this.repo.find('shipment_lines', { shipment_id: s.id });
    const shipped = new Map(lines.map((l) => [l.order_item_id, l.quantity]));
    // other packages already dispatched may not have reached orders yet
    const left = task.openLines.filter((l) => (shipped.get(l.orderItemId) ?? 0) < l.quantityToShip).map((l) => l.orderItemId);
    if (!left.length) {
      await this.repo.removeWhere('dispatch_watch', { group_id: s.group_id });
      await this.exceptions.clear({ groupId: s.group_id, kinds: ['late_dispatch'] }, 'shipped', s.dispatched_on_time === false ? 'Shipped after the deadline' : 'Shipped');
    } else {
      await this.repo.updateWhere('dispatch_watch', { group_id: s.group_id }, { open_item_ids: left });
    }
  }

  /** Matches webhook events stored before the package was known */
  async matchStored(s: ShipmentRec) {
    if (!s.carrier_code || !s.tracking_number) return;
    const stored = await this.repo.find('webhook_events', { carrier_code: s.carrier_code, processed_at: null }, { orderBy: [['received_at', 'asc']], limit: 200 });
    for (const w of stored) {
      const scan = w.payload as Partial<CarrierScan>;
      if (normalizeTracking(scan.trackingNumber) !== s.tracking_number || !scan.code || !scan.id) continue;
      await this.applyScan(s.id, { code: normalizeCode(scan.code), at: new Date(scan.at ?? this.core.now()), detail: scan.description ?? null, location: scan.location ?? null, source: 'carrier_webhook', carrierEventId: scan.id }, { actor: SYSTEM });
      await this.repo.update('webhook_events', w.id, { processed_at: this.core.now(), error: null });
    }
  }

  /* ---------------------------------------------------------------- record a shipment (seller) */

  async record(owner: Owner, input: RecordShipmentInput, by: By, source: 'seller' | 'warehouse' = 'seller'): Promise<Shipment> {
    const g = await this.groupContext(input.groupId, owner);
    // the warehouse records Marketly's packages; the seller never does
    if (source === 'seller') this.core.refuseIfMarketly(g.fulfilledBy);
    if (input.labelId) return this.recordWithLabel(g, input, by);
    await this.checkItems(g, input.items);
    const carrier = await this.carrierByCode(input.carrierCode);
    if (!carrier || carrier.status !== 'active') throw invalid([{ path: 'carrierCode', message: 'Choose one of the listed carriers' }]);
    const services = await this.servicesOfCarrier(carrier.id);
    let service: ServiceRec | null = null;
    if (input.carrierServiceId) {
      service = services.find((s) => s.id === input.carrierServiceId) ?? null;
      if (!service) throw invalid([{ path: 'carrierServiceId', message: `Not a ${carrier.name} service` }]);
    } else if (input.serviceName) service = services.find((s) => s.name.toLowerCase() === input.serviceName!.trim().toLowerCase() || s.code === input.serviceName!.trim().toLowerCase()) ?? null;
    const tracking = normalizeTracking(input.trackingNumber);
    if (!tracking && carrier.code !== 'other') throw invalid([{ path: 'trackingNumber', message: 'Enter the tracking number' }]);
    let trackingState: 'pending' | 'invalid' | 'missing' = tracking ? 'pending' : 'missing';
    if (tracking && !this.checkFormat(tracking, services, service)) {
      if (!input.acknowledgeFormatWarning) throw this.core.error('TRACKING_FORMAT_INVALID', `This does not look like a ${carrier.name} tracking number. Check it, or save it anyway.`, { carrierCode: carrier.code, pattern: service?.tracking_pattern ?? null });
      trackingState = 'invalid';
    }
    if (tracking) await this.assertUnused(carrier.code, tracking);
    const shippedAt = new Date(input.shippedAt);
    const now = this.core.now();
    if (Number.isNaN(shippedAt.getTime()) || shippedAt.getTime() > now.getTime() + HOUR_MS) throw invalid([{ path: 'shippedAt', message: 'The ship date cannot be in the future' }]);
    const { kind, returnId } = this.kindOf(g, input.items);
    const due = new Date(g.task.dispatchDeadline.dueAt);
    const id = newId();
    const batch = new Batch(by);
    const packageNo = await this.nextPackageNo(g.task.orderId);
    const lines = this.linesOf(g, input.items, id);
    const s = await this.repo.transaction(async (tx) => {
      const row = await tx.insert('shipments', {
        id,
        kind,
        order_id: g.task.orderId,
        order_ref: g.task.orderRef,
        group_id: g.task.groupId,
        return_id: returnId,
        owner_type: g.owner.ownerType,
        seller_id: g.owner.sellerId,
        fulfilled_by: g.fulfilledBy,
        package_no: packageNo,
        carrier_code: carrier.code,
        service_name: service?.name ?? input.serviceName?.trim() ?? null,
        tracking_number: tracking || null,
        tracking_state: trackingState,
        status: shipmentMachine.initial,
        ship_from: g.group?.shipsFrom ?? '',
        to_address: g.task.shipTo,
        shipped_at: null,
        dispatch_due_at: due,
        dispatched_on_time: null,
        estimated_arrival: null,
        delivered_at: null,
        failed_delivery: null,
        recorded_by: by.actor,
        created_at: now,
      });
      await tx.insertMany('shipment_lines', lines);
      // recorded with tracking: created and handed over in the same transaction
      const after = await tx.update('shipments', id, {
        status: shipmentMachine.next(row.status as never, 'hand_over'),
        shipped_at: shippedAt,
        dispatched_on_time: shippedAt.getTime() <= due.getTime(),
        estimated_arrival: this.estimateAfter(shippedAt, service ? { min: service.transit_min, max: service.transit_max } : null, g.task.delivery.arrival),
      });
      await tx.insert('tracking_events', { id: newId(), shipment_id: id, code: 'info', label: source === 'warehouse' ? 'Handed to the carrier by the warehouse' : 'Shipment recorded by the seller', detail: tracking ? `${carrier.name} ${tracking}` : `${carrier.name}, no tracking number`, location: null, source, carrier_event_id: null, at: shippedAt });
      this.created(batch, { ...after, status: 'label_created' }, lines, `Package ${packageNo}`);
      this.statusChanged(batch, after, 'label_created', after.status, shippedAt);
      this.dispatched(batch, after, lines);
      return after;
    });
    await this.core.flush(batch);
    await this.afterDispatch(s, g);
    if (trackingState !== 'pending') {
      await this.exceptions.openMissingTracking(s, trackingState === 'missing' ? `${carrier.name}: shipped without a tracking number` : `${carrier.name} number not recognized`, by);
    }
    await this.matchStored(s);
    return this.view((await this.repo.get('shipments', id))!, by.principal);
  }

  /** Recording a shipment for a bought label hands that package over */
  private async recordWithLabel(g: GroupCtx, input: RecordShipmentInput, by: By): Promise<Shipment> {
    const label = await this.repo.get('labels', input.labelId!);
    if (!label || label.group_id !== g.task.groupId || !label.shipment_id) throw notFound('Label');
    const s = await this.load(label.shipment_id);
    const at = new Date(input.shippedAt);
    return this.handOver(s.id, Number.isNaN(at.getTime()) ? this.core.now().toISOString() : at.toISOString(), by.actor, by);
  }

  /* ---------------------------------------------------------------- hand over */

  async handOver(shipmentId: string, at: string, actor: common.Actor, by: By = { actor }): Promise<Shipment> {
    const when = new Date(at);
    const shippedAt = Number.isNaN(when.getTime()) ? this.core.now() : when;
    const batch = new Batch(by);
    const known = await this.repo.get('shipments', shipmentId);
    if (!known) throw notFound('Shipment');
    // read before the transaction: on one connection a query outside it would wait for it
    const service = await this.serviceOfShipment(known);
    const s = await this.repo.transaction(async (tx) => {
      const before = await tx.get('shipments', shipmentId, { forUpdate: true });
      if (!before) throw notFound('Shipment');
      const status = shipmentMachine.next(before.status as never, 'hand_over');
      const lines = await tx.find('shipment_lines', { shipment_id: shipmentId });
      const after = await tx.update('shipments', shipmentId, {
        status,
        shipped_at: shippedAt,
        dispatched_on_time: before.dispatch_due_at ? shippedAt.getTime() <= before.dispatch_due_at.getTime() : null,
        estimated_arrival: this.estimateAfter(shippedAt, service ? { min: service.transit_min, max: service.transit_max } : null, before.estimated_arrival),
      });
      await tx.insert('tracking_events', { id: newId(), shipment_id: shipmentId, code: 'info', label: 'Handed to the carrier', detail: null, location: null, source: actor.kind === 'seller' ? 'seller' : 'warehouse', carrier_event_id: null, at: shippedAt });
      this.statusChanged(batch, after, before.status, status, shippedAt);
      this.dispatched(batch, after, lines);
      return after;
    });
    await this.core.flush(batch);
    await this.afterDispatch(s);
    return this.view(s, by.principal);
  }

  /** Seller Center: the seller's own labelled package; Marketly's warehouse hands its packages over itself */
  async handOverSeller(sellerId: string, shipmentId: string, at: string, by: By): Promise<Shipment> {
    const s = await this.own(shipmentId, sellerId);
    this.core.refuseIfMarketly(s.fulfilled_by);
    return this.handOver(shipmentId, at, by.actor, by);
  }

  private async serviceOfShipment(s: ShipmentRec): Promise<ServiceRec | null> {
    const label = (await this.repo.find('labels', { shipment_id: s.id }, { limit: 1 }))[0];
    if (label) return (await this.repo.get('carrier_services', label.carrier_service_id)) ?? null;
    if (!s.carrier_code || !s.service_name) return null;
    const carrier = await this.carrierByCode(s.carrier_code);
    if (!carrier) return null;
    return (await this.servicesOfCarrier(carrier.id)).find((x) => x.name === s.service_name) ?? null;
  }

  /* ---------------------------------------------------------------- labels */

  private async labelServices(): Promise<{ service: ServiceRec; carrier: CarrierRec }[]> {
    await this.core.ensureSeeded();
    const [carriers, services] = await Promise.all([this.repo.find('carriers', { status: 'active' }), this.repo.find('carrier_services', { enabled: true, label_supported: true })]);
    return services.flatMap((s) => {
      const carrier = carriers.find((c) => c.id === s.carrier_id);
      return carrier ? [{ service: s, carrier }] : [];
    });
  }

  private speedOf(s: ServiceRec) {
    return s.transit_max <= 1 ? 'overnight' : s.transit_max <= 3 ? 'two_day' : 'ground';
  }

  /** Quotes per label-capable service: cost, arrival and whether it keeps the promised range */
  private async quotesFor(g: GroupCtx, parcel: Parcel, o: { kind: string; to?: Partial<common.Address> | null; from?: Partial<common.Address> | null }): Promise<LabelQuote[]> {
    const options = await this.labelServices();
    if (!options.length) throw this.core.error('LABELS_NOT_SUPPORTED', 'No carrier service can sell a label for this package. Enter tracking manually.');
    const now = this.core.now();
    const promise = g.task.delivery.arrival;
    const toZip = (o.to?.postalCode ?? g.task.shipTo.postalCode ?? '').toString();
    const fromZip = o.from?.postalCode ? String(o.from.postalCode) : null;
    const out: LabelQuote[] = [];
    for (const { service, carrier } of options) {
      let cost: common.Money;
      try {
        cost = await this.core.carriers.rate({ carrierCode: carrier.code, serviceCode: service.code, speed: this.speedOf(service), parcel, fromPostalCode: fromZip, toPostalCode: toZip, currency: this.core.currency });
      } catch (err) {
        if (err instanceof CarrierRefused) continue;
        throw err;
      }
      const estimatedArrival = this.estimateAfter(now, { min: service.transit_min, max: service.transit_max }, null)!;
      const keepsPromise = o.kind === 'return' || !promise ? true : estimatedArrival.to <= promise.to;
      const row = await this.repo.insert('label_quotes', { id: newId(), group_id: g.task.groupId, carrier_service_id: service.id, cost: cost.amount, parcel, estimated_arrival: estimatedArrival, keeps_promise: keepsPromise, expires_at: new Date(now.getTime() + QUOTE_TTL_MS) });
      out.push({ id: row.id, carrierServiceId: service.id, carrierName: carrier.name, serviceName: service.name, cost, estimatedArrival, keepsPromise, expiresAt: row.expires_at.toISOString() });
    }
    if (!out.length) throw this.core.error('LABELS_NOT_SUPPORTED', 'No carrier can carry this package. Enter tracking manually.');
    return out.sort((a, b) => Number(b.keepsPromise) - Number(a.keepsPromise) || a.cost.amount - b.cost.amount);
  }

  /** Where an outbound package of the group starts: the service location for Fulfilled by Marketly groups, else not known here */
  private async originOf(g: GroupCtx): Promise<common.Address | null> {
    return byMarketly(g.fulfilledBy) ? ((await this.core.serviceLocation())?.address ?? null) : null;
  }

  async quoteLabels(sellerId: string, body: { groupId: string; items: ShipmentLineInput[]; parcel: Parcel }): Promise<LabelQuote[]> {
    const g = await this.groupContext(body.groupId, { ownerType: 'seller', sellerId });
    this.core.refuseIfMarketly(g.fulfilledBy);
    if (!(body.parcel.weightGrams > 0)) throw invalid([{ path: 'parcel.weightGrams', message: 'Enter the package weight' }]);
    await this.checkItems(g, body.items);
    return this.quotesFor(g, body.parcel, { kind: 'outbound' });
  }

  async quoteLabelOptions(input: LabelRequest): Promise<LabelQuote[]> {
    const g = await this.groupContext(input.groupId);
    if (input.kind !== 'return' && input.items.length) await this.checkItems(g, input.items);
    const from = input.from ?? (input.kind === 'return' ? null : await this.originOf(g));
    const quotes = await this.quotesFor(g, input.parcel, { kind: input.kind, to: input.to ?? null, from });
    return input.keepPromise ? quotes.filter((q) => q.keepsPromise) : quotes;
  }

  /** Seller Center: buy the quoted label (cost deducted from earnings) */
  async buyLabel(sellerId: string, body: { quoteId: string; items: ShipmentLineInput[] }, idempotencyKey: string, by: By): Promise<LabelResult> {
    const key = `seller:${sellerId}:${idempotencyKey}`;
    const existing = (await this.repo.find('labels', { idempotency_key: key }))[0];
    if (existing) return this.labelResult(existing, by.principal);
    const quote = await this.repo.get('label_quotes', body.quoteId);
    if (!quote) throw notFound('Label quote');
    const g = await this.groupContext(quote.group_id, { ownerType: 'seller', sellerId });
    this.core.refuseIfMarketly(g.fulfilledBy);
    if (quote.expires_at.getTime() < this.core.now().getTime()) throw this.core.error('QUOTE_EXPIRED', 'This label price has expired. Get a new quote.');
    const result = await this.purchase(g, {
      kind: 'outbound',
      items: body.items,
      parcel: quote.parcel,
      serviceId: quote.carrier_service_id,
      cost: money(quote.cost, this.core.currency),
      billedTo: 'seller',
      key,
      from: null,
      to: g.task.shipTo,
      returnId: null,
      qr: false,
      format: 'pdf',
      dropOffBy: null,
    }, by);
    await this.profiles.rememberParcel(sellerId, quote.parcel);
    return result;
  }

  /** In-process label purchase (warehouse, returns, fulfillment service) */
  async createLabel(input: LabelRequest, idempotencyKey: string, by: By = { actor: SYSTEM }): Promise<LabelResult> {
    const key = `api:${idempotencyKey}`;
    const existing = (await this.repo.find('labels', { idempotency_key: key }))[0];
    if (existing) return this.labelResult(existing, by.principal);
    const g = await this.groupContext(input.groupId);
    if (input.kind === 'return' && !input.to) throw invalid([{ path: 'to', message: 'Return labels need the return address' }]);
    if (input.kind === 'return' && !input.returnId) throw invalid([{ path: 'returnId', message: 'Return labels need the return' }]);
    if (input.format && input.format !== 'pdf' && input.format !== 'zpl') throw invalid([{ path: 'format', message: 'Choose pdf or zpl' }]);
    if (input.dropOffBy && Number.isNaN(new Date(input.dropOffBy).getTime())) throw invalid([{ path: 'dropOffBy', message: 'Give a date and time' }]);
    const options = await this.labelServices();
    let pick = input.carrierServiceId ? options.find((o) => o.service.id === input.carrierServiceId) : input.serviceCode ? options.find((o) => o.service.code === input.serviceCode || `${o.carrier.code}:${o.service.code}` === input.serviceCode) : undefined;
    if ((input.carrierServiceId || input.serviceCode) && !pick) throw this.core.error('LABELS_NOT_SUPPORTED', 'This carrier service cannot sell labels. Enter tracking manually.');
    // a Fulfilled by Marketly package leaves from the service location (the label is billed to the seller, decision D1)
    const from = input.from ?? (input.kind === 'return' ? null : await this.originOf(g));
    const quotes = await this.quotesFor(g, input.parcel, { kind: input.kind, to: input.to ?? null, from });
    if (!pick) {
      const best = (input.keepPromise ? quotes.filter((q) => q.keepsPromise) : quotes)[0];
      if (!best) throw invalid([{ path: 'keepPromise', message: 'No carrier service arrives within the promised dates' }]);
      pick = options.find((o) => o.service.id === best.carrierServiceId)!;
    }
    const q = quotes.find((x) => x.carrierServiceId === pick!.service.id);
    if (!q) throw this.core.error('LABELS_NOT_SUPPORTED', 'This carrier service cannot carry the package. Enter tracking manually.');
    if (input.keepPromise && !q.keepsPromise) throw invalid([{ path: 'carrierServiceId', message: `${pick.service.name} would arrive after the date promised to the customer` }]);
    const billedTo = input.billedTo ?? (g.owner.ownerType === 'official' ? 'company' : 'seller');
    return this.purchase(g, {
      kind: input.kind,
      items: input.items,
      parcel: input.parcel,
      serviceId: pick.service.id,
      cost: q.cost,
      billedTo,
      key,
      from,
      to: input.kind === 'return' ? input.to! : (input.to ?? g.task.shipTo),
      returnId: input.kind === 'return' ? (input.returnId ?? null) : null,
      qr: input.kind === 'return' && input.labelMethod === 'prepaid_qr',
      format: input.format ?? 'pdf',
      // the drop-off deadline is decided by returns (approval + policy dropOffDays); shipping never invents one
      dropOffBy: input.kind === 'return' && input.dropOffBy ? new Date(input.dropOffBy) : null,
    }, by);
  }

  private async purchase(
    g: GroupCtx,
    o: {
      kind: 'outbound' | 'replacement' | 'return';
      items: ShipmentLineInput[];
      parcel: Parcel;
      serviceId: string;
      cost: common.Money;
      billedTo: BilledTo;
      key: string;
      from: Partial<common.Address> | null;
      to: Partial<common.Address>;
      returnId: string | null;
      qr: boolean;
      format: 'pdf' | 'zpl';
      dropOffBy: Date | null;
    },
    by: By,
  ): Promise<LabelResult> {
    if (o.kind !== 'return') await this.checkItems(g, o.items);
    const service = await this.repo.get('carrier_services', o.serviceId);
    const carrier = service ? await this.repo.get('carriers', service.carrier_id) : undefined;
    if (!service || !carrier || !service.enabled || !service.label_supported || carrier.status !== 'active') throw this.core.error('LABELS_NOT_SUPPORTED', 'This carrier service cannot sell labels right now. Enter tracking manually.');
    const id = newId();
    const labelId = newId();
    let bought: { trackingNumber: string; pdf: Uint8Array; qrCode: string | null };
    try {
      bought = await this.core.carriers.buyLabel({ carrierCode: carrier.code, carrierName: carrier.name, serviceCode: service.code, serviceName: service.name, parcel: o.parcel, from: o.from, to: o.to, reference: labelId, qr: o.qr, format: o.format });
    } catch (err) {
      if (err instanceof CarrierRefused) throw this.core.error('LABEL_FAILED', 'The carrier did not sell the label. Nothing was charged; try again or choose another service.', { carrierMessage: err.carrierMessage });
      throw err;
    }
    const tracking = normalizeTracking(bought.trackingNumber);
    const asset = await this.core.soft('media', 'store label', (m) =>
      m.storeGeneratedFile({ owner: g.owner.ownerType === 'seller' ? { kind: 'seller', id: g.owner.sellerId, label: 'Shipping label' } : { kind: 'platform', label: 'Shipping label' }, fileName: `label-${g.task.orderRef}-${tracking}.${o.format}`, contentType: o.format === 'zpl' ? 'application/x-zpl' : 'application/pdf', body: new Blob([Buffer.from(bought.pdf)]).stream(), purpose: 'label' }),
    );
    const now = this.core.now();
    const kindInfo = o.kind === 'return' ? { kind: 'return' as const, returnId: o.returnId } : this.kindOf(g, o.items);
    const batch = new Batch(by);
    const packageNo = o.kind === 'return' ? 0 : await this.nextPackageNo(g.task.orderId);
    const lines = o.kind === 'return' ? o.items.map((i) => ({ shipment_id: id, order_item_id: i.orderItemId, title: g.group?.items.find((x) => x.id === i.orderItemId)?.title ?? 'Returned item', variant_label: g.group?.items.find((x) => x.id === i.orderItemId)?.variantLabel ?? '', quantity: i.quantity })) : this.linesOf(g, o.items, id);
    const label = await this.repo.transaction(async (tx) => {
      const s = await tx.insert('shipments', {
        id,
        kind: kindInfo.kind,
        order_id: g.task.orderId,
        order_ref: g.task.orderRef,
        group_id: g.task.groupId,
        return_id: kindInfo.returnId,
        owner_type: g.owner.ownerType,
        seller_id: g.owner.sellerId,
        fulfilled_by: g.fulfilledBy,
        package_no: packageNo,
        carrier_code: carrier.code,
        service_name: service.name,
        tracking_number: tracking,
        tracking_state: 'pending',
        status: shipmentMachine.initial,
        ship_from: o.kind === 'return' ? [o.from?.city, o.from?.region].filter(Boolean).join(', ') || 'Customer' : (g.group?.shipsFrom ?? ''),
        to_address: o.to,
        shipped_at: null,
        dispatch_due_at: o.kind === 'return' ? null : new Date(g.task.dispatchDeadline.dueAt),
        dispatched_on_time: null,
        estimated_arrival: null,
        delivered_at: null,
        failed_delivery: null,
        recorded_by: by.actor,
        created_at: now,
      });
      await tx.insertMany('shipment_lines', lines);
      await tx.insert('tracking_events', { id: newId(), shipment_id: id, code: 'label_created', label: EVENT_LABELS.label_created, detail: `${service.name} ${tracking}`, location: null, source: 'system', carrier_event_id: null, at: now });
      const l = await tx.insert('labels', {
        id: labelId,
        shipment_id: id,
        group_id: g.task.groupId,
        carrier_service_id: service.id,
        cost: o.cost.amount,
        currency: o.cost.currency,
        // customer: the customer pays (returns deducts it from the refund; finance books nothing for the label)
        billed_to: o.billedTo,
        tracking_number: tracking,
        storage_key: asset?.id ?? null,
        kind: kindInfo.kind,
        return_id: kindInfo.returnId,
        qr_code: bought.qrCode,
        format: o.format,
        drop_off_by: o.dropOffBy,
        status: labelMachine.initial,
        idempotency_key: o.key,
        purchased_by: by.actor,
        purchased_at: now,
        voided_at: null,
      });
      this.created(batch, s, lines, o.kind === 'return' ? 'Return parcel' : `Package ${packageNo}`);
      batch.push('shipping.label.purchased', { labelId, shipmentId: id, orderId: g.task.orderId, groupId: g.task.groupId, sellerId: g.owner.sellerId, billedTo: o.billedTo, cost: o.cost, kind: kindInfo.kind, returnId: kindInfo.returnId });
      return l;
    });
    await this.core.flush(batch);
    await this.matchStored((await this.repo.get('shipments', id))!);
    return this.labelResult(label, by.principal);
  }

  private async labelResult(l: LabelRec, principal?: Principal | null): Promise<LabelResult> {
    const s = await this.load(l.shipment_id!);
    return { label: await this.views.label(l, principal), shipment: await this.view(s, principal) };
  }

  async voidLabel(labelId: string, reason: string, by: By = { actor: SYSTEM }, sellerId?: string): Promise<Label> {
    if (!reason?.trim()) throw invalid([{ path: 'reason', message: 'Say why the label is voided' }]);
    const l = await this.repo.get('labels', labelId);
    if (!l) throw notFound('Label');
    const s = l.shipment_id ? await this.repo.get('shipments', l.shipment_id) : undefined;
    if (sellerId && (!s || s.owner_type !== 'seller' || s.seller_id !== sellerId)) throw notFound('Label');
    // the warehouse's label for a Fulfilled by Marketly package is not the seller's to void
    if (sellerId) this.core.refuseIfMarketly(s?.fulfilled_by);
    if (l.status === 'voided') return this.views.label(l, by.principal);
    labelMachine.next(l.status as never, 'void');
    if (s && s.status !== 'label_created') throw new AppError('ILLEGAL_TRANSITION', 'The carrier already has this package; the label cannot be voided', { machine: 'Label', from: l.status, event: 'void', allowed: [] });
    const { carrierCode } = await labelCarrier(this.core, l);
    await this.core.carriers.voidLabel({ carrierCode, trackingNumber: l.tracking_number });
    const batch = new Batch(by);
    const after = await this.repo.transaction(async (tx) => {
      const fresh = await tx.get('labels', labelId, { forUpdate: true });
      if (fresh?.status !== 'purchased') return fresh!;
      const now = this.core.now();
      const updated = await tx.update('labels', labelId, { status: labelMachine.next('purchased', 'void'), voided_at: now });
      if (s) {
        const cancelled = await tx.update('shipments', s.id, { status: shipmentMachine.next(s.status as never, 'void_label') });
        await tx.insert('tracking_events', { id: newId(), shipment_id: s.id, code: 'info', label: 'Label voided', detail: reason.trim(), location: null, source: 'system', carrier_event_id: null, at: now });
        this.statusChanged(batch, cancelled, s.status, cancelled.status, now);
      }
      batch.push('shipping.label.voided', { labelId, shipmentId: l.shipment_id, orderId: s?.order_id ?? '', kind: l.kind as 'outbound' | 'replacement' | 'return', returnId: l.return_id, sellerId: s?.seller_id ?? null, billedTo: l.billed_to as BilledTo, cost: money(l.cost, l.currency) });
      return updated;
    });
    await this.core.flush(batch);
    return this.views.label(after, by.principal);
  }

  /* ---------------------------------------------------------------- corrections */

  async correct(id: string, body: { carrierCode?: string | null; trackingNumber: string; reason: string; notifyCustomer?: boolean }, by: By, o: { sellerId?: string; staff?: boolean }): Promise<Shipment> {
    const s = o.sellerId ? await this.own(id, o.sellerId) : await this.load(id);
    if (o.sellerId) this.core.refuseIfMarketly(s.fulfilled_by);
    if (!body.reason?.trim()) throw invalid([{ path: 'reason', message: 'Say why the tracking changes' }]);
    if (!o.staff && ['delivered', 'returned_to_sender', 'cancelled'].includes(s.status)) {
      throw new AppError('ILLEGAL_TRANSITION', 'Tracking of a delivered, returned or cancelled package cannot be changed', { machine: 'Shipment', from: s.status, event: 'correct_tracking', allowed: [] });
    }
    const code = (body.carrierCode ?? s.carrier_code ?? '').trim().toLowerCase();
    const carrier = code ? await this.carrierByCode(code) : undefined;
    if (!carrier) throw invalid([{ path: 'carrierCode', message: 'Choose one of the listed carriers' }]);
    const tracking = normalizeTracking(body.trackingNumber);
    if (!tracking) throw invalid([{ path: 'trackingNumber', message: 'Enter the tracking number' }]);
    const services = await this.servicesOfCarrier(carrier.id);
    const service = services.find((x) => x.name === s.service_name) ?? null;
    if (!this.checkFormat(tracking, services, carrier.code === s.carrier_code ? service : null)) {
      throw this.core.error('TRACKING_FORMAT_INVALID', `This does not look like a ${carrier.name} tracking number.`, { carrierCode: carrier.code });
    }
    if (tracking === s.tracking_number && carrier.code === s.carrier_code) return this.view(s, by.principal);
    await this.assertUnused(carrier.code, tracking, s.id);
    const fromLabel = [carrierNameOf(s.carrier_code), s.tracking_number].filter(Boolean).join(' ') || 'No tracking';
    const toLabel = `${carrier.name} ${tracking}`;
    const notified = o.staff ? Boolean(body.notifyCustomer) : true;
    const now = this.core.now();
    const batch = new Batch(by);
    const after = await this.repo.transaction(async (tx) => {
      await tx.get('shipments', s.id, { forUpdate: true });
      await tx.insert('tracking_corrections', { id: newId(), shipment_id: s.id, from_value: fromLabel, to_value: toLabel, reason: body.reason.trim(), by: by.actor, customer_notified: notified, at: now });
      const updated = await tx.update('shipments', s.id, { carrier_code: carrier.code, tracking_number: tracking, tracking_state: s.tracking_state === 'valid' && tracking === s.tracking_number ? 'valid' : 'pending', ...(carrier.code !== s.carrier_code ? { service_name: null } : {}) });
      batch.push('shipping.tracking.corrected', { shipmentId: s.id, orderId: s.order_id, from: s.tracking_number ?? carrierNameOf(s.carrier_code) ?? '', to: tracking, reason: body.reason.trim(), by: by.actor });
      return updated;
    });
    await this.core.flush(batch);
    if (o.staff) await this.core.audit({ action: 'shipping.tracking.correct', actionLabel: 'Corrected tracking', category: 'shipping', target: { type: 'shipment', id: s.id, ref: s.order_ref, label: toLabel }, before: { carrier: s.carrier_code, trackingNumber: s.tracking_number }, after: { carrier: carrier.code, trackingNumber: tracking, customerNotified: notified }, reason: body.reason }, by);
    await this.matchStored(after);
    return this.view((await this.repo.get('shipments', s.id))!, by.principal);
  }

  /* ---------------------------------------------------------------- tracking events */

  /**
   * Applies a carrier (or staff-recorded) event: stored once per carrier event id, then the shipment follows the
   * status model. Returns false for a duplicate. Throws ILLEGAL_TRANSITION only for staff records.
   */
  async applyScan(
    shipmentId: string,
    e: { code: TrackingCode; at: Date; detail: string | null; location: string | null; source: 'carrier_webhook' | 'carrier_poll' | 'staff' | 'warehouse' | 'seller'; carrierEventId: string | null },
    by: By,
  ): Promise<boolean> {
    const cfg = await this.core.cfg();
    const batch = new Batch(by);
    const result = await this.repo.transaction(async (tx) => {
      const s = await tx.get('shipments', shipmentId, { forUpdate: true });
      if (!s) throw notFound('Shipment');
      const path = pathFor(s.status as ShipmentStatus, e.code);
      if (e.source === 'staff' && !path && ['in_transit', 'out_for_delivery', 'delivered', 'attempt_failed', 'held_for_pickup', 'returning', 'returned'].includes(e.code)) {
        throw new AppError('ILLEGAL_TRANSITION', `A ${statusLabel(s.status, s.tracking_state, s.kind).toLowerCase()} package cannot move to ${EVENT_LABELS[e.code].toLowerCase()}`, { machine: 'Shipment', from: s.status, event: e.code, allowed: shipmentMachine.eventsFrom(s.status as never) });
      }
      const inserted = await tx.insertIfAbsent('tracking_events', { id: newId(), shipment_id: s.id, code: e.code, label: EVENT_LABELS[e.code], detail: e.detail, location: e.location, source: e.source, carrier_event_id: e.carrierEventId, at: e.at });
      if (!inserted) return { s, changed: false, duplicate: true, scanned: false, from: s.status };
      const carrierScan = e.source === 'carrier_webhook' || e.source === 'carrier_poll';
      const scanned = carrierScan && ['accepted', 'in_transit', 'out_for_delivery', 'delivered', 'attempt_failed', 'held_for_pickup', 'returning', 'returned'].includes(e.code);
      const patch: Partial<ShipmentRec> = {};
      if (scanned && s.tracking_state !== 'valid') patch.tracking_state = 'valid';
      let status = s.status;
      const lines = await tx.find('shipment_lines', { shipment_id: s.id });
      let current: ShipmentRec = s;
      for (const ev of path?.events ?? []) {
        const next = shipmentMachine.next(status as never, ev as never);
        const step: Partial<ShipmentRec> = { ...patch, status: next };
        if (ev === 'hand_over') {
          step.shipped_at = s.shipped_at ?? e.at;
          step.dispatched_on_time = s.dispatch_due_at ? e.at.getTime() <= s.dispatch_due_at.getTime() : null;
        }
        if (next === 'delivered') step.delivered_at = e.at;
        if (next === 'delivery_failed') step.failed_delivery = this.failedInfo(s, e, cfg.failedDeliveryChoiceDays);
        if (next === 'held_for_pickup' && s.failed_delivery) step.failed_delivery = { ...s.failed_delivery, heldAt: e.location ?? s.failed_delivery.heldAt ?? null };
        if (next === 'held_for_pickup' && !s.failed_delivery) step.failed_delivery = { ...this.failedInfo(s, e, cfg.failedDeliveryChoiceDays), heldAt: e.location ?? null };
        current = await tx.update('shipments', s.id, step);
        this.statusChanged(batch, current, status, next, e.at);
        if (ev === 'hand_over') this.dispatched(batch, current, lines);
        if (next === 'delivered') batch.push('shipping.shipment.delivered', { shipmentId: s.id, kind: s.kind as 'outbound', orderId: s.order_id, groupId: s.group_id, returnId: s.return_id, sellerId: s.seller_id, fulfilledBy: fulfilledByOf(s.owner_type, s.fulfilled_by), lines: this.views.contents(lines), deliveredAt: e.at.toISOString() });
        status = next;
      }
      if (!path?.events.length && Object.keys(patch).length) current = await tx.update('shipments', s.id, patch);
      if (scanned) {
        const label = (await tx.find('labels', { shipment_id: s.id, status: 'purchased' }))[0];
        if (label) await tx.update('labels', label.id, { status: labelMachine.next('purchased', 'first_scan') });
      }
      if (carrierScan && s.carrier_code) await tx.updateWhere('carriers', { code: s.carrier_code }, { last_event_at: this.core.now() });
      return { s: current, changed: status !== s.status, duplicate: false, scanned, from: s.status };
    });
    await this.core.flush(batch);
    if (result.duplicate) return false;
    const s = result.s;
    if (result.from === 'label_created' && s.status !== 'label_created') await this.afterDispatch(s);
    if (result.scanned) await this.exceptions.clear({ shipmentId: s.id, kinds: ['missing_tracking'] }, 'tracking_provided', 'Carrier scan received');
    if (result.scanned) await this.exceptions.clearStalled(s.id);
    if (result.changed && s.status === 'delivery_failed') await this.exceptions.openFailedDelivery(s, e.detail);
    if (result.changed && s.status === 'delivered') await this.exceptions.clear({ shipmentId: s.id, kinds: ['failed_delivery'] }, result.from === 'held_for_pickup' ? 'picked_up' : 'redelivered', 'Delivered');
    if (result.changed && s.status === 'returned_to_sender') await this.exceptions.clear({ shipmentId: s.id, kinds: ['failed_delivery'] }, 'returned_to_seller', 'Returned to the seller');
    return true;
  }

  private failedInfo(s: ShipmentRec, e: { at: Date; detail: string | null; location: string | null }, days: number): FailedDeliveryInfo {
    const today = this.core.today(e.at);
    const next = (n: number) => {
      const out: string[] = [];
      let d = today;
      while (out.length < n) {
        d = onOrAfter(addDays(d, 1), WEEKDAYS_ONLY);
        out.push(d);
      }
      return out;
    };
    const zero = money(0, this.core.currency);
    const carrier = carrierNameOf(s.carrier_code) ?? 'the carrier';
    const options: DeliveryChoiceOption[] = [
      { choice: 'redeliver', title: 'Deliver again', description: `${carrier} tries again on the day you choose.`, cost: zero, costIfNoChoice: null, dates: next(3), pickupLocation: null },
      { choice: 'pickup', title: 'Pick it up', description: `Collect the package from ${e.location ?? `the nearest ${carrier} location`}. Bring an ID.`, cost: zero, costIfNoChoice: null, dates: next(5), pickupLocation: e.location ?? null },
      { choice: 'return_to_seller', title: 'Return it to the seller', description: 'The package goes back to the seller and you get a refund when it arrives.', cost: zero, costIfNoChoice: null, dates: [], pickupLocation: null },
    ];
    return { reason: e.detail || 'Nobody was available to receive the package', heldAt: e.location ?? null, chooseBy: new Date(e.at.getTime() + days * DAY_MS).toISOString(), options, chosen: null, defaultIfNoChoice: 'return_to_seller' };
  }

  async recordEventAdmin(id: string, body: { code: string; at: string; detail: string; evidenceIds?: string[] | null; reason: string }, by: By): Promise<Shipment> {
    const s = await this.load(id);
    const issues: { path: string; message: string }[] = [];
    if (!body.reason?.trim()) issues.push({ path: 'reason', message: 'Say why the event is recorded by hand' });
    if (!body.detail?.trim()) issues.push({ path: 'detail', message: 'Describe what the carrier confirmed' });
    if (body.code === 'delivered' && !body.evidenceIds?.length) issues.push({ path: 'evidenceIds', message: 'Delivery recorded by hand needs proof of delivery' });
    const at = new Date(body.at);
    if (Number.isNaN(at.getTime()) || at.getTime() > this.core.now().getTime() + HOUR_MS) issues.push({ path: 'at', message: 'When did it happen? (not in the future)' });
    if (issues.length) throw invalid(issues);
    if (body.evidenceIds?.length) {
      const refs = await this.core.soft('media', 'evidence', (m) => m.refs(body.evidenceIds!));
      if (refs && refs.length < new Set(body.evidenceIds).size) throw invalid([{ path: 'evidenceIds', message: 'Upload the proof first' }]);
    }
    await this.applyScan(s.id, { code: normalizeCode(body.code), at, detail: `${body.detail.trim()}${body.evidenceIds?.length ? ` (evidence: ${body.evidenceIds.length} file${body.evidenceIds.length === 1 ? '' : 's'})` : ''}`, location: null, source: 'staff', carrierEventId: `staff:${newId()}` }, by);
    const after = await this.load(id);
    await this.core.audit({ action: 'shipping.shipment.record_event', actionLabel: `Recorded a carrier event: ${EVENT_LABELS[normalizeCode(body.code)]}`, category: 'shipping', target: { type: 'shipment', id, ref: s.order_ref, label: after.tracking_number ?? 'Package' }, before: { status: s.status }, after: { status: after.status, evidenceIds: body.evidenceIds ?? [] }, reason: body.reason }, by);
    return this.view(after, by.principal);
  }

  /** POST /webhooks/shipping/carriers/{carrier}/events: stored once per carrier event id, then applied */
  async webhook(carrierCode: string, body: unknown, eventId?: string): Promise<{ received: boolean }> {
    const code = carrierCode.trim().toLowerCase();
    const scans = this.core.carriers.parseWebhook(code, body, eventId);
    const now = this.core.now();
    if (!scans.length) {
      await this.repo.insertIfAbsent('webhook_events', { id: newId(), carrier_code: code, external_id: eventId ?? `raw:${newId()}`, payload: body ?? null, received_at: now, processed_at: now, error: 'No tracking events in the payload' });
      return { received: true };
    }
    for (const scan of scans) {
      const id = newId();
      if (!(await this.repo.insertIfAbsent('webhook_events', { id, carrier_code: code, external_id: scan.id, payload: scan, received_at: now, processed_at: null, error: null }))) continue;
      await this.processStored(id, code, scan);
    }
    return { received: true };
  }

  private async processStored(webhookId: string, carrierCode: string, scan: CarrierScan): Promise<boolean> {
    const tracking = normalizeTracking(scan.trackingNumber);
    const s = (await this.repo.find('shipments', { carrier_code: carrierCode, tracking_number: tracking, status: { op: '<>', value: 'cancelled' } }, { orderBy: [['created_at', 'desc']], limit: 1 }))[0];
    if (!s) {
      await this.repo.update('webhook_events', webhookId, { error: 'Unknown tracking number; kept for matching' });
      return false;
    }
    try {
      const at = new Date(scan.at);
      await this.applyScan(s.id, { code: normalizeCode(scan.code), at: Number.isNaN(at.getTime()) ? this.core.now() : at, detail: scan.description ?? null, location: scan.location ?? null, source: 'carrier_webhook', carrierEventId: scan.id }, { actor: { kind: 'provider', id: null, name: carrierNameOf(carrierCode) } });
      await this.repo.update('webhook_events', webhookId, { processed_at: this.core.now(), error: null });
      return true;
    } catch (err) {
      await this.repo.update('webhook_events', webhookId, { error: err instanceof Error ? err.message.slice(0, 500) : 'Could not apply' });
      if (!isAppError(err)) throw err;
      return false;
    }
  }

  /* ---------------------------------------------------------------- customer choice after a failed delivery */

  async choose(id: string, viewer: ShopperViewer, body: { choice: 'redeliver' | 'pickup' | 'return_to_seller'; redeliveryDate?: string | null }, by: By): Promise<TrackingView> {
    const s = await this.shopperShipment(id, viewer);
    const info = s.failed_delivery;
    if (!['delivery_failed', 'held_for_pickup'].includes(s.status) || !info) {
      throw new AppError('ILLEGAL_TRANSITION', 'There is no failed delivery to decide on', { machine: 'Shipment', from: s.status, event: 'choose_next_step', allowed: [] });
    }
    if (info.chosen) throw new AppError('ILLEGAL_TRANSITION', 'A next step was already chosen', { machine: 'Shipment', from: s.status, event: 'choose_next_step', allowed: [] });
    if (new Date(info.chooseBy).getTime() < this.core.now().getTime()) throw this.core.error('CHOICE_WINDOW_CLOSED', 'The time to choose has passed; the package is returning to the seller.');
    const option = info.options.find((o) => o.choice === body.choice);
    if (!option) throw invalid([{ path: 'choice', message: 'Not one of the options' }]);
    if (body.choice === 'redeliver' && (!body.redeliveryDate || !option.dates.includes(body.redeliveryDate))) throw invalid([{ path: 'redeliveryDate', message: 'Choose one of the offered dates' }]);
    const chosen = { choice: body.choice, redeliveryDate: body.choice === 'redeliver' ? body.redeliveryDate! : null, chosenAt: this.core.now().toISOString(), chosenBy: by.actor };
    const updated = await this.repo.transaction(async (tx) => {
      await tx.get('shipments', s.id, { forUpdate: true });
      return tx.update('shipments', s.id, { failed_delivery: { ...info, chosen } });
    });
    this.core.publish('shipping.delivery_choice.made', { shipmentId: s.id, orderId: s.order_id, choice: body.choice, redeliveryDate: chosen.redeliveryDate }, by);
    await this.exceptions.noteChoice(s.id, option.title, by);
    return this.trackingView(updated);
  }

  /** Job: failed deliveries past chooseBy without a choice follow the default (return to seller) */
  async failedDeliveryDefault(): Promise<void> {
    const now = this.core.now();
    const rows = await this.repo.find('shipments', { status: ['delivery_failed', 'held_for_pickup'] }, { limit: 200 });
    for (const s of rows) {
      const info = s.failed_delivery;
      if (!info || info.chosen || new Date(info.chooseBy).getTime() > now.getTime()) continue;
      const chosen = { choice: 'return_to_seller' as const, redeliveryDate: null, chosenAt: now.toISOString(), chosenBy: SYSTEM };
      const batch = new Batch({ actor: SYSTEM });
      const done = await this.repo.transaction(async (tx) => {
        const fresh = await tx.get('shipments', s.id, { forUpdate: true });
        if (!fresh?.failed_delivery || fresh.failed_delivery.chosen || !['delivery_failed', 'held_for_pickup'].includes(fresh.status)) return null;
        const to = shipmentMachine.next(fresh.status as never, 'return_to_sender');
        const after = await tx.update('shipments', s.id, { status: to, failed_delivery: { ...fresh.failed_delivery, chosen } });
        await tx.insert('tracking_events', { id: newId(), shipment_id: s.id, code: 'returning', label: EVENT_LABELS.returning, detail: 'No next step was chosen in time; returning to the seller', location: null, source: 'system', carrier_event_id: null, at: now });
        this.statusChanged(batch, after, fresh.status, to, now);
        return after;
      });
      if (!done) continue;
      await this.core.flush(batch);
      this.core.publish('shipping.delivery_choice.made', { shipmentId: s.id, orderId: s.order_id, choice: 'return_to_seller', redeliveryDate: null });
      await this.exceptions.defaultApplied(done);
    }
  }

  /* ---------------------------------------------------------------- returns */

  async registerReturnTracking(input: { returnId: string; orderId: string; groupId: string; carrierCode: string; trackingNumber: string; to: common.Address }, by: By = { actor: SYSTEM }): Promise<Shipment> {
    const g = await this.groupContext(input.groupId);
    if (g.task.orderId !== input.orderId) throw notFound('Order');
    const existing = (await this.repo.find('shipments', { return_id: input.returnId, kind: 'return', status: { op: '<>', value: 'cancelled' } }))[0];
    const tracking = normalizeTracking(input.trackingNumber);
    if (existing && existing.tracking_number === tracking) return this.view(existing);
    const carrier = await this.carrierByCode(input.carrierCode);
    if (!carrier) throw invalid([{ path: 'carrierCode', message: 'Choose one of the listed carriers' }]);
    if (!tracking) throw invalid([{ path: 'trackingNumber', message: 'Enter the tracking number' }]);
    const services = await this.servicesOfCarrier(carrier.id);
    if (!this.checkFormat(tracking, services, null)) throw this.core.error('TRACKING_FORMAT_INVALID', `This does not look like a ${carrier.name} tracking number.`, { carrierCode: carrier.code });
    await this.assertUnused(carrier.code, tracking);
    const now = this.core.now();
    const id = newId();
    const batch = new Batch(by);
    const s = await this.repo.transaction(async (tx) => {
      const row = await tx.insert('shipments', {
        id,
        kind: 'return',
        order_id: input.orderId,
        order_ref: g.task.orderRef,
        group_id: input.groupId,
        return_id: input.returnId,
        owner_type: g.owner.ownerType,
        seller_id: g.owner.sellerId,
        fulfilled_by: g.fulfilledBy,
        package_no: 0,
        carrier_code: carrier.code,
        service_name: null,
        tracking_number: tracking,
        tracking_state: 'pending',
        status: shipmentMachine.initial,
        ship_from: [g.task.shipTo.city, g.task.shipTo.region].filter(Boolean).join(', ') || 'Customer',
        to_address: input.to,
        shipped_at: null,
        dispatch_due_at: null,
        dispatched_on_time: null,
        estimated_arrival: null,
        delivered_at: null,
        failed_delivery: null,
        recorded_by: by.actor,
        created_at: now,
      });
      const after = await tx.update('shipments', id, { status: shipmentMachine.next(row.status as never, 'hand_over'), shipped_at: now });
      // the customer arranged the return and entered the tracking themselves
      await tx.insert('tracking_events', { id: newId(), shipment_id: id, code: 'info', label: 'Tracking entered by the customer', detail: null, location: null, source: 'customer', carrier_event_id: null, at: now });
      this.created(batch, { ...after, status: 'label_created' }, [], 'Return parcel');
      this.statusChanged(batch, after, 'label_created', after.status, now);
      this.dispatched(batch, after, []);
      return after;
    });
    await this.core.flush(batch);
    await this.matchStored(s);
    return this.view((await this.repo.get('shipments', id))!);
  }

  async findDropOffPoints(carrierServiceId: string, postalCode: string, limit = 5) {
    const service = await this.repo.get('carrier_services', carrierServiceId);
    if (!service) throw notFound('Carrier service');
    const carrier = await this.repo.get('carriers', service.carrier_id);
    if (!carrier) throw notFound('Carrier');
    return this.core.carriers.dropOffPoints({ carrierCode: carrier.code, carrierName: carrier.name, postalCode, limit: Math.max(1, Math.min(limit ?? 5, 20)), qr: service.label_supported });
  }

  /* ---------------------------------------------------------------- warehouse */

  /**
   * warehouse.package.packed: hand over the warehouse's package, an Official Store one or a seller's Fulfilled by
   * Marketly one (recorded from the event when no label is known, with the payload's owner, never a hard-coded one)
   */
  async onPackagePacked(e: {
    packageId: string;
    orderId: string;
    sellerGroupId: string;
    ownerType?: 'official' | 'seller' | null;
    sellerId?: string | null;
    fulfilledBy?: string | null;
    items: { orderItemId: string; quantity: number }[];
    carrier: string;
    service: string;
    trackingNumber: string;
    weight: { value: number; unit: string };
  }) {
    const tracking = normalizeTracking(e.trackingNumber);
    const existing = (await this.repo.find('shipments', { group_id: e.sellerGroupId, tracking_number: tracking })).find((s) => s.status !== 'cancelled');
    if (existing) {
      if (existing.status === 'label_created') await this.handOver(existing.id, this.core.now().toISOString(), { kind: 'system', id: null, name: 'Warehouse' });
      return;
    }
    const carriers = await this.repo.find('carriers', {});
    const carrier = carriers.find((c) => c.code === e.carrier.trim().toLowerCase() || c.name.toLowerCase() === e.carrier.trim().toLowerCase());
    if (!carrier || !tracking) {
      this.core.ctx.log.warn({ packageId: e.packageId, carrier: e.carrier }, 'shipping: packed package with an unknown carrier or no tracking');
      return;
    }
    // older payloads carry no owner: the warehouse shipped Official Store packages only
    const ownerType = e.ownerType ?? (byMarketly(e.fulfilledBy) ? 'seller' : 'official');
    const owner: Owner = { ownerType, sellerId: ownerType === 'official' ? null : (e.sellerId ?? null) };
    try {
      await this.record(owner, { groupId: e.sellerGroupId, carrierCode: carrier.code, serviceName: e.service, trackingNumber: tracking, shippedAt: this.core.now().toISOString(), items: e.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })), acknowledgeFormatWarning: true }, { actor: { kind: 'system', id: null, name: 'Warehouse' } }, 'warehouse');
    } catch (err) {
      if (!isAppError(err)) throw err;
      this.core.ctx.log.info({ err, packageId: e.packageId }, 'shipping: packed package not recorded');
    }
  }

  /* ---------------------------------------------------------------- jobs and metrics */

  /** Polls carriers in polling mode and retries webhook numbers that were not matched yet */
  async pollTracking(): Promise<void> {
    const now = this.core.now();
    const polling = await this.repo.find('carriers', { tracking_mode: 'polling', status: 'active' });
    if (polling.length) {
      const rows = await this.repo.find('shipments', { carrier_code: polling.map((c) => c.code), status: ['label_created', ...MOVING], tracking_number: { op: 'is not', value: null } }, { orderBy: [['created_at', 'asc']], limit: 200 });
      for (const s of rows) {
        const scans = await this.core.carriers.track({ carrierCode: s.carrier_code!, trackingNumber: s.tracking_number!, shippedAt: s.shipped_at ?? s.created_at, now }).catch(() => [] as CarrierScan[]);
        for (const scan of scans) {
          await this.applyScan(s.id, { code: normalizeCode(scan.code), at: new Date(scan.at), detail: scan.description ?? null, location: scan.location ?? null, source: 'carrier_poll', carrierEventId: scan.id }, { actor: { kind: 'provider', id: null, name: carrierNameOf(s.carrier_code) } }).catch((err) => {
            if (!isAppError(err)) throw err;
          });
        }
      }
    }
    const unmatched = await this.repo.find('webhook_events', { processed_at: null }, { orderBy: [['received_at', 'asc']], limit: 200 });
    for (const w of unmatched) {
      const scan = w.payload as CarrierScan;
      if (!scan?.trackingNumber) continue;
      await this.processStored(w.id, w.carrier_code, scan);
    }
  }

  async dispatchMetrics(sellerId: string | null, range: common.DateRange): Promise<DispatchMetrics> {
    const { start: from, end: to } = zonedDayRange(range, this.core.tz) as { start: Date; end: Date };
    // a seller's figures leave out Fulfilled by Marketly packages: Marketly dispatched them
    const rows = await this.repo.find('shipments', {
      owner_type: sellerId ? 'seller' : 'official',
      ...(sellerId ? { seller_id: sellerId, fulfilled_by: 'seller' } : {}),
      kind: ['outbound', 'replacement'],
      shipped_at: { op: '>=', value: from },
    });
    const inRange = rows.filter((s) => s.shipped_at && s.shipped_at.getTime() < to.getTime() && s.status !== 'cancelled');
    const known = inRange.filter((s) => s.dispatched_on_time !== null);
    const onTime = known.filter((s) => s.dispatched_on_time).length;
    const validTracking = inRange.filter((s) => s.tracking_state === 'valid' || s.tracking_state === 'pending').length;
    const overdueOpen = await this.repo.count('dispatch_watch', { owner_type: sellerId ? 'seller' : 'official', ...(sellerId ? { seller_id: sellerId, fulfilled_by: 'seller' } : { seller_id: null }), due_at: { op: '<', value: this.core.now() } });
    const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 100);
    return { dispatched: inRange.length, onTimePct: pct(onTime, known.length), validTrackingPct: pct(validTracking, inRange.length), late: known.length - onTime, overdueOpen };
  }

  /** Job: 30-day on-time delivery per carrier and the Official Store on-time dispatch rate */
  async carrierOnTime(): Promise<void> {
    const now = this.core.now();
    const since = new Date(now.getTime() - 30 * DAY_MS);
    const delivered = await this.repo.find('shipments', { status: 'delivered', delivered_at: { op: '>=', value: since } });
    const carriers = await this.repo.find('carriers', {});
    for (const c of carriers) {
      const own = delivered.filter((s) => s.carrier_code === c.code && s.estimated_arrival && s.delivered_at);
      const rate = own.length ? Math.round((own.filter((s) => this.core.today(s.delivered_at!) <= s.estimated_arrival!.to).length / own.length) * 1000) / 10 : null;
      await this.repo.update('carriers', c.id, { on_time_rate_30d: rate === null ? null : String(rate) });
    }
    const official = await this.dispatchMetrics(null, { from: this.core.today(since), to: this.core.today(now) });
    const targets = await this.core.targets(now);
    const rate = official.dispatched ? official.onTimePct : null;
    if (targets.effective_from.getTime() === 0) {
      await this.repo.insert('dispatch_targets', { ...targets, id: newId(), official: { ...targets.official, onTimeRate30d: rate }, effective_from: now, set_by: SYSTEM, reason: 'Official Store on-time rate computed' });
    } else {
      await this.repo.update('dispatch_targets', targets.id, { official: { ...targets.official, onTimeRate30d: rate } });
    }
  }
}

/* ---------------------------------------------------------------- tracking view texts */

export function headlineOf(s: Pick<ShipmentRec, 'status' | 'kind'>): string {
  switch (s.status) {
    case 'delivered':
      return 'Delivered';
    case 'delivery_failed':
      return 'Delivery attempt failed';
    case 'held_for_pickup':
      return 'Waiting for pickup';
    case 'returning':
    case 'returned_to_sender':
      return 'Returning to the seller';
    case 'lost':
      return 'We are looking into this package';
    case 'cancelled':
      return 'Shipment cancelled';
    case 'label_created':
      return 'Preparing to ship';
    default:
      return 'Estimated delivery';
  }
}

export function estimateNoteOf(s: Pick<ShipmentRec, 'to_address' | 'status'>): string {
  const a = s.to_address ?? {};
  const place = [a.city, [a.region, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const who = [a.name, place].filter(Boolean).join(', ');
  if (s.status === 'delivered') return who ? `Delivered to ${who}` : 'Delivered';
  return who ? `By 8:00 PM · to ${who}` : 'By 8:00 PM';
}
