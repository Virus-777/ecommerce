/**
 * The store-credit tender of a mixed payment (phase 3, wallet). Checkout holds the credit (wallet.holdCredit) and the
 * hold is used when the order is placed with an accepted payment (wallet and checkout call captureHold). From then on
 * the credit counts as paid for the order next to what the card was charged:
 *   - a refund gives the credit back first (wallet.creditRefund) and only the rest goes to the card or new method;
 *   - an order cancelled before its card was charged gets the credit back;
 *   - the card is charged the order total minus the credit, and credit beyond the order total goes back.
 *
 * What went back is kept per refund (or per cancellation) on the tender itself, reserved under the intent lock before
 * wallet is called, so concurrent refunds never give the same credit back twice and a retried refund sends the same
 * split again.
 */
import { createHash } from 'node:crypto';
import { ACCEPTED, is } from '../domain/rules.js';
import type { CreditReturn, IntentRec, PaymentsRepository, StoredTender } from '../ports.js';
import { notFound, type Core } from './core.js';

/** Credit given back outside a refund: the order was cancelled before its card was charged */
export const CANCELLED_KEY = 'order_cancelled';
/** Credit given back outside a refund: items were cancelled before the card was charged and the credit was more than the order */
export const EXCESS_KEY = 'order_excess';
export const refundKey = (refundId: string) => `refund:${refundId}`;

/** A stable UUID from a name (wallet refund ids of credit returns that are not refunds) */
function stableUuid(name: string): string {
  const h = createHash('sha256').update(name).digest('hex').split('');
  h[12] = '5';
  h[16] = '89ab'[parseInt(h[16]!, 16) % 4]!;
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

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

  /** Credit that can still go back */
  left(i: IntentRec): number {
    return Math.max(0, this.paid(i) - this.returned(i));
  }

  /**
   * The credit share of `key` (a refund, or a cancellation): what was reserved for it before, else up to `wanted` of
   * the credit left, reserved now under the intent lock.
   */
  async reserve(intentId: string, key: string, wanted: number): Promise<CreditReturn> {
    return this.repo.transaction(async (tx) => {
      const i = await tx.get('intents', intentId, { forUpdate: true });
      if (!i) throw notFound();
      const t = this.tender(i);
      if (!t) return { amount: 0, sent: true };
      const known = t.creditReturns?.[key];
      if (known) return known;
      const amount = Math.min(Math.max(0, wanted), this.left(i));
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

  /** Reserves and gives back credit outside a refund (cancellation, excess); logs instead of throwing (event consumers) */
  async returnOutsideRefund(i: IntentRec, key: string, amount: number, reason: string): Promise<number> {
    if (amount <= 0) return 0;
    const share = await this.reserve(i.id, key, amount);
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
