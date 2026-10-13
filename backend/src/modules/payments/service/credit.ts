/**
 * The store-credit tender of a mixed payment (phase 3, wallet). Checkout holds the credit (wallet.holdCredit) and the
 * hold is used when the order is placed with an accepted payment (wallet and checkout call captureHold). From then on
 * the credit counts as paid for the order next to what the card is charged.
 *
 * Each seller group's allocation is split into a card share and a store-credit share in proportion to the tenders
 * (credit × amount ÷ payment amount; the last uncharged part takes what is left, so the shares add up to the credit
 * exactly). A capture charges the card only its card share and keeps its credit share (captureCredits, reported as
 * creditAmount on payments.payment.captured). The credit is in three pools:
 *   - not charged yet (`unallocated`): the share of the groups not captured. Items cancelled before the capture give
 *     their share back (wallet.creditRefund, keyed by the item); an order cancelled before it was charged in full gives
 *     back what is left; credit beyond what is left of the order after cancellations goes back too (excess);
 *   - charged (`taken`): the credit shares of the captures, which refunds give back first (`refundable`);
 *   - given back: per refund, item, cancellation or excess (creditReturns).
 * Payments captured before the shares were kept (and payments paid only with credit) count all their credit as
 * charged, as before.
 *
 * What went back is kept per key on the tender itself, reserved under the intent lock before wallet is called, so
 * concurrent refunds or cancellations never give the same credit back twice and a retry sends the same share again.
 */
import { createHash } from 'node:crypto';
import { ACCEPTED, is } from '../domain/rules.js';
import type { CaptureCredit, CreditReturn, IntentRec, StoredTender } from '../ports.js';
import type { PaymentsRepository } from '../repository.js';
import { notFound, type Core } from './core.js';

/** Credit given back outside a refund: the order was cancelled before its card was charged (in full) */
export const CANCELLED_KEY = 'order_cancelled';
/** Credit given back outside a refund: items were cancelled before the card was charged and the credit was more than the order */
export const EXCESS_KEY = 'order_excess';
export const refundKey = (refundId: string) => `refund:${refundId}`;
/** Credit share of an item cancelled before it was charged */
export const itemKey = (orderItemId: string) => `item:${orderItemId}`;

/** Which credit a reservation draws from: what was charged (refunds) or what was not charged yet (cancellations) */
export type CreditPool = 'refund' | 'uncharged';

