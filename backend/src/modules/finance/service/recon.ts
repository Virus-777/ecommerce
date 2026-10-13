/**
 * Daily finance checks: captured payments against orders, seller balances against the ledger, the provider
 * deposit against captures, unexplained amounts and failed payouts. Mismatches are explained (no money
 * moves) or corrected with a reason (second reviewer above the caller's correction limit in access), then the
 * day is signed off.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import { zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import type * as common from '../../../spec/common.js';
import type { Correction, CorrectionInput, ReconChecklistItem, ReconDay, ReconItem, Reference } from '../../../spec/finance.js';
import { addDays, dayStart, decodeActor, detId, encodeActor, fmt, isDate, SYSTEM } from '../domain/rules.js';
import { reconciliationItemMachine } from '../domain/state-machines.js';
import { reference } from '../mappers.js';
import type { ReconDayRec, ReconItemRec } from '../ports.js';
import type { Where } from '../../../kernel/mongo/index.js';
import { invalid, notFound, Part, type By } from './core.js';

const NIL = '00000000-0000-0000-0000-000000000000';
const OPEN = ['open', 'correction_pending'];
const DAY_MS = 86_400_000;

export class ReconPart extends Part {
  /* ---------------------------------------------------------------- days */

  async owners(): Promise<{ owner: string; backup: string | null }> {
    const staff = await this.core.optionalDep(() => this.ctx.use('access').resolveRecipients('finance_staff'));
    const manager = await this.core.optionalDep(() => this.ctx.use('access').resolveRecipients('finance_manager'));
    const owner = staff?.leadAccountId ?? staff?.accountIds[0] ?? manager?.leadAccountId ?? NIL;
    const backup = manager?.leadAccountId && manager.leadAccountId !== owner ? manager.leadAccountId : null;
    return { owner, backup };
  }

  async ensureDay(date: string): Promise<ReconDayRec> {
    const existing = await this.repo.findOne('recon_days', { date });
    if (existing) return existing;
    const { owner, backup } = await this.owners();
    await this.repo.insertIfAbsent('recon_days', { date, status: 'open', owner_staff_id: owner, backup_staff_id: backup, due_at: zonedTimeToUtc(addDays(date, 1), '12:00', this.core.tz()), checklist: [] as never, completed_by: null, completed_at: null });
    return (await this.repo.findOne('recon_days', { date }))!;
  }

  async staffActor(id: string | null | undefined): Promise<{ actor: common.Actor | null; role: string | null }> {
    if (!id || id === NIL) return { actor: id === NIL ? { kind: 'system', id: null, name: 'Finance team' } : null, role: null };
    const ref = await this.core.staffRef(id);
    return { actor: { kind: 'staff', id, name: ref?.name ?? null }, role: ref?.roleLabel ?? null };
  }

  async itemViews(rows: ReconItemRec[]): Promise<ReconItem[]> {
    const now = this.now().getTime();
    const out: ReconItem[] = [];
    for (const r of rows) {
      const owner = await this.staffActor(r.owner_staff_id);
      const c = r.correction as (Correction & { approvalRequestId?: string | null }) | null;
      let correction: Correction | null = null;
      if (c) {
        const { approvalRequestId: _a, ...rest } = c;
        correction = { ...rest, approval: r.approval_request_id ? await this.core.approvalInfo(r.approval_request_id) : (rest.approval ?? null) };
      }
      out.push({
        id: r.id,
        date: r.date,
        check: r.check as ReconItem['check'],
        reference: reference(r.ref_kind === 'capture' ? 'reconciliation' : r.ref_kind, r.ref_id),
        subject: r.subject,
        description: r.description,
        expected: { amount: r.expected, currency: r.currency },
        actual: { amount: r.actual, currency: r.currency },
        credit: r.ref_kind === 'capture' ? { amount: r.credit, currency: r.currency } : null,
        difference: { amount: r.difference, currency: r.currency },
        detectedAt: r.detected_at.toISOString(),
        ageDays: Math.max(0, Math.floor((now - r.detected_at.getTime()) / DAY_MS)),
        status: r.status as ReconItem['status'],
        note: r.note,
        owner: owner.actor,
        ownerRole: owner.role,
        correction,
      });
    }
    return out;
  }

  async itemView(id: string): Promise<ReconItem> {
    const row = await this.repo.get('recon_items', id);
    if (!row) throw notFound('Reconciliation item');
    return (await this.itemViews([row]))[0]!;
  }

  async day(date: string): Promise<ReconDay> {
    if (!isDate(date)) throw invalid([{ path: 'date', message: 'A date' }]);
    const row = await this.repo.findOne('recon_days', { date });
    const owners = row ? { owner: row.owner_staff_id, backup: row.backup_staff_id } : await this.owners();
    const items = await this.repo.find('recon_items', { date });
    const open = items.filter((i) => OPEN.includes(i.status));
    const chargebacks = await this.repo.find('holds', { reason_code: 'chargeback', status: 'active' });
    const failed = await this.repo.find('payouts', { status: 'failed' }, { orderBy: [['failed_at', 'desc']] });
    const retried = failed.length ? new Set((await this.repo.find('payouts', { retry_of: failed.map((f) => f.id) })).map((p) => p.retry_of)) : new Set<string | null>();
    const unretried = failed.filter((f) => !retried.has(f.id));
    const due = row?.due_at ?? zonedTimeToUtc(addDays(date, 1), '12:00', this.core.tz());
    const late = this.now() > due;
    const stored = new Map(((Array.isArray(row?.checklist) ? row!.checklist : []) as unknown as ReconChecklistItem[]).map((c) => [c.key, c]));
    const state = (done: boolean, started: boolean): ReconChecklistItem['state'] => (done ? 'done' : late ? 'late' : started ? 'in_progress' : 'todo');
    const of = (check: string) => items.filter((i) => i.check === check);
    const openOf = (check: string) => open.filter((i) => i.check === check);
    const deposit = of('provider_deposit');
    const checklist: ReconChecklistItem[] = ([

      { key: 'provider_deposit', label: 'Provider deposit matches captured payments', state: state(deposit.length > 0 && !openOf('provider_deposit').length, deposit.length > 0), note: deposit.length ? null : 'No settlement report yet' },
      { key: 'chargebacks_reviewed', label: 'Chargebacks reviewed', state: state(chargebacks.every((h) => h.review_date > date), chargebacks.length > 0), note: chargebacks.length ? `${chargebacks.length} open` : null },
      { key: 'payments_matched', label: 'Payments matched to orders', state: state(!openOf('payments_vs_orders').length, of('payments_vs_orders').length > 0), note: null },
      { key: 'seller_amounts_matched', label: 'Seller balances match the ledger and statements', state: state(!openOf('seller_amounts').length, true), note: null },
      { key: 'store_credit_matched', label: 'Store credit balances match the liability', state: state(!openOf('store_credit').length, of('store_credit').length > 0), note: openOf('store_credit').length ? `${openOf('store_credit').length} open` : null },
      { key: 'failed_payouts_followed', label: 'Failed payouts followed up', state: state(!unretried.length, failed.length > 0), note: unretried.length ? `${unretried.length} to retry` : null },
      { key: 'unexplained_explained', label: 'Unexplained amounts explained', state: state(!openOf('unexplained_amount').length, of('unexplained_amount').length > 0), note: null },
    ] as Omit<ReconChecklistItem, 'doneAt'>[]).map((c) => ({ ...c, doneAt: c.state === 'done' ? (stored.get(c.key)?.doneAt ?? row?.completed_at?.toISOString() ?? null) : null }));
    const owner = await this.staffActor(owners.owner);
    const backup = owners.backup ? await this.staffActor(owners.backup) : null;
    const dueState: common.Deadline['state'] = late ? 'overdue' : due.getTime() - this.now().getTime() < 4 * 3_600_000 ? 'due_soon' : 'on_time';
    return {
      date,
      status: (row?.status ?? 'open') as ReconDay['status'],
      owner: owner.actor ?? SYSTEM,
      backup: backup?.actor ?? null,
      due: { dueAt: due.toISOString(), state: row?.status === 'completed' ? 'on_time' : dueState },
      checklist,
      openMismatches: open.length,
      netDifference: this.money(open.reduce((s, i) => s + i.difference, 0)),
      chargebacksOpen: chargebacks.length,
      chargebacksAtRisk: this.money(chargebacks.reduce((s, h) => s + h.amount - h.released_amount, 0)),
      failedPayouts: await this.parts.payouts.payoutViews(unretried.slice(0, 50)),
      unexplained: this.money(openOf('unexplained_amount').reduce((s, i) => s + Math.abs(i.difference), 0)),
      completedBy: decodeActor(row?.completed_by),
      completedAt: row?.completed_at?.toISOString() ?? null,
    };
  }

  async complete(date: string, note: string | null | undefined, by: By): Promise<ReconDay> {
    if (!isDate(date)) throw invalid([{ path: 'date', message: 'A date' }]);
    const row = await this.ensureDay(date);
    if (row.status === 'completed') throw new AppError('ILLEGAL_TRANSITION', 'The day is already signed off', { from: 'completed', event: 'complete' });
    const open = await this.repo.find('recon_items', { date, status: OPEN });
    if (open.length) throw this.ctx.error('RECON_DAY_INCOMPLETE', 'Open mismatches remain; explain or correct them first', { openItems: open.map((i) => i.id) });
    const view = await this.day(date);
    await this.repo.updateWhere('recon_days', { date }, { status: 'completed', completed_by: encodeActor(by.actor), completed_at: this.now(), checklist: view.checklist.map((c) => ({ ...c, doneAt: c.doneAt ?? (c.state === 'done' ? this.now().toISOString() : null) })) as never });
    await this.core.audit({ action: 'finance.reconciliation.complete', actionLabel: 'Signed off the daily finance checks', category: 'financial', target: { type: 'reconciliation_day', id: date, ref: date, screen: 'ops/finance-checks' }, reason: note ?? null }, by);
    return this.day(date);
  }

  /* ---------------------------------------------------------------- items */

  async list(f: { date?: string | null; check?: string | null; status?: string | null }, page: PageRequest): Promise<common.Page<ReconItem>> {
    const where: Where<ReconItemRec> = {};
    if (f.date) where.date = f.date;
    if (f.check) where.check = f.check;
    where.status = f.status ? f.status : { op: '<>', value: 'matched' };
    const res = await this.repo.page('recon_items', where, page, { column: 'detected_at', direction: 'desc' });
    return { ...res, items: await this.itemViews(res.items) };
  }

  /**
   * An open (or correction-pending) item is closed: matched (automatically or by a later event), explained or
   * corrected. Workqueues closes the work item it opened for the mismatch.
   */
  closed(row: Pick<ReconItemRec, 'id' | 'check' | 'date'>, outcome: 'matched' | 'explained' | 'corrected', by: { actor?: common.Actor; requestId?: string } = {}) {
    this.core.publish('finance.reconciliation.item_closed', { itemId: row.id, check: row.check, date: row.date, outcome }, by);
  }

  /** Records a check result; new mismatches are published for Finance's queue, an open item that now matches is closed */
  async upsertItem(input: Omit<ReconItemRec, 'status' | 'note' | 'owner_staff_id' | 'correction' | 'approval_request_id' | 'currency' | 'detected_at' | 'credit'> & { credit?: number }) {
    const row = { ...input, credit: input.credit ?? 0 };
    await this.ensureDay(row.date);
    const matched = row.difference === 0;
    const inserted = await this.repo.insertIfAbsent('recon_items', { ...row, currency: this.core.currency(), detected_at: this.now(), status: matched ? this.core.step(reconciliationItemMachine, 'open', 'autoMatch') : 'open', note: null, owner_staff_id: null, correction: null, approval_request_id: null });
    if (!inserted) {
      if (!matched) return;
      // compare-and-set: only the run that moves the item out of open publishes that it closed
      const changed = await this.repo.updateWhere('recon_items', { id: row.id, status: 'open' }, { status: this.core.step(reconciliationItemMachine, 'open', 'autoMatch'), actual: row.actual, difference: 0 });
      if (changed) this.closed(row, 'matched');
      return;
    }
    if (!matched) this.core.publish('finance.reconciliation.mismatch_found', { itemId: row.id, check: row.check, difference: this.money(row.difference) });
  }

  /**
   * payments.payment.captured: the capture is recorded (captures: card amount and store credit applied), then
   * checked: card plus store credit (creditAmount) against the order (or package) total less the items cancelled
   * before they were charged. The item keeps expected = that total, actual = the card amount (what the provider
   * deposits) and credit = the store credit, so a mixed card and credit payment is no mismatch and the deposit
   * check adds up card money only.
   */
  async onPaymentCaptured(e: EventPayload<'payments.payment.captured'>) {
    const at0 = new Date(e.capturedAt);
    const at = Number.isNaN(at0.getTime()) ? this.now() : at0;
    const date = this.core.today(at);
    const card = e.amount.amount;
    const credit = e.creditAmount && e.creditAmount.amount > 0 ? e.creditAmount.amount : 0;
    const creditNote = credit ? ` (store credit ${fmt(credit, e.creditAmount!.currency)} also applied)` : '';
    const itemId = detId(`capture:${e.captureId}`);
    const order = await this.parts.ledger.order(e.orderId);
    if (isUuid(e.captureId)) {
      await this.repo.insertIfAbsent('captures', {
        id: e.captureId,
        intent_id: isUuid(e.intentId) ? e.intentId : null,
        order_id: order && isUuid(e.orderId) ? e.orderId : null,
        group_id: e.groupId && isUuid(e.groupId) ? e.groupId : null,
        card_amount: card,
        credit_amount: credit,
        currency: e.amount.currency,
        provider_ref: e.providerRef ?? null,
        captured_at: at,
        recon_item_id: itemId,
      });
    }
    if (!order) {
      await this.upsertItem({ id: itemId, date, check: 'unexplained_amount', ref_kind: 'capture', ref_id: e.captureId, subject: e.providerRef ?? 'Captured payment', description: `Captured payment with no matching order${creditNote}`, expected: 0, actual: card, credit, difference: card + credit });
      return;
    }
    const group = e.groupId ? order.groups.find((g) => g.id === e.groupId) : undefined;
    const total = group ? group.totals.total.amount : order.totals.total.amount;
    const items = group ? group.items : order.groups.flatMap((g) => g.items);
    // items cancelled before they were charged are not part of the capture; ones cancelled after it are refunds
    const cancelled = items.filter((i) => i.state === 'cancelled' && (i.afterSales?.refundStatus ?? 'none') === 'none' && !((i.afterSales?.refundedAmount?.amount ?? 0) > 0)).reduce((s, i) => s + i.paidAmount.amount, 0);
    const due = total - cancelled;
    const cur = order.totals.total.currency;
    const against = `${group ? `package ${group.packageLabel}` : 'the order'} total ${fmt(total, cur)}${cancelled ? ` less ${fmt(cancelled, cur)} of cancelled items` : ''}`;
    const description = credit ? `Card capture ${fmt(card, cur)} plus store credit ${fmt(credit, cur)} against ${against}` : `Capture against ${against}`;
    await this.upsertItem({ id: itemId, date, check: 'payments_vs_orders', ref_kind: 'capture', ref_id: e.captureId, subject: order.ref, description, expected: due, actual: card, credit, difference: card + credit - due });
  }

  /**
   * recordExternalDifference: another module (wallet) reports a difference in its own books for the daily check.
   * One item per key on the day it is first reported (store_credit, finance.reconciliation.mismatch_found); the same
   * key returns that item, and a later report with expected = actual matches it (finance.reconciliation.item_closed).
   */
  async recordExternalDifference(input: { check: 'store_credit'; subject: string; description: string; expected: common.Money; actual: common.Money; reference?: Reference; key: string }): Promise<ReconItem> {
    const currency = this.core.currency();
    const issues: { path: string; message: string }[] = [];
    if (input?.check !== 'store_credit') issues.push({ path: 'check', message: 'Only store_credit differences are reported by other modules' });
    if (!input?.key?.trim()) issues.push({ path: 'key', message: 'Required' });
    if (!input?.subject?.trim()) issues.push({ path: 'subject', message: 'Required' });
    for (const k of ['expected', 'actual'] as const) {
      const v = input?.[k];
      if (!v || !Number.isSafeInteger(v.amount)) issues.push({ path: k, message: 'An amount in minor units' });
      else if (v.currency !== currency) issues.push({ path: `${k}.currency`, message: `Finance checks are in ${currency}` });
    }
    if (issues.length) throw invalid(issues);
    const id = detId(`external:${input.check}:${input.key}`);
    const known = await this.repo.get('recon_items', id);
    await this.upsertItem({
      id,
      date: known?.date ?? this.core.today(),
      check: input.check,
      ref_kind: input.reference?.kind ?? null,
      ref_id: input.reference?.id ?? null,
      subject: input.subject.trim(),
      description: input.description?.trim() || `Reported difference ${fmt(input.actual.amount - input.expected.amount, currency)}`,
      expected: input.expected.amount,
      actual: input.actual.amount,
      difference: input.actual.amount - input.expected.amount,
    });
    return this.itemView(id);
  }

  /**
   * Part of finance.reconcile.daily: the store-credit liability finance booked from wallet events up to the end of
   * the day against wallet's balances then (wallet.getLiabilityTotal), when wallet is enabled.
   */
  async storeCreditCheck(date: string) {
    const wallet = this.ctx.tryUse('wallet');
    if (!wallet) return;
    const end = dayStart(addDays(date, 1), this.core.tz());
    const totals = await wallet.getLiabilityTotal(end.toISOString());
    const outstanding = totals.available.amount + totals.held.amount;
    const liability = await this.parts.ledger.storeCreditLiability(end);
    const cur = this.core.currency();
    await this.upsertItem({
      id: detId(`store_credit:${date}`),
      date,
      check: 'store_credit',
      ref_kind: null,
      ref_id: null,
      subject: 'Store credit liability',
      description: `Wallet balances ${fmt(outstanding, cur)} (available ${fmt(totals.available.amount, cur)}, held ${fmt(totals.held.amount, cur)}, ${totals.accounts} accounts) vs store-credit liability ${fmt(liability, cur)}`,
      expected: liability,
      actual: outstanding,
      difference: outstanding - liability,
    });
  }

  /** A refund payments gave up on (final attempt failed): money owed to the customer that was not sent */
  async refundFailed(e: EventPayload<'payments.refund.failed'>) {
    await this.upsertItem({
      id: detId(`refund_failed:${e.refundId}`),
      date: this.core.today(),
      check: 'payments_vs_orders',
      ref_kind: 'refund',
      ref_id: e.refundId,
      subject: e.ref,
      description: `Refund ${e.ref} failed after ${e.attempts} attempt${e.attempts === 1 ? '' : 's'} and was not sent: ${e.reason}`,
      expected: e.amount.amount,
      actual: 0,
      difference: -e.amount.amount,
    });
  }

  /** The failed refund was sent after all (a later retry or a new destination): its open item matches */
  async refundSent(refundId: string, amount: number) {
    const id = detId(`refund_failed:${refundId}`);
    const row = await this.repo.get('recon_items', id);
    if (row?.status !== 'open') return;
    const changed = await this.repo.updateWhere('recon_items', { id, status: 'open' }, { status: this.core.step(reconciliationItemMachine, 'open', 'autoMatch'), actual: amount, difference: amount - row.expected, note: 'Sent after a later attempt' });
    if (changed) this.closed(row, 'matched');
  }

  /** Job finance.reconcile.daily: yesterday's checks */
  async daily() {
    const date = addDays(this.core.today(), -1);
    await this.ensureDay(date);
    // earlier seller mismatches still open: closed as matched once the seller's balance matches the ledger again
    const openSeller = new Map<string, ReconItemRec[]>();
    for (const r of await this.repo.find('recon_items', { check: 'seller_amounts', status: 'open' }, { limit: 5000 })) if (r.ref_id) openSeller.set(r.ref_id, [...(openSeller.get(r.ref_id) ?? []), r]);
    // seller balances against the ledger
    for (const a of await this.repo.find('seller_accounts', {}, { limit: 5000 })) {
      const total = await this.repo.sum('ledger_entries', 'amount', { seller_id: a.seller_id });
      const held = await this.repo.sum('ledger_entries', 'amount', { seller_id: a.seller_id, bucket: 'held' });
      const pending = await this.repo.pendingFromLedger(a.seller_id);
      const actual = a.pending + a.available + a.held;
      const diff = actual - total || a.held - held || a.pending - pending;
      if (diff === 0) {
        for (const r of openSeller.get(a.seller_id) ?? []) {
          const changed = await this.repo.updateWhere('recon_items', { id: r.id, status: 'open' }, { status: this.core.step(reconciliationItemMachine, 'open', 'autoMatch'), difference: 0, note: `The balance matches the ledger again (checked for ${date})` });
          if (changed) this.closed(r, 'matched');
        }
      } else {
        const name = await this.core.sellerName(a.seller_id);
        await this.upsertItem({ id: detId(`seller_amounts:${date}:${a.seller_id}`), date, check: 'seller_amounts', ref_kind: 'seller', ref_id: a.seller_id, subject: name, description: `Balance ${fmt(actual, a.currency)} vs ledger ${fmt(total, a.currency)} (held ${fmt(a.held, a.currency)} vs ${fmt(held, a.currency)})`, expected: total, actual, difference: diff });
      }
    }
    // the provider's deposit against the day's captures
    const tz = this.core.tz();
    const captures = (await this.repo.find('captures', { captured_at: { op: '>=', value: dayStart(date, tz) } })).filter((c) => c.captured_at < dayStart(addDays(date, 1), tz));
    const deposit = await this.core.provider.settlementReport(date, this.core.currency());
    if (deposit) {
      const expected = captures.reduce((s, c) => s + c.card_amount, 0);
      await this.upsertItem({ id: detId(`deposit:${date}`), date, check: 'provider_deposit', ref_kind: null, ref_id: null, subject: 'Payment provider deposit', description: `Deposit for ${date} against ${captures.length} captured payments`, expected, actual: deposit.amount, difference: deposit.amount - expected });
    }
    // store credit: finance's liability against wallet's balances (wallet's own per-account differences arrive through recordExternalDifference)
    try {
      await this.storeCreditCheck(date);
    } catch (err) {
      this.ctx.log.error({ err, date }, 'finance: store credit check failed');
    }
  }

  async assign(id: string, ownerId: string, by: By): Promise<ReconItem> {
    const row = isUuid(id) ? await this.repo.get('recon_items', id) : undefined;
    if (!row) throw notFound('Reconciliation item');
    await this.repo.update('recon_items', id, { owner_staff_id: ownerId });
    await this.core.audit({ action: 'finance.reconciliation.assign', actionLabel: 'Assigned a finance mismatch', category: 'financial', target: { type: 'reconciliation_item', id, label: row.subject, screen: 'ops/finance-checks' }, before: { owner: row.owner_staff_id }, after: { owner: ownerId } }, by);
    return this.itemView(id);
  }

  async explain(id: string, body: { reasonCode: string; note: string }, by: By): Promise<ReconItem> {
    if (!body.note?.trim()) throw invalid([{ path: 'note', message: 'Explain the difference' }]);
    const row = isUuid(id) ? await this.repo.get('recon_items', id) : undefined;
    if (!row) throw notFound('Reconciliation item');
    const status = this.core.step(reconciliationItemMachine, row.status, 'explain');
    // compare-and-set on the status read: a concurrent explain or match closes the item once
    const changed = await this.repo.updateWhere('recon_items', { id, status: row.status }, { status, note: `${body.reasonCode.replace('_', ' ')}: ${body.note}` });
    if (!changed) throw new AppError('ILLEGAL_TRANSITION', 'This item was closed in the meantime', { from: row.status, event: 'explain' });
    this.closed(row, 'explained', by);
    await this.core.audit({ action: 'finance.reconciliation.explain', actionLabel: 'Explained a finance difference', category: 'financial', target: { type: 'reconciliation_item', id, label: row.subject, screen: 'ops/finance-checks' }, reason: `${body.reasonCode}: ${body.note}` }, by);
    return this.itemView(id);
  }

  async correct(id: string, input: CorrectionInput, by: By): Promise<ReconItem> {
    const row = isUuid(id) ? await this.repo.get('recon_items', id) : undefined;
    if (!row) throw notFound('Reconciliation item');
    if (!Number.isSafeInteger(input.amount.amount) || input.amount.amount === 0) throw invalid([{ path: 'amount', message: 'A non-zero amount in minor units' }]);
    if (!input.note?.trim()) throw invalid([{ path: 'note', message: 'Give the reason for the correction' }]);
    if ((input.type === 'seller_adjustment' || input.type === 'fee_correction') && row.ref_kind !== 'seller') throw invalid([{ path: 'type', message: 'Seller corrections apply to seller balance mismatches' }]);
    if (input.type === 'refund_duplicate_capture' && row.check !== 'payments_vs_orders') throw invalid([{ path: 'type', message: 'Duplicate-capture refunds apply to payment mismatches' }]);
    const status = this.core.step(reconciliationItemMachine, row.status, 'proposeCorrection');
    const check = await this.core.authority(by, 'finance.reconciliation.correct', Math.abs(input.amount.amount));
    const correction: Correction = { type: input.type, amount: input.amount, reasonCode: input.reasonCode, note: input.note, status: 'pending_approval', approval: null, recordedBy: by.actor, at: this.now().toISOString(), resultReference: null };
    let approvalId: string | null = null;
    if (check.decision === 'approval_required') {
      const req = await this.core.requestApproval(by, {
        action: 'finance.reconciliation.correct',
        target: { type: 'reconciliation_item', id, label: row.subject, screen: 'ops/finance-checks' },
        amount: { amount: Math.abs(input.amount.amount), currency: input.amount.currency },
        summary: `Correction of ${fmt(input.amount.amount, input.amount.currency)} (${input.type.replace(/_/g, ' ')}) for ${row.subject}`,
        details: { type: input.type, reasonCode: input.reasonCode },
        reason: input.note,
      });
      approvalId = req.id;
    }
    await this.repo.update('recon_items', id, { status, correction: correction as never, approval_request_id: approvalId });
    await this.core.audit({ action: 'finance.reconciliation.correct', actionLabel: approvalId ? 'Proposed a correction for approval' : 'Recorded a correction', category: 'financial', target: { type: 'reconciliation_item', id, label: row.subject, screen: 'ops/finance-checks' }, after: { type: input.type, amount: input.amount.amount }, reason: input.note, approvalRequestId: approvalId }, by);
    // above the limit the correction is saved pending approval and the item answers with it (FORMAT.md, Approval responses)
    if (approvalId) return this.itemView(id);
    await this.applyCorrection(id, by);
    return this.itemView(id);
  }

  /** Posts what the correction moves (seller adjustment, company write-off, refund through payments) */
  async applyCorrection(id: string, by: By) {
    const row = await this.repo.get('recon_items', id);
    if (!row || row.status !== 'correction_pending' || !row.correction) return;
    const c = row.correction as unknown as Correction;
    const amount = c.amount.amount;
    let result: Correction['resultReference'] = null;
    let sellerId: string | null = null;
    if ((c.type === 'seller_adjustment' || c.type === 'fee_correction') && row.ref_id) {
      sellerId = row.ref_id;
      const adj = await this.parts.holds.recordSystemAdjustment({ key: `correction:${id}`, sellerId: row.ref_id, direction: amount > 0 ? 'credit' : 'debit', amount: Math.abs(amount), reasonCode: c.type === 'fee_correction' ? 'fee_correction' : 'reconciliation_correction', reason: c.note, reference: { kind: 'reconciliation', id, ref: row.date }, by });
      result = { kind: 'adjustment', id: adj.id, ref: adj.ref };
    } else if (c.type === 'write_off') {
      await this.repo.transaction((tx) => this.parts.ledger.trading(tx, `correction:${id}`, { at: this.now(), kind: 'write_off', amount: Math.abs(amount), order_id: null, order_item_id: null, variant_id: null, ref_kind: 'reconciliation', ref_id: id }));
      result = { kind: 'reconciliation', id, ref: row.date };
    } else if (c.type === 'refund_duplicate_capture') {
      const admin = await this.ctx.use('orders').getOrderAdmin(row.subject);
      const item = admin ? admin.order.groups.flatMap((g) => g.items)[0] : undefined;
      if (!admin || !item) throw new AppError('CONFLICT', 'The order of this payment could not be found for the refund');
      const refund = await this.ctx.use('payments').startRefund({ orderId: admin.order.id, origin: 'correction', originId: id, originRef: row.date, items: [{ orderItemId: item.id, amount: { amount: Math.abs(amount), currency: c.amount.currency } }], destination: 'original_method', reason: c.note, requestedBy: by.actor }, `finance-correction-${id}`);
      result = { kind: 'refund', id: refund.id, ref: refund.ref };
    }
    await this.repo.update('recon_items', id, { status: this.core.step(reconciliationItemMachine, row.status, 'applyCorrection'), correction: { ...c, status: 'applied', resultReference: result } as never });
    this.closed(row, 'corrected', by);
    if (!sellerId && c.type !== 'other' && c.type !== 'adjust_order_total') this.core.publish('finance.adjustment.recorded', { adjustmentId: id, sellerId: null, direction: amount > 0 ? 'credit' : 'debit', amount: { amount: Math.abs(amount), currency: c.amount.currency }, reasonCode: c.reasonCode }, by);
  }

  async onApprovalDecided(e: EventPayload<'access.approval.decided'>) {
    const row = isUuid(e.target.id) ? await this.repo.get('recon_items', e.target.id) : undefined;
    if (!row || row.approval_request_id !== e.requestId || row.status !== 'correction_pending') return;
    const by: By = { actor: e.decidedBy ?? SYSTEM };
    if (e.outcome === 'approved') {
      await this.repo.update('recon_items', row.id, { approval_request_id: null });
      return this.applyCorrection(row.id, by);
    }
    const c = row.correction as unknown as Correction;
    await this.repo.update('recon_items', row.id, { status: this.core.step(reconciliationItemMachine, row.status, 'rejectCorrection'), approval_request_id: null, correction: { ...c, status: 'rejected' } as never });
  }
}
