/**
 * Credit staff give or take: goodwill grants (within approval limits and the per-customer 30-day limit),
 * reversal of unused goodwill, and balance corrections. Approval limits come from access; grants above the
 * caller's limit wait as pending_approval and finish on access.approval.decided.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { CreditCorrection, CustomerWalletAdmin, GoodwillGrant, GoodwillInput } from '../../../spec/wallet.js';
import { creditCorrectionMachine, goodwillGrantMachine } from '../domain/state-machines.js';
import { actorFrom, actorText, goodwillExpiry, m, SYSTEM } from '../domain/rules.js';
import { allocationsOf, toCorrection, toGrant } from '../mappers.js';
import type { AccountRow, CorrectionRow, GrantRow } from '../ports.js';
import type { WalletRepository } from '../repository.js';
import { invalid, notFound, Outbox, type By, type Issue, type WalletCore } from './core.js';
import type { Ledger } from './ledger.js';

const DAY = 86_400_000;
export const GOODWILL_ACTION = 'wallet.goodwill.grant';
export const CORRECT_ACTION = 'wallet.credit.correct';
const REASON_CODES = ['late_delivery', 'service_failure', 'price_adjustment', 'damaged_item', 'other'];

/**
 * What a correction sent for approval before pass 4 carried in its approval request (there was no table for
 * it). Newer requests carry correctionId and live in credit_corrections.
 */
interface LegacyPendingCorrection {
  customerId: string;
  amount: common.Money;
  reason: string;
  reference: string | null;
  requestedBy: common.Actor;
  key: string;
  correctionId?: string;
}

export class StaffCredit {
  constructor(
    private readonly core: WalletCore,
    private readonly ledger: Ledger,
  ) {}

  private get repo() {
    return this.core.repo;
  }

  /* ================================================================ goodwill */

