/**
 * Food orders: placed from the basket and paid by card through payments purchase intents (authorized at placement,
 * captured on delivery, voided when declined or cancelled); staff move them through the Food order state machine on
 * the restaurant's behalf; customers cancel before acceptance and rate them once delivered.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { money } from '../../../kernel/lib/money.js';
import type { Page, PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type * as payments from '../../../spec/payments.js';
import type { FoodOrder, FoodOrderAdmin, FoodReview, OrderAction, OrderLine, PlaceOrderInput, RestaurantCard, RetryPaymentInput, ReviewAdmin, ReviewInput, ReviewModeration, StatusChange } from '../../../spec/food.js';
import { ADMIN_ACTIONS, deliveryLabel, moneyLabel, etaLabel, etaWindow, feeLabel, LIMITS, makeRef, OPEN_STATUSES, PAST_STATUSES, shortName, statusLabel, withRating, type AdminAction, type OrderStatus } from '../domain/rules.js';
import { foodOrderMachine } from '../domain/state-machines.js';
import type { OrderRow, RestaurantRow, RestaurantSnapshot, ReviewRow, StoredChange, StoredOrderLine } from '../ports.js';
import type { FoodRepository } from '../repository.js';
import { invalid, notFound, optionalText, present, stringsOf, unique, type By, type Refs } from './base.js';
import { FoodBasket } from './basket.js';

type Event = Parameters<typeof foodOrderMachine.next>[1];
/** How long a payment may wait in a bank challenge before the order is dropped */
const CHALLENGE_MINUTES = 30;
const JOB_BATCH = 100;
const SYSTEM = 'Marketly';
const ACTION_LABEL: Record<AdminAction, string> = { accept: 'Accepted', decline: 'Declined', prepare: 'Started preparing', send: 'Sent out', deliver: 'Delivered', cancel: 'Cancelled' };

const historyOf = (v: unknown): StoredChange[] => (Array.isArray(v) ? (v as StoredChange[]).filter((h) => h && typeof h.status === 'string' && typeof h.at === 'string').map((h) => ({ status: h.status, at: h.at, by: h.by ?? null, note: h.note ?? null })) : []);
const linesOf = (v: unknown): StoredOrderLine[] => (Array.isArray(v) ? (v as StoredOrderLine[]) : []);
const snapshotOf = (v: unknown): RestaurantSnapshot => v as RestaurantSnapshot;
const reviewOut = (r: ReviewRow): FoodReview => ({ id: r.id, name: r.name, stars: r.stars, text: r.text, date: r.created_at.toISOString() });

export class FoodOrders extends FoodBasket {
  /* ---------------------------------------------------------------- output */

  /** The restaurant card of an order: the restaurant now, or the copy taken when it was placed */
  private orderRestaurant(o: OrderRow, r: RestaurantRow | undefined, refs: Refs): RestaurantCard {
    if (r) return this.restaurantCard(r, refs);
    const s = snapshotOf(o.restaurant);
    return { id: o.restaurant_id, slug: s.slug, name: s.name, cuisine: s.cuisine, image: s.imageId ? (refs.get(s.imageId) ?? null) : null, logo: s.logoId ? (refs.get(s.logoId) ?? null) : null, city: s.city, rating: null, ratingCount: 0, deliveryLabel: deliveryLabel(s.deliveryMin, s.deliveryMax), feeLabel: feeLabel(money(o.delivery_fee, o.currency)), promoBadge: null, open: false, openLabel: 'Closed today', distanceLabel: null, saved: false };
  }

  private async outputParts(rows: OrderRow[]) {
    const restaurants = new Map((await this.repo.restaurantsByIds(unique(rows.map((o) => o.restaurant_id)))).map((r) => [r.id, r]));
    const refs = await this.refsMap([
      ...[...restaurants.values()].flatMap((r) => [r.image_id, r.logo_id]),
      ...rows.flatMap((o) => [snapshotOf(o.restaurant).imageId, snapshotOf(o.restaurant).logoId, ...linesOf(o.lines).map((l) => l.imageId)]),
    ]);
    return { restaurants, refs };
  }

  private linesOut(o: OrderRow, refs: Refs): OrderLine[] {
    return linesOf(o.lines).map((l) => ({ itemId: l.itemId, name: l.name, image: l.imageId ? (refs.get(l.imageId) ?? null) : null, optionsLabel: l.optionsLabel, note: l.note, unitPrice: money(l.unitPrice, o.currency), quantity: l.quantity, total: money(l.total, o.currency) }));
  }

  private eta(o: OrderRow): string | null {
    const s = snapshotOf(o.restaurant);
    return etaLabel(o.status, { from: o.eta_from, to: o.eta_to }, { min: s.deliveryMin, max: s.deliveryMax }, s.timeZone || this.tz);
  }

