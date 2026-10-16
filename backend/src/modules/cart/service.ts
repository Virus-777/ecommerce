import type { Principal } from '../../kernel/auth/index.js';
import type { Scope } from '../../kernel/auth/scope.js';
import { AppError, isAppError, isNotImplemented } from '../../kernel/errors/index.js';
import type { EventPayload, PublishMeta } from '../../kernel/events/index.js';
import { isUuid, newId } from '../../kernel/lib/ids.js';
import { money } from '../../kernel/lib/money.js';
import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type {
  AddItemInput,
  AddItemResult,
  CartAdminSummary,
  CartBadge,
  CartItem,
  CartDestination,
  CartLineInput,
  CartOwner,
  CartPublicApi,
  CartView,
  CheckoutCartLine,
  CheckoutCartSnapshot,
  CouponPreview,
  MergeLine,
  MergeReport,
  MergeResult,
  SavedItem,
} from '../../spec/cart.js';
import type * as common from '../../spec/common.js';
import type * as offers from '../../spec/offers.js';
import { CartChecker, type CheckResult } from './checker.js';
import { addBlock, currentPrice, evaluateLine, sellerLabelOf } from './domain/check.js';
import {
  addDays,
  conditionGroupOf,
  lineMaximum,
  minLimit,
  normalizeCode,
  plural,
  shippingOf,
  storedCoupons,
  unavailableMessage,
  validPostalCode,
  type LimitKind,
} from './domain/rules.js';
import { cartLifecycleMachine, cartLineAvailabilityMachine } from './domain/state-machines.js';
import type { AdminCartFilter, CartAggregate, CartRow, ItemRow, OwnerKey } from './ports.js';
import type { CartRepository } from './repository.js';

export interface CartServiceDeps {
  repo: CartRepository;
  ctx: ModuleContext<'cart'>;
}

/** Who acts: for events */
export interface By {
  actor: common.Actor;
  requestId?: string;
}

/** The owner of a shopper request: the customer (customers' id) or the visitor (guest) session */
export interface Shopper {
  owner: OwnerKey;
  kind: 'customer' | 'guest';
  customerId: string | null;
  guestSessionId: string | null;
  /** identity account of a customer (carts are keyed by it while customers has no record yet) */
  accountId: string | null;
}

const SYSTEM: By = { actor: { kind: 'system', id: 'cart', name: 'Cart' } };
const EVENT_BATCH = 500;
const JOB_BATCH = 200;
const iso = (d: Date) => d.toISOString();

const notFound = (what = 'Cart item') => new AppError('NOT_FOUND', `${what} not found`);
const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });

/**
 * Cart use cases. Depends only on its repository, the event bus, the clock and other modules' public APIs.
 * Each method maps to an endpoint, a publicApi function, a consumed event or a job in docs/api/spec/modules/cart.json.
 */
export class CartService implements CartPublicApi {
  readonly checker: CartChecker;

  constructor(protected readonly deps: CartServiceDeps) {
    this.checker = new CartChecker(deps.ctx, deps.repo);
  }

  private get ctx() {
    return this.deps.ctx;
  }
  private get repo() {
    return this.deps.repo;
  }
  private now() {
    return this.ctx.clock.now();
  }
  private meta(by: By): PublishMeta {
    return { actor: by.actor, requestId: by.requestId };
  }

  /* ================================================================ owners */

  /** customers' id for an identity account; the account id itself while customers has none (or is off) */
  async customerKey(accountId: string): Promise<string> {
    const c = await this.checker.optional('customers.getCustomerByUserId', () => this.ctx.tryUse('customers')?.getCustomerByUserId(accountId) ?? Promise.resolve(null));
    return c?.id ?? accountId;
  }

  async shopperOf(scope: Scope): Promise<Shopper> {
    if (scope.kind === 'visitor') return { owner: { kind: 'guest', guestSessionId: scope.visitorSessionId }, kind: 'guest', customerId: null, guestSessionId: scope.visitorSessionId, accountId: null };
    if (scope.kind === 'customer') {
      const customerId = scope.customerId ?? (await this.customerKey(scope.accountId));
      return { owner: { kind: 'customer', customerId }, kind: 'customer', customerId, guestSessionId: null, accountId: scope.accountId };
    }
    throw new AppError('UNAUTHORIZED', 'Sign in or continue as a guest to use the cart');
  }

  /** GraphQL: the shopper of the request's principal */
  async shopperOfPrincipal(p: Principal | null): Promise<Shopper | null> {
    if (p?.kind === 'visitor') return this.shopperOf({ kind: 'visitor', visitorSessionId: p.guestSessionId ?? p.sessionId });
    if (p?.kind === 'customer' && p.accountId) return this.shopperOf({ kind: 'customer', accountId: p.accountId, customerId: null });
    return null;
  }

  private shopperOfOwner(owner: CartOwner): Shopper {
    if (owner.kind === 'customer' && owner.customerId) return { owner: { kind: 'customer', customerId: owner.customerId }, kind: 'customer', customerId: owner.customerId, guestSessionId: null, accountId: null };
    if (owner.kind === 'guest' && owner.guestSessionId) return { owner: { kind: 'guest', guestSessionId: owner.guestSessionId }, kind: 'guest', customerId: null, guestSessionId: owner.guestSessionId, accountId: null };
    throw invalid('owner', 'A customer id or guest session id is required');
  }

  private ownerOf(cart: CartRow): Shopper {
    return cart.owner_kind === 'customer'
      ? { owner: { kind: 'customer', customerId: cart.customer_id! }, kind: 'customer', customerId: cart.customer_id, guestSessionId: null, accountId: null }
      : { owner: { kind: 'guest', guestSessionId: cart.guest_session_id! }, kind: 'guest', customerId: null, guestSessionId: cart.guest_session_id, accountId: null };
  }

  /** The owner's active cart. A customer cart created before customers knew the account is adopted. */
  async activeCart(s: Shopper): Promise<CartRow | undefined> {
    const cart = await this.repo.getActiveCart(s.owner);
    if (cart || s.kind !== 'customer' || !s.accountId || s.accountId === s.customerId) return cart;
    const early = await this.repo.getActiveCart({ kind: 'customer', customerId: s.accountId });
    if (!early) return undefined;
    try {
      return await this.repo.updateCart(early.id, { customer_id: s.customerId });
    } catch {
      return this.repo.getActiveCart(s.owner);
    }
  }

  private async retention(kind: 'customer' | 'guest') {
    return this.checker.retentionDays(kind);
  }

  /** The owner's active cart, created when missing */
  async ensureCart(s: Shopper): Promise<CartRow> {
    const existing = await this.activeCart(s);
    if (existing) return existing;
    const now = this.now();
    const days = await this.retention(s.kind);
    const created = await this.repo.insertCart({
      id: newId(),
      owner_kind: s.kind,
      customer_id: s.customerId,
      guest_session_id: s.guestSessionId,
      status: 'active',
      currency: this.ctx.config.market.currency,
      destination: null,
      coupon_codes: [],
      merged_into_id: null,
      checked_at: null,
      created_at: now,
      updated_at: now,
      expires_at: addDays(now, days),
    });
    return created ?? (await this.repo.getActiveCart(s.owner))!;
  }

  private async touch(cartId: string, days: number, tx: CartRepository = this.repo, extra: Partial<CartRow> = {}) {
    const now = this.now();
    return tx.updateCart(cartId, { updated_at: now, expires_at: addDays(now, days), ...extra });
  }