  /**
   * Within the requester's goodwill limit (access) the grant is made now (pending_approval → granted in the same
   * call); above it an approval request is raised and the grant waits. The per-customer 30-day limit
   * (goodwillMaxPerCustomer30Days) counts granted and pending goodwill; above it only Finance (wallet.credit.correct)
   * may grant, still within their own limit. A pending grant is returned like any grant (REST answers 201 with
   * state pending_approval and `approval`; FORMAT.md, Approval responses).
   */
  async grant(input: GoodwillInput, by: By, key: string, o: { http?: boolean } = {}): Promise<GoodwillGrant> {
    const issues: Issue[] = [...this.core.checkMoney(input.amount, 'amount')];
    if (!input.reason?.trim()) issues.push({ path: 'reason', message: 'Give a reason' });
    if (!REASON_CODES.includes(input.reasonCode)) issues.push({ path: 'reasonCode', message: 'Choose a reason' });
    if (input.chargedTo === 'seller' && !input.sellerId) issues.push({ path: 'sellerId', message: 'Choose the seller who funds this credit' });
    if (input.expiresInDays != null && (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > 3650)) issues.push({ path: 'expiresInDays', message: 'Between 1 and 3650 days' });
    if (!key?.trim()) issues.push({ path: 'idempotencyKey', message: 'Required' });
    if (issues.length) throw invalid(issues);

    const known = await this.repo.grantByKey(key);
    if (known) return this.answer(known, o);

    const customer = await this.core.customer(input.customerId);
    if (!customer) throw notFound('Customer');
    const amount = input.amount.amount;
    const limit = (await this.core.ctx.settings.get('goodwillMaxPerCustomer30Days')) as common.Money;
    const last30 = await this.repo.goodwillSince(input.customerId, new Date(this.core.now().getTime() - 30 * DAY));
    if (last30 + amount > limit.amount && !(await this.core.hasPermission(by, CORRECT_ACTION))) {
      throw this.core.error('GOODWILL_LIMIT_EXCEEDED', `This customer can receive ${this.core.fmt(Math.max(0, limit.amount - last30))} more goodwill credit in 30 days. Finance can grant more.`, {
        goodwillLast30Days: m(last30, limit.currency),
        limit,
        remaining: m(Math.max(0, limit.amount - last30), limit.currency),
      });
    }
    const decision = await this.core.authority(by, GOODWILL_ACTION, input.amount);
    const [orderRefs, caseRefs] = await Promise.all([this.core.orderRefs([input.orderId]), this.core.caseRefs([{ caseId: input.caseId ?? null, orderId: input.orderId ?? null }])]);
    const caseRef = input.caseId ? caseRefs.get(input.caseId) : undefined;
    const orderRef = input.orderId ? orderRefs.get(input.orderId) : undefined;
    const id = newId();
    const row: GrantRow = {
      id,
      customer_id: input.customerId,
      amount,
      currency: input.amount.currency,
      reason: input.reason.trim(),
      reason_code: input.reasonCode,
      case_id: input.caseId ?? null,
      order_id: input.orderId ?? null,
      charged_to: input.chargedTo,
      seller_id: input.sellerId ?? null,
      state: goodwillGrantMachine.initial,
      approval_request_id: null,
      requested_by: actorText(by.actor),
      decided_by: null,
      ledger_entry_id: null,
      idempotency_key: key,
      created_at: this.core.now(),
    };

    if (decision.decision === 'approval_required') {
      const req = await this.core.requestApproval(by, {
        action: GOODWILL_ACTION,
        target: { type: 'goodwill_grant', id, ref: caseRef ?? orderRef ?? null, label: `Goodwill credit for ${customer.displayName}`, sellerId: input.chargedTo === 'seller' ? (input.sellerId ?? null) : null, screen: 'admin/customers' },
        amount: input.amount,
        summary: `Goodwill credit of ${this.core.fmt(amount)} for ${customer.displayName}${caseRef ? ` (case ${caseRef})` : orderRef ? ` (order ${orderRef})` : ''}`,
        details: { customerId: input.customerId, reasonCode: input.reasonCode, caseId: input.caseId ?? null, orderId: input.orderId ?? null, chargedTo: input.chargedTo, sellerId: input.sellerId ?? null, expiresInDays: input.expiresInDays ?? null },
        reason: input.reason.trim(),
      });
      const saved = (await this.repo.insertGrant({ ...row, approval_request_id: req.id })) ?? (await this.repo.grantByKey(key))!;
      await this.core.audit(
        { action: 'wallet.goodwill.request_approval', actionLabel: 'Sent goodwill credit for approval', category: 'financial', target: this.target(saved, customer.displayName), reason: saved.reason, after: { amount: input.amount, reasonCode: input.reasonCode, chargedTo: input.chargedTo }, approvalRequestId: req.id },
        by,
      );
      return this.answer(saved, o);
    }

    const out = new Outbox();
    const months = Number(await this.core.ctx.settings.get('creditExpiryMonths'));
    const saved = await this.repo.transaction(async (tx) => {
      const inserted = await tx.insertGrant(row);
      if (!inserted) return (await tx.grantByKey(key))!; // the same request, concurrently
      const acct = await tx.lockOrCreateAccount(input.customerId, input.amount.currency, this.core.now());
      return this.credit(tx, acct, inserted, by.actor, { caseRef, orderRef, months, expiresInDays: input.expiresInDays ?? null, out });
    });
    this.core.flush(out, by);
    if (saved.id === id) {
      await this.core.audit(
        { action: 'wallet.goodwill.grant', actionLabel: 'Granted goodwill credit', category: 'financial', target: this.target(saved, customer.displayName), reason: saved.reason, after: { amount: input.amount, reasonCode: input.reasonCode, chargedTo: input.chargedTo, sellerId: input.sellerId ?? null, ledgerEntryId: saved.ledger_entry_id }, approvalNote: decision.reason },
        by,
      );
    }
    return this.answer(saved, o);
  }

