/**
 * Decisions on a return: approve (with a return label from shipping), ask for information, reject with an
 * explanation, refund without return (a controlled exception with a recorded reason), and the platform's
 * interventions: take over, overturn a rejection, assign an owner.
 */
import { newId } from '../../../kernel/lib/ids.js';
import type { ExceptionInput, ReturnDecision } from '../../../spec/returns.js';
import { returnMachine, returnShipmentMachine } from '../domain/state-machines.js';
import { addDays, is, isFault, LIVE_REFUND, shortDate, type ReturnStatus } from '../domain/rules.js';
import type { ShipmentRec } from '../ports.js';
import { illegal, invalidField, SYSTEM, type Agg, type By, type Core } from './core.js';
import type { Handling } from './handling.js';
import type { Refunds } from './refunds.js';

export type LabelMethod = 'prepaid_qr' | 'prepaid_label' | 'customer_arranged';
/** seller: the seller's own decision; admin: staff (Official Store, or the platform deciding a seller return); auto: Official Store auto-approval */
export type Mode = 'seller' | 'admin' | 'auto';

const REJECT_LABEL: Record<string, string> = { outside_window: 'Outside the return window', item_not_eligible: 'Item not eligible for return', damaged_by_customer: 'Damaged after delivery', other: 'Other' };

export class Decisions {
  constructor(
    private readonly core: Core,
    private readonly refunds: Refunds,
    private readonly handling: Handling,
  ) {}

  /** Marketly decides a seller's return: staff, or the automatic approval of a Fulfilled by Marketly return (D7) */
  private platformDecision(agg: Agg, mode: Mode) {
    return agg.ret.owner_type === 'seller' && (mode === 'admin' || (mode === 'auto' && this.core.isService(agg.ret)));
  }

  /** Sellers cannot act on Fulfilled by Marketly returns, nor once Marketly handles the return */
  private sellerMayRespond(agg: Agg, mode: Mode) {
    if (mode === 'seller') this.core.sellerMayAct(agg.ret);
    if (mode === 'seller' && agg.ret.platform_handling) throw this.core.error('RESPONSE_DEADLINE_PASSED', 'Marketly is handling this return now', { respondBy: agg.ret.response_due_at?.toISOString() ?? null });
  }

  /** Platform handling once staff decide a seller return */
  private platformPatch(agg: Agg, mode: Mode) {
    return this.platformDecision(agg, mode) ? { platform_handling: true, handled_by: 'marketplace_support' } : {};
  }

  /* ---------------------------------------------------------------- labels */

  /** Creates the return parcel (prepaid label through shipping, or a customer-arranged shipment) */
  private async issue(agg: Agg, method: LabelMethod, carrierServiceId: string | null | undefined, by: By): Promise<{ row: ShipmentRec; labelId: string | null }> {
    const r = agg.ret;
    const meta = r.terms_snapshot.meta;
    const now = this.core.now();
    const dropOffBy = addDays(now, meta.targets.dropOffDays);
    const base = { return_id: r.id, method, from_address: meta.deliveryAddress, to_address: meta.destination.address, created_at: now, delivered_at: null } as const;
    if (method === 'customer_arranged') {
      return {
        labelId: null,
        row: { ...base, id: newId(), status: 'label_issued', carrier: null, service: null, tracking_number: null, label_url: null, qr_code_url: null, drop_off_code: null, drop_off_by: dropOffBy, cost: null, paid_by: 'customer', shipping_shipment_id: null, label_id: null, carrier_service_id: null },
      };
    }
    const billedTo = r.owner_type === 'official' ? 'company' : (r.shipping_paid_by as 'seller' | 'customer' | 'platform');
    const result = await this.core.ctx.use('shipping').createLabel(
      {
        groupId: meta.groupId,
        kind: 'return',
        items: agg.items.map((i) => ({ orderItemId: i.order_item_id, quantity: i.quantity })),
        parcel: { weightGrams: 1000 },
        carrierServiceId: carrierServiceId ?? meta.carrierServiceId ?? null,
        keepPromise: false,
        from: meta.deliveryAddress,
        to: meta.destination.address,
        returnId: r.id,
        labelMethod: method,
        billedTo,
        // the policy's drop-off days from approval; shipping stores it on the label and never invents one
        dropOffBy: dropOffBy.toISOString(),
      },
      `return-label:${r.id}:${method}`,
    );
    const l = result.label;
    void by;
    return {
      labelId: l.id,
      row: {
        ...base,
        id: l.id,
        status: 'label_issued',
        carrier: l.carrierName,
        service: l.serviceName,
        tracking_number: l.trackingNumber,
        label_url: l.labelUrl,
        qr_code_url: l.qrCodeUrl ?? null,
        drop_off_code: l.dropOffCode ?? null,
        drop_off_by: l.dropOffBy ? new Date(l.dropOffBy) : dropOffBy,
        cost: l.cost.amount,
        paid_by: r.shipping_paid_by,
        shipping_shipment_id: result.shipment.id,
        label_id: l.id,
        carrier_service_id: l.carrierServiceId ?? null,
      },
    };
  }

