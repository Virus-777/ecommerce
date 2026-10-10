/**
 * Seller credits without an original charge (creditSeller): fulfillment-service reimbursements for lost or
 * damaged units, goodwill to a seller. Up to creditSecondReviewerThreshold a credit is posted at once as ledger
 * type seller_credit; above it the credit waits as pending_approval with an approval request (finance.credits.issue)
 * and is posted or rejected on access.approval.decided, publishing finance.seller_credit.decided.
 * One credit per idempotency key (seller_credits.idempotency_key is unique): the same key returns the first credit.
 */
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { Reference, SellerCredit } from '../../../spec/finance.js';
import { decodeActor, encodeActor, fmt, SYSTEM } from '../domain/rules.js';
import { sellerCreditMachine } from '../domain/state-machines.js';
import { toEntry } from '../mappers.js';
import type { FinanceRepository, SellerCreditRec } from '../ports.js';
import { invalid, notFound, Outbox, Part, type By } from './core.js';

const REFERENCE_KINDS: readonly Reference['kind'][] = ['order', 'order_item', 'return', 'refund', 'case', 'chargeback', 'payout', 'adjustment', 'ad_campaign', 'fulfillment_service', 'statement', 'seller', 'reconciliation'];
export const CREDIT_ACTION = 'finance.credits.issue';

export interface CreditSellerInput {
  sellerId: string;
  amount: common.Money;
  reason: string;
  reference: Reference;
  idempotencyKey: string;
}

export class CreditsPart extends Part {
  async view(row: SellerCreditRec, repo: FinanceRepository = this.repo): Promise<SellerCredit> {
    const entry = row.ledger_entry_id ? await repo.get('ledger_entries', row.ledger_entry_id) : undefined;
    return {
      id: row.id,
      sellerId: row.seller_id,
      amount: { amount: row.amount, currency: row.currency },
      reason: row.reason,
      reference: { kind: row.ref_kind as Reference['kind'], id: row.ref_id, ref: row.ref_label },
      status: row.status,
      ledgerEntry: entry ? toEntry(entry, new Map()) : null,
      approvalRequestId: row.approval_request_id,
      requestedBy: decodeActor(row.requested_by) ?? SYSTEM,
      createdAt: row.created_at.toISOString(),
      decidedAt: row.decided_at?.toISOString() ?? null,
    };
  }

  private entryOf(row: SellerCreditRec, recordedBy: common.Actor) {
    return {
      key: `seller_credit:${row.id}`,
      type: 'seller_credit' as const,
      amount: row.amount,
      bucket: 'available' as const,
      ref: { kind: row.ref_kind as Reference['kind'], id: row.ref_id, label: row.ref_label },
      description: `Credit from Marketly${row.ref_label ? ` (${row.ref_label})` : ''}: ${row.reason}`,
      recordedBy,
    };
  }

  /** Posts the credit's ledger entry and marks it posted, inside the caller's transaction; the row must be locked */
  private async postIn(tx: FinanceRepository, row: SellerCreditRec, out: Outbox, recordedBy: common.Actor): Promise<SellerCreditRec> {
    const [entry] = await this.core.post(tx, row.seller_id, [this.entryOf(row, recordedBy)], out);
    const posted = entry ?? (await tx.findOne('ledger_entries', { source_event_id: `seller_credit:${row.id}` }))!;
    return tx.update('seller_credits', row.id, { status: 'posted', ledger_entry_id: posted.id, decided_at: this.now() });
  }