  /** The payment of each order (payments' customer-facing view), when it has one */
  private async paymentsOf(rows: OrderRow[], refresh = false): Promise<Map<string, payments.PurchasePaymentStatus>> {
    const out = new Map<string, payments.PurchasePaymentStatus>();
    for (const o of rows) {
      if (!o.intent_id) continue;
      const p = await this.soft('payments.getPurchaseStatus', () => this.payments.getPurchaseStatus(o.intent_id!, refresh), null);
      if (p) out.set(o.id, p);
    }
    return out;
  }

  protected async ordersOut(rows: OrderRow[], given?: Map<string, payments.PurchasePaymentStatus>): Promise<FoodOrder[]> {
    if (!rows.length) return [];
    const [{ restaurants, refs }, reviews, pays] = await Promise.all([this.outputParts(rows), this.repo.reviewsOfOrders(rows.map((o) => o.id)), given ? Promise.resolve(given) : this.paymentsOf(rows)]);
    const reviewByOrder = new Map(reviews.map((r) => [r.order_id, r]));
    return rows.map((o) => {
      const card = this.orderRestaurant(o, restaurants.get(o.restaurant_id), refs);
      const review = reviewByOrder.get(o.id);
      return {
        id: o.id,
        ref: o.ref,
        status: o.status,
        statusLabel: statusLabel(o.status, card.name),
        restaurant: card,
        lines: this.linesOut(o, refs),
        itemCount: linesOf(o.lines).reduce((s, l) => s + l.quantity, 0),
        subtotal: money(o.subtotal, o.currency),
        deliveryFee: money(o.delivery_fee, o.currency),
        total: money(o.total, o.currency),
        address: o.address as unknown as common.Address,
        courierNote: o.courier_note,
        contactPhone: o.contact_phone,
        etaLabel: this.eta(o),
        placedAt: o.placed_at?.toISOString() ?? null,
        deliveredAt: o.delivered_at?.toISOString() ?? null,
        // customers see when the status changed, not who changed it
        history: historyOf(o.history).map((h): StatusChange => ({ status: h.status, at: h.at, by: null, note: h.note })),
        restaurantNote: o.restaurant_note,
        payment: pays.get(o.id) ?? null,
        canCancel: o.status === 'placed',
        canReview: o.status === 'delivered' && !o.reviewed,
        review: review ? reviewOut(review) : null,
        createdAt: o.created_at.toISOString(),
      };
    });
  }

  /** The moves staff can make now */
  private actionsOf(status: string): AdminAction[] {
    return ADMIN_ACTIONS.filter((a) => {
      try {
        foodOrderMachine.next(status as never, a as Event);
        return true;
      } catch {
        return false;
      }
    });
  }

  protected async ordersAdmin(rows: OrderRow[]): Promise<FoodOrderAdmin[]> {
    if (!rows.length) return [];
    const [{ restaurants, refs }, pays] = await Promise.all([this.outputParts(rows), this.paymentsOf(rows)]);
    const customers = new Map<string, { id: string; name: string | null; email: string | null }>();
    for (const id of unique(rows.map((o) => o.customer_id))) {
      const c = await this.soft('customers.getCustomer', () => this.customers.getCustomer(id), null);
      customers.set(id, { id, name: c?.displayName ?? null, email: c?.email ?? null });
    }
    return rows.map((o) => {
      const card = this.orderRestaurant(o, restaurants.get(o.restaurant_id), refs);
      return {
        id: o.id,
        ref: o.ref,
        status: o.status,
        statusLabel: statusLabel(o.status, card.name),
        restaurant: card,
        lines: this.linesOut(o, refs),
        subtotal: money(o.subtotal, o.currency),
        deliveryFee: money(o.delivery_fee, o.currency),
        total: money(o.total, o.currency),
        customer: customers.get(o.customer_id)!,
        address: o.address as unknown as common.Address,
        courierNote: o.courier_note,
        contactPhone: o.contact_phone,
        etaLabel: this.eta(o),
        history: historyOf(o.history),
        restaurantNote: o.restaurant_note,
        staffNote: o.staff_note,
        methodLabel: o.method_label ?? pays.get(o.id)?.methodLabel ?? null,
        paymentState: pays.get(o.id)?.state ?? null,
        intentId: o.intent_id,
        placedAt: o.placed_at?.toISOString() ?? null,
        createdAt: o.created_at.toISOString(),
        actions: this.actionsOf(o.status),
      };
    });
  }

  /* ---------------------------------------------------------------- moves */

  private publishStatus(o: OrderRow, note: string | null, by: By) {
    this.ctx.events.publish('food.order.status_changed', { orderId: o.id, ref: o.ref, customerId: o.customer_id, restaurantName: snapshotOf(o.restaurant).name, status: o.status, note }, by);
  }