  private async voidLabel(labelId: string | null, reason: string) {
    if (!labelId) return;
    await this.core.quiet('void label', () => this.core.ctx.use('shipping').voidLabel(labelId, reason));
  }

  /* ---------------------------------------------------------------- approve */

  async approve(id: string, body: { labelMethod: LabelMethod; carrierServiceId?: string | null; note?: string | null }, by: By, mode: Mode, agg: Agg): Promise<void> {
    const r = agg.ret;
    this.sellerMayRespond(agg, mode);
    returnMachine.next(r.status as ReturnStatus, 'approve');
    if (body.labelMethod === 'customer_arranged' && isFault(r.reason)) throw this.core.error('SHIPPING_PAYER_NOT_ALLOWED', 'Customers never pay return shipping for damaged, wrong or defective items; send a prepaid label', { reason: r.reason });
    const { row, labelId } = await this.issue(agg, body.labelMethod, body.carrierServiceId, by);
    const now = this.core.now();
    const decision: ReturnDecision = { kind: 'approved', reasonCode: null, explanation: body.note?.trim() || null, decidedBy: mode === 'auto' ? SYSTEM : by.actor, decidedAt: now.toISOString(), platformDecision: this.platformDecision(agg, mode) };
    try {
      await this.core.write(id, by, async (tx, a, batch) => {
        const status = returnMachine.next(a.ret.status as ReturnStatus, 'approve');
        await tx.update('returns', id, {
          status,
          decision,
          ...this.platformPatch(a, mode),
          shipping_paid_by: row.paid_by,
          terms_snapshot: { ...a.ret.terms_snapshot, meta: { ...a.ret.terms_snapshot.meta, carrierServiceId: row.carrier_service_id ?? body.carrierServiceId ?? a.ret.terms_snapshot.meta.carrierServiceId ?? null } },
          updated_at: now,
        });
        await tx.insert('return_shipments', row);
        await this.core.timeline(tx, id, [
          {
            kind: 'approved',
            label: 'Return approved',
            detail: row.method === 'customer_arranged' ? `Send it back and add tracking by ${shortDate(row.drop_off_by!, this.core.tz)}` : `Drop off by ${shortDate(row.drop_off_by!, this.core.tz)}`,
            visibility: 'customer',
            actor: decision.decidedBy,
          },
          ...(body.note ? [{ kind: 'note', label: 'Approval note', detail: body.note, visibility: 'seller' as const, actor: by.actor }] : []),
        ]);
        batch.push('returns.return.approved', this.core.approvedEvent(a, { withoutReturn: false, platformDecision: decision.platformDecision, shipment: row }));
        if (labelId && row.cost !== null) batch.push('returns.label.created', { returnId: id, ...this.core.refs(a.ret), ...this.core.recipient(a.ret), ownerType: a.ret.owner_type, sellerId: a.ret.seller_id, labelId, cost: { amount: row.cost, currency: this.core.currency }, paidBy: row.paid_by as 'seller' | 'customer' | 'platform' });
      });
    } catch (err) {
      await this.voidLabel(labelId, 'The return could not be approved');
      throw err;
    }
    if (mode === 'admin') {
      await this.core.audit({ action: 'returns.return.approve', actionLabel: `Approved return ${r.ref}`, target: this.target(agg), before: { status: r.status }, after: { status: 'approved', labelMethod: body.labelMethod }, reason: body.note ?? null }, by);
    }
  }

