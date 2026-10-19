/**
 * The seller ledger and company trading facts: sales at order acceptance (lots, fees), cancellations,
 * deliveries and the availability clock, refunds (including after payout), labels, carrier claims,
 * discount funding, ad charges and company costs. Balances, the ledger list and refund previews.
 */
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { LedgerEntry, Reference, RefundImpactPreview, SellerBalances } from '../../../spec/finance.js';
import type * as orders from '../../../spec/orders.js';
import { addDays, calculate, DAY, dayStart, detId, fmt, nextSlot, prorate, scheduleLabel, shortDate, TYPE_GROUPS, TYPE_LABELS, type EntryType } from '../domain/rules.js';
import { toEntry, toHold } from '../mappers.js';
import type { AccountRec, FeeChargeRec, FundingRec, LiabilityRec, LotRec, PlatformCostRec, TradingRec } from '../ports.js';
import type { FinanceRepository } from '../repository.js';
import { invalid, notFound, Outbox, Part, type Destination, type NewEntry } from './core.js';

type Item = orders.OrderItem;

const REFERENCE_KINDS: readonly Reference['kind'][] = ['order', 'order_item', 'return', 'refund', 'case', 'chargeback', 'payout', 'adjustment', 'ad_campaign', 'fulfillment_service', 'statement', 'seller', 'reconciliation'];

/**
 * Row ids of the trading and marketplace fact tables: detId('trading:<key>'), the same scheme the facts had while
 * they all lived in trading_entries (migration 0004 kept the ids), so a redelivered event adds nothing.
 */
const factId = (key: string) => detId(`trading:${key}`);
const walletEntry = (id: string) => (isUuid(id) ? id : null);

/** Rows by a key, each list in the order the rows came */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(key(r));
    if (list) list.push(r);
    else out.set(key(r), [r]);
  }
  return out;
}

export class LedgerPart extends Part {
  /* ---------------------------------------------------------------- lookups */

  async order(orderId: string): Promise<orders.OrderDetail | null> {
    try {
      return await this.ctx.use('orders').getOrder(orderId);
    } catch (err) {
      this.ctx.log.warn({ err, orderId }, 'finance: order lookup failed');
      return null;
    }
  }

  itemsOf(order: orders.OrderDetail): Item[] {
    return order.groups.flatMap((g) => g.items);
  }

  /** The lot of an order item, or of the line it was split from */
  async lotOf(itemId: string, order?: orders.OrderDetail | null, repo: FinanceRepository = this.repo): Promise<LotRec | undefined> {
    if (!isUuid(itemId)) return undefined;
    const lot = await repo.findOne('earnings_lots', { order_item_id: itemId });
    if (lot) return lot;
    const item = order ? this.itemsOf(order).find((i) => i.id === itemId) : undefined;
    if (item?.splitFromItemId) return this.lotOf(item.splitFromItemId, order, repo);
    return undefined;
  }

  /** Seller- and platform-funded discount on an item (promotions' split; the order's allocations otherwise) */
  async discountSplit(item: Item): Promise<{ seller: number; platform: number }> {
    const split = await this.core.optional('promotions', (p) => p.fundingSplitFor(item.id));
    if (split && split.sellerFunded.amount + split.platformFunded.amount > 0) return { seller: split.sellerFunded.amount, platform: split.platformFunded.amount };
    let seller = 0;
    let platform = 0;
    for (const d of item.discounts ?? []) {
      if (d.fundedBy === 'seller') seller += d.amount.amount;
      else if (d.fundedBy === 'platform') platform += d.amount.amount;
      else {
        const half = Math.floor(d.amount.amount / 2);
        seller += half;
        platform += d.amount.amount - half;
      }
    }
    return { seller, platform };
  }

  /** Official Store (company) trading only; marketplace facts go to the tables below */
  async trading(tx: FinanceRepository, key: string, row: Omit<TradingRec, 'id' | 'currency'> & { currency?: string }) {
    if (!row.amount) return;
    await tx.insertIfAbsent('trading_entries', { ...row, id: factId(key), currency: row.currency ?? this.core.currency() });
  }

  /** A marketplace cost (positive) or recovery (negative) that is not Official Store trading */
  async platformCost(tx: FinanceRepository, key: string, row: Omit<PlatformCostRec, 'id' | 'currency' | 'order_item_id'> & { currency?: string; order_item_id?: string | null }) {
    if (!row.amount) return;
    await tx.insertIfAbsent('platform_costs', { order_item_id: null, ...row, id: factId(key), currency: row.currency ?? this.core.currency() });
  }

  /** One funder's part of a coupon discount (reversals negative) */
  async funding(tx: FinanceRepository, key: string, row: Omit<FundingRec, 'id' | 'currency'> & { currency?: string }) {
    if (!row.amount) return;
    await tx.insertIfAbsent('discount_funding', { ...row, id: factId(key), currency: row.currency ?? this.core.currency() });
  }

  /** A movement of the store credit liability */
  async liability(tx: FinanceRepository, key: string, row: Omit<LiabilityRec, 'id' | 'at'>) {
    if (!row.amount) return;
    await tx.insertIfAbsent('store_credit_liability', { ...row, id: factId(key), at: this.now() });
  }

  /* ---------------------------------------------------------------- orders.order.accepted */

  async onOrderAccepted(e: EventPayload<'orders.order.accepted'>) {
    const order = await this.order(e.orderId);
    if (!order) return void this.ctx.log.warn({ orderId: e.orderId }, 'finance: accepted order not found');
    const at = new Date(e.acceptedAt);
    const items = this.itemsOf(order);
    for (const g of e.groups) {
      const groupItems = g.itemIds.map((id) => items.find((i) => i.id === id)).filter((i): i is Item => Boolean(i));
      if (g.ownerType === 'official' || !g.sellerId) {
        await this.repo.transaction(async (tx) => {
          for (const item of groupItems) {
            const base = { at, order_id: order.id, order_item_id: item.id, variant_id: item.product?.variantId ?? null, ref_kind: 'order_item', ref_id: item.id };
            await this.trading(tx, `sale:${item.id}`, { ...base, kind: 'sale', amount: item.lineSubtotal.amount });
            const disc = (item.discounts ?? []).reduce((s, d) => s + d.amount.amount, 0);
            await this.trading(tx, `discount:${item.id}`, { ...base, kind: 'discount', amount: disc });
            // shipping charged to the customer recovers part of the company's shipping expense
            await this.trading(tx, `shipping_charged:${item.id}`, { ...base, kind: 'shipping_expense', amount: -item.shippingShare.amount });
          }
        });
        continue;
      }
      await this.postSales(g.sellerId, order, groupItems, at);
    }
  }