  /** pending_approval → granted: the lot and the ledger entry (account locked by the caller) */
  private async credit(
    tx: WalletRepository,
    acct: AccountRow,
    g: GrantRow,
    decidedBy: common.Actor,
    o: { caseRef?: string; orderRef?: string; months: number; expiresInDays: number | null; out: Outbox },
  ): Promise<GrantRow> {
    const state = goodwillGrantMachine.next(g.state as 'pending_approval', 'approve');
    const kind = g.reason_code === 'price_adjustment' ? 'price_adjustment' : 'goodwill';
    const r = await this.ledger.addCredit(tx, acct, {
      kind,
      source: kind,
      amount: g.amount,
      expiresAt: goodwillExpiry(this.core.now(), o.expiresInDays, o.months),
      reference: o.caseRef ? `case ${o.caseRef}` : o.orderRef ? `order ${o.orderRef}` : null,
      orderId: g.order_id,
      caseId: g.case_id,
      key: `goodwill:${g.id}`,
      actor: decidedBy,
      reason: g.reason,
    });
    o.out.push('wallet.credit.granted', { customerId: g.customer_id, entryId: r.entry.id, kind, amount: m(g.amount, g.currency), chargedTo: g.charged_to as 'platform' | 'seller', sellerId: g.seller_id, caseId: g.case_id, orderId: g.order_id });
    return tx.updateGrant(g.id, { state, ledger_entry_id: r.entry.id, decided_by: actorText(decidedBy) });
  }

  /** A grant waiting for approval is saved, so it is answered like any grant (state pending_approval, `approval` in the body; FORMAT.md, Approval responses) */
  private async answer(g: GrantRow, _o: { http?: boolean }): Promise<GoodwillGrant> {
    return (await this.grantViews([g]))[0]!;
  }

  private target(g: GrantRow, customerName?: string | null) {
    return { type: 'goodwill_grant', id: g.id, label: `Goodwill credit of ${this.core.fmt(g.amount, g.currency)}${customerName ? ` for ${customerName}` : ''}` };
  }

  /** granted → reversed: removes the credit only while none of it was used (or reserved, or expired) */
  async reverse(id: string, reason: string, by: By): Promise<GoodwillGrant> {
    if (!reason?.trim()) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
    const g0 = await this.repo.getGrant(id);
    if (!g0) throw notFound('Goodwill grant');
    if (g0.state !== 'granted') goodwillGrantMachine.next(g0.state as 'granted', 'reverse');
    const out = new Outbox();
    const after = await this.repo.transaction(async (tx) => {
      const acct = await tx.lockAccount(g0.customer_id);
      const g = (await tx.getGrant(id, { forUpdate: true }))!;
      const state = goodwillGrantMachine.next(g.state as 'granted', 'reverse');
      const entry = g.ledger_entry_id ? await tx.getEntry(g.ledger_entry_id) : undefined;
      const lotId = entry ? allocationsOf(entry)[0]?.lotId : undefined;
      const [lot] = lotId ? await tx.getLots([lotId], { forUpdate: true }) : [];
      if (!acct || !lot || lot.state !== 'active' || lot.remaining < lot.original) {
        const used = lot ? lot.original - lot.remaining : g.amount;
        throw this.core.error('CREDIT_ALREADY_USED', lot?.state === 'expired' ? 'This credit has expired and cannot be reversed' : `${this.core.fmt(used, g.currency)} of this credit was already used`, { used: m(used, g.currency) });
      }
      await tx.updateLot(lot.id, { remaining: 0, state: 'depleted' });
      const a = await tx.updateAccount(acct.customer_id, { available: acct.available - lot.remaining, held: acct.held, updated_at: this.core.now() });
      const rev = await tx.insertEntry({
        id: newId(),
        customer_id: a.customer_id,
        kind: 'reversal',
        amount: -lot.remaining,
        balance_after: a.available + a.held,
        lot_allocations: [{ lotId: lot.id, amount: lot.remaining }],
        order_id: g.order_id,
        refund_id: null,
        case_id: g.case_id,
        hold_id: null,
        idempotency_key: `reverse:${g.id}`,
        actor_kind: by.actor.kind,
        actor_id: by.actor.id ?? null,
        reason: reason.trim(),
        at: this.core.now(),
      });
      // finance reverses what it booked for the grant (keyed by grantEntryId) and credits a funding seller back
      out.push('wallet.credit.reversed', {
        customerId: g.customer_id,
        entryId: rev.id,
        grantId: g.id,
        grantEntryId: g.ledger_entry_id!,
        amount: m(-rev.amount, g.currency),
        chargedTo: g.charged_to as 'platform' | 'seller',
        sellerId: g.charged_to === 'seller' ? g.seller_id : null,
        caseId: g.case_id,
        orderId: g.order_id,
        reason: reason.trim(),
      });
      return tx.updateGrant(g.id, { state });
    });
    this.core.flush(out, by);
    await this.core.audit({ action: 'wallet.goodwill.reverse', actionLabel: 'Reversed goodwill credit', category: 'financial', target: this.target(after), reason: reason.trim(), before: { state: 'granted' }, after: { state: after.state } }, by);
    return (await this.grantViews([after]))[0]!;
  }