  target(agg: Agg) {
    return { type: 'return', id: agg.ret.id, ref: agg.ret.ref, label: `Return ${agg.ret.ref}`, sellerId: agg.ret.seller_id, screen: 'admin/return' };
  }

  /* ---------------------------------------------------------------- information and rejection */

  async requestInfo(id: string, question: string, by: By, mode: Mode, agg: Agg): Promise<void> {
    if (!question?.trim()) throw invalidField('question', 'Ask a question');
    this.sellerMayRespond(agg, mode);
    const now = this.core.now();
    const replyDueAt = addDays(now, agg.ret.terms_snapshot.meta.targets.infoReplyDays);
    await this.core.write(id, by, async (tx, a, batch) => {
      const status = returnMachine.next(a.ret.status as ReturnStatus, 'requestInfo');
      const remainingMs = Math.max(0, (a.ret.response_due_at?.getTime() ?? now.getTime()) - now.getTime());
      await tx.update('returns', id, {
        status,
        info_request: { question: question.trim(), askedBy: by.actor, askedAt: now.toISOString(), replyDueAt: replyDueAt.toISOString(), reply: null, replyMediaIds: [], repliedAt: null, remainingMs },
        response_due_at: null,
        ...this.platformPatch(a, mode),
        updated_at: now,
      });
      await this.core.timeline(tx, id, [{ kind: 'info_requested', label: 'Question about your return', detail: question.trim(), visibility: 'customer', actor: by.actor }]);
      batch.push('returns.return.info_requested', { returnId: id, ...this.core.refs(a.ret), ...this.core.recipient(a.ret), replyDueAt: replyDueAt.toISOString() });
    });
    if (mode === 'admin') await this.core.audit({ action: 'returns.return.request-info', actionLabel: `Asked the customer about return ${agg.ret.ref}`, target: this.target(agg), after: { question } }, by);
  }

  async reject(id: string, body: { reasonCode: string; explanation: string }, by: By, mode: Mode, agg: Agg): Promise<void> {
    if (!body.explanation?.trim()) throw invalidField('explanation', 'Explain the decision to the customer');
    this.sellerMayRespond(agg, mode);
    const now = this.core.now();
    const decision: ReturnDecision = { kind: 'rejected', reasonCode: body.reasonCode, explanation: body.explanation.trim(), decidedBy: by.actor, decidedAt: now.toISOString(), platformDecision: this.platformDecision(agg, mode) };
    await this.core.write(id, by, async (tx, a, batch) => {
      const status = returnMachine.next(a.ret.status as ReturnStatus, 'reject');
      await tx.update('returns', id, { status, decision, ...this.platformPatch(a, mode), updated_at: now });
      await this.core.timeline(tx, id, [{ kind: 'rejected', label: `Return rejected: ${REJECT_LABEL[body.reasonCode] ?? body.reasonCode}`, detail: body.explanation.trim(), visibility: 'customer', actor: by.actor }]);
      batch.push('returns.return.rejected', { returnId: id, ...this.core.refs(a.ret), ...this.core.recipient(a.ret), ownerType: a.ret.owner_type, sellerId: a.ret.seller_id, reasonCode: body.reasonCode, platformDecision: decision.platformDecision });
    });
    if (mode === 'admin') await this.core.audit({ action: 'returns.return.reject', actionLabel: `Rejected return ${agg.ret.ref}`, target: this.target(agg), before: { status: agg.ret.status }, after: { status: 'rejected', reasonCode: body.reasonCode }, reason: body.explanation }, by);
  }

  /* ---------------------------------------------------------------- platform interventions */

