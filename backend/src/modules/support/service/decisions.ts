/**
 * Decisions and what follows them: remedies (through returns, wallet and access approvals), decision drafts,
 * appeals reviewed by a different staff member, resolving and reopening.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import type * as common from '../../../spec/common.js';
import type { DecisionDraft, DecisionInput, RemedyInput } from '../../../spec/support.js';
import { appealMachine, caseMachine, caseOfferMachine, remedyMachine } from '../domain/state-machines.js';
import { human, overturnedOutcome, platformShare, UNRESOLVED_REMEDY, type CaseStatus, type RemedyStatus } from '../domain/rules.js';
import type { OfferRec, PendingApproval, RemedyRec, StoredDecision, SupportRepository } from '../ports.js';
import type { Cases } from './cases.js';
import { actorText, DAY, illegal, invalid, invalidField, SYSTEM, type Agg, type Batch, type By, type Core } from './core.js';
import type { Views } from './views.js';

export const APPROVE_ACTION = 'support.remedies.approve';

/** A remedy validated and priced, before anything is requested */
interface Planned {
  kind: RemedyInput['kind'];
  amount: number | null;
  currency: string;
  chargedTo: 'seller' | 'platform' | 'shared' | null;
  orderItemIds: string[];
  dueAt: Date | null;
  note: string | null;
  /** Value counted against the approval limit (replacements without an amount count the paid price) */
  value: number;
}

type NewRemedy = Omit<RemedyRec, 'id' | 'case_id'>;

/** Events that take a remedy from one status to another (shortest path in the spec machine) */
export function remedyPath(from: RemedyStatus, to: RemedyStatus): string[] | null {
  if (from === to) return [];
  const queue: { s: RemedyStatus; path: string[] }[] = [{ s: from, path: [] }];
  const seen = new Set<string>([from]);
  while (queue.length) {
    const { s, path } = queue.shift()!;
    for (const e of remedyMachine.eventsFrom(s)) {
      for (const t of remedyMachine.targets(s, e)) {
        if (seen.has(t)) continue;
        if (t === to) return [...path, e];
        seen.add(t);
        queue.push({ s: t as RemedyStatus, path: [...path, e] });
      }
    }
  }
  return null;
}

