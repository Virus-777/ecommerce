/**
 * Store credit: accounts, lots and the append-only ledger.
 *
 * The model (all amounts integer minor units):
 *   - the ledger is append-only; the sum of a customer's entries is their credit balance (available + held);
 *   - credit lives in lots (source, expiry); active lots' remainders add up to `available`;
 *   - a hold moves credit from available to held (lots are drawn earliest-expiring first) and writes a
 *     zero-amount `hold` entry recording the lots; capture writes the use (−amount), release a zero-amount
 *     `release` entry giving the lots back;
 *   - every change locks the account row first (one writer per customer), so concurrent holds, uses and
 *     refunds can never overspend, and each write is idempotent by its reference (key, hold, refund).
 */
import { newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { CreditBalance, CreditHold, CreditLot, LedgerEntry, WalletCreditGrantedEvent, WalletOverview } from '../../../spec/wallet.js';
import { creditHoldMachine } from '../domain/state-machines.js';
import { allocate, daysLeft, dueReminder, HOW_TO_USE, m, reminderDays, RESERVATION_KINDS, SYSTEM, USABLE_ON, type EntryKind, type LotSource } from '../domain/rules.js';
import { allocationsOf, toEntry, toHold, toLot, type EntryFacts } from '../mappers.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import type { AccountRow, BalanceSnapshot, EntryRow, HoldRow, LotAllocation, LotRow, WalletRepository } from '../ports.js';
import { conflict, invalid, notFound, Outbox, type By, type WalletCore } from './core.js';

const DAY = 86_400_000;
const BATCH = 200;
/** A payment being checked keeps its checkout's credit hold this long after the order was placed */
export const PENDING_CHECK_HOLD_HOURS = 24;

export interface CreditInput {
  kind: EntryKind;
  source: LotSource;
  amount: number;
  expiresAt: Date | null;
  reference: string | null;
  orderId?: string | null;
  refundId?: string | null;
  caseId?: string | null;
  key: string;
  actor: common.Actor;
  reason?: string | null;
}

export class Ledger {
  constructor(private readonly core: WalletCore) {}

  private get repo() {
    return this.core.repo;
  }

  /* ================================================================ primitives (inside a transaction, account locked) */

  private entryRow(acct: AccountRow, e: { kind: EntryKind; amount: number; allocations: LotAllocation[]; key: string | null; actor: common.Actor; reason?: string | null; orderId?: string | null; refundId?: string | null; caseId?: string | null; holdId?: string | null }) {
    return {
      id: newId(),
      customer_id: acct.customer_id,
      kind: e.kind,
      amount: e.amount,
      balance_after: acct.available + acct.held,
      lot_allocations: e.allocations,
      order_id: e.orderId ?? null,
      refund_id: e.refundId ?? null,
      case_id: e.caseId ?? null,
      hold_id: e.holdId ?? null,
      idempotency_key: e.key,
      actor_kind: e.actor.kind,
      actor_id: e.actor.id ?? null,
      reason: e.reason ?? null,
      at: this.core.now(),
    };
  }

  /** Adds credit: a new lot and a positive entry */
  async addCredit(tx: WalletRepository, acct: AccountRow, c: CreditInput): Promise<{ entry: EntryRow; lot: LotRow; acct: AccountRow }> {
    const now = this.core.now();
    const lot = await tx.insertLot({ id: newId(), customer_id: acct.customer_id, source: c.source, original: c.amount, remaining: c.amount, expires_at: c.expiresAt, reference: c.reference, state: 'active', created_at: now });
    const after = await tx.updateAccount(acct.customer_id, { available: acct.available + c.amount, held: acct.held, updated_at: now });
    const entry = await tx.insertEntry(this.entryRow(after, { kind: c.kind, amount: c.amount, allocations: [{ lotId: lot.id, amount: c.amount }], key: c.key, actor: c.actor, reason: c.reason, orderId: c.orderId, refundId: c.refundId, caseId: c.caseId }));
    return { entry, lot, acct: after };
  }

  /** Draws `amount` from usable lots, earliest-expiring first; INSUFFICIENT_CREDIT when they hold less */
  async drawLots(tx: WalletRepository, acct: AccountRow, amount: number): Promise<LotAllocation[]> {
    const lots = await tx.usableLots(acct.customer_id, this.core.now(), { forUpdate: true });
    const allocations = allocate(lots, amount);
    if (!allocations || acct.available < amount) throw this.core.insufficient(Math.min(acct.available, lots.reduce((s, l) => s + l.remaining, 0)), acct.currency);
    const byId = new Map(lots.map((l) => [l.id, l]));
    for (const a of allocations) {
      const lot = byId.get(a.lotId)!;
      const remaining = lot.remaining - a.amount;
      await tx.updateLot(lot.id, { remaining, state: remaining === 0 ? 'depleted' : 'active' });
    }
    return allocations;
  }

  /** Gives drawn credit back to its lots (a lot past its expiry then expires through expireDue) */
  private async restoreLots(tx: WalletRepository, allocations: readonly LotAllocation[]) {
    const lots = new Map((await tx.getLots(allocations.map((a) => a.lotId), { forUpdate: true })).map((l) => [l.id, l]));
    for (const a of allocations) {
      const lot = lots.get(a.lotId);
      if (!lot) continue;
      const updated = await tx.updateLot(lot.id, { remaining: lot.remaining + a.amount, state: 'active' });
      lots.set(lot.id, updated);
    }
  }

  /** Expires the customer's lots at or past their expiry: one −remaining entry per lot */
  async expireDue(tx: WalletRepository, acct: AccountRow, out: Outbox): Promise<AccountRow> {
    const now = this.core.now();
    let a = acct;
    for (const lot of await tx.dueLots(acct.customer_id, now, { forUpdate: true })) {
      if (lot.remaining > 0) {
        a = await tx.updateAccount(a.customer_id, { available: a.available - lot.remaining, held: a.held, updated_at: now });
        const entry = await tx.insertEntry(this.entryRow(a, { kind: 'expiry', amount: -lot.remaining, allocations: [{ lotId: lot.id, amount: lot.remaining }], key: null, actor: SYSTEM, reason: 'Credit reached its expiry date' }));
        out.push('wallet.credit.expired', { customerId: a.customer_id, entryId: entry.id, lotId: lot.id, source: lot.source as LotSource, amount: m(lot.remaining, a.currency) });
      }
      await tx.updateLot(lot.id, { remaining: 0, state: 'expired' });
    }
    return a;
  }

  /* ================================================================ holds (checkout and payments) */

  async holdCredit(customerId: string, quoteId: string, amount: common.Money, idempotencyKey: string): Promise<CreditHold> {
    const issues = this.core.checkMoney(amount, 'amount');
    if (!idempotencyKey?.trim()) issues.push({ path: 'idempotencyKey', message: 'Required' });
    if (issues.length) throw invalid(issues);
    const sameRequest = (h: HoldRow) => {
      if (h.customer_id !== customerId || h.quote_id !== quoteId || h.amount !== amount.amount) throw conflict('This key was already used for another credit hold', { holdId: h.id });
      return toHold(h, amount.currency);
    };
    const known = await this.repo.holdByKey(idempotencyKey);
    if (known) return sameRequest(known);
    const ttl = Number(await this.core.ctx.settings.get('holdTtlMinutes')) || 30;
    const out = new Outbox();
    const hold = await this.repo.transaction(async (tx) => {
      const acct = await tx.lockAccount(customerId);
      const again = await tx.holdByKey(idempotencyKey);
      if (again) return again;
      const live = await tx.liveHoldOfQuote(quoteId, { forUpdate: true });
      if (live) {
        // one live hold per checkout: the same amount is the same reservation
        if (live.customer_id === customerId && live.amount === amount.amount) return live;
        throw conflict('Store credit is already reserved for this checkout', { holdId: live.id });
      }
      if (!acct) throw this.core.insufficient(0, amount.currency);
      if (acct.currency !== amount.currency) throw invalid([{ path: 'amount.currency', message: `Store credit is in ${acct.currency}` }]);
      let a = await this.expireDue(tx, acct, out);
      const allocations = await this.drawLots(tx, a, amount.amount);
      const now = this.core.now();
      a = await tx.updateAccount(customerId, { available: a.available - amount.amount, held: a.held + amount.amount, updated_at: now });
      const h = await tx.insertHold({ id: newId(), customer_id: customerId, quote_id: quoteId, order_id: null, amount: amount.amount, state: creditHoldMachine.initial, expires_at: new Date(now.getTime() + ttl * 60_000), idempotency_key: idempotencyKey });
      await tx.insertEntry(this.entryRow(a, { kind: 'hold', amount: 0, allocations, key: `hold:${h.id}`, actor: SYSTEM, holdId: h.id, reason: 'Reserved for checkout' }));
      return h;
    });
    this.core.flush(out);
    return hold.idempotency_key === idempotencyKey ? toHold(hold, amount.currency) : sameRequest(hold);
  }

  async captureHold(holdId: string, orderId: string, by: By = { actor: SYSTEM }): Promise<CreditHold> {
    const h0 = await this.repo.getHold(holdId);
    if (!h0) throw notFound('Credit hold');
    const out = new Outbox();
    const { hold, currency } = await this.repo.transaction(async (tx) => {
      const acct = (await tx.lockAccount(h0.customer_id))!;
      const h = (await tx.getHold(holdId, { forUpdate: true }))!;
      if (h.state === 'captured') {
        if (h.order_id === orderId) return { hold: h, currency: acct.currency };
        throw conflict('This credit was already used on another order', { orderId: h.order_id });
      }
      if (h.state === 'released') return { hold: await this.lateCapture(tx, acct, h, orderId, out), currency: acct.currency };
      const state = creditHoldMachine.next('held', 'capture');
      const a = await tx.updateAccount(acct.customer_id, { available: acct.available, held: acct.held - h.amount, updated_at: this.core.now() });
      const captured = await tx.updateHold(h.id, { state, order_id: orderId });
      const held = await tx.entryOfHold(h.id, 'hold');
      await tx.insertEntry(this.entryRow(a, { kind: 'capture', amount: -h.amount, allocations: held ? allocationsOf(held) : [], key: `capture:${h.id}`, actor: by.actor, orderId, holdId: h.id }));
      out.push('wallet.credit.used', { customerId: a.customer_id, orderId, amount: m(h.amount, a.currency) });
      return { hold: captured, currency: a.currency };
    });
    this.core.flush(out, by);
    return toHold(hold, currency);
  }

  /**
   * The order was accepted with a store-credit tender whose hold had already been released: the hold reached its
   * expiry while the payment was being checked (PENDING_CHECK_HOLD_HOURS) and the check then ended accepted. (A
   * declined payment no longer gets here: checkout drops the released hold and holds the credit again on the retry.)
   * The released hold stays released; the credit is reserved and used again as a new hold for the same checkout,
   * captured at once, so the tender payments counted is really paid.
   */
  private async lateCapture(tx: WalletRepository, acct: AccountRow, released: HoldRow, orderId: string, out: Outbox): Promise<HoldRow> {
    const key = `recapture:${released.id}`;
    const done = await tx.holdByKey(key);
    if (done) {
      if (done.order_id === orderId) return done;
      throw conflict('This credit was already used on another order', { orderId: done.order_id });
    }
    let a = await this.expireDue(tx, acct, out);
    const allocations = await this.drawLots(tx, a, released.amount);
    const now = this.core.now();
    a = await tx.updateAccount(a.customer_id, { available: a.available - released.amount, held: a.held, updated_at: now });
    const h = await tx.insertHold({ id: newId(), customer_id: a.customer_id, quote_id: released.quote_id, order_id: orderId, amount: released.amount, state: creditHoldMachine.next('held', 'capture'), expires_at: now, idempotency_key: key });
    await tx.insertEntry(this.entryRow(a, { kind: 'capture', amount: -released.amount, allocations, key: `capture:${h.id}`, actor: SYSTEM, orderId, holdId: h.id, reason: 'Used after the checkout reservation had been released' }));
    out.push('wallet.credit.used', { customerId: a.customer_id, orderId, amount: m(released.amount, a.currency) });
    this.core.ctx.log.warn({ holdId: released.id, newHoldId: h.id, orderId }, 'wallet: captured credit of a released hold again for an accepted order');
    return h;
  }

  /** held → released (event release, or expire for the stale-hold job); a released hold answers as it is */
  async releaseHold(holdId: string, event: 'release' | 'expire' = 'release', by: By = { actor: SYSTEM }): Promise<CreditHold> {
    const h0 = await this.repo.getHold(holdId);
    if (!h0) throw notFound('Credit hold');
    const out = new Outbox();
    const { hold, currency } = await this.repo.transaction(async (tx) => {
      const acct = (await tx.lockAccount(h0.customer_id))!;
      const h = (await tx.getHold(holdId, { forUpdate: true }))!;
      if (h.state === 'released') return { hold: h, currency: acct.currency };
      const state = creditHoldMachine.next(h.state as 'held', event); // captured: ILLEGAL_TRANSITION (refunds return used credit)
      const held = await tx.entryOfHold(h.id, 'hold');
      const allocations = held ? allocationsOf(held) : [];
      await this.restoreLots(tx, allocations);
      let a = await tx.updateAccount(acct.customer_id, { available: acct.available + h.amount, held: acct.held - h.amount, updated_at: this.core.now() });
      await tx.insertEntry(this.entryRow(a, { kind: 'release', amount: 0, allocations, key: `release:${h.id}`, actor: by.actor, holdId: h.id, reason: event === 'expire' ? 'Checkout reservation expired' : 'Checkout reservation released' }));
      const released = await tx.updateHold(h.id, { state });
      a = await this.expireDue(tx, a, out);
      return { hold: released, currency: a.currency };
    });
    this.core.flush(out, by);
    return toHold(hold, currency);
  }

  /** orders.order.placed: capture the checkout's live hold for an accepted order; a payment being checked keeps it, linked to the order */
  async onOrderPlaced(e: { orderId: string; checkoutSessionId: string; customerId?: string | null; paymentState: 'accepted' | 'pending_check'; placedAt: string }) {
    const live = await this.repo.liveHoldOfQuote(e.checkoutSessionId);
    if (!live) return; // no credit on this checkout, or checkout/payments captured or released it already
    if (e.customerId && live.customer_id !== e.customerId) {
      this.core.ctx.log.warn({ holdId: live.id, orderId: e.orderId }, 'wallet: placed order and credit hold belong to different customers');
      return;
    }
    if (e.paymentState === 'accepted') {
      await this.captureHold(live.id, e.orderId);
      return;
    }
    // payment being checked: the hold waits for the outcome (payments.payment.failed releases it; checkout captures on acceptance)
    await this.repo.transaction(async (tx) => {
      const h = await tx.getHold(live.id, { forUpdate: true });
      if (h?.state !== 'held') return;
      const ttl = PENDING_CHECK_HOLD_HOURS * 3_600_000;
      const until = new Date(Math.max(h.expires_at.getTime(), new Date(e.placedAt).getTime() + ttl));
      await tx.updateHold(h.id, { order_id: e.orderId, expires_at: until });
    });
  }

  /** payments.payment.failed: release the checkout's live hold */
  async onPaymentFailed(e: { checkoutSessionId: string; orderId?: string | null }) {
    const live = await this.repo.liveHoldOfQuote(e.checkoutSessionId);
    if (!live) return;
    try {
      await this.releaseHold(live.id);
    } catch (err) {
      this.core.ctx.log.warn({ err, holdId: live.id }, 'wallet: could not release the credit hold of a failed payment');
    }
  }

  /** Job wallet.release-stale-holds */
  async releaseStaleHolds(): Promise<{ released: number }> {
    let released = 0;
    const failed = new Set<string>();
    for (let round = 0; round < 50; round++) {
      const stale = (await this.repo.staleHolds(this.core.now(), BATCH)).filter((h) => !failed.has(h.id));
      if (!stale.length) break;
      for (const h of stale) {
        try {
          await this.releaseHold(h.id, 'expire');
          released++;
        } catch (err) {
          failed.add(h.id);
          this.core.ctx.log.error({ err, holdId: h.id }, 'wallet: stale credit hold not released');
        }
      }
      if (stale.length < BATCH) break;
    }
    return { released };
  }

  /**
   * held → held (extend): keeps a hold alive while its payment is pending check, so the capture after a slow
   * bank answer does not fail with INSUFFICIENT_CREDIT. Never shortens a hold; capped at pendingHoldMaxHours
   * after the hold was made (its `hold` ledger entry); a captured or released hold is returned unchanged.
   */
  async extendHold(holdId: string, until: string): Promise<CreditHold> {
    const wanted = until ? new Date(until) : new Date(Number.NaN);
    if (Number.isNaN(wanted.getTime())) throw invalid([{ path: 'until', message: 'Give a date and time' }]);
    const h0 = await this.repo.getHold(holdId);
    if (!h0) throw notFound('Credit hold');
    const maxHours = Number(await this.core.ctx.settings.get('pendingHoldMaxHours')) || 48;
    const { hold, currency } = await this.repo.transaction(async (tx) => {
      const acct = await tx.lockAccount(h0.customer_id);
      const h = (await tx.getHold(holdId, { forUpdate: true }))!;
      const currency = acct?.currency ?? this.core.currency;
      if (h.state !== 'held') return { hold: h, currency };
      const made = (await tx.entryOfHold(h.id, 'hold'))?.at ?? h.expires_at;
      const target = Math.min(wanted.getTime(), made.getTime() + maxHours * 3_600_000);
      if (target <= h.expires_at.getTime()) return { hold: h, currency };
      const state = creditHoldMachine.next('held', 'extend');
      return { hold: await tx.updateHold(h.id, { state, expires_at: new Date(target) }), currency };
    });
    return toHold(hold, currency);
  }

  /** Credit outstanding over all accounts (now, or rebuilt from the ledger at asOf), for finance's store_credit check */
  async liabilityTotal(asOf?: string): Promise<{ available: common.Money; held: common.Money; accounts: number }> {
    const currency = this.core.currency;
    if (asOf) {
      const at = new Date(asOf);
      if (Number.isNaN(at.getTime())) throw invalid([{ path: 'asOf', message: 'Give a date and time' }]);
      if (at.getTime() < this.core.now().getTime()) {
        const r = await this.repo.liabilityAt(at);
        return { available: m(r.total - r.held, currency), held: m(r.held, currency), accounts: r.accounts };
      }
    }
    const r = await this.repo.liabilityNow();
    return { available: m(r.available, currency), held: m(r.held, currency), accounts: r.accounts };
  }

  /* ================================================================ refunds to credit */

  async creditRefund(input: { customerId: string; refundId: string; orderId: string; amount: common.Money; reason: string }, idempotencyKey: string, by: By = { actor: SYSTEM }): Promise<LedgerEntry> {
    const issues = this.core.checkMoney(input.amount, 'amount');
    if (!input.customerId) issues.push({ path: 'customerId', message: 'Required' });
    if (!input.refundId) issues.push({ path: 'refundId', message: 'Required' });
    if (!idempotencyKey?.trim()) issues.push({ path: 'idempotencyKey', message: 'Required' });
    if (issues.length) throw invalid(issues);
    const primary = (rows: EntryRow[]) => rows.find((r) => r.kind === 'refund_to_credit') ?? rows[0]!;
    const sameRefund = async (rows: EntryRow[]) => {
      const total = rows.reduce((s, r) => s + r.amount, 0);
      if (rows[0]!.customer_id !== input.customerId || total !== input.amount.amount) throw conflict('This refund was already credited with a different amount', { refundId: input.refundId });
      return (await this.entryViews([primary(rows)], { staff: true }))[0]!;
    };
    const known = await this.repo.entriesOfRefund(input.refundId);
    if (known.length) return sameRefund(known);
    const byKey = await this.repo.entryByKey(idempotencyKey);
    if (byKey) {
      if (byKey.refund_id !== input.refundId) throw conflict('This key was already used for another refund');
      return sameRefund(await this.repo.entriesOfRefund(input.refundId));
    }
    const orderRef = input.orderId ? (await this.core.orderRefs([input.orderId])).get(input.orderId) : undefined;
    const reference = orderRef ? `order ${orderRef}` : null;
    const out = new Outbox();
    const rows = await this.repo.transaction(async (tx) => {
      let acct = await tx.lockOrCreateAccount(input.customerId, input.amount.currency, this.core.now());
      const again = await tx.entriesOfRefund(input.refundId);
      if (again.length) return again;
      if (acct.currency !== input.amount.currency) throw invalid([{ path: 'amount.currency', message: `Store credit is in ${acct.currency}` }]);
      // the credit part of the order comes back first (kind order_refund_returned), the rest is a refund to credit
      const usage = input.orderId ? await tx.orderCredit(input.customerId, input.orderId) : { used: 0, returned: 0 };
      const back = Math.min(input.amount.amount, Math.max(0, usage.used - usage.returned));
      const parts: [WalletCreditGrantedEvent['kind'] & EntryKind, number][] = [
        ['order_refund_returned', back],
        ['refund_to_credit', input.amount.amount - back],
      ];
      const created: EntryRow[] = [];
      for (const [kind, amount] of parts) {
        if (amount <= 0) continue;
        const r = await this.addCredit(tx, acct, { kind, source: 'refund', amount, expiresAt: null, reference, orderId: input.orderId, refundId: input.refundId, key: created.length ? `${idempotencyKey}:${kind}` : idempotencyKey, actor: by.actor, reason: input.reason });
        acct = r.acct;
        created.push(r.entry);
        out.push('wallet.credit.granted', { customerId: input.customerId, entryId: r.entry.id, kind, amount: m(amount, acct.currency), chargedTo: null, sellerId: null, caseId: null, orderId: input.orderId });
      }
      return created;
    });
    this.core.flush(out, by);
    return (await this.entryViews([primary(rows)], { staff: true }))[0]!;
  }

  /* ================================================================ staff corrections */

  /** Positive: a new lot (source correction). Negative: drawn from lots like a use; INSUFFICIENT_CREDIT below zero */
  async applyCorrection(customerId: string, amount: common.Money, reason: string, reference: string | null, key: string, by: By): Promise<EntryRow> {
    const known = await this.repo.entryByKey(key);
    if (known) return known;
    const out = new Outbox();
    let created = false;
    const entry = await this.repo.transaction(async (tx) => {
      const again = await tx.entryByKey(key);
      if (again) return again;
      created = true;
      if (amount.amount > 0) {
        const acct = await tx.lockOrCreateAccount(customerId, amount.currency, this.core.now());
        const r = await this.addCredit(tx, acct, { kind: 'correction', source: 'correction', amount: amount.amount, expiresAt: null, reference, key, actor: by.actor, reason });
        return r.entry;
      }
      const acct = await tx.lockAccount(customerId);
      if (!acct) throw this.core.insufficient(0, amount.currency);
      let a = await this.expireDue(tx, acct, out);
      const take = -amount.amount;
      const allocations = await this.drawLots(tx, a, take);
      a = await tx.updateAccount(customerId, { available: a.available - take, held: a.held, updated_at: this.core.now() });
      return tx.insertEntry(this.entryRow(a, { kind: 'correction', amount: amount.amount, allocations, key, actor: by.actor, reason: reference ? `${reason} (${reference})` : reason }));
    });
    if (created) out.push('wallet.credit.corrected', { customerId, entryId: entry.id, amount: m(entry.amount, amount.currency), reason });
    this.core.flush(out, by);
    return entry;
  }

  /* ================================================================ expiry */

  /** Job wallet.expire-lots: expire due lots (per customer, in batches), then publish wallet.credit.expiring for lots at a reminder day */
  async expireLots(): Promise<{ expiredCustomers: number; reminders: number }> {
    const done = new Set<string>();
    for (let round = 0; round < 50; round++) {
      const customers = (await this.repo.customersWithDueLots(this.core.now(), BATCH)).filter((c) => !done.has(c));
      if (!customers.length) break;
      for (const customerId of customers) {
        done.add(customerId);
        const out = new Outbox();
        try {
          await this.repo.transaction(async (tx) => {
            const acct = await tx.lockAccount(customerId);
            if (acct) await this.expireDue(tx, acct, out);
          });
          this.core.flush(out);
        } catch (err) {
          this.core.ctx.log.error({ err, customerId }, 'wallet: credit expiry failed for a customer');
        }
      }
    }
    return { expiredCustomers: done.size, reminders: await this.remindExpiring() };
  }

  /**
   * wallet.credit.expiring for lots with credit left that reached one of expiryReminderDays (notifications
   * tells the customer). Once per lot and reminder day: the inbox key `credit-expiring:<lotId>:<day>` makes a
   * second run (or a run after a missed day) change nothing, and a lot gets the latest reminder it reached.
   */
  private async remindExpiring(): Promise<number> {
    const days = reminderDays(await this.core.ctx.settings.get('expiryReminderDays'));
    const now = this.core.now();
    const to = new Date(now.getTime() + days[0]! * DAY + 1);
    const currencies = new Map<string, string>();
    let from = now;
    let published = 0;
    for (let round = 0; round < 50; round++) {
      const lots = await this.repo.lotsExpiringBetween(from, to, 1_000);
      for (const lot of lots) {
        const left = daysLeft(lot.expires_at!, now);
        const day = dueReminder(left, days);
        if (day === null) continue;
        const claimed = await this.repo.transaction((tx) => tx.claim(`credit-expiring:${lot.id}:${day}`));
        if (!claimed) continue;
        if (!currencies.has(lot.customer_id)) currencies.set(lot.customer_id, (await this.repo.getAccount(lot.customer_id))?.currency ?? this.core.currency);
        this.core.ctx.events.publish('wallet.credit.expiring', {
          customerId: lot.customer_id,
          lotId: lot.id,
          amount: m(lot.remaining, currencies.get(lot.customer_id)!),
          expiresAt: lot.expires_at!.toISOString(),
          daysLeft: left,
        });
        published++;
      }
      if (lots.length < 1_000) break;
      const last = lots.at(-1)!.expires_at!;
      if (last.getTime() === from.getTime()) break;
      from = last;
    }
    return published;
  }

  /* ================================================================ balance check */

  /** Job wallet.balance-check: every account against its ledger, lots and holds; differences are logged, audited and (ledger vs balance) reported to finance */
  async balanceCheck(): Promise<{ checked: number; differences: number }> {
    let after: string | null = null;
    let checked = 0;
    const differences: Record<string, unknown>[] = [];
    for (;;) {
      const rows = await this.repo.balanceSnapshots(after, BATCH);
      for (const r of rows) {
        checked++;
        const problems: string[] = [];
        if (r.ledgerSum !== r.available + r.held) problems.push(`ledger sum ${r.ledgerSum} ≠ balance ${r.available + r.held}`);
        if (r.lotsSum !== r.available) problems.push(`lots ${r.lotsSum} ≠ available ${r.available}`);
        if (r.holdsSum !== r.held) problems.push(`holds ${r.holdsSum} ≠ held ${r.held}`);
        if (problems.length) differences.push({ ...r, problems });
      }
      if (rows.length < BATCH) break;
      after = rows.at(-1)!.customerId;
    }
    if (differences.length) {
      this.core.ctx.log.error({ differences }, 'wallet: store credit balances differ from the ledger');
      await this.reportToFinance(differences as unknown as BalanceSnapshot[]);
      for (const d of differences) {
        await this.core.audit(
          {
            action: 'wallet.balance_check.difference',
            actionLabel: 'Store credit balance differs from its ledger',
            category: 'financial',
            target: { type: 'wallet_account', id: String(d.customerId), label: 'Store credit account' },
            reason: (d.problems as string[]).join('; '),
            after: d,
          },
          { actor: SYSTEM },
        );
      }
    }
    return { checked, differences: differences.length };
  }

  /**
   * Each account whose balance differs from its ledger sum goes to Finance's daily check
   * (finance.recordExternalDifference, check store_credit, key customer id + market date; expected = ledger sum,
   * actual = balance). Without finance the log and audit entries above are the record.
   */
  private async reportToFinance(rows: readonly BalanceSnapshot[]) {
    const finance = this.core.ctx.tryUse('finance');
    if (!finance) return;
    const date = dateInZone(this.core.now(), this.core.ctx.config.market.timeZone);
    for (const r of rows) {
      const balance = r.available + r.held;
      if (r.ledgerSum === balance) continue;
      try {
        await finance.recordExternalDifference({
          check: 'store_credit',
          subject: `Store credit account ${r.customerId}`,
          description: `Store credit balance ${this.core.fmt(balance)} differs from its ledger sum ${this.core.fmt(r.ledgerSum)}`,
          expected: m(r.ledgerSum, this.core.currency),
          actual: m(balance, this.core.currency),
          key: `${r.customerId}:${date}`,
        });
      } catch (err) {
        this.core.ctx.log.error({ err, customerId: r.customerId }, 'wallet: balance difference not reported to finance');
      }
    }
  }

  /* ================================================================ reads */

  async balance(customerId: string): Promise<CreditBalance> {
    const [acct, lots] = await Promise.all([this.repo.getAccount(customerId), this.repo.usableLots(customerId, this.core.now())]);
    const currency = acct?.currency ?? this.core.currency;
    const available = lots.reduce((s, l) => s + l.remaining, 0);
    const soonest = lots.find((l) => l.expires_at);
    return {
      customerId,
      available: m(available, currency),
      held: m(acct?.held ?? 0, currency),
      nextExpiry: soonest ? { amount: m(lots.filter((l) => l.expires_at?.getTime() === soonest.expires_at!.getTime()).reduce((s, l) => s + l.remaining, 0), currency), expiresAt: soonest.expires_at!.toISOString() } : null,
      usableOn: USABLE_ON,
    };
  }

  /** Lots with credit left, earliest-expiring first */
  async lots(customerId: string): Promise<CreditLot[]> {
    const [acct, lots] = await Promise.all([this.repo.getAccount(customerId), this.repo.usableLots(customerId, this.core.now())]);
    return lots.map((l) => toLot(l, acct?.currency ?? this.core.currency));
  }

  async recent(customerId: string, limit: number, o: { staff: boolean }): Promise<LedgerEntry[]> {
    const rows = await this.repo.recentEntries(customerId, Math.max(1, Math.min(limit, 50)), o.staff ? undefined : RESERVATION_KINDS);
    return this.entryViews(rows, o);
  }

  async overview(customerId: string): Promise<WalletOverview> {
    const [balance, lots, recent, giftCards] = await Promise.all([this.balance(customerId), this.lots(customerId), this.recent(customerId, 5, { staff: false }), this.core.ctx.settings.get('giftCardsEnabled')]);
    return { balance, lots, recent, giftCardsEnabled: Boolean(giftCards), howToUse: HOW_TO_USE };
  }

  async entriesPage(customerId: string, f: { kind?: string }, page: PageRequest, o: { staff: boolean }): Promise<common.Page<LedgerEntry>> {
    const p = await this.repo.entriesPage(customerId, { kinds: f.kind ? f.kind.split(',').map((k) => k.trim()).filter(Boolean) : undefined, excludeKinds: o.staff ? undefined : RESERVATION_KINDS }, page);
    return { ...p, items: await this.entryViews(p.items, o) };
  }

  /** Entries with their labels: order refs (orders), lot references and goodwill reasons, case refs */
  async entryViews(rows: readonly EntryRow[], o: { staff: boolean }): Promise<LedgerEntry[]> {
    if (!rows.length) return [];
    const currency = (await this.repo.getAccount(rows[0]!.customer_id))?.currency ?? this.core.currency;
    const firstLots = rows.map((r) => allocationsOf(r)[0]?.lotId).filter((x): x is string => Boolean(x));
    const grantEntries = rows.filter((r) => r.kind === 'goodwill' || r.kind === 'price_adjustment').map((r) => r.id);
    const [orderRefs, lots, grants] = await Promise.all([this.core.orderRefs(rows.map((r) => r.order_id)), this.repo.getLots(firstLots), this.repo.grantsOfEntries(grantEntries)]);
    const caseRefs = await this.core.caseRefs(rows.filter((r) => r.case_id && r.order_id).map((r) => ({ caseId: r.case_id, orderId: r.order_id })));
    const facts: EntryFacts = {
      orderRefs,
      lotRefs: new Map(lots.map((l) => [l.id, l.reference])),
      reasonCodes: new Map(grants.map((g) => [g.ledger_entry_id!, g.reason_code])),
      caseRefs,
    };
    return rows.map((r) => toEntry(r, currency, facts, o));
  }

  async entryView(row: EntryRow): Promise<LedgerEntry> {
    return (await this.entryViews([row], { staff: true }))[0]!;
  }
}