  /**
   * Moves an order along the state machine and records it in its history (inside its own transaction unless `tx`
   * is given). `expect` refuses the move when the order is no longer in that status. Returns the new row, or
   * undefined when `quiet` and the move no longer applies.
   */
  private async move(id: string, event: Event, o: { by: string | null; note?: string | null; patch?: Partial<OrderRow>; quiet?: boolean; tx?: FoodRepository; expect?: (row: OrderRow) => boolean }): Promise<OrderRow | undefined> {
    const run = async (tx: FoodRepository) => {
      const row = await tx.getOrder(id, { forUpdate: true });
      if (!row) throw notFound('Order');
      if (o.expect && !o.expect(row)) {
        if (o.quiet) return undefined;
        throw new AppError('ILLEGAL_TRANSITION', 'This order has moved on; refresh it', { machine: 'Food order', from: row.status, event });
      }
      let to: string;
      try {
        to = foodOrderMachine.next(row.status as never, event) as string;
      } catch (err) {
        if (o.quiet) return undefined;
        throw err;
      }
      const now = this.now();
      const history = [...historyOf(row.history), { status: to, at: now.toISOString(), by: o.by, note: o.note ?? null }];
      return tx.updateOrder(id, { ...o.patch, status: to as OrderStatus, history: history as never, updated_at: now });
    };
    return o.tx ? run(o.tx) : this.repo.transaction(run);
  }

  /** The payment went through: the order is placed and the basket emptied (once, whoever sees it first) */
  protected async markPaid(orderId: string, intentId: string, methodLabel: string | null, by: By, claimKey?: string): Promise<OrderRow | undefined> {
    const after = await this.repo.transaction(async (tx) => {
      if (claimKey && !(await tx.claim(claimKey))) return undefined;
      const row = await tx.getOrder(orderId, { forUpdate: true });
      if (!row || row.status !== 'payment_pending' || (row.intent_id && row.intent_id !== intentId)) return undefined;
      const now = this.now();
      const moved = await this.move(orderId, 'pay', { by: null, tx, patch: { intent_id: intentId, placed_at: now, ...(methodLabel ? { method_label: methodLabel } : {}) } });
      // the basket is emptied when it still holds this restaurant's food
      const basket = await tx.basketOf(row.customer_id, { forUpdate: true });
      if (basket && basket.restaurant_id === row.restaurant_id) await tx.saveBasket({ ...basket, restaurant_id: null, lines: [] as never, updated_at: now });
      return moved;
    });
    if (after) this.publishStatus(after, null, by);
    return after;
  }

  /** The card was declined: the order waits for another try (the basket stays) */
  protected async markFailed(orderId: string, intentId: string, by: By, claimKey?: string): Promise<OrderRow | undefined> {
    const after = await this.repo.transaction(async (tx) => {
      if (claimKey && !(await tx.claim(claimKey))) return undefined;
      const row = await tx.getOrder(orderId, { forUpdate: true });
      if (!row || row.status !== 'payment_pending' || row.intent_id !== intentId) return undefined;
      return this.move(orderId, 'fail', { by: null, tx });
    });
    if (after) this.publishStatus(after, null, by);
    return after;
  }

  /** What an authorization answered, applied to the order */
  private async settle(orderId: string, result: payments.AuthorizeResult, by: By): Promise<void> {
    await this.repo.updateOrder(orderId, { intent_id: result.intentId, method_label: result.methodLabel || null, updated_at: this.now() });
    if (result.state === 'accepted') await this.markPaid(orderId, result.intentId, result.methodLabel, by);
    else if (result.state === 'failed') await this.markFailed(orderId, result.intentId, by);
    // requires_action and pending_check: the order waits in payment_pending (complete-action, refresh or the payments events finish it)
  }

  /** Payments' latest answer for a waiting order, applied */
  private async applyStatus(o: OrderRow, p: payments.PurchasePaymentStatus | null, by: By) {
    if (!p || o.status !== 'payment_pending' || o.intent_id !== p.intentId) return;
    if (p.state === 'accepted' || p.state === 'captured') await this.markPaid(o.id, p.intentId, p.methodLabel, by);
    else if (p.state === 'failed') await this.markFailed(o.id, p.intentId, by);
  }

  private async voidPayment(o: OrderRow, reason: string) {
    if (!o.intent_id) return;
    try {
      await this.payments.voidIntent(o.intent_id, reason);
    } catch (err) {
      // the authorization lapses on its own; staff see the payment state on the order
      this.ctx.log.warn({ err, orderId: o.id, intentId: o.intent_id }, 'food: could not void the payment');
    }
  }

  /* ---------------------------------------------------------------- customers: placing and paying */

