/**
 * Delivery exceptions with their required responses (plan ch. 12), the dispatch watch and late-dispatch handling
 * (scenario 5), detection jobs, the events from orders, sellers, support, returns and payments, and carrier claims.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { format, money } from '../../../kernel/lib/money.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type { CarrierClaim, ClaimInput, DeliveryException, ExceptionCounts, OpenExceptionInput, ShippingShipmentExceptionEvent } from '../../../spec/shipping.js';

/** What opened an exception (shipping.shipment.exception source) */
type ExceptionSource = ShippingShipmentExceptionEvent['source'];
import { DAY_MS, HOUR_MS, instantLabel } from '../domain/calendar.js';
import { CUSTOMER_ACTION, DEFAULT_NEXT_STEP, FIRST_DEADLINE_HOURS, KIND_LABEL, MARKETLY_NEXT_STEP, OPEN_STATUSES, type ExceptionKind } from '../domain/exceptions.js';
import { carrierClaimMachine, deliveryExceptionMachine } from '../domain/state-machines.js';
import type { ExceptionRec, ShipmentRec, WatchRec } from '../ports.js';
import { byMarketly, fulfilledByOf, invalid, notFound, SYSTEM, type By, type Core, type FulfilledBy } from './core.js';
import { scheduleOwner, type Estimates } from './estimates.js';
import type { Shipments } from './shipments.js';
import type { Views } from './views.js';

interface GroupFacts {
  orderId: string;
  orderRef: string;
  groupId: string;
  ownerType: 'official' | 'seller';
  sellerId: string | null;
  /** marketly_service: owned by the Shipping Manager, no seller notice, no seller response */
  fulfilledBy: FulfilledBy;
}

const CASE_KINDS = /(missing|not[_\s-]?received|never[_\s-]?arrived|lost|damage|broken|not[_\s-]?delivered|wrong[_\s-]?address|package)/i;
const RESOLUTIONS = ['shipped', 'tracking_provided', 'cancelled_refunded', 'replacement_sent', 'redelivered', 'picked_up', 'returned_to_seller', 'claim_filed', 'no_action'] as const;
type ResolutionKind = (typeof RESOLUTIONS)[number];
const REMIND_EVERY_MS = HOUR_MS;

const itemsSummary = (lines: { title: string; variantLabel?: string | null; quantity: number }[]) =>
  lines.length ? lines.map((l) => `${l.quantity} × ${l.title}${l.variantLabel ? ` (${l.variantLabel})` : ''}`).join(', ') : 'The whole package';