  async postSales(sellerId: string, order: orders.OrderDetail, items: Item[], at: Date) {
    const acct = await this.repo.findOne('seller_accounts', { seller_id: sellerId });
    const ruleRow = await this.core.ruleAt(at, acct?.fee_override_set_id);
    const rule = await this.core.ruleModel(ruleRow);
    const splits = new Map<string, { seller: number; platform: number }>();
    for (const item of items) splits.set(item.id, await this.discountSplit(item));
    const cur = this.core.currency();
    const out = new Outbox();
    await this.repo.transaction(async (tx) => {
      for (const item of items) {
        const split = splits.get(item.id)!;
        // category fee rates apply to the product category at purchase (the order item's snapshot)
        const calc = calculate(rule, { categoryId: item.categoryId ?? null, itemPrice: item.lineSubtotal.amount, sellerDiscount: split.seller, platformDiscount: split.platform, shippingCharged: item.shippingShare.amount }, cur);
        const lotId = detId(`lot:${item.id}`);
        await tx.insertIfAbsent('earnings_lots', { id: lotId, seller_id: sellerId, order_id: order.id, order_item_id: item.id, state: 'pending', gross: item.lineSubtotal.amount, fee: calc.fee.amount, net: 0, delivered_at: null, available_at: null, payout_id: null });
        const lot = (await tx.findOne('earnings_lots', { order_item_id: item.id }))!;
        if (lot.id !== lotId || lot.seller_id !== sellerId) continue;
        await tx.insertIfAbsent('fee_charges', { id: detId(`fee:${item.id}`), order_item_id: item.id, seller_id: sellerId, rule_set_id: ruleRow.id, basis_amount: calc.feeBasis.amount, rate_bps: calc.rateBps, fee: calc.fee.amount, refunded_fee: 0, status: 'charged', created_at: at });
        const ref = { kind: 'order' as const, id: order.id, label: order.ref };
        const what = `${item.title}${item.variantLabel ? ` (${item.variantLabel})` : ''} × ${item.quantity}`;
        const entries: NewEntry[] = [
          { key: `sale:${item.id}`, type: 'sale', amount: item.lineSubtotal.amount, bucket: 'pending', ref, description: what, lotId },
          { key: `sale_discount:${item.id}`, type: 'seller_discount', amount: -calc.sellerDiscount.amount, bucket: 'pending', ref, description: `Your discount on ${item.title}`, lotId },
        ];
        if (rule.platformDiscountsReduceFee) entries.push({ key: `sale_platform_discount:${item.id}`, type: 'seller_discount', amount: -calc.platformDiscount.amount, bucket: 'pending', ref, description: `Marketly-funded discount on ${item.title} (fee rule ${rule.version})`, lotId });
        entries.push(
          { key: `sale_shipping:${item.id}`, type: 'shipping_charge', amount: calc.shippingCharged.amount, bucket: 'pending', ref, description: `Shipping charged for ${item.title}`, lotId },
          { key: `sale_fee:${item.id}`, type: 'marketplace_fee', amount: -calc.fee.amount, bucket: 'pending', ref, description: `${(calc.rateBps / 100).toString()}% of ${fmt(calc.feeBasis.amount, cur)} ${rule.basis === 'after_seller_discounts' && calc.sellerDiscount.amount ? 'item price after your discount' : 'item price'}${rule.includeShipping ? ' (shipping included)' : ' (shipping excluded)'}`, lotId },
        );
        await this.core.post(tx, sellerId, entries, out);
      }
    });
    this.core.flush(out);
  }

  /* ---------------------------------------------------------------- orders.item.cancelled */

  async onItemCancelled(e: EventPayload<'orders.item.cancelled'>) {
    const at = this.now();
    if (e.ownerType === 'official' || !e.sellerId) {
      await this.repo.transaction(async (tx) => {
        const base = { at, order_id: e.orderId, order_item_id: e.itemId, variant_id: null, ref_kind: 'cancellation', ref_id: e.cancellationId };
        await this.trading(tx, `cancel_sale:${e.cancellationId}:${e.itemId}`, { ...base, kind: 'sale', amount: -e.refund.itemAmount.amount });
        await this.trading(tx, `cancel_discount:${e.cancellationId}:${e.itemId}`, { ...base, kind: 'discount', amount: -e.refund.discountShare.amount });
        await this.trading(tx, `cancel_shipping:${e.cancellationId}:${e.itemId}`, { ...base, kind: 'shipping_expense', amount: e.refund.shippingRefund.amount });
      });
      return;
    }
    let lot = await this.lotOf(e.itemId);
    if (!lot) lot = await this.lotOf(e.itemId, await this.order(e.orderId));
    if (!lot) return void this.ctx.log.warn({ itemId: e.itemId }, 'finance: cancelled item has no earnings lot');
    const out = new Outbox();
    await this.repo.transaction(async (tx) => {
      const l = (await tx.get('earnings_lots', lot!.id, { forUpdate: true }))!;
      const ruleRow = await this.feeRuleOf(tx, l);
      const rule = await this.core.ruleModel(ruleRow, tx);
      const totals = await this.lotTotals(tx, l.id);
      const itemAmount = Math.min(e.refund.itemAmount.amount, l.gross);
      if (itemAmount <= 0 && e.refund.shippingRefund.amount <= 0) return;
      const discountPart = prorate(-totals.seller_discount, itemAmount, totals.sale);
      const reversal = itemAmount - discountPart + Math.min(e.refund.shippingRefund.amount, totals.shipping_charge);
      const bucket = l.state === 'pending' ? 'pending' : 'available';
      const ref = { kind: 'order' as const, id: e.orderId, label: e.ref };
      const entries: NewEntry[] = [{ key: `cancel:${e.cancellationId}:${e.itemId}`, type: 'cancellation', amount: -reversal, bucket, ref, description: `Cancelled ${e.quantity} item${e.quantity === 1 ? '' : 's'} ${e.beforeDispatch ? 'before dispatch' : 'after dispatch'} (${e.reasonCode.replace(/_/g, ' ')})`, lotId: l.id }];
      const charge = await tx.findOne('fee_charges', { order_item_id: l.order_item_id });
      let feeBack = 0;
      // after dispatch (a package returned to sender) the fee follows the returns treatment
      if (charge && (e.beforeDispatch ? rule.treatment.cancellationBeforeDispatch === 'no_fee' : rule.treatment.returns === 'fee_returned_pro_rata')) {
        feeBack = Math.min(charge.fee - charge.refunded_fee, prorate(charge.fee, itemAmount, totals.sale || l.gross));
        if (itemAmount >= l.gross) feeBack = charge.fee - charge.refunded_fee;
        entries.push({ key: `cancel_fee:${e.cancellationId}:${e.itemId}`, type: 'fee_refund', amount: feeBack, bucket, ref, description: e.beforeDispatch ? 'No fee on items cancelled before dispatch' : 'Fee refunded on the returned item, in proportion to the refund', lotId: l.id });
      }
      const posted = await this.core.post(tx, l.seller_id, entries, out);
      if (!posted.length) return;
      if (charge && feeBack) await tx.update('fee_charges', charge.id, { refunded_fee: charge.refunded_fee + feeBack, status: charge.refunded_fee + feeBack >= charge.fee ? 'reversed' : charge.status });
      const fresh = (await tx.get('earnings_lots', l.id))!;
      const gross = Math.max(0, fresh.gross - itemAmount);
      await tx.update('earnings_lots', l.id, { gross, fee: fresh.fee - feeBack });
      if (gross === 0 && (fresh.state === 'pending' || fresh.state === 'available')) await this.core.moveLot(tx, { ...fresh, gross }, 'reverse', out);
    });
    this.core.flush(out);
  }

  async feeRuleOf(tx: FinanceRepository, lot: LotRec) {
    const charge = await tx.findOne('fee_charges', { order_item_id: lot.order_item_id });
    return (charge ? await tx.get('fee_rule_sets', charge.rule_set_id) : undefined) ?? (await tx.findOne('fee_rule_sets', { status: 'active' }))!;
  }

  /** Sum of a lot's entries by type */
  async lotTotals(tx: FinanceRepository, lotId: string): Promise<Record<EntryType, number>> {
    const rows = await tx.find('ledger_entries', { lot_id: lotId });
    const t = Object.fromEntries(Object.keys(TYPE_LABELS).map((k) => [k, 0])) as Record<EntryType, number>;
    for (const r of rows) t[r.type as EntryType] = (t[r.type as EntryType] ?? 0) + r.amount;
    return t;
  }

  /* ---------------------------------------------------------------- orders.item.delivered + finance.release-pending */