  private async freshRef(): Promise<string> {
    for (let i = 0; i < 8; i++) {
      const ref = makeRef();
      if (!(await this.repo.refTaken(ref))) return ref;
    }
    throw new AppError('CONFLICT', 'Could not make an order reference; try again');
  }

  private closedError(r: RestaurantRow) {
    const state = this.openState(r);
    return this.ctx.error('RESTAURANT_CLOSED', `${r.name} is closed now${state.opensLabel ? ` · ${state.opensLabel}` : ''}.`, { opensLabel: state.opensLabel });
  }

  private async authorize(o: OrderRow, method: payments.MethodSelection, returnUrl: string, key: string): Promise<payments.AuthorizeResult> {
    return this.payments.authorizePurchase(
      { module: 'food', refId: o.id, ref: o.ref, customerId: o.customer_id, amount: money(o.total, o.currency), method, description: `${snapshotOf(o.restaurant).name} order`, returnUrl },
      `food:${o.id}:${o.attempts}:${key}`,
    );
  }

  async placeOrder(customerId: string, input: PlaceOrderInput, idempotencyKey: string, by: By): Promise<FoodOrder> {
    const key = `${customerId}:${idempotencyKey}`;
    let order = await this.repo.orderByKey(key);
    if (!order) order = await this.createOrder(customerId, input, key);
    if (order.status === 'payment_pending' && !order.intent_id) {
      let result: payments.AuthorizeResult;
      try {
        result = await this.authorize(order, input.method, input.returnUrl, idempotencyKey);
      } catch (err) {
        // nothing was authorized: the order goes away and the basket stays for another try
        const now = await this.repo.getOrder(order.id);
        if (now && !now.intent_id && now.status === 'payment_pending') await this.repo.deleteOrder(order.id);
        throw err;
      }
      await this.settle(order.id, result, by);
    }
    return this.getOrder(customerId, order.id, false);
  }

  private async createOrder(customerId: string, input: PlaceOrderInput, key: string): Promise<OrderRow> {
    const { basket, restaurant, lines } = await this.pricedBasket(customerId);
    if (!restaurant || !lines.length) throw this.ctx.error('BASKET_EMPTY', 'Your basket is empty.');
    if (restaurant.status !== 'published' || !this.openState(restaurant).open) throw this.closedError(restaurant);
    const unavailable = lines.filter((l) => !l.available);
    if (unavailable.length) throw this.ctx.error('ITEM_UNAVAILABLE', unavailable.length === 1 ? `${unavailable[0]!.name} is no longer available.` : 'Some items are no longer available.', { itemIds: unique(unavailable.map((l) => l.stored.itemId)) });
    if (basket.missingForMinimum) throw this.ctx.error('BELOW_MINIMUM', `Add ${moneyLabel(basket.missingForMinimum)} more to reach the minimum order.`, { missing: basket.missingForMinimum });
    if (input.expectedTotal.amount !== basket.total.amount || input.expectedTotal.currency !== basket.total.currency) throw this.ctx.error('PRICE_CHANGED', 'Prices changed; check the new total.', { total: basket.total });
    const courierNote = optionalText(input.courierNote, 'courierNote', LIMITS.courierNote);
    const contactPhone = optionalText(input.contactPhone, 'contactPhone', LIMITS.phone);
    const address = await this.customers.getAddressForOrder(customerId, input.addressId);
    const now = this.now();
    const snapshot: RestaurantSnapshot = { name: restaurant.name, slug: restaurant.slug, cuisine: restaurant.cuisine, city: restaurant.city, imageId: restaurant.image_id, logoId: restaurant.logo_id, timeZone: this.zoneOf(restaurant), deliveryMin: restaurant.delivery_min, deliveryMax: restaurant.delivery_max };
    const orderLines: StoredOrderLine[] = lines.map((l) => ({ itemId: l.stored.itemId, name: l.name, imageId: l.item ? (stringsOf(l.item.photo_ids)[0] ?? null) : null, optionsLabel: l.optionsLabel, note: l.stored.note, unitPrice: l.unitPrice, quantity: l.stored.quantity, total: l.unitPrice * l.stored.quantity }));
    return this.repo.insertOrder({
      id: newId(),
      ref: await this.freshRef(),
      customer_id: customerId,
      restaurant_id: restaurant.id,
      restaurant: snapshot as never,
      lines: orderLines as never,
      subtotal: basket.subtotal.amount,
      delivery_fee: basket.deliveryFee.amount,
      total: basket.total.amount,
      currency: basket.total.currency,
      address: address as never,
      courier_note: courierNote,
      contact_phone: contactPhone ?? address.phone ?? null,
      status: 'payment_pending',
      history: [{ status: 'payment_pending', at: now.toISOString(), by: null, note: null }] as never,
      restaurant_note: null,
      staff_note: null,
      intent_id: null,
      attempts: 1,
      method_label: null,
      eta_from: null,
      eta_to: null,
      placed_at: null,
      accepted_at: null,
      delivered_at: null,
      reviewed: false,
      idempotency_key: key,
      created_at: now,
      updated_at: now,
    });
  }

