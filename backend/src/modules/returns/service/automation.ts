/**
 * What returns does on its own: other modules' events (orders, shipping, sellers, support) and the jobs
 * (response and inspection deadlines, information and drop-off expiry). Consumers are idempotent and
 * ignore records they don't know.
 */
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import { returnMachine, returnShipmentMachine } from '../domain/state-machines.js';
import { ACTIVE_STATUSES, HOUR, is, PENDING_REFUND, type ReturnStatus } from '../domain/rules.js';
import type { ReturnRec, ShipmentRec } from '../ports.js';
import { SYSTEM, type Agg, type By, type Core } from './core.js';
import type { Decisions } from './decisions.js';
import type { Handling } from './handling.js';
import type { Refunds } from './refunds.js';
import type { Requests } from './requests.js';
import type { Views } from './views.js';

const BATCH = 200;

export class Automation {
  /** Rows per read when a job walks its candidates (repo.batches); tests lower it to walk several batches */
  jobBatchSize = BATCH;

  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly requests: Requests,
    private readonly decisions: Decisions,
    private readonly handling: Handling,
    private readonly refunds: Refunds,
  ) {}

  private get repo() {
    return this.core.repo;
  }

  /* ---------------------------------------------------------------- orders */

  /** The window is read from the order item (deliveredAt + its frozen window) whenever eligibility is checked */
  async onItemDelivered(e: EventPayload<'orders.item.delivered'>): Promise<void> {
    this.core.ctx.log.debug({ orderItemId: e.itemId, returnWindowEndsAt: e.returnWindowEndsAt }, 'returns: return window started');
  }

  /** Cancelled before delivery: a return still waiting for a decision on that item is cancelled */
  async onItemCancelled(e: EventPayload<'orders.item.cancelled'>): Promise<void> {
    if (!isUuid(e.itemId)) return;
    const rows = await this.repo.find('return_items', { order_item_id: e.itemId });
    if (!rows.length) return;
    const rets = await this.repo.find('returns', { id: [...new Set(rows.map((r) => r.return_id))], status: ['requested', 'info_requested'] });
    for (const r of rets) {
      await this.requests.cancel(r.id, 'withdraw', 'The item was cancelled', { actor: SYSTEM });
    }
  }

  /* ---------------------------------------------------------------- shipping */

  private async returnShipment(shipmentId: string, returnId: string | null | undefined): Promise<{ ret: ReturnRec; s: ShipmentRec } | null> {
    const byId = isUuid(shipmentId) ? (await this.repo.find('return_shipments', { shipping_shipment_id: shipmentId }))[0] : undefined;
    const s = byId ?? (isUuid(returnId) ? (await this.repo.find('return_shipments', { return_id: returnId }, { orderBy: [['created_at', 'desc']], limit: 1 }))[0] : undefined);
    if (!s) return null;
    const ret = await this.repo.get('returns', s.return_id);
    return ret ? { ret, s } : null;
  }

  /** First carrier scan of the return parcel: shipment and return in transit */
  async dropOff(shipmentId: string, returnId: string | null | undefined, at: string | null): Promise<void> {
    const found = await this.returnShipment(shipmentId, returnId);
    if (!found) return;
    const { ret } = found;
    await this.core.write(ret.id, { actor: SYSTEM }, async (tx, a, batch) => {
      const sh = this.core.shipmentOf(a);
      if (!sh || !returnShipmentMachine.can(sh.status as never, 'dropOff')) return;
      await tx.update('return_shipments', sh.id, { status: returnShipmentMachine.next(sh.status as never, 'dropOff'), shipping_shipment_id: sh.shipping_shipment_id ?? shipmentId });
      await this.core.timeline(tx, ret.id, [{ kind: 'shipment_dropped_off', label: 'Return dropped off', detail: at ? `Scanned by the carrier` : null, visibility: 'customer' }]);
      if (returnMachine.can(a.ret.status as ReturnStatus, 'dropOff')) {
        await tx.update('returns', ret.id, { status: returnMachine.next(a.ret.status as ReturnStatus, 'dropOff'), updated_at: this.core.now() });
        batch.push('returns.return.shipped', { returnId: ret.id, ...this.core.refs(a.ret), trackingNumber: sh.tracking_number });
      }
    });
  }

  async onShipmentDispatched(e: EventPayload<'shipping.shipment.dispatched'>): Promise<void> {
    if (e.kind === 'return') return this.dropOff(e.shipmentId, e.returnId, e.shippedAt);
    if (e.kind !== 'replacement') return;
    // replacements of a return by return id; case replacements (no return) by order and items
    const rep = await this.handling.replacementFor(e);
    if (rep) await this.handling.replacementShipped(rep, e.shipmentId, e.shippedAt);
  }

  async onShipmentDelivered(e: EventPayload<'shipping.shipment.delivered'>): Promise<void> {
    if (e.kind === 'replacement') {
      const rep = await this.handling.replacementFor(e);
      if (rep) await this.handling.replacementDelivered(rep, e.shipmentId, e.deliveredAt);
      return;
    }
    if (e.kind !== 'return') return;
    const found = await this.returnShipment(e.shipmentId, e.returnId);
    if (!found) return;
    await this.core.write(found.ret.id, { actor: SYSTEM }, async (tx, a, batch) => {
      const sh = this.core.shipmentOf(a);
      if (!sh || sh.status === 'delivered') return;
      if (sh.status === 'label_issued' && returnMachine.can(a.ret.status as ReturnStatus, 'dropOff')) {
        await tx.update('returns', a.ret.id, { status: returnMachine.next(a.ret.status as ReturnStatus, 'dropOff'), updated_at: this.core.now() });
        batch.push('returns.return.shipped', { returnId: a.ret.id, ...this.core.refs(a.ret), trackingNumber: sh.tracking_number });
      }
      if (!returnShipmentMachine.can(sh.status as never, 'deliver')) return;
      await tx.update('return_shipments', sh.id, { status: returnShipmentMachine.next(sh.status as never, 'deliver'), delivered_at: new Date(e.deliveredAt) });
      await this.core.timeline(tx, a.ret.id, [{ kind: 'shipment_delivered', label: `Delivered to ${a.ret.terms_snapshot.meta.destination.name}`, detail: 'It will be checked in shortly.', visibility: 'customer' }]);
    });
  }

  async onShipmentException(e: EventPayload<'shipping.shipment.exception'>): Promise<void> {
    if (!e.shipmentId) return;
    const found = await this.returnShipment(e.shipmentId, null);
    if (found) {
      await this.core.write(found.ret.id, { actor: SYSTEM }, async (tx, a) => {
        const sh = this.core.shipmentOf(a);
        if (!sh) return;
        if (returnShipmentMachine.can(sh.status as never, 'exception')) await tx.update('return_shipments', sh.id, { status: returnShipmentMachine.next(sh.status as never, 'exception') });
        await this.core.timeline(tx, a.ret.id, [
          { kind: 'shipment_exception', label: 'Delay with your return parcel', detail: 'We are checking with the carrier.', visibility: 'customer' },
          { kind: 'shipment_exception', label: `Return parcel exception: ${e.kind.replace(/_/g, ' ')}`, detail: e.customerAction ?? null, visibility: 'seller' },
        ]);
      });
      return;
    }
    const rep = isUuid(e.shipmentId) ? (await this.repo.find('replacements', { shipping_shipment_id: e.shipmentId }))[0] : undefined;
    if (rep?.return_id) await this.core.timeline(this.repo, rep.return_id, [{ kind: 'replacement_exception', label: 'Delay with your replacement', detail: e.kind.replace(/_/g, ' '), visibility: 'customer' }]);
  }

  async onShipmentStatusChanged(e: EventPayload<'shipping.shipment.status_changed'>): Promise<void> {
    if (e.kind !== 'return') return;
    const found = await this.returnShipment(e.shipmentId, e.returnId);
    if (!found) return;
    if (['shipped', 'in_transit', 'out_for_delivery'].includes(e.to) && found.s.status === 'label_issued') await this.dropOff(e.shipmentId, found.ret.id, e.at);
    await this.core.write(found.ret.id, { actor: SYSTEM }, async (tx, a) => {
      const sh = this.core.shipmentOf(a);
      if (!sh) return;
      if (['lost', 'delivery_failed', 'returned_to_sender'].includes(e.to) && returnShipmentMachine.can(sh.status as never, 'exception')) await tx.update('return_shipments', sh.id, { status: returnShipmentMachine.next(sh.status as never, 'exception') });
      if (e.to === 'in_transit' && sh.status === 'exception') await tx.update('return_shipments', sh.id, { status: returnShipmentMachine.next('exception', 'resume') });
      if (e.estimatedArrival) await tx.update('returns', a.ret.id, { terms_snapshot: { ...a.ret.terms_snapshot, meta: { ...a.ret.terms_snapshot.meta, estimatedArrival: e.estimatedArrival } } });
      if (!a.events.some((x) => x.kind === 'shipment_status' && x.label === e.statusLabel)) {
        await this.core.timeline(tx, a.ret.id, [{ kind: 'shipment_status', label: e.statusLabel, detail: e.estimatedArrival ? `Expected ${e.estimatedArrival.from} to ${e.estimatedArrival.to}` : null, visibility: 'customer' }]);
      }
    });
  }

  /* ---------------------------------------------------------------- sellers and support */

  /** Open returns of a suspended seller move to platform handling; they stay readable for the seller */
  async onSellerSuspended(e: EventPayload<'sellers.seller.suspended'>): Promise<void> {
    if (!isUuid(e.sellerId)) return;
    const open = await this.repo.find('returns', { seller_id: e.sellerId, status: ACTIVE_STATUSES, platform_handling: false });
    for (const r of open) {
      await this.core.write(r.id, { actor: SYSTEM }, async (tx, a, batch) => {
        if (a.ret.platform_handling) return;
        const now = this.core.now();
        await tx.update('returns', r.id, { platform_handling: true, handled_by: 'marketplace_support', escalation: a.ret.escalation ?? { at: now.toISOString(), by: SYSTEM, reason: 'other', note: 'Seller suspended', caseId: a.ret.case_id, caseRef: null }, updated_at: now });
        await this.core.timeline(tx, r.id, [{ kind: 'taken_over', label: 'Marketly support is handling your return', visibility: 'customer' }]);
        batch.push('returns.return.escalated', { returnId: r.id, ...this.core.refs(a.ret), ownerType: a.ret.owner_type, sellerId: a.ret.seller_id, reason: 'other', by: SYSTEM });
      });
    }
  }

  /** A dispute decision about a return: overturn, approve without return, or close */
  async onCaseDecided(e: EventPayload<'support.case.decided'>): Promise<void> {
    const ret = isUuid(e.returnId) ? await this.repo.get('returns', e.returnId) : isUuid(e.caseId) ? (await this.repo.find('returns', { case_id: e.caseId }))[0] : undefined;
    if (!ret) return;
    const by: By = { actor: { kind: 'staff', id: null, name: `Case ${e.ref}` } };
    if (ret.case_id !== e.caseId) {
      await this.core.write(ret.id, by, async (tx, a) => {
        await tx.update('returns', ret.id, { case_id: e.caseId, escalation: a.ret.escalation ? { ...a.ret.escalation, caseId: e.caseId, caseRef: e.ref } : a.ret.escalation, updated_at: this.core.now() });
      });
    }
    const kinds = new Set(e.remedies.filter((r) => r.status !== 'cancelled').map((r) => r.kind));
    const label = kinds.has('return_label');
    const money = kinds.has('refund') || kinds.has('partial_refund') || kinds.has('goodwill_credit') || kinds.has('replacement');
    const agg = (await this.core.load(ret.id))!;
    const status = agg.ret.status as ReturnStatus;
    try {
      if (status === 'rejected' && label) {
        await this.decisions.overturn(ret.id, { withoutReturn: false, reason: `Case ${e.ref}: ${e.outcome}`, labelMethod: 'prepaid_qr' }, by, agg);
      } else if (status === 'rejected' && money) {
        await this.decisions.overturn(ret.id, { withoutReturn: true, reason: `Case ${e.ref}: ${e.outcome}` }, by, agg);
      } else if (is(['requested', 'approved', 'in_transit'], status) && money && !label) {
        await this.core.write(ret.id, by, async (tx, a, batch) => {
          const now = this.core.now();
          const event = a.ret.status === 'requested' ? 'approveWithoutReturn' : 'waiveReturn';
          if (!returnMachine.can(a.ret.status as ReturnStatus, event)) return;
          await tx.update('returns', ret.id, {
            status: returnMachine.next(a.ret.status as ReturnStatus, event),
            decision: { kind: 'approved_without_return', reasonCode: 'case_decision', explanation: e.outcome, decidedBy: by.actor, decidedAt: now.toISOString(), platformDecision: true },
            exception: a.ret.exception ?? { reasonCode: 'other', details: `Case ${e.ref}: ${e.outcome}`, proposedBy: by.actor, proposedAt: now.toISOString(), approvedBy: by.actor, approvedAt: now.toISOString(), stockOutcome: 'write_off' },
            platform_handling: a.ret.owner_type === 'seller' ? true : a.ret.platform_handling,
            updated_at: now,
          });
          await this.core.timeline(tx, ret.id, [{ kind: 'case_decided', label: "Marketly decided your case: you don't need to send the item back", detail: e.outcome, visibility: 'customer' }]);
          batch.push('returns.return.approved', this.core.approvedEvent(a, { withoutReturn: true, platformDecision: true }));
        });
      } else if (!money && !label && e.final && is(['requested', 'info_requested', 'approved'], status)) {
        await this.requests.cancel(ret.id, 'withdraw', `Closed by case ${e.ref}`, by);
      } else {
        await this.core.timeline(this.repo, ret.id, [{ kind: 'case_decided', label: `Case ${e.ref} decided`, detail: e.outcome, visibility: 'customer' }]);
      }
    } catch (err) {
      this.core.ctx.log.warn({ err, returnId: ret.id, caseId: e.caseId }, 'returns: case decision could not be applied to the return');
    }
  }

  /* ---------------------------------------------------------------- jobs */

  /** Seller responses past due (plus the grace period) move to platform handling */
  async responseDeadlines(): Promise<void> {
    const now = this.core.now();
    const grace = Number(await this.core.ctx.settings.get('platformInterventionGraceHours')) || 0;
    const overdue = await this.repo.find('returns', { status: 'requested', owner_type: 'seller', platform_handling: false, response_due_at: { op: '<', value: new Date(now.getTime() - grace * HOUR) } }, { orderBy: [['response_due_at', 'asc']], limit: BATCH });
    for (const r of overdue) {
      await this.core.write(r.id, { actor: SYSTEM }, async (tx, a, batch) => {
        if (a.ret.platform_handling || a.ret.status !== 'requested') return;
        await tx.update('returns', r.id, {
          platform_handling: true,
          handled_by: 'marketplace_support',
          escalation: a.ret.escalation ?? { at: now.toISOString(), by: SYSTEM, reason: 'seller_no_response', note: 'The seller did not respond in time', caseId: a.ret.case_id, caseRef: null },
          updated_at: now,
        });
        await this.core.timeline(tx, r.id, [
          { kind: 'taken_over', label: 'Marketly support is handling your return', detail: 'The seller did not respond in time.', visibility: 'customer' },
          { kind: 'deadline_missed', label: 'Response deadline missed: Marketly took over', visibility: 'seller' },
        ]);
        batch.push('returns.return.escalated', { returnId: r.id, ...this.core.refs(a.ret), ownerType: 'seller', sellerId: a.ret.seller_id, reason: 'seller_no_response', by: SYSTEM });
      });
    }
    // reminders for responses due within a day (once per return)
    const soon = await this.repo.find('returns', { status: 'requested', owner_type: 'seller', platform_handling: false, response_due_at: { op: '<', value: new Date(now.getTime() + 24 * HOUR) } }, { limit: BATCH });
    const notifications = this.core.ctx.tryUse('notifications');
    if (!notifications) return;
    for (const r of soon.filter((x) => x.response_due_at && x.response_due_at.getTime() >= now.getTime() && x.seller_id)) {
      await this.core.soft('notifications', 'response reminder', (n) =>
        n.notify({
          topic: 'seller.return.requested',
          recipients: [{ kind: 'seller', sellerId: r.seller_id! }],
          context: { return: { ref: r.ref }, due: { date: r.response_due_at!.toISOString() } },
          link: { kind: 'return', id: r.id, ref: r.ref, label: 'Respond', screen: 'seller/return' },
          dedupeKey: `return:${r.id}:respond-soon`,
          actionRequired: true,
          deadline: r.response_due_at!.toISOString(),
          sellerId: r.seller_id,
        }),
      );
    }
  }

  /** Received returns past the inspection target and remedies past the refund target go to the platform; stuck hand-overs are retried */
  async inspectionDeadlines(): Promise<void> {
    // Every candidate is visited, batch by batch (BUILDING-MODULES §9): returns still inside their inspection or
    // refund target are skipped and stay candidates, so a first page alone could fill up with them and never reach
    // the late ones. Returns the job escalates leave the candidates (platform_handling) as it goes.
    const candidates = this.repo.batches('returns', { status: ['received', 'awaiting_remedy'], owner_type: 'seller', platform_handling: false }, this.jobBatchSize);
    for await (const batch of candidates) await this.inspectionBatch(batch.map((r) => r.id));
    await this.refunds.retryHandOvers();
  }

  /** One batch of inspectionDeadlines: the returns past their inspection or refund target go to the platform */
  private async inspectionBatch(returnIds: string[]): Promise<void> {
    const now = this.core.now();
    const aggs = await this.core.loadMany(returnIds);
    for (const agg of aggs.values()) {
      const r = agg.ret;
      let reason: 'seller_missed_inspection' | 'refund_late' | null = null;
      if (r.status === 'received') {
        const by = this.views.inspectBy(agg);
        if (by && by.getTime() < now.getTime()) reason = 'seller_missed_inspection';
      } else {
        const by = this.views.refundBy(agg);
        const settled = agg.refunds.some((x) => !is(PENDING_REFUND, x.status) && x.status !== 'declined' && x.status !== 'cancelled') || agg.replacements.some((x) => x.status !== 'cancelled');
        const pending = agg.refunds.some((x) => is(['requested', 'failed'], x.status));
        if (by && by.getTime() < now.getTime() && !settled && (pending || !agg.refunds.length)) reason = 'refund_late';
      }
      if (!reason) continue;
      await this.escalate(agg, reason);
    }
  }

  private async escalate(agg: Agg, reason: 'seller_missed_inspection' | 'refund_late') {
    const now = this.core.now();
    await this.core.write(agg.ret.id, { actor: SYSTEM }, async (tx, a, batch) => {
      if (a.ret.platform_handling) return;
      await tx.update('returns', a.ret.id, {
        platform_handling: true,
        handled_by: 'marketplace_support',
        escalation: a.ret.escalation ?? { at: now.toISOString(), by: SYSTEM, reason, note: reason === 'refund_late' ? 'The refund is late' : 'The seller did not inspect the return in time', caseId: a.ret.case_id, caseRef: null },
        updated_at: now,
      });
      await this.core.timeline(tx, a.ret.id, [{ kind: 'deadline_missed', label: reason === 'refund_late' ? 'Refund target missed: Marketly took over' : 'Inspection target missed: Marketly took over', visibility: 'seller' }]);
      batch.push('returns.return.escalated', { returnId: a.ret.id, ...this.core.refs(a.ret), ownerType: a.ret.owner_type, sellerId: a.ret.seller_id, reason, by: SYSTEM });
    });
  }

  /** Information requests not answered in time cancel the return */
  async infoExpiry(): Promise<void> {
    // The reply-by time is in the query, so every row read is due; the walk goes on until none is left (BUILDING-MODULES
    // §9). Cancelled returns leave the query as it goes; one that fails to cancel is logged and passed over.
    for await (const batch of this.repo.infoRequestsDue(this.core.now(), this.jobBatchSize)) {
      for (const r of batch) {
        await this.requests.cancel(r.id, 'expire', 'No reply to the question in time', { actor: SYSTEM }).catch((err) => this.core.ctx.log.warn({ err, returnId: r.id }, 'returns: info expiry failed'));
      }
    }
  }

  /** Approved returns not dropped off by the deadline are cancelled; unused labels are voided */
  async dropoffExpiry(): Promise<void> {
    const now = this.core.now();
    // Every unused label past its drop-off date is visited, batch by batch (BUILDING-MODULES §9): a label whose return
    // is no longer approved is skipped and stays in this state, so a first page alone could fill up with them and
    // never reach the returns that should expire. (The return's status lives in another collection, so the query
    // cannot leave those labels out.)
    const late = this.repo.batches('return_shipments', { status: 'label_issued', drop_off_by: { op: '<', value: now } }, this.jobBatchSize);
    for await (const batch of late) {
      const approved = await this.repo.find('returns', { id: [...new Set(batch.map((s) => s.return_id))], status: 'approved' });
      for (const ret of approved) {
        await this.requests.cancel(ret.id, 'expire', 'The item was not sent back by the drop-off date', { actor: SYSTEM }).catch((err) => this.core.ctx.log.warn({ err, returnId: ret.id }, 'returns: drop-off expiry failed'));
      }
    }
  }
}
