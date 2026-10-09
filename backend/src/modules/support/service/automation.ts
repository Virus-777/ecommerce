/**
 * What happens without a person: consumers of other modules' events (returns, payments, shipping, orders,
 * sellers) and the jobs (SLA timers, seller deadline, offer expiry, auto-close).
 */
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import { caseMachine, caseOfferMachine, remedyMachine } from '../domain/state-machines.js';
import { CLOSED_STATUSES, nextActionOf, type CaseStatus, type RemedyStatus } from '../domain/rules.js';
import type { RemedyRec } from '../ports.js';
import type { Cases } from './cases.js';
import { DAY, SYSTEM, type By, type Core } from './core.js';
import { remedyPath, type Decisions } from './decisions.js';

const BATCH = 200;
const SYS: By = { actor: SYSTEM };
const REFUND_KINDS = ['refund', 'partial_refund', 'goodwill_credit'];

export class Automation {
  constructor(
    private readonly core: Core,
    private readonly cases: Cases,
    private readonly decisions: Decisions,
  ) {}

  private async safely(what: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      this.core.ctx.log.warn({ err, what }, 'support: automation step failed');
    }
  }

  /** Remedies matching a refund request: linked by id, else the first unlinked refund remedy of the case or return */
  private async refundRemedy(refundRequestId: string, caseId?: string | null, returnId?: string | null): Promise<RemedyRec | undefined> {
    const linked = (await this.core.repo.find('case_remedies', { refund_request_id: refundRequestId }))[0];
    if (linked) return linked;
    const caseIds = new Set<string>();
    if (caseId && isUuid(caseId)) caseIds.add(caseId);
    if (returnId && isUuid(returnId)) for (const c of await this.core.repo.find('cases', { return_id: returnId })) caseIds.add(c.id);
    if (!caseIds.size) return undefined;
    const rows = await this.core.repo.find('case_remedies', { case_id: [...caseIds], refund_request_id: null, kind: REFUND_KINDS, status: ['pending_approval', 'approved'] }, { orderBy: [['created_at', 'asc']] });
    return rows[0];
  }

  /* ================================================================ returns */

  /** returns.return.escalated: open or link a dispute case for the return, owned by the Returns team */
  async onReturnEscalated(e: EventPayload<'returns.return.escalated'>): Promise<void> {
    if (!isUuid(e.returnId)) return;
    const existing = (await this.core.repo.find('cases', { return_id: e.returnId }))[0];
    if (existing) {
      if (existing.team !== 'returns' && this.core.isOpen(existing)) {
        await this.core.write(existing.id, SYS, async (tx, a) => {
          await this.core.save(tx, a, { team: 'returns' });
          await this.core.timeline(tx, a.c.id, [{ kind: 'team', label: 'Moved to the Returns team', detail: `Return escalated (${e.reason})`, visibility: 'staff' }]);
        });
      }
      return;
    }
    const order = isUuid(e.orderId) ? await this.core.quiet('order', () => this.core.ctx.use('orders').getOrder(e.orderId)) : null;
    if (!order) return;
    const ret = (await this.core.soft('returns', 'returns of order', (r) => r.listForOrder(e.orderId, { area: 'admin' })))?.find((r) => r.detail.id === e.returnId);
    const items = ret?.detail.items.map((i) => i.orderItemId) ?? [];
    await this.cases.openFromModule({
      kind: 'dispute',
      category: 'return_dispute',
      orderId: e.orderId,
      orderItemIds: items,
      ...(order.contact.customerId ? { customerId: order.contact.customerId } : {}),
      ...(e.sellerId ? { sellerId: e.sellerId } : {}),
      returnId: e.returnId,
      subject: `Return ${ret?.detail.ref ?? ''}`.trim(),
      message: `The return was escalated to Marketly (${e.reason.replace(/_/g, ' ')}).`,
      openedBy: e.by?.kind === 'customer' || e.by?.kind === 'staff' ? e.by : SYSTEM,
    });
  }

  /** returns.refund.approved: the refund remedy is approved and handed over (in progress) */
  async onRefundApproved(e: EventPayload<'returns.refund.approved'>): Promise<void> {
    const r = await this.refundRemedy(e.refundRequestId, e.caseId, e.returnId);
    if (!r) return;
    await this.decisions.moveRemedy(r.id, 'in_progress', { refundRequestId: e.refundRequestId, label: 'Refund approved and being processed', note: "Approved means we agreed to refund you; it isn't money in your account yet" });
  }

  /** returns.replacement.created: link the replacement to its remedy */
  async onReplacementCreated(e: EventPayload<'returns.replacement.created'>): Promise<void> {
    const cases = await this.core.repo.find('cases', { return_id: e.returnId });
    const candidates = cases.length ? await this.core.repo.find('case_remedies', { case_id: cases.map((c) => c.id), kind: 'replacement', replacement_id: null }) : [];
    const byItem = candidates.find((r) => r.order_item_ids.includes(e.orderItemId)) ?? candidates[0];
    if (!byItem) return;
    await this.decisions.moveRemedy(byItem.id, 'in_progress', { replacementId: e.replacementId, label: 'Replacement on its way' });
  }

  /* ================================================================ payments */

  /** payments.refund.sent: the refund remedy is complete; the case can now be resolved */
  async onRefundSent(e: EventPayload<'payments.refund.sent'>): Promise<void> {
    if (!e.originId || !isUuid(e.originId)) return;
    const r = (await this.core.repo.find('case_remedies', { refund_request_id: e.originId }))[0];
    if (!r) return;
    await this.decisions.moveRemedy(r.id, 'completed', { label: 'Refund sent', note: `Sent to ${e.destination}. Banks usually show it in 3–5 business days.` });
  }

  /** payments.refund.failed: the refund remedy failed; the case goes back to the owner's queue */
  async onRefundFailed(e: EventPayload<'payments.refund.failed'>): Promise<void> {
    if (!e.originId || !isUuid(e.originId)) return;
    const r = (await this.core.repo.find('case_remedies', { refund_request_id: e.originId }))[0];
    if (!r) return;
    await this.decisions.moveRemedy(r.id, 'failed', { label: 'Refund could not be sent yet', note: e.finalAttempt ? `Failed: ${e.reason}. Marketly support will contact you.` : `Failed: ${e.reason}. Retrying.` });
  }

  /* ================================================================ wallet */

  /**
   * wallet.goodwill.decided: the case's goodwill credit remedy waiting for approval is granted (completed) or
   * rejected (cancelled), and the case goes back to the top of its owner's queue. The remedy keeps no grant id,
   * so it is matched by case, kind and amount (the oldest pending one). Claimed once per grant in the inbox.
   */
  async onGoodwillDecided(e: EventPayload<'wallet.goodwill.decided'>): Promise<void> {
    if (!e.caseId || !isUuid(e.caseId)) return;
    const c = await this.core.repo.get('cases', e.caseId);
    if (!c) return;
    const granted = e.status === 'granted';
    const amount = `${(e.amount.amount / 100).toFixed(2)} ${e.amount.currency}`;
    await this.core.write(c.id, SYS, async (tx, a) => {
      if (!(await tx.claim(`wallet.goodwill.decided:${e.grantId}`))) return;
      const pending = a.remedies.filter((r) => r.kind === 'goodwill_credit' && r.status === 'pending_approval').sort((x, y) => x.created_at.getTime() - y.created_at.getTime());
      const remedy = pending.find((r) => r.amount === e.amount.amount && (!r.currency || r.currency === e.amount.currency)) ?? pending[0];
      if (!remedy) return;
      const path = remedyPath(remedy.status as RemedyStatus, granted ? 'completed' : 'cancelled');
      if (!path?.length) return;
      let status = remedy.status as RemedyStatus;
      for (const ev of path) status = remedyMachine.next(status, ev as never) as RemedyStatus;
      const updated = await tx.update('case_remedies', remedy.id, { status, note: granted ? `${amount} added to your Marketly credit` : 'The goodwill credit was not approved', updated_at: this.core.now() });
      Object.assign(remedy, updated);
      await this.core.timeline(tx, a.c.id, [
        granted
          ? { kind: 'remedy_completed', label: 'Goodwill credit added', detail: `${amount} added to your Marketly credit`, visibility: 'all' }
          : { kind: 'remedy_cancelled', label: 'Goodwill credit not approved', detail: `${amount} was not approved; choose another remedy`, visibility: 'staff' },
      ]);
      // back to the owner's queue: due now (the SLA job flags it)
      await this.core.save(tx, a, { waiting_on: 'marketplace', next_response_due_at: this.core.now() });
    });
  }

  /* ================================================================ shipping */

  /** shipping.shipment.delivered: replacements and return labels complete; ship-by remedies complete on delivery */
  async onShipmentDelivered(e: EventPayload<'shipping.shipment.delivered'>): Promise<void> {
    const items = e.lines.map((l) => l.orderItemId);
    const cases = await this.core.repo.find('cases', { order_id: e.orderId });
    if (!cases.length) return;
    const remedies = await this.core.repo.find('case_remedies', { case_id: cases.map((c) => c.id), status: ['approved', 'in_progress'] });
    for (const r of remedies) {
      const c = cases.find((x) => x.id === r.case_id)!;
      const matchesItems = r.order_item_ids.some((id) => items.includes(id));
      if (e.kind === 'replacement' && r.kind === 'replacement' && (matchesItems || (e.returnId && c.return_id === e.returnId))) await this.decisions.moveRemedy(r.id, 'completed', { label: 'Replacement delivered' });
      else if (e.kind === 'return' && r.kind === 'return_label' && e.returnId && c.return_id === e.returnId) await this.decisions.moveRemedy(r.id, 'completed', { label: 'The return arrived' });
      else if (e.kind === 'outbound' && r.kind === 'ship_by_deadline' && matchesItems) await this.decisions.moveRemedy(r.id, 'completed', { label: 'The item was shipped and delivered' });
    }
  }

  /** shipping.dispatch.overdue: open cases on the items get the warning and the customer escalation route */
  async onDispatchOverdue(e: EventPayload<'shipping.dispatch.overdue'>): Promise<void> {
    const links = await this.core.repo.casesForItems(e.orderItemIds ?? [], true);
    const ids = [...new Set(links.map((l) => l.caseId))];
    for (const id of ids) {
      await this.core.write(id, SYS, async (tx, a) => {
        if (a.c.next_action.facts?.dispatchOverdue?.dueAt === e.dueAt) return;
        await this.core.timeline(tx, a.c.id, [{ kind: 'dispatch_overdue', label: 'The seller missed the dispatch deadline', detail: `Was due ${e.dueAt}. You can ask Marketly to step in.`, visibility: 'all' }]);
        await this.core.message(tx, a.c.id, { author: SYSTEM, authorLabel: 'Marketly', role: 'system', audience: 'customer', body: 'The item was not shipped by its dispatch deadline. If you would rather not wait, ask Marketly to step in from this case.' });
        await this.core.save(tx, a, {}, { dispatchOverdue: { dueAt: e.dueAt, at: this.core.now().toISOString() } });
      });
    }
    // agreed ship-by dates that passed fall back to a refund
    if (ids.length) await this.shipByDeadlines(ids);
  }

  /** shipping.shipment.exception: a lost or damaged package opens a case unless the customer already has one */
  async onShipmentException(e: EventPayload<'shipping.shipment.exception'>): Promise<void> {
    if (e.kind !== 'lost_or_damaged') return;
    const open = await this.core.repo.casesForItems(e.orderItemIds ?? [], true);
    if (open.length) {
      for (const id of [...new Set(open.map((o) => o.caseId))]) {
        await this.core.write(id, SYS, async (tx, a) => {
          if (a.events.some((x) => x.kind === 'delivery_exception' && x.detail === e.exceptionId)) return;
          await this.core.timeline(tx, a.c.id, [{ kind: 'delivery_exception', label: 'The carrier reported the package lost or damaged', detail: e.exceptionId, visibility: 'staff' }]);
        });
      }
      return;
    }
    // only a package the carrier reported (an exception raised from a customer's report has no shipment and
    // already has its case)
    if (!e.shipmentId) return;
    const order = isUuid(e.orderId) ? await this.core.quiet('order', () => this.core.ctx.use('orders').getOrder(e.orderId)) : null;
    if (!order) return;
    await this.cases.openFromModule({
      kind: 'order_problem',
      category: 'lost_or_damaged',
      orderId: e.orderId,
      orderItemIds: e.orderItemIds,
      ...(order.contact.customerId ? { customerId: order.contact.customerId } : {}),
      ...(e.sellerId ? { sellerId: e.sellerId } : {}),
      subject: 'Package lost or damaged',
      message: e.customerAction ? `The carrier reported a problem with the package. ${e.customerAction}` : 'The carrier reported the package lost or damaged. We are sorting it out with the seller.',
      openedBy: SYSTEM,
    });
  }

  /* ================================================================ orders and sellers */

  /** orders.item.cancelled: note it on linked cases; a ship-by remedy for the item ends with the cancellation */
  async onItemCancelled(e: EventPayload<'orders.item.cancelled'>): Promise<void> {
    const links = await this.core.repo.casesForItems([e.itemId], false);
    for (const caseId of [...new Set(links.map((l) => l.caseId))]) {
      await this.core.write(caseId, SYS, async (tx, a) => {
        if (a.events.some((x) => x.kind === 'item_cancelled' && x.detail === e.cancellationId)) return;
        await this.core.timeline(tx, a.c.id, [{ kind: 'item_cancelled', label: 'An item on this case was cancelled and refunded through the cancellation', detail: e.cancellationId, visibility: 'all' }]);
        await this.core.save(tx, a, {});
      });
      const rows = await this.core.repo.find('case_remedies', { case_id: caseId, kind: 'ship_by_deadline', status: ['pending_approval', 'approved', 'in_progress', 'failed'] });
      for (const r of rows.filter((x) => x.order_item_ids.includes(e.itemId))) await this.decisions.moveRemedy(r.id, 'cancelled', { label: 'Ship-by date ended: the item was cancelled', note: 'The item was cancelled; the cancellation refunds it' });
    }
  }

  /** sellers.seller.restricted: cases stay open; seller-handled cases of a seller that can no longer sell go to Marketly */
  async onSellerRestricted(e: EventPayload<'sellers.seller.restricted'>): Promise<void> {
    if (!e.affectedActivities.includes('sales')) return;
    const rows = await this.core.repo.find('cases', { seller_id: e.sellerId, handler_kind: 'seller', status: { op: 'not in', value: CLOSED_STATUSES as string[] } }, { limit: 500 });
    for (const c of rows) {
      await this.safely('route restricted seller case', async () => {
        const agg = (await this.core.load(c.id))!;
        if (caseMachine.can(agg.c.status as CaseStatus, 'escalate')) {
          await this.cases.escalate(agg, { reason: 'seller_restricted', to: 'customer_support', note: null, label: 'Marketly support took over: the seller cannot handle orders right now', convertToDispute: false }, SYS);
        } else {
          await this.core.write(c.id, SYS, async (tx, a) => {
            await this.core.save(tx, a, { handler_kind: 'marketplace_support', support_following: true });
            await this.core.timeline(tx, a.c.id, [{ kind: 'seller_restricted', label: 'Marketly support is handling this case', visibility: 'all' }]);
          });
        }
      });
    }
  }

  /* ================================================================ jobs */

  /** Response deadlines that passed: support.case.overdue once per deadline (workqueues raises it); ship-by dates */
  async slaTimers(): Promise<void> {
    const now = this.core.now();
    const due = await this.core.repo.listCases({ statuses: ['open', 'waiting_on_seller', 'waiting_on_customer', 'escalated', 'decision_made', 'appealed', 'reopened'], dueBefore: now }, 'next_deadline', { mode: 'page', page: 1, limit: BATCH });
    for (const c of due.items) {
      const dueAt = c.next_response_due_at!.toISOString();
      if (c.next_action.facts?.overdueNotified === dueAt) continue;
      await this.safely('overdue case', async () => {
        await this.core.write(c.id, SYS, async (tx, a, batch) => {
          if (a.c.next_action.facts?.overdueNotified === dueAt || !a.c.next_response_due_at || a.c.next_response_due_at.toISOString() !== dueAt) return;
          const next = nextActionOf(this.core.nextFacts(a), now);
          const who = next.whoMustAct === 'none' ? 'marketplace' : next.whoMustAct;
          await this.core.timeline(tx, a.c.id, [{ kind: 'overdue', label: `Response deadline passed (${who} to act)`, detail: dueAt, visibility: 'staff' }]);
          await this.core.save(tx, a, {}, { overdueNotified: dueAt });
          batch.push('support.case.overdue', { caseId: a.c.id, whoMustAct: who, dueAt });
        });
      });
    }
    await this.shipByDeadlines();
  }

  /** Ship-by remedies past their date: shipped → completed, otherwise they fall back to a refund */
  async shipByDeadlines(caseIds?: string[]): Promise<void> {
    const now = this.core.now();
    const rows = await this.core.repo.find('case_remedies', { kind: 'ship_by_deadline', status: ['approved', 'in_progress'], due_at: { op: '<', value: now }, ...(caseIds ? { case_id: caseIds } : {}) }, { limit: BATCH });
    for (const r of rows) {
      await this.safely('ship-by deadline', async () => {
        const agg = (await this.core.load(r.case_id))!;
        const order = agg.c.order_id ? await this.core.quiet('order', () => this.core.ctx.use('orders').getOrder(agg.c.order_id!)) : null;
        const items = order?.groups.flatMap((g) => g.items).filter((i) => r.order_item_ids.includes(i.id)) ?? [];
        const shipped = items.length > 0 && items.every((i) => ['shipped', 'delivered', 'return_requested', 'returned', 'refunded'].includes(i.state));
        if (shipped) {
          await this.decisions.moveRemedy(r.id, 'completed', { label: 'The seller shipped the item' });
          return;
        }
        const cancelled = items.length > 0 && items.every((i) => i.state === 'cancelled' || i.state === 'refunded');
        await this.decisions.moveRemedy(r.id, 'failed', { label: 'The seller missed the agreed ship-by date', note: 'Missed: falls back to a refund' });
        if (cancelled) {
          await this.decisions.moveRemedy(r.id, 'cancelled', { note: 'The item was cancelled; the cancellation refunds it' });
          return;
        }
        const refund = await this.decisions.fallbackRefund(agg, r);
        await this.decisions.moveRemedy(r.id, 'cancelled', { note: refund ? 'Missed: replaced by a refund' : 'Missed: Marketly support follows up' });
      });
    }
  }

  /** Seller-handled cases whose seller missed the reply deadline: Marketly steps in */
  async sellerDeadline(): Promise<void> {
    const now = this.core.now();
    const rows = await this.core.repo.find('cases', { status: 'waiting_on_seller', handler_kind: 'seller', next_response_due_at: { op: '<', value: now } }, { orderBy: [['next_response_due_at', 'asc']], limit: BATCH });
    for (const c of rows) {
      await this.safely('seller deadline', async () => {
        const agg = (await this.core.load(c.id))!;
        if (agg.c.status !== 'waiting_on_seller' || agg.c.handler_kind !== 'seller') return;
        await this.cases.escalate(agg, { reason: 'seller_no_reply', to: 'customer_support', note: null, label: 'The seller did not reply in time: Marketly support stepped in', convertToDispute: agg.c.kind === 'order_problem' }, SYS);
      });
    }
  }

  /** Offers nobody answered in time expire */
  async offerExpiry(): Promise<void> {
    const now = this.core.now();
    const rows = await this.core.repo.find('case_offers', { status: 'open', respond_by: { op: '<', value: now } }, { limit: BATCH });
    for (const o of rows) {
      await this.safely('offer expiry', async () => {
        await this.core.write(o.case_id, SYS, async (tx, a) => {
          const fresh = a.offers.find((x) => x.id === o.id);
          if (!fresh || fresh.status !== 'open') return;
          fresh.status = caseOfferMachine.next('open', 'expire');
          await tx.update('case_offers', o.id, { status: fresh.status, responded_at: now });
          await this.core.timeline(tx, a.c.id, [{ kind: 'offer_expired', label: 'The offer expired without an answer', detail: o.kind.replace(/_/g, ' '), visibility: 'all' }]);
          await this.core.save(tx, a, {});
        });
      });
    }
  }

  /** Resolved cases close after autoCloseAfterDays; appeal windows that ended are recorded */
  async autoClose(): Promise<void> {
    const now = this.core.now();
    const days = await this.core.setting('autoCloseAfterDays', 7);
    const resolved = await this.core.repo.find('cases', { status: 'resolved', resolved_at: { op: '<', value: new Date(now.getTime() - days * DAY) } }, { limit: BATCH });
    for (const c of resolved) {
      await this.safely('auto-close', async () => {
        await this.core.write(c.id, SYS, async (tx, a) => {
          if (a.c.status !== 'resolved') return;
          await this.core.timeline(tx, a.c.id, [{ kind: 'closed', label: 'Case closed', detail: a.c.reopen_until && a.c.reopen_until > now ? `You can still reopen it until ${a.c.reopen_until.toISOString().slice(0, 10)}` : null, visibility: 'all' }]);
          await this.core.save(tx, a, { status: caseMachine.next('resolved', 'close'), closed_at: now });
        });
      });
    }
    const appeals = await this.core.repo.find('cases', { status: 'decision_made', appeal_deadline: { op: '<', value: now } }, { limit: BATCH });
    for (const c of appeals.filter((x) => !x.next_action.facts?.appealWindowClosed)) {
      await this.safely('appeal window', async () => {
        await this.core.write(c.id, SYS, async (tx, a) => {
          if (a.c.next_action.facts?.appealWindowClosed || a.appeals.length) return;
          await this.core.timeline(tx, a.c.id, [{ kind: 'appeal_window_closed', label: 'The appeal window ended', visibility: 'all' }]);
          await this.core.save(tx, a, {}, { appealWindowClosed: true });
        });
      });
    }
    // reopen windows that ended since the last runs (the date stays on the case for REOPEN_WINDOW_CLOSED)
    const windows = (await this.core.repo.find('cases', { status: ['resolved', 'closed'], reopen_until: { op: '<', value: now } }, { orderBy: [['reopen_until', 'desc']], limit: BATCH })).filter((c) => c.reopen_until!.getTime() > now.getTime() - 3 * DAY);
    for (const c of windows) {
      await this.safely('reopen window', async () => {
        await this.core.write(c.id, SYS, async (tx, a) => {
          if (a.events.some((x) => x.kind === 'reopen_window_closed')) return;
          await this.core.timeline(tx, a.c.id, [{ kind: 'reopen_window_closed', label: 'The reopen window ended', visibility: 'all' }]);
          await this.core.save(tx, a, {});
        });
      });
    }
  }
}