  async listMyOrders(customerId: string, q: { state?: 'open' | 'past' }, page: PageRequest): Promise<Page<FoodOrder>> {
    const statuses = q.state === 'open' ? OPEN_STATUSES : q.state === 'past' ? PAST_STATUSES : undefined;
    const res = await this.repo.pageCustomerOrders(customerId, statuses, page);
    return { ...res, items: await this.ordersOut(res.items) };
  }

  private async mine(customerId: string, id: string): Promise<OrderRow> {
    const o = await this.repo.getOrder(id);
    if (!o || o.customer_id !== customerId) throw notFound('Order');
    return o;
  }

  async getOrder(customerId: string, id: string, refresh = false, by?: By): Promise<FoodOrder> {
    let o = await this.mine(customerId, id);
    if (refresh && o.status === 'payment_pending' && o.intent_id) {
      const p = await this.soft('payments.getPurchaseStatus', () => this.payments.getPurchaseStatus(o.intent_id!, true), null);
      await this.applyStatus(o, p, by ?? { actor: { kind: 'customer', id: customerId } });
      o = (await this.repo.getOrder(id))!;
    }
    return (await this.ordersOut([o]))[0]!;
  }

  async completeOrderAction(customerId: string, id: string, resultToken: string, idempotencyKey: string, by: By): Promise<FoodOrder> {
    const o = await this.mine(customerId, id);
    if (o.status !== 'payment_pending' || !o.intent_id) throw new AppError('ILLEGAL_TRANSITION', 'This order has no payment waiting for your bank', { machine: 'Food order', from: o.status, event: 'complete_action' });
    const result = await this.payments.completeAction(o.intent_id, resultToken, `food:${o.id}:action:${idempotencyKey}`);
    await this.settle(o.id, result, by);
    return this.getOrder(customerId, id);
  }

  async retryOrderPayment(customerId: string, id: string, input: RetryPaymentInput, idempotencyKey: string, by: By): Promise<FoodOrder> {
    const o = await this.mine(customerId, id);
    foodOrderMachine.next(o.status as never, 'retry');
    const r = await this.repo.getRestaurant(o.restaurant_id);
    if (!r || r.status !== 'published' || !this.openState(r).open) {
      if (!r) throw this.ctx.error('RESTAURANT_CLOSED', 'This restaurant is closed now.', { opensLabel: null });
      throw this.closedError(r);
    }
    const moved = (await this.move(id, 'retry', { by: null, expect: (row) => row.status === 'payment_failed', patch: { attempts: o.attempts + 1, intent_id: null } }))!;
    let result: payments.AuthorizeResult;
    try {
      result = await this.authorize(moved, input.method, input.returnUrl, idempotencyKey);
    } catch (err) {
      // nothing was authorized: back to payment failed, as before the try
      await this.repo.updateOrder(id, { status: 'payment_failed', attempts: o.attempts, intent_id: o.intent_id, history: o.history, updated_at: this.now() });
      throw err;
    }
    await this.settle(id, result, by);
    return this.getOrder(customerId, id);
  }

  async cancelOrder(customerId: string, id: string, body: { reason?: string | null }, by: By): Promise<FoodOrder> {
    const o = await this.mine(customerId, id);
    if (o.status !== 'placed') throw new AppError('ILLEGAL_TRANSITION', 'The restaurant has your order now; it can no longer be cancelled in the app', { machine: 'Food order', from: o.status, event: 'cancel' });
    const reason = optionalText(body.reason, 'reason', 300);
    const after = (await this.move(id, 'cancel', { by: 'customer', note: reason, expect: (row) => row.status === 'placed' }))!;
    await this.voidPayment(after, 'Cancelled by the customer');
    this.publishStatus(after, reason, by);
    return this.getOrder(customerId, id);
  }

  /* ---------------------------------------------------------------- reviews */

