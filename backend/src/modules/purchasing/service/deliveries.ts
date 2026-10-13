/**
 * Deliveries of purchase orders: arrival windows, delays (by hand, or flagged late by the job), arrival at the dock,
 * and the receiving dashboard figures.
 */
import { dateInZone, zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { Page, PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { Delivery, DeliveryInput, DeliveryUpdate, ReceivingStats } from '../../../spec/purchasing.js';
import { ACTIVE_CLAIM_STATUSES, addDays, INCOMING_PO_STATUSES, invalid, openQty, shortageOf, shortDate, startOfWeek, SUBMITTED_RECEIPT_STATUSES, SYSTEM } from '../domain/rules.js';
import { deliveryMachine } from '../domain/state-machines.js';
import type { ReceiptRow } from '../ports.js';
import { clean, dockText, groupBy, illegal, notFound, required, type Caller, type Core } from './core.js';

const LATE_BATCH = 200;
const SHORTAGE_LOOKBACK_DAYS = 180;

export class Deliveries {
  constructor(private readonly core: Core) {}

  async listDeliveries(query: { date?: string; status?: Delivery['status']; purchaseOrderId?: string }, page: PageRequest): Promise<Page<Delivery>> {
    const tz = this.core.ctx.config.market.timeZone;
    const range = query.date ? { from: zonedTimeToUtc(query.date, '00:00', tz), to: zonedTimeToUtc(addDays(query.date, 1), '00:00', tz) } : {};
    const p = await this.core.repo.listDeliveries({ status: query.status, purchaseOrderId: query.purchaseOrderId, ...range }, page);
    return { ...p, items: await this.core.views.deliveries(p.items) };
  }

  async addDelivery(purchaseOrderId: string, input: DeliveryInput, by: Caller): Promise<Delivery> {
    const po = await this.core.repo.getPurchaseOrder(purchaseOrderId);
    if (!po) throw notFound('Purchase order');
    if (!INCOMING_PO_STATUSES.includes(po.status)) throw illegal(po.status, 'addDelivery', 'Deliveries are added to sent purchase orders with units still to come.');
    const from = new Date(input.windowFrom);
    const to = new Date(input.windowTo);
    if (to < from) throw invalid('windowTo', 'The arrival window ends before it starts');
    if (input.units != null && input.units < 1) throw invalid('units', 'A delivery brings at least 1 unit');
    const lines = await this.core.repo.linesOf([purchaseOrderId]);
    const open = lines.reduce((n, l) => n + openQty(l), 0);
    const row = await this.core.repo.transaction(async (tx) => {
      const cur = await tx.getPurchaseOrder(purchaseOrderId, { forUpdate: true });
      if (!cur || !INCOMING_PO_STATUSES.includes(cur.status)) throw illegal(cur?.status ?? po.status, 'addDelivery', 'Deliveries are added to sent purchase orders with units still to come.');
      const d = await tx.insertDelivery({
        id: newId(),
        purchaseOrderId,
        carrier: clean(input.carrier),
        trackingRef: clean(input.trackingRef),
        windowFrom: from,
        windowTo: to,
        units: input.units ?? open,
        status: deliveryMachine.initial,
        delayReason: null,
        arrivedAt: null,
        dock: null,
      });
      const day = shortDate(dateInZone(from, this.core.ctx.config.market.timeZone));
      await tx.addEvent(this.core.event(purchaseOrderId, `Delivery expected ${day}`, [clean(input.carrier), clean(input.trackingRef), clean(input.note)].filter(Boolean).join(' · ') || null, by.actor));
      return d;
    });
    return (await this.core.views.deliveries([row]))[0]!;
  }

  async updateDelivery(id: string, body: DeliveryUpdate, by: Caller): Promise<Delivery> {
    const reason = required(body.reason, 'reason', 'Say why the delivery changed');
    const d = await this.core.repo.getDelivery(id);
    if (!d) throw notFound('Delivery');
    const po = await this.core.repo.getPurchaseOrder(d.purchaseOrderId);
    if (!po) throw notFound('Purchase order');
    const after = await this.core.repo.transaction(async (tx) => {
      const cur = await tx.getDelivery(id, { forUpdate: true });
      if (!cur) throw notFound('Delivery');
      const windowFrom = body.windowFrom != null ? new Date(body.windowFrom) : cur.windowFrom;
      const windowTo = body.windowTo != null ? new Date(body.windowTo) : cur.windowTo;
      if (windowTo < windowFrom) throw invalid('windowTo', 'The arrival window ends before it starts');
      const moved = windowFrom.getTime() !== cur.windowFrom.getTime() || windowTo.getTime() !== cur.windowTo.getTime();
      let status = cur.status;
      if (body.delayed === true) status = cur.status === 'delayed' ? deliveryStillOpen(cur.status) : deliveryMachine.next(cur.status, 'delay');
      else if (moved || body.delayed === false) status = deliveryMachine.next(cur.status, 'reschedule');
      else if (cur.status !== 'expected' && cur.status !== 'delayed') throw illegal(cur.status, 'reschedule', 'Only deliveries still to arrive can change.');
      const updated = await tx.updateDelivery(id, {
        windowFrom,
        windowTo,
        status,
        delayReason: reason,
        ...(body.carrier !== undefined ? { carrier: clean(body.carrier) } : {}),
        ...(body.trackingRef !== undefined ? { trackingRef: clean(body.trackingRef) } : {}),
      });
      const label = status === 'delayed' ? 'Delivery delayed' : moved ? `Delivery rescheduled to ${shortDate(dateInZone(windowFrom, this.core.ctx.config.market.timeZone))}` : 'Delivery updated';
      await tx.addEvent(this.core.event(cur.purchaseOrderId, label, reason, by.actor));
      return updated;
    });
    this.core.ctx.events.publish(
      'purchasing.delivery.rescheduled',
      { deliveryId: id, purchaseOrderId: po.id, ref: po.ref, windowFrom: after.windowFrom.toISOString(), windowTo: after.windowTo.toISOString(), reason },
      { actor: by.actor, requestId: by.requestId },
    );
    return (await this.core.views.deliveries([after]))[0]!;
  }

  async arriveDelivery(id: string, body: { dock?: string | null; arrivedAt?: string | null; note?: string | null }, by: Caller): Promise<Delivery> {
    const now = this.core.now();
    const arrivedAt = body.arrivedAt ? new Date(body.arrivedAt) : now;
    if (arrivedAt.getTime() > now.getTime() + 5 * 60_000) throw invalid('arrivedAt', 'The arrival time is in the future');
    const dock = clean(body.dock);
    const { after, po } = await this.core.repo.transaction(async (tx) => {
      const cur = await tx.getDelivery(id, { forUpdate: true });
      if (!cur) throw notFound('Delivery');
      const status = deliveryMachine.next(cur.status, 'arrive');
      const po = await tx.getPurchaseOrder(cur.purchaseOrderId);
      if (!po) throw notFound('Purchase order');
      const updated = await tx.updateDelivery(id, { status, arrivedAt, dock });
      await tx.addEvent(this.core.event(po.id, dock ? `Delivery arrived · ${dockText(dock)}` : 'Delivery arrived', clean(body.note), by.actor));
      return { after: updated, po };
    });
    this.core.ctx.events.publish(
      'purchasing.delivery.arrived',
      { deliveryId: id, purchaseOrderId: po.id, ref: po.ref, arrivedAt: arrivedAt.toISOString(), dock },
      { actor: by.actor, requestId: by.requestId },
    );
    return (await this.core.views.deliveries([after], { pos: [po] }))[0]!;
  }

  async getReceivingStats(query: { date?: string; locationId?: string }): Promise<ReceivingStats> {
    const tz = this.core.ctx.config.market.timeZone;
    const date = query.date ?? this.core.today();
    const dayStart = zonedTimeToUtc(date, '00:00', tz);
    const dayEnd = zonedTimeToUtc(addDays(date, 1), '00:00', tz);
    const weekStart = zonedTimeToUtc(startOfWeek(date), '00:00', tz);
    const monthAgo = zonedTimeToUtc(addDays(date, -29), '00:00', tz);
    const shortageFrom = zonedTimeToUtc(addDays(date, -SHORTAGE_LOOKBACK_DAYS), '00:00', tz);
    const loc = query.locationId;
    const [today, pending, receiving, recent] = await Promise.all([
      this.core.repo.deliveriesBy({ from: dayStart, to: dayEnd, locationId: loc }),
      this.core.repo.deliveriesBy({ statuses: ['expected', 'delayed', 'arrived'], locationId: loc }),
      this.core.repo.deliveriesBy({ statuses: ['receiving'], locationId: loc }),
      this.core.repo.receiptsBy({ statuses: SUBMITTED_RECEIPT_STATUSES, submittedFrom: shortageFrom, locationId: loc }),
    ]);
    const expectedToday = today.filter((d) => d.status !== 'cancelled');
    const arrived = pending.filter((d) => d.status === 'arrived').sort((a, b) => (a.arrivedAt?.getTime() ?? 0) - (b.arrivedAt?.getTime() ?? 0));
    const oldest = arrived[0];
    const oldestPo = oldest ? await this.core.repo.getPurchaseOrder(oldest.purchaseOrderId) : null;

    const lines = await this.core.repo.receiptLines(recent.map((r) => r.id));
    const linesByReceipt = groupBy(lines, (l) => l.receiptId);
    const inWindow = (r: ReceiptRow, from: Date) => !!r.submittedAt && r.submittedAt >= from && r.submittedAt < dayEnd;
    const week = recent.filter((r) => inWindow(r, weekStart));
    const month = recent.filter((r) => inWindow(r, monthAgo));
    const deliveries = new Map((await this.core.repo.deliveriesBy({ statuses: ['received', 'received_with_issues'], locationId: loc })).map((d) => [d.id, d]));
    const monthDeliveries = new Set(month.map((r) => r.deliveryId));
    const completed = [...monthDeliveries].filter((id) => deliveries.get(id)?.status === 'received').length;
    const withIssues = [...monthDeliveries].filter((id) => deliveries.get(id)?.status === 'received_with_issues').length;

    // open shortages: lines short or damaged that no settled or rejected claim covers
    const claims = await this.core.repo.claimsBy({ purchaseOrderIds: [...new Set(recent.map((r) => r.purchaseOrderId))] });
    const covered = new Set(claims.filter((c) => c.status === 'settled' || c.status === 'rejected').flatMap((c) => c.lines.map((l) => `${c.receiptId ?? c.purchaseOrderId}:${l.stockItemId}`)));
    const openLines = recent.flatMap((r) =>
      (linesByReceipt.get(r.id) ?? []).filter((l) => (shortageOf(l) > 0 || l.damaged > 0) && !covered.has(`${r.id}:${l.stockItemId}`) && !covered.has(`${r.purchaseOrderId}:${l.stockItemId}`)).map(() => r),
    );
    let shortageOwner: common.Actor | null = null;
    if (openLines.length) {
      const poIds = new Set(openLines.map((r) => r.purchaseOrderId));
      const active = claims.find((c) => ACTIVE_CLAIM_STATUSES.includes(c.status) && poIds.has(c.purchaseOrderId));
      shortageOwner = active?.owner ?? (await this.core.repo.getPurchaseOrder(openLines[0]!.purchaseOrderId))?.createdBy ?? null;
    }
    return {
      date,
      expectedToday: expectedToday.length,
      expectedTodayUnits: expectedToday.reduce((n, d) => n + d.units, 0),
      arrivedNotReceived: arrived.length,
      arrivedNote: oldest && oldestPo ? `${oldestPo.ref} ${oldest.dock ? `at ${dockText(oldest.dock)}` : 'at the dock'}` : null,
      receivedThisWeek: new Set(week.map((r) => r.deliveryId)).size,
      receivedThisWeekUnits: week.reduce((n, r) => n + (linesByReceipt.get(r.id) ?? []).reduce((m, l) => m + l.received, 0), 0),
      openShortages: openLines.length,
      shortageOwner,
      tabCounts: { expected: pending.length, receiving: receiving.length, receivedWithIssues: withIssues, completed: completed + withIssues },
    };
  }

  /** Job purchasing.flag-late-deliveries (every 30 min): Deliveries past windowTo + grace without arrival → delayed; publish purchasing.delivery.late (work queue for the Purchasing Manager) */
  async flagLateDeliveries(): Promise<number> {
    const grace = await this.core.ctx.settings.get('deliveryLateGraceMinutes');
    const cutoff = new Date(this.core.now().getTime() - grace * 60_000);
    const seen = new Set<string>();
    let flagged = 0;
    for (;;) {
      const batch = (await this.core.repo.deliveriesBy({ statuses: ['expected'], windowToBefore: cutoff, limit: LATE_BATCH })).filter((d) => !seen.has(d.id));
      if (!batch.length) break;
      for (const d of batch) {
        seen.add(d.id);
        const done = await this.core.repo.transaction(async (tx) => {
          const cur = await tx.getDelivery(d.id, { forUpdate: true });
          if (!cur || cur.status !== 'expected' || cur.windowTo >= cutoff) return null;
          await tx.updateDelivery(d.id, { status: deliveryMachine.next(cur.status, 'delay'), delayReason: 'Arrival window passed without check-in' });
          await tx.addEvent(this.core.event(cur.purchaseOrderId, 'Delivery late', 'Arrival window passed without check-in', SYSTEM));
          return tx.getPurchaseOrder(cur.purchaseOrderId);
        });
        if (!done) continue;
        const supplier = await this.core.repo.getSupplier(done.supplierId);
        this.core.ctx.events.publish('purchasing.delivery.late', { deliveryId: d.id, purchaseOrderId: done.id, ref: done.ref, supplierName: supplier?.name ?? 'Unknown supplier' }, { actor: SYSTEM });
        flagged++;
      }
      if (batch.length < LATE_BATCH) break;
    }
    return flagged;
  }
}

/** A delayed delivery marked delayed again stays delayed (no transition). */
const deliveryStillOpen = <S extends string>(s: S): S => s;