  async onItemDelivered(e: EventPayload<'orders.item.delivered'>) {
    if (e.ownerType === 'official' || !e.sellerId) return;
    let lot = await this.lotOf(e.itemId);
    if (!lot) lot = await this.lotOf(e.itemId, await this.order(e.orderId));
    if (!lot || lot.delivered_at || lot.state !== 'pending') return;
    const deliveredAt = new Date(e.deliveredAt);
    const days = (await this.core.num('availableAfterDeliveryDays', 7)) + (await this.newSellerExtraDays(lot.seller_id, deliveredAt));
    await this.repo.updateWhere('earnings_lots', { id: lot.id, delivered_at: null }, { delivered_at: deliveredAt, available_at: new Date(deliveredAt.getTime() + days * DAY) });
  }

  /** Extra hold days for an item delivered at `at` while the seller is in its new-seller period (seller account, set at approval) */
  async newSellerExtraDays(sellerId: string, at: Date): Promise<number> {
    const acct = await this.repo.findOne('seller_accounts', { seller_id: sellerId });
    if (!acct?.new_seller_until || !acct.new_seller_extra_days || acct.new_seller_until < this.core.today(at)) return 0;
    return acct.new_seller_extra_days;
  }

  /** Job finance.release-pending: lots past delivery + hold window become available (bounded batches, restartable) */
  async releasePending() {
    for (let round = 0; round < 20; round++) {
      const due = await this.repo.find('earnings_lots', { state: 'pending', available_at: { op: '<=', value: this.now() } }, { orderBy: [['available_at', 'asc']], limit: 200 });
      if (!due.length) return;
      for (const lot of due) {
        const out = new Outbox();
        await this.repo.transaction(async (tx) => {
          const l = await tx.get('earnings_lots', lot.id, { forUpdate: true });
          if (l?.state === 'pending') await this.core.moveLot(tx, l, 'makeAvailable', out);
        });
        this.core.flush(out);
      }
      if (due.length < 200) return;
    }
  }

  /* ---------------------------------------------------------------- refunds */

  async onRefundApproved(e: EventPayload<'returns.refund.approved'>) {
    const total = e.total.amount;
    let seller = e.sellerShare?.amount ?? null;
    let platform = e.platformShare?.amount ?? null;
    if (seller === null || platform === null) {
      const by = e.ownerType === 'official' ? 'official_store' : e.fundedBy;
      if (by === 'platform') [seller, platform] = [0, total];
      else if (by === 'shared') [seller, platform] = [Math.floor(total / 2), total - Math.floor(total / 2)];
      else if (by === 'official_store') [seller, platform] = [0, 0];
      else [seller, platform] = [total, 0];
    }
    await this.repo.insertIfAbsent('refund_allocations', {
      refund_request_id: e.refundRequestId,
      payment_refund_id: null,
      order_id: e.orderId,
      owner_type: e.ownerType,
      seller_id: e.sellerId ?? null,
      funded_by: e.fundedBy,
      seller_share: seller,
      platform_share: platform,
      breakdown: { ...e.breakdown, orderItemIds: e.orderItemIds, returnId: e.returnId ?? null, caseId: e.caseId ?? null, source: e.source, total: e.total } as never,
      applied_at: null,
    });
  }

  async onRefundSent(e: EventPayload<'payments.refund.sent'>) {
    await this.parts.recon.refundSent(e.refundId, e.amount.amount); // a refund listed after its final failure was sent after all
    if (['cancellation', 'correction', 'orphan_payment'].includes(e.origin)) return; // cancellations were reversed from orders.item.cancelled
    const alloc = (await this.repo.findOne('refund_allocations', { payment_refund_id: e.refundId })) ?? (e.originId && isUuid(e.originId) ? await this.repo.findOne('refund_allocations', { refund_request_id: e.originId }) : undefined);
    if (alloc?.applied_at && alloc.payment_refund_id && alloc.payment_refund_id !== e.refundId) return;
    const total = e.items.reduce((s, i) => s + i.amount.amount, 0) || e.amount.amount;
    const breakdown = (alloc?.breakdown ?? null) as { itemAmount?: common.Money; returnId?: string | null } | null;
    const label = e.ref;
    const out = new Outbox();
    const order = await this.order(e.orderId);
    for (const item of e.items) {
      if (!item.sellerId) {
        await this.repo.transaction((tx) => this.trading(tx, `return:${e.refundId}:${item.orderItemId}`, { at: new Date(e.sentAt), kind: 'return', amount: item.amount.amount, order_id: e.orderId, order_item_id: item.orderItemId, variant_id: null, ref_kind: 'refund', ref_id: e.refundId }));
        continue;
      }
      const sellerCharge = alloc ? prorate(alloc.seller_share, item.amount.amount, total) : item.amount.amount;
      const platformCharge = item.amount.amount - sellerCharge;
      const lot = await this.lotOf(item.orderItemId, order);
      await this.repo.transaction(async (tx) => {
        if (platformCharge > 0) await this.platformCost(tx, `platform_refund:${e.refundId}:${item.orderItemId}`, { at: new Date(e.sentAt), kind: 'refund', amount: platformCharge, order_id: e.orderId, order_item_id: item.orderItemId, ref_kind: 'refund', ref_id: e.refundId });
        const l = lot ? await tx.get('earnings_lots', lot.id, { forUpdate: true }) : undefined;
        const ref: NewEntry['ref'] = breakdown?.returnId ? { kind: 'return', id: breakdown.returnId, label } : { kind: 'refund', id: e.refundId, label };
        if (!l) {
          await this.core.post(tx, item.sellerId!, [{ key: `refund:${e.refundId}:${item.orderItemId}`, type: 'refund', amount: -sellerCharge, bucket: 'available', ref, description: `${item.title} · refund` }], out);
          return;
        }
        const totals = await this.lotTotals(tx, l.id);
        const itemShare = breakdown?.itemAmount ? prorate(breakdown.itemAmount.amount, item.amount.amount, total) : item.amount.amount;
        const itemAmount = Math.min(l.gross, Math.max(0, itemShare));
        const payout = l.payout_id ? await tx.get('payouts', l.payout_id) : undefined;
        const afterPayout = l.state === 'paid_out' || (l.state === 'in_payout' && Boolean(payout && ['processing', 'paid'].includes(payout.status)));
        const full = itemAmount >= l.gross;
        const bucket = l.state === 'pending' ? 'pending' : 'available';
        const entries: NewEntry[] = [
          {
            key: `refund:${e.refundId}:${item.orderItemId}`,
            type: afterPayout ? 'refund_after_payout' : 'refund',
            amount: -sellerCharge,
            bucket,
            ref,
            description: `${item.title} · ${full ? 'full' : 'partial'} refund${afterPayout ? ` after payout${payout ? ` (paid out in ${payout.ref})` : ''}` : ''}${platformCharge > 0 ? `; ${fmt(platformCharge, e.amount.currency)} funded by Marketly` : ''}`,
            lotId: l.id,
          },
        ];
        const charge = await tx.findOne('fee_charges', { order_item_id: l.order_item_id });
        const rule = await this.core.ruleModel(await this.feeRuleOf(tx, l), tx);
        let feeBack = 0;
        if (charge && rule.treatment.returns === 'fee_returned_pro_rata') {
          feeBack = full ? charge.fee - charge.refunded_fee : Math.min(charge.fee - charge.refunded_fee, prorate(charge.fee, itemAmount, totals.sale || l.gross));
          entries.push({ key: `refund_fee:${e.refundId}:${item.orderItemId}`, type: 'fee_refund', amount: feeBack, bucket, ref, description: 'Fee refunded on the returned item, in proportion to the refund', lotId: l.id });
        }
        const posted = await this.core.post(tx, l.seller_id, entries, out);
        if (!posted.length) return;
        if (charge && feeBack) await tx.update('fee_charges', charge.id, { refunded_fee: charge.refunded_fee + feeBack, status: charge.refunded_fee + feeBack >= charge.fee ? 'reversed' : charge.status });
        const fresh = (await tx.get('earnings_lots', l.id))!;
        const gross = Math.max(0, fresh.gross - itemAmount);
        await tx.update('earnings_lots', l.id, { gross, fee: fresh.fee - feeBack });
        if (gross === 0 && (fresh.state === 'pending' || fresh.state === 'available')) await this.core.moveLot(tx, { ...fresh, gross }, 'reverse', out);
      });
    }
    if (alloc) await this.repo.updateWhere('refund_allocations', { refund_request_id: alloc.refund_request_id }, { payment_refund_id: e.refundId, applied_at: this.now() });
    this.core.flush(out);
  }