  /* ================================================================ corrections */

  /**
   * Within the caller's adjustment limit the correction is applied now (row applied with its ledger entry, in one
   * transaction). Above it the correction is saved pending_approval with its access approval request and answered
   * like any correction (REST 201 with `approval`; FORMAT.md, Approval responses); access.approval.decided applies,
   * rejects or fails it.
   */
  async correct(customerId: string, body: { amount: common.Money; reason: string; reference?: string | null }, by: By, key: string): Promise<CreditCorrection> {
    const issues = this.core.checkMoney(body.amount, 'amount', { signed: true });
    if (!body.reason?.trim()) issues.push({ path: 'reason', message: 'Give a reason' });
    if (!key?.trim()) issues.push({ path: 'idempotencyKey', message: 'Required' });
    if (issues.length) throw invalid(issues);
    const known = await this.repo.correctionByKey(key);
    if (known) return this.correctionView(known);
    const customer = await this.core.customer(customerId);
    if (!customer) throw notFound('Customer');
    const size = m(Math.abs(body.amount.amount), body.amount.currency);
    const decision = await this.core.authority(by, CORRECT_ACTION, size);
    const reference = body.reference?.trim() || null;
    const reason = body.reason.trim();
    const row: CorrectionRow = {
      id: newId(),
      customer_id: customerId,
      amount: body.amount.amount,
      currency: body.amount.currency,
      reason,
      reference,
      state: creditCorrectionMachine.initial,
      approval_request_id: null,
      requested_by: actorText(by.actor),
      decided_by: null,
      decided_at: null,
      ledger_entry_id: null,
      failure: null,
      idempotency_key: key,
      created_at: this.core.now(),
    };
    const target = { type: 'wallet_account', id: customerId, label: customer.displayName };
    if (decision.decision === 'approval_required') {
      const req = await this.core.requestApproval(by, {
        action: CORRECT_ACTION,
        target: { type: 'credit_correction', id: row.id, ref: reference, label: `Store credit correction for ${customer.displayName}`, screen: 'admin/customers' },
        amount: size,
        summary: `Store credit correction of ${body.amount.amount > 0 ? '+' : '−'}${this.core.fmt(size.amount)} for ${customer.displayName}`,
        details: { customerId, correctionId: row.id, amount: body.amount, reference },
        reason,
      });
      const saved = (await this.repo.insertCorrection({ ...row, approval_request_id: req.id })) ?? (await this.repo.correctionByKey(key))!;
      if (saved.id === row.id) {
        await this.core.audit(
          { action: 'wallet.credit.request_correction', actionLabel: 'Sent a store credit correction for approval', category: 'financial', target, reason, after: { amount: body.amount, reference, correctionId: saved.id }, approvalRequestId: req.id },
          by,
        );
      }
      return this.correctionView(saved);
    }
    let saved: CorrectionRow | undefined;
    const entry = await this.ledger.applyCorrection(customerId, body.amount, reason, reference, `correction:${key}`, by, async (tx, e) => {
      const state = creditCorrectionMachine.next('pending_approval', 'apply');
      saved = (await tx.insertCorrection({ ...row, state, ledger_entry_id: e.id, decided_by: actorText(by.actor), decided_at: this.core.now() })) ?? (await tx.correctionByKey(key))!;
    });
    if (saved?.id === row.id) {
      await this.core.audit(
        { action: 'wallet.credit.correct', actionLabel: 'Corrected store credit', category: 'financial', target, reason, after: { amount: body.amount, reference, entryId: entry.id, balanceAfter: entry.balance_after, correctionId: row.id }, approvalNote: decision.reason },
        by,
      );
    }
    return this.correctionView(saved!);
  }

