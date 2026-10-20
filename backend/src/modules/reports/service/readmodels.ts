/**
 * Read models fed by other modules' events (never their tables), the daily pull of figures that have no
 * event, discovery signals, read model health and rebuilds.
 *
 * Consumers are idempotent and order-tolerant: facts are keyed by natural ids (order item, refund,
 * return), counters record the natural key of what they counted (shipment, case, payout, hold…) before
 * adding, and an event about an order reports has not seen yet first loads the order from orders.
 */
import { isIsoDate } from '../../../kernel/lib/dates.js';
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import type * as identity from '../../../spec/identity.js';
import type * as orders from '../../../spec/orders.js';
import type { ReadModelStatus } from '../../../spec/reports.js';
import { isOfficialSeller, OFFICIAL_KEY, READ_MODELS, readModelDef } from '../domain/catalogue.js';
import { addDays, customerKey, marketDay, splitRefund } from '../domain/rules.js';
import type { OrderItemFact } from '../ports.js';
import { LEDGER_COLUMN_DEFAULTS } from '../repository.js';
import { invalid, notFound, type Caller, type ReportsCore } from './core.js';

/** The envelope fields a consumer uses: the event id and when it happened */
export interface Env {
  id: string;
  at: string;
}

const MINUTE = 60_000;

/** What a rebuild reads per read model; the ones kept from events only cannot be rebuilt until the kernel keeps an event log */
const REBUILDS: Record<string, string | null> = {
  order_items: 'Order facts are refreshed from orders, and every item fee is pulled again from finance',
  customers: 'Buyers are recomputed from the order facts',
  discovery: 'Units ordered are recomputed from the order facts; views and stock-out minutes stay as received',
  marketplace_finance: 'The last 400 days are pulled again from finance and advertising',
  company_finance: 'The last 400 days are pulled again from finance',
  seller_balances: 'The last 400 days of end-of-day balances are rebuilt again from the finance ledger',
  search_misses: 'Searches without results are pulled again from search for yesterday',
  campaigns: 'The last 90 days are pulled again from advertising',
  refunds: null,
  returns: null,
  service: null,
  marketly_fulfillment: null,
};
/** A seller's group Marketly's warehouse fulfils (Fulfilled by Marketly): its dispatch facts are Marketly's, not the seller's */
const isMarketly = (p: { fulfilledBy?: string | null; sellerId?: string | null }) => p.fulfilledBy === 'marketly_service' && !isOfficialSeller(p.sellerId);
const EVENT_ONLY_NOTE ='Kept from events only: there is no event log to replay yet, so it cannot be rebuilt';
const DAY = 86_400_000;
/** How far back a rebuild pulls the finance facts (the longest range a report covers) */
const REBUILD_DAYS = 400;
/** Days per finance pull while rebuilding, so one answer stays small */
const PULL_CHUNK_DAYS = 31;
/** The item fee pull starts this long before the last change it saw: a fee written in a transaction that committed late is still read */
const FEE_PULL_OVERLAP_MS = 60 * 60_000;

/**
 * Seller ledger entry types → fact_marketplace_finance_daily columns (finance.ledgerDailyTotals). Ledger amounts are
 * signed from the seller's side (a fee is negative); each column holds a positive amount of what its name says, so
 * sign -1 flips the ledger's sign. adjustments_minor stays signed (credits positive, debits negative).
 * Not here, on purpose: sale, seller_discount and cancellation (order-date figures come from fact_order_items);
 * ad_charge, service_fee and charge_credit (ad_charges_minor and service_fees_minor come from the advertising and
 * fulfillment-service events); payout and payout_returned (payouts_* come from the finance.payout events); hold and
 * hold_release (they move money between buckets); owed_offset (a debt settled, not earnings).
 */
const LEDGER_COLUMNS: Record<string, { column: keyof typeof LEDGER_COLUMN_DEFAULTS; sign: 1 | -1 }> = {
  marketplace_fee: { column: 'fee_gross_minor', sign: -1 },
  fee_refund: { column: 'fee_refunds_minor', sign: 1 },
  refund: { column: 'refunds_minor', sign: -1 },
  refund_after_payout: { column: 'refunds_minor', sign: -1 },
  shipping_charge: { column: 'shipping_charged_minor', sign: 1 },
  label_charge: { column: 'label_charges_minor', sign: -1 },
  adjustment: { column: 'adjustments_minor', sign: 1 },
  seller_credit: { column: 'adjustments_minor', sign: 1 },
  chargeback: { column: 'chargebacks_minor', sign: -1 },
};

export class ReadModels {
  /** Store signals per session: [window start, count] */
  readonly #signalWindows = new Map<string, { start: number; count: number }>();

  constructor(private readonly core: ReportsCore) {}

  private get repo() {
    return this.core.repo;
  }

  private async tz() {
    return (await this.core.cfg()).timeZone;
  }

  private async day(at: string | Date | undefined) {
    const d = at ? new Date(at) : this.core.now();
    return marketDay(Number.isNaN(d.getTime()) ? this.core.now() : d, await this.tz());
  }

  /** Checkpoint of the models an event fed: last event, and stale when it arrived later than the lag allowance */
  private async touch(models: string[], env: Env) {
    const cfg = await this.core.cfg();
    const delay = this.core.now().getTime() - new Date(env.at).getTime();
    for (const key of models) {
      const cp = await this.repo.getCheckpoint(key);
      const state = cp?.state === 'rebuilding' ? 'rebuilding' : delay > cfg.readModelMaxLagMinutes * MINUTE ? 'stale' : 'live';
      await this.repo.upsertCheckpoint(key, { last_event_id: env.id, last_event_at: new Date(env.at), state });
    }
  }

  /* ---------------------------------------------------------------- order item facts */