  /**
   * payments.refund.failed: nothing is posted until payments.refund.sent. The stored funding split (from
   * returns.refund.approved) is marked failed with the attempt, and a final failure is listed in the daily checks.
   * Claimed once per event (inbox) together with the mark.
   */
  async onRefundFailed(e: EventPayload<'payments.refund.failed'>, eventId: string) {
    if (e.finalAttempt) await this.parts.recon.refundFailed(e); // idempotent per refund (one item)
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`payments.refund.failed:${eventId}`))) return;
      const alloc = (await tx.findOne('refund_allocations', { payment_refund_id: e.refundId })) ?? (e.originId && isUuid(e.originId) ? await tx.findOne('refund_allocations', { refund_request_id: e.originId }) : undefined);
      if (!alloc || alloc.applied_at) return;
      const breakdown = (alloc.breakdown ?? {}) as Record<string, unknown>;
      const failure = { refundId: e.refundId, ref: e.ref, reason: e.reason, attempts: e.attempts, finalAttempt: e.finalAttempt, at: this.now().toISOString() };
      await tx.updateWhere('refund_allocations', { refund_request_id: alloc.refund_request_id }, { payment_refund_id: e.refundId, breakdown: { ...breakdown, failure } as never });
    });
  }

  /* ---------------------------------------------------------------- labels and claims */

  async chargeLabel(o: { labelId: string; sellerId: string; cost: number; ref: NewEntry['ref']; description: string }) {
    const out = new Outbox();
    await this.repo.transaction((tx) => this.core.post(tx, o.sellerId, [{ key: `label:${o.labelId}`, type: 'label_charge', amount: -o.cost, bucket: 'available', ref: o.ref, description: o.description }], out));
    this.core.flush(out);
  }

  async onReturnLabel(e: EventPayload<'returns.label.created'>) {
    const at = this.now();
    if (e.paidBy === 'customer') return; // deducted from the refund by returns
    if (e.paidBy === 'seller' && e.sellerId) return this.chargeLabel({ labelId: e.labelId, sellerId: e.sellerId, cost: e.cost.amount, ref: { kind: 'return', id: e.returnId }, description: 'Prepaid return label' });
    // an Official Store return label is company trading; one the platform pays on a seller's order is a platform cost
    if (e.ownerType === 'official') await this.repo.transaction((tx) => this.trading(tx, `label:${e.labelId}`, { at, kind: 'shipping_expense', amount: e.cost.amount, order_id: e.orderId, order_item_id: null, variant_id: null, ref_kind: 'return_label', ref_id: e.labelId }));
    else await this.repo.transaction((tx) => this.platformCost(tx, `label:${e.labelId}`, { at, kind: 'label', amount: e.cost.amount, order_id: e.orderId, ref_kind: 'label', ref_id: e.labelId }));
  }

  async onLabelPurchased(e: EventPayload<'shipping.label.purchased'>) {
    if (e.kind === 'return' || e.billedTo === 'customer') return; // return labels are booked from returns.label.created
    if (e.billedTo === 'seller' && e.sellerId) return this.chargeLabel({ labelId: e.labelId, sellerId: e.sellerId, cost: e.cost.amount, ref: { kind: 'order', id: e.orderId }, description: `${e.kind === 'replacement' ? 'Replacement' : 'Shipping'} label bought through Marketly` });
    if (e.billedTo === 'company') await this.repo.transaction((tx) => this.trading(tx, `label:${e.labelId}`, { at: this.now(), kind: 'shipping_expense', amount: e.cost.amount, order_id: e.orderId, order_item_id: null, variant_id: null, ref_kind: 'label', ref_id: e.labelId }));
    else await this.repo.transaction((tx) => this.platformCost(tx, `label:${e.labelId}`, { at: this.now(), kind: 'label', amount: e.cost.amount, order_id: e.orderId, ref_kind: 'label', ref_id: e.labelId }));
  }

  async onLabelVoided(e: EventPayload<'shipping.label.voided'>) {
    const charged = await this.repo.findOne('ledger_entries', { source_event_id: `label:${e.labelId}` });
    if (charged) {
      const out = new Outbox();
      await this.repo.transaction((tx) => this.core.post(tx, charged.seller_id, [{ key: `label_void:${e.labelId}`, type: 'label_charge', amount: -charged.amount, bucket: 'available', ref: { kind: charged.ref_kind as Reference['kind'], id: charged.ref_id, label: charged.ref_label }, description: 'Label voided; charge reversed' }], out));
      this.core.flush(out);
      return;
    }
    const booked = await this.repo.get('trading_entries', factId(`label:${e.labelId}`));
    if (booked) return void (await this.repo.transaction((tx) => this.trading(tx, `label_void:${e.labelId}`, { at: this.now(), kind: 'shipping_expense', amount: -booked.amount, order_id: booked.order_id, order_item_id: null, variant_id: null, ref_kind: booked.ref_kind, ref_id: e.labelId })));
    const cost = await this.repo.get('platform_costs', factId(`label:${e.labelId}`));
    if (cost) await this.repo.transaction((tx) => this.platformCost(tx, `label_void:${e.labelId}`, { at: this.now(), kind: 'label', amount: -cost.amount, order_id: cost.order_id, ref_kind: 'label', ref_id: e.labelId }));
  }

  async onClaimStatusChanged(e: EventPayload<'shipping.claim.status_changed'>) {
    if (e.status !== 'paid' || !e.paidAmount?.amount) return void this.ctx.log.info({ claimId: e.claimId, status: e.status }, 'finance: carrier claim status noted');
    if (e.sellerId && e.filedBy !== 'platform') {
      await this.parts.holds.recordSystemAdjustment({ key: `claim:${e.claimId}`, sellerId: e.sellerId, direction: 'credit', amount: e.paidAmount.amount, reasonCode: 'carrier_claim', reason: 'Carrier claim paid for a lost or damaged parcel', reference: { kind: 'order', id: e.orderId, ref: null } });
      return;
    }
    // paid to the platform on a seller's order: a platform recovery; on an Official Store order: company trading
    if (e.sellerId) await this.repo.transaction((tx) => this.platformCost(tx, `claim:${e.claimId}`, { at: this.now(), kind: 'carrier_claim', amount: -e.paidAmount!.amount, order_id: e.orderId, ref_kind: 'claim', ref_id: e.claimId }));
    else await this.repo.transaction((tx) => this.trading(tx, `claim:${e.claimId}`, { at: this.now(), kind: 'supplier_credit', amount: e.paidAmount!.amount, order_id: e.orderId, order_item_id: null, variant_id: null, ref_kind: 'claim', ref_id: e.claimId }));
  }

  /* ---------------------------------------------------------------- discount funding, wallet */

  async onCouponRedeemed(e: EventPayload<'promotions.coupon.redeemed'>) {
    await this.repo.transaction(async (tx) => {
      const base = { at: this.now(), redemption_id: e.redemptionId, kind: 'redeemed' as const, order_id: e.orderId, order_item_id: null, currency: e.platformPart.currency };
      await this.funding(tx, `coupon:${e.redemptionId}`, { ...base, funded_by: 'platform', amount: e.platformPart.amount });
      await this.funding(tx, `coupon_seller:${e.redemptionId}`, { ...base, funded_by: 'seller', amount: e.sellerPart.amount });
    });
  }

  /**
   * promotions.redemption.reversed: the discount funding recorded from promotions.coupon.redeemed is reversed by
   * the platform and seller parts given, once per event (inbox), so discount reports match after a cancellation or
   * refund. Seller earnings were already corrected by the cancellation or refund itself.
   */
  async onRedemptionReversed(e: EventPayload<'promotions.redemption.reversed'>, eventId: string) {
    const redeemed = (await this.repo.get('discount_funding', factId(`coupon:${e.redemptionId}`))) ?? (await this.repo.get('discount_funding', factId(`coupon_seller:${e.redemptionId}`)));
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`promotions.redemption.reversed:${eventId}`))) return;
      const base = { at: this.now(), redemption_id: e.redemptionId, kind: 'reversed' as const, order_id: redeemed?.order_id ?? null, order_item_id: isUuid(e.orderItemId) ? e.orderItemId : null, currency: e.platformPart.currency };
      await this.funding(tx, `coupon_reversed:${eventId}`, { ...base, funded_by: 'platform', amount: -e.platformPart.amount });
      await this.funding(tx, `coupon_seller_reversed:${eventId}`, { ...base, funded_by: 'seller', amount: -e.sellerPart.amount });
    });
  }

  /**
   * wallet.credit.granted: every grant adds to the store-credit liability (wallet_liability). Only goodwill funded
   * by the platform is a platform cost (wallet_credit); goodwill or a price adjustment charged to a seller is taken
   * from that seller's earnings (adjustment, reason goodwill). Refunds to credit and gift card redemptions are not
   * costs: the refund was already booked from payments.refund.sent, the gift card when it was sold.
   */
  async onCreditGranted(e: EventPayload<'wallet.credit.granted'>) {
    const orderId = e.orderId && isUuid(e.orderId) ? e.orderId : null;
    await this.repo.transaction(async (tx) => {
      await this.liability(tx, `wallet_liability:${e.entryId}`, { kind: 'granted', amount: e.amount.amount, currency: e.amount.currency, wallet_entry_id: walletEntry(e.entryId), order_id: orderId });
      if (e.kind === 'goodwill' && e.chargedTo === 'platform') await this.platformCost(tx, `wallet:${e.entryId}`, { at: this.now(), kind: 'goodwill_credit', amount: e.amount.amount, currency: e.amount.currency, order_id: orderId, ref_kind: 'wallet_entry', ref_id: e.entryId });
    });
    if (e.chargedTo !== 'seller' || (e.kind !== 'goodwill' && e.kind !== 'price_adjustment')) return;
    if (!e.sellerId || !isUuid(e.sellerId)) return void this.ctx.log.warn({ entryId: e.entryId }, 'finance: seller-funded store credit without a seller');
    const what = e.kind === 'goodwill' ? 'Goodwill store credit' : 'Price adjustment store credit';
    await this.parts.holds.recordSystemAdjustment({
      key: `wallet_credit:${e.entryId}`,
      sellerId: e.sellerId,
      direction: 'debit',
      amount: e.amount.amount,
      reasonCode: 'goodwill',
      reason: `${what} given to your customer, charged to you`,
      reference: e.caseId ? { kind: 'case', id: e.caseId, ref: null } : e.orderId ? { kind: 'order', id: e.orderId, ref: null } : null,
    });
  }

  /** wallet.credit.used: store credit paying for an order reduces the liability */
  async onCreditUsed(e: EventPayload<'wallet.credit.used'>) {
    await this.repo.transaction((tx) => this.liability(tx, `wallet_used:${e.orderId}`, { kind: 'used', amount: -e.amount.amount, currency: e.amount.currency, wallet_entry_id: null, order_id: isUuid(e.orderId) ? e.orderId : null }));
  }

  /**
   * wallet.credit.reversed: unused goodwill removed. The liability goes down by the amount; platform-funded
   * goodwill lowers the platform goodwill cost; seller-funded goodwill credits the seller back the charge posted
   * for the grant (keyed by grantEntryId, never more than was charged). Once per reversal entry (inbox).
   */
  async onCreditReversed(e: EventPayload<'wallet.credit.reversed'>) {
    const orderId = e.orderId && isUuid(e.orderId) ? e.orderId : null;
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`wallet.credit.reversed:${e.entryId}`))) return;
      await this.liability(tx, `wallet_liability_reversed:${e.entryId}`, { kind: 'reversed', amount: -e.amount.amount, currency: e.amount.currency, wallet_entry_id: walletEntry(e.entryId), order_id: orderId });
      if (e.chargedTo === 'platform') await this.platformCost(tx, `wallet_reversed:${e.entryId}`, { at: this.now(), kind: 'goodwill_credit', amount: -e.amount.amount, currency: e.amount.currency, order_id: orderId, ref_kind: 'wallet_entry', ref_id: e.entryId });
    });
    if (e.chargedTo !== 'seller') return;
    if (!e.sellerId || !isUuid(e.sellerId)) return void this.ctx.log.warn({ entryId: e.entryId, grantEntryId: e.grantEntryId }, 'finance: reversed seller-funded store credit without a seller');
    // the debit booked from wallet.credit.granted for this grant (recordSystemAdjustment key wallet_credit:<grantEntryId>)
    const charge = await this.repo.get('adjustments', detId(`adjustment:wallet_credit:${e.grantEntryId}`));
    if (!charge || charge.direction !== 'debit' || charge.seller_id !== e.sellerId) return void this.ctx.log.warn({ entryId: e.entryId, grantEntryId: e.grantEntryId }, 'finance: no seller charge found for the reversed goodwill');
    const back = Math.min(e.amount.amount, charge.amount);
    if (back <= 0) return;
    await this.parts.holds.recordSystemAdjustment({
      key: `wallet_credit_reversed:${e.grantEntryId}`,
      sellerId: e.sellerId,
      direction: 'credit',
      amount: back,
      reasonCode: 'goodwill',
      reason: 'Goodwill store credit charged to you was reversed: the charge is given back',
      reference: e.caseId ? { kind: 'case', id: e.caseId, ref: null } : e.orderId ? { kind: 'order', id: e.orderId, ref: null } : null,
    });
  }

  /** wallet.credit.expired: unused credit expired; the liability goes down and the platform records breakage (never seller money) */
  async onCreditExpired(e: EventPayload<'wallet.credit.expired'>) {
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`wallet.credit.expired:${e.entryId}`))) return;
      await this.liability(tx, `wallet_liability_expired:${e.entryId}`, { kind: 'expired', amount: -e.amount.amount, currency: e.amount.currency, wallet_entry_id: walletEntry(e.entryId), order_id: null });
      await this.platformCost(tx, `wallet_breakage:${e.entryId}`, { at: this.now(), kind: 'credit_breakage', amount: -e.amount.amount, currency: e.amount.currency, order_id: null, ref_kind: 'wallet_entry', ref_id: e.entryId });
    });
  }

  /** wallet.credit.corrected: a staff balance correction raises (positive) or lowers (negative) the liability; booked as a platform credit correction */
  async onCreditCorrected(e: EventPayload<'wallet.credit.corrected'>) {
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`wallet.credit.corrected:${e.entryId}`))) return;
      await this.liability(tx, `wallet_liability_corrected:${e.entryId}`, { kind: 'corrected', amount: e.amount.amount, currency: e.amount.currency, wallet_entry_id: walletEntry(e.entryId), order_id: null });
      await this.platformCost(tx, `wallet_correction:${e.entryId}`, { at: this.now(), kind: 'credit_correction', amount: e.amount.amount, currency: e.amount.currency, order_id: null, ref_kind: 'wallet_entry', ref_id: e.entryId });
    });
  }

  /** Finance's store-credit liability (store_credit_liability) up to a time */
  async storeCreditLiability(before: Date): Promise<number> {
    return this.repo.sum('store_credit_liability', 'amount', { at: { op: '<', value: before } });
  }

  /* ---------------------------------------------------------------- public API: ad charges, company costs */

  async recordAdCharge(input: { sellerId: string; campaignId: string; campaignRef: string; period: common.DateRange; amount: common.Money; description: string }): Promise<LedgerEntry> {
    if (!isUuid(input.sellerId)) throw notFound('Seller');
    if (!Number.isSafeInteger(input.amount.amount) || input.amount.amount <= 0) throw invalid([{ path: 'amount', message: 'Ad charges are positive amounts' }]);
    const key = `ad:${input.campaignId}:${input.period.from}:${input.period.to}`;
    const out = new Outbox();
    await this.repo.transaction((tx) => this.core.post(tx, input.sellerId, [{ key, type: 'ad_charge', amount: -input.amount.amount, bucket: 'available', ref: { kind: 'ad_campaign', id: input.campaignId, label: input.campaignRef }, description: input.description || `Ad charges ${shortDate(input.period.from)} – ${shortDate(input.period.to)}` }], out));
    this.core.flush(out);
    const row = (await this.repo.findOne('ledger_entries', { source_event_id: key }))!;
    return toEntry(row, new Map());
  }

  /** A fulfillment-service fee (storage, handling, receiving, returns processing, removal) as service_fee, once per idempotency key */
  async recordServiceFee(input: { sellerId: string; amount: common.Money; kind: string; reference: Reference; description: string; idempotencyKey: string }): Promise<LedgerEntry> {
    if (!isUuid(input.sellerId)) throw notFound('Seller');
    const issues: { path: string; message: string }[] = [];
    if (!Number.isSafeInteger(input.amount?.amount) || input.amount.amount <= 0) issues.push({ path: 'amount', message: 'Service fees are positive amounts in minor units' });
    else if (input.amount.currency !== this.core.currency()) issues.push({ path: 'amount.currency', message: `Seller ledgers are in ${this.core.currency()}` });
    if (!input.idempotencyKey?.trim()) issues.push({ path: 'idempotencyKey', message: 'Required' });
    if (!input.reference?.id || !REFERENCE_KINDS.includes(input.reference.kind)) issues.push({ path: 'reference', message: 'A reference to the fee charge' });
    if (issues.length) throw invalid(issues);
    const key = `service_fee:${input.idempotencyKey}`;
    const known = await this.repo.findOne('ledger_entries', { source_event_id: key });
    if (known) return toEntry(known, new Map());
    const out = new Outbox();
    const description = input.description?.trim() || `Fulfillment service fee (${input.kind.replace(/_/g, ' ')})`;
    await this.repo.transaction((tx) => this.core.post(tx, input.sellerId, [{ key, type: 'service_fee', amount: -input.amount.amount, bucket: 'available', ref: { kind: input.reference.kind, id: input.reference.id, label: input.reference.ref ?? null }, description }], out));
    this.core.flush(out);
    return toEntry((await this.repo.findOne('ledger_entries', { source_event_id: key }))!, new Map());
  }

  /**
   * Credits back all or part of an ad charge or service fee as charge_credit, never more than the charge minus the
   * credits already given (decided under the seller account lock). The credit carries the charge's reference; its
   * key names the charge (charge_credit:<originalEntryId>:<idempotencyKey>), so the same key returns the first entry.
   */
  async creditSellerCharge(input: { sellerId: string; amount: common.Money; originalEntryId: string; reason: string; idempotencyKey: string }): Promise<LedgerEntry> {
    if (!isUuid(input.sellerId)) throw notFound('Seller');
    if (!isUuid(input.originalEntryId)) throw notFound('Charge');
    const issues: { path: string; message: string }[] = [];
    if (!Number.isSafeInteger(input.amount?.amount) || input.amount.amount <= 0) issues.push({ path: 'amount', message: 'Credits are positive amounts in minor units' });
    if (!input.reason?.trim()) issues.push({ path: 'reason', message: 'Give the reason for the credit' });
    if (!input.idempotencyKey?.trim()) issues.push({ path: 'idempotencyKey', message: 'Required' });
    if (issues.length) throw invalid(issues);
    const escaped = input.idempotencyKey.replace(/[\\%_]/g, (c) => `\\${c}`);
    const first = async (repo: FinanceRepository) => repo.findOne('ledger_entries', { seller_id: input.sellerId, type: 'charge_credit', source_event_id: { op: 'like', value: `charge_credit:%:${escaped}` } }, { orderBy: [['at', 'asc']] });
    const known = await first(this.repo);
    if (known) return toEntry(known, new Map());
    const key = `charge_credit:${input.originalEntryId}:${input.idempotencyKey}`;
    const out = new Outbox();
    const posted = await this.repo.transaction(async (tx) => {
      await tx.lockAccount(input.sellerId, this.core.currency(), this.now()); // one decision per seller at a time
      const again = await first(tx);
      if (again) return again;
      const original = await tx.get('ledger_entries', input.originalEntryId);
      if (!original || original.seller_id !== input.sellerId) throw notFound('Charge');
      if (original.type !== 'ad_charge' && original.type !== 'service_fee') throw invalid([{ path: 'originalEntryId', message: 'Only ad charges and fulfillment service fees can be credited back' }]);
      if (input.amount.currency !== original.currency) throw invalid([{ path: 'amount.currency', message: `The charge is in ${original.currency}` }]);
      const credited = await tx.sum('ledger_entries', 'amount', { seller_id: input.sellerId, type: 'charge_credit', source_event_id: { op: 'like', value: `charge_credit:${original.id}:%` } });
      const left = -original.amount - credited;
      if (input.amount.amount > left) {
        throw invalid([{ path: 'amount', message: left > 0 ? `At most ${fmt(left, original.currency)} of this charge can still be credited back` : 'This charge was already credited back in full' }], 'The credit is more than what is left of the charge');
      }
      const what = original.type === 'ad_charge' ? 'ad charge' : 'service fee';
      const [row] = await this.core.post(tx, input.sellerId, [{ key, type: 'charge_credit', amount: input.amount.amount, bucket: 'available', ref: { kind: original.ref_kind as Reference['kind'], id: original.ref_id, label: original.ref_label }, description: `Credit of ${what}${original.ref_label ? ` ${original.ref_label}` : ''}: ${input.reason.trim()}` }], out);
      return row!;
    });
    this.core.flush(out);
    return toEntry(posted, new Map());
  }

  async recordCompanyCost(input:{ kind: 'buying_cost' | 'shipping_expense' | 'return_loss' | 'write_off' | 'supplier_credit'; amount: common.Money; reference: Reference; at: string }): Promise<void> {
    const kind = input.kind === 'return_loss' ? 'return' : input.kind;
    if (!Number.isSafeInteger(input.amount.amount)) throw invalid([{ path: 'amount', message: 'Whole minor units' }]);
    const at = new Date(input.at);
    await this.repo.transaction((tx) =>
      this.trading(tx, `cost:${input.kind}:${input.reference.kind}:${input.reference.id}:${at.toISOString()}`, {
        at: Number.isNaN(at.getTime()) ? this.now() : at,
        kind,
        amount: input.amount.amount,
        currency: input.amount.currency,
        order_id: input.reference.kind === 'order' && isUuid(input.reference.id) ? input.reference.id : null,
        order_item_id: input.reference.kind === 'order_item' && isUuid(input.reference.id) ? input.reference.id : null,
        variant_id: null,
        ref_kind: input.reference.kind,
        ref_id: input.reference.id,
      }),
    );
  }

  /* ---------------------------------------------------------------- balances and the ledger */

  /** One seller's balances (the seller finance header, seller 360): balancesFor with one seller */
  async balances(sellerId: string): Promise<SellerBalances> {
    return (await this.balancesFor([sellerId])).get(sellerId)!;
  }

  /**
   * Balances of several sellers (the admin seller list), the same reads for one seller or a thousand: accounts, holds,
   * amounts owed, last statements, payout destinations, seller names and the sales proceeds since each seller's last
   * statement, each read once for all of them. A seller without an account yet gets zeros.
   */
  async balancesFor(sellerIds: readonly string[]): Promise<Map<string, SellerBalances>> {
    const ids = [...new Set(sellerIds)];
    const out = new Map<string, SellerBalances>();
    if (!ids.length) return out;
    const tz = this.core.tz();
    const today = this.core.today();
    // independent records: side by side
    const [accounts, sellers, holds, owed, lastEnds, dests, scheduleSetting, releaseTime, minimum, days] = await Promise.all([
      this.repo.find('seller_accounts', { seller_id: ids }),
      this.core.sellerInfo(ids),
      this.repo.find('holds', { seller_id: ids, status: 'active' }, { orderBy: [['review_date', 'asc']] }),
      this.repo.find('amounts_owed', { seller_id: ids, status: 'open' }, { orderBy: [['since', 'asc']] }),
      this.repo.lastStatementEnds(ids),
      this.core.destinations(ids),
      this.core.setting('payoutSchedule'),
      this.core.setting('payoutReleaseTime'),
      this.core.num('minimumPayout', 2500),
      this.core.num('availableAfterDeliveryDays', 7),
    ]);
    // sales proceeds count from the day after the last statement (the last 7 days without one), never after today
    const periodFrom = new Map<string, string>();
    for (const id of ids) {
      const last = lastEnds.get(id);
      const from = last ? addDays(last, 1) : addDays(today, -6);
      periodFrom.set(id, from <= today ? from : today);
    }
    const [infos, proceeds] = await Promise.all([
      this.core.approvalInfos(holds.map((h) => h.approval_request_id)),
      this.repo.sumsSince(new Map(ids.map((id) => [id, dayStart(periodFrom.get(id)!, tz)])), ['sale', 'shipping_charge', 'seller_discount']),
    ]);
    const accountOf = new Map(accounts.map((a) => [a.seller_id, a]));
    const holdsOf = groupBy(holds, (h) => h.seller_id);
    const owedOf = groupBy(owed, (o) => o.seller_id);
    const now = this.now();
    const schedule = String(scheduleSetting);
    const slot = nextSlot(now, schedule, String(releaseTime), tz);
    for (const sellerId of ids) {
      const acct = accountOf.get(sellerId);
      const dest = dests.get(sellerId)!;
      const name = sellers.get(sellerId)!.name;
      const sellerOwed = owedOf.get(sellerId) ?? [];
      const pending = acct?.pending ?? 0;
      const available = acct?.available ?? 0;
      const held = acct?.held ?? 0;
      const inNewSellerPeriod = Boolean(acct?.new_seller_until && acct.new_seller_extra_days && acct.new_seller_until >= today);
      const newSellerDays = inNewSellerPeriod ? acct!.new_seller_extra_days : null;
      const estimate = Math.max(0, available);
      const blocked = this.payoutBlockOf(acct, dest);
      out.set(sellerId, {
        sellerId,
        asOf: now.toISOString(),
        salesProceeds: this.money(proceeds.get(sellerId) ?? 0),
        salesPeriod: { from: periodFrom.get(sellerId)!, to: today },
        pending: this.money(pending),
        available: this.money(available),
        held: this.money(held),
        holds: (holdsOf.get(sellerId) ?? []).map((h) => toHold(h, name, h.approval_request_id ? (infos.get(h.approval_request_id) ?? null) : null)),
        negative: available < 0,
        amountOwed: sellerOwed.length ? this.money(sellerOwed.reduce((s, o) => s + o.remaining, 0)) : null,
        owedDueBy: sellerOwed.find((o) => o.due_by)?.due_by ?? null,
        nextPayout:
          dest.status.status === 'missing'
            ? null
            : {
                estimatedAmount: this.money(estimate),
                scheduledFor: slot.payDate,
                cutoffAt: slot.cutoffAt.toISOString(),
                destination: dest.status,
                arrivesNote: 'Usually 1 business day after sending',
                note: blocked.blocked ? `Not paid while: ${blocked.reasons.join('; ')}` : estimate < minimum ? `Below the ${fmt(minimum, this.core.currency())} minimum; the balance rolls to the next payout` : 'Estimate. Earnings that become available before the cutoff are added; new holds or refunds reduce it.',
              },
        settlementRules: {
          schedule: scheduleLabel(schedule),
          availableAfterDeliveryDays: days,
          minimumPayout: this.money(minimum),
          newSellerHoldDays: newSellerDays,
          newSellerUntil: inNewSellerPeriod ? acct!.new_seller_until : null,
          refundAfterPayout: 'Deducted from later earnings; if none, the balance shows the amount owed',
          text: `Earnings become available ${days} days after delivery${newSellerDays ? ` (${days + newSellerDays} days for items delivered until ${acct!.new_seller_until}, your new-seller period)` : ''} and are paid ${scheduleLabel(schedule).toLowerCase()} to a verified account. Balances under ${fmt(minimum, this.core.currency())} roll to the next payout.`,
        },
        destination: dest.status,
      });
    }
    return out;
  }

  /** Whether a seller can be paid (verified destination, no restriction, holds not covering everything) */
  async payoutBlock(sellerId: string): Promise<{ blocked: boolean; reasons: string[] }> {
    const [acct, dest] = await Promise.all([this.repo.findOne('seller_accounts', { seller_id: sellerId }), this.core.destinationOf(sellerId)]);
    return this.payoutBlockOf(acct, dest);
  }

  /** payoutBlock from the seller account and destination already read */
  payoutBlockOf(acct: AccountRec | undefined, dest: Destination): { blocked: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (!dest.active) reasons.push(dest.status.status === 'missing' ? 'No payout account' : 'The payout account is not verified');
    else if (dest.active.pause_until && dest.active.pause_until > this.now()) reasons.push(`New payout account: payouts start after ${dest.active.pause_until.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    if (acct?.payouts_blocked_reason) reasons.push(acct.payouts_blocked_reason);
    if (acct && acct.held > 0 && acct.available <= 0 && acct.pending <= 0) reasons.push('All earnings are on hold');
    return { blocked: reasons.length > 0, reasons };
  }

  ledgerTypes(type?: string | null, types?: string | null): string[] | undefined {
    const out = new Set<string>();
    if (type && type !== 'all') {
      const group = TYPE_GROUPS[type];
      if (group) group.forEach((t) => out.add(t));
      else if (type in TYPE_LABELS) out.add(type);
      else throw invalid([{ path: 'type', message: `Unknown entry type ${type}` }]);
    }
    for (const t of (types ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!(t in TYPE_LABELS)) throw invalid([{ path: 'types', message: `Unknown entry type ${t}` }]);
      out.add(t);
    }
    return out.size ? [...out] : undefined;
  }

  async listLedger(sellerId: string, f: { type?: string | null; types?: string | null; from?: string | null; to?: string | null; q?: string | null }, page: PageRequest): Promise<common.Page<LedgerEntry>> {
    const tz = this.core.tz();
    const res = await this.repo.ledgerPage(sellerId, { types: this.ledgerTypes(f.type, f.types), from: f.from ? dayStart(f.from, tz) : undefined, to: f.to ? dayStart(addDays(f.to, 1), tz) : undefined, q: f.q ?? undefined }, page);
    const stIds = [...new Set(res.items.map((r) => r.statement_id).filter((x): x is string => Boolean(x)))];
    const refs = new Map((await this.repo.getMany('statements', stIds)).map((s) => [s.id, s.ref]));
    return { ...res, items: res.items.map((r) => toEntry(r, refs)) };
  }

  /* ---------------------------------------------------------------- refund previews */

  async previewRefundImpact(orderItemIds: string[], refund: common.Money, fundedBy: string): Promise<{ sellerEarningsChange: common.Money; feeReturned: common.Money; afterPayout: boolean; note: string; platformShare: number; sellerId: string | null }> {
    const lots: LotRec[] = [];
    for (const id of orderItemIds) {
      const l = await this.lotOf(id);
      if (l) lots.push(l);
    }
    const cur = refund.currency || this.core.currency();
    if (!lots.length || fundedBy === 'official_store') {
      return { sellerEarningsChange: { amount: 0, currency: cur }, feeReturned: { amount: 0, currency: cur }, afterPayout: false, note: fundedBy === 'official_store' || !lots.length ? 'Official Store or unknown items: no seller earnings change; the refund is recorded in company trading' : '', platformShare: fundedBy === 'platform' ? refund.amount : 0, sellerId: null };
    }
    const gross = lots.reduce((s, l) => s + l.gross, 0);
    const sellerShare = fundedBy === 'platform' ? 0 : fundedBy === 'shared' ? Math.floor(refund.amount / 2) : refund.amount;
    const charges = (await Promise.all(lots.map((l) => this.repo.findOne('fee_charges', { order_item_id: l.order_item_id })))).filter((c): c is FeeChargeRec => Boolean(c));
    const rule = await this.core.ruleModel(await this.feeRuleOf(this.repo, lots[0]!));
    const feeLeft = charges.reduce((s, c) => s + c.fee - c.refunded_fee, 0);
    const itemPart = Math.min(gross, refund.amount);
    const feeReturned = rule.treatment.returns === 'fee_returned_pro_rata' ? Math.min(feeLeft, prorate(charges.reduce((s, c) => s + c.fee, 0), itemPart, lots.reduce((s, l) => s + l.gross, 0) || 1)) : 0;
    const afterPayout = lots.some((l) => l.state === 'paid_out' || l.state === 'in_payout');
    const next = nextSlot(this.now(), String(await this.core.setting('payoutSchedule')), String(await this.core.setting('payoutReleaseTime')), this.core.tz());
    const note = `Earnings of ${fmt(sellerShare, cur)} reversed; ${fmt(feeReturned, cur)} fee returned${fundedBy !== 'seller' ? `; ${fmt(refund.amount - sellerShare, cur)} funded by Marketly` : ''}${afterPayout ? `; already paid out, so it is deducted from the ${shortDate(next.payDate)} payout or becomes an amount owed` : ''}`;
    return { sellerEarningsChange: { amount: -sellerShare, currency: cur }, feeReturned: { amount: feeReturned, currency: cur }, afterPayout, note, platformShare: refund.amount - sellerShare, sellerId: lots[0]!.seller_id };
  }

  /**
   * What a sent refund changed on the seller ledger (onRefundSent posts refund:<refundId>:<item> and
   * refund_fee:<refundId>:<item>). Null while it is not booked yet; zeros when it was booked with no seller entry
   * (funded by Marketly).
   */
  async bookedRefundImpact(paymentRefundId: string, orderItemIds: string[]): Promise<{ sellerEarningsChange: common.Money; feeReturned: common.Money; afterPayout: boolean; note: string } | null> {
    if (!isUuid(paymentRefundId) || !orderItemIds.length) return null;
    const keys = orderItemIds.flatMap((id) => [`refund:${paymentRefundId}:${id}`, `refund_fee:${paymentRefundId}:${id}`]);
    const rows = await this.repo.find('ledger_entries', { source_event_id: keys });
    if (!rows.length) {
      const alloc = await this.repo.findOne('refund_allocations', { payment_refund_id: paymentRefundId });
      if (!alloc?.applied_at) return null;
    }
    const cur = rows[0]?.currency ?? this.core.currency();
    const earnings = rows.filter((r) => r.type === 'refund' || r.type === 'refund_after_payout').reduce((s, r) => s + r.amount, 0);
    const fee = rows.filter((r) => r.type === 'fee_refund').reduce((s, r) => s + r.amount, 0);
    const afterPayout = rows.some((r) => r.type === 'refund_after_payout');
    const note = `Booked: earnings of ${fmt(-earnings, cur)} reversed; ${fmt(fee, cur)} fee returned${afterPayout ? '; the sale was already paid out, so it comes off the next payout or becomes an amount owed' : ''}`;
    return { sellerEarningsChange: { amount: earnings, currency: cur }, feeReturned: { amount: fee, currency: cur }, afterPayout, note };
  }

  async previewRefundImpactForOrder(orderRef: string, items: { orderItemId: string; quantity?: number }[] | null, refund: common.Money | null, fundedBy: string): Promise<RefundImpactPreview> {
    const admin = await this.ctx.use('orders').getOrderAdmin(orderRef);
    if (!admin) throw notFound('Order');
    const all = this.itemsOf(admin.order);
    const chosen = (items?.length ? items : all.map((i) => ({ orderItemId: i.id, quantity: i.quantity }))).map((c) => {
      const item = all.find((i) => i.id === c.orderItemId);
      if (!item) throw invalid([{ path: 'items', message: `Item ${c.orderItemId} is not on ${orderRef}` }]);
      const qty = Math.min(item.quantity, Math.max(1, c.quantity ?? item.quantity));
      return { item, refundable: prorate(item.paidAmount.amount, qty, item.quantity) };
    });
    const cur = admin.order.totals.total.currency;
    const amount = refund?.amount ?? chosen.reduce((s, c) => s + c.refundable, 0);
    if (!Number.isSafeInteger(amount) || amount < 0) throw invalid([{ path: 'amount', message: 'Whole minor units, zero or more' }]);
    const official = chosen.every((c) => admin.order.groups.find((g) => g.id === c.item.groupId)?.seller?.ownerType === 'official');
    const by = official ? 'official_store' : fundedBy;
    const p = await this.previewRefundImpact(chosen.map((c) => c.item.id), { amount, currency: cur }, by);
    const acct = p.sellerId ? await this.repo.findOne('seller_accounts', { seller_id: p.sellerId }) : undefined;
    return {
      orderRef: admin.order.ref,
      refund: { amount, currency: cur },
      fundedBy: (['seller', 'platform', 'shared', 'official_store'].includes(by) ? by : 'seller') as RefundImpactPreview['fundedBy'],
      sellerEarningsChange: p.sellerEarningsChange,
      feeReturned: p.feeReturned,
      platformShare: { amount: by === 'official_store' ? 0 : p.platformShare, currency: cur },
      afterPayout: p.afterPayout,
      balanceAfter: acct ? { amount: acct.pending + acct.available + acct.held + p.sellerEarningsChange.amount + p.feeReturned.amount, currency: cur } : null,
      note: p.note,
    };
  }

  /** Validates a seller id, else 404 */
  requireSeller(id: string) {
    if (!isUuid(id)) throw new AppError('NOT_FOUND', 'Seller not found');
  }
}