  async reviewOrder(customerId: string, id: string, input: ReviewInput, _by: By): Promise<FoodOrder> {
    const o = await this.mine(customerId, id);
    if (o.status !== 'delivered') throw new AppError('ILLEGAL_TRANSITION', 'You can rate an order once it is delivered', { machine: 'Food order', from: o.status, event: 'review' });
    if (o.reviewed) throw this.ctx.error('ALREADY_REVIEWED', 'You already rated this order.');
    if (!Number.isInteger(input.stars) || input.stars < 1 || input.stars > 5) throw invalid('stars', 'Rate from 1 to 5 stars');
    const text = optionalText(input.text, 'text', LIMITS.reviewText);
    const c = await this.soft('customers.getCustomer', () => this.customers.getCustomer(customerId), null);
    const itemIds = unique(linesOf(o.lines).map((l) => l.itemId));
    await this.repo.transaction(async (tx) => {
      const fresh = await tx.getOrder(id, { forUpdate: true });
      if (!fresh || fresh.reviewed) throw this.ctx.error('ALREADY_REVIEWED', 'You already rated this order.');
      await tx.insertReview({ id: newId(), order_id: id, restaurant_id: o.restaurant_id, item_ids: itemIds as never, customer_id: customerId, name: shortName(c?.displayName), stars: input.stars, text, hidden: false, hidden_reason: null, created_at: this.now() });
      await tx.updateOrder(id, { reviewed: true, updated_at: this.now() });
      await this.addRating(tx, o.restaurant_id, itemIds, input.stars, 1);
    });
    return this.getOrder(customerId, id);
  }

  /** Keeps the rating totals of a restaurant and the order's items in step with their visible reviews */
  private async addRating(tx: FoodRepository, restaurantId: string, itemIds: string[], stars: number, delta: 1 | -1) {
    const r = await tx.getRestaurant(restaurantId, { forUpdate: true });
    if (r) await tx.updateRestaurant(restaurantId, { rating_sum: Math.max(0, r.rating_sum + delta * stars), rating_count: Math.max(0, r.rating_count + delta), rating_stars: withRating(r.rating_stars, stars, delta) as never });
    for (const id of itemIds) {
      const i = await tx.getItem(id, { forUpdate: true });
      if (i) await tx.updateItem(id, { rating_sum: Math.max(0, i.rating_sum + delta * stars), rating_count: Math.max(0, i.rating_count + delta), rating_stars: withRating(i.rating_stars, stars, delta) as never });
    }
  }

  private async reviewsAdmin(rows: ReviewRow[]): Promise<ReviewAdmin[]> {
    if (!rows.length) return [];
    const [orders, restaurants] = await Promise.all([this.repo.ordersByIds(unique(rows.map((r) => r.order_id))), this.repo.restaurantsByIds(unique(rows.map((r) => r.restaurant_id)))]);
    const refs = await this.restaurantRefs(restaurants);
    const oById = new Map(orders.map((o) => [o.id, o]));
    const rById = new Map(restaurants.map((r) => [r.id, r]));
    return rows.map((v) => {
      const o = oById.get(v.order_id);
      const restaurant = o ? this.orderRestaurant(o, rById.get(v.restaurant_id), refs) : this.restaurantCard(rById.get(v.restaurant_id)!, refs);
      return { id: v.id, orderRef: o?.ref ?? '', restaurant, name: v.name, customerId: v.customer_id, stars: v.stars, text: v.text, hidden: v.hidden, date: v.created_at.toISOString() };
    });
  }

  async listReviewsAdmin(q: { restaurantId?: string; hidden?: boolean; stars?: number }, page: PageRequest): Promise<Page<ReviewAdmin>> {
    const res = await this.repo.pageAdminReviews(q, page);
    return { ...res, items: await this.reviewsAdmin(res.items) };
  }

  async moderateReview(id: string, body: ReviewModeration, by: By): Promise<ReviewAdmin> {
    const reason = optionalText(body.reason, 'reason', 300);
    let changed = false;
    await this.repo.transaction(async (tx) => {
      const r = await tx.getReview(id, { forUpdate: true });
      if (!r) throw notFound('Review');
      changed = r.hidden !== body.hidden;
      await tx.updateReview(id, { hidden: body.hidden, hidden_reason: body.hidden ? reason : null });
      if (changed) await this.addRating(tx, r.restaurant_id, stringsOf(r.item_ids), r.stars, body.hidden ? -1 : 1);
    });
    const r = (await this.repo.getReview(id))!;
    if (changed) await this.audit({ action: 'food.review.moderate', actionLabel: body.hidden ? 'Hid a food review' : 'Showed a food review', category: 'content', target: { type: 'food_review', id, label: r.name }, after: { hidden: body.hidden }, reason }, by);
    return (await this.reviewsAdmin([r]))[0]!;
  }

  /* ---------------------------------------------------------------- staff */

  async listOrdersAdmin(q: { status?: string; state?: 'open' | 'past'; restaurantId?: string; q?: string }, page: PageRequest): Promise<Page<FoodOrderAdmin>> {
    let statuses: string[] | undefined = q.state === 'open' ? OPEN_STATUSES : q.state === 'past' ? PAST_STATUSES : undefined;
    if (q.status) statuses = statuses ? statuses.filter((s) => s === q.status) : [q.status];
    const text = q.q?.trim();
    let customerIds: string[] = [];
    if (text && !/^FD-/i.test(text)) {
      const found = await this.soft('customers.searchCustomers', () => this.customers.searchCustomers({ search: text }, { limit: 50 }), null);
      customerIds = found?.items.map((c) => c.id) ?? [];
    }
    const res = await this.repo.pageAdminOrders({ ...(statuses ? { statuses } : {}), ...(q.restaurantId ? { restaurantId: q.restaurantId } : {}), ...(text ? { q: text, customerIds } : {}) }, page);
    return { ...res, items: await this.ordersAdmin(res.items) };
  }