export class Decisions {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly cases: Cases,
  ) {}

  /* ================================================================ remedies */

  private async paidFor(agg: Agg, ids: string[]): Promise<number> {
    if (agg.c.order_id) {
      const remaining = await this.core.soft('payments', 'remaining refundable', (p) => p.remainingRefundable(agg.c.order_id!, ids));
      if (remaining) return remaining.items.filter((i) => ids.includes(i.orderItemId)).reduce((s, i) => s + i.remaining.amount, 0);
      const paid = await this.core.quiet('paid amounts', () => this.core.ctx.use('orders').getPaidAmounts(agg.c.order_id!));
      if (paid) return paid.filter((p) => ids.includes(p.orderItemId)).reduce((s, p) => s + p.paid.amount, 0);
    }
    return agg.items.filter((i) => ids.includes(i.order_item_id)).reduce((s, i) => s + (i.snapshot.paid?.amount ?? i.snapshot.price.amount * i.snapshot.quantity), 0);
  }

  async plan(agg: Agg, inputs: RemedyInput[], path = 'remedies'): Promise<Planned[]> {
    const out: Planned[] = [];
    const issues: { path: string; message: string }[] = [];
    const caseItems = agg.items.map((i) => i.order_item_id);
    const official = agg.c.next_action.facts?.ownerType === 'official';
    const order = agg.c.order_id ? await this.core.quiet('order', () => this.core.ctx.use('orders').getOrder(agg.c.order_id!)) : null;
    const orderItems = new Set(order?.groups.flatMap((g) => g.items.map((i) => i.id)) ?? caseItems);
    for (const [n, r] of (inputs ?? []).entries()) {
      const p = `${path}.${n}`;
      if (r.kind === 'none') continue;
      const ids = r.orderItemIds?.length ? [...new Set(r.orderItemIds)] : caseItems;
      if (ids.some((id) => !orderItems.has(id))) issues.push({ path: `${p}.orderItemIds`, message: 'Some items are not part of the order' });
      const needsOrder = r.kind === 'refund' || r.kind === 'partial_refund' || r.kind === 'replacement' || r.kind === 'return_label' || r.kind === 'ship_by_deadline';
      if (needsOrder && !agg.c.order_id) issues.push({ path: `${p}.kind`, message: 'This remedy needs an order on the case' });
      if ((r.kind === 'partial_refund' || r.kind === 'goodwill_credit') && !(r.amount && r.amount.amount > 0)) issues.push({ path: `${p}.amount`, message: 'Enter the amount' });
      if (r.amount && r.amount.amount <= 0) issues.push({ path: `${p}.amount`, message: 'The amount must be more than zero' });
      if (r.amount && r.amount.currency && r.amount.currency !== this.core.currency) issues.push({ path: `${p}.amount.currency`, message: `Amounts are in ${this.core.currency}` });
      const due = r.dueAt ? new Date(r.dueAt) : null;
      if (r.kind === 'ship_by_deadline' && !due) issues.push({ path: `${p}.dueAt`, message: 'Choose the date the seller must ship by' });
      if (due && (Number.isNaN(due.getTime()) || due.getTime() <= this.core.now().getTime())) issues.push({ path: `${p}.dueAt`, message: 'Choose a date in the future' });
      if ((r.kind === 'refund' || r.kind === 'partial_refund' || r.kind === 'replacement' || r.kind === 'ship_by_deadline') && !ids.length) issues.push({ path: `${p}.orderItemIds`, message: 'Choose the items' });
      const chargedTo = r.chargedTo ?? (r.kind === 'goodwill_credit' || official ? 'platform' : r.kind === 'return_label' || r.kind === 'ship_by_deadline' ? null : 'seller');
      out.push({ kind: r.kind, amount: r.amount?.amount ?? null, currency: this.core.currency, chargedTo, orderItemIds: r.kind === 'goodwill_credit' && !r.orderItemIds?.length ? [] : ids, dueAt: due, note: r.note?.trim() || null, value: 0 });
    }
    if (issues.length) throw invalid(issues);
    for (const p of out) {
      if (p.kind === 'refund' && p.amount === null) {
        p.amount = await this.paidFor(agg, p.orderItemIds);
        if (!p.amount) throw invalidField(path, 'Nothing is left to refund for these items');
      }
      if (p.amount !== null && (p.kind === 'refund' || p.kind === 'partial_refund')) {
        const cap = await this.paidFor(agg, p.orderItemIds);
        if (cap && p.amount > cap) throw this.core.error('VALIDATION_FAILED', 'The refund is more than can still be refunded for these items', { issues: [{ path, message: 'The refund is more than can still be refunded' }], maxRefundable: { amount: cap, currency: this.core.currency } });
      }
      p.value = p.amount ?? (p.kind === 'replacement' ? await this.paidFor(agg, p.orderItemIds) : 0);
    }
    return out;
  }

  /** Marketly's share of the money remedies (support.remedies.approve); goodwill is checked by wallet when it is on */
  platformTotal(planned: Planned[]): number {
    const wallet = this.core.ctx.modules.includes('wallet');
    return planned.filter((p) => ['refund', 'partial_refund', 'replacement'].includes(p.kind) || (p.kind === 'goodwill_credit' && !wallet)).reduce((s, p) => s + platformShare(p.value, p.chargedTo), 0);
  }

  /** Within the decider's limit, or sent for approval (APPROVAL_REQUIRED) with the decision kept pending */
  private async authorize(agg: Agg, planned: Planned[], pending: Omit<PendingApproval, 'requestId' | 'ref' | 'requestedBy' | 'principal' | 'requestedAt'>, reason: string, by: By): Promise<void> {
    const total = this.platformTotal(planned);
    if (!total) return;
    if (!by.principal) throw new AppError('APPROVAL_REQUIRED', 'A platform-funded remedy needs an approver', { action: APPROVE_ACTION });
    const access = this.core.ctx.use('access');
    const amount: common.Money = { amount: total, currency: this.core.currency };
    const check = await access.check(by.principal, APPROVE_ACTION, { money: amount });
    if (check.decision === 'allowed') return;
    if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'Your role cannot decide platform-funded remedies', { action: APPROVE_ACTION });
    const req = await access.requestApproval({
      action: APPROVE_ACTION,
      target: { type: 'case', id: agg.c.id, ref: agg.c.ref, label: `Case ${agg.c.ref}: ${agg.c.subject}`, sellerId: agg.c.seller_id, screen: 'admin/case' },
      amount,
      summary: `${pending.kind === 'appeal' ? 'Appeal decision' : 'Decision'} on ${agg.c.ref} with $${(total / 100).toFixed(2)} funded by Marketly`,
      details: { remedies: planned.map((p) => ({ kind: p.kind, amount: p.amount, chargedTo: p.chargedTo, orderItemIds: p.orderItemIds })) },
      reason,
      requestedBy: by.principal,
    });
    const now = this.core.now();
    await this.core.write(agg.c.id, by, async (tx, a) => {
      const draft = a.c.decision_draft;
      await this.core.save(tx, a, {
        decision_draft: {
          draft: draft?.draft ?? pending.decision ?? null,
          savedAt: draft?.savedAt ?? now.toISOString(),
          savedBy: draft?.savedBy ?? by.actor,
          pending: { ...pending, requestId: req.id, ref: req.ref ?? null, requestedBy: by.actor, principal: by.principal!, requestedAt: now.toISOString() },
        },
      });
      await this.core.timeline(tx, a.c.id, [{ kind: 'approval_requested', label: `${pending.kind === 'appeal' ? 'Appeal decision' : 'Decision'} sent for approval (${req.ref ?? 'approval'})`, detail: check.reason, visibility: 'staff', actor: by.actor }]);
    });
    await this.core.audit({ action: 'support.remedies.request_approval', actionLabel: 'Sent a case decision for approval', category: 'financial', target: this.cases.target(agg), reason, after: { amount, remedies: planned.map((p) => p.kind) }, approvalRequestId: req.id }, by);
    throw new AppError('APPROVAL_REQUIRED', check.reason || 'Above your limit: another approver must approve this decision', { approvalRequestId: req.id, ...(req.ref ? { approvalRef: req.ref } : {}) });
  }

  /** Requests what each remedy needs (refund requests, goodwill) and returns the rows to insert */
  private async execute(agg: Agg, planned: Planned[], reason: string, by: By): Promise<NewRemedy[]> {
    const now = this.core.now();
    const out: NewRemedy[] = [];
    const returnsOn = !!this.core.ctx.tryUse('returns');
    const wallet = this.core.ctx.tryUse('wallet');
    const official = agg.c.next_action.facts?.ownerType === 'official';
    for (const [n, p] of planned.entries()) {
      let status: RemedyStatus = 'pending_approval';
      let refundRequestId: string | null = null;
      let note = p.note;
      const viaRefund = p.kind === 'refund' || p.kind === 'partial_refund' || (p.kind === 'goodwill_credit' && !wallet);
      if (p.kind === 'goodwill_credit' && wallet && agg.c.customer_id && isUuid(agg.c.customer_id)) {
        const grant = await wallet.grantGoodwill(
          { customerId: agg.c.customer_id, amount: { amount: p.amount!, currency: p.currency }, reason, reasonCode: 'service_failure', caseId: agg.c.id, orderId: agg.c.order_id, chargedTo: p.chargedTo === 'seller' ? 'seller' : 'platform', sellerId: agg.c.seller_id },
          by.actor,
          `case:${agg.c.id}:goodwill:${n}:${p.amount}`,
        );
        status = grant.state === 'granted' ? 'completed' : grant.state === 'rejected' ? 'cancelled' : 'pending_approval';
        note = note ?? (grant.state === 'pending_approval' ? 'Waiting for approval of the credit' : null);
      } else if (viaRefund && agg.c.return_id && returnsOn) {
        note = note ?? 'Refunded through the return';
      } else if (viaRefund && agg.c.order_id && returnsOn && p.orderItemIds.length) {
        const fundedBy = p.chargedTo ?? (official ? 'official_store' : 'seller');
        const amount = { amount: p.amount!, currency: p.currency };
        const rr = await this.core.ctx.tryUse('returns')!.requestRefund({
          source: 'case',
          caseId: agg.c.id,
          orderId: agg.c.order_id,
          orderItemIds: p.orderItemIds,
          breakdown: { itemAmount: amount, discountShare: { amount: 0, currency: p.currency }, shippingRefund: { amount: 0, currency: p.currency }, returnShippingDeduction: { amount: 0, currency: p.currency }, deductions: [], total: amount, maxRefundable: amount, destination: 'Original payment method', isEstimate: false },
          fundedBy: official && fundedBy === 'platform' ? 'official_store' : fundedBy,
          reason: `Case ${agg.c.ref}: ${reason}`,
          proposedBy: by.actor,
        });
        refundRequestId = rr.id;
        status = rr.status === 'approved' ? 'approved' : rr.status === 'processing' ? 'in_progress' : rr.status === 'sent' ? 'completed' : rr.status === 'declined' || rr.status === 'cancelled' ? 'cancelled' : 'pending_approval';
      } else if (viaRefund) {
        note = note ?? 'Recorded as a refund request to Finance';
      } else if (p.kind === 'replacement' || p.kind === 'return_label' || p.kind === 'ship_by_deadline') {
        status = 'in_progress';
      }
      out.push({
        kind: p.kind,
        amount: p.amount,
        currency: p.amount !== null ? p.currency : null,
        charged_to: p.chargedTo,
        order_item_ids: p.orderItemIds,
        status,
        refund_request_id: refundRequestId,
        replacement_id: null,
        due_at: p.dueAt,
        note,
        created_by: actorText(by.actor),
        created_at: now,
        updated_at: now,
      });
    }
    return out;
  }

  /** A remedy for an accepted seller offer (refunds go to Finance through returns) */
  async fromOffer(agg: Agg, offer: OfferRec, by: By): Promise<NewRemedy | null> {
    const kind = offer.kind === 'ship_by_date' ? 'ship_by_deadline' : (offer.kind as RemedyInput['kind']);
    const dueAt = offer.kind === 'ship_by_date' && offer.ship_by ? this.cases.shipByEnd(offer.ship_by).toISOString() : null;
    const planned = await this.plan(agg, [{ kind, amount: offer.amount !== null ? { amount: offer.amount, currency: offer.currency ?? this.core.currency } : null, chargedTo: 'seller', dueAt: dueAt && new Date(dueAt).getTime() > this.core.now().getTime() ? dueAt : null, note: offer.note }], 'offer');
    if (!planned[0]) return null;
    if (planned[0].kind === 'ship_by_deadline' && !planned[0].dueAt) planned[0].dueAt = new Date(this.core.now().getTime() + DAY);
    return (await this.execute(agg, planned, `Accepted the seller's offer (${offer.kind.replace(/_/g, ' ')})`, by))[0] ?? null;
  }

  /* ================================================================ decision */

  private stillPending(agg: Agg) {
    const p = agg.c.decision_draft?.pending;
    if (p) throw new AppError('APPROVAL_REQUIRED', 'A decision on this case is waiting for approval', { approvalRequestId: p.requestId, ...(p.ref ? { approvalRef: p.ref } : {}) });
  }

  async decide(agg: Agg, input: DecisionInput, by: By, o: { approved?: PendingApproval } = {}): Promise<void> {
    if (!o.approved) this.stillPending(agg);
    caseMachine.next(agg.c.status as CaseStatus, 'decide');
    if (!input.reason?.trim()) throw invalidField('reason', 'Explain the decision to both parties');
    const now = this.core.now();
    let appealDeadline: Date;
    if (input.appealDeadline) {
      appealDeadline = new Date(input.appealDeadline);
      if (Number.isNaN(appealDeadline.getTime()) || appealDeadline.getTime() <= now.getTime()) throw invalidField('appealDeadline', 'Choose an appeal deadline in the future');
    } else appealDeadline = new Date(now.getTime() + (await this.core.setting('appealWindowDays', 14)) * DAY);
    const planned = await this.plan(agg, input.remedies ?? []);
    if (!o.approved) await this.authorize(agg, planned, { kind: 'decision', decision: input }, input.reason.trim(), by);
    const rows = await this.execute(agg, planned, input.reason.trim(), by);
    const decided = await this.core.write(agg.c.id, by, async (tx, a, batch) => {
      const status = caseMachine.next(a.c.status as CaseStatus, 'decide');
      const inserted = await this.insertRemedies(tx, a, rows);
      await this.withdrawOffers(tx, a);
      const decision: StoredDecision = { outcome: input.outcome, reason: input.reason.trim(), decidedBy: by.actor, decidedAt: now.toISOString(), publishedAt: input.notifyParties ? now.toISOString() : null, appealDeadline: appealDeadline.toISOString(), final: false, notifyParties: input.notifyParties };
      await this.core.save(tx, a, { status, decision, decision_draft: null, appeal_deadline: appealDeadline, next_response_due_at: null, waiting_on: null, handler_kind: 'marketplace_support', support_following: true, ...(a.c.first_replied_at ? {} : { first_replied_at: now }) }, { infoRequest: null, appealWindowClosed: false });
      await this.core.timeline(tx, a.c.id, [{ kind: 'decided', label: `Decision: ${human(input.outcome)}`, detail: input.reason.trim(), visibility: 'all', actor: by.actor }]);
      if (input.notifyParties) await this.decisionMessage(tx, a, batch, decision, inserted, by);
      batch.push('support.case.decided', { caseId: a.c.id, ref: a.c.ref, outcome: input.outcome, orderId: a.c.order_id, returnId: a.c.return_id, sellerId: a.c.seller_id, remedies: a.remedies.map((r) => this.views.remedy(r, this.core.currency)), appealDeadline: appealDeadline.toISOString(), final: false });
      return inserted;
    });
    await this.core.audit(
      {
        action: 'support.case.decide',
        actionLabel: `Decided case ${agg.c.ref}: ${human(input.outcome)}`,
        category: decided.some((r) => r.amount) ? 'financial' : 'customers',
        target: this.cases.target(agg),
        reason: input.reason,
        before: { status: agg.c.status },
        after: { outcome: input.outcome, remedies: decided.map((r) => ({ kind: r.kind, amount: r.amount, chargedTo: r.charged_to, status: r.status })), appealDeadline: appealDeadline.toISOString() },
        ...(o.approved ? { approvalRequestId: o.approved.requestId } : {}),
      },
      by,
    );
  }

  private async insertRemedies(tx: SupportRepository, a: Agg, rows: NewRemedy[]): Promise<RemedyRec[]> {
    const out: RemedyRec[] = [];
    for (const r of rows) {
      const row = await tx.insert('case_remedies', { id: newId(), case_id: a.c.id, ...r });
      a.remedies.push(row);
      out.push(row);
    }
    return out;
  }

  private async withdrawOffers(tx: SupportRepository, a: Agg) {
    for (const o of a.offers.filter((x) => x.status === 'open')) {
      o.status = caseOfferMachine.next('open', 'withdraw');
      await tx.update('case_offers', o.id, { status: o.status, responded_at: this.core.now() });
    }
  }

  private async decisionMessage(tx: SupportRepository, a: Agg, batch: Batch, d: StoredDecision, remedies: RemedyRec[], by: By) {
    const what = remedies.length ? ` Remedy: ${remedies.map((r) => `${human(r.kind)}${r.amount ? ` $${(r.amount / 100).toFixed(2)}` : ''}`).join(', ')}.` : '';
    const appeal = d.final ? ' This decision is final.' : d.appealDeadline ? ` Either party can appeal until ${new Date(d.appealDeadline).toISOString().slice(0, 10)}.` : '';
    const m = await this.core.message(tx, a.c.id, { author: by.actor, authorLabel: 'Marketly decision', role: 'system', audience: 'all', body: `${human(d.outcome)}: ${d.reason}.${what}${appeal}`.replace(/\.\./g, '.') });
    batch.push('support.case.message_added', { caseId: a.c.id, messageId: m.id, audience: 'all', authorRole: 'system' });
  }

  async saveDraft(agg: Agg, input: DecisionInput, by: By): Promise<DecisionDraft> {
    if (!caseMachine.can(agg.c.status as CaseStatus, 'decide') && agg.c.status !== 'appealed') throw illegal('A decision can only be drafted while the case is open for a decision', { from: agg.c.status, event: 'decide' });
    const now = this.core.now();
    await this.core.write(agg.c.id, by, async (tx, a) => {
      await this.core.save(tx, a, { decision_draft: { draft: input, savedAt: now.toISOString(), savedBy: by.actor, pending: a.c.decision_draft?.pending ?? null } });
      await this.core.timeline(tx, a.c.id, [{ kind: 'draft_saved', label: 'Decision draft saved', visibility: 'staff', actor: by.actor }]);
    });
    return { draft: input, savedAt: now.toISOString(), savedBy: by.actor };
  }

  async deleteDraft(agg: Agg, by: By): Promise<void> {
    if (!agg.c.decision_draft?.draft) return;
    await this.core.write(agg.c.id, by, async (tx, a) => {
      const pending = a.c.decision_draft?.pending ?? null;
      await this.core.save(tx, a, { decision_draft: pending ? { ...a.c.decision_draft!, draft: null } : null });
      await this.core.timeline(tx, a.c.id, [{ kind: 'draft_discarded', label: 'Decision draft discarded', visibility: 'staff', actor: by.actor }]);
    });
  }

  /* ================================================================ appeals */

  async appeal(agg: Agg, body: { reason: string; mediaIds?: string[] | null }, party: 'customer' | 'seller', by: By): Promise<void> {
    const c = agg.c;
    if (!body.reason?.trim()) throw invalidField('reason', 'Explain why the decision should change');
    if (!c.decision || c.decision.final || agg.appeals.length) throw illegal(c.decision?.final ? 'This decision is final' : 'There is no decision to appeal', { from: c.status, event: 'appeal' });
    caseMachine.next(c.status as CaseStatus, 'appeal');
    if (c.appeal_deadline && c.appeal_deadline.getTime() <= this.core.now().getTime()) throw this.core.error('APPEAL_WINDOW_CLOSED', 'The appeal deadline has passed', { appealDeadline: c.appeal_deadline.toISOString() });
    await this.core.checkAttachments(body.mediaIds);
    const mediaIds = body.mediaIds ?? [];
    await this.core.attach(mediaIds, c.id, `Case ${c.ref}`, party === 'seller' ? { kind: 'seller', id: c.seller_id } : { kind: 'customer', id: by.actor.id ?? null });
    const due = await this.core.addBusinessDays(this.core.now(), await this.core.setting('appealReplyBusinessDays', 3));
    await this.core.write(c.id, by, async (tx, a, batch) => {
      if (a.appeals.length) throw illegal('This decision was already appealed', { from: a.c.status, event: 'appeal' });
      const now = this.core.now();
      const status = caseMachine.next(a.c.status as CaseStatus, 'appeal');
      a.appeals.push(await tx.insert('case_appeals', { id: newId(), case_id: a.c.id, by_kind: by.actor.kind, by_id: by.actor.id ?? party, reason: body.reason.trim(), media_ids: mediaIds, status: appealMachine.initial, reviewer_staff_id: null, submitted_at: now, decided_at: null, outcome: null }));
      const label = party === 'seller' ? `${a.c.next_action.facts?.sellerName ?? 'Seller'} (seller)` : (a.c.next_action.facts?.customerName ?? 'Customer');
      const m = await this.core.message(tx, a.c.id, { author: by.actor, authorLabel: label, role: party, audience: 'all', body: `Appeal: ${body.reason.trim()}`, mediaIds });
      if (mediaIds.length) await tx.insert('case_evidence', { id: newId(), case_id: a.c.id, party, kind: 'photo', media_ids: mediaIds, note: 'Attached to the appeal', added_by: actorText(by.actor), at: now });
      await this.core.timeline(tx, a.c.id, [{ kind: 'appealed', label: party === 'seller' ? 'The seller appealed the decision' : 'The customer appealed the decision', detail: body.reason.trim(), visibility: 'all', actor: by.actor }]);
      await this.core.save(tx, a, { status, next_response_due_at: due, waiting_on: 'marketplace' });
      batch.push('support.case.appealed', { caseId: a.c.id, by: by.actor });
      batch.push('support.case.message_added', { caseId: a.c.id, messageId: m.id, audience: 'all', authorRole: party });
    });
  }

  async decideAppeal(agg: Agg, body: { overturn: boolean; reason: string; remedies?: RemedyInput[] | null }, by: By, o: { approved?: PendingApproval } = {}): Promise<void> {
    if (!o.approved) this.stillPending(agg);
    const c = agg.c;
    caseMachine.next(c.status as CaseStatus, 'decideAppeal');
    const appeal = agg.appeals.at(-1);
    if (!appeal || !c.decision) throw illegal('There is no appeal to decide', { from: c.status, event: 'decideAppeal' });
    if (!body.reason?.trim()) throw invalidField('reason', 'Explain the appeal decision');
    const decider = c.decision.decidedBy;
    if (decider.kind === 'staff' && decider.id && by.actor.id && decider.id === by.actor.id) throw this.core.error('SAME_DECIDER', 'A different staff member must review the appeal');
    const planned = body.overturn ? await this.plan(agg, body.remedies ?? []) : [];
    if (!o.approved && planned.length) await this.authorize(agg, planned, { kind: 'appeal', appeal: { overturn: body.overturn, reason: body.reason, remedies: body.remedies ?? [] } }, body.reason.trim(), by);
    const rows = await this.execute(agg, planned, body.reason.trim(), by);
    const now = this.core.now();
    const final = await this.core.write(c.id, by, async (tx, a, batch) => {
      const status = caseMachine.next(a.c.status as CaseStatus, 'decideAppeal');
      const ap = a.appeals.at(-1)!;
      const reviewing = ap.status === 'submitted' ? appealMachine.next('submitted', 'startReview') : ap.status;
      const appealStatus = appealMachine.next(reviewing as never, body.overturn ? 'overturn' : 'keepDecision');
      await tx.update('case_appeals', ap.id, { status: appealStatus, reviewer_staff_id: by.actor.id && isUuid(by.actor.id) ? by.actor.id : null, decided_at: now, outcome: body.reason.trim() });
      if (body.overturn) {
        for (const r of a.remedies.filter((x) => ['pending_approval', 'approved', 'failed'].includes(x.status))) {
          const path = remedyPath(r.status as RemedyStatus, 'cancelled');
          if (!path) continue;
          r.status = 'cancelled';
          await tx.update('case_remedies', r.id, { status: 'cancelled', note: 'Cancelled: the appeal changed the decision', updated_at: now });
        }
      }
      await this.insertRemedies(tx, a, rows);
      const old = a.c.decision!;
      const hasMoney = rows.some((r) => r.kind !== 'return_label' && r.kind !== 'ship_by_deadline');
      const decision: StoredDecision = body.overturn
        ? { outcome: overturnedOutcome(old.outcome, hasMoney), reason: body.reason.trim(), decidedBy: by.actor, decidedAt: now.toISOString(), publishedAt: now.toISOString(), appealDeadline: null, final: true, notifyParties: true, previous: [...(old.previous ?? []), { outcome: old.outcome, reason: old.reason, decidedBy: old.decidedBy, decidedAt: old.decidedAt }] }
        : { ...old, final: true, appealDeadline: null };
      await this.core.save(tx, a, { status, decision, appeal_deadline: null, next_response_due_at: null, waiting_on: null, decision_draft: a.c.decision_draft?.draft ? { ...a.c.decision_draft, pending: null } : null });
      await this.core.timeline(tx, a.c.id, [{ kind: 'appeal_decided', label: body.overturn ? 'Appeal accepted: the decision was changed' : 'Appeal reviewed: the decision stands', detail: body.reason.trim(), visibility: 'all', actor: by.actor }]);
      const m = await this.core.message(tx, a.c.id, { author: by.actor, authorLabel: 'Marketly appeal review', role: 'system', audience: 'all', body: `${body.overturn ? `The appeal was accepted. New decision: ${human(decision.outcome)}` : 'The appeal was reviewed and the decision stands'}: ${body.reason.trim()}. This decision is final.` });
      batch.push('support.case.message_added', { caseId: a.c.id, messageId: m.id, audience: 'all', authorRole: 'system' });
      batch.push('support.case.appeal_decided', { caseId: a.c.id, overturned: body.overturn });
      batch.push('support.case.decided', { caseId: a.c.id, ref: a.c.ref, outcome: decision.outcome, orderId: a.c.order_id, returnId: a.c.return_id, sellerId: a.c.seller_id, remedies: a.remedies.map((r) => this.views.remedy(r, this.core.currency)), appealDeadline: null, final: true });
      return decision;
    });
    await this.core.audit(
      {
        action: 'support.appeal.decide',
        actionLabel: body.overturn ? `Overturned the decision on ${c.ref}` : `Kept the decision on ${c.ref}`,
        category: rows.some((r) => r.amount) ? 'financial' : 'customers',
        target: this.cases.target(agg),
        reason: body.reason,
        before: { outcome: c.decision.outcome, decidedBy: c.decision.decidedBy },
        after: { outcome: final.outcome, overturned: body.overturn, remedies: rows.map((r) => ({ kind: r.kind, amount: r.amount })) },
        ...(o.approved ? { approvalRequestId: o.approved.requestId } : {}),
      },
      by,
    );
  }

  /* ================================================================ resolve and reopen */

  async resolve(agg: Agg, body: { summary: string }, by: By): Promise<void> {
    if (!body.summary?.trim()) throw invalidField('summary', 'Summarize how the case was resolved');
    caseMachine.next(agg.c.status as CaseStatus, 'resolve');
    const unresolved = agg.remedies.filter((r) => (UNRESOLVED_REMEDY as readonly string[]).includes(r.status));
    if (unresolved.length) throw this.core.error('REMEDY_PENDING', 'A promised refund or replacement is not finished yet', { remedies: unresolved.map((r) => ({ id: r.id, kind: r.kind, status: r.status })) });
    const reopenUntil = new Date(this.core.now().getTime() + (await this.core.setting('reopenWindowDays', 30)) * DAY);
    const name = by.actor.name ?? (by.actor.id ? (await this.core.staffNames([by.actor.id])).get(by.actor.id) : undefined);
    const resolvedAt = await this.core.write(agg.c.id, by, async (tx, a, batch) => {
      const now = this.core.now();
      const status = caseMachine.next(a.c.status as CaseStatus, 'resolve');
      if (a.remedies.some((r) => (UNRESOLVED_REMEDY as readonly string[]).includes(r.status))) throw this.core.error('REMEDY_PENDING', 'A promised refund or replacement is not finished yet', { remedies: a.remedies.filter((r) => (UNRESOLVED_REMEDY as readonly string[]).includes(r.status)).map((r) => ({ id: r.id, kind: r.kind, status: r.status })) });
      await this.withdrawOffers(tx, a);
      const m = await this.core.message(tx, a.c.id, { author: by.actor, authorLabel: `${name ?? 'Marketly'}, Marketly support`, role: 'marketly_staff', audience: 'all', body: body.summary.trim() });
      await this.core.timeline(tx, a.c.id, [{ kind: 'resolved', label: 'Case resolved', detail: body.summary.trim(), visibility: 'all', actor: by.actor }]);
      await this.core.save(tx, a, { status, resolved_at: now, reopen_until: reopenUntil, next_response_due_at: null, waiting_on: null, ...(a.c.first_replied_at ? {} : { first_replied_at: now }) });
      batch.push('support.case.message_added', { caseId: a.c.id, messageId: m.id, audience: 'all', authorRole: 'marketly_staff' });
      batch.push('support.case.resolved', { caseId: a.c.id, ref: a.c.ref, sellerId: a.c.seller_id, resolvedAt: now.toISOString() });
      return now;
    });
    await this.core.audit({ action: 'support.case.resolve', actionLabel: `Resolved case ${agg.c.ref}`, target: this.cases.target(agg), reason: body.summary, before: { status: agg.c.status }, after: { status: 'resolved', resolvedAt: resolvedAt.toISOString(), reopenUntil: reopenUntil.toISOString() } }, by);
  }

  async reopen(agg: Agg, body: { reason: string }, who: 'customer' | 'staff', by: By): Promise<void> {
    const c = agg.c;
    if (!body.reason?.trim()) throw invalidField('reason', 'Say why the case should be reopened');
    caseMachine.next(c.status as CaseStatus, 'reopen');
    if (who === 'customer' && (!c.reopen_until || c.reopen_until.getTime() <= this.core.now().getTime())) throw this.core.error('REOPEN_WINDOW_CLOSED', 'The reopen window has ended. Contact support to open a new case.', { reopenUntil: c.reopen_until?.toISOString() ?? null });
    const cat = (await this.core.category(c.category_key))!;
    const due = await this.cases.marketplaceDue(cat, c.priority, true);
    await this.core.write(c.id, by, async (tx, a, batch) => {
      const status = caseMachine.next(a.c.status as CaseStatus, 'reopen');
      if (who === 'customer') {
        const m = await this.core.message(tx, a.c.id, { author: by.actor, authorLabel: a.c.next_action.facts?.customerName ?? 'Customer', role: 'customer', audience: 'all', body: body.reason.trim() });
        batch.push('support.case.message_added', { caseId: a.c.id, messageId: m.id, audience: 'all', authorRole: 'customer' });
      } else await this.core.message(tx, a.c.id, { author: by.actor, authorLabel: 'Reopened (internal note)', role: 'internal_note', audience: 'internal', body: body.reason.trim() });
      await this.core.timeline(tx, a.c.id, [{ kind: 'reopened', label: who === 'customer' ? 'You reopened the case' : 'Marketly reopened the case', detail: body.reason.trim(), visibility: 'all', actor: by.actor, reason: body.reason.trim() }]);
      await this.core.save(tx, a, { status, reopen_count: a.c.reopen_count + 1, reopen_until: null, closed_at: null, handler_kind: 'marketplace_support', support_following: true, next_response_due_at: due, waiting_on: 'marketplace' });
      batch.push('support.case.reopened', { caseId: a.c.id, by: by.actor, reason: body.reason.trim() });
    });
    if (who === 'staff') await this.core.audit({ action: 'support.case.reopen', actionLabel: `Reopened case ${c.ref}`, target: this.cases.target(agg), reason: body.reason, before: { status: c.status }, after: { status: 'reopened' } }, by);
  }

  /* ================================================================ approvals */

  /** access.approval.decided for support.remedies.approve: publish the waiting decision, or put it back to the decider */
  async onApprovalDecided(e: EventPayload<'access.approval.decided'>): Promise<void> {
    if (e.actionKey !== APPROVE_ACTION || (e.module && e.module !== 'support')) return;
    const caseId = e.target?.type === 'case' ? e.target.id : null;
    const agg = caseId ? await this.core.load(caseId) : undefined;
    const pending = agg?.c.decision_draft?.pending;
    if (!agg || !pending || pending.requestId !== e.requestId) return;
    const decider: By = { actor: pending.requestedBy, principal: pending.principal };
    if (e.outcome === 'approved') {
      try {
        if (pending.kind === 'appeal' && pending.appeal) await this.decideAppeal(agg, pending.appeal, decider, { approved: pending });
        else if (pending.decision) await this.decide(agg, pending.decision, decider, { approved: pending });
      } catch (err) {
        this.core.ctx.log.warn({ err, caseId: agg.c.id, requestId: e.requestId }, 'support: approved decision could not be published');
        await this.clearPending(agg.c.id, `Approved, but the decision could not be published: ${(err as Error).message}`, e.decidedBy ?? SYSTEM);
        return;
      }
      await this.core.write(agg.c.id, { actor: e.decidedBy ?? SYSTEM }, async (tx, a) => {
        await this.core.timeline(tx, a.c.id, [{ kind: 'approval_decided', label: `Approval ${e.ref} granted`, detail: e.reason ?? null, visibility: 'staff', actor: e.decidedBy ?? SYSTEM }]);
        if (a.c.decision_draft?.pending) await this.core.save(tx, a, { decision_draft: a.c.decision_draft.draft ? { ...a.c.decision_draft, pending: null } : null });
      });
      return;
    }
    await this.clearPending(agg.c.id, `Approval ${e.ref} ${e.outcome}${e.reason ? `: ${e.reason}` : ''}`, e.decidedBy ?? SYSTEM);
  }

  private async clearPending(caseId: string, label: string, actor: common.Actor) {
    await this.core.write(caseId, { actor }, async (tx, a) => {
      if (!a.c.decision_draft?.pending) return;
      const draft = a.c.decision_draft;
      await this.core.save(tx, a, { decision_draft: draft.draft ? { ...draft, pending: null } : draft.pending?.decision ? { draft: draft.pending.decision, savedAt: draft.savedAt, savedBy: draft.savedBy, pending: null } : null });
      await this.core.timeline(tx, a.c.id, [{ kind: 'approval_decided', label, visibility: 'staff', actor }]);
      await this.core.message(tx, a.c.id, { author: actor, authorLabel: 'Approval (internal note)', role: 'internal_note', audience: 'internal', body: `${label}. The decision was not published; change it and decide again.` });
    });
  }

  /* ================================================================ remedy progress (consumers and jobs) */

  /** A missed ship-by date falls back to a seller-funded refund of the items */
  async fallbackRefund(agg: Agg, r: RemedyRec): Promise<boolean> {
    const by: By = { actor: SYSTEM };
    try {
      const planned = await this.plan(agg, [{ kind: 'refund', chargedTo: 'seller', orderItemIds: r.order_item_ids, note: 'The agreed ship-by date was missed' }]);
      const rows = await this.execute(agg, planned, 'The seller missed the agreed ship-by date', by);
      if (!rows.length) return false;
      await this.core.write(agg.c.id, by, async (tx, a) => {
        await this.insertRemedies(tx, a, rows);
        await this.core.timeline(tx, a.c.id, [{ kind: 'fallback_refund', label: 'The seller missed the ship-by date: a refund was requested', visibility: 'all' }]);
        await this.core.save(tx, a, {});
      });
      return true;
    } catch (err) {
      this.core.ctx.log.warn({ err, caseId: agg.c.id }, 'support: fallback refund could not be requested');
      return false;
    }
  }

  /** Moves a remedy along the spec machine to `to` (no-op when it is already there or cannot get there) */
  async moveRemedy(remedyId: string, to: RemedyStatus, o: { note?: string | null; refundRequestId?: string | null; replacementId?: string | null; label?: string; visibility?: 'all' | 'staff' } = {}): Promise<boolean> {
    const r = await this.core.repo.get('case_remedies', remedyId);
    if (!r) return false;
    let moved = false;
    await this.core.write(r.case_id, { actor: SYSTEM }, async (tx, a) => {
      const fresh = a.remedies.find((x) => x.id === remedyId)!;
      const path = remedyPath(fresh.status as RemedyStatus, to);
      const link = (o.refundRequestId && !fresh.refund_request_id) || (o.replacementId && !fresh.replacement_id);
      if ((!path || !path.length) && !link) return;
      let status = fresh.status as RemedyStatus;
      for (const e of path ?? []) status = remedyMachine.next(status, e as never) as RemedyStatus;
      const updated = await tx.update('case_remedies', remedyId, { status, updated_at: this.core.now(), ...(o.note !== undefined ? { note: o.note } : {}), ...(o.refundRequestId && !fresh.refund_request_id ? { refund_request_id: o.refundRequestId } : {}), ...(o.replacementId && !fresh.replacement_id ? { replacement_id: o.replacementId } : {}) });
      Object.assign(fresh, updated);
      if (o.label && path?.length) await this.core.timeline(tx, a.c.id, [{ kind: `remedy_${status}`, label: o.label, detail: o.note ?? null, visibility: o.visibility ?? 'all' }]);
      // a failed remedy goes back to the top of the owner's queue (due now; the SLA job flags it)
      if (status === 'failed') await this.core.save(tx, a, { waiting_on: 'marketplace', next_response_due_at: this.core.now() });
      else await this.core.save(tx, a, {});
      moved = true;
    });
    return moved;
  }
}