  async correctionView(c: CorrectionRow): Promise<CreditCorrection> {
    return (await this.correctionViews([c]))[0]!;
  }

  async correctionViews(rows: readonly CorrectionRow[]): Promise<CreditCorrection[]> {
    if (!rows.length) return [];
    const [approvals, entries] = await Promise.all([
      this.core.approvalInfos(rows.map((r) => r.approval_request_id)),
      this.repo.getEntries(rows.map((r) => r.ledger_entry_id).filter((x): x is string => Boolean(x))),
    ]);
    const views = new Map((await Promise.all(entries.map((e) => this.ledger.entryView(e)))).map((v) => [v.id, v]));
    return rows.map((c) => toCorrection(c, { approvals, entries: views }));
  }

  /* ================================================================ approvals decided (access) */

  async onApprovalDecided(e: EventPayload<'access.approval.decided'>, giftCards: { onApprovalDecided(e: EventPayload<'access.approval.decided'>): Promise<void> }) {
    if (e.module !== 'wallet') return;
    if (e.actionKey === GOODWILL_ACTION) return this.goodwillDecided(e);
    if (e.actionKey === CORRECT_ACTION) return this.correctionDecided(e);
    return giftCards.onApprovalDecided(e);
  }

  private async goodwillDecided(e: EventPayload<'access.approval.decided'>) {
    const g0 = (await this.repo.grantByApproval(e.requestId)) ?? (e.target.type === 'goodwill_grant' ? await this.repo.getGrant(e.target.id) : undefined);
    if (!g0 || g0.state !== 'pending_approval') return void this.core.ctx.log.info({ requestId: e.requestId }, 'wallet: approval for no pending goodwill grant');
    const decider: common.Actor = e.decidedBy ?? SYSTEM;
    const by: By = { actor: decider };
    if (e.outcome !== 'approved') {
      const after = await this.repo.transaction(async (tx) => {
        const g = (await tx.getGrant(g0.id, { forUpdate: true }))!;
        if (g.state !== 'pending_approval') return null;
        return tx.updateGrant(g.id, { state: goodwillGrantMachine.next('pending_approval', 'reject'), decided_by: actorText(decider) });
      });
      if (after) {
        this.decided(after, 'rejected', by);
        await this.core.audit({ action: 'wallet.goodwill.reject', actionLabel: 'Goodwill credit not approved', category: 'financial', target: this.target(after), reason: e.reason ?? `Approval ${e.outcome}`, approvalRequestId: e.requestId }, by);
      }
      return;
    }
    const [orderRefs, caseRefs] = await Promise.all([this.core.orderRefs([g0.order_id]), this.core.caseRefs([{ caseId: g0.case_id, orderId: g0.order_id }])]);
    const months = Number(await this.core.ctx.settings.get('creditExpiryMonths'));
    const details = (await this.core.soft('access.getApproval', async () => (await this.core.ctx.tryUse('access')?.getApproval(e.requestId))?.details)) as { expiresInDays?: number | null } | undefined;
    const out = new Outbox();
    const after = await this.repo.transaction(async (tx) => {
      const acct = await tx.lockOrCreateAccount(g0.customer_id, g0.currency, this.core.now());
      const g = (await tx.getGrant(g0.id, { forUpdate: true }))!;
      if (g.state !== 'pending_approval') return null;
      return this.credit(tx, acct, g, decider, { caseRef: g.case_id ? caseRefs.get(g.case_id) : undefined, orderRef: g.order_id ? orderRefs.get(g.order_id) : undefined, months, expiresInDays: details?.expiresInDays ?? null, out });
    });
    this.core.flush(out, by);
    if (after) this.decided(after, 'granted', by);
    if (after) await this.core.audit({ action: 'wallet.goodwill.grant', actionLabel: 'Granted goodwill credit after approval', category: 'financial', target: this.target(after), reason: after.reason, after: { amount: m(after.amount, after.currency), ledgerEntryId: after.ledger_entry_id, requestedBy: actorFrom(after.requested_by) }, approvalRequestId: e.requestId }, by);
  }