  async getOrderAdmin(id: string): Promise<FoodOrderAdmin> {
    const o = await this.repo.getOrder(id);
    if (!o) throw notFound('Order');
    return (await this.ordersAdmin([o]))[0]!;
  }

  async moveOrder(id: string, input: OrderAction, by: By): Promise<FoodOrderAdmin> {
    const o = await this.repo.getOrder(id);
    if (!o) throw notFound('Order');
    const action = input.action as AdminAction;
    if (!(ADMIN_ACTIONS as readonly string[]).includes(action)) throw invalid('action', 'Unknown action');
    foodOrderMachine.next(o.status as never, action);
    const note = optionalText(input.note, 'note', 300);
    const staffNote = optionalText(input.staffNote, 'staffNote', LIMITS.staffNote);
    const now = this.now();
    const patch: Partial<OrderRow> = {};
    if (staffNote) patch.staff_note = staffNote;
    if (action === 'accept') {
      const r = await this.repo.getRestaurant(o.restaurant_id);
      const s = snapshotOf(o.restaurant);
      const w = etaWindow(now, r?.delivery_min ?? s.deliveryMin, r?.delivery_max ?? s.deliveryMax);
      Object.assign(patch, { accepted_at: now, eta_from: w.from, eta_to: w.to });
    }
    if (action === 'decline' || action === 'cancel') patch.restaurant_note = note;
    if (action === 'deliver') {
      await this.capture(o);
      patch.delivered_at = now;
    }
    const after = (await this.move(id, action, { by: by.actor.name || 'Staff', note, patch, expect: (row) => row.status === o.status }))!;
    if (action === 'decline' || action === 'cancel') await this.voidPayment(after, action === 'decline' ? 'Declined by the restaurant' : 'Cancelled by Marketly staff');
    this.publishStatus(after, note, by);
    await this.audit({ action: `food.order.${action}`, actionLabel: `${ACTION_LABEL[action]} food order ${after.ref}`, category: 'orders', target: { type: 'food_order', id, ref: after.ref, label: after.ref }, before: { status: o.status }, after: { status: after.status }, reason: note }, by);
    return this.getOrderAdmin(id);
  }

  /** Charges the authorized card on delivery; PAYMENT_CAPTURE_FAILED leaves the order on the way */
  private async capture(o: OrderRow) {
    if (!o.intent_id) throw this.ctx.error('PAYMENT_CAPTURE_FAILED', 'This order has no card payment to charge.');
    try {
      await this.payments.capturePurchase(o.intent_id);
    } catch (err) {
      // a capture that went through before (a retried delivery) is fine
      const p = await this.soft('payments.getPurchaseStatus', () => this.payments.getPurchaseStatus(o.intent_id!, false), null);
      if (p?.state === 'captured') return;
      this.ctx.log.warn({ err, orderId: o.id, intentId: o.intent_id }, 'food: capture failed');
      throw this.ctx.error('PAYMENT_CAPTURE_FAILED', "The card couldn't be charged; the order stays on the way. Try again or cancel it.", isAppError(err) ? { reason: err.message } : undefined);
    }
  }

  /* ---------------------------------------------------------------- events, jobs, export */

  async onPurchaseAuthorizedFromPayments(e: EventPayload<'payments.purchase.authorized'>, eventId?: string): Promise<void> {
    if (e.module !== 'food') return;
    const o = await this.repo.getOrder(e.refId);
    if (!o) {
      this.ctx.log.warn({ intentId: e.intentId, refId: e.refId }, 'food: authorized payment for an unknown order');
      return;
    }
    await this.markPaid(o.id, e.intentId, e.methodLabel, { actor: { kind: 'system' } }, `purchase-authorized:${eventId ?? e.intentId}`);
  }

  async onPurchaseFailedFromPayments(e: EventPayload<'payments.purchase.failed'>, eventId?: string): Promise<void> {
    if (e.module !== 'food') return;
    const o = await this.repo.getOrder(e.refId);
    if (!o) {
      this.ctx.log.warn({ intentId: e.intentId, refId: e.refId }, 'food: failed payment for an unknown order');
      return;
    }
    await this.markFailed(o.id, e.intentId, { actor: { kind: 'system' } }, `purchase-failed:${eventId ?? e.intentId}`);
  }