/** A stable UUID from a name (wallet refund ids of credit returns that are not refunds) */
function stableUuid(name: string): string {
  const h = createHash('sha256').update(name).digest('hex').split('');
  h[12] = '5';
  h[16] = '89ab'[parseInt(h[16]!, 16) % 4]!;
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

const sum = (xs: Iterable<number>) => [...xs].reduce((s, x) => s + x, 0);

export class Credit {
  constructor(private readonly core: Core) {}

  private get repo() {
    return this.core.repo;
  }

  tender(i: IntentRec): StoredTender | undefined {
    return i.tenders.find((t) => t.kind === 'store_credit' && t.amount.amount > 0);
  }

  /** What the card (or digital wallet) pays */
  card(i: IntentRec): number {
    return i.tenders.filter((t) => t.kind !== 'store_credit').reduce((s, t) => s + t.amount.amount, 0);
  }

  /** Credit that paid for the order: an order exists and its payment was accepted (voided: accepted, then released) */
  paid(i: IntentRec): number {
    const t = this.tender(i);
    return t && i.order_id && (is(ACCEPTED, i.status) || i.status === 'voided') ? t.amount.amount : 0;
  }

  /**
   * Credit already given back (reserved or sent). `notRefunds`: only what went back outside the refunds that still
   * count against the payment, i.e. cancellations, excess, and refunds cancelled after their credit part was sent.
   */
  returned(i: IntentRec, o: { notRefunds?: boolean; cancelledRefunds?: ReadonlySet<string> } = {}): number {
    return Object.entries(this.tender(i)?.creditReturns ?? {})
      .filter(([key]) => !o.notRefunds || !key.startsWith('refund:') || Boolean(o.cancelledRefunds?.has(key.slice('refund:'.length))))
      .reduce((s, [, r]) => s + r.amount, 0);
  }

  /** Credit given back outside refunds: cancelled items, the order cancellation, excess */
  outside(i: IntentRec): number {
    return sum(Object.entries(this.tender(i)?.creditReturns ?? {}).filter(([key]) => !key.startsWith('refund:')).map(([, r]) => r.amount));
  }

  /** Credit shares of the captures, null when none was kept (captured before shares were kept, or not captured yet) */
  private shares(i: IntentRec): Record<string, CaptureCredit> | null {
    const s = this.tender(i)?.captureCredits;
    return s && Object.keys(s).length ? s : null;
  }

  /** The credit share of one capture */
  shareOf(i: IntentRec, captureId: string): number {
    return this.tender(i)?.captureCredits?.[captureId]?.amount ?? 0;
  }

  /** Credit charged with one group's captures */
  groupShare(i: IntentRec, groupId: string): number {
    return sum(Object.values(this.tender(i)?.captureCredits ?? {}).filter((c) => c.groupId === groupId).map((c) => c.amount));
  }

  /** Credit that counts as charged for the order: the capture shares (or, without shares, all credit still used) */
  taken(i: IntentRec): number {
    const s = this.shares(i);
    return s ? sum(Object.values(s).map((c) => c.amount)) : Math.max(0, this.paid(i) - this.outside(i));
  }

  /** Credit of the groups not charged yet (less what went back for cancelled items) */
  unallocated(i: IntentRec): number {
    const paid = this.paid(i);
    if (!paid) return 0;
    const s = this.shares(i);
    if (s) return Math.max(0, paid - this.outside(i) - sum(Object.values(s).map((c) => c.amount)));
    // captured before shares were kept: all of the credit was charged with it
    if (i.captured_amount > 0 || i.status === 'captured') return 0;
    return Math.max(0, paid - this.outside(i));
  }

  /** Credit refunds can still give back: what was charged less what refunds gave back */
  refundable(i: IntentRec): number {
    const byRefunds = this.returned(i) - this.outside(i);
    return Math.max(0, this.taken(i) - byRefunds);
  }

  /** Credit that can still go back (any pool) */
  left(i: IntentRec): number {
    return Math.max(0, this.paid(i) - this.returned(i));
  }

  /**
   * The credit share of `amount` of the payment (credit × amount ÷ payment amount, rounded half up). `last`: nothing
   * else is left to charge, so the share is all the credit not charged yet.
   */
  proportional(i: IntentRec, amount: number, last: boolean): number {
    if (last) return this.unallocated(i);
    return Math.min(this.ratio(i, amount), Math.max(0, amount), this.unallocated(i));
  }

  /** credit × amount ÷ payment amount, rounded half up, in exact integer arithmetic */
  ratio(i: IntentRec, amount: number): number {
    const credit = this.tender(i)?.amount.amount ?? 0;
    if (!credit || amount <= 0) return 0;
    const total = BigInt(Math.max(1, i.amount));
    return Number((BigInt(credit) * BigInt(amount) * 2n + total) / (2n * total));
  }

  /** The tenders with the credit share of a capture recorded (inside the intent lock) */
  withShare(i: IntentRec, captureId: string, share: CaptureCredit | null): StoredTender[] {
    const t = this.tender(i);
    if (!t) return i.tenders;
    const { [captureId]: _old, ...rest } = t.captureCredits ?? {};
    const captureCredits = share && share.amount > 0 ? { ...rest, [captureId]: share } : rest;
    return i.tenders.map((x) => (x === t ? { ...t, captureCredits } : x));
  }

  /**
   * The credit share of `key` (a refund, a cancelled item, a cancellation): what was reserved for it before, else up
   * to `wanted` of the credit left in the pool, reserved now under the intent lock.
   */
  async reserve(intentId: string, key: string, wanted: number, pool: CreditPool = 'refund'): Promise<CreditReturn> {
    return this.repo.transaction(async (tx) => {
      const i = await tx.get('intents', intentId, { forUpdate: true });
      if (!i) throw notFound();
      const t = this.tender(i);
      if (!t) return { amount: 0, sent: true };
      const known = t.creditReturns?.[key];
      if (known) return known;
      const available = pool === 'refund' ? this.refundable(i) : this.unallocated(i);
      const amount = Math.min(Math.max(0, wanted), available, this.left(i));
      if (amount <= 0) return { amount: 0, sent: true };
      const share: CreditReturn = { amount, sent: false };
      await this.save(tx, i, t, { ...t.creditReturns, [key]: share });
      return share;
    });
  }

  /** A refund cancelled before its credit went back gives its reservation up */
  async unreserve(intentId: string, key: string): Promise<void> {
    await this.repo.transaction(async (tx) => {
      const i = await tx.get('intents', intentId, { forUpdate: true });
      const t = i ? this.tender(i) : undefined;
      const share = t?.creditReturns?.[key];
      if (!i || !t || !share || share.sent) return;
      const { [key]: _dropped, ...rest } = t.creditReturns!;
      await this.save(tx, i, t, rest);
    });
  }

  /** The share went back (wallet confirmed it) */
  async confirm(intentId: string, key: string): Promise<void> {
    await this.repo.transaction(async (tx) => {
      const i = await tx.get('intents', intentId, { forUpdate: true });
      const t = i ? this.tender(i) : undefined;
      const share = t?.creditReturns?.[key];
      if (!i || !t || !share || share.sent) return;
      await this.save(tx, i, t, { ...t.creditReturns, [key]: { ...share, sent: true } });
    });
  }

  private async save(tx: PaymentsRepository, i: IntentRec, t: StoredTender, creditReturns: Record<string, CreditReturn>) {
    await tx.update('intents', i.id, { tenders: i.tenders.map((x) => (x === t ? { ...t, creditReturns } : x)), updated_at: this.core.now() });
  }

  /**
   * Gives a reserved share back to the customer's store credit: the checkout's hold is used for the order first
   * (wallet.captureHold, idempotent; usually done at placement already), then credited back (wallet.creditRefund,
   * idempotent per refund id, which books it as the order's credit returned). Throws when wallet cannot do it; the
   * reservation stays, so a retry sends the same share. Returns the wallet ledger entry id.
   */
  async giveBack(i: IntentRec, key: string, share: CreditReturn, reason: string): Promise<string | null> {
    if (share.amount <= 0) return null;
    const wallet = this.core.ctx.tryUse('wallet');
    const t = this.tender(i);
    if (!wallet) throw this.core.error('PROVIDER_UNAVAILABLE', 'Store credit is not available right now');
    if (!t || !i.customer_id || !i.order_id) throw notFound('Store credit payment');
    if (t.creditHoldId) await wallet.captureHold(t.creditHoldId, i.order_id);
    const refundId = key.startsWith('refund:') ? key.slice('refund:'.length) : stableUuid(`${i.id}:${key}`);
    const entry = await wallet.creditRefund({ customerId: i.customer_id, refundId, orderId: i.order_id, amount: { amount: share.amount, currency: i.currency }, reason }, `payments:credit:${i.id}:${key}`);
    await this.confirm(i.id, key);
    return entry.id;
  }

  /**
   * Reserves and gives back credit not charged yet (cancelled item, cancellation, excess); logs instead of throwing
   * (event consumers). Returns the share that went back.
   */
  async returnOutsideRefund(i: IntentRec, key: string, amount: number, reason: string): Promise<number> {
    if (amount <= 0 && !this.tender(i)?.creditReturns?.[key]) return 0;
    const share = await this.reserve(i.id, key, amount, 'uncharged');
    if (share.sent) return share.amount;
    try {
      await this.giveBack((await this.repo.get('intents', i.id))!, key, share, reason);
      return share.amount;
    } catch (err) {
      // wallet is idempotent per refund id, so the next attempt (a redelivered event) can safely reserve and send again
      await this.unreserve(i.id, key);
      this.core.ctx.log.error({ err, intentId: i.id, key, amount: share.amount }, 'payments: store credit of the order could not be given back');
      return 0;
    }
  }
}