  async creditSeller(input: CreditSellerInput): Promise<SellerCredit> {
    if (!input || !isUuid(input.sellerId)) throw notFound('Seller');
    const currency = this.core.currency();
    const issues: { path: string; message: string }[] = [];
    if (!Number.isSafeInteger(input.amount?.amount) || input.amount.amount <= 0) issues.push({ path: 'amount', message: 'Credits are positive amounts in minor units' });
    else if (input.amount.currency !== currency) issues.push({ path: 'amount.currency', message: `Seller ledgers are in ${currency}` });
    if (!input.reason?.trim()) issues.push({ path: 'reason', message: 'Give the reason for the credit' });
    if (!input.reference?.id || !REFERENCE_KINDS.includes(input.reference.kind)) issues.push({ path: 'reference', message: 'A reference to what the credit is for' });
    if (!input.idempotencyKey?.trim()) issues.push({ path: 'idempotencyKey', message: 'Required' });
    if (issues.length) throw invalid(issues);

    const known = await this.repo.findOne('seller_credits', { idempotency_key: input.idempotencyKey });
    if (known) return this.view(known);

    const threshold = await this.core.num('creditSecondReviewerThreshold', 50_000);
    const by: By = { actor: SYSTEM };
    const id = newId();
    const now = this.now();
    const row: SellerCreditRec = {
      id,
      seller_id: input.sellerId,
      amount: input.amount.amount,
      currency,
      reason: input.reason.trim(),
      ref_kind: input.reference.kind,
      ref_id: input.reference.id,
      ref_label: input.reference.ref ?? null,
      status: 'posted',
      idempotency_key: input.idempotencyKey,
      requested_by: encodeActor(SYSTEM)!,
      approval_request_id: null,
      ledger_entry_id: null,
      created_at: now,
      decided_at: null,
    };

    if (input.amount.amount <= threshold) {
      const out = new Outbox();
      const saved = await this.repo.transaction(async (tx) => {
        if (!(await tx.insertIgnore('seller_credits', row))) return null; // the same key won a race
        return this.postIn(tx, row, out, SYSTEM);
      });
      this.core.flush(out, by);
      if (!saved) return this.view((await this.repo.findOne('seller_credits', { idempotency_key: input.idempotencyKey }))!);
      await this.audited(saved, 'finance.seller_credit.post', 'Credited a seller', by);
      return this.view(saved);
    }

    // above the threshold: a Finance reviewer approves it (the caller is a module, so the setting is the limit)
    const sellerName = await this.core.sellerName(input.sellerId);
    const label = `Credit ${fmt(row.amount, currency)} to ${sellerName}`;
    const req = await this.core.requestApproval(by, {
      action: CREDIT_ACTION,
      target: { type: 'seller_credit', id, ref: row.ref_label, label, sellerId: input.sellerId, screen: 'admin/seller' },
      amount: { amount: row.amount, currency },
      summary: `${label}${row.ref_label ? ` for ${row.ref_label}` : ''} (${row.ref_kind.replace(/_/g, ' ')})`,
      details: { reference: input.reference, idempotencyKey: input.idempotencyKey },
      reason: row.reason,
    });
    const pending: SellerCreditRec = { ...row, status: sellerCreditMachine.initial as SellerCreditRec['status'], approval_request_id: req.id };
    if (!(await this.repo.insertIgnore('seller_credits', pending))) {
      // the same key won a race: withdraw this request, answer with the first credit
      await this.core.optionalDep(() => this.ctx.use('access').cancelApproval(req.id, SYSTEM, 'Duplicate seller credit request'));
      return this.view((await this.repo.findOne('seller_credits', { idempotency_key: input.idempotencyKey }))!);
    }
    await this.audited(pending, 'finance.seller_credit.request', 'Requested approval for a seller credit', by, req.id);
    return this.view(pending);
  }

  private async find(by: { creditId?: string; idempotencyKey?: string }): Promise<SellerCreditRec | undefined> {
    if (by?.creditId) return isUuid(by.creditId) ? this.repo.get('seller_credits', by.creditId) : undefined;
    if (by?.idempotencyKey) return this.repo.findOne('seller_credits', { idempotency_key: by.idempotencyKey });
    throw invalid([{ path: 'creditId', message: 'Give the credit id or the idempotency key used with creditSeller' }]);
  }

  /** getSellerCredit: the credit's current state, by id or by the caller's idempotency key; null when unknown */
  async getSellerCredit(by: { creditId?: string; idempotencyKey?: string }): Promise<SellerCredit | null> {
    const row = await this.find(by);
    return row ? this.view(row) : null;
  }