  private async acceptMinutes(): Promise<number> {
    const v = Number(await this.ctx.settings.get('acceptMinutes'));
    return Number.isFinite(v) && v > 0 ? v : 15;
  }

  /** Declines placed orders the restaurant didn't accept in time, and drops orders left in a bank challenge */
  async expireUnaccepted(): Promise<void> {
    const by: By = { actor: { kind: 'system' } };
    const now = this.now();
    const acceptBy = new Date(now.getTime() - (await this.acceptMinutes()) * 60_000);
    let cursor: { at: Date; id: string } | null = null;
    for (;;) {
      const batch: OrderRow[] = await this.repo.staleOrders('placed', 'placed_at', acceptBy, cursor, JOB_BATCH);
      for (const o of batch) {
        const note = "The restaurant didn't accept the order in time";
        const after = await this.move(o.id, 'decline', { by: SYSTEM, note, quiet: true, expect: (row) => row.status === 'placed', patch: { restaurant_note: note } });
        if (!after) continue;
        await this.voidPayment(after, 'Not accepted in time');
        this.publishStatus(after, note, by);
      }
      if (batch.length < JOB_BATCH) break;
      const last: OrderRow = batch[batch.length - 1]!;
      cursor = { at: last.placed_at!, id: last.id };
    }
    const challengeBy = new Date(now.getTime() - CHALLENGE_MINUTES * 60_000);
    cursor = null;
    for (;;) {
      const batch: OrderRow[] = await this.repo.staleOrders('payment_pending', 'updated_at', challengeBy, cursor, JOB_BATCH);
      for (const o of batch) {
        const p = o.intent_id ? await this.soft('payments.getPurchaseStatus', () => this.payments.getPurchaseStatus(o.intent_id!, false), null) : null;
        if (p && p.state !== 'requires_action') {
          // a missed answer from payments: apply it; a pending check stays with payments
          await this.applyStatus(o, p, by);
          continue;
        }
        if (o.intent_id && !p) continue;
        const note = "The payment wasn't confirmed in time";
        const after = await this.move(o.id, 'abandon', { by: SYSTEM, note, quiet: true, expect: (row) => row.status === 'payment_pending' && row.intent_id === o.intent_id });
        if (!after) continue;
        await this.voidPayment(after, 'Bank challenge not finished');
        this.publishStatus(after, note, by);
      }
      if (batch.length < JOB_BATCH) break;
      const last: OrderRow = batch[batch.length - 1]!;
      cursor = { at: last.updated_at, id: last.id };
    }
  }

  async exportCustomerData(input: { customerId: string; accountId: string }): Promise<common.CustomerDataSection[]> {
    const ids = unique([input.customerId, input.accountId].filter(present));
    const orders = (await Promise.all(ids.map((id) => this.repo.customerOrders(id)))).flat();
    const reviews = (await Promise.all(ids.map((id) => this.repo.customerReviews(id)))).flat();
    const refById = new Map(orders.map((o) => [o.id, o.ref]));
    const out: common.CustomerDataSection[] = [];
    if (orders.length)
      out.push({
        key: 'food_orders',
        title: 'Food orders',
        module: 'food',
        records: orders.map((o) => ({
          reference: o.ref,
          restaurant: snapshotOf(o.restaurant).name,
          items: linesOf(o.lines).map((l) => ({ name: l.name, options: l.optionsLabel, note: l.note, quantity: l.quantity, unitPrice: money(l.unitPrice, o.currency), total: money(l.total, o.currency) })),
          subtotal: money(o.subtotal, o.currency),
          deliveryFee: money(o.delivery_fee, o.currency),
          total: money(o.total, o.currency),
          address: o.address,
          courierNote: o.courier_note,
          contactPhone: o.contact_phone,
          status: o.status,
          payment: o.method_label,
          placedAt: o.placed_at?.toISOString() ?? null,
          deliveredAt: o.delivered_at?.toISOString() ?? null,
          createdAt: o.created_at.toISOString(),
        })),
      });
    if (reviews.length) out.push({ key: 'food_reviews', title: 'Food reviews', module: 'food', records: reviews.map((r) => ({ order: refById.get(r.order_id) ?? null, stars: r.stars, text: r.text, shownAs: r.name, hidden: r.hidden, date: r.created_at.toISOString() })) });
    const saved = (await Promise.all(ids.map((id) => this.repo.savedOf(id)))).flat();
    if (saved.length) {
      const names = new Map((await this.repo.restaurantsByIds(unique(saved.map((s) => s.restaurant_id)))).map((r) => [r.id, r.name]));
      out.push({ key: 'food_saved_restaurants', title: 'Saved restaurants', module: 'food', records: saved.map((s) => ({ restaurant: names.get(s.restaurant_id) ?? null, savedAt: s.created_at.toISOString() })) });
    }
    return out;
  }
}
