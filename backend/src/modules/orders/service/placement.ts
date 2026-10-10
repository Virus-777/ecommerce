/**
 * Placing and accepting orders: createOrder (idempotent per checkout session, one transaction, frozen snapshots),
 * acceptOrder and cancelForDeclinedPayment, and the payment events that drive them.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import type * as offers from '../../../spec/offers.js';
import type { AcceptedItem, OrderCreateInput, OrderDetail, PlacedGroup, SellerLabel } from '../../../spec/orders.js';
import { orderItemMachine, orderLifecycleMachine } from '../domain/state-machines.js';
import { CONDITION_LABEL, discountSum, plural } from '../domain/rules.js';
import type { GroupRec, ItemRec, OrderRec, StoredProduct } from '../ports.js';
import { Batch, invalid, notFound, SYSTEM, type Agg, type By, type Core } from './core.js';
import type { Views } from './views.js';

export class Placement {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
  ) {}

  placedGroups(agg: Agg): PlacedGroup[] {
    return agg.groups.map((g) => ({
      groupId: g.id,
      ownerType: g.owner_type as 'official' | 'seller',
      sellerId: g.seller_id,
      fulfilledBy: g.fulfilled_by as PlacedGroup['fulfilledBy'],
      dispatchBy: g.dispatch_by.toISOString(),
      itemIds: agg.items.filter((i) => i.group_id === g.id).map((i) => i.id),
      total: this.views.m(g.total, agg),
    }));
  }

  /** Every item line with its stock item: inventory allocates the reservation from these (orders.order.accepted) */
  acceptedItems(agg: Agg): AcceptedItem[] {
    return agg.items.map((i) => ({ orderItemId: i.id, offerId: i.offer_id, stockItemId: i.stock_item_id, quantity: i.quantity }));
  }

  async detailOf(orderId: string): Promise<OrderDetail> {
    const agg = await this.core.load(orderId);
    if (!agg) throw notFound();
    const cfg = await this.core.cfg();
    return this.views.detail(agg, await this.core.timelineOf(orderId, ['customer']), 'internal', cfg);
  }

  validate(input: OrderCreateInput) {
    const issues: { path: string; message: string }[] = [];
    if (!input.groups?.length) issues.push({ path: 'groups', message: 'An order needs at least one package' });
    if (input.contact?.kind === 'customer' && !input.contact.customerId) issues.push({ path: 'contact.customerId', message: 'A customer order needs the customer id' });
    input.groups?.forEach((g, gi) => {
      if (!g.items?.length) issues.push({ path: `groups[${gi}].items`, message: 'A package needs at least one item' });
      if (g.ownerType === 'seller' && !g.sellerId) issues.push({ path: `groups[${gi}].sellerId`, message: 'A seller package needs the seller id' });
      if (g.ownerType === 'official' && g.sellerId) issues.push({ path: `groups[${gi}].sellerId`, message: 'Official Store packages have no seller id' });
      g.items?.forEach((i, ii) => {
        if (!(Number.isInteger(i.quantity) && i.quantity > 0)) issues.push({ path: `groups[${gi}].items[${ii}].quantity`, message: 'Quantity must be at least 1' });
        for (const [k, m] of [['unitPrice', i.unitPrice], ['shippingShare', i.shippingShare], ['taxShare', i.taxShare]] as const) {
          if (m.currency !== input.currency) issues.push({ path: `groups[${gi}].items[${ii}].${k}`, message: `Expected ${input.currency}` });
          if (m.amount < 0) issues.push({ path: `groups[${gi}].items[${ii}].${k}`, message: 'Amounts cannot be negative' });
        }
      });
    });
    if (issues.length) throw invalid(issues, 'The order is incomplete');
  }

  /** Create the order from an authorized or pending payment (idempotent per checkoutSessionId and attemptNo) */
  async createOrder(input: OrderCreateInput): Promise<OrderDetail> {
    const attemptNo = input.attemptNo ?? 1;
    if (!(Number.isInteger(attemptNo) && attemptNo >= 1)) throw invalid([{ path: 'attemptNo', message: 'Attempt numbers start at 1' }]);
    const existing = (await this.core.repo.find('orders', { checkout_session_id: input.checkoutSessionId, attempt_no: attemptNo }))[0];
    if (existing) return this.detailOf(existing.id);
    this.validate(input);
    const ctx = this.core.ctx;
    const accepted = input.paymentState === 'accepted';

    // frozen purchase snapshots, read before the transaction
    const lines = input.groups.flatMap((g) => g.items);
    const offerSnaps = new Map<string, offers.OfferSnapshot>();
    for (const offerId of new Set(lines.map((l) => l.offerId))) offerSnaps.set(offerId, await ctx.use('offers').snapshotForOrder(offerId));
    const productSnaps = new Map<string, StoredProduct>();
    for (const variantId of new Set(lines.map((l) => l.variantId))) productSnaps.set(variantId, await ctx.use('catalog').snapshotForOrder(variantId));
    // the category at purchase comes with the snapshot; older catalog snapshots without it fall back to the product
    for (const p of productSnaps.values()) {
      if (p.categoryId) continue;
      const product = await ctx
        .use('catalog')
        .getProduct(p.productId)
        .catch(() => null);
      p.categoryId = product?.categoryId ?? null;
    }
    const skus = await this.core.soft('inventory', 'seller SKUs', (inv) => inv.getStockForOffers([...offerSnaps.keys()], {}));
    const sellerIds = [...new Set(input.groups.map((g) => g.sellerId).filter((x): x is string => Boolean(x)))];
    const sellers = new Map((await this.core.soft('sellers', 'seller labels', (s) => s.getSellers(sellerIds)))?.map((s) => [s.id, s]) ?? []);

    const issues: { path: string; message: string }[] = [];
    input.groups.forEach((g, gi) =>
      g.items.forEach((i, ii) => {
        const o = offerSnaps.get(i.offerId)!;
        if (o.ownerType !== g.ownerType || (g.ownerType === 'seller' && o.sellerId !== g.sellerId)) issues.push({ path: `groups[${gi}].items[${ii}].offerId`, message: 'The offer belongs to another seller' });
      }),
    );
    if (issues.length) throw invalid(issues, 'The order does not match its offers');

    const cfg = await this.core.cfg();
    const ref = await ctx.refs.next(cfg.orderRefPrefix);
    const now = this.core.now();
    const orderId = newId();
    const itemState = accepted ? orderItemMachine.next('pending_payment', 'accept_payment') : 'pending_payment';
    const lifecycle = accepted ? orderLifecycleMachine.next('payment_pending', 'accept_payment') : 'payment_pending';

    const groups: GroupRec[] = [];
    const items: ItemRec[] = [];
    input.groups.forEach((g, gi) => {
      const groupId = newId();
      const first = offerSnaps.get(g.items[0]!.offerId)!;
      const s = g.sellerId ? sellers.get(g.sellerId) : undefined;
      const label: SellerLabel =
        g.ownerType === 'official'
          ? { ownerType: 'official', id: null, name: first.sellerName || OFFICIAL_STORE_NAME, slug: 'official-store', verified: true, logo: null }
          : { ownerType: 'seller', id: g.sellerId, name: s?.storeName ?? first.sellerName, slug: s?.slug ?? '', verified: s?.verified ?? false, logo: null };
      groups.push({
        id: groupId,
        order_id: orderId,
        position: gi + 1,
        owner_type: g.ownerType,
        seller_id: g.sellerId ?? null,
        seller_name: label.name,
        ships_from: g.shipsFrom,
        fulfilled_by: g.fulfilledBy,
        delivery: { ...g.delivery, seller: label },
        dispatch_by: new Date(g.delivery.dispatchBy),
        dispatch_by_history: [],
        status: 'new',
        return_terms_summary: g.returnTermsSummary,
        items_total: g.totals.items.amount,
        discount_total: g.totals.discounts.amount,
        shipping_total: g.totals.shipping.amount,
        tax_total: g.totals.tax.amount,
        total: g.totals.total.amount,
        shipped_at: null,
        delivered_at: null,
      });
      for (const i of g.items) {
        const o = offerSnaps.get(i.offerId)!;
        const p = productSnaps.get(i.variantId)!;
        const line = { quantity: i.quantity, unit_price: i.unitPrice.amount, discounts: i.discounts ?? [], shipping_share: i.shippingShare.amount, tax_share: i.taxShare.amount };
        items.push({
          id: newId(),
          order_id: orderId,
          group_id: groupId,
          offer_id: i.offerId,
          product_id: p.productId,
          variant_id: i.variantId,
          stock_item_id: i.stockItemId,
          category_id: p.categoryId ?? null,
          product_snapshot: p,
          offer_snapshot: { ...o, conditionLabel: CONDITION_LABEL[o.condition] ?? o.condition, sellerSku: o.sellerSku || skus?.[i.offerId]?.sku || null },
          return_terms: i.returnTerms,
          ...line,
          paid_amount: line.quantity * line.unit_price - discountSum(line.discounts) + line.shipping_share + line.tax_share,
          refunded_amount: 0,
          refund_status: 'none',
          state: itemState,
          state_before_request: null,
          shipment_id: null,
          return_id: null,
          return_ref: null,
          delivered_at: null,
          return_window_ends_at: null,
          split_from_item_id: null,
          replacement_of_item_id: null,
          checkout_line_id: i.checkoutLineId,
        });
      }
    });

    const order: OrderRec = {
      id: orderId,
      ref,
      checkout_session_id: input.checkoutSessionId,
      attempt_no: attemptNo,
      reservation_id: input.reservationId ?? null,
      delivery_address_id: input.deliveryAddressId ?? null,
      customer_id:input.contact.kind === 'customer' ? (input.contact.customerId ?? null) : null,
      contact_email: input.contact.email,
      contact_phone: input.contact.phone ?? null,
      contact_name: input.contact.name,
      channel: input.channel,
      lifecycle,
      display_status: accepted ? 'confirmed' : 'payment_pending',
      flags: { kinds: accepted ? [] : ['payment_checking'] },
      currency: input.currency,
      items_total: input.totals.items.amount,
      discount_total: input.totals.discounts.amount,
      shipping_total: input.totals.shipping.amount,
      tax_total: input.totals.tax.amount,
      total: input.totals.total.amount,
      delivery_address: input.deliveryAddress,
      gift_note: input.giftNote ?? null,
      hide_prices: input.hidePricesOnSlip,
      policy_versions: input.policyVersions ?? [],
      coupon_codes: input.couponCodes ?? [],
      payment_intent_id: input.paymentIntentId,
      payment_state: input.paymentState,
      payment_method_label: input.paymentMethodLabel,
      captured_total: 0,
      refunded_total: 0,
      placed_at: now,
      accepted_at: accepted ? now : null,
      completed_at: null,
    };

    const actor = input.contact.kind === 'customer' ? { kind: 'customer' as const, id: input.contact.customerId ?? null, name: input.contact.name } : { kind: 'visitor' as const, id: null, name: input.contact.name };
    const batch = new Batch({ actor });
    const created = await this.core.repo.transaction(async (tx) => {
      const row = await tx.insertOrderIfNew(order);
      if (!row) return false; // a concurrent call for the same checkout won
      await tx.insertMany('seller_groups', groups);
      await tx.insertMany('order_items', items);
      if (accepted) {
        await tx.insertMany(
          'item_state_log',
          items.map((i) => ({ id: newId(), item_id: i.id, from_state: 'pending_payment', to_state: itemState, event: 'accept_payment', reason: null, actor_kind: 'system', actor_id: null, at: now })),
        );
      }
      await tx.insertMany('documents', [
        { id: newId(), order_id: orderId, group_id: null, kind: 'receipt', number: `${ref}-R`, issued_at: now },
        ...groups.map((g) => ({ id: newId(), order_id: orderId, group_id: g.id, kind: 'invoice', number: `${ref}-I${g.position}`, issued_at: now })),
      ]);
      const units = items.reduce((s, i) => s + i.quantity, 0);
      await this.core.timeline(tx, orderId, [
        { visibility: 'customer', label: 'Order placed', detail: `${plural(units, 'item')} from ${plural(groups.length, 'seller')}`, actor },
        accepted
          ? { visibility: 'customer', label: 'Payment accepted', detail: `${input.paymentMethodLabel}. Your order is confirmed.` }
          : { visibility: 'customer', label: 'Payment being checked', detail: "Your bank is confirming the payment. You won't be charged twice." },
        ...groups.map((g) => ({ group_id: g.id, visibility: 'seller' as const, label: accepted ? 'New order' : 'New order, payment being checked', detail: `Dispatch by ${g.dispatch_by.toISOString()}` })),
      ]);
      return true;
    });
    if (!created) {
      const winner = (await this.core.repo.find('orders', { checkout_session_id: input.checkoutSessionId, attempt_no: attemptNo }))[0];
      if (!winner) throw new AppError('CONFLICT', 'The order could not be placed; try again');
      return this.detailOf(winner.id);
    }

    const agg = (await this.core.load(orderId))!;
    const placed = this.placedGroups(agg);
    batch.push('orders.order.placed', {
      orderId,
      ref,
      checkoutSessionId: input.checkoutSessionId,
      customerId: order.customer_id,
      guestEmail: order.customer_id ? null : order.contact_email,
      paymentIntentId: input.paymentIntentId,
      paymentState: input.paymentState,
      total: this.views.m(order.total, agg),
      couponCodes: order.coupon_codes,
      groups: placed,
      placedAt: now.toISOString(),
      attemptNo,
      deliveryAddressId: order.delivery_address_id,
      contactName: order.contact_name,
      visitorId: input.visitorId ?? null,
    });
    if (accepted) {
      for (const i of items) batch.push('orders.item.state_changed', { orderId, groupId: i.group_id, itemId: i.id, from: 'pending_payment', to: itemState, actor: SYSTEM, at: now.toISOString() });
      batch.push('orders.order.accepted', { orderId, ref, customerId: order.customer_id, contactEmail: order.contact_email, total: this.views.m(order.total, agg), groups: placed, items: this.acceptedItems(agg), reservationId: order.reservation_id, acceptedAt: now.toISOString() });
    }
    this.core.flush(batch);
    await this.attachSnapshotImages(orderId, ref, items);
    return this.views.detail(agg, await this.core.timelineOf(orderId, ['customer']), 'internal', cfg);
  }

  /**
   * Keeps each item's snapshot image alive for the order (media usage kind order_evidence, ref the order id), so the
   * picture on the order outlives catalog changes. Best effort: media off or an asset gone never fails the order.
   */
  private async attachSnapshotImages(orderId: string, ref: string, items: ItemRec[]) {
    const media = this.core.ctx.tryUse('media');
    if (!media) return;
    const assetIds = new Set<string>();
    for (const i of items) {
      const id = i.product_snapshot.imageId ?? i.product_snapshot.image?.id ?? null;
      if (id) assetIds.add(id);
    }
    for (const assetId of assetIds) {
      try {
        await media.attach(assetId, { module: 'orders', kind: 'order_evidence', refId: orderId, refLabel: ref }, { kind: 'platform', id: null, label: 'Orders' });
      } catch (err) {
        this.core.ctx.log.warn({ err, orderId, assetId }, 'orders: could not keep the snapshot image');
      }
    }
  }

  /** payment_pending → open when the payment result arrives. Idempotent. */
  async acceptOrder(orderId: string, paymentIntentId: string, methodLabel?: string): Promise<OrderDetail> {
    const agg0 = await this.core.load(orderId);
    if (!agg0) throw notFound();
    if (agg0.order.lifecycle === 'open' || agg0.order.lifecycle === 'completed') return this.detailOf(orderId);
    const by: By = { actor: SYSTEM };
    await this.core.write(orderId, by, async (tx, agg, batch) => {
      if (agg.order.lifecycle !== 'payment_pending') {
        if (agg.order.lifecycle === 'cancelled') orderLifecycleMachine.next('cancelled', 'accept_payment'); // ILLEGAL_TRANSITION
        return;
      }
      const now = this.core.now();
      const lifecycle = orderLifecycleMachine.next('payment_pending', 'accept_payment');
      for (const i of agg.items.filter((x) => x.state === 'pending_payment')) await this.core.move(tx, batch, i, 'accept_payment');
      await tx.update('orders', orderId, {
        lifecycle,
        payment_state: 'accepted',
        payment_intent_id: paymentIntentId,
        accepted_at: now,
        ...(methodLabel ? { payment_method_label: methodLabel } : {}),
      });
      await this.core.timeline(tx, orderId, [
        { visibility: 'customer', label: 'Payment accepted', detail: 'Your order is confirmed.' },
        ...agg.groups.map((g) => ({ group_id: g.id, visibility: 'seller' as const, label: 'Payment accepted', detail: 'You can prepare and ship this order.' })),
      ]);
      const fresh = (await this.core.load(orderId, tx))!;
      batch.push('orders.order.accepted', {
        orderId,
        ref: fresh.order.ref,
        customerId: fresh.order.customer_id,
        contactEmail: fresh.order.contact_email,
        total: this.views.m(fresh.order.total, fresh),
        groups: this.placedGroups(fresh),
        items: this.acceptedItems(fresh),
        reservationId: fresh.order.reservation_id,
        acceptedAt: now.toISOString(),
      });
    });
    return this.detailOf(orderId);
  }

  /** payment_pending → cancelled when a pending payment is finally declined (no refund needed) */
  async cancelForDeclinedPayment(orderId: string): Promise<void> {
    const agg0 = await this.core.load(orderId);
    if (!agg0) throw notFound();
    if (agg0.order.lifecycle === 'cancelled') return;
    await this.core.write(orderId, { actor: SYSTEM }, async (tx, agg, batch) => {
      if (agg.order.lifecycle === 'cancelled') return;
      const lifecycle = orderLifecycleMachine.next(agg.order.lifecycle as 'payment_pending', 'payment_declined');
      for (const i of agg.items.filter((x) => x.state === 'pending_payment')) await this.core.move(tx, batch, i, 'payment_declined', { reason: 'Payment declined' });
      await tx.update('orders', orderId, { lifecycle, payment_state: 'failed' });
      await this.core.timeline(tx, orderId, [{ visibility: 'customer', label: 'Payment declined', detail: 'Your bank declined the payment. Nothing was charged and the order was cancelled.' }]);
      batch.push('orders.order.cancelled', { orderId, ref: agg.order.ref, reason: 'payment_declined', checkoutSessionId: agg.order.checkout_session_id });
    });
  }

  private async orderForPayment(orderId: string | null | undefined, checkoutSessionId: string) {
    if (orderId) {
      const o = await this.core.repo.get('orders', orderId);
      if (o) return o;
    }
    // the latest attempt of the checkout (earlier ones were cancelled for a declined payment)
    return (await this.core.repo.find('orders', { checkout_session_id: checkoutSessionId }, { orderBy: [['attempt_no', 'desc']], limit: 1 }))[0];
  }

  async onPaymentAuthorized(e: EventPayload<'payments.payment.authorized'>) {
    const o = await this.orderForPayment(e.orderId, e.checkoutSessionId);
    if (!o) return this.core.ctx.log.info({ intentId: e.intentId }, 'orders: authorized payment has no order yet');
    if (o.lifecycle !== 'payment_pending') return;
    await this.acceptOrder(o.id, e.intentId, e.methodLabel);
  }

  async onPaymentFailed(e: EventPayload<'payments.payment.failed'>) {
    const o = await this.orderForPayment(e.orderId, e.checkoutSessionId);
    if (!o || o.lifecycle !== 'payment_pending') return;
    try {
      await this.cancelForDeclinedPayment(o.id);
    } catch (err) {
      if (!isAppError(err)) throw err;
      this.core.ctx.log.warn({ err, orderId: o.id }, 'orders: could not cancel for a declined payment');
    }
  }

  async onPaymentCaptured(e: EventPayload<'payments.payment.captured'>) {
    const o = await this.core.repo.get('orders', e.orderId);
    if (!o) return;
    if ((o.flags?.captures ?? []).some((c) => c.captureId === e.captureId)) return;
    await this.core.write(o.id, { actor: SYSTEM }, async (tx, agg) => {
      if ((agg.order.flags?.captures ?? []).some((c) => c.captureId === e.captureId)) return;
      const fresh = await this.core.setFlags(tx, agg.order, (f) => ({ ...f, captures: [...(f.captures ?? []), { captureId: e.captureId, amount: e.amount.amount, at: e.capturedAt }] }));
      await tx.update('orders', o.id, { captured_total: fresh.captured_total + e.amount.amount });
    });
  }
}
