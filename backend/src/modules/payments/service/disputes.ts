/**
 * Chargebacks and payment disputes: opened by the provider (webhook), worked by Finance staff (owner, evidence,
 * concession within their limit, approval above it), decided by the provider or by the evidence deadline.
 * finance holds the seller amount on payments.chargeback.opened and applies or releases it on decided.
 */
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { Dispute } from '../../../spec/payments.js';
import { paymentDisputeMachine } from '../domain/state-machines.js';
import { HOUR, disputePrefix, fmt } from '../domain/rules.js';
import { ProviderError, type DisputeRec, type PaymentsRepository, type StoredEvidence } from '../ports.js';
import { Batch, PROVIDER_ACTOR, SYSTEM, illegal, invalid, notFound, type By, type Core } from './core.js';
import type { Views } from './views.js';

const ACCEPT_ACTION = 'payments.disputes.accept';
type DEv = Parameters<typeof paymentDisputeMachine.next>[1];

export interface DisputeOpened {
  caseId: string;
  paymentRef: string;
  kind?: string | null;
  amount?: number | null;
  currency?: string | null;
  reasonCode?: string | null;
  reason?: string | null;
  evidenceDueBy?: string | null;
}

export class Disputes {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
  ) {}

  private get repo() {
    return this.core.repo;
  }

  async get(disputeId: string): Promise<DisputeRec> {
    const d = await this.repo.get('disputes', disputeId);
    if (!d) throw notFound('Dispute');
    return d;
  }

  toApi = async (d: DisputeRec): Promise<Dispute> => this.views.dispute(d, this.core.lookup());

  private entry(label: string, detail: string | null, actor: common.Actor): common.TimelineEvent {
    return { at: this.core.now().toISOString(), label, detail, actor };
  }

  /** One transition with a history entry; events collected in the batch */
  private async transition(tx: PaymentsRepository, d: DisputeRec, event: DEv, o: { label: string; detail?: string | null; actor: common.Actor; evidence?: Partial<StoredEvidence> }, batch: Batch): Promise<DisputeRec> {
    const to = paymentDisputeMachine.next(d.status as never, event);
    const decided = to === 'won' || to === 'lost';
    const evidence: StoredEvidence = { ...d.evidence, ...o.evidence, history: [...(d.evidence.history ?? []), this.entry(o.label, o.detail ?? null, o.actor)], ...(decided ? { pendingConcession: null } : {}) };
    const updated = await tx.update('disputes', d.id, { status: to, evidence, ...(decided ? { decided_at: this.core.now() } : {}) });
    batch.push('payments.chargeback.status_changed', { disputeId: d.id, status: to });
    if (decided) batch.push('payments.chargeback.decided', { disputeId: d.id, orderId: d.order_id, sellerId: d.seller_id, outcome: to, amount: { amount: d.amount, currency: d.currency } });
    return updated;
  }

  /* ---------------------------------------------------------------- provider side */

  /** dispute.created: one case per (provider, case id); the seller group is the one whose share matches the amount */
  async open(provider: string, o: DisputeOpened): Promise<'opened' | 'known' | 'unknown_payment' | 'no_order'> {
    const intent = (await this.repo.find('intents', { provider, provider_ref: o.paymentRef }))[0];
    if (!intent) return 'unknown_payment';
    if (!intent.order_id) return 'no_order';
    const known = (await this.repo.find('disputes', { provider, provider_case_id: o.caseId }))[0];
    if (known) return 'known';
    const kind = o.kind === 'inquiry' || o.kind === 'wallet_dispute' ? o.kind : 'chargeback';
    const amount = Number.isSafeInteger(o.amount) && o.amount! > 0 ? o.amount! : intent.captured_amount || intent.amount;
    const allocations = await this.repo.find('allocations', { intent_id: intent.id });
    const group = allocations.length === 1 ? allocations[0] : allocations.find((a) => a.amount === amount);
    const due = o.evidenceDueBy ? new Date(o.evidenceDueBy) : null;
    const ref = await this.core.nextRef(disputePrefix(kind) as 'CB' | 'DP');
    const now = this.core.now();
    const row: DisputeRec = {
      id: newId(),
      ref,
      kind,
      provider,
      provider_case_id: o.caseId,
      intent_id: intent.id,
      order_id: intent.order_id,
      group_id: group?.group_id ?? null,
      seller_id: group?.seller_id ?? null,
      reason_code: o.reasonCode ?? 'unknown',
      reason: o.reason ?? 'Dispute opened by the card issuer',
      amount,
      currency: o.currency ?? intent.currency,
      evidence_due_at: due && !Number.isNaN(due.getTime()) ? due : null,
      status: paymentDisputeMachine.initial,
      evidence: { text: null, fileIds: [], files: [], submittedAt: null, submittedBy: null, history: [this.entry(kind === 'chargeback' ? 'Chargeback opened' : 'Dispute opened', `${o.reason ?? 'Opened by the card issuer'} · ${fmt({ amount, currency: o.currency ?? intent.currency })}`, PROVIDER_ACTOR)] },
      owner_staff_id: null,
      opened_at: now,
      decided_at: null,
    };
    const inserted = await this.insertDispute(row);
    if (!inserted) return 'known';
    const who = await this.core.contactOf(intent);
    this.core.publish(
      'payments.chargeback.opened',
      { disputeId: row.id, ref: row.ref, kind, orderId: row.order_id, ...who, groupId: row.group_id, sellerId: row.seller_id, amount: { amount, currency: row.currency }, evidenceDueAt: row.evidence_due_at?.toISOString() ?? null },
      { actor: PROVIDER_ACTOR },
    );
    return 'opened';
  }

  private async insertDispute(row: DisputeRec): Promise<DisputeRec | null> {
    try {
      return await this.repo.insert('disputes', row);
    } catch (err) {
      if ((await this.repo.find('disputes', { provider: row.provider, provider_case_id: row.provider_case_id }))[0]) return null;
      throw err;
    }
  }

  /** dispute.updated / dispute.closed: the provider moves the case */
  async providerUpdate(provider: string, caseId: string, o: { status?: string | null; outcome?: string | null }): Promise<'applied' | 'unknown_case' | 'ignored'> {
    const d0 = (await this.repo.find('disputes', { provider, provider_case_id: caseId }))[0];
    if (!d0) return 'unknown_case';
    const batch = new Batch();
    const result = await this.repo.transaction(async (tx) => {
      const d = (await tx.get('disputes', d0.id, { forUpdate: true }))!;
      if (o.outcome === 'won' || o.outcome === 'lost') {
        if (d.status === 'won' || d.status === 'lost') return 'ignored';
        const event: DEv = d.status === 'opened' ? (o.outcome === 'won' ? 'provider_closes' : 'deadline_passed') : o.outcome === 'won' ? 'win' : 'lose';
        await this.transition(tx, d, event, { label: o.outcome === 'won' ? 'Dispute won' : 'Dispute lost', detail: 'Decided by the card issuer', actor: PROVIDER_ACTOR }, batch);
        return 'applied';
      }
      if (o.status === 'under_review' && d.status === 'opened') {
        await this.transition(tx, d, 'submit_evidence', { label: 'Under review by the issuer', actor: PROVIDER_ACTOR }, batch);
        return 'applied';
      }
      return 'ignored';
    });
    this.core.flush(batch, { actor: PROVIDER_ACTOR });
    return result;
  }

  /* ---------------------------------------------------------------- staff */

  async list(q: { status?: string; kind?: string; sellerId?: string }, page: PageRequest): Promise<common.Page<Dispute>> {
    const res = await this.repo.listDisputes(q, page);
    const lookup = this.core.lookup();
    return { ...res, items: await Promise.all(res.items.map((d) => this.views.dispute(d, lookup))) };
  }

  async listForOrder(orderId: string): Promise<Dispute[]> {
    const rows = await this.repo.find('disputes', { order_id: orderId }, { orderBy: [['opened_at', 'desc']] });
    const lookup = this.core.lookup();
    return Promise.all(rows.map((d) => this.views.dispute(d, lookup)));
  }

  async assign(disputeId: string, ownerStaffId: string, by: By): Promise<Dispute> {
    const before = await this.get(disputeId);
    const access = this.core.ctx.tryUse('access');
    const staff = access ? await access.getStaffRef(ownerStaffId).catch(() => null) : null;
    if (access && !staff) throw invalid([{ path: 'ownerStaffId', message: 'Choose a staff member' }]);
    const after = await this.repo.transaction(async (tx) => {
      const d = (await tx.get('disputes', disputeId, { forUpdate: true }))!;
      return tx.update('disputes', d.id, { owner_staff_id: ownerStaffId, evidence: { ...d.evidence, history: [...d.evidence.history, this.entry('Owner set', staff?.name ?? null, by.actor)] } });
    });
    await this.core.audit({ action: 'payments.dispute.assign', actionLabel: 'Set the dispute owner', category: 'financial', target: this.target(before), before: { ownerStaffId: before.owner_staff_id }, after: { ownerStaffId } }, by);
    return this.toApi(after);
  }

  private target(d: DisputeRec) {
    return { type: 'dispute', id: d.id, ref: d.ref, label: d.reason, sellerId: d.seller_id, screen: 'admin/finance' };
  }

  async evidence(disputeId: string, body: { text: string; fileIds?: string[] | null; submit: boolean }, by: By): Promise<Dispute> {
    const d0 = await this.get(disputeId);
    if (d0.status !== 'opened') {
      if (body.submit) paymentDisputeMachine.next(d0.status as never, 'submit_evidence');
      throw illegal('Evidence can be changed only while the dispute is open', { status: d0.status });
    }
    if (d0.evidence_due_at && d0.evidence_due_at.getTime() < this.core.now().getTime()) throw this.core.error('EVIDENCE_WINDOW_CLOSED');
    const text = body.text?.trim() ?? '';
    if (body.submit && !text && !(body.fileIds?.length || d0.evidence.fileIds.length)) throw invalid([{ path: 'text', message: 'Add evidence before submitting' }]);
    const fileIds = body.fileIds ?? d0.evidence.fileIds;
    let files = d0.evidence.files ?? [];
    if (body.fileIds) {
      if (fileIds.length) {
        const media = this.core.ctx.tryUse('media');
        if (!media) throw invalid([{ path: 'fileIds', message: 'Evidence files are not available right now' }]);
        files = await media.refs(fileIds);
        if (files.length !== fileIds.length) throw invalid([{ path: 'fileIds', message: 'Some files were not found' }]);
      } else files = [];
    }
    if (body.submit) {
      try {
        // provider_calls has no dispute operation in the spec: dispute calls show in the case history
        await this.core.provider.submitDisputeEvidence({ caseId: d0.provider_case_id, text, fileUrls: files.map((f) => f.url) });
      } catch (err) {
        if (err instanceof ProviderError) throw this.core.error('PROVIDER_UNAVAILABLE');
        throw err;
      }
    }
    const batch = new Batch();
    const after = await this.repo.transaction(async (tx) => {
      const d = (await tx.get('disputes', disputeId, { forUpdate: true }))!;
      if (d.status !== 'opened') throw illegal('Evidence can be changed only while the dispute is open', { status: d.status });
      const evidence: Partial<StoredEvidence> = { text, fileIds, files };
      if (!body.submit) return tx.update('disputes', d.id, { evidence: { ...d.evidence, ...evidence, history: [...d.evidence.history, this.entry('Evidence saved', null, by.actor)] } });
      return this.transition(tx, d, 'submit_evidence', { label: 'Evidence submitted', detail: `${files.length} file${files.length === 1 ? '' : 's'}`, actor: by.actor, evidence: { ...evidence, submittedAt: this.core.now().toISOString(), submittedBy: by.actor } }, batch);
    });
    this.core.flush(batch, by);
    await this.core.audit({ action: body.submit ? 'payments.dispute.submit_evidence' : 'payments.dispute.save_evidence', actionLabel: body.submit ? 'Submitted dispute evidence' : 'Saved dispute evidence', category: 'financial', target: this.target(d0), after: { text, fileIds, status: after.status } }, by);
    return this.toApi(after);
  }

  /** Concede: within the staff member's dispute limit now, above it after a Finance approval */
  async accept(disputeId: string, reason: string, by: By): Promise<Dispute> {
    if (!reason?.trim()) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
    const d = await this.get(disputeId);
    paymentDisputeMachine.next(d.status as never, 'accept'); // ILLEGAL_TRANSITION unless opened
    const access = this.core.ctx.tryUse('access');
    const amount = { amount: d.amount, currency: d.currency };
    const check = access && by.principal ? await access.check(by.principal as never, ACCEPT_ACTION, { money: amount }) : null;
    if (check?.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'Your role cannot concede disputes');
    if (check?.decision === 'approval_required') {
      if (d.evidence.pendingConcession) throw new AppError('APPROVAL_REQUIRED', 'A concession of this dispute is already waiting for approval', { approvalRequestId: d.evidence.pendingConcession.approvalRequestId });
      const request = await access!.requestApproval({
        action: ACCEPT_ACTION,
        target: { type: 'payment_dispute', id: d.id, ref: d.ref, label: d.reason, sellerId: d.seller_id, screen: 'admin/finance' },
        amount,
        summary: `Accept ${d.kind} ${d.ref} of ${fmt(amount)}`,
        details: { disputeId: d.id, orderId: d.order_id, reasonCode: d.reason_code },
        reason: reason.trim(),
        requestedBy: by.principal as never,
      });
      await this.repo.transaction(async (tx) => {
        const x = (await tx.get('disputes', d.id, { forUpdate: true }))!;
        await tx.update('disputes', x.id, {
          evidence: { ...x.evidence, pendingConcession: { approvalRequestId: request.id, reason: reason.trim(), requestedBy: by.actor, at: this.core.now().toISOString() }, history: [...x.evidence.history, this.entry('Concession sent for approval', reason.trim(), by.actor)] },
        });
      });
      await this.core.audit({ action: 'payments.dispute.accept_request', actionLabel: 'Asked to concede a dispute', category: 'financial', target: this.target(d), reason, approvalRequestId: request.id }, by);
      throw new AppError('APPROVAL_REQUIRED', 'Conceding this dispute needs approval above your limit. It was sent for approval.', { approvalRequestId: request.id, approval: { id: request.id, ref: request.ref, status: request.status } });
    }
    const after = await this.concede(d.id, reason.trim(), by);
    await this.core.audit({ action: 'payments.dispute.accept', actionLabel: 'Conceded a dispute', category: 'financial', target: this.target(d), reason, before: { status: d.status }, after: { status: after.status }, approvalNote: check?.reason ?? null }, by);
    return this.toApi(after);
  }

  private async concede(disputeId: string, reason: string, by: By): Promise<DisputeRec> {
    const d0 = await this.get(disputeId);
    if (d0.status !== 'opened') return d0;
    try {
      await this.core.provider.acceptDispute({ caseId: d0.provider_case_id });
    } catch (err) {
      if (err instanceof ProviderError) throw this.core.error('PROVIDER_UNAVAILABLE');
      throw err;
    }
    const batch = new Batch();
    const after = await this.repo.transaction(async (tx) => {
      const d = (await tx.get('disputes', disputeId, { forUpdate: true }))!;
      if (d.status !== 'opened') return d;
      return this.transition(tx, d, 'accept', { label: 'Dispute conceded', detail: reason, actor: by.actor }, batch);
    });
    this.core.flush(batch, by);
    return after;
  }

  /** access.approval.decided for a concession: approved → concede now; otherwise the case stays open */
  async onApprovalDecided(e: { actionKey: string; target: { type: string; id: string }; outcome: string; requestId: string; decidedBy?: common.Actor | null; reason?: string | null }) {
    if (e.actionKey !== ACCEPT_ACTION || e.target.type !== 'payment_dispute') return;
    const d = await this.repo.get('disputes', e.target.id);
    if (!d || d.evidence.pendingConcession?.approvalRequestId !== e.requestId) return;
    const actor = e.decidedBy ?? SYSTEM;
    if (e.outcome === 'approved' && d.status === 'opened') {
      const reason = d.evidence.pendingConcession.reason;
      try {
        const after = await this.concede(d.id, reason, { actor });
        await this.core.audit({ action: 'payments.dispute.accept', actionLabel: 'Conceded a dispute after approval', category: 'financial', target: this.target(d), reason, approvalRequestId: e.requestId, before: { status: d.status }, after: { status: after.status } }, { actor });
      } catch (err) {
        this.core.ctx.log.warn({ err, disputeId: d.id }, 'payments: approved concession could not be sent; staff can accept again');
        await this.clearPending(d.id, 'Approved concession could not reach the provider; accept again', actor);
      }
      return;
    }
    await this.clearPending(d.id, e.outcome === 'approved' ? 'Concession approved after the case closed' : `Concession ${e.outcome}${e.reason ? `: ${e.reason}` : ''}`, actor);
  }

  private async clearPending(disputeId: string, label: string, actor: common.Actor) {
    await this.repo.transaction(async (tx) => {
      const x = (await tx.get('disputes', disputeId, { forUpdate: true }))!;
      await tx.update('disputes', x.id, { evidence: { ...x.evidence, pendingConcession: null, history: [...x.evidence.history, this.entry(label, null, actor)] } });
    });
  }

  /** payments.dispute-deadlines: flag due within 48 h once; lost when the deadline passed without evidence */
  async deadlines(): Promise<void> {
    const now = this.core.now();
    const open = await this.repo.find('disputes', { status: 'opened', evidence_due_at: { op: '<=', value: new Date(now.getTime() + 48 * HOUR) } }, { orderBy: [['evidence_due_at', 'asc']], limit: 100 });
    for (const d0 of open) {
      const batch = new Batch();
      await this.repo.transaction(async (tx) => {
        const d = (await tx.get('disputes', d0.id, { forUpdate: true }))!;
        if (d.status !== 'opened' || !d.evidence_due_at) return;
        if (d.evidence_due_at.getTime() < now.getTime()) {
          await this.transition(tx, d, 'deadline_passed', { label: 'Evidence deadline passed', detail: 'No evidence was submitted in time', actor: SYSTEM }, batch);
        } else if (!d.evidence.dueSoonFlagged) {
          await tx.update('disputes', d.id, { evidence: { ...d.evidence, dueSoonFlagged: true, history: [...d.evidence.history, this.entry('Evidence due within 48 hours', null, SYSTEM)] } });
        }
      });
      this.core.flush(batch, { actor: SYSTEM });
    }
  }
}