export class Exceptions {
  shipments!: Shipments;

  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly estimates: Estimates,
  ) {}

  private get repo() {
    return this.core.repo;
  }
  private get orders() {
    return this.core.ctx.use('orders');
  }

  /* ---------------------------------------------------------------- opening and closing */

  /**
   * Opens one exception per group and kind (the unique open index guarantees it); an open one of the same kind is
   * returned instead (created=false). Events are published by the caller's choice.
   */
  async open(o: {
    kind: ExceptionKind;
    group: GroupFacts;
    shipmentId?: string | null;
    /** The order items concerned with their units (G75: exceptions carry quantities) */
    items: { id: string; quantity: number }[];
    itemsSummary: string;
    situation: string;
    nextStep?: string;
    dueAt: Date;
    by: By;
    owner?: { staffId: string | null; name: string; role?: string | null } | null;
    caseRef?: string | null;
    sellerNotified?: boolean;
    publish?: boolean;
    /** What opened it; support opens a case only for carrier, system and staff sources (never customer_report) */
    source: ExceptionSource;
  }): Promise<{ row: ExceptionRec; created: boolean }> {
    const now = this.core.now();
    const id = newId();
    // Fulfilled by Marketly: the Shipping Manager's exception; the seller is never notified or asked to respond
    const marketly = byMarketly(o.group.fulfilledBy);
    const created = await this.repo.transaction(async (tx) => {
      const ok = await tx.insertIfAbsent('exceptions', {
        id,
        kind: o.kind,
        order_id: o.group.orderId,
        order_ref: o.group.orderRef,
        group_id: o.group.groupId,
        shipment_id: o.shipmentId ?? null,
        owner_type: o.group.ownerType,
        seller_id: o.group.sellerId,
        fulfilled_by: o.group.fulfilledBy,
        items_summary: o.itemsSummary,
        order_item_ids: o.items.map((i) => i.id),
        item_quantities: o.items.map((i) => ({ order_item_id: i.id, quantity: i.quantity })),
        situation: o.situation,
        next_step: o.nextStep ?? (marketly ? MARKETLY_NEXT_STEP[o.kind] : undefined) ?? DEFAULT_NEXT_STEP[o.kind],
        status: o.owner ? 'in_progress' : 'open',
        owner_staff_id: o.owner?.staffId ?? null,
        owner_name: o.owner?.name ?? null,
        owner_role: o.owner?.role ?? null,
        due_at: o.dueAt,
        customer_notified_at: null,
        seller_notified_at: o.sellerNotified && !marketly ? now : null,
        escalated_to: null,
        seller_response: null,
        resolution: null,
        claim_id: null,
        case_ref: o.caseRef ?? null,
        opened_by: o.by.actor,
        opened_at: now,
      });
      if (ok) await tx.insert('exception_log', { id: newId(), exception_id: id, action: 'opened', detail: o.situation, actor: o.by.actor, at: now });
      if (ok && o.owner) await tx.insert('exception_log', { id: newId(), exception_id: id, action: 'assigned', detail: o.owner.name, actor: o.by.actor, at: new Date(now.getTime() + 1) });
      return ok;
    });
    if (!created) {
      // one open exception per (group, kind, package) (decision D-S3): another package of the group gets its own
      const existing = await this.openFor(o.group.groupId, o.kind, o.shipmentId ?? null);
      if (existing) return { row: existing, created: false };
      throw new AppError('CONFLICT', 'The exception could not be opened; try again');
    }
    const row = (await this.repo.get('exceptions', id))!;
    if (o.publish !== false) {
      this.core.publish(
        'shipping.shipment.exception',
        { exceptionId: id, kind: o.kind, orderId: row.order_id, orderRef: row.order_ref, ...(await this.core.recipientOf(row.order_id)), groupId: row.group_id, shipmentId: row.shipment_id, sellerId: row.seller_id, fulfilledBy: fulfilledByOf(row.owner_type, row.fulfilled_by), orderItemIds: o.items.map((i) => i.id), dueAt: row.due_at.toISOString(), customerAction: CUSTOMER_ACTION[o.kind], source: o.source, caseRef: row.case_ref },
        o.by,
      );
    }
    return { row, created: true };
  }

  /** The open exception of a kind for a group and package (no package: the group's one without a package) */
  private async openFor(groupId: string, kind: ExceptionKind, shipmentId: string | null): Promise<ExceptionRec | undefined> {
    return (await this.repo.find('exceptions', { group_id: groupId, kind, shipment_id: shipmentId, status: OPEN_STATUSES }))[0];
  }

  private async log(exceptionId: string, action: string, detail: string | null, actor: common.Actor) {
    await this.repo.insert('exception_log', { id: newId(), exception_id: exceptionId, action, detail, actor, at: this.core.now() });
  }

  /** The condition behind open exceptions cleared: they close with the outcome recorded */
  async clear(where: { groupId?: string; shipmentId?: string; kinds: ExceptionKind[] }, kind: ResolutionKind, note: string) {
    const rows = await this.repo.find('exceptions', { ...(where.groupId ? { group_id: where.groupId } : {}), ...(where.shipmentId ? { shipment_id: where.shipmentId } : {}), kind: where.kinds, status: OPEN_STATUSES });
    for (const e of rows) await this.closeOne(e, kind, note);
  }

  private async closeOne(e: ExceptionRec, kind: ResolutionKind, note: string) {
    const now = this.core.now();
    const status = deliveryExceptionMachine.next(e.status as never, 'condition_cleared');
    const n = await this.repo.updateWhere('exceptions', { id: e.id, status: OPEN_STATUSES }, { status, resolution: { kind, note, by: SYSTEM, at: now.toISOString() } });
    if (!n) return;
    await this.log(e.id, 'closed', note, SYSTEM);
    this.core.publish('shipping.exception.resolved', { exceptionId: e.id, kind: e.kind, orderId: e.order_id, groupId: e.group_id, resolution: kind });
  }

  /** A stalled-package review closes when the carrier scans the package again */
  async clearStalled(shipmentId: string) {
    const rows = await this.repo.find('exceptions', { shipment_id: shipmentId, kind: 'lost_or_damaged', status: OPEN_STATUSES });
    for (const e of rows.filter((x) => x.opened_by.kind === 'system' && x.situation.startsWith('No carrier scan'))) await this.closeOne(e, 'no_action', 'The carrier scanned the package again');
  }

  private factsOf(s: ShipmentRec): GroupFacts {
    return { orderId: s.order_id, orderRef: s.order_ref, groupId: s.group_id, ownerType: s.owner_type as 'seller', sellerId: s.seller_id, fulfilledBy: fulfilledByOf(s.owner_type, s.fulfilled_by) };
  }

  private async linesOf(shipmentId: string) {
    const lines = await this.repo.find('shipment_lines', { shipment_id: shipmentId });
    return { items: lines.map((l) => ({ id: l.order_item_id, quantity: l.quantity })), summary: itemsSummary(lines.map((l) => ({ title: l.title, variantLabel: l.variant_label, quantity: l.quantity }))) };
  }

  async openMissingTracking(s: ShipmentRec, situation: string, by: By) {
    const cfg = await this.core.cfg();
    const lines = await this.linesOf(s.id);
    await this.open({ kind: 'missing_tracking', group: this.factsOf(s), shipmentId: s.id, items: lines.items, itemsSummary: lines.summary, situation, dueAt: new Date(this.core.now().getTime() + cfg.validTrackingWithinHours * HOUR_MS), by, source: by.actor.kind === 'staff' ? 'staff' : 'system' });
  }

  async openFailedDelivery(s: ShipmentRec, detail: string | null) {
    const lines = await this.linesOf(s.id);
    const chooseBy = s.failed_delivery ? new Date(s.failed_delivery.chooseBy) : new Date(this.core.now().getTime() + FIRST_DEADLINE_HOURS.failed_delivery * HOUR_MS);
    const situation = `Delivery attempt failed${detail ? `: ${detail}` : ''}`;
    const { row, created } = await this.open({ kind: 'failed_delivery', group: this.factsOf(s), shipmentId: s.id, items: lines.items, itemsSummary: lines.summary, situation, dueAt: chooseBy, by: { actor: SYSTEM }, source: 'carrier' });
    if (!created && row.shipment_id !== s.id) await this.log(row.id, 'opened', `Another package failed: ${situation}`, SYSTEM);
  }

  async noteChoice(shipmentId: string, title: string, by: By) {
    for (const e of await this.repo.find('exceptions', { shipment_id: shipmentId, kind: 'failed_delivery', status: OPEN_STATUSES })) {
      await this.repo.update('exceptions', e.id, { next_step: `Customer chose: ${title}` });
      await this.log(e.id, 'customer_notified', `Customer chose: ${title}`, by.actor);
      this.core.publish('shipping.exception.updated', { exceptionId: e.id, action: 'customer_choice', by: by.actor }, by);
    }
  }

  async defaultApplied(s: ShipmentRec) {
    for (const e of await this.repo.find('exceptions', { shipment_id: s.id, kind: 'failed_delivery', status: OPEN_STATUSES })) {
      await this.repo.update('exceptions', e.id, { next_step: 'No choice in time: returning to the seller', customer_notified_at: this.core.now(), ...(byMarketly(e.fulfilled_by) ? {} : { seller_notified_at: this.core.now() }) });
      await this.log(e.id, 'customer_notified', 'No choice in time; the package returns to the seller', SYSTEM);
    }
    await this.notifyCustomerOf(s.order_id, s.id, 'failed_delivery', 'The package is returning to the seller; your refund follows when it arrives', this.core.now());
  }

  /* ---------------------------------------------------------------- reads */

  async listAdmin(f: { kind?: string | null; status?: string | null; sellerType?: string | null; ownerStaffId?: string | null; customerNotNotified?: boolean | null; q?: string | null; sellerId?: string | null }, page: PageRequest): Promise<common.Page<DeliveryException>> {
    const r = await this.repo.page(
      'exceptions',
      {
        ...(f.kind ? { kind: f.kind } : {}),
        ...(f.status ? { status: f.status } : {}),
        ...(f.sellerType === 'official' ? { owner_type: 'official' } : f.sellerType === 'marketplace' ? { owner_type: 'seller' } : {}),
        ...(f.ownerStaffId ? { owner_staff_id: f.ownerStaffId } : {}),
        ...(f.customerNotNotified ? { customer_notified_at: null, status: f.status ?? OPEN_STATUSES } : {}),
        // the seller's list holds what needs the seller's response: never a Fulfilled by Marketly package's
        ...(f.sellerId ? { owner_type: 'seller', seller_id: f.sellerId, fulfilled_by: 'seller' } : {}),
      },
      page,
      { order: { column: 'due_at', direction: 'asc' }, ...(f.q ? { search: { columns: ['order_ref', 'items_summary', 'situation', 'case_ref'], term: f.q } } : {}) },
    );
    return { ...r, items: await this.views.exceptions(r.items) };
  }

  async get(id: string, sellerId?: string): Promise<ExceptionRec> {
    const e = await this.repo.get('exceptions', id);
    if (!e || (sellerId && (e.owner_type !== 'seller' || e.seller_id !== sellerId))) throw notFound('Exception');
    return e;
  }

  async view(id: string): Promise<DeliveryException> {
    return (await this.views.exceptions([await this.get(id)]))[0]!;
  }

  async forOrder(orderId: string, sellerId?: string): Promise<DeliveryException[]> {
    const rows = await this.repo.find('exceptions', { order_id: orderId, ...(sellerId ? { owner_type: 'seller', seller_id: sellerId } : {}) }, { orderBy: [['opened_at', 'desc']] });
    return this.views.exceptions(rows);
  }

  async counts(): Promise<ExceptionCounts> {
    const c = await this.repo.exceptionCounts();
    return {
      sellerCannotFulfill: c.kinds.seller_cannot_fulfill ?? 0,
      lateDispatch: c.kinds.late_dispatch ?? 0,
      missingTracking: c.kinds.missing_tracking ?? 0,
      lostOrDamaged: c.kinds.lost_or_damaged ?? 0,
      failedDelivery: c.kinds.failed_delivery ?? 0,
      customerNotNotified: c.notNotified,
    };
  }

  /* ---------------------------------------------------------------- staff actions */

  /** A staff member's name and primary role label (access; identity's display name when access is off) */
  private async staffRef(staffId: string): Promise<{ name: string; role: string | null }> {
    const ref = await this.core.soft('access', 'getStaffRef', (a) => a.getStaffRef(staffId));
    if (ref) return { name: ref.name, role: ref.roleLabel ?? null };
    const acc = await this.core.soft('identity', 'getAccounts', (i) => i.getAccounts([staffId]));
    return { name: acc?.[0]?.displayName ?? 'Staff member', role: null };
  }

  async openManual(input: OpenExceptionInput, by: By): Promise<DeliveryException> {
    if (!input.situation?.trim()) throw invalid([{ path: 'situation', message: 'Describe the situation' }]);
    const g = await this.shipments.groupContext(input.groupId);
    let shipmentId: string | null = null;
    let lines: { title: string; variantLabel: string; quantity: number; id: string }[] = [];
    if (input.shipmentId) {
      const s = await this.repo.get('shipments', input.shipmentId);
      if (!s || s.group_id !== input.groupId) throw invalid([{ path: 'shipmentId', message: 'Not a package of this order group' }]);
      shipmentId = s.id;
      lines = (await this.repo.find('shipment_lines', { shipment_id: s.id })).map((l) => ({ id: l.order_item_id, title: l.title, variantLabel: l.variant_label, quantity: l.quantity }));
    }
    const items = g.group?.items ?? [];
    if (input.orderItemIds?.length) {
      const unknown = input.orderItemIds.filter((id) => !items.some((i) => i.id === id));
      if (unknown.length) throw invalid([{ path: 'orderItemIds', message: 'Some items are not in this order group' }]);
      lines = input.orderItemIds.map((id) => items.find((i) => i.id === id)!).map((i) => ({ id: i.id, title: i.title, variantLabel: i.variantLabel, quantity: i.quantity }));
    } else if (!lines.length) lines = g.task.openLines.map((l) => ({ id: l.orderItemId, title: l.title, variantLabel: l.variantLabel, quantity: l.quantityToShip }));
    const kind = input.kind as ExceptionKind;
    const dueAt = input.dueAt ? new Date(input.dueAt) : new Date(this.core.now().getTime() + FIRST_DEADLINE_HOURS[kind] * HOUR_MS);
    if (Number.isNaN(dueAt.getTime())) throw invalid([{ path: 'dueAt', message: 'Not a date-time' }]);
    const owner = input.ownerStaffId ? { staffId: input.ownerStaffId, ...(await this.staffRef(input.ownerStaffId)) } : null;
    const existing = await this.openFor(input.groupId, kind, shipmentId);
    if (existing) throw this.core.error('EXCEPTION_ALREADY_OPEN', `An open ${KIND_LABEL[kind].toLowerCase()} exception exists for this package`, { exceptionId: existing.id });
    const { row, created } = await this.open({
      kind,
      group: { orderId: g.task.orderId, orderRef: g.task.orderRef, groupId: g.task.groupId, ownerType: g.owner.ownerType, sellerId: g.owner.sellerId, fulfilledBy: g.fulfilledBy },
      shipmentId,
      items: lines.map((l) => ({ id: l.id, quantity: l.quantity })),
      itemsSummary: itemsSummary(lines),
      situation: input.situation.trim(),
      dueAt,
      by,
      owner,
      source: 'staff',
    });
    if (!created) throw this.core.error('EXCEPTION_ALREADY_OPEN', `An open ${KIND_LABEL[kind].toLowerCase()} exception exists for this package`, { exceptionId: row.id });
    const view = await this.view(row.id);
    await this.core.audit({ action: 'shipping.exception.open', actionLabel: `Opened a ${KIND_LABEL[kind].toLowerCase()} exception`, category: 'shipping', target: { type: 'delivery_exception', id: row.id, ref: row.order_ref, label: KIND_LABEL[kind] }, before: null, after: view }, by);
    return view;
  }

  private requireOpen(e: ExceptionRec, event: string) {
    if (!OPEN_STATUSES.includes(e.status)) throw new AppError('ILLEGAL_TRANSITION', `This exception is ${e.status}`, { machine: 'Delivery exception', from: e.status, event, allowed: deliveryExceptionMachine.eventsFrom(e.status as never) });
  }

  private updated(e: ExceptionRec, action: string, by: By) {
    this.core.publish('shipping.exception.updated', { exceptionId: e.id, action, by: by.actor }, by);
  }

  async assign(id: string, ownerStaffId: string, by: By, o: { audit?: boolean } = {}): Promise<DeliveryException> {
    const before = await this.get(id);
    this.requireOpen(before, 'assign');
    const { name, role } = await this.staffRef(ownerStaffId);
    const status = before.status === 'open' ? deliveryExceptionMachine.next('open', 'assign') : before.status;
    await this.repo.update('exceptions', id, { owner_staff_id: ownerStaffId, owner_name: name, owner_role: role, status });
    await this.log(id, 'assigned', name, by.actor);
    this.updated(before, 'assigned', by);
    const view = await this.view(id);
    if (o.audit !== false) await this.core.audit({ action: 'shipping.exception.assign', actionLabel: 'Assigned a delivery exception', category: 'shipping', target: { type: 'delivery_exception', id, ref: before.order_ref, label: KIND_LABEL[before.kind as ExceptionKind] }, before: { owner: before.owner_name, status: before.status }, after: { owner: name, status } }, by);
    return view;
  }

  /** Seller reminders (late dispatch, missing tracking, failed delivery); at most one an hour */
  async notifySeller(id: string, message: string | null | undefined, by: By): Promise<DeliveryException> {
    const e = await this.get(id);
    this.requireOpen(e, 'notify_seller');
    if (e.owner_type !== 'seller' || !e.seller_id) throw invalid([{ path: 'id', message: 'Official Store packages have no seller to remind' }]);
    if (byMarketly(e.fulfilled_by)) throw invalid([{ path: 'id', message: 'Marketly ships this package; the seller has nothing to do' }]);
    const now = this.core.now();
    if (e.seller_notified_at && now.getTime() - e.seller_notified_at.getTime() < REMIND_EVERY_MS) {
      throw new AppError('RATE_LIMITED', 'The seller was reminded less than an hour ago', { retryAfterSeconds: Math.ceil((REMIND_EVERY_MS - (now.getTime() - e.seller_notified_at.getTime())) / 1000) });
    }
    await this.core.soft('notifications', 'remind seller', (n) =>
      n.notify({
        topic: e.kind === 'late_dispatch' ? 'seller.dispatch.overdue' : 'seller.dispatch.reminder',
        recipients: [{ kind: 'seller', sellerId: e.seller_id }],
        context: { order: { ref: e.order_ref }, due: { date: instantLabel(e.due_at, this.core.tz) }, exception: { kind: KIND_LABEL[e.kind as ExceptionKind], message: message ?? null } },
        link: { kind: 'seller_order', id: e.group_id, ref: e.order_ref, label: 'Open order', screen: 'seller/order' },
        dedupeKey: `shipping.exception.remind:${e.id}:${now.getTime()}`,
        actionRequired: true,
        deadline: e.due_at.toISOString(),
        sellerId: e.seller_id,
      }),
    );
    await this.repo.update('exceptions', id, { seller_notified_at: now });
    await this.log(id, 'seller_notified', message?.trim() || null, by.actor);
    this.updated(e, 'seller_notified', by);
    return this.view(id);
  }

  private async notifyCustomerOf(orderId: string, subjectId: string, kind: string, action: string, due: Date) {
    const order = await this.orders.getOrder(orderId).catch(() => null);
    if (!order) return;
    await this.core.soft('notifications', 'notify customer', (n) =>
      n.notify({
        topic: 'customer.shipment.exception',
        // the order's customer (customers-module id) when there is one; the contact email only for guests
        recipients: [order.contact.customerId ? { kind: 'customer', customerId: order.contact.customerId } : { kind: 'guest_email', email: order.contact.email }],
        context: { order: { ref: order.ref }, exception: { kind: KIND_LABEL[kind as ExceptionKind] ?? kind, action }, due: { date: instantLabel(due, this.core.tz) } },
        link: { kind: 'shipment', id: subjectId, ref: order.ref, label: 'See next steps', screen: 'account/tracking' },
        dedupeKey: `shipping.exception.customer:${subjectId}:${this.core.now().getTime()}`,
        actionRequired: true,
        deadline: due.toISOString(),
      }),
    );
  }

  async notifyCustomer(id: string, message: string | null | undefined, by: By): Promise<DeliveryException> {
    const e = await this.get(id);
    this.requireOpen(e, 'notify_customer');
    const action = message?.trim() || `${CUSTOMER_ACTION[e.kind as ExceptionKind] ?? 'We will update you'}. Contact support if this no longer works for you.`;
    await this.notifyCustomerOf(e.order_id, e.shipment_id ?? e.order_id, e.kind, action, e.due_at);
    await this.repo.update('exceptions', id, { customer_notified_at: this.core.now() });
    await this.log(id, 'customer_notified', action, by.actor);
    this.updated(e, 'customer_notified', by);
    return this.view(id);
  }

  async requestTracking(id: string, dueAt: string, by: By): Promise<DeliveryException> {
    const e = await this.get(id);
    this.requireOpen(e, 'request_tracking');
    const due = new Date(dueAt);
    if (Number.isNaN(due.getTime()) || due.getTime() <= this.core.now().getTime()) throw invalid([{ path: 'dueAt', message: 'Give the seller a deadline in the future' }]);
    const marketly = byMarketly(e.fulfilled_by);
    if (e.seller_id && !marketly) {
      await this.core.soft('notifications', 'request tracking', (n) =>
        n.notify({
          topic: 'seller.dispatch.reminder',
          recipients: [{ kind: 'seller', sellerId: e.seller_id }],
          context: { order: { ref: e.order_ref }, due: { date: instantLabel(due, this.core.tz) } },
          link: { kind: 'seller_order', id: e.group_id, ref: e.order_ref, label: 'Add tracking', screen: 'seller/order' },
          dedupeKey: `shipping.exception.tracking:${e.id}:${due.getTime()}`,
          actionRequired: true,
          deadline: due.toISOString(),
          sellerId: e.seller_id,
        }),
      );
    }
    await this.repo.update('exceptions', id, {
      due_at: due,
      ...(marketly ? { next_step: `Marketly warehouse to confirm valid tracking by ${instantLabel(due, this.core.tz)}` } : { seller_notified_at: this.core.now(), next_step: `Seller to provide valid tracking by ${instantLabel(due, this.core.tz)}` }),
    });
    await this.log(id, 'tracking_requested', `Due ${instantLabel(due, this.core.tz)}`, by.actor);
    this.updated(e, 'tracking_requested', by);
    return this.view(id);
  }

  async escalate(id: string, to: 'seller_manager' | 'support' | 'finance' | 'returns', reason: string, by: By, o: { audit?: boolean } = {}): Promise<DeliveryException> {
    if (!reason?.trim()) throw invalid([{ path: 'reason', message: 'Say why it is escalated' }]);
    const before = await this.get(id);
    const status = before.status === 'escalated' ? 'escalated' : deliveryExceptionMachine.next(before.status as never, 'escalate');
    await this.repo.update('exceptions', id, { status, escalated_to: to });
    await this.log(id, `escalated:${to}`, reason.trim(), by.actor);
    this.updated(before, `escalated:${to}`, by);
    const view = await this.view(id);
    if (o.audit !== false) await this.core.audit({ action: 'shipping.exception.escalate', actionLabel: 'Escalated a delivery exception', category: 'shipping', target: { type: 'delivery_exception', id, ref: before.order_ref, label: KIND_LABEL[before.kind as ExceptionKind] }, before: { status: before.status, escalatedTo: before.escalated_to }, after: { status, escalatedTo: to }, reason }, by);
    return view;
  }

  async resolve(id: string, body: { kind: ResolutionKind; note: string }, by: By): Promise<DeliveryException> {
    if (!body.note?.trim()) throw invalid([{ path: 'note', message: 'Record what was done' }]);
    const before = await this.get(id);
    const status = deliveryExceptionMachine.next(before.status as never, 'resolve');
    const resolution = { kind: body.kind, note: body.note.trim(), by: by.actor, at: this.core.now().toISOString() };
    await this.repo.update('exceptions', id, { status, resolution });
    await this.log(id, `resolved:${body.kind}`, body.note.trim(), by.actor);
    this.core.publish('shipping.exception.resolved', { exceptionId: id, kind: before.kind, orderId: before.order_id, groupId: before.group_id, resolution: body.kind }, by);
    const view = await this.view(id);
    await this.core.audit({ action: 'shipping.exception.resolve', actionLabel: 'Resolved a delivery exception', category: 'shipping', target: { type: 'delivery_exception', id, ref: before.order_ref, label: KIND_LABEL[before.kind as ExceptionKind] }, before: { status: before.status }, after: { status, resolution }, reason: body.note }, by);
    return view;
  }

  async bulk(body: { ids: string[]; action: 'notify_seller' | 'assign' | 'escalate'; ownerStaffId?: string | null; to?: 'seller_manager' | 'support' | 'finance' | 'returns' | null; reason?: string | null }, by: By): Promise<{ updated: number; failed: string[] }> {
    if (body.action === 'assign' && !body.ownerStaffId) throw invalid([{ path: 'ownerStaffId', message: 'Choose the owner' }]);
    if (body.action === 'escalate' && (!body.to || !body.reason?.trim())) throw invalid([{ path: body.to ? 'reason' : 'to', message: 'Choose where to escalate and say why' }]);
    let updated = 0;
    const failed: string[] = [];
    for (const id of [...new Set(body.ids)]) {
      try {
        if (body.action === 'notify_seller') await this.notifySeller(id, body.reason ?? null, by);
        else if (body.action === 'assign') await this.assign(id, body.ownerStaffId!, by, { audit: false });
        else await this.escalate(id, body.to!, body.reason!, by, { audit: false });
        updated++;
      } catch (err) {
        if (!isAppError(err)) throw err;
        failed.push(id);
      }
    }
    await this.core.audit({ action: 'shipping.exception.bulk', actionLabel: `Bulk ${body.action.replace('_', ' ')} on delivery exceptions`, category: 'shipping', target: { type: 'delivery_exception', id: body.ids[0] ?? 'none', label: `${body.ids.length} exceptions` }, after: { action: body.action, updated, failed, ownerStaffId: body.ownerStaffId ?? null, to: body.to ?? null }, ...(body.reason ? { reason: body.reason } : {}) }, by);
    return { updated, failed };
  }

  /* ---------------------------------------------------------------- seller response */

  async respond(sellerId: string, id: string, body: { action: 'tracking_provided' | 'will_ship_by' | 'cannot_fulfill' | 'replacement_sent' | 'other'; trackingNumber?: string | null; shipBy?: string | null; note?: string | null }, by: By): Promise<DeliveryException> {
    const e = await this.get(id, sellerId);
    this.core.refuseIfMarketly(e.fulfilled_by);
    this.requireOpen(e, 'seller_response');
    const issues: { path: string; message: string }[] = [];
    let shipBy: Date | null = null;
    if (body.action === 'tracking_provided' && !body.trackingNumber?.trim()) issues.push({ path: 'trackingNumber', message: 'Enter the tracking number' });
    if (body.action === 'tracking_provided' && !e.shipment_id) issues.push({ path: 'action', message: 'Record the shipment from the order to add tracking' });
    if (body.action === 'will_ship_by') {
      shipBy = body.shipBy ? new Date(body.shipBy) : null;
      if (!shipBy || Number.isNaN(shipBy.getTime()) || shipBy.getTime() <= this.core.now().getTime()) issues.push({ path: 'shipBy', message: 'Promise a ship-by time in the future' });
    }
    if ((body.action === 'other' || body.action === 'cannot_fulfill') && !body.note?.trim()) issues.push({ path: 'note', message: 'Add a note for the customer and our team' });
    if (issues.length) throw invalid(issues);
    if (body.action === 'tracking_provided') {
      try {
        await this.shipments.correct(e.shipment_id!, { trackingNumber: body.trackingNumber!, reason: body.note?.trim() || 'Tracking provided for a missing tracking exception' }, by, { sellerId });
      } catch (err) {
        if (isAppError(err) && ['TRACKING_FORMAT_INVALID', 'TRACKING_ALREADY_USED'].includes(err.code)) throw invalid([{ path: 'trackingNumber', message: err.message }]);
        throw err;
      }
    }
    const response = { action: body.action, note: body.note?.trim() || null, shipBy: shipBy ? shipBy.toISOString() : null, at: this.core.now().toISOString(), by: by.actor };
    await this.repo.update('exceptions', id, {
      seller_response: response,
      ...(shipBy && e.kind === 'late_dispatch' ? { due_at: shipBy, next_step: `Seller promised to ship by ${instantLabel(shipBy, this.core.tz)}` } : {}),
      ...(body.action === 'cannot_fulfill' ? { next_step: 'Cancel the items and refund the customer' } : {}),
      ...(body.action === 'replacement_sent' ? { next_step: 'Seller sent a replacement' } : {}),
    });
    await this.log(id, `seller_responded:${body.action}`, [body.note?.trim(), shipBy ? `Ship by ${instantLabel(shipBy, this.core.tz)}` : null, body.trackingNumber?.trim()].filter(Boolean).join(' · ') || null, by.actor);
    this.updated(e, `seller_responded:${body.action}`, by);
    if (shipBy && e.kind === 'late_dispatch') {
      // the promise becomes the group's dispatch deadline; missing it again escalates to the Seller Manager
      await this.orders.setDispatchDeadline(e.group_id, shipBy.toISOString(), 'Seller promised a ship-by date', by.actor).catch((err) => {
        if (!isAppError(err)) throw err;
      });
    }
    if (body.action === 'cannot_fulfill' && e.kind !== 'seller_cannot_fulfill') {
      await this.open({
        kind: 'seller_cannot_fulfill',
        group: { orderId: e.order_id, orderRef: e.order_ref, groupId: e.group_id, ownerType: e.owner_type as 'seller', sellerId: e.seller_id, fulfilledBy: fulfilledByOf(e.owner_type, e.fulfilled_by) },
        shipmentId: e.shipment_id,
        items: [],
        itemsSummary: e.items_summary,
        situation: `Seller cannot fulfill: ${body.note!.trim()}`,
        dueAt: new Date(this.core.now().getTime() + FIRST_DEADLINE_HOURS.seller_cannot_fulfill * HOUR_MS),
        by,
        source: 'seller',
      });
    }
    return this.view(id);
  }

  /* ---------------------------------------------------------------- dispatch watch and late dispatch (scenario 5) */

  /** orders.order.accepted: watch each group's deadline (with its fulfilledBy); a late acceptance moves the deadline */
  async onOrderAccepted(e: EventPayload<'orders.order.accepted'>) {
    const acceptedAt = new Date(e.acceptedAt);
    let placedAt: Date | null = null;
    for (const g of e.groups) {
      let due = new Date(g.dispatchBy);
      const fulfilledBy = fulfilledByOf(g.ownerType, g.fulfilledBy);
      const sellerId = g.ownerType === 'official' ? null : (g.sellerId ?? null);
      const inserted = await this.repo.insertIfAbsent('dispatch_watch', { group_id: g.groupId, order_id: e.orderId, owner_type: g.ownerType, seller_id: sellerId, fulfilled_by: fulfilledBy, due_at: due, open_item_ids: g.itemIds, overdue_since: null });
      if (!inserted) continue;
      placedAt ??= await this.orders.getOrder(e.orderId).then((o) => (o ? new Date(o.placedAt) : null), () => null);
      if (!placedAt || this.core.today(acceptedAt) <= this.core.today(placedAt)) continue;
      // payment accepted on a later day: the deadline counts from acceptance with the same handling days, on the
      // Official schedule for warehouse-shipped groups (Official Store and Fulfilled by Marketly)
      const w = await this.estimates.world(placedAt);
      const owner = scheduleOwner({ ownerType: g.ownerType, sellerId }, fulfilledBy);
      const schedule = await this.estimates.schedule(w, owner);
      let handling: number | null = null;
      for (let h = 0; h <= 10; h++) {
        if (this.core.today((await this.estimates.plan(w, owner, { businessDays: h }, schedule)).dueAt) === this.core.today(due)) {
          handling = h;
          break;
        }
      }
      const later = await this.estimates.plan(await this.estimates.world(acceptedAt), owner, { businessDays: handling });
      if (later.dueAt.getTime() > due.getTime()) {
        due = later.dueAt;
        await this.repo.update('dispatch_watch', g.groupId, { due_at: due });
        await this.orders.setDispatchDeadline(g.groupId, due.toISOString(), 'Payment accepted after the order was placed', SYSTEM).catch((err) => {
          if (!isAppError(err)) throw err;
          this.core.ctx.log.info({ err, groupId: g.groupId }, 'shipping: deadline recalculation not applied');
        });
      }
    }
  }

  /** orders.dispatch_deadline.changed: the watch follows (a later deadline can be missed again) */
  async onDeadlineChanged(e: EventPayload<'orders.dispatch_deadline.changed'>) {
    const w = await this.repo.get('dispatch_watch', e.groupId);
    if (!w) return;
    const due = new Date(e.dueAt);
    if (Number.isNaN(due.getTime()) || w.due_at.getTime() === due.getTime()) return;
    await this.repo.update('dispatch_watch', e.groupId, { due_at: due, ...(due.getTime() > this.core.now().getTime() ? { overdue_since: null } : {}) });
    for (const ex of await this.repo.find('exceptions', { group_id: e.groupId, kind: 'late_dispatch', status: OPEN_STATUSES })) await this.log(ex.id, 'deadline_moved', `New dispatch deadline ${instantLabel(due, this.core.tz)}: ${e.reason}`, e.by ?? SYSTEM);
  }

  /** Job: groups past their deadline with unshipped items open late_dispatch once per group and deadline */
  async detectLateDispatch(): Promise<void> {
    const now = this.core.now();
    const due = await this.repo.find('dispatch_watch', { due_at: { op: '<=', value: now }, overdue_since: null }, { orderBy: [['due_at', 'asc']], limit: 100 });
    for (const w of due) await this.lateOne(w, now);
  }

  private async lateOne(w: WatchRec, now: Date) {
    let task;
    try {
      task = await this.orders.getFulfillmentTask(w.group_id);
    } catch (err) {
      if (isAppError(err) && err.status === 404) await this.repo.removeWhere('dispatch_watch', { group_id: w.group_id });
      else this.core.ctx.log.warn({ err, groupId: w.group_id }, 'shipping: late dispatch check skipped');
      return;
    }
    const open = task.openLines;
    if (!open.length) {
      await this.repo.removeWhere('dispatch_watch', { group_id: w.group_id });
      return;
    }
    // once per group and deadline: whoever sets overdue_since first raises it
    if (!(await this.repo.updateWhere('dispatch_watch', { group_id: w.group_id, overdue_since: null, due_at: w.due_at }, { overdue_since: now, open_item_ids: open.map((l) => l.orderItemId) }))) return;
    const by: By = { actor: SYSTEM };
    const respondBy = new Date(now.getTime() + FIRST_DEADLINE_HOURS.late_dispatch * HOUR_MS);
    const existing = (await this.repo.find('exceptions', { group_id: w.group_id, kind: 'late_dispatch', status: OPEN_STATUSES }))[0];
    const fulfilledBy = fulfilledByOf(w.owner_type, w.fulfilled_by);
    // only a seller who ships its own package is late; Marketly's warehouse is late for Fulfilled by Marketly groups
    const sellerShips = w.owner_type === 'seller' && fulfilledBy === 'seller';
    let exceptionId: string;
    if (existing) {
      // a seller who misses a second deadline goes to the Seller Manager
      exceptionId = existing.id;
      await this.repo.update('exceptions', existing.id, { due_at: respondBy, ...(sellerShips ? { seller_notified_at: now } : {}), situation: `Missed the new dispatch deadline of ${instantLabel(w.due_at, this.core.tz)}` });
      await this.log(existing.id, 'missed_deadline', `Deadline ${instantLabel(w.due_at, this.core.tz)} passed with ${open.length} item${open.length === 1 ? '' : 's'} unshipped`, SYSTEM);
      if (existing.status !== 'escalated' && sellerShips) await this.escalate(existing.id, 'seller_manager', 'The seller missed a second dispatch deadline', by, { audit: false });
    } else {
      const { row } = await this.open({
        kind: 'late_dispatch',
        group: { orderId: task.orderId, orderRef: task.orderRef, groupId: w.group_id, ownerType: w.owner_type as 'seller', sellerId: w.seller_id, fulfilledBy },
        items: open.map((l) => ({ id: l.orderItemId, quantity: l.quantityToShip })),
        itemsSummary: itemsSummary(open.map((l) => ({ title: l.title, variantLabel: l.variantLabel, quantity: l.quantityToShip }))),
        situation: `Not dispatched by ${instantLabel(w.due_at, this.core.tz)}`,
        dueAt: respondBy,
        by,
        sellerNotified: sellerShips,
        // shipping.dispatch.overdue carries the exception to orders, notifications, sellers and workqueues
        publish: false,
        source: 'system',
      });
      exceptionId = row.id;
    }
    this.core.publish('shipping.dispatch.overdue', { orderId: task.orderId, orderRef: task.orderRef, groupId: w.group_id, ownerType: w.owner_type as 'seller', sellerId: w.seller_id, fulfilledBy, orderItemIds: open.map((l) => l.orderItemId), dueAt: w.due_at.toISOString(), exceptionId }, by);
  }

  /** Job: no tracking, an invalid number, or a label or dispatch without a carrier scan after the grace period */
  async detectMissingTracking(): Promise<void> {
    const cfg = await this.core.cfg();
    const now = this.core.now();
    const labelCutoff = new Date(now.getTime() - cfg.labelScanGraceHours * HOUR_MS);
    const shippedCutoff = new Date(now.getTime() - cfg.validTrackingWithinHours * HOUR_MS);
    const candidates = [
      ...(await this.repo.find('shipments', { kind: ['outbound', 'replacement'], tracking_state: ['missing', 'invalid'], status: ['shipped', 'label_created'] }, { limit: 200 })),
      ...(await this.repo.find('shipments', { kind: ['outbound', 'replacement'], tracking_state: 'pending', status: 'label_created', created_at: { op: '<=', value: labelCutoff } }, { limit: 200 })),
      ...(await this.repo.find('shipments', { kind: ['outbound', 'replacement'], tracking_state: 'pending', status: 'shipped', shipped_at: { op: '<=', value: shippedCutoff } }, { limit: 200 })),
    ];
    const raised = await this.shipmentsWithException(candidates, 'missing_tracking');
    for (const s of candidates) {
      if (raised.has(s.id)) continue;
      const situation =
        s.tracking_state === 'missing'
          ? 'Shipped without a tracking number'
          : s.tracking_state === 'invalid'
            ? `${(s.carrier_code ?? 'Carrier').toUpperCase()} number not recognized`
            : s.status === 'label_created'
              ? `Label created, no scan ${cfg.labelScanGraceHours} h`
              : `Shipped, no carrier scan ${cfg.validTrackingWithinHours} h`;
      await this.openMissingTracking(s, situation, { actor: SYSTEM });
    }
  }

  /** Shipments among rows that already have an exception of the kind, in any status (one read) */
  private async shipmentsWithException(rows: readonly ShipmentRec[], kind: ExceptionKind): Promise<Set<string>> {
    if (!rows.length) return new Set();
    const found = await this.repo.find('exceptions', { shipment_id: rows.map((s) => s.id), kind });
    return new Set(found.map((e) => e.shipment_id!));
  }

  /** Job: packages with no carrier scan for stalledNoScanDays open a lost_or_damaged review */
  async detectStalled(): Promise<void> {
    const cfg = await this.core.cfg();
    const now = this.core.now();
    const cutoff = new Date(now.getTime() - cfg.stalledNoScanDays * DAY_MS);
    const moving = await this.repo.find('shipments', { status: ['shipped', 'in_transit', 'out_for_delivery'], shipped_at: { op: '<=', value: cutoff } }, { limit: 300 });
    // one review per package: a resolved one is not reopened every day
    const reviewed = await this.shipmentsWithException(moving, 'lost_or_damaged');
    for (const s of moving) {
      if (reviewed.has(s.id)) continue;
      const last = (await this.repo.find('tracking_events', { shipment_id: s.id, source: ['carrier_webhook', 'carrier_poll'] }, { orderBy: [['at', 'desc']], limit: 1 }))[0];
      const since = last?.at ?? s.shipped_at!;
      if (since.getTime() > cutoff.getTime()) continue;
      const lines = await this.linesOf(s.id);
      await this.open({
        kind: 'lost_or_damaged',
        group: this.factsOf(s),
        shipmentId: s.id,
        items: lines.items,
        itemsSummary: lines.summary,
        situation: `No carrier scan for ${Math.floor((now.getTime() - since.getTime()) / DAY_MS)} days`,
        nextStep: 'Check with the carrier; agree a remedy with the customer if the package is lost',
        dueAt: new Date(now.getTime() + FIRST_DEADLINE_HOURS.lost_or_damaged * HOUR_MS),
        by: { actor: SYSTEM },
        source: 'system',
      });
    }
  }

  /* ---------------------------------------------------------------- events from other modules */

  /** orders.item.cancelled: off the watch; a seller cancellation opens seller_cannot_fulfill; nothing left closes dispatch exceptions; unused labels are voided */
  async onItemCancelled(e: EventPayload<'orders.item.cancelled'>) {
    const w = await this.repo.get('dispatch_watch', e.groupId);
    if (w) await this.repo.update('dispatch_watch', e.groupId, { open_item_ids: w.open_item_ids.filter((id) => id !== e.itemId) });
    if (e.initiatedBy === 'seller') {
      const refund = e.refund?.total ? format(e.refund.total) : null;
      const situation = `${e.quantity} item${e.quantity === 1 ? '' : 's'} cancelled by the seller (${e.reasonCode.replace(/_/g, ' ')})`;
      const lines = await this.orders.getOrder(e.orderId).then((o) => o?.groups.flatMap((g) => g.items).find((i) => i.id === e.itemId) ?? null, () => null);
      const summary = lines ? itemsSummary([{ title: lines.title, variantLabel: lines.variantLabel, quantity: e.quantity }]) : `${e.quantity} item${e.quantity === 1 ? '' : 's'}`;
      const { row, created } = await this.open({
        kind: 'seller_cannot_fulfill',
        group: { orderId: e.orderId, orderRef: e.ref, groupId: e.groupId, ownerType: e.ownerType, sellerId: e.sellerId ?? null, fulfilledBy: fulfilledByOf(e.ownerType, e.fulfilledBy ?? w?.fulfilled_by) },
        items: [{ id: e.itemId, quantity: e.quantity }],
        itemsSummary: summary,
        situation,
        nextStep: refund ? `Cancel item, refund ${refund}` : DEFAULT_NEXT_STEP.seller_cannot_fulfill,
        dueAt: new Date(this.core.now().getTime() + FIRST_DEADLINE_HOURS.seller_cannot_fulfill * HOUR_MS),
        by: { actor: SYSTEM },
        source: 'seller',
      });
      if (!created && !row.items_summary.includes(summary)) {
        // the item joins the open exception with its units
        const ids = row.order_item_ids.includes(e.itemId) ? row.order_item_ids : [...row.order_item_ids, e.itemId];
        const quantities = [...((row.item_quantities as { order_item_id: string; quantity: number }[] | null) ?? []).filter((q) => q.order_item_id !== e.itemId), { order_item_id: e.itemId, quantity: e.quantity }];
        await this.repo.update('exceptions', row.id, { items_summary: `${row.items_summary}; ${summary}`, situation: `${row.situation}; ${situation}`, order_item_ids: ids, item_quantities: quantities as never });
        await this.log(row.id, 'opened', situation, SYSTEM);
      }
    }
    const task = await this.orders.getFulfillmentTask(e.groupId).catch(() => null);
    const nothingLeft = task ? !task.openLines.length : false;
    if (nothingLeft) {
      await this.repo.removeWhere('dispatch_watch', { group_id: e.groupId });
      await this.clear({ groupId: e.groupId, kinds: ['late_dispatch'] }, 'cancelled_refunded', 'Nothing left to ship: the items were cancelled');
    }
    // unused labels for the cancelled item (or for a group with nothing left to ship) are voided
    const waiting = await this.repo.find('shipments', { group_id: e.groupId, status: 'label_created', kind: ['outbound', 'replacement'] });
    for (const s of waiting) {
      const lines = await this.repo.find('shipment_lines', { shipment_id: s.id });
      if (!nothingLeft && !lines.every((l) => l.order_item_id === e.itemId)) continue;
      for (const l of await this.repo.find('labels', { shipment_id: s.id, status: 'purchased' })) {
        await this.shipments.voidLabel(l.id, 'Items cancelled', { actor: SYSTEM }).catch((err) => {
          if (!isAppError(err)) throw err;
        });
      }
    }
  }

  /** sellers.seller.restricted: the seller's open exceptions are marked for escalation to the Seller Manager */
  async onSellerRestricted(e: EventPayload<'sellers.seller.restricted'>) {
    // Fulfilled by Marketly exceptions stay with the Shipping Manager: the seller has no part in them
    const rows = await this.repo.find('exceptions', { owner_type: 'seller', seller_id: e.sellerId, fulfilled_by: 'seller', status: ['open', 'in_progress'] });
    for (const x of rows) {
      await this.repo.update('exceptions', x.id, { status: deliveryExceptionMachine.next(x.status as never, 'escalate'), escalated_to: 'seller_manager' });
      await this.log(x.id, 'marked_for_escalation', `Seller restricted: ${e.reason}`, SYSTEM);
      this.core.publish('shipping.exception.updated', { exceptionId: x.id, action: 'escalated:seller_manager', by: SYSTEM });
    }
  }

  /** support.case.opened: a missing or damaged package report opens lost_or_damaged when none is open */
  async onCaseOpened(e: EventPayload<'support.case.opened'>) {
    if (!e.orderId || !CASE_KINDS.test(`${e.kind} ${e.category}`)) return;
    const order = await this.orders.getOrder(e.orderId).catch(() => null);
    if (!order) return;
    const items = order.groups.flatMap((g) => g.items.map((i) => ({ ...i, groupId: g.id })));
    const chosen = e.orderItemIds.length ? items.filter((i) => e.orderItemIds.includes(i.id)) : items;
    const groups = [...new Set(chosen.map((i) => i.groupId))];
    for (const groupId of groups) {
      const g = order.groups.find((x) => x.id === groupId)!;
      const own = chosen.filter((i) => i.groupId === groupId);
      const shipment = (await this.repo.find('shipments', { group_id: groupId, kind: ['outbound', 'replacement'], status: { op: '<>', value: 'cancelled' } }, { orderBy: [['created_at', 'desc']] })).find((s) => own.some((i) => i.shipmentId === s.id)) ?? null;
      const { row, created } = await this.open({
        kind: 'lost_or_damaged',
        group: { orderId: order.id, orderRef: order.ref, groupId, ownerType: g.seller.ownerType, sellerId: g.seller.ownerType === 'official' ? null : (g.seller.id ?? null), fulfilledBy: fulfilledByOf(g.seller.ownerType, g.fulfilledBy) },
        shipmentId: shipment?.id ?? null,
        items: own.map((i) => ({ id: i.id, quantity: i.quantity })),
        itemsSummary: itemsSummary(own.map((i) => ({ title: i.title, variantLabel: i.variantLabel, quantity: i.quantity }))),
        situation: `Customer reported: ${e.category.replace(/_/g, ' ')} (case ${e.ref})`,
        dueAt: new Date(this.core.now().getTime() + FIRST_DEADLINE_HOURS.lost_or_damaged * HOUR_MS),
        by: { actor: SYSTEM },
        caseRef: e.ref,
        // support already holds the report as a case: it must not open a second case for it
        source: 'customer_report',
      });
      if (!created && !row.case_ref) await this.repo.update('exceptions', row.id, { case_ref: e.ref });
    }
  }

  /** returns.replacement.created: the replacement's dispatch is watched like an original shipment */
  async onReplacementCreated(e: EventPayload<'returns.replacement.created'>) {
    const order = await this.orders.getOrder(e.orderId).catch(() => null);
    const group = order?.groups.find((g) => g.items.some((i) => i.id === e.orderItemId || i.replacementOfItemId === e.orderItemId));
    if (!order || !group) return;
    const owner = { ownerType: e.ownerType, sellerId: e.ownerType === 'official' ? null : (e.sellerId ?? null) };
    const fulfilledBy = fulfilledByOf(e.ownerType, group.fulfilledBy);
    const plan = await this.estimates.plan(await this.estimates.world(), scheduleOwner(owner, fulfilledBy), { businessDays: null });
    const existing = await this.repo.get('dispatch_watch', group.id);
    if (!existing) {
      await this.repo.insertIfAbsent('dispatch_watch', { group_id: group.id, order_id: e.orderId, owner_type: e.ownerType, seller_id: owner.sellerId, fulfilled_by: fulfilledBy, due_at: plan.dueAt, open_item_ids: [`replacement:${e.replacementId}`], overdue_since: null });
    } else if (!existing.open_item_ids.includes(`replacement:${e.replacementId}`)) {
      await this.repo.update('dispatch_watch', group.id, { open_item_ids: [...existing.open_item_ids, `replacement:${e.replacementId}`], ...(existing.overdue_since ? { due_at: plan.dueAt, overdue_since: null } : {}) });
    }
  }

  /** payments.refund.sent: seller_cannot_fulfill exceptions on the refunded items close */
  async onRefundSent(e: EventPayload<'payments.refund.sent'>) {
    const groups = [...new Set(e.items.map((i) => i.groupId))];
    if (!groups.length) return;
    const rows = await this.repo.find('exceptions', { order_id: e.orderId, group_id: groups, kind: 'seller_cannot_fulfill', status: OPEN_STATUSES });
    for (const x of rows) await this.closeOne(x, 'cancelled_refunded', `Refund ${e.ref} of ${format(e.amount)} sent`);
  }

  /* ---------------------------------------------------------------- carrier claims */

  async listClaims(f: { status?: string | null; carrierCode?: string | null; sellerId?: string | null }, page: PageRequest): Promise<common.Page<CarrierClaim>> {
    const r = await this.repo.page('claims', { ...(f.status ? { status: f.status } : {}), ...(f.carrierCode ? { carrier_code: f.carrierCode } : {}), ...(f.sellerId ? { seller_id: f.sellerId } : {}) }, page, { order: { column: 'id', direction: 'desc' } });
    return { ...r, items: await this.claimViews(r.items) };
  }

  private async claimViews(rows: Parameters<Views['claims']>[0]) {
    const cfg = await this.core.cfg();
    const views = await this.views.claims(rows);
    // claims above the limit without access to request approval still show that Finance must approve
    return views.map((v) => (v.approval || v.filedBy !== 'platform' || v.status !== 'draft' || v.amount.amount <= cfg.claimFinanceApprovalAbove.amount ? v : { ...v, approval: { required: true, reason: `Claims above ${format(cfg.claimFinanceApprovalAbove)} need Finance approval`, approvalRequestId: null, approvers: ['Finance Manager'] } }));
  }

  private async claimView(id: string) {
    return (await this.claimViews([(await this.repo.get('claims', id))!]))[0]!;
  }

  private claimEvent(c: { id: string; order_id: string; seller_id: string | null; filed_by: string; status: string; amount: number; currency: string; paid_amount: number | null }, by: By) {
    this.core.publish('shipping.claim.status_changed', { claimId: c.id, orderId: c.order_id, sellerId: c.seller_id, filedBy: c.filed_by, status: c.status, amount: money(c.amount, c.currency), paidAmount: c.paid_amount != null ? money(c.paid_amount, c.currency) : null }, by);
  }

  private async claimBasics(input: ClaimInput, sellerId?: string) {
    const issues: { path: string; message: string }[] = [];
    if (!input.note?.trim()) issues.push({ path: 'note', message: 'Describe the claim' });
    if (!(input.amount.amount > 0) || input.amount.currency !== this.core.currency) issues.push({ path: 'amount', message: `A positive amount in ${this.core.currency}` });
    if (issues.length) throw invalid(issues);
    const s = await this.repo.get('shipments', input.shipmentId);
    if (!s || (sellerId && (s.owner_type !== 'seller' || s.seller_id !== sellerId))) throw notFound('Shipment');
    let exception: ExceptionRec | null = null;
    if (input.exceptionId) {
      exception = (await this.repo.get('exceptions', input.exceptionId)) ?? null;
      if (!exception || exception.order_id !== s.order_id || (sellerId && exception.seller_id !== sellerId)) throw invalid([{ path: 'exceptionId', message: 'Not an exception on this order' }]);
    }
    const carrier = (await this.repo.find('carriers', { code: input.carrierCode.trim().toLowerCase() }))[0];
    if (!carrier) throw invalid([{ path: 'carrierCode', message: 'Unknown carrier' }]);
    if (input.evidenceIds?.length) {
      const refs = await this.core.soft('media', 'claim evidence', (m) => m.refs(input.evidenceIds!));
      if (refs && refs.length < new Set(input.evidenceIds).size) throw invalid([{ path: 'evidenceIds', message: 'Upload the evidence first' }]);
    }
    return { s, exception, carrier };
  }

  private async linkClaim(exception: ExceptionRec | null, claimId: string, by: By) {
    if (!exception) return;
    await this.repo.update('exceptions', exception.id, { claim_id: claimId });
    await this.log(exception.id, 'claim_filed', null, by.actor);
    this.updated(exception, 'claim_filed', by);
  }

  /** Staff open a carrier claim (draft); above the limit it waits for Finance approval before it can be submitted */
  async openClaim(input: ClaimInput, by: By): Promise<CarrierClaim> {
    const { s, exception, carrier } = await this.claimBasics(input);
    const id = newId();
    let approvalRequestId: string | null = null;
    const access = this.core.ctx.tryUse('access');
    if (access && by.principal) {
      const check = await access.check(by.principal as identity.Principal, 'shipping.claims.open', { money: input.amount });
      if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason);
      if (check.decision === 'approval_required') {
        const req = await access.requestApproval({
          action: 'shipping.claims.open',
          target: { type: 'carrier_claim', id, ref: s.order_ref, label: `${carrier.name} claim for ${s.order_ref}`, sellerId: s.seller_id, screen: 'admin/shipping' },
          amount: input.amount,
          summary: `${carrier.name} claim of ${format(input.amount)} for ${s.order_ref}`,
          reason: input.note.trim(),
          requestedBy: by.principal as identity.Principal,
        });
        approvalRequestId = req.id;
      }
    }
    const owner = by.actor.name ?? (by.actor.id ? (await this.staffRef(by.actor.id)).name : 'Shipping Manager');
    const row = await this.repo.insert('claims', {
      id,
      claim_number: input.claimNumber?.trim() || null,
      carrier_code: carrier.code,
      order_id: s.order_id,
      shipment_id: s.id,
      exception_id: exception?.id ?? null,
      amount: input.amount.amount,
      currency: input.amount.currency,
      filed_by: 'platform',
      seller_id: s.seller_id,
      filed_at: null,
      status: carrierClaimMachine.initial,
      owner,
      evidence_ids: [...new Set(input.evidenceIds ?? [])],
      approval_request_id: approvalRequestId,
      paid_amount: null,
      decided_at: null,
      note: input.note.trim(),
    });
    await this.linkClaim(exception, id, by);
    this.claimEvent(row, by);
    const view = await this.claimView(id);
    await this.core.audit({ action: 'shipping.claim.open', actionLabel: 'Opened a carrier claim', category: 'shipping', target: { type: 'carrier_claim', id, ref: s.order_ref, label: `${carrier.name} claim` }, before: null, after: view, reason: input.note }, by);
    return view;
  }

  /** Sellers record a claim filed with their own carrier account (submitted) */
  async recordSellerClaim(sellerId: string, input: ClaimInput, by: By): Promise<CarrierClaim> {
    const { s, exception, carrier } = await this.claimBasics(input, sellerId);
    const id = newId();
    const row = await this.repo.insert('claims', {
      id,
      claim_number: input.claimNumber?.trim() || null,
      carrier_code: carrier.code,
      order_id: s.order_id,
      shipment_id: s.id,
      exception_id: exception?.id ?? null,
      amount: input.amount.amount,
      currency: input.amount.currency,
      filed_by: 'seller',
      seller_id: sellerId,
      filed_at: this.core.today(),
      status: carrierClaimMachine.next('draft', 'submit'),
      owner: by.actor.name ?? 'Seller',
      evidence_ids: [...new Set(input.evidenceIds ?? [])],
      approval_request_id: null,
      paid_amount: null,
      decided_at: null,
      note: input.note.trim(),
    });
    await this.linkClaim(exception, id, by);
    this.claimEvent(row, by);
    return this.claimView(id);
  }

  async claimStatus(id: string, body: { event: 'submit' | 'carrier_reviews' | 'pay' | 'reject' | 'withdraw'; claimNumber?: string | null; paidAmount?: common.Money | null; note: string }, by: By): Promise<CarrierClaim> {
    if (!body.note?.trim()) throw invalid([{ path: 'note', message: 'Add a note' }]);
    const before = await this.repo.get('claims', id);
    if (!before) throw notFound('Claim');
    const status = carrierClaimMachine.next(before.status as never, body.event);
    if (body.event === 'submit') {
      const cfg = await this.core.cfg();
      if (before.approval_request_id) {
        const req = await this.core.soft('access', 'getApproval', (a) => a.getApproval(before.approval_request_id!));
        if (req?.status !== 'approved') throw new AppError('APPROVAL_REQUIRED', 'Finance has not approved this claim yet', { approvalRequestId: before.approval_request_id, status: req?.status ?? 'unknown' });
      } else if (!this.core.ctx.tryUse('access') && before.amount > cfg.claimFinanceApprovalAbove.amount) {
        throw new AppError('APPROVAL_REQUIRED', `Claims above ${format(cfg.claimFinanceApprovalAbove)} need Finance approval`, { approvalRequestId: null });
      }
    }
    if (body.event === 'pay' && (!body.paidAmount || body.paidAmount.amount <= 0 || body.paidAmount.currency !== before.currency)) throw invalid([{ path: 'paidAmount', message: 'Enter the amount the carrier paid' }]);
    const now = this.core.now();
    const after = await this.repo.update('claims', id, {
      status,
      ...(body.claimNumber?.trim() ? { claim_number: body.claimNumber.trim() } : {}),
      ...(body.event === 'submit' ? { filed_at: this.core.today(now) } : {}),
      ...(body.event === 'pay' ? { paid_amount: body.paidAmount!.amount } : {}),
      ...(['pay', 'reject', 'withdraw'].includes(body.event) ? { decided_at: now } : {}),
      note: body.note.trim(),
    });
    if (body.event === 'submit' && after.exception_id) {
      const ex = await this.repo.get('exceptions', after.exception_id);
      if (ex) await this.log(ex.id, 'claim_filed', `Claim submitted${after.claim_number ? ` (${after.claim_number})` : ''}`, by.actor);
    }
    this.claimEvent(after, by);
    const view = await this.claimView(id);
    await this.core.audit({ action: 'shipping.claim.status', actionLabel: `Carrier claim: ${body.event.replace('_', ' ')}`, category: 'shipping', target: { type: 'carrier_claim', id, ref: after.claim_number ?? undefined, label: 'Carrier claim' }, before, after, reason: body.note }, by);
    return view;
  }

  /* ---------------------------------------------------------------- export */

  async exportRows(dataset: string, filters: unknown, _principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    if (dataset !== 'shipping.admin.exceptions') throw invalid([{ path: 'dataset', message: 'Unknown dataset' }]);
    const f = (filters && typeof filters === 'object' ? filters : {}) as Record<string, unknown>;
    const s = (k: string) => (typeof f[k] === 'string' && f[k] ? (f[k] as string) : null);
    const page = await this.listAdmin({ kind: s('kind'), status: s('status'), sellerType: s('sellerType'), ownerStaffId: s('ownerStaffId'), customerNotNotified: f.customerNotNotified === true || f.customerNotNotified === 'true', q: s('q') }, { mode: 'cursor', cursor: cursor ?? null, limit: 100 });
    return {
      rows: page.items.map((e) => ({
        id: e.id,
        kind: KIND_LABEL[e.kind as ExceptionKind] ?? e.kind,
        orderRef: e.orderRef,
        seller: e.sellerName,
        items: e.itemsSummary,
        situation: e.situation,
        nextStep: e.nextStep,
        owner: e.owner?.name ?? '',
        dueAt: e.deadline.dueAt,
        deadlineState: e.deadline.state,
        status: e.status,
        escalatedTo: e.escalatedTo ?? '',
        customerNotifiedAt: e.customerNotifiedAt ?? '',
        sellerNotifiedAt: e.sellerNotifiedAt ?? '',
        openedAt: e.openedAt,
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async registerDataset() {
    await this.core.soft('reports', 'registerDataset', (r) =>
      r.registerDataset({
        key: 'shipping.admin.exceptions' as never,
        owner: 'shipping',
        title: 'Delivery exceptions',
        permission: 'shipping.exceptions.view',
        audience: 'staff',
        screens: ['ops/dispatch'],
        available: true,
        phase: 1,
        columns: [
          { key: 'kind', label: 'Kind' },
          { key: 'orderRef', label: 'Order' },
          { key: 'seller', label: 'Seller' },
          { key: 'items', label: 'Items' },
          { key: 'situation', label: 'Situation' },
          { key: 'nextStep', label: 'Next step' },
          { key: 'owner', label: 'Owner' },
          { key: 'dueAt', label: 'Due' },
          { key: 'deadlineState', label: 'Deadline' },
          { key: 'status', label: 'Status' },
          { key: 'escalatedTo', label: 'Escalated to' },
          { key: 'customerNotifiedAt', label: 'Customer notified' },
          { key: 'sellerNotifiedAt', label: 'Seller notified' },
          { key: 'openedAt', label: 'Opened' },
        ],
      }),
    );
  }
}