  private async checkFor(cart: CartRow, s: Shopper, shopperRead: boolean, postalCode?: string): Promise<CheckResult> {
    return this.checker.run(cart, { shopperRead, postalCode, customerId: s.customerId, guestSessionId: s.guestSessionId });
  }

  /** The shopper's cart after a fresh check; an empty view when there is no cart */
  async viewFor(s: Shopper, postalCode?: string): Promise<CartView> {
    const cart = await this.activeCart(s);
    if (!cart) return this.checker.emptyView(s.kind, await this.repo.countSaved(s.owner), this.checker.destinationOf(null, postalCode));
    return (await this.checkFor(cart, s, true, postalCode)).view;
  }

  private async lineOf(s: Shopper, itemId: string): Promise<{ cart: CartRow; item: ItemRow }> {
    const cart = isUuid(itemId) ? await this.activeCart(s) : undefined;
    const item = cart ? await this.repo.getItem(cart.id, itemId) : undefined;
    if (!cart || !item) throw notFound();
    return { cart, item };
  }

  /* ================================================================ offer facts for writes */

  private async offerForWrite(offerId: string, customerId: string | null) {
    const offer = await this.ctx.use('offers').getOffer(offerId);
    if (!offer) throw notFound('Offer');
    const catalogApi = this.ctx.tryUse('catalog');
    const promoApi = this.ctx.tryUse('promotions');
    const [availability, purchasable, promos] = await Promise.all([
      this.ctx.use('inventory').getAvailability([offer.stockItemId]),
      this.checker.optional('catalog.isPurchasable', catalogApi && (() => catalogApi.isPurchasable(offer.productId))),
      this.checker.optional('promotions.priceOffers', promoApi && (() => promoApi.priceOffers([offer.id], { customerId: customerId ?? undefined, at: iso(this.now()) }))),
    ]);
    const a = availability[offer.stockItemId];
    const promo = promos?.find((p) => p.offerId === offer.id) ?? null;
    const available = a ? a.available : offer.status === 'out_of_stock' ? 0 : null;
    const maxPerLine = await this.ctx.settings.get('maxQuantityPerLine');
    const purchaseLimit = minLimit(offer.purchaseLimit, promo?.purchaseLimit);
    const { max, limitKind } = lineMaximum(purchaseLimit, available, maxPerLine);
    return { offer, available, purchasable: purchasable ?? null, promo, unitPrice: currentPrice(offer, promo), max, limitKind };
  }

  /** OFFER_UNAVAILABLE with the reason and a hint of other offers (never applied) */
  private async unavailable(offer: offers.Offer, reason: string) {
    const group = offer.condition === 'new' ? 'new' : offer.condition === 'refurbished' ? 'refurbished' : 'used';
    let alternatives: { count: number; lowestPrice: common.Money | null } | null = null;
    try {
      const cmp = await this.ctx.use('offers').compareOffers(offer.productId, { variantId: offer.variantId, condition: group, sort: 'total_cost' });
      const others = cmp.offers.filter((o) => o.offerId !== offer.id && o.status === 'active');
      if (others.length) alternatives = { count: others.length, lowestPrice: others.reduce((m, o) => (o.price.amount < m.amount ? o.price : m), others[0]!.price) };
    } catch {
      /* a hint only */
    }
    return this.ctx.error('OFFER_UNAVAILABLE', unavailableMessage[reason] ?? 'This offer is not available right now.', { reason, alternatives });
  }

  private limitError(max: number, limitKind: LimitKind) {
    const why = limitKind === 'purchase_limit' ? `Limit ${max} per customer.` : limitKind === 'stock' ? `Only ${max} available.` : `You can buy up to ${max} of this item at a time.`;
    return this.ctx.error('QUANTITY_LIMIT_EXCEEDED', why, { max, limitKind });
  }

  /* ================================================================ store: cart */

  async getCart(scope: Scope, postalCode?: string): Promise<CartView> {
    return this.viewFor(await this.shopperOf(scope), postalCode);
  }

  async getBadge(scope: Scope): Promise<CartBadge> {
    const cart = await this.activeCart(await this.shopperOf(scope));
    return cart ? this.repo.badgeCounts(cart.id) : { itemCount: 0, attentionCount: 0 };
  }

  async addItem(scope: Scope, input: AddItemInput, by: By): Promise<AddItemResult> {
    return this.add(await this.shopperOf(scope), input, by);
  }