  /** wallet.goodwill.decided: a grant that waited for approval was granted or rejected (support tells the case) */
  private decided(g: GrantRow, status: 'granted' | 'rejected', by: By) {
    const out = new Outbox();
    out.push('wallet.goodwill.decided', { grantId: g.id, customerId: g.customer_id, status, amount: m(g.amount, g.currency), caseId: g.case_id });
    this.core.flush(out, by);
  }

  private async correctionDecided(e: EventPayload<'access.approval.decided'>) {
    const c0 = (await this.repo.correctionByApproval(e.requestId)) ?? (e.target.type === 'credit_correction' ? await this.repo.getCorrection(e.target.id) : undefined) ?? (await this.legacyCorrection(e));
    if (!c0 || c0.state !== 'pending_approval') return void this.core.ctx.log.info({ requestId: e.requestId }, 'wallet: approval for no pending store credit correction');
    const decider: common.Actor = e.decidedBy ?? SYSTEM;
    const target = { type: 'wallet_account', id: c0.customer_id, label: 'Store credit account' };
    const amount = m(c0.amount, c0.currency);
    if (e.outcome !== 'approved') {
      const after = await this.repo.transaction(async (tx) => {
        const c = (await tx.getCorrection(c0.id, { forUpdate: true }))!;
        if (c.state !== 'pending_approval') return null;
        return tx.updateCorrection(c.id, { state: creditCorrectionMachine.next('pending_approval', 'reject'), decided_by: actorText(decider), decided_at: this.core.now() });
      });
      if (after) await this.core.audit({ action: 'wallet.credit.reject_correction', actionLabel: 'Store credit correction not approved', category: 'financial', target, reason: e.reason ?? `Approval ${e.outcome}`, after: { amount, correctionId: after.id }, approvalRequestId: e.requestId }, { actor: decider });
      return;
    }
    // the ledger write is idempotent per correction key, so a redelivered decision never applies it twice
    const by: By = { actor: actorFrom(c0.requested_by) ?? SYSTEM };
    let applied = null as CorrectionRow | null;
    try {
      const entry = await this.ledger.applyCorrection(c0.customer_id, amount, c0.reason, c0.reference, `correction:${c0.idempotency_key}`, by, async (tx, entryRow) => {
        const c = (await tx.getCorrection(c0.id, { forUpdate: true }))!;
        if (c.state !== 'pending_approval') return;
        applied = await tx.updateCorrection(c.id, { state: creditCorrectionMachine.next('pending_approval', 'apply'), ledger_entry_id: entryRow.id, decided_by: actorText(decider), decided_at: this.core.now() });
      });
      if (applied) {
        await this.core.audit(
          { action: 'wallet.credit.correct', actionLabel: 'Corrected store credit after approval', category: 'financial', target, reason: c0.reason, after: { amount, reference: c0.reference, entryId: entry.id, correctionId: c0.id, approvedBy: e.decidedBy ?? null }, approvalRequestId: e.requestId },
          by,
        );
      }
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      // e.g. a negative correction that no longer finds the credit: the correction ends failed, with why
      const failed = await this.repo.transaction(async (tx) => {
        const c = (await tx.getCorrection(c0.id, { forUpdate: true }))!;
        if (c.state !== 'pending_approval') return null;
        return tx.updateCorrection(c.id, { state: creditCorrectionMachine.next('pending_approval', 'fail'), failure: err.message, decided_by: actorText(decider), decided_at: this.core.now() });
      });
      this.core.ctx.log.warn({ err, requestId: e.requestId }, 'wallet: approved store credit correction could not be applied');
      if (failed) await this.core.audit({ action: 'wallet.credit.correction_failed', actionLabel: 'Approved store credit correction could not be applied', category: 'financial', target, reason: err.message, after: { amount, correctionId: failed.id }, approvalRequestId: e.requestId }, { actor: decider });
    }
  }