  /**
   * withdrawSellerCredit: pending_approval → withdrawn (the calling module no longer needs it); its approval request
   * is cancelled through access and nothing is posted. Posted or rejected credits are ILLEGAL_TRANSITION; a
   * withdrawn credit is returned unchanged. An approval decided afterwards finds the credit withdrawn and posts nothing.
   */
  async withdrawSellerCredit(input: { creditId?: string; idempotencyKey?: string; reason: string }): Promise<SellerCredit> {
    if (!input?.reason?.trim()) throw invalid([{ path: 'reason', message: 'Give the reason for withdrawing the credit' }]);
    const row = await this.find(input);
    if (!row) throw notFound('Seller credit');
    if (row.status === 'withdrawn') return this.view(row);
    const after = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('seller_credits', row.id, { forUpdate: true }))!;
      if (locked.status === 'withdrawn') return null;
      const status = this.core.step<SellerCreditRec['status']>(sellerCreditMachine, locked.status, 'withdraw'); // posted, rejected: ILLEGAL_TRANSITION
      return tx.update('seller_credits', locked.id, { status, decided_at: this.now() });
    });
    if (!after) return this.view((await this.repo.get('seller_credits', row.id))!);
    const by: By = { actor: SYSTEM };
    if (after.approval_request_id) await this.core.optionalDep(() => this.ctx.use('access').cancelApproval(after.approval_request_id!, SYSTEM, input.reason.trim()));
    await this.audited(after, 'finance.seller_credit.withdraw', 'Seller credit withdrawn by the requesting module', by, after.approval_request_id, input.reason.trim());
    return this.view(after);
  }

  /** access.approval.decided for finance.credits.issue: post or reject the pending credit (once) */
  async onApprovalDecided(e: EventPayload<'access.approval.decided'>) {
    const row = isUuid(e.target.id) ? await this.repo.get('seller_credits', e.target.id) : undefined;
    if (!row || row.approval_request_id !== e.requestId || row.status !== 'pending_approval') return;
    const by: By = { actor: e.decidedBy ?? SYSTEM };
    const approved = e.outcome === 'approved';
    const out = new Outbox();
    const after = await this.repo.transaction(async (tx) => {
      const locked = await tx.get('seller_credits', row.id, { forUpdate: true });
      if (!locked || locked.status !== 'pending_approval' || locked.approval_request_id !== e.requestId) return null; // redelivered
      const status = this.core.step(sellerCreditMachine, locked.status, approved ? 'approve' : 'reject');
      if (status === 'posted') return this.postIn(tx, locked, out, by.actor);
      return tx.update('seller_credits', locked.id, { status: 'rejected', decided_at: this.now() });
    });
    if (!after) return;
    this.core.flush(out, by);
    this.core.publish(
      'finance.seller_credit.decided',
      { creditId: after.id, sellerId: after.seller_id, reference: { kind: after.ref_kind as Reference['kind'], id: after.ref_id, ref: after.ref_label }, idempotencyKey: after.idempotency_key, amount: { amount: after.amount, currency: after.currency }, outcome: after.status === 'posted' ? 'posted' : 'rejected', ledgerEntryId: after.ledger_entry_id },
      by,
    );
    await this.audited(after, approved ? 'finance.seller_credit.post' : 'finance.seller_credit.reject', approved ? 'Seller credit approved and posted' : `Seller credit not approved (${e.outcome})`, by, e.requestId, e.reason ?? null);
  }

  private async audited(row: SellerCreditRec, action: string, actionLabel: string, by: By, approvalRequestId: string | null = null, reason: string | null = row.reason) {
    await this.core.audit(
      {
        action,
        actionLabel,
        category: 'financial',
        target: { type: 'seller_credit', id: row.id, ref: row.ref_label, label: `Credit ${fmt(row.amount, row.currency)}`, sellerId: row.seller_id, screen: 'admin/seller' },
        after: { status: row.status, amount: row.amount, ledgerEntryId: row.ledger_entry_id },
        reason,
        approvalRequestId,
        visibleToSeller: row.status === 'posted',
      },
      by,
    );
  }
}