  async takeOver(id: string, body: { reason: 'seller_no_response' | 'seller_missed_inspection' | 'customer_disagrees' | 'refund_late' | 'other'; note: string; ownerId?: string | null }, by: By, agg: Agg): Promise<void> {
    if (!body.note?.trim()) throw invalidField('note', 'Say why Marketly takes over');
    if (agg.ret.owner_type !== 'seller') throw illegal('Marketly already handles Official Store returns', { from: agg.ret.status });
    if (!is(['requested', 'info_requested', 'approved', 'in_transit', 'received', 'awaiting_remedy', 'rejected'], agg.ret.status)) throw illegal('This return is closed', { from: agg.ret.status });
    const now = this.core.now();
    const ownerId = body.ownerId ?? (by.actor.kind === 'staff' ? (by.actor.id ?? null) : null);
    await this.core.write(id, by, async (tx, a, batch) => {
      await tx.update('returns', id, {
        platform_handling: true,
        handled_by: 'marketplace_support',
        owner_staff_id: ownerId ?? a.ret.owner_staff_id,
        escalation: a.ret.escalation ?? { at: now.toISOString(), by: by.actor, reason: body.reason, note: body.note.trim(), caseId: a.ret.case_id, caseRef: null },
        updated_at: now,
      });
      await this.core.timeline(tx, id, [
        { kind: 'taken_over', label: 'Marketly support is handling your return', visibility: 'customer', actor: by.actor },
        { kind: 'taken_over', label: 'Marketly took over this return', detail: body.note.trim(), visibility: 'seller', actor: by.actor },
      ]);
      if (!a.ret.platform_handling) batch.push('returns.return.escalated', { returnId: id, ...this.core.refs(a.ret), ownerType: a.ret.owner_type, sellerId: a.ret.seller_id, reason: body.reason, by: by.actor });
    });
    await this.core.audit({ action: 'returns.return.take-over', actionLabel: `Took over return ${agg.ret.ref}`, target: this.target(agg), before: { platformHandling: agg.ret.platform_handling }, after: { platformHandling: true, ownerId }, reason: body.note }, by);
  }

  async overturn(id: string, body: { withoutReturn: boolean; reason: string; labelMethod?: LabelMethod | null }, by: By, agg: Agg): Promise<void> {
    if (!body.reason?.trim()) throw invalidField('reason', 'Say why the rejection is overturned');
    const r = agg.ret;
    const event = body.withoutReturn ? 'overturnWithoutReturn' : 'overturn';
    returnMachine.next(r.status as ReturnStatus, event);
    const now = this.core.now();
    const decision: ReturnDecision = { kind: 'overturned', reasonCode: null, explanation: body.reason.trim(), decidedBy: by.actor, decidedAt: now.toISOString(), platformDecision: true };
    if (body.withoutReturn) {
      await this.core.write(id, by, async (tx, a, batch) => {
        const status = returnMachine.next(a.ret.status as ReturnStatus, 'overturnWithoutReturn');
        await tx.update('returns', id, {
          status,
          decision,
          platform_handling: a.ret.owner_type === 'seller' ? true : a.ret.platform_handling,
          handled_by: a.ret.owner_type === 'seller' ? 'marketplace_support' : a.ret.handled_by,
          exception: { reasonCode: 'other', details: body.reason.trim(), proposedBy: by.actor, proposedAt: now.toISOString(), approvedBy: by.actor, approvedAt: now.toISOString(), stockOutcome: 'write_off' },
          updated_at: now,
        });
        await this.core.timeline(tx, id, [{ kind: 'overturned', label: "Marketly approved your return. You don't need to send the item back.", detail: body.reason.trim(), visibility: 'customer', actor: by.actor }]);
        batch.push('returns.return.approved', this.core.approvedEvent(a, { withoutReturn: true, platformDecision: true }));
      });
    } else {
      const method = body.labelMethod ?? 'prepaid_qr';
      if (method === 'customer_arranged' && isFault(r.reason)) throw this.core.error('SHIPPING_PAYER_NOT_ALLOWED', 'Customers never pay return shipping for damaged, wrong or defective items', { reason: r.reason });
      const { row, labelId } = await this.issue(agg, method, null, by);
      try {
        await this.core.write(id, by, async (tx, a, batch) => {
          const status = returnMachine.next(a.ret.status as ReturnStatus, 'overturn');
          await tx.update('returns', id, {
            status,
            decision,
            platform_handling: a.ret.owner_type === 'seller' ? true : a.ret.platform_handling,
            handled_by: a.ret.owner_type === 'seller' ? 'marketplace_support' : a.ret.handled_by,
            shipping_paid_by: row.paid_by,
            updated_at: now,
          });
          await tx.insert('return_shipments', row);
          await this.core.timeline(tx, id, [{ kind: 'overturned', label: 'Marketly approved your return', detail: `Drop off by ${shortDate(row.drop_off_by!, this.core.tz)}`, visibility: 'customer', actor: by.actor }]);
          batch.push('returns.return.approved', this.core.approvedEvent(a, { withoutReturn: false, platformDecision: true, shipment: row }));
          if (labelId && row.cost !== null) batch.push('returns.label.created', { returnId: id, ...this.core.refs(a.ret), ...this.core.recipient(a.ret), ownerType: a.ret.owner_type, sellerId: a.ret.seller_id, labelId, cost: { amount: row.cost, currency: this.core.currency }, paidBy: row.paid_by as 'seller' | 'customer' | 'platform' });
        });
      } catch (err) {
        await this.voidLabel(labelId, 'The return could not be approved');
        throw err;
      }
    }
    await this.core.audit({ action: 'returns.return.overturn', actionLabel: `Overturned the rejection of return ${r.ref}`, target: this.target(agg), before: { status: r.status, decision: r.decision }, after: { status: body.withoutReturn ? 'awaiting_remedy' : 'approved' }, reason: body.reason }, by);
  }