  private async add(s: Shopper, input: AddItemInput, by: By): Promise<AddItemResult> {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) throw invalid('quantity', 'Quantity must be at least 1');
    const f = await this.offerForWrite(input.offerId, s.customerId);
    const block = addBlock(f.offer, f.available, f.purchasable);
    if (block) throw await this.unavailable(f.offer, block);
    const maxLines = await this.ctx.settings.get('maxLines');
    const days = await this.retention(s.kind);
    const cart = await this.ensureCart(s);
    const now = this.now();
    const r = await this.repo.transaction(async (tx) => {
      await tx.getCart(cart.id, { forUpdate: true });
      const existing = await tx.getItemByOffer(cart.id, f.offer.id);
      const current = existing?.quantity ?? 0;
      if (current >= f.max) throw this.limitError(f.max, f.limitKind);
      if (!existing && (await tx.countItems(cart.id)) >= maxLines) throw this.ctx.error('CART_FULL', `Your cart can hold ${maxLines} different items. Remove something to add this one.`, { max: maxLines });
      const target = Math.min(current + input.quantity, f.max);
      const capped = current + input.quantity > f.max;
      const base = { accepted_price: f.unitPrice.amount, accepted_terms_version: f.offer.termsVersion, updated_at: now };
      const item = existing
        ? await tx.updateItem(existing.id, { ...base, quantity: target })
        : await tx.insertItem({
            id: newId(),
            cart_id: cart.id,
            offer_id: f.offer.id,
            owner_type: f.offer.ownerType,
            seller_id: f.offer.sellerId ?? null,
            product_id: f.offer.productId,
            variant_id: f.offer.variantId,
            stock_item_id: f.offer.stockItemId,
            ships_from: shippingOf(f.offer).dispatch.shipsFrom,
            fulfilled_by: shippingOf(f.offer).fulfilledBy,
            condition: f.offer.condition,
            quantity: target,
            price_at_add: f.unitPrice.amount,
            currency: f.unitPrice.currency,
            source: input.source ?? null,
            added_at: now,
            last_checked_at: null,
            ...base,
          });
      await this.touch(cart.id, days, tx);
      return { item, added: target - current, capped, existed: !!existing, target };
    });
    this.ctx.events.publish(
      'cart.item.added',
      { cartId: cart.id, itemId: r.item.id, offerId: f.offer.id, productId: f.offer.productId, sellerId: f.offer.sellerId ?? null, quantity: r.added, unitPrice: f.unitPrice, ownerKind: s.kind, source: input.source ?? null },
      this.meta(by),
    );
    const outcome = r.capped ? 'capped_at_limit' : r.existed ? 'quantity_increased' : 'added';
    const why = f.limitKind === 'purchase_limit' ? ` (limit ${f.max} per customer)` : f.limitKind === 'stock' ? ` (only ${f.max} available)` : '';
    const message =
      outcome === 'capped_at_limit'
        ? `You can buy up to ${f.max} of this item${why}. Your cart now has ${r.target}.`
        : outcome === 'quantity_increased'
          ? `You now have ${r.target} of this item in your cart.`
          : 'Added to your cart.';
    return { cart: await this.viewFor(s), itemId: r.item.id, outcome, message };
  }

  async updateItemQuantity(scope: Scope, itemId: string, quantity: number, _by: By): Promise<CartView> {
    const s = await this.shopperOf(scope);
    const { cart, item } = await this.lineOf(s, itemId);
    if (!Number.isInteger(quantity) || quantity < 1) throw invalid('quantity', 'Quantity must be at least 1. Remove the item instead.');
    if (quantity > item.quantity) {
      const f = await this.offerForWrite(item.offer_id, s.customerId);
      const block = addBlock(f.offer, f.available, f.purchasable);
      if (block) throw await this.unavailable(f.offer, block);
      if (quantity > f.max) throw this.limitError(f.max, f.limitKind);
    }
    const days = await this.retention(s.kind);
    await this.repo.transaction(async (tx) => {
      const locked = await tx.getItem(cart.id, item.id, { forUpdate: true });
      if (!locked) throw notFound();
      // reducing to a lower purchase limit accepts the offer edit that lowered it (its terms version)
      const version = limitTermsVersion((await tx.listNotices([item.id])).filter((n) => !n.resolved_at), quantity);
      await tx.updateItem(item.id, { quantity, ...(version > locked.accepted_terms_version ? { accepted_terms_version: version } : {}), updated_at: this.now() });
      await this.touch(cart.id, days, tx);
    });
    return this.viewFor(s);
  }

  async removeItem(scope: Scope, itemId: string, by: By): Promise<CartView> {
    const s = await this.shopperOf(scope);
    const { cart, item } = await this.lineOf(s, itemId);
    const days = await this.retention(s.kind);
    await this.repo.transaction(async (tx) => {
      await tx.deleteItems([item.id]);
      await this.touch(cart.id, days, tx);
    });
    this.ctx.events.publish('cart.item.removed', { cartId: cart.id, itemId: item.id, offerId: item.offer_id, reason: 'customer' }, this.meta(by));
    return this.viewFor(s);
  }

  async acceptItemChanges(scope: Scope, itemId: string, noticeIds: string[], _by: By): Promise<CartView> {
    const s = await this.shopperOf(scope);
    const { cart } = await this.lineOf(s, itemId);
    if (!noticeIds.length) throw invalid('noticeIds', 'Choose at least one change to accept');
    // a fresh check first: a notice whose change moved on again is no longer open
    const checked = await this.checkFor(cart, s, false);
    const line = checked.lines.find((l) => l.item.id === itemId);
    if (!line) throw notFound();
    const all = await this.repo.listNotices([itemId]);
    const patch: Partial<ItemRow> = {};
    let quantity = line.eval.item.quantity;
    for (const id of new Set(noticeIds)) {
      const n = line.open.find((o) => o.id === id);
      if (!n) {
        if (all.some((o) => o.id === id)) throw new AppError('CONFLICT', 'This change was already handled or the item changed again. Review the item again.', { noticeId: id });
        throw notFound('Notice');
      }
      if (n.severity === 'blocking') cartLineAvailabilityMachine.next('unavailable', 'accept');
      const cur = (n.current ?? {}) as Record<string, unknown>;
      if (n.kind === 'price_increased' && typeof cur.price === 'number') {
        patch.accepted_price = cur.price;
        if (line.eval.offer) patch.accepted_terms_version = line.eval.offer.termsVersion;
      }
      if (n.kind === 'terms_changed') {
        const version = Math.max(typeof cur.termsVersion === 'number' ? cur.termsVersion : 0, line.eval.offer?.termsVersion ?? 0);
        if (version) patch.accepted_terms_version = version;
      }
      if (n.kind === 'quantity_reduced' && typeof cur.available === 'number') quantity = Math.min(quantity, Math.max(cur.available, 1));
      if (n.kind === 'purchase_limit_reduced' && typeof cur.limit === 'number') {
        quantity = Math.min(quantity, Math.max(cur.limit, 1));
        if (typeof cur.termsVersion === 'number' && cur.termsVersion > (patch.accepted_terms_version ?? line.eval.item.accepted_terms_version)) patch.accepted_terms_version = cur.termsVersion;
      }
    }
    if (quantity !== line.eval.item.quantity) patch.quantity = quantity;
    const days = await this.retention(s.kind);
    await this.repo.transaction(async (tx) => {
      const locked = await tx.getItem(cart.id, itemId, { forUpdate: true });
      if (!locked) throw notFound();
      await tx.acceptNotices([...new Set(noticeIds)], this.now());
      await tx.updateItem(itemId, { ...patch, updated_at: this.now() });
      await this.touch(cart.id, days, tx);
    });
    return this.viewFor(s);
  }

  async switchItemOffer(scope: Scope, itemId: string, body: { offerId: string; quantity?: number | null }, by: By): Promise<CartView> {
    const s = await this.shopperOf(scope);
    const { cart, item } = await this.lineOf(s, itemId);
    if (body.quantity != null && (!Number.isInteger(body.quantity) || body.quantity < 1)) throw invalid('quantity', 'Quantity must be at least 1');
    const f = await this.offerForWrite(body.offerId, s.customerId);
    if (f.offer.variantId !== item.variant_id) throw this.ctx.error('OFFER_MISMATCH', 'Choose an offer for the same item and options.', { variantId: item.variant_id });
    const block = addBlock(f.offer, f.available, f.purchasable);
    if (block) throw await this.unavailable(f.offer, block);
    const days = await this.retention(s.kind);
    const now = this.now();
    if (f.offer.id === item.offer_id) {
      const quantity = body.quantity ?? item.quantity;
      if (quantity > f.max) throw this.limitError(f.max, f.limitKind);
      await this.repo.transaction(async (tx) => {
        await tx.updateItem(item.id, { quantity, updated_at: now });
        await this.touch(cart.id, days, tx);
      });
      return this.viewFor(s);
    }
    const requested = body.quantity ?? Math.min(item.quantity, Math.max(f.max, 1));
    await this.repo.transaction(async (tx) => {
      const locked = await tx.getItem(cart.id, item.id, { forUpdate: true });
      if (!locked) throw notFound();
      const other = await tx.getItemByOffer(cart.id, f.offer.id);
      const quantity = requested + (other?.quantity ?? 0);
      if (quantity > f.max) throw this.limitError(f.max, f.limitKind);
      const notices = (await tx.listNotices([item.id])).filter((n) => !n.resolved_at).map((n) => n.id);
      await tx.resolveNotices(notices, now);
      if (other) {
        // the chosen offer is already a line: the switched line joins it
        await tx.updateItem(other.id, { quantity, accepted_price: f.unitPrice.amount, accepted_terms_version: f.offer.termsVersion, updated_at: now });
        await tx.deleteItems([item.id]);
      } else {
        await tx.updateItem(item.id, {
          offer_id: f.offer.id,
          owner_type: f.offer.ownerType,
          seller_id: f.offer.sellerId ?? null,
          product_id: f.offer.productId,
          variant_id: f.offer.variantId,
          stock_item_id: f.offer.stockItemId,
          ships_from: shippingOf(f.offer).dispatch.shipsFrom,
          fulfilled_by: shippingOf(f.offer).fulfilledBy,
          condition: f.offer.condition,
          quantity,
          price_at_add: f.unitPrice.amount,
          accepted_price: f.unitPrice.amount,
          accepted_terms_version: f.offer.termsVersion,
          currency: f.unitPrice.currency,
          updated_at: now,
        });
      }
      await this.touch(cart.id, days, tx);
    });
    this.ctx.events.publish('cart.item.offer_switched', { cartId: cart.id, itemId: item.id, fromOfferId: item.offer_id, toOfferId: f.offer.id }, this.meta(by));
    return this.viewFor(s);
  }

  async removeUnavailableItems(scope: Scope, by: By): Promise<CartView> {
    const s = await this.shopperOf(scope);
    const cart = await this.activeCart(s);
    if (!cart) return this.viewFor(s);
    const checked = await this.checkFor(cart, s, false);
    const gone = checked.lines.filter((l) => l.state === 'unavailable').map((l) => l.eval.item);
    if (gone.length) {
      const days = await this.retention(s.kind);
      await this.repo.transaction(async (tx) => {
        await tx.deleteItems(gone.map((i) => i.id));
        await this.touch(cart.id, days, tx);
      });
      for (const i of gone) this.ctx.events.publish('cart.item.removed', { cartId: cart.id, itemId: i.id, offerId: i.offer_id, reason: 'unavailable' }, this.meta(by));
    }
    return this.viewFor(s);
  }

  async setDestination(scope: Scope, body: { addressId?: string | null; postalCode?: string | null; country?: string | null }): Promise<CartView> {
    const s = await this.shopperOf(scope);
    const postal = body.postalCode?.trim() || null;
    if (body.addressId && postal) throw invalid('postalCode', 'Send a saved address or a postal code, not both');
    let dest: CartDestination;
    if (body.addressId) {
      const customers = this.ctx.tryUse('customers');
      if (s.kind !== 'customer' || !s.customerId) throw invalid('addressId', 'Sign in to use a saved address');
      if (!customers) throw invalid('addressId', 'Saved addresses are not available right now');
      let a: common.Address;
      try {
        a = await customers.getAddressForOrder(s.customerId, body.addressId);
      } catch (err) {
        if (isAppError(err) && err.code === 'NOT_FOUND') throw invalid('addressId', 'Address not found');
        throw err;
      }
      dest = { postalCode: a.postalCode, country: a.country, region: a.region, city: a.city, addressId: body.addressId, source: 'address' };
    } else if (postal) {
      const country = (body.country?.trim() || 'US').toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) throw invalid('country', 'Use a two-letter country code, e.g. US');
      if (!validPostalCode(country, postal)) throw invalid('postalCode', country === 'US' ? 'Enter a 5-digit ZIP code' : 'Enter a valid postal code');
      dest = { postalCode: postal, country, region: null, city: null, addressId: null, source: 'postal_code' };
    } else {
      throw invalid('postalCode', 'Enter a ZIP code or choose a saved address');
    }
    const cart = await this.ensureCart(s);
    const days = await this.retention(s.kind);
    await this.touch(cart.id, days, this.repo, { destination: { ...dest } as never });
    return this.viewFor(s);
  }

  /* ================================================================ coupons */

  /** Coupon attempts per owner per hour (couponPreviewRateLimitPerHour), counted across server instances */
  private async rateLimitCoupons(s: Shopper, limit: number) {
    const owner = s.owner.kind === 'customer' ? `c:${s.owner.customerId}` : `g:${s.owner.guestSessionId}`;
    const r = await this.ctx.rateLimit(`coupon:${owner}`, { limit, windowMs: 3_600_000 });
    if (!r.allowed) throw new AppError('RATE_LIMITED', 'Too many coupon attempts. Try again later.', { retryAfterSeconds: Math.max(1, Math.ceil(r.retryAfterMs / 1000)) });
  }

  async previewCoupon(scope: Scope, rawCode: string): Promise<{ cart: CartView; result: CouponPreview }> {
    const s = await this.shopperOf(scope);
    const code = normalizeCode(rawCode ?? '');
    if (!code || code.length > 40) throw invalid('code', 'Enter a coupon code');
    await this.rateLimitCoupons(s, await this.ctx.settings.get('couponPreviewRateLimitPerHour'));
    const cart = await this.activeCart(s);
    if (!cart || !(await this.repo.countItems(cart.id))) {
      const view = await this.viewFor(s);
      return { cart: view, result: { code, status: 'rejected', amount: null, label: code, fundedBy: null, reason: 'Add items to your cart to use this code.', coverage: [], notCovered: [] } };
    }
    const codes = storedCoupons(cart.coupon_codes);
    const known = codes.some((c) => c.code === code);
    const fresh = known ? cart : await this.repo.updateCart(cart.id, { coupon_codes: [...codes, { code, covered: [] }] as never });
    const checked = await this.checkFor(fresh, s, true);
    const result = checked.view.coupons.find((c) => c.code === code) ?? { code, status: 'rejected' as const, amount: null, label: code, fundedBy: null, reason: "This code can't be used on your cart.", coverage: [], notCovered: [] };
    if (result.status === 'rejected' && !known) {
      // a rejected code is explained, not kept
      const after = storedCoupons(checked.cart.coupon_codes).filter((c) => c.code !== code);
      await this.repo.updateCart(cart.id, { coupon_codes: after as never });
      return { cart: { ...checked.view, coupons: checked.view.coupons.filter((c) => c.code !== code) }, result };
    }
    return { cart: checked.view, result };
  }

  async removeCoupon(scope: Scope, rawCode: string): Promise<CartView> {
    const s = await this.shopperOf(scope);
    const code = normalizeCode(decodeURIComponent(rawCode ?? ''));
    const cart = await this.activeCart(s);
    if (cart) {
      const codes = storedCoupons(cart.coupon_codes);
      if (codes.some((c) => c.code === code)) await this.repo.updateCart(cart.id, { coupon_codes: codes.filter((c) => c.code !== code) as never, updated_at: this.now() });
    }
    return this.viewFor(s);
  }

  /* ================================================================ merge */

  /** Inbox key recording that an account claimed a visitor session (identity.guest_session.claimed) */
  private claimKey(guestSessionId: string, accountId: string) {
    return `guest-session-claimed:${guestSessionId}:${accountId}`;
  }

  async mergeGuestCart(scope: Scope, guestSessionId: string, by: By): Promise<MergeResult> {
    const s = await this.shopperOf(scope);
    if (s.kind !== 'customer' || !s.accountId) throw new AppError('UNAUTHORIZED', 'Sign in to merge your cart');
    // ownership proof: only a visitor session this account claimed at sign-in or registration; knowing its id is not enough
    if (!isUuid(guestSessionId) || !(await this.ctx.mongo.seen(this.claimKey(guestSessionId, s.accountId)))) throw notFound('Guest cart');
    const report = await this.merge(s, guestSessionId, by);
    if (!report) throw notFound('Guest cart');
    return { cart: await this.viewFor(s), report };
  }

  /**
   * Folds a guest cart into the customer's cart: same offer combines up to the limit, another offer for
   * the same variant is kept as its own line, unavailable lines are dropped and listed. Idempotent by
   * guest cart: a merged cart answers its stored report. null = nothing to merge for this customer.
   * Callers must have proved that the customer claimed the guest session (identity.guest_session.claimed).
   */
  async merge(s: Shopper, guestSessionId: string, by: By): Promise<MergeReport | null> {
    if (!isUuid(guestSessionId) || s.kind !== 'customer' || !s.customerId) return null;
    const customerId = s.customerId;
    const guest = await this.repo.getGuestCart(guestSessionId);
    if (guest?.status === 'merged') {
      const stored = await this.storedReport(guest, s);
      // items saved by the guest after the cart was merged (normally none) still move
      if (stored) await this.repo.transaction((tx) => tx.moveGuestSaved(guestSessionId, customerId));
      return stored;
    }
    if (!guest || guest.status !== 'active') {
      // no cart to fold in: the guest's saved-for-later items still move to the customer
      const moved = await this.repo.transaction((tx) => tx.moveGuestSaved(guestSessionId, customerId));
      return moved ? { mergedFromCartId: null, lines: [], savedItemsMoved: moved, message: `We moved ${plural(moved, 'saved item')} from before you signed in.` } : null;
    }

    const guestItems = await this.repo.listItems(guest.id);
    const target = await this.ensureCart(s);
    const facts = await this.checker.gather(guestItems, this.checker.destinationOf(target)?.postalCode ?? this.checker.destinationOf(guest)?.postalCode, s.customerId);
    const settings = { maxQuantityPerLine: await this.ctx.settings.get('maxQuantityPerLine'), showPriceDecreaseNotices: false };
    const maxLines = await this.ctx.settings.get('maxLines');
    const days = await this.retention('customer');
    const titles = new Map<string, string>();
    for (const [pid, p] of facts.products) titles.set(pid, p.product?.title ?? 'Item');
    const evals = guestItems.map((i) => evaluateLine(i, facts.offers.get(i.offer_id)!, facts.products.get(i.product_id) ?? { product: null, purchasable: null }, settings));
    const now = this.now();

    const result = await this.repo.transaction(async (tx) => {
      const lockedGuest = await tx.getCart(guest.id, { forUpdate: true });
      if (!lockedGuest || lockedGuest.status !== 'active') return { done: false as const };
      const into = (await tx.getCart(target.id, { forUpdate: true }))!;
      // the customer's lines, read once: guest lines have distinct offers, so each customer line is matched at most once
      const intoLines = await tx.listItems(into.id);
      const intoByOffer = new Map(intoLines.map((x) => [x.offer_id, x]));
      const intoVariants = new Set(intoLines.map((x) => x.variant_id));
      let lineCount = intoLines.length;
      const lines: MergeLine[] = [];
      for (const e of evals) {
        const i = e.item;
        const title = titles.get(i.product_id) ?? 'Item';
        const blocking = e.notices.find((n) => ['offer_ended', 'seller_unavailable', 'product_unavailable', 'out_of_stock'].includes(n.kind));
        if (blocking || e.maxQuantity < 1) {
          lines.push({ itemId: null, offerId: i.offer_id, title, outcome: 'dropped_unavailable', note: unavailableMessage[blocking?.kind ?? 'out_of_stock'] ?? 'No longer available.' });
          continue;
        }
        const same = intoByOffer.get(i.offer_id);
        if (same) {
          const sum = same.quantity + i.quantity;
          const qty = Math.min(sum, Math.max(e.maxQuantity, same.quantity));
          if (qty !== same.quantity) await tx.updateItem(same.id, { quantity: qty, updated_at: now });
          await tx.deleteItems([i.id]);
          lines.push(
            sum > qty
              ? { itemId: same.id, offerId: i.offer_id, title, outcome: 'capped_at_limit', note: `You now have ${qty}, the most you can buy of this item.` }
              : { itemId: same.id, offerId: i.offer_id, title, outcome: 'quantity_combined', note: `Quantities combined: you now have ${qty}.` },
          );
          continue;
        }
        if (lineCount >= maxLines) {
          lines.push({ itemId: null, offerId: i.offer_id, title, outcome: 'dropped_unavailable', note: `Your cart is full (${maxLines} items).` });
          continue;
        }
        const otherOffer = intoVariants.has(i.variant_id);
        const qty = Math.min(i.quantity, e.maxQuantity);
        await tx.moveItems([i.id], into.id, now);
        if (qty !== i.quantity) await tx.updateItem(i.id, { quantity: qty });
        intoVariants.add(i.variant_id);
        lineCount++;
        lines.push(
          qty < i.quantity
            ? { itemId: i.id, offerId: i.offer_id, title, outcome: 'capped_at_limit', note: `Reduced to ${qty}, the most you can buy of this item.` }
            : otherOffer
              ? { itemId: i.id, offerId: i.offer_id, title, outcome: 'kept_separate_offer', note: 'You already had this item from another seller. Both are kept; nothing was switched.' }
              : { itemId: i.id, offerId: i.offer_id, title, outcome: 'added', note: 'Added from before you signed in.' },
        );
      }
      // saved-for-later items move with the cart, in the same transaction
      const savedItemsMoved = await tx.moveGuestSaved(guestSessionId, customerId);
      const merged = lines.filter((l) => l.outcome !== 'dropped_unavailable').length;
      const dropped = lines.length - merged;
      const message =
        !lines.length && !savedItemsMoved
          ? null
          : [
              merged ? `We added ${plural(merged, 'item')} from before you signed in.` : null,
              dropped ? `${plural(dropped, 'item')} ${merged ? '' : 'from before you signed in '}${dropped === 1 ? 'is' : 'are'} no longer available.` : null,
              savedItemsMoved ? `We moved ${plural(savedItemsMoved, 'saved item')} to your Saved for later.` : null,
            ]
              .filter(Boolean)
              .join(' ');
      const report: MergeReport = { mergedFromCartId: guest.id, lines, savedItemsMoved, message };
      // coupons are carried over and checked again on the customer's next view; the deliver-to location when the customer has none
      const intoCodes = storedCoupons(into.coupon_codes);
      const carried = storedCoupons(lockedGuest.coupon_codes).filter((c) => !intoCodes.some((x) => x.code === c.code));
      await tx.updateCart(into.id, {
        updated_at: now,
        expires_at: addDays(now, days),
        coupon_codes: [...intoCodes, ...carried.map((c) => ({ code: c.code, covered: [] }))] as never,
        ...(into.destination || !lockedGuest.destination ? {} : { destination: lockedGuest.destination }),
      });
      await tx.updateCart(guest.id, { status: cartLifecycleMachine.next('active', 'merge'), merged_into_id: into.id, updated_at: now });
      await tx.insertMerge({ id: newId(), from_cart_id: guest.id, into_cart_id: into.id, report: report as never, at: now });
      return { done: true as const, report, merged, carried: carried.map((c) => c.code), intoId: into.id };
    });
    if (!result.done) return this.storedReport((await this.repo.getCart(guest.id))!, s);
    this.ctx.events.publish('cart.cart.merged', { fromCartId: guest.id, intoCartId: result.intoId, customerId: s.customerId, lines: result.merged }, this.meta(by));
    if (result.carried.length) await this.dropInvalidCarriedCodes(result.intoId, s, result.carried);
    return result.report;
  }

  /** Guest codes are carried over only while they are still valid for the customer */
  private async dropInvalidCarriedCodes(cartId: string, s: Shopper, carried: string[]) {
    const cart = await this.repo.getCart(cartId);
    if (!cart) return;
    const checked = await this.checkFor(cart, s, false);
    const invalidCodes = checked.view.coupons.filter((c) => carried.includes(c.code) && c.status !== 'applied').map((c) => c.code);
    if (!invalidCodes.length) return;
    await this.repo.updateCart(cartId, { coupon_codes: storedCoupons(checked.cart.coupon_codes).filter((c) => !invalidCodes.includes(c.code)) as never });
  }

  private async storedReport(guest: CartRow, s: Shopper): Promise<MergeReport | null> {
    const m = await this.repo.getMergeFrom(guest.id);
    if (!m) return null;
    const into = await this.repo.getCart(m.into_cart_id);
    if (!into || into.owner_kind !== 'customer' || (into.customer_id !== s.customerId && into.customer_id !== s.accountId)) return null;
    return withSavedCount(m.report);
  }

  /* ================================================================ save for later (phase 3) */

  async saveForLater(scope: Scope, itemId: string, by: By): Promise<CartView> {
    const s = await this.shopperOf(scope);
    const { cart, item } = await this.lineOf(s, itemId);
    const now = this.now();
    const days = await this.retention(s.kind);
    await this.repo.transaction(async (tx) => {
      const existing = await tx.findSavedByOffer(s.owner, item.offer_id);
      if (existing) await tx.updateSaved(existing.id, { saved_at: now });
      else
        await tx.insertSaved({
          id: newId(),
          owner_kind: s.kind,
          customer_id: s.customerId,
          guest_session_id: s.guestSessionId,
          offer_id: item.offer_id,
          product_id: item.product_id,
          variant_id: item.variant_id,
          saved_at: now,
        });
      await tx.deleteItems([item.id]);
      await this.touch(cart.id, days, tx);
    });
    this.ctx.events.publish('cart.item.removed', { cartId: cart.id, itemId: item.id, offerId: item.offer_id, reason: 'saved_for_later' }, this.meta(by));
    return this.viewFor(s);
  }

  async listSavedItems(scope: Scope, page: PageRequest): Promise<Page<SavedItem>> {
    const s = await this.shopperOf(scope);
    const res = await this.repo.listSaved(s.owner, page);
    return { ...res, items: await this.savedItems(res.items, s) };
  }

  /** Saved items with their current seller, price and availability */
  async savedItems(rows: { id: string; offer_id: string; product_id: string; variant_id: string; saved_at: Date }[], s: Shopper): Promise<SavedItem[]> {
    if (!rows.length) return [];
    const facts = await this.checker.gather(
      rows.map((r) => ({ offer_id: r.offer_id, product_id: r.product_id, stock_item_id: r.offer_id, quantity: 1, accepted_terms_version: 0, accepted_price: 0, currency: this.ctx.config.market.currency })),
      undefined,
      s.customerId,
    );
    return rows.map((r) => {
      const f = facts.offers.get(r.offer_id);
      const offer = f?.offer ?? null;
      const product = facts.products.get(r.product_id)?.product ?? null;
      const variant = product?.variants.find((v) => v.id === r.variant_id) ?? null;
      const reason = !offer
        ? 'offer_ended'
        : addBlock(offer, f!.available, facts.products.get(r.product_id)?.purchasable ?? null);
      return {
        id: r.id,
        offerId: r.offer_id,
        productId: r.product_id,
        productSlug: product?.slug ?? null,
        variantId: r.variant_id,
        seller: sellerLabelOf({ owner_type: offer?.ownerType ?? 'seller', seller_id: offer?.sellerId ?? null }, offer, f?.quote ?? null),
        title: product?.title ?? 'Item',
        variantLabel: Object.values(variant?.options ?? {}).join(' · '),
        image: variant?.images[0] ?? product?.images[0] ?? null,
        currentPrice: offer ? currentPrice(offer, f!.promo) : null,
        available: !reason,
        unavailableReason: reason ? (unavailableMessage[reason] ?? 'Not available right now.') : null,
        savedAt: iso(r.saved_at),
      };
    });
  }

  async moveSavedToCart(scope: Scope, savedId: string, quantity: number | null | undefined, by: By): Promise<AddItemResult> {
    const s = await this.shopperOf(scope);
    const saved = isUuid(savedId) ? await this.repo.getSaved(s.owner, savedId) : undefined;
    if (!saved) throw notFound('Saved item');
    const result = await this.add(s, { offerId: saved.offer_id, quantity: quantity ?? 1, source: 'saved_for_later' }, by);
    await this.repo.deleteSaved(saved.id);
    return { ...result, cart: { ...result.cart, savedForLaterCount: await this.repo.countSaved(s.owner) } };
  }

  async deleteSavedItem(scope: Scope, savedId: string): Promise<void> {
    const s = await this.shopperOf(scope);
    const saved = isUuid(savedId) ? await this.repo.getSaved(s.owner, savedId) : undefined;
    if (!saved) throw notFound('Saved item');
    await this.repo.deleteSaved(saved.id);
  }

  /* ================================================================ admin */

  private summary(a: CartAggregate): CartAdminSummary {
    const c = a.cart;
    return {
      id: c.id,
      owner: { kind: c.owner_kind, customerId: c.customer_id, guestSessionId: c.guest_session_id },
      status: c.status,
      itemCount: a.itemCount,
      itemsSubtotal: money(a.itemsSubtotal, c.currency),
      openNotices: a.openNotices,
      updatedAt: iso(c.updated_at),
      expiresAt: iso(c.expires_at),
    };
  }

  async listCartsAdmin(filter: AdminCartFilter, page: PageRequest): Promise<Page<CartAdminSummary>> {
    const res = await this.repo.listCartsAdmin(filter, page);
    return { ...res, items: res.items.map((a) => this.summary(a)) };
  }

  async getCartAdmin(cartId: string): Promise<{ summary: CartAdminSummary; cart: CartView; merges: MergeReport[] }> {
    const cart = isUuid(cartId) ? await this.repo.getCart(cartId) : undefined;
    if (!cart) throw notFound('Cart');
    const checked = await this.checkFor(cart, this.ownerOf(cart), false);
    const [agg, merges] = await Promise.all([this.repo.aggregateCart(cart.id), this.repo.listMerges(cart.id)]);
    return { summary: this.summary(agg!), cart: checked.view, merges: merges.map((m) => withSavedCount(m.report)) };
  }

  /* ================================================================ public API (in-process) */

  /** Eligible lines (offer, seller, variant, quantity, accepted unit price, package key) and coupon codes, after a fresh change check. Unavailable lines are returned separately so checkout can explain them. */
  async getCartForCheckout(owner: CartOwner, itemIds?: string[]): Promise<CheckoutCartSnapshot> {
    const s = this.shopperOfOwner(owner);
    const cart = await this.repo.getActiveCart(s.owner);
    if (!cart) return { cartId: newId(), eligible: [], excluded: [], couponCodes: [], destination: null };
    const checked = await this.checkFor(cart, s, false);
    const wanted = itemIds ? new Set(itemIds) : null;
    const lines = checked.lines.filter((l) => !wanted || wanted.has(l.item.id));
    const eligible: CheckoutCartLine[] = lines
      .filter((l) => l.state === 'ok')
      .map((l) => ({
        itemId: l.item.id,
        offerId: l.item.offerId,
        ownerType: l.eval.item.owner_type,
        sellerId: l.eval.item.seller_id,
        stockItemId: l.eval.offer?.stockItemId ?? l.eval.item.stock_item_id,
        acceptedTermsVersion: l.item.acceptedTermsVersion,
        productId: l.item.productId,
        variantId: l.item.variantId,
        packageKey: l.eval.packageKey,
        fulfilledBy: l.eval.fulfilledBy,
        quantity: l.item.quantity,
        acceptedUnitPrice: l.item.acceptedUnitPrice,
        currentUnitPrice: l.item.unitPrice,
      }));
    return {
      cartId: cart.id,
      eligible,
      excluded: lines.filter((l) => l.state !== 'ok').map((l) => l.item),
      couponCodes: storedCoupons(checked.cart.coupon_codes).map((c) => c.code),
      destination: checked.view.destination ?? null,
    };
  }

  /** Remove lines that became an accepted order; other lines stay. Marks the cart converted when it becomes empty. */
  async removePurchasedItems(cartId: string, itemIds: string[], orderId: string): Promise<void> {
    this.ctx.log.debug({ cartId, orderId }, 'cart: removing purchased lines');
    if (!isUuid(cartId)) return;
    const removed = await this.repo.transaction(async (tx) => {
      const cart = await tx.getCart(cartId, { forUpdate: true });
      if (!cart) return [] as ItemRow[];
      const items = (await tx.listItems(cartId)).filter((i) => itemIds.includes(i.id));
      await tx.deleteItems(items.map((i) => i.id));
      if (cart.status === 'active' && (await tx.countItems(cartId)) === 0) {
        await tx.updateCart(cartId, { status: cartLifecycleMachine.next('active', 'convert'), updated_at: this.now() });
      }
      return items;
    });
    for (const i of removed) this.ctx.events.publish('cart.item.removed', { cartId, itemId: i.id, offerId: i.offer_id, reason: 'purchased' }, { actor: SYSTEM.actor });
  }

  /** Put lines back after a declined payment on an order that was pending, so the customer can pay another way without rebuilding the cart. */
  async restoreItems(cartId: string, lines: CartLineInput[]): Promise<void> {
    const cart = isUuid(cartId) ? await this.repo.getCart(cartId) : undefined;
    if (!cart) throw notFound('Cart');
    const offersApi = this.ctx.use('offers');
    const offerMap = lines.length ? await offersApi.getOffers([...new Set(lines.map((l) => l.offerId))]) : {};
    const found = lines.map((l) => ({ line: l, offer: offerMap[l.offerId] ?? null }));
    const s = this.ownerOf(cart);
    const days = await this.retention(s.kind);
    const now = this.now();
    await this.repo.transaction(async (tx) => {
      const locked = (await tx.getCart(cartId, { forUpdate: true }))!;
      // the same cart when it can come back; the owner's newer active cart otherwise
      let target = locked;
      if (locked.status !== 'active') {
        const active = await tx.getActiveCart(s.owner, { forUpdate: true });
        if (active) target = active;
        else if (locked.status === 'converted') target = await tx.updateCart(locked.id, { status: cartLifecycleMachine.next('converted', 'restore') });
        else {
          const created = await tx.insertCart({ ...locked, id: newId(), status: 'active', merged_into_id: null, coupon_codes: storedCoupons(locked.coupon_codes) as never, created_at: now, checked_at: null });
          target = created ?? (await tx.getActiveCart(s.owner))!;
        }
      }
      for (const { line, offer } of found) {
        if (!offer) {
          this.ctx.log.warn({ cartId, offerId: line.offerId }, 'cart: offer of a restored line no longer exists');
          continue;
        }
        const existing = await tx.getItemByOffer(target.id, offer.id);
        if (existing) {
          if (existing.quantity < line.quantity) await tx.updateItem(existing.id, { quantity: line.quantity, updated_at: now });
          continue;
        }
        await tx.insertItem({
          id: newId(),
          cart_id: target.id,
          offer_id: offer.id,
          owner_type: offer.ownerType,
          seller_id: offer.sellerId ?? null,
          product_id: offer.productId,
          variant_id: offer.variantId,
          stock_item_id: offer.stockItemId,
          ships_from: shippingOf(offer).dispatch.shipsFrom,
          fulfilled_by: shippingOf(offer).fulfilledBy,
          condition: offer.condition,
          quantity: line.quantity,
          price_at_add: line.acceptedUnitPrice.amount,
          accepted_price: line.acceptedUnitPrice.amount,
          accepted_terms_version: offer.termsVersion,
          currency: line.acceptedUnitPrice.currency,
          source: null,
          added_at: now,
          updated_at: now,
          last_checked_at: null,
        });
      }
      await tx.updateCart(target.id, { updated_at: now, expires_at: addDays(now, days) });
    });
  }

  /** Add an offer to the shopper's cart, creating the cart if needed; same rules as POST /cart/items (an offer already in the cart increases its quantity, capped at the limit). Publishes cart.item.added. */
  async addLine(owner: { customerId?: string; guestSessionId?: string }, line: { offerId: string; quantity: number }): Promise<CartItem> {
    const s = owner.customerId ? this.shopperOfOwner({ kind: 'customer', customerId: owner.customerId }) : this.shopperOfOwner({ kind: 'guest', guestSessionId: owner.guestSessionId ?? null });
    const actor: common.Actor = s.kind === 'customer' ? { kind: 'customer', id: s.customerId } : { kind: 'visitor', id: s.guestSessionId };
    const r = await this.add(s, { offerId: line.offerId, quantity: line.quantity }, { actor });
    const item = r.cart.packages.flatMap((p) => p.items).find((i) => i.id === r.itemId);
    if (!item) throw notFound();
    return item;
  }

  /** How many active carts hold an offer (used to warn a seller before ending an offer). */
  async countOfferInCarts(offerId: string): Promise<number> {
    return isUuid(offerId) ? this.repo.countActiveCartsWithOffer(offerId) : 0;
  }

  /** The shopper's cart grouped by package, after a fresh price, stock and eligibility check (same as GET /cart) */
  async getCartView(owner: CartOwner): Promise<CartView | null> {
    const s = this.shopperOfOwner(owner);
    const cart = await this.repo.getActiveCart(s.owner);
    return cart ? (await this.checkFor(cart, s, true)).view : null;
  }

  /** GraphQL Query.cart: the principal's cart (null without one) */
  async getCartViewFor(p: Principal | null): Promise<{ view: CartView; shopper: Shopper } | null> {
    const s = await this.shopperOfPrincipal(p);
    if (!s) return null;
    const cart = await this.activeCart(s);
    return cart ? { view: (await this.checkFor(cart, s, true)).view, shopper: s } : null;
  }

  async savedForLaterOf(s: Shopper, limit: number): Promise<SavedItem[]> {
    const res = await this.repo.listSaved(s.owner, { mode: 'cursor', cursor: null, limit: Math.min(Math.max(limit, 1), 100) });
    return this.savedItems(res.items, s);
  }

  /* ================================================================ events consumed */

  private async queue(items: ItemRow[], reason: string) {
    for (let i = 0; i < items.length; i += EVENT_BATCH) await this.repo.enqueue(items.slice(i, i + EVENT_BATCH).map((x) => x.id), reason, this.now());
  }

  /** Gives lines a blocking notice at once (the badge shows it); the recheck job confirms against the source */
  private async flag(items: ItemRow[], kind: 'offer_ended' | 'seller_unavailable' | 'product_unavailable' | 'out_of_stock', current: Record<string, string | null>) {
    if (!items.length) return;
    const now = this.now();
    await this.repo.transaction(async (tx) => {
      const flagged = new Set((await tx.listNotices(items.map((i) => i.id))).filter((n) => !n.resolved_at && n.kind === kind).map((n) => n.item_id));
      const rows = items
        .filter((i) => !flagged.has(i.id))
        .map((i) => ({ id: newId(), item_id: i.id, kind, severity: 'blocking', previous: {}, current, detected_at: now, accepted_at: null, resolved_at: null }));
      await tx.insertNotices(rows);
    });
  }

  /** offers.offer.price_changed: Queue lines holding the offer for a notice refresh (price increased or decreased) */
  async onOfferPriceChangedFromOffers(event: EventPayload<'offers.offer.price_changed'>): Promise<void> {
    await this.queue(await this.repo.findActiveItems({ offerIds: [event.offerId] }), 'price_changed');
  }

  /** offers.offer.status_changed: Queue lines; an ended or hidden offer becomes an offer_ended blocking notice */
  async onOfferStatusChangedFromOffers(event: EventPayload<'offers.offer.status_changed'>): Promise<void> {
    const items = await this.repo.findActiveItems({ offerIds: [event.offerId] });
    if (!items.length) return;
    if (['removed', 'paused', 'ineligible', 'draft'].includes(event.to)) {
      const code = event.reasonCode ?? null;
      const kind = code === 'seller_restricted' || code === 'seller_suspended' || code === 'seller_closed' ? 'seller_unavailable' : code === 'product_hidden' || code === 'product_suspended' ? 'product_unavailable' : 'offer_ended';
      await this.flag(items, kind, { reason: event.reason ?? null });
    } else if (event.to === 'out_of_stock') {
      await this.flag(items, 'out_of_stock', { reason: null });
    }
    await this.queue(items, `status:${event.to}`);
  }

  /** inventory.stock.changed: Queue lines whose quantity may exceed availability (out_of_stock or quantity_reduced) */
  async onStockChangedFromInventory(event: EventPayload<'inventory.stock.changed'>): Promise<void> {
    const items = await this.repo.findActiveItems({ stockItemIds: [event.stockItemId] });
    if (!items.length) return;
    const notices = await this.repo.listNotices(items.map((i) => i.id));
    const stockNotice = new Set(notices.filter((n) => !n.resolved_at && (n.kind === 'out_of_stock' || n.kind === 'quantity_reduced')).map((n) => n.item_id));
    // lines above the new availability, and lines whose stock notice may now clear
    await this.queue(items.filter((i) => i.quantity > event.available || stockNotice.has(i.id)), 'stock_changed');
  }

  /** sellers.seller.restricted: Lines from offers the restriction hides get seller_unavailable notices; nothing is switched to another seller */
  async onSellerRestrictedFromSellers(event: EventPayload<'sellers.seller.restricted'>): Promise<void> {
    if (!event.affectedActivities.includes('sales')) return;
    const items = await this.repo.findActiveItems({ sellerIds: [event.sellerId] });
    if (!items.length) return;
    const sc = event.scope ?? {};
    // scopes by category need the offer to decide: those lines are re-checked through offers. A condition scope is
    // decided here from the line's condition (cart_items.condition), unless a line does not know it yet.
    const conditions = sc.conditions ?? [];
    const conditionHit = (c: string | null) => !conditions.length || (c !== null && (conditions.includes(c) || conditions.includes(conditionGroupOf(c))));
    const hit = items.filter((i) => (!sc.offerIds?.length || sc.offerIds.includes(i.offer_id)) && (!sc.productIds?.length || sc.productIds.includes(i.product_id)) && (i.condition === null || conditionHit(i.condition)));
    const precise = !(sc.categoryIds?.length || event.categoryIds?.length) && (!conditions.length || hit.every((i) => i.condition !== null));
    if (precise) await this.flag(hit, 'seller_unavailable', { reason: event.reason });
    await this.queue(precise ? hit : items, 'seller_restricted');
  }

  /** sellers.seller.suspended: Same as restricted */
  async onSellerSuspendedFromSellers(event: EventPayload<'sellers.seller.suspended'>): Promise<void> {
    const items = await this.repo.findActiveItems({ sellerIds: [event.sellerId] });
    await this.flag(items, 'seller_unavailable', { reason: event.reason });
    await this.queue(items, 'seller_suspended');
  }

  /** catalog.product.publication_changed: Hidden or suspended products give their lines a product_unavailable notice */
  async onProductPublicationChangedFromCatalog(event: EventPayload<'catalog.product.publication_changed'>): Promise<void> {
    const items = await this.repo.findActiveItems({ productIds: [event.productId] });
    if (!items.length) return;
    if (event.to === 'hidden' || event.to === 'suspended') await this.flag(items, 'product_unavailable', { reason: event.reason });
    await this.queue(items, `product_${event.to}`);
  }

  /** identity.guest_session.claimed: Merge the claimed guest session's cart into the account's customer cart (same rules and report as POST /cart/merge; idempotent). This is how sign-in merges carts on every client; identity only publishes the event and calls nothing in cart */
  async onGuestSessionClaimedFromIdentity(event: EventPayload<'identity.guest_session.claimed'>): Promise<void> {
    if (!isUuid(event.guestSessionId) || !isUuid(event.accountId)) return;
    // the claim is the proof POST /cart/merge asks for: recorded once, and kept even if the merge below has to be retried
    await this.ctx.mongo.claim(this.claimKey(event.guestSessionId, event.accountId));
    const customerId = await this.customerKey(event.accountId);
    const s: Shopper = { owner: { kind: 'customer', customerId }, kind: 'customer', customerId, guestSessionId: null, accountId: event.accountId };
    await this.merge(s, event.guestSessionId, { actor: { kind: 'customer', id: event.accountId } });
  }

  /* ================================================================ jobs */

  /** Job cart.recheck-queued (every 2 min): Refresh notices for lines queued by offer, stock and seller events so the next read is fast; GET /cart still re-checks authoritatively */
  async recheckQueued(): Promise<void> {
    for (let round = 0; round < 10; round++) {
      const rows = await this.repo.takeQueue(JOB_BATCH);
      if (!rows.length) return;
      const itemIds = rows.map((r) => r.item_id);
      const items = await this.repo.getItemsByIds(itemIds);
      const carts = await this.repo.getCarts([...new Set(items.map((i) => i.cart_id))]);
      for (const cart of carts) {
        if (cart.status !== 'active') continue;
        try {
          await this.checkFor(cart, this.ownerOf(cart), false);
        } catch (err) {
          if (isNotImplemented(err)) this.ctx.log.debug({ cartId: cart.id }, 'cart: recheck skipped, a dependency is not built yet');
          else this.ctx.log.warn({ err, cartId: cart.id }, 'cart: recheck failed; the next read re-checks');
        }
      }
      await this.repo.dequeue(itemIds);
      if (rows.length < JOB_BATCH) return;
    }
  }

  /** Job cart.expire-idle (daily 03:00 PT): Expire guest carts idle longer than guestCartRetentionDays and customer carts idle longer than customerCartRetentionDays; publishes cart.cart.expired */
  async expireIdle(): Promise<void> {
    for (let round = 0; round < 50; round++) {
      const now = this.now();
      const carts = await this.repo.listExpiredCarts(now, JOB_BATCH);
      if (!carts.length) return;
      for (const c of carts) {
        const expired = await this.repo.transaction(async (tx) => {
          const locked = await tx.getCart(c.id, { forUpdate: true });
          if (!locked || locked.status !== 'active' || locked.expires_at > now) return null;
          await tx.updateCart(c.id, { status: cartLifecycleMachine.next('active', 'expire'), updated_at: now });
          return (await tx.aggregateCart(c.id))?.itemCount ?? 0;
        });
        if (expired !== null) this.ctx.events.publish('cart.cart.expired', { cartId: c.id, ownerKind: c.owner_kind, itemCount: expired }, this.meta(SYSTEM));
      }
      if (carts.length < JOB_BATCH) return;
    }
  }
}

/** The terms version an open purchase_limit_reduced notice carries when the new quantity is within its limit (0 = none) */
function limitTermsVersion(open: { kind: string; current: unknown }[], quantity: number): number {
  let version = 0;
  for (const n of open) {
    const cur = (n.current ?? {}) as Record<string, unknown>;
    if (n.kind === 'purchase_limit_reduced' && typeof cur.limit === 'number' && quantity <= cur.limit && typeof cur.termsVersion === 'number') version = Math.max(version, cur.termsVersion);
  }
  return version;
}

/** A stored merge report; reports saved before savedItemsMoved existed count 0 */
function withSavedCount(report: unknown): MergeReport {
  const r = report as MergeReport;
  return { ...r, savedItemsMoved: typeof r.savedItemsMoved === 'number' ? r.savedItemsMoved : 0 };
}