  /**
   * Rows of an accepted order, loading the order from orders the first time (placement event, or any later
   * event that arrives first). Orders waiting for payment are not counted until accepted.
   */
  async ensureOrder(orderId: string, hint: { customerId?: string | null; email?: string | null; accepted?: boolean } = {}): Promise<OrderItemFact[]> {
    const existing = await this.repo.getOrderItems(orderId);
    if (existing.length) return existing;
    const api = this.core.api('orders');
    if (!api) return [];
    const order = await this.core.soft('orders.getOrder', () => api.getOrder(orderId));
    if (!order) return [];
    if (!hint.accepted && !order.acceptedAt && order.lifecycle === 'payment_pending') return [];
    const rows = await this.factsOf(order, hint);
    if (!rows.length) return [];
    const tz = await this.tz();
    const placedDay = marketDay(new Date(order.placedAt), tz);
    const key = rows[0]!.customer_key;
    const spend = rows.reduce((n, r) => n + r.item_minor + r.shipping_minor + r.tax_minor, 0);
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`order_items:${orderId}`))) return;
      await tx.insertOrderItems(rows);
      await tx.upsertCustomer(key, new Date(order.placedAt), spend);
      const units = new Map<string, number>();
      for (const r of rows) units.set(r.product_id, (units.get(r.product_id) ?? 0) + r.quantity);
      for (const [productId, n] of units) await tx.bumpDaily('fact_discovery_daily', { product_id: productId, day: placedDay }, { purchases: n });
    });
    return this.repo.getOrderItems(orderId);
  }

  private async factsOf(order: orders.OrderDetail, hint: { customerId?: string | null; email?: string | null }): Promise<OrderItemFact[]> {
    const catalog = this.core.api('catalog');
    const inventory = this.core.api('inventory');
    const categories = new Map<string, string | null>();
    const key = customerKey(hint.customerId ?? order.contact?.customerId ?? null, hint.email ?? order.contact?.email ?? null);
    const rows: OrderItemFact[] = [];
    for (const g of order.groups) {
      const ownerType = g.seller.ownerType;
      for (const i of g.items) {
        const productId = i.product.productId;
        // the category at purchase (order item snapshot); orders placed before it was recorded fall back to the catalog
        if (!i.categoryId && !categories.has(productId)) categories.set(productId, (catalog ? await this.core.soft('catalog.getProduct', () => catalog.getProduct(productId)) : undefined)?.categoryId ?? null);
        const discount = i.discounts.reduce((n, d) => n + d.amount.amount, 0);
        const funded = (who: 'platform' | 'seller') => i.discounts.reduce((n, d) => n + (d.fundedBy === who ? d.amount.amount : d.fundedBy === 'shared' ? (who === 'platform' ? Math.ceil(d.amount.amount / 2) : Math.floor(d.amount.amount / 2)) : 0), 0);
        let cost: number | null = null;
        if (ownerType === 'official' && inventory) {
          const unit = await this.core.soft('inventory.getUnitCost', () => inventory.getUnitCost(i.stockItemId));
          if (unit) cost = unit.amount * i.quantity;
        }
        rows.push({
          order_item_id: i.id,
          order_id: order.id,
          owner_type: ownerType,
          seller_id: ownerType === 'seller' ? (g.seller.id ?? null) : null,
          customer_key: key,
          category_id: i.categoryId ?? categories.get(productId) ?? null,
          product_id: productId,
          offer_id: i.offer.offerId,
          quantity: i.quantity,
          item_minor: i.lineSubtotal.amount - discount,
          shipping_minor: i.shippingShare.amount,
          discount_platform_minor: funded('platform'),
          discount_seller_minor: funded('seller'),
          tax_minor: i.taxShare.amount,
          currency: i.lineSubtotal.currency,
          placed_at: new Date(order.placedAt),
          accepted_at: order.acceptedAt ? new Date(order.acceptedAt) : null,
          group_id: g.id,
          fulfilled_by: g.fulfilledBy ?? null,
          paid_at: null,
          shipped_at: null,
          delivered_at: i.deliveredAt ? new Date(i.deliveredAt) : null,
          completed_at: null,
          cancelled_at: null,
          cancelled_by: null,
          cancelled_minor: 0,
          refunded_minor: 0,
          last_refund_at: null,
          buying_cost_minor: cost,
          fee_minor: null,
        });
      }
    }
    return rows;
  }

  async onOrderPlaced(p: EventPayload<'orders.order.placed'>, env: Env) {
    if (p.paymentState === 'accepted') await this.ensureOrder(p.orderId, { customerId: p.customerId, email: p.guestEmail, accepted: true });
    await this.keepFulfilledBy(p.orderId, p.groups);
    await this.touch(['order_items', 'customers'], env);
  }

  async onOrderAccepted(p: EventPayload<'orders.order.accepted'>, env: Env) {
    await this.ensureOrder(p.orderId, { customerId: p.customerId, email: p.contactEmail, accepted: true });
    await this.keepFulfilledBy(p.orderId, p.groups);
    await this.touch(['order_items', 'customers', 'discovery'], env);
  }

  /** fact_order_items.fulfilled_by from the event's groups (PlacedGroup.fulfilledBy), for rows that do not hold it yet */
  private async keepFulfilledBy(orderId: string, groups: readonly orders.PlacedGroup[]) {
    for (const g of groups) {
      if (g.fulfilledBy) await this.repo.updateOrderItems({ orderId, groupId: g.groupId, nullColumn: 'fulfilled_by' }, { fulfilled_by: g.fulfilledBy });
    }
  }

  async onPaymentCaptured(p: EventPayload<'payments.payment.captured'>, env: Env) {
    await this.ensureOrder(p.orderId, { accepted: true });
    const at = new Date(p.capturedAt);
    // captured groups: the event's group (per-group capture) or its allocations; rows recorded before group_id
    // existed (null) fall back to the group's owner
    const groups = p.groupId ? p.allocations.filter((a) => a.groupId === p.groupId) : p.allocations;
    if (!groups.length && !p.groupId) await this.repo.updateOrderItems({ orderId: p.orderId, nullColumn: 'paid_at' }, { paid_at: at });
    if (!groups.length && p.groupId) await this.repo.updateOrderItems({ orderId: p.orderId, groupId: p.groupId, nullColumn: 'paid_at' }, { paid_at: at });
    for (const a of groups) {
      await this.repo.updateOrderItems({ orderId: p.orderId, groupId: a.groupId, nullColumn: 'paid_at' }, { paid_at: at });
      await this.repo.updateOrderItems({ orderId: p.orderId, groupId: null, ownerType: a.ownerType, sellerId: a.ownerType === 'seller' ? (a.sellerId ?? null) : null, nullColumn: 'paid_at' }, { paid_at: at });
    }
    await this.touch(['order_items'], env);
  }

  /**
   * Shipment date basis and on-time dispatch. A dispatch Marketly's warehouse made for a Fulfilled by Marketly group
   * (fulfilledBy marketly_service) counts in fact_marketly_fulfillment_daily for the seller of record, never in the
   * seller's fact_service_daily row (seller dispatch figures only count what the seller shipped).
   */
  async onShipmentDispatched(p: EventPayload<'shipping.shipment.dispatched'>, env: Env) {
    if (p.kind === 'return') return this.touch(['service'], env);
    await this.ensureOrder(p.orderId, { accepted: true });
    await this.repo.updateOrderItems({ itemIds: p.lines.map((l) => l.orderItemId), nullColumn: 'shipped_at' }, { shipped_at: new Date(p.shippedAt) });
    const marketly = isMarketly(p);
    if (p.kind === 'outbound') {
      const day = await this.day(p.shippedAt);
      const onTime = p.onTime === false ? 0 : 1;
      await this.repo.transaction(async (tx) => {
        if (!(await tx.claim(`service:dispatched:${p.shipmentId}`))) return;
        if (marketly) await tx.bumpDaily('fact_marketly_fulfillment_daily', { seller_id: p.sellerId!, day }, { dispatched: 1, dispatched_on_time: onTime });
        else await tx.bumpService(p.sellerId ?? OFFICIAL_KEY, day, { dispatched: 1, dispatched_on_time: onTime, valid_tracking: p.trackingValid ? 1 : 0 });
      });
    }
    await this.touch(['order_items', marketly ? 'marketly_fulfillment' : 'service'], env);
  }

  async onDispatchOverdue(p: EventPayload<'shipping.dispatch.overdue'>, env: Env) {
    const day = await this.day(env.at);
    const marketly = isMarketly(p);
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`service:overdue:${p.exceptionId}`))) return;
      if (marketly) await tx.bumpDaily('fact_marketly_fulfillment_daily', { seller_id: p.sellerId!, day }, { overdue: 1 });
      else await tx.bumpService(p.sellerId ?? OFFICIAL_KEY, day, { overdue: 1 });
    });
    await this.touch([marketly ? 'marketly_fulfillment' : 'service'], env);
  }

  /** Delivery issues: a Fulfilled by Marketly package's go to the Marketly fulfillment row of its seller of record, never the seller's own */
  async onShipmentException(p: EventPayload<'shipping.shipment.exception'>, env: Env) {
    const day = await this.day(env.at);
    const marketly = isMarketly(p);
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`service:exception:${p.exceptionId}`))) return;
      if (marketly) await tx.bumpDaily('fact_marketly_fulfillment_daily', { seller_id: p.sellerId!, day }, { delivery_exceptions: 1 });
      else await tx.bumpService(p.sellerId ?? OFFICIAL_KEY, day, { delivery_exceptions: 1 });
    });
    await this.touch([marketly ? 'marketly_fulfillment' : 'service'], env);
  }

  async onItemDelivered(p: EventPayload<'orders.item.delivered'>, env: Env) {
    await this.ensureOrder(p.orderId, { accepted: true });
    await this.repo.updateOrderItems({ itemIds: [p.itemId], nullColumn: 'delivered_at' }, { delivered_at: new Date(p.deliveredAt) });
    await this.touch(['order_items'], env);
  }

  async onOrderCompleted(p: EventPayload<'orders.order.completed'>, env: Env) {
    await this.ensureOrder(p.orderId, { accepted: true });
    await this.repo.updateOrderItems({ orderId: p.orderId, nullColumn: 'completed_at' }, { completed_at: new Date(p.completedAt) });
    await this.touch(['order_items'], env);
  }

  async onItemCancelled(p: EventPayload<'orders.item.cancelled'>, env: Env) {
    const rows = await this.ensureOrder(p.orderId, { accepted: true });
    // a partial cancellation splits the line: the cancelled part counts against the original line of the same offer
    const target = rows.find((r) => r.order_item_id === p.itemId) ?? rows.find((r) => r.offer_id === p.offerId);
    const day = await this.day(env.at);
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`cancellation:${p.cancellationId}:${p.itemId}`))) return;
      if (target) {
        const amount = Math.max(0, p.refund.itemAmount.amount - p.refund.discountShare.amount);
        await tx.addToOrderItem(target.order_item_id, { cancelled_minor: amount }, { cancelled_at: new Date(env.at), cancelled_by: p.initiatedBy });
        await tx.adjustCustomerSpend(target.customer_key, -p.refund.total.amount);
      }
      if (p.countsAgainstSeller || p.initiatedBy === 'seller') await tx.bumpService(p.sellerId ?? OFFICIAL_KEY, day, { seller_cancellations: 1 });
    });
    await this.touch(['order_items', 'service', 'customers'], env);
  }

  /**
   * payments.refund.sent: one fact_refunds row per seller (decision D5). The items the refund names go to their
   * sellers; the rest (shipping, unnamed amounts) is split proportionally to each seller's item amounts on the
   * order. after_payout: a payout to that seller was paid between the item's delivery and the refund (the sale may
   * already have been paid out).
   */
  async onRefundSent(p: EventPayload<'payments.refund.sent'>, env: Env) {
    const rows = await this.ensureOrder(p.orderId, { accepted: true });
    const keyOf = (sellerId: string | null | undefined) => (isOfficialSeller(sellerId) ? OFFICIAL_KEY : sellerId!);
    const rowSeller = (r: OrderItemFact) => (r.owner_type === 'official' ? OFFICIAL_KEY : keyOf(r.seller_id));
    const shares = splitRefund(
      p.amount.amount,
      p.items.map((i) => {
        const row = rows.find((r) => r.order_item_id === i.orderItemId);
        return { sellerId: i.sellerId ? keyOf(i.sellerId) : row ? rowSeller(row) : OFFICIAL_KEY, amount: i.amount.amount };
      }),
      rows.map((r) => ({ sellerId: rowSeller(r), weight: Number(r.item_minor) })),
    );
    const sentAt = new Date(p.sentAt);
    const sentDay = await this.day(sentAt);
    // after_payout per seller, read before the transaction
    const afterPayout = new Map<string, boolean>();
    for (const sellerId of shares.keys()) {
      if (sellerId === OFFICIAL_KEY) {
        afterPayout.set(sellerId, false);
        continue;
      }
      const theirs = rows.filter((r) => rowSeller(r) === sellerId && r.delivered_at);
      const named = theirs.filter((r) => p.items.some((i) => i.orderItemId === r.order_item_id));
      const delivered = (named.length ? named : theirs).map((r) => new Date(r.delivered_at!).getTime());
      afterPayout.set(sellerId, delivered.length ? await this.repo.paidPayoutBetween(sellerId, await this.day(new Date(Math.min(...delivered))), sentDay) : false);
    }
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`refund:${p.refundId}`))) return;
      for (const [sellerId, amount] of shares) {
        await tx.insertRefund({
          refund_id: p.refundId,
          seller_id: sellerId,
          order_id: p.orderId,
          owner_type: sellerId === OFFICIAL_KEY ? 'official' : 'seller',
          amount_minor: amount,
          currency: p.amount.currency,
          reason: p.origin || null,
          after_payout: afterPayout.get(sellerId) ?? false,
          sent_at: sentAt,
        });
      }
      for (const i of p.items) {
        const row = rows.find((r) => r.order_item_id === i.orderItemId);
        if (row) await tx.addToOrderItem(row.order_item_id, { refunded_minor: i.amount.amount }, { last_refund_at: sentAt });
      }
      if (rows[0]) await tx.adjustCustomerSpend(rows[0].customer_key, -p.amount.amount);
    });
    await this.touch(['refunds', 'order_items', 'customers'], env);
  }

  async onReturnRequested(p: EventPayload<'returns.return.requested'>, env: Env) {
    const rows = (await this.ensureOrder(p.orderId, { accepted: true })).filter((r) => p.orderItemIds.includes(r.order_item_id));
    const first = rows[0];
    if (!first) {
      this.core.ctx.log.debug({ returnId: p.returnId }, 'reports: return for items without facts');
      return this.touch(['returns'], env);
    }
    await this.repo.insertReturn({
      return_id: p.returnId,
      seller_id: p.sellerId ?? OFFICIAL_KEY,
      product_id: first.product_id,
      category_id: first.category_id,
      units: rows.reduce((n, r) => n + r.quantity, 0),
      reason: p.reason,
      requested_at: new Date(env.at),
      outcome: null,
      stock_outcome: null,
    });
    await this.touch(['returns'], env);
  }

  async onReturnInspected(p: EventPayload<'returns.return.inspected'>, env: Env) {
    await this.repo.updateReturn(p.returnId, { outcome: p.conditionOutcome, stock_outcome: p.proposedStockOutcome });
    await this.touch(['returns'], env);
  }

  /* ---------------------------------------------------------------- discovery */

  async onStockChanged(p: EventPayload<'inventory.stock.changed'>, env: Env) {
    const productId = await this.productOf(p.offerId ?? null);
    if (!productId) return this.touch(['discovery'], env);
    if (p.state === 'out_of_stock') {
      // the first out-of-stock time of an open interval stays (open_stockouts); a redelivered event changes nothing
      await this.repo.transaction(async (tx) => {
        if (await tx.claim(`stock:${env.id}`)) await tx.openStockout(p.stockItemId, productId, new Date(env.at));
      });
    } else {
      const open = await this.repo.getStockout(p.stockItemId);
      if (open) {
        const days = await this.minutesByDay(open.since, new Date(env.at));
        await this.repo.transaction(async (tx) => {
          if (!(await tx.claim(`stock:${env.id}`))) return;
          const still = await tx.getStockout(p.stockItemId, { forUpdate: true });
          if (!still || still.since.getTime() !== open.since.getTime()) return; // closed meanwhile
          await tx.closeStockout(p.stockItemId);
          for (const [day, minutes] of days) await tx.bumpDaily('fact_discovery_daily', { product_id: open.product_id, day }, { stockout_minutes: minutes });
        });
      }
    }
    await this.touch(['discovery'], env);
  }

  /** Minutes of an interval per market day */
  private async minutesByDay(from: Date, to: Date): Promise<[string, number][]> {
    const tz = await this.tz();
    const out = new Map<string, number>();
    let t = from.getTime();
    const end = Math.max(t, to.getTime());
    while (t < end) {
      const step = Math.min(end, t + 15 * MINUTE);
      const day = marketDay(new Date(t), tz);
      out.set(day, (out.get(day) ?? 0) + (step - t) / MINUTE);
      t = step;
    }
    return [...out].map(([d, m]) => [d, Math.round(m)] as [string, number]).filter(([, m]) => m > 0);
  }

  private async productOf(offerId: string | null): Promise<string | null> {
    if (!offerId) return null;
    const offers = this.core.api('offers');
    if (!offers) return null;
    return (await this.core.soft('offers.getOffer', () => offers.getOffer(offerId)))?.productId ?? null;
  }

  async onCartItemAdded(p: EventPayload<'cart.item.added'>, env: Env) {
    const day = await this.day(env.at);
    await this.repo.transaction(async (tx) => {
      if (await tx.claim(`cart_add:${env.id}`)) await tx.bumpDaily('fact_discovery_daily', { product_id: p.productId, day }, { cart_adds: 1 });
    });
    await this.touch(['discovery'], env);
  }

  /** Discovery signals that are not events (anonymous counts only) */
  async recordSignal(s: { kind: 'product_view' | 'search_no_result' | 'cart_add'; productId?: string; offerId?: string; query?: string; sessionKey?: string; at: string }) {
    const now = this.core.now();
    let at = new Date(s.at);
    if (Number.isNaN(at.getTime()) || at > now || now.getTime() - at.getTime() > DAY) at = now;
    const day = await this.day(at);
    if (s.kind === 'search_no_result') {
      const q = (s.query ?? '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
      if (q) await this.repo.bumpDaily('fact_search_misses_daily', { day, query_norm: q }, { count: 1 });
      return;
    }
    const productId = s.productId ?? (await this.productOf(s.offerId ?? null));
    if (!productId || !/^[0-9a-f-]{36}$/i.test(productId)) return;
    await this.repo.bumpDaily('fact_discovery_daily', { product_id: productId, day }, s.kind === 'cart_add' ? { cart_adds: 1 } : { views: 1 });
  }

  /** POST /api/store/reports/signals: product views from the website and the app */
  async recordStoreSignals(signals: unknown[], principal: identity.Principal & { sessionId?: string | null }, customerId: string | null) {
    if (signals.length > 50) throw invalid([{ path: 'signals', message: 'Send at most 50 signals per call' }]);
    const session = principal.sessionId ?? principal.guestSessionId ?? principal.accountId ?? 'anonymous';
    const now = this.core.now().getTime();
    const w = this.#signalWindows.get(session);
    const window = w && now - w.start < 10 * MINUTE ? w : { start: now, count: 0 };
    if (window.count + signals.length > 500) throw new AppError('RATE_LIMITED', 'Too many signals from this session; try again in a few minutes');
    window.count += signals.length;
    this.#signalWindows.set(session, window);
    if (this.#signalWindows.size > 10_000) for (const [k, v] of this.#signalWindows) if (now - v.start >= 10 * MINUTE) this.#signalWindows.delete(k);

    // shoppers who turned off personalisation are not counted
    if (customerId) {
      const customers = this.core.api('customers');
      const prefs = customers ? await this.core.soft('customers.getMarketingConsent', () => customers.getMarketingConsent(customerId)) : undefined;
      if (prefs && prefs.personalizedRecommendations === false) return;
    }
    for (const raw of signals) {
      if (!raw || typeof raw !== 'object') continue;
      const s = raw as { kind?: unknown; productId?: unknown; at?: unknown };
      if (s.kind !== 'product_view' || typeof s.productId !== 'string') continue;
      await this.recordSignal({ kind: 'product_view', productId: s.productId, at: typeof s.at === 'string' ? s.at : new Date(now).toISOString() });
    }
  }

  /* ---------------------------------------------------------------- service */

  async onMessageSent(p: EventPayload<'messaging.message.sent'>, env: Env) {
    if (p.authorKind === 'customer' && p.sellerId) {
      const day = await this.day(env.at);
      await this.repo.transaction(async (tx) => {
        if (await tx.claim(`message:${p.messageId}`)) await tx.bumpService(p.sellerId!, day, { messages_received: 1 });
      });
    }
    await this.touch(['service'], env);
  }

  async onCaseOpened(p: EventPayload<'support.case.opened'>, env: Env) {
    const day = await this.day(env.at);
    await this.repo.transaction(async (tx) => {
      if (await tx.claim(`case:opened:${p.caseId}`)) await tx.bumpService(p.sellerId ?? OFFICIAL_KEY, day, { cases_opened: 1, cases_open_eod: 1 }, p.category || 'other');
    });
    await this.touch(['service'], env);
  }

  async onCaseResolved(p: EventPayload<'support.case.resolved'>, env: Env) {
    const day = await this.day(p.resolvedAt);
    await this.repo.transaction(async (tx) => {
      if (await tx.claim(`case:resolved:${p.caseId}`)) await tx.bumpService(p.sellerId ?? OFFICIAL_KEY, day, { cases_open_eod: -1 });
    });
    await this.touch(['service'], env);
  }

  /* ---------------------------------------------------------------- marketplace finance */

  private async financeBump(seen: string, sellerId: string, day: string, add: Record<string, number>) {
    await this.repo.transaction(async (tx) => {
      if (await tx.claim(seen)) await tx.bumpDaily('fact_marketplace_finance_daily', { seller_id: sellerId, day }, add);
    });
  }

  async onPayoutPaid(p: EventPayload<'finance.payout.paid'>, env: Env) {
    await this.financeBump(`payout:paid:${p.payoutId}`, p.sellerId, await this.day(p.paidAt), { payouts_paid_minor: p.amount.amount });
    await this.touch(['marketplace_finance'], env);
  }

  async onPayoutFailed(p: EventPayload<'finance.payout.failed'>, env: Env) {
    await this.financeBump(`payout:failed:${p.payoutId}`, p.sellerId, await this.day(env.at), { payouts_failed: 1 });
    await this.touch(['marketplace_finance'], env);
  }

  async onHoldPlaced(p: EventPayload<'finance.hold.placed'>, env: Env) {
    await this.financeBump(`hold:placed:${p.holdId}`, p.sellerId, await this.day(env.at), { held_minor: p.amount.amount });
    await this.touch(['marketplace_finance'], env);
  }

  async onHoldReleased(p: EventPayload<'finance.hold.released'>, env: Env) {
    await this.financeBump(`hold:released:${p.holdId}`, p.sellerId, await this.day(env.at), { held_minor: -p.amount.amount });
    await this.touch(['marketplace_finance'], env);
  }

  async onAmountOwedCreated(p: EventPayload<'finance.amount_owed.created'>, env: Env) {
    await this.financeBump(`owed:${p.amountOwedId}`, p.sellerId, await this.day(env.at), { owed_minor: p.amount.amount });
    await this.touch(['marketplace_finance'], env);
  }

  /* ---------------------------------------------------------------- campaigns */

  async onCouponRedeemed(p: EventPayload<'promotions.coupon.redeemed'>, env: Env) {
    const day = await this.day(env.at);
    const sales = (await this.repo.getOrderItems(p.orderId)).reduce((n, r) => n + r.item_minor, 0);
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`redemption:${p.redemptionId}`))) return;
      await tx.rememberCampaign('redemption', p.redemptionId, p.campaignId, new Date(env.at));
      await tx.bumpDaily('fact_campaigns_daily', { campaign_kind: 'promotion', campaign_id: p.campaignId, day }, { discount_cost_minor: p.amount.amount, redemptions: 1, sales_minor: sales }, {}, { column: 'funded_by', add: { platform: p.platformPart.amount, seller: p.sellerPart.amount } });
    });
    await this.touch(['campaigns'], env);
  }

  async onRedemptionReversed(p: EventPayload<'promotions.redemption.reversed'>, env: Env) {
    const campaignId = await this.repo.campaignOf('redemption', p.redemptionId);
    if (campaignId) {
      const day = await this.day(env.at);
      await this.repo.transaction(async (tx) => {
        if (!(await tx.claim(`reversal:${p.redemptionId}:${p.orderItemId}`))) return;
        await tx.bumpDaily('fact_campaigns_daily', { campaign_kind: 'promotion', campaign_id: campaignId, day }, { discount_cost_minor: -p.amount.amount }, {}, { column: 'funded_by', add: { platform: -p.platformPart.amount, seller: -p.sellerPart.amount } });
      });
    } else this.core.ctx.log.debug({ redemptionId: p.redemptionId }, 'reports: reversal of a redemption not seen');
    await this.touch(['campaigns'], env);
  }

  async onChargePosted(p: EventPayload<'advertising.charge.posted'>, env: Env) {
    const day = isIsoDate(p.day) ? p.day : await this.day(env.at);
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`charge:${p.chargeId}`))) return;
      await tx.rememberCampaign('charge', p.chargeId, p.campaignId, new Date(env.at));
      await tx.bumpDaily('fact_campaigns_daily', { campaign_kind: 'ad', campaign_id: p.campaignId, day }, { spend_minor: p.amount.amount });
      await tx.bumpDaily('fact_marketplace_finance_daily', { seller_id: p.sellerId, day }, { ad_charges_minor: p.amount.amount });
    });
    await this.touch(['campaigns', 'marketplace_finance'], env);
  }

  async onChargeCredited(p: EventPayload<'advertising.charge.credited'>, env: Env) {
    const day = await this.day(env.at);
    const campaignId = await this.repo.campaignOf('charge', p.chargeId);
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`credit:${p.chargeId}`))) return;
      if (campaignId) await tx.bumpDaily('fact_campaigns_daily', { campaign_kind: 'ad', campaign_id: campaignId, day }, { spend_minor: -p.amount.amount });
      await tx.bumpDaily('fact_marketplace_finance_daily', { seller_id: p.sellerId, day }, { ad_charges_minor: -p.amount.amount });
    });
    await this.touch(['campaigns', 'marketplace_finance'], env);
  }

  /** Fulfilled by Marketly fees per seller and day, claimed per chargeId (the event carries no time: the day it was posted) */
  async onServiceFeeCharged(p: EventPayload<'fulfillment-service.fee.charged'>, env: Env) {
    await this.financeBump(`service_fee:charged:${p.chargeId}`, p.sellerId, await this.day(env.at), { service_fees_minor: p.amount.amount });
    await this.touch(['marketplace_finance'], env);
  }

  /** A reversed Fulfilled by Marketly fee comes off service_fees_minor on the reversal day */
  async onServiceFeeReversed(p: EventPayload<'fulfillment-service.fee.reversed'>, env: Env) {
    await this.financeBump(`service_fee:reversed:${p.chargeId}`, p.sellerId, await this.day(env.at), { service_fees_minor: -Math.abs(p.amount.amount) });
    await this.touch(['marketplace_finance'], env);
  }

  /* ---------------------------------------------------------------- daily pull (02:30 market time) */

  /** Figures without events: fee income, seller sales and discount funding, unavailable searches, ad performance, buying costs, reply times */
  async pullDaily(days = 3) {
    const tz = await this.tz();
    const today = marketDay(this.core.now(), tz);
    const to = addDays(today, -1);
    const from = addDays(to, -(days - 1));
    await this.pullFinance(from, to);
    await this.pullSearches(to);
    await this.pullAds(from, to);
    await this.pullCosts();
    await this.pullReplyTimes(to);
  }

  private async markPulled(model: string, through: string) {
    await this.repo.upsertCheckpoint(`pull:${model}`, { last_event_id: through, last_event_at: this.core.now(), state: 'live' });
    const cp = await this.repo.getCheckpoint(model);
    if (cp?.state === 'stale') await this.repo.upsertCheckpoint(model, { state: 'live' });
  }

  async pullFinance(from: string, to: string) {
    await this.pullFinanceTotals(from, to);
    const tz = await this.tz();
    for (const s of await this.repo.sellerSalesByDay(from, to, tz)) {
      await this.repo.bumpDaily('fact_marketplace_finance_daily', { seller_id: s.sellerId, day: s.day }, {}, { seller_sales_minor: s.sales, platform_discount_minor: s.platformDiscount, seller_discount_minor: s.sellerDiscount });
    }
    const finance = this.core.api('finance');
    if (!finance) return;
    const income = await this.core.soft('finance.marketplaceIncomeByDay', () => finance.marketplaceIncomeByDay({ from, to }));
    if (!income) return;
    for (const r of income) await this.repo.bumpDaily('fact_marketplace_finance_daily', { seller_id: r.sellerId, day: r.date }, {}, { fee_income_minor: r.netFeeIncome.amount });
    await this.markPulled('marketplace_finance', to);
  }

  /**
   * Job reports.pull-finance-recent (every 15 min): today and yesterday from finance into the three finance facts,
   * and the item fees changed since the last run. Fee income shows the same day instead of after the nightly pull.
   */
  async pullFinanceRecent() {
    const today = marketDay(this.core.now(), await this.tz());
    if (!(await this.pullFinanceTotals(addDays(today, -1), today))) return;
    await this.pullItemFees();
    await this.repo.upsertCheckpoint('pull:finance_recent', { last_event_id: today, last_event_at: this.core.now(), state: 'live' });
  }

  /**
   * The finance facts of market days from..to, set (never added) so a pull can run twice: ledger totals per seller
   * and day into fact_marketplace_finance_daily (LEDGER_COLUMNS, and fee_income_minor as fees less fee refunds),
   * company money into fact_company_daily, end-of-day balances into fact_seller_balances_daily. Long ranges go in
   * chunks of PULL_CHUNK_DAYS. False when finance is off or did not answer.
   */
  async pullFinanceTotals(from: string, to: string): Promise<boolean> {
    const finance = this.core.api('finance');
    if (!finance) return false;
    for (let start = from; start <= to; start = addDays(start, PULL_CHUNK_DAYS)) {
      const end = addDays(start, PULL_CHUNK_DAYS - 1) < to ? addDays(start, PULL_CHUNK_DAYS - 1) : to;
      const range = { from: start, to: end };
      const [ledger, company, balances] = await Promise.all([
        this.core.soft('finance.ledgerDailyTotals', () => finance.ledgerDailyTotals(range)),
        this.core.soft('finance.companyDailyTotals', () => finance.companyDailyTotals(range)),
        this.core.soft('finance.sellerBalancesByDay', () => finance.sellerBalancesByDay(range)),
      ]);
      if (!ledger || !company || !balances) return false;
      const perSellerDay = new Map<string, Record<string, number>>();
      for (const r of ledger) {
        const map = LEDGER_COLUMNS[r.type];
        if (!map) continue;
        const key = `${r.sellerId}|${r.day}`;
        const cols = perSellerDay.get(key) ?? { ...LEDGER_COLUMN_DEFAULTS };
        cols[map.column] = (cols[map.column] ?? 0) + map.sign * r.amount.amount;
        perSellerDay.set(key, cols);
      }
      for (const [key, cols] of perSellerDay) {
        const [sellerId, day] = key.split('|') as [string, string];
        await this.repo.bumpDaily('fact_marketplace_finance_daily', { seller_id: sellerId, day }, {}, { ...cols, fee_income_minor: (cols.fee_gross_minor ?? 0) - (cols.fee_refunds_minor ?? 0) });
      }
      for (let day = start; day <= end; day = addDays(day, 1)) {
        await this.repo.replaceDay('fact_company_daily', day, company.filter((c) => c.day === day).map((c) => ({ day, source: c.source, kind: c.kind, amount_minor: c.amount.amount })));
        await this.repo.replaceDay('fact_seller_balances_daily', day, balances.filter((b) => b.day === day).map((b) => ({ seller_id: b.sellerId, day, pending_minor: b.pending.amount, available_minor: b.available.amount, held_minor: b.held.amount, owed_minor: b.owed.amount })));
      }
    }
    await this.markPulled('company_finance', to);
    await this.markPulled('seller_balances', to);
    return true;
  }

  /**
   * fact_order_items.fee_minor (fee less fee refunds) for the fee charges changed since the last pull, page by page
   * (finance.itemFeesChangedSince). `full` reads every charge (a rebuild). The last change seen is kept in the
   * checkpoint cursor:item_fees; the next pull starts a little before it (FEE_PULL_OVERLAP_MS).
   */
  async pullItemFees(o: { full?: boolean } = {}) {
    const finance = this.core.api('finance');
    if (!finance) return;
    const cp = await this.repo.getCheckpoint('cursor:item_fees');
    const since = o.full || !cp?.last_event_at ? new Date(0) : new Date(cp.last_event_at.getTime() - FEE_PULL_OVERLAP_MS);
    let after: string | undefined;
    let last: { cursor: string; at: Date } | undefined;
    for (;;) {
      const page = await this.core.soft('finance.itemFeesChangedSince', () => finance.itemFeesChangedSince({ since: since.toISOString(), ...(after ? { after } : {}), limit: 500 }));
      if (!page?.length) break;
      for (const f of page) await this.repo.updateOrderItems({ itemIds: [f.orderItemId] }, { fee_minor: f.fee.amount - f.refundedFee.amount });
      after = page.at(-1)!.cursor;
      last = { cursor: after, at: new Date(page.at(-1)!.changedAt) };
      if (page.length < 500) break;
    }
    if (last && (!cp?.last_event_at || last.at > cp.last_event_at)) await this.repo.upsertCheckpoint('cursor:item_fees', { last_event_id: last.cursor, last_event_at: last.at, state: 'live' });
  }

  async pullSearches(day: string) {
    const search = this.core.api('search');
    if (!search) return;
    const stats = await this.core.soft('search.zeroResultStats', () => search.zeroResultStats(day, day));
    if (!stats) return;
    for (const q of stats) {
      const norm = (q.normalized || q.query).trim().toLowerCase().slice(0, 200);
      if (norm) await this.repo.bumpDaily('fact_search_misses_daily', { day, query_norm: norm }, {}, { count: q.count });
    }
    await this.markPulled('search_misses', day);
  }

  async pullAds(from: string, to: string) {
    const ads = this.core.api('advertising');
    if (!ads) return;
    const perf = await this.core.soft('advertising.dailyPerformance', () => ads.dailyPerformance({ from, to }));
    if (!perf) return;
    for (const r of perf) await this.repo.bumpDaily('fact_campaigns_daily', { campaign_kind: 'ad', campaign_id: r.campaignId, day: r.date }, {}, { displays: r.displays, clicks: r.clicks, dismissals: r.dismissals, attributed_purchases: r.attributedOrders });
    await this.markPulled('campaigns', to);
  }

  /** Buying costs of Official Store items sold in the last 30 days whose cost was unknown when they were sold */
  async pullCosts() {
    const inventory = this.core.api('inventory');
    const ordersApi = this.core.api('orders');
    if (!inventory || !ordersApi) return;
    const items = await this.repo.officialItemsWithoutCost(new Date(this.core.now().getTime() - 30 * DAY), 200);
    const byOrder = new Map<string, OrderItemFact[]>();
    for (const i of items) byOrder.set(i.order_id, [...(byOrder.get(i.order_id) ?? []), i]);
    for (const [orderId, rows] of byOrder) {
      const order = await this.core.soft('orders.getOrder', () => ordersApi.getOrder(orderId));
      if (!order) continue;
      for (const r of rows) {
        const item = order.groups.flatMap((g) => g.items).find((i) => i.id === r.order_item_id);
        if (!item) continue;
        const unit = await this.core.soft('inventory.getUnitCost', () => inventory.getUnitCost(item.stockItemId));
        if (unit) await this.repo.updateOrderItems({ itemIds: [r.order_item_id], nullColumn: 'buying_cost_minor' }, { buying_cost_minor: unit.amount * r.quantity });
      }
    }
  }

  async pullReplyTimes(day: string) {
    const messaging = this.core.api('messaging');
    if (!messaging) return;
    for (const sellerId of await this.repo.sellersWithMessages(day)) {
      if (sellerId === OFFICIAL_KEY) continue;
      const stats = await this.core.soft('messaging.sellerResponseStats', () => messaging.sellerResponseStats(sellerId, { from: day, to: day }));
      // the median first reply time (messaging's medianReplyMinutes), the average when messaging gives no median
      const p50 = stats?.medianReplyMinutes ?? stats?.averageReplyMinutes;
      if (p50 != null) await this.repo.bumpDaily('fact_service_daily', { seller_id: sellerId, day }, {}, { first_reply_minutes_p50: Math.round(p50) });
    }
  }

  /* ---------------------------------------------------------------- health and rebuilds */

  async status(): Promise<ReadModelStatus[]> {
    const now = this.core.now().getTime();
    const cps = await this.repo.listCheckpoints(READ_MODELS.flatMap((m) => [m.key, `pull:${m.key}`]));
    const out: ReadModelStatus[] = [];
    for (const m of READ_MODELS) {
      const cp = cps.find((c) => c.key === m.key);
      const pull = cps.find((c) => c.key === `pull:${m.key}`);
      const last = [cp?.last_event_at, pull?.last_event_at].filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0];
      const state = (cp?.state ?? 'live') as ReadModelStatus['state'];
      out.push({
        key: m.key,
        description: m.description,
        sourceEvents: m.sourceEvents,
        lastEventAt: last?.toISOString() ?? null,
        lagSeconds: state === 'stale' && last ? Math.max(0, Math.round((now - last.getTime()) / 1000)) : 0,
        rows: await this.repo.countRows(m.table as never),
        state,
        rebuildProgressPct: state === 'rebuilding' ? (cp?.rebuild_progress ?? 0) : null,
        rebuildable: Boolean(REBUILDS[m.key]),
        rebuildNote: REBUILDS[m.key] ?? EVENT_ONLY_NOTE,
      });
    }
    return out;
  }

  async requestRebuild(key: string, reason: string, by: Caller): Promise<ReadModelStatus> {
    const def = readModelDef(key);
    if (!def) throw notFound('Read model');
    if (!reason.trim()) throw invalid([{ path: 'reason', message: 'Say why the read model is rebuilt' }]);
    // refunds, returns and service are kept from events only: nothing to rebuild them from yet
    if (!REBUILDS[key]) throw this.core.ctx.error('REBUILD_UNAVAILABLE', `${def.description} is kept from events only and cannot be rebuilt until an event log exists`, { key });
    const cp = await this.repo.getCheckpoint(key);
    if (cp?.state === 'rebuilding') throw new AppError('CONFLICT', `${key} is already being rebuilt`, { startedAt: cp.rebuild_started_at?.toISOString() ?? null });
    await this.repo.upsertCheckpoint(key, { state: 'rebuilding', rebuild_started_at: this.core.now(), rebuild_progress: 0 });
    await this.core.audit({ action: 'reports.read_model.rebuild', actionLabel: 'Started a read model rebuild', category: 'settings', target: { type: 'read_model', id: key, label: def.description, screen: 'admin/reports' }, before: { state: cp?.state ?? 'live' }, after: { state: 'rebuilding' }, reason: reason.trim() }, by);
    return (await this.status()).find((s) => s.key === key)!;
  }

  /** Job reports.check-lag: resumes rebuilds, marks daily-pulled models stale when the pull is late */
  async checkLag() {
    const cfg = await this.core.cfg();
    const now = this.core.now().getTime();
    for (const m of READ_MODELS) {
      const cp = await this.repo.getCheckpoint(m.key);
      if (cp?.state === 'rebuilding') {
        await this.rebuild(m.key);
        continue;
      }
      if (m.pulled) {
        const pull = await this.repo.getCheckpoint(`pull:${m.key}`);
        const late = pull?.last_event_at ? now - pull.last_event_at.getTime() > DAY + cfg.readModelMaxLagMinutes * MINUTE : false;
        if (late && cp?.state !== 'stale') await this.repo.upsertCheckpoint(m.key, { state: 'stale' });
      }
    }
  }

  /** Rebuild from source snapshots: order facts are refreshed from orders, buyers recomputed, daily pulls repeated */
  async rebuild(key: string) {
    const progress = (pct: number) => this.repo.upsertCheckpoint(key, { rebuild_progress: pct });
    try {
      const tz = await this.tz();
      const today = marketDay(this.core.now(), tz);
      switch (key) {
        case 'order_items': {
          const ordersApi = this.core.api('orders');
          if (!ordersApi) throw new AppError('SERVICE_UNAVAILABLE', 'orders is switched off');
          const total = Math.max(1, await this.repo.countRows('fact_order_items'));
          let after: string | null = null;
          let done = 0;
          for (;;) {
            const ids = await this.repo.orderIdsWithFacts(after, 100);
            if (!ids.length) break;
            for (const id of ids) await this.refreshOrder(id);
            done += ids.length;
            after = ids.at(-1)!;
            await progress(Math.min(99, Math.round((done / total) * 100)));
          }
          // every item fee again (fee_minor), whatever the cursor says
          await this.pullItemFees({ full: true });
          break;
        }
        case 'customers':
          await this.repo.rebuildCustomers();
          break;
        case 'discovery':
          for (const r of await this.repo.purchasesByDay(addDays(today, -400), today, tz)) await this.repo.bumpDaily('fact_discovery_daily', { product_id: r.productId, day: r.day }, {}, { purchases: r.units });
          break;
        case 'marketplace_finance':
          await this.pullFinance(addDays(today, -REBUILD_DAYS), today);
          break;
        case 'company_finance':
        case 'seller_balances':
          await this.pullFinanceTotals(addDays(today, -REBUILD_DAYS), today);
          break;
        case 'search_misses':
          await this.pullSearches(addDays(today, -1));
          break;
        case 'campaigns':
          await this.pullAds(addDays(today, -90), today);
          break;
        default:
          // refunds, returns and service are kept from events only; the in-process bus keeps no event log to replay
          break;
      }
      await this.repo.upsertCheckpoint(key, { state: 'live', rebuild_progress: 100 });
    } catch (err) {
      this.core.ctx.log.error({ err, readModel: key }, 'reports: rebuild failed');
      await this.repo.upsertCheckpoint(key, { state: 'failed' });
    }
  }

  /** Dates and amounts of an order's facts from the order itself (delivery dates, categories, items added later) */
  private async refreshOrder(orderId: string) {
    const api = this.core.api('orders');
    const order = api ? await this.core.soft('orders.getOrder', () => api.getOrder(orderId)) : undefined;
    if (!order) return;
    const existing = await this.repo.getOrderItems(orderId);
    const fresh = await this.factsOf(order, {});
    const missing = fresh.filter((f) => !existing.some((e) => e.order_item_id === f.order_item_id)).map((f) => ({ ...f, customer_key: existing[0]?.customer_key ?? f.customer_key }));
    if (missing.length) await this.repo.insertOrderItems(missing);
    for (const f of fresh) {
      const e = existing.find((x) => x.order_item_id === f.order_item_id);
      if (!e) continue;
      await this.repo.updateOrderItems(
        { itemIds: [f.order_item_id] },
        { category_id: f.category_id ?? e.category_id, delivered_at: e.delivered_at ?? f.delivered_at, buying_cost_minor: e.buying_cost_minor ?? f.buying_cost_minor, fulfilled_by: e.fulfilled_by ?? f.fulfilled_by },
      );
    }
  }
}