  /**
   * A correction sent for approval before credit_corrections existed (pass 4) kept its details only in the
   * approval request: its row is created here, pending, so the decision finishes it like any other.
   */
  private async legacyCorrection(e: EventPayload<'access.approval.decided'>): Promise<CorrectionRow | undefined> {
    const req = await this.core.soft('access.getApproval', async () => this.core.ctx.tryUse('access')?.getApproval(e.requestId));
    const p = req?.details as LegacyPendingCorrection | undefined;
    if (!p?.customerId || !p.amount || !p.key || p.correctionId) return undefined;
    const known = await this.repo.correctionByKey(p.key);
    if (known) return known;
    return (
      (await this.repo.insertCorrection({
        id: e.target.type === 'credit_correction' && isUuid(e.target.id) ? e.target.id : newId(),
        customer_id: p.customerId,
        amount: p.amount.amount,
        currency: p.amount.currency,
        reason: p.reason || 'Balance correction',
        reference: p.reference ?? null,
        state: 'pending_approval',
        approval_request_id: e.requestId,
        requested_by: actorText(p.requestedBy ?? SYSTEM),
        decided_by: null,
        decided_at: null,
        ledger_entry_id: null,
        failure: null,
        idempotency_key: p.key,
        created_at: this.core.now(),
      })) ?? (await this.repo.correctionByKey(p.key))
    );
  }

  /* ================================================================ reads */

  async list(f: { state?: string; from?: string; to?: string; requestedBy?: string }, page: PageRequest): Promise<common.Page<GoodwillGrant>> {
    const day = (d: string, plus = 0) => new Date(new Date(`${d}T00:00:00Z`).getTime() + plus * DAY);
    const p = await this.repo.grantsPage({ state: f.state, from: f.from ? day(f.from) : undefined, to: f.to ? day(f.to, 1) : undefined, requestedBy: f.requestedBy }, page);
    return { ...p, items: await this.grantViews(p.items) };
  }

  async grantViews(rows: readonly GrantRow[]): Promise<GoodwillGrant[]> {
    if (!rows.length) return [];
    const [names, orderRefs, caseRefs, approvals, entries] = await Promise.all([
      this.core.customerNames(rows.map((r) => r.customer_id)),
      this.core.orderRefs(rows.map((r) => r.order_id)),
      this.core.caseRefs(rows.map((r) => ({ caseId: r.case_id, orderId: r.order_id }))),
      this.core.approvalInfos(rows.map((r) => r.approval_request_id)),
      this.repo.getEntries(rows.map((r) => r.ledger_entry_id).filter((x): x is string => Boolean(x))),
    ]);
    const grantedAt = new Map(entries.map((e) => [e.id, e.at]));
    return rows.map((g) => toGrant(g, { names, orderRefs, caseRefs, approvals, grantedAt }));
  }

  /** Staff view: balance, lots, goodwill in the last 30 days against the per-customer limit, pending grants */
  async customerWallet(customerId: string): Promise<CustomerWalletAdmin> {
    const [balance, lots, limit, last30, pending, corrections] = await Promise.all([
      this.ledger.balance(customerId),
      this.ledger.lots(customerId),
      this.core.ctx.settings.get('goodwillMaxPerCustomer30Days') as Promise<common.Money>,
      this.repo.goodwillSince(customerId, new Date(this.core.now().getTime() - 30 * DAY)),
      this.repo.grantsOfCustomer(customerId, ['pending_approval']),
      this.repo.correctionsOfCustomer(customerId, ['pending_approval']),
    ]);
    const [pendingGrants, pendingCorrections] = await Promise.all([this.grantViews(pending), this.correctionViews(corrections)]);
    return { balance, lots, goodwillLast30Days: m(last30, limit.currency), goodwillLimitPerCustomer: limit, pendingGrants, pendingCorrections };
  }
}