  async assign(id: string, body: { ownerId: string; note?: string | null }, by: By, agg: Agg): Promise<void> {
    const ref = await this.core.soft('access', 'staff ref', (a) => a.getStaffRef(body.ownerId));
    const name = (ref as { name?: string } | undefined)?.name ?? null;
    await this.core.write(id, by, async (tx) => {
      await tx.update('returns', id, { owner_staff_id: body.ownerId, updated_at: this.core.now() });
      await this.core.timeline(tx, id, [{ kind: 'assigned', label: `Assigned to ${name ?? 'a staff member'}`, detail: body.note ?? null, visibility: 'staff', actor: by.actor }]);
    });
    await this.core.audit({ action: 'returns.return.assign', actionLabel: `Assigned return ${agg.ret.ref}`, target: this.target(agg), before: { ownerId: agg.ret.owner_staff_id }, after: { ownerId: body.ownerId }, reason: body.note ?? null }, by);
  }

  /* ---------------------------------------------------------------- refund without return */

  /**
   * Seller: approved by the seller at once (its earnings fund it) and the refund handed to payments.
   * Staff: proposed; the refund request goes to Finance and the exception is approved with it.
   */
  async approveWithoutReturn(id: string, input: ExceptionInput, by: By, mode: 'seller' | 'admin', agg: Agg): Promise<void> {
    const r = agg.ret;
    if (!input.details?.trim()) throw invalidField('details', 'Record why the item does not come back');
    if (mode === 'seller') this.core.sellerMayAct(r);
    if (mode === 'seller' && r.platform_handling) throw illegal('Marketly is handling this return now', { from: r.status });
    // retry after a hand-over that did not go through (idempotent endpoint)
    if (r.status === 'awaiting_remedy' && r.exception) {
      const rr = agg.refunds.find((x) => is(LIVE_REFUND, x.status));
      if (rr) {
        if (mode === 'seller' && rr.status === 'requested') await this.refunds.approveAndHandOver(rr.id, by.actor, by);
        return;
      }
    }
    const event = r.status === 'requested' ? 'approveWithoutReturn' : 'waiveReturn';
    returnMachine.next(r.status as ReturnStatus, event);
    const refundKinds = ['full_refund', 'partial_refund', 'store_credit'];
    const isRefund = refundKinds.includes(input.remedy.kind);
    if (!isRefund && !['replacement', 'exchange'].includes(input.remedy.kind)) throw invalidField('remedy.kind', 'Choose a remedy');
    const plan = isRefund ? await this.refunds.plan(agg, input.remedy) : null;
    if (!isRefund) await this.handling.checkReplacement(agg, input.remedy);
    const ref = plan ? await this.core.refundRef() : null;
    const now = this.core.now();
    const approvedNow = mode === 'seller' || !isRefund;
    const exception = { reasonCode: input.reasonCode, details: input.details.trim(), proposedBy: by.actor, proposedAt: now.toISOString(), approvedBy: approvedNow ? by.actor : null, approvedAt: approvedNow ? now.toISOString() : null, stockOutcome: 'write_off' };
    const decision: ReturnDecision = { kind: 'approved_without_return', reasonCode: input.reasonCode, explanation: input.remedy.explanation ?? null, decidedBy: by.actor, decidedAt: now.toISOString(), platformDecision: this.platformDecision(agg, mode) };
    const shipment = this.core.shipmentOf(agg);
    const labelToVoid = shipment && shipment.status === 'label_issued' && shipment.method !== 'customer_arranged' ? (shipment.label_id ?? shipment.id) : null;
    const rrId = await this.core.write(id, by, async (tx, a, batch) => {
      const status = returnMachine.next(a.ret.status as ReturnStatus, event);
      await tx.update('returns', id, { status, decision, exception, ...(mode === 'admin' ? this.platformPatch(a, 'admin') : {}), updated_at: now });
      const sh = this.core.shipmentOf(a);
      if (sh && sh.status === 'label_issued') await tx.update('return_shipments', sh.id, { status: returnShipmentMachine.next('label_issued', 'expire') });
      await this.core.timeline(tx, id, [
        { kind: 'approved_without_return', label: "Approved without return: you don't need to send the item back", visibility: 'customer', actor: by.actor },
        { kind: mode === 'seller' ? 'exception_approved' : 'exception_proposed', label: mode === 'seller' ? 'Refund without return recorded' : 'Refund without return proposed', detail: `${input.reasonCode.replace(/_/g, ' ')}: ${input.details.trim()}`, visibility: 'staff', actor: by.actor },
      ]);
      let rr = null;
      if (plan) rr = await this.refunds.insertForReturn(tx, a, plan, { source: mode === 'seller' ? 'seller' : 'return', status: mode === 'seller' ? 'requested' : 'under_review', by, reasonCode: input.reasonCode, reason: input.details.trim(), ref: ref! });
      if (mode === 'seller') {
        batch.push('returns.return.approved', this.core.approvedEvent(a, { withoutReturn: true, platformDecision: false }));
        batch.push('returns.exception.approved', { returnId: id, reasonCode: input.reasonCode, approvedBy: by.actor });
      } else {
        batch.push('returns.exception.proposed', { returnId: id, reasonCode: input.reasonCode });
        if (rr) batch.push('returns.refund.requested', { refundRequestId: rr.id, orderId: rr.order_id, total: { amount: rr.total, currency: rr.currency }, source: rr.source });
        else batch.push('returns.exception.approved', { returnId: id, reasonCode: input.reasonCode, approvedBy: by.actor });
      }
      return rr?.id ?? null;
    });
    await this.voidLabel(labelToVoid, 'Refund without return');
    if (mode === 'admin') {
      await this.core.audit(
        { action: 'returns.return.approve-without-return', actionLabel: `Proposed refund without return for ${r.ref}`, target: this.target(agg), before: { status: r.status }, after: { status: 'awaiting_remedy', reasonCode: input.reasonCode, remedy: input.remedy }, reason: input.details },
        by,
      );
    }
    if (!isRefund) {
      const fresh = (await this.core.load(id))!;
      await this.handling.createReplacement(fresh, input.remedy, by);
      return;
    }
    if (mode === 'seller' && rrId) await this.refunds.approveAndHandOver(rrId, by.actor, by);
  }
}
