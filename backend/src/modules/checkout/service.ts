import type { Scope } from '../../kernel/auth/scope.js';
import { AppError, isAppError } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import { isUuid, newId } from '../../kernel/lib/ids.js';
import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as cart from '../../spec/cart.js';
import type * as common from '../../spec/common.js';
import type * as payments from '../../spec/payments.js';
import type * as shipping from '../../spec/shipping.js';
import type {
  AddressSelection,
  ChangeDecision,
  ChangeSet,
  CheckoutLine,
  CheckoutPublicApi,
  CheckoutSessionAdminDetail,
  CheckoutSessionAdminRow,
  CheckoutView,
  ConfirmationView,
  CouponResult,
  DeliverySelection,
  GuestContactInput,
  PlaceOrderInput,
  PlaceOrderResult,
  RetryPaymentInput,
  RevalidationResult,
} from '../../spec/checkout.js';
import { CONDITION_LABEL, emptyTotals, m, plural, type StoredAccount, type StoredQuote } from './domain/rules.js';
import { checkoutSessionMachine } from './domain/state-machines.js';
import type { LineRow, Owner, SessionRow, TaxProvider } from './ports.js';
import type { CheckoutRepository } from './repository.js';
import { Core, SYSTEM, invalid, type By } from './service/core.js';
import { Placement } from './service/placement.js';
import { Quoter, included, type Draft } from './service/quote.js';
import { Revalidator } from './service/revalidation.js';
import { Views } from './service/views.js';

export interface CheckoutServiceDeps {
  repo: CheckoutRepository;
  ctx: ModuleContext<'checkout'>;
  /** Sales tax per line for a destination (dev adapter: the state base-rate table) */
  tax: TaxProvider;
}

type Status = Parameters<typeof checkoutSessionMachine.next>[0];

const EDITABLE_INFO = ['open', 'changes_pending', 'payment_failed'];

/**
 * Checkout use cases. Depends only on its repository, the tax provider, the event bus, the clock and other modules' public APIs.
 * Each method maps to an endpoint, a publicApi function, a consumed event or a job in docs/api/spec/modules/checkout.json.
 */
export class CheckoutService implements CheckoutPublicApi {
  readonly core: Core;
  readonly quoter: Quoter;
  readonly views: Views;
  readonly reval: Revalidator;
  readonly placement: Placement;

  constructor(protected readonly deps: CheckoutServiceDeps) {
    this.core = new Core(deps.ctx, deps.repo);
    this.quoter = new Quoter(this.core, deps.tax);
    this.views = new Views(this.core);
    this.reval = new Revalidator(this.core, this.quoter, this.views);
    this.placement = new Placement(this.core, this.views, this.reval, (s) => this.views.checkout(s));
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

  /* ================================================================ start */

  /**
   * Who is checking out, for guest ad attribution: the caller's app session id (the visitor id advertising keys
   * clicks by) and whether the shopper allowed personalization. A signed-in customer's personalizedRecommendations
   * preference decides; visitor sessions carry no privacy choice, so personalization is off for them.
   */
  private async privacyOf(owner: Owner, principal: { sessionId?: string | null } | null | undefined): Promise<{ visitorKey: string | null; personalizationAllowed: boolean }> {
    const visitorKey = principal?.sessionId ?? null;
    if (!owner.customerId) return { visitorKey, personalizationAllowed: false };
    const prefs = await this.core.optional('customers.getMarketingConsent', () => this.ctx.use('customers').getMarketingConsent(owner.customerId!));
    return { visitorKey, personalizationAllowed: Boolean(prefs?.personalizedRecommendations) };
  }

  async startCheckout(scope: Scope, body: { source: 'cart' | 'buy_now'; cartItemIds?: string[] | null; offerId?: string | null; quantity?: number | null }, by: By, principal?: { sessionId?: string | null } | null): Promise<CheckoutView> {
    const owner = await this.core.ownerOf(scope);
    const privacy = await this.privacyOf(owner, principal);
    const customers = this.ctx.use('customers');
    let account: StoredAccount = { kind: 'guest', customerId: null, name: null, email: null, phone: null, createAccountAfter: false, marketingOptIn: false, hidePricesOnSlip: false };
    if (owner.guestSessionId) {
      if (!(await this.ctx.settings.get('guestCheckoutEnabled'))) throw this.core.error('GUEST_CHECKOUT_DISABLED', 'Sign in or create an account to check out');
    } else {
      const can = await customers.canPlaceOrders(owner.customerId!);
      if (!can.allowed) throw this.core.error('ORDERING_RESTRICTED', can.reason ?? 'This account cannot place orders right now', { reason: can.reason ?? null });
      const c = await customers.getCustomer(owner.customerId!);
      account = { kind: 'customer', customerId: owner.customerId!, name: c?.displayName ?? null, email: c?.email ?? null, phone: c?.phone ?? null, createAccountAfter: false, marketingOptIn: false, hidePricesOnSlip: false };
    }

    const id = newId();
    const now = this.now();
    const lines: LineRow[] = [];
    const excluded: CheckoutLine[] = [];
    const lineInfo: StoredQuote['lineInfo'] = {};
    let couponCodes: string[] = [];
    let cartId: string | null = null;
    let prefillAddressId: string | null = null;
    const windowDays = Number(await this.ctx.settings.get('purchaseLimitWindowDays')) || 30;
    const checkLimit = async (offerId: string, quantity: number, limit: number | null | undefined) => {
      if (!limit) return;
      const before = owner.customerId ? await this.ctx.use('orders').countPurchased(owner.customerId, offerId, windowDays) : 0;
      if (quantity + before > limit) throw this.core.error('PURCHASE_LIMIT_EXCEEDED', `Limit ${limit} per customer${before ? `; you bought ${before} in the last ${windowDays} days` : ''}`, { max: Math.max(0, limit - before), offerId });
    };

    if (body.source === 'cart') {
      const cartOwner: cart.CartOwner = owner.customerId ? { kind: 'customer', customerId: owner.customerId } : { kind: 'guest', guestSessionId: owner.guestSessionId! };
      const snap = await this.ctx.use('cart').getCartForCheckout(cartOwner, body.cartItemIds?.length ? body.cartItemIds : undefined);
      if (!snap.eligible.length && !snap.excluded.length) throw this.core.error('CART_EMPTY', 'Your cart is empty');
      if (!snap.eligible.length) {
        throw this.core.error('NOTHING_TO_CHECK_OUT', 'None of your cart items can be checked out yet. Review them in your cart first.', { lines: snap.excluded.map((i) => ({ cartItemId: i.id, title: i.title, state: i.state })) });
      }
      cartId = snap.cartId;
      couponCodes = snap.couponCodes;
      prefillAddressId = owner.customerId ? (snap.destination?.addressId ?? null) : null;
      const facts = await this.quoter.facts(snap.eligible.map((e) => ({ offerId: e.offerId })));
      for (const e of snap.eligible) {
        const f = facts.get(e.offerId);
        if (!f?.offer || !f.info) continue;
        await checkLimit(e.offerId, e.quantity, f.offer.purchaseLimit);
        const line = this.quoter.lineFrom(id, f.offer, e.quantity, e.itemId);
        lines.push(line);
        lineInfo[line.id] = f.info;
      }
      const offersApi = this.ctx.use('offers');
      for (const i of snap.excluded) {
        const o = await offersApi.getOffer(i.offerId);
        excluded.push({
          id: `cart:${i.id}`,
          cartItemId: i.id,
          offerId: i.offerId,
          productId: i.productId,
          variantId: i.variantId,
          stockItemId: o?.stockItemId ?? i.offerId,
          title: i.title,
          variantLabel: i.variantLabel,
          condition: CONDITION_LABEL[i.condition] ?? i.condition,
          image: i.image ?? null,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          lineTotal: i.lineTotal,
          discounts: [],
          status: 'unavailable',
          note: i.notices[0]?.message ?? 'Needs your attention in the cart. It stays in your cart.',
        });
      }
      if (!lines.length) throw this.core.error('NOTHING_TO_CHECK_OUT', 'None of your cart items can be checked out right now.', { lines: snap.eligible.map((e) => ({ cartItemId: e.itemId })) });
    } else {
      if (!body.offerId) throw invalid([{ path: 'offerId', message: 'Choose the offer to buy' }], 'Choose the offer to buy');
      const quantity = body.quantity ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1) throw invalid([{ path: 'quantity', message: 'Quantity must be at least 1' }], 'Quantity must be at least 1');
      const f = (await this.quoter.facts([{ offerId: body.offerId }])).get(body.offerId);
      const offer = f?.offer;
      if (!offer || !f.info || offer.status !== 'active') throw this.core.error('OFFER_UNAVAILABLE', 'This offer cannot be bought right now', { reason: offer ? `offer_${offer.status}` : 'not_found' });
      const available = (await this.ctx.use('inventory').getAvailability([offer.stockItemId]))[offer.stockItemId]?.available ?? 0;
      if (available < quantity) throw this.core.error('OFFER_UNAVAILABLE', available > 0 ? `Only ${available} available` : 'This offer is out of stock', { reason: available > 0 ? 'not_enough_stock' : 'out_of_stock', available });
      await checkLimit(offer.id, quantity, offer.purchaseLimit);
      const line = this.quoter.lineFrom(id, offer, quantity, null);
      lines.push(line);
      lineInfo[line.id] = f.info;
    }

    const currency = this.core.currency;
    const quote: StoredQuote = { fingerprint: '', lineInfo, shippability: {}, lineAllocations: {}, shippingDiscounts: {}, coupons: [], discounts: [], tax: null, totals: emptyTotals(currency), excluded, evaluation: null, addressBookNote: null, cartItemIds: lines.map((l) => l.cart_item_id).filter((x): x is string => Boolean(x)) };
    let session = await this.repo.insertSession({
      id,
      source: body.source,
      cart_id: cartId,
      customer_id: owner.customerId ?? null,
      guest_session_id: owner.guestSessionId ?? null,
      ...this.core.accountPatch(account),
      visitor_key: privacy.visitorKey,
      personalization_allowed: privacy.personalizationAllowed,
      address: null,
      address_id: null,
      status: checkoutSessionMachine.initial,
      quote_version: 0,
      currency,
      ...this.core.quotePatch(quote),
      coupon_codes: couponCodes as never,
      credit: null,
      payment_selection: null,
      payment_intent_id: null,
      payment_state: null,
      order_attempt: null,
      gift_note: null,
      promotion_evaluation_id: null,
      redemption_reservation_id: null,
      stock_reservation_id: null,
      credit_hold_id: null,
      hold_until: null,
      attempt_count: 0,
      order_id: null,
      order_ref: null,
      channel: null,
      expires_at: await this.core.idleExpiry(),
      created_at: now,
      updated_at: now,
    });

    // the address the cart's estimates used (a saved address of the customer)
    let address: common.Address | null = null;
    if (prefillAddressId && owner.customerId) {
      address = (await this.core.optional('customers.getAddressForOrder', () => customers.getAddressForOrder(owner.customerId!, prefillAddressId!))) ?? null;
    }
    const d: Draft = { session, address, lines, packages: new Map(), quote, couponCodes, credit: null };
    session = await this.quoter.requote(d, { coverage: Boolean(address), shipping: true, allowed: ['open'], patch: address ? { address: address as never, address_id: prefillAddressId } : {} });
    // codes carried over from the cart that no longer apply are dropped
    const rejected = this.core.quote(session).coupons.filter((c) => c.status !== 'applied').map((c) => c.code.toUpperCase());
    if (rejected.length) {
      d.couponCodes = d.couponCodes.filter((c) => !rejected.includes(c.toUpperCase()));
      session = await this.quoter.requote(d, { allowed: ['open'] });
    }
    await this.core.log(id, 'Checkout started', `${body.source === 'cart' ? 'From the cart' : 'Buy now'}: ${plural(lines.length, 'line')}`);
    this.core.publish('checkout.session.started', { sessionId: id, source: body.source, customerId: owner.customerId ?? null, guest: !owner.customerId, lineCount: lines.length, total: this.core.quote(session).totals.total }, by);
    return this.views.checkout(session);
  }

  /* ================================================================ reads */

  async getCheckout(scope: Scope, id: string): Promise<CheckoutView> {
    return this.views.checkout(await this.core.load(await this.core.readerOf(scope), id));
  }

  async getConfirmationFor(scope: Scope, id: string): Promise<ConfirmationView> {
    const s = await this.core.load(await this.core.readerOf(scope), id);
    const c = await this.views.confirmation(s);
    if (!c) {
      throw new AppError('ILLEGAL_TRANSITION', s.status === 'payment_pending' ? "We're still confirming your payment. Check your order status." : 'The confirmation is shown once your payment is accepted', { machine: 'Checkout session', from: s.status, event: 'payment_accepted' });
    }
    return c;
  }

  /* ================================================================ editing */

  private assertNotExpired(s: SessionRow) {
    if (['open', 'changes_pending'].includes(s.status) && s.expires_at.getTime() <= this.now().getTime()) throw this.core.error('SESSION_EXPIRED', 'This checkout expired. Start again from your cart; nothing was charged.');
  }

  /** Steps that change the quote: open, or back to open from a declined payment (holds are released) */
  private async forQuoteEdit(owner: Owner | null, id: string): Promise<{ session: SessionRow; from: string }> {
    const s = await this.core.load(owner, id);
    this.assertNotExpired(s);
    if (s.status === 'open') return { session: s, from: 'open' };
    if (s.status === 'payment_failed') {
      checkoutSessionMachine.next('payment_failed', 'edit');
      return { session: s, from: 'payment_failed' };
    }
    if (s.status === 'changes_pending') throw new AppError('ILLEGAL_TRANSITION', 'Review the changes we found before editing your checkout', { machine: 'Checkout session', from: s.status, event: 'edit', allowed: checkoutSessionMachine.eventsFrom('changes_pending') });
    throw new AppError('ILLEGAL_TRANSITION', 'This checkout can no longer be changed', { machine: 'Checkout session', from: s.status, event: 'edit', allowed: checkoutSessionMachine.eventsFrom(s.status as Status) });
  }

  private async reopen(e: { session: SessionRow; from: string }): Promise<{ draftSession: SessionRow; patch: Partial<SessionRow> }> {
    if (e.from !== 'payment_failed') return { draftSession: e.session, patch: {} };
    const released = await this.placement.releaseHolds(e.session, 'Checkout edited after a declined payment');
    await this.core.log(e.session.id, 'Back to checkout', 'After a declined payment');
    return { draftSession: released, patch: { status: checkoutSessionMachine.next('payment_failed', 'edit'), hold_until: null } };
  }

  private async forInfoEdit(owner: Owner | null, id: string): Promise<SessionRow> {
    const s = await this.core.load(owner, id);
    this.assertNotExpired(s);
    if (!EDITABLE_INFO.includes(s.status)) throw new AppError('ILLEGAL_TRANSITION', 'This checkout can no longer be changed', { machine: 'Checkout session', from: s.status, event: 'edit', allowed: checkoutSessionMachine.eventsFrom(s.status as Status) });
    return s;
  }

  async setGuestContact(owner: Owner | null, id: string, body: GuestContactInput): Promise<CheckoutView> {
    const s = await this.forInfoEdit(owner, id);
    const a = this.core.account(s);
    if (a.kind === 'guest' && !(await this.ctx.settings.get('guestCheckoutEnabled'))) throw this.core.error('GUEST_CHECKOUT_DISABLED', 'Sign in or create an account to check out');
    const email = body.email.trim().toLowerCase();
    const phone = body.phone?.trim() || null;
    if (phone && !/^\+?[0-9 ().-]{7,20}$/.test(phone)) throw invalid([{ path: 'phone', message: 'Enter a phone number with digits only, e.g. +1 503 555 0101' }], 'Check your phone number');
    const next: StoredAccount = {
      ...a,
      email,
      phone,
      createAccountAfter: a.kind === 'guest' ? Boolean(body.createAccountAfter) : false,
      marketingOptIn: Boolean(body.marketingOptIn),
    };
    const saved = await this.repo.updateSession(id, { ...this.core.accountPatch(next), updated_at: this.now(), expires_at: s.status === 'payment_failed' ? s.expires_at : await this.core.idleExpiry() });
    return this.views.checkout(saved);
  }

  async setAddress(owner: Owner | null, id: string, body: AddressSelection): Promise<CheckoutView> {
    const e = await this.forQuoteEdit(owner, id);
    const customers = this.ctx.use('customers');
    let address: common.Address;
    let addressId: string | null = null;
    let note: string;
    if (body.addressId) {
      if (!e.session.customer_id) throw this.core.notFound('Address');
      address = await customers.getAddressForOrder(e.session.customer_id, body.addressId);
      addressId = body.addressId;
      note = "Changing the address here doesn't change your address book.";
    } else if (body.address) {
      const v = await customers.validateAddress(body.address);
      if (!v.valid || !v.deliverable) {
        throw this.core.error('ADDRESS_INVALID', v.issues[0]?.message ?? "We can't deliver to this address", { issues: v.issues.map((i) => ({ path: `address.${i.field}`, code: i.code, message: i.message })), suggestion: v.suggestion ?? null });
      }
      address = { ...body.address, line2: body.address.line2 || null, phone: body.address.phone || null };
      note = e.session.customer_id ? "Changing the address here doesn't change your address book." : "We'll use this address for this order only.";
      if (body.saveToAddressBook && e.session.customer_id) {
        const saved = await customers.rememberCheckoutAddress(e.session.customer_id, address, body.label ?? undefined);
        addressId = saved.id;
        note = 'Saved to your addresses.';
      }
    } else {
      throw this.core.error('ADDRESS_INVALID', 'Choose a saved address or enter one', { issues: [{ path: 'address', message: 'Choose a saved address or enter one' }] });
    }
    const { draftSession, patch } = await this.reopen(e);
    const d = await this.quoter.draftOf(draftSession);
    d.address = address;
    d.quote.addressBookNote = note;
    // a new address re-checks every line that is not removed
    for (const l of d.lines) if (l.status === 'not_shippable') l.status = 'included';
    const account = this.core.account(draftSession);
    const accountPatch = account.kind === 'guest' && !account.name ? this.core.accountPatch({ ...account, name: address.name, phone: account.phone ?? address.phone ?? null }) : {};
    const saved = await this.quoter.requote(d, { coverage: true, shipping: true, allowed: [e.from], patch: { ...patch, ...accountPatch, address: address as never, address_id: addressId } });
    return this.views.checkout(saved);
  }

  async setDeliveryOptions(owner: Owner | null, id: string, selections: DeliverySelection[]): Promise<CheckoutView> {
    const e = await this.forQuoteEdit(owner, id);
    const d0 = await this.quoter.draftOf(e.session);
    for (const sel of selections) {
      const pkg = d0.packages.get(sel.packageKey);
      const options = (pkg?.options ?? []) as unknown as shipping.DeliveryOption[];
      if (!pkg || !options.some((o) => o.id === sel.optionId)) {
        throw this.core.error('DELIVERY_OPTION_UNAVAILABLE', pkg ? 'This delivery option is no longer offered for the package. Choose one of the current options.' : 'This package is not part of your checkout', { packageKey: sel.packageKey, optionId: sel.optionId, options });
      }
    }
    const { draftSession, patch } = await this.reopen(e);
    const d = draftSession === e.session ? d0 : await this.quoter.draftOf(draftSession);
    for (const sel of selections) {
      const pkg = d.packages.get(sel.packageKey)!;
      const opt = (pkg.options as unknown as shipping.DeliveryOption[]).find((o) => o.id === sel.optionId)!;
      pkg.selected_option_id = opt.id;
      pkg.selected_option = opt as never;
    }
    return this.views.checkout(await this.quoter.requote(d, { allowed: [e.from], patch }));
  }

  async applyCoupon(owner: Owner | null, id: string, rawCode: string): Promise<{ result: CouponResult; checkout: CheckoutView }> {
    const e = await this.forQuoteEdit(owner, id);
    const code = rawCode.trim();
    if (!code) throw invalid([{ path: 'code', message: 'Enter a code' }], 'Enter a coupon code');
    const limit = Number(await this.ctx.settings.get('couponAttemptsPerHour')) || 20;
    const tried = await this.repo.countLog(id, 'Coupon tried', new Date(this.now().getTime() - 3600_000));
    if (tried >= limit) throw new AppError('RATE_LIMITED', 'Too many codes tried. Try again in an hour.', { retryAfterSeconds: 3600 });
    await this.core.log(id, 'Coupon tried', code);
    const existing = this.core.quote(e.session).coupons.find((c) => c.code.toUpperCase() === code.toUpperCase() && c.status === 'applied');
    if (existing) return { result: existing, checkout: await this.views.checkout(e.session) };

    const trial = await this.quoter.draftOf(e.session);
    trial.couponCodes = [...trial.couponCodes.filter((c) => c.toUpperCase() !== code.toUpperCase()), code];
    this.quoter.syncPackages(trial);
    const priced = await this.quoter.price(trial);
    const result = priced.coupons.find((c) => c.code.toUpperCase() === code.toUpperCase())!;
    if (result.status !== 'applied') {
      // a code that doesn't apply is not kept; other discounts are unchanged
      return { result: { ...result, otherDiscountsNote: this.core.quote(e.session).coupons.some((c) => c.status === 'applied') ? 'Your other discount is unchanged.' : null }, checkout: await this.views.checkout(e.session) };
    }
    const { draftSession, patch } = await this.reopen(e);
    const d = draftSession === e.session ? trial : Object.assign(await this.quoter.draftOf(draftSession), { couponCodes: trial.couponCodes });
    const saved = await this.quoter.requote(d, { allowed: [e.from], patch });
    const final = this.core.quote(saved).coupons.find((c) => c.code.toUpperCase() === code.toUpperCase()) ?? result;
    return { result: final, checkout: await this.views.checkout(saved) };
  }

  async removeCoupon(owner: Owner | null, id: string, code: string): Promise<CheckoutView> {
    const e = await this.forQuoteEdit(owner, id);
    const codes = this.core.couponCodes(e.session);
    if (!codes.some((c) => c.toUpperCase() === code.trim().toUpperCase())) return this.views.checkout(e.session);
    const { draftSession, patch } = await this.reopen(e);
    const d = await this.quoter.draftOf(draftSession);
    d.couponCodes = d.couponCodes.filter((c) => c.toUpperCase() !== code.trim().toUpperCase());
    return this.views.checkout(await this.quoter.requote(d, { allowed: [e.from], patch }));
  }

  async setCredit(owner: Owner | null, id: string, body: { use: boolean; amount?: common.Money | null }): Promise<CheckoutView> {
    const e = await this.forQuoteEdit(owner, id);
    if (!e.session.customer_id) throw this.core.notFound();
    const wallet = this.ctx.tryUse('wallet');
    if (!wallet) throw this.core.error('INSUFFICIENT_CREDIT', 'Store credit is not available', { available: m(0, e.session.currency) });
    const balance = await wallet.getBalance(e.session.customer_id);
    if (body.amount && (body.amount.amount < 0 || body.amount.currency !== e.session.currency)) throw invalid([{ path: 'amount', message: `Enter a positive ${e.session.currency} amount` }], 'Check the credit amount');
    if (body.use && body.amount && body.amount.amount > balance.available.amount) throw this.core.error('INSUFFICIENT_CREDIT', `You have ${new Intl.NumberFormat('en-US', { style: 'currency', currency: balance.available.currency }).format(balance.available.amount / 100)} of store credit`, { available: balance.available });
    const { draftSession, patch } = await this.reopen(e);
    const d = await this.quoter.draftOf(draftSession);
    d.credit = { use: body.use, amount: body.use ? (body.amount?.amount ?? null) : null, available: balance.available.amount, sourceNote: balance.usableOn };
    return this.views.checkout(await this.quoter.requote(d, { allowed: [e.from], patch }));
  }

  async setPaymentMethod(owner: Owner | null, id: string, method: payments.MethodSelection): Promise<CheckoutView> {
    const s = await this.forInfoEdit(owner, id);
    const chosen = await this.placement.validateMethod(s, method);
    const saved = await this.repo.transaction(async (tx) => {
      const locked = (await tx.getSession(id, { forUpdate: true }))!;
      if (!EDITABLE_INFO.includes(locked.status)) throw new AppError('ILLEGAL_TRANSITION', 'This checkout can no longer be changed', { machine: 'Checkout session', from: locked.status });
      return tx.updateSession(id, { ...this.core.paymentPatch({ ...this.core.payment(locked), method: chosen.method, view: chosen.view }), updated_at: this.now() });
    });
    await this.core.log(id, 'Payment method chosen', chosen.view?.label ?? method.kind);
    return this.views.checkout(saved);
  }

  async setPreferences(owner: Owner | null, id: string, body: { giftNote?: string | null; hidePricesOnSlip?: boolean | null }): Promise<CheckoutView> {
    const s = await this.forInfoEdit(owner, id);
    const note = body.giftNote === undefined ? s.gift_note : body.giftNote?.trim() || null;
    if (note && note.length > 500) throw invalid([{ path: 'giftNote', message: 'Keep the gift note under 500 characters' }], 'The gift note is too long');
    const a = this.core.account(s);
    const saved = await this.repo.updateSession(id, { gift_note: note, ...this.core.accountPatch({ ...a, hidePricesOnSlip: body.hidePricesOnSlip ?? a.hidePricesOnSlip }), updated_at: this.now() });
    return this.views.checkout(saved);
  }

  /* ================================================================ revalidation and changes */

  async revalidate(owner: Owner | null, id: string, by: By): Promise<RevalidationResult> {
    const s = await this.core.load(owner, id);
    this.assertNotExpired(s);
    return this.reval.revalidate(owner, id, by, (x) => this.views.checkout(x));
  }

  /**
   * Development only (G30a, POST /api/dev/checkout/sessions/{id}/changes, DEV_TOKENS on): makes the next check of an
   * open checkout find a change, so the review-changes screen can be tested by hand. Default: the line's quoted price
   * is set 10% below the offer's (the price "went up"); unitPrice sets it to that amount; stock sets the quantity one
   * above what is available (a stock shortage). The checkout is then checked again and the change set returned.
   */
  async devForceChanges(id: string, input: { lineId?: string; unitPrice?: number; stock?: boolean }, by: By): Promise<RevalidationResult> {
    const s = isUuid(id) ? await this.repo.getSession(id) : undefined;
    if (!s) throw this.core.notFound();
    if (s.status !== 'open') throw new AppError('ILLEGAL_TRANSITION', 'Only an open checkout can be given changes', { machine: 'Checkout session', from: s.status, event: 'changes_found' });
    if (input.unitPrice !== undefined && !(Number.isInteger(input.unitPrice) && input.unitPrice >= 1)) throw invalid([{ path: 'unitPrice', message: 'A price in cents, at least 1' }]);
    const d = await this.quoter.draftOf(s);
    const line = d.lines.filter(included).find((l) => !input.lineId || l.id === input.lineId);
    if (!line) throw invalid([{ path: 'lineId', message: 'No such line in this checkout' }]);
    if (input.stock) {
      const available = (await this.ctx.use('inventory').getAvailability([line.stock_item_id]))[line.stock_item_id]?.available ?? line.quantity;
      line.quantity = Math.max(available, 0) + 1;
    } else {
      line.unit_price = input.unitPrice ?? Math.max(1, Math.round(line.unit_price * 0.9));
    }
    await this.quoter.requote(d, { allowed: ['open'] });
    await this.core.log(id, 'Development change', input.stock ? `Quantity set to ${line.quantity}` : `Quoted price set to ${line.unit_price}`);
    return this.reval.revalidate(this.core.ownerOfRow(s), id, by, (x) => this.views.checkout(x));
  }

  async getChangeSet(owner: Owner | null, id: string, changeSetId: string): Promise<ChangeSet> {
    if (!owner) throw this.core.notFound();
    return this.reval.getChangeSet(owner, id, changeSetId);
  }

  async acceptChanges(owner: Owner | null, id: string, changeSetId: string, body: { decisions: ChangeDecision[]; acceptPartialOrder: boolean }, by: By): Promise<CheckoutView> {
    const s = await this.core.load(owner, id);
    this.assertNotExpired(s);
    // stock and discounts held by a declined attempt no longer match a changed order
    if (s.stock_reservation_id || s.redemption_reservation_id) {
      const row = await this.repo.getChangeSet(id, changeSetId);
      if (row?.status === 'open' && s.status === 'changes_pending') await this.placement.releaseHolds(s, 'Checkout changed');
    }
    return this.views.checkout(await this.reval.accept(owner, id, changeSetId, body, by));
  }

  /* ================================================================ place and pay */

  placeOrder(owner: Owner | null, id: string, input: PlaceOrderInput, key: string, by: By): Promise<PlaceOrderResult> {
    return this.placement.place(owner, id, input, key, by);
  }

  retryPayment(owner: Owner | null, id: string, input: RetryPaymentInput, key: string, by: By): Promise<PlaceOrderResult> {
    return this.placement.retry(owner, id, input, key, by);
  }

  completePaymentAction(owner: Owner | null, id: string, resultToken: string, key: string, by: By): Promise<PlaceOrderResult> {
    return this.placement.completeAction(owner, id, resultToken, key, by);
  }

  /* ================================================================ leaving */

  async abandon(owner: Owner | null, id: string, by: By): Promise<void> {
    const s = await this.core.load(owner, id);
    checkoutSessionMachine.next(s.status as Status, 'cancel');
    await this.close(s, 'cancel', 'left', by);
  }

  /** cancel or expire: holds released, any open authorization voided, checkout.session.abandoned */
  private async close(s: SessionRow, event: 'cancel' | 'expire', reason: 'left' | 'expired' | 'retry_window_closed', by: By): Promise<boolean> {
    const claimed = await this.repo.transaction(async (tx) => {
      const locked = (await tx.getSession(s.id, { forUpdate: true }))!;
      if (!checkoutSessionMachine.can(locked.status as Status, event)) {
        if (event === 'cancel') checkoutSessionMachine.next(locked.status as Status, event);
        return null;
      }
      const updated = await tx.updateSession(s.id, { status: checkoutSessionMachine.next(locked.status as Status, event), hold_until: null, updated_at: this.now() });
      return { before: locked, updated };
    });
    if (!claimed) return false;
    await this.placement.releaseHolds(claimed.updated, reason === 'left' ? 'Checkout left' : 'Checkout expired');
    const pay = this.core.payment(claimed.before);
    if (pay.intentId && !claimed.before.order_id && (pay.intentState === 'requires_action' || pay.intentState === 'pending_check')) {
      await this.core.optional('payments.voidIntent', () => this.ctx.use('payments').voidIntent(pay.intentId!, reason === 'left' ? 'Checkout abandoned' : 'Checkout expired'));
    }
    await this.core.log(s.id, reason === 'left' ? 'Checkout left' : reason === 'expired' ? 'Checkout expired' : 'Retry window closed');
    this.core.publish('checkout.session.abandoned', { sessionId: s.id, lastStatus: claimed.before.status, reason }, by);
    return true;
  }

  /* ================================================================ admin */

  async listSessionsAdmin(query: { status?: string | null; q?: string | null; from?: string | null; to?: string | null }, page: PageRequest): Promise<Page<CheckoutSessionAdminRow>> {
    const day = (s: string | null | undefined, plusDays = 0) => {
      if (!s) return undefined;
      const d = new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime())) throw invalid([{ path: 'from', message: 'Not a date' }], 'Check the dates');
      return new Date(d.getTime() + plusDays * 86_400_000);
    };
    // without a status or a search: the checkouts support acts on (payment problems, open changes)
    const statuses = query.status ? [query.status] : query.q?.trim() ? undefined : ['changes_pending', 'payment_failed', 'payment_pending', 'awaiting_action'];
    const rows = await this.repo.listSessionsAdmin({ statuses, q: query.q ?? undefined, from: day(query.from), to: day(query.to, 1) }, page);
    return { ...rows, items: rows.items.map((r) => this.views.adminRow(r)) };
  }

  async getSessionAdmin(id: string): Promise<CheckoutSessionAdminDetail> {
    const s = await this.repo.getSession(id);
    if (!s) throw this.core.notFound();
    const [checkout, attempts, sets, log] = await Promise.all([this.views.checkout(s), this.repo.listPlaceRequests(id), this.repo.listChangeSets(id), this.repo.listLog(id)]);
    return {
      checkout,
      attempts: attempts.map((a) => this.views.attempt(a, s.currency)),
      changeSets: sets.map((c) => this.views.changeSet(c)),
      history: log.map((l) => ({ at: l.at.toISOString(), label: l.label, detail: l.detail, actor: null })),
    };
  }

  /* ================================================================ public API (in-process) */

  private ownerFrom(owner: { customerId?: string; guestSessionId?: string }): Owner | null {
    if (owner?.customerId) return { customerId: owner.customerId };
    if (owner?.guestSessionId) return { guestSessionId: owner.guestSessionId };
    return null;
  }

  /** Whether a checkout produced an order (used by payments' orphan check) */
  async getSessionForOrder(sessionId: string): Promise<{ orderId: string | null; status: string; customerId: string | null } | null> {
    const s = /^[0-9a-f-]{36}$/i.test(sessionId) ? await this.repo.getSession(sessionId) : undefined;
    return s ? { orderId: s.order_id, status: s.status, customerId: s.customer_id } : null;
  }

  /** A checkout session of this shopper (same as GET /sessions/{id}); null when it belongs to someone else */
  async getSessionView(owner: { customerId?: string; guestSessionId?: string }, sessionId: string): Promise<CheckoutView | null> {
    const o = this.ownerFrom(owner);
    const s = o && /^[0-9a-f-]{36}$/i.test(sessionId) ? await this.repo.getOwnSession(o, sessionId) : undefined;
    return s ? this.views.checkout(s) : null;
  }

  /** Order confirmation once the payment is accepted (same as GET /sessions/{id}/confirmation); null before */
  async getConfirmation(owner: { customerId?: string; guestSessionId?: string }, sessionId: string): Promise<ConfirmationView | null> {
    const o = this.ownerFrom(owner);
    const s = o && /^[0-9a-f-]{36}$/i.test(sessionId) ? await this.repo.getOwnSession(o, sessionId) : undefined;
    return s ? this.views.confirmation(s) : null;
  }

  /** GraphQL: the packing-slip preference of a session the viewer owns */
  async hidePricesOnSlip(owner: { customerId?: string; guestSessionId?: string }, sessionId: string): Promise<boolean> {
    const o = this.ownerFrom(owner);
    const s = o ? await this.repo.getOwnSession(o, sessionId) : undefined;
    return s ? this.core.account(s).hidePricesOnSlip : false;
  }

  /** GraphQL: the open change set of a session the viewer owns */
  async openChangeSetOf(owner: { customerId?: string; guestSessionId?: string }, sessionId: string): Promise<ChangeSet | null> {
    const o = this.ownerFrom(owner);
    const s = o ? await this.repo.getOwnSession(o, sessionId) : undefined;
    if (!s) return null;
    const row = await this.repo.openChangeSet(s.id);
    return row ? this.views.changeSet(row) : null;
  }

  /* ================================================================ events consumed */

  /** payments.payment.authorized: A payment_pending or awaiting_action session becomes completed (orders accepts the order on the same event) */
  async onPaymentAuthorizedFromPayments(event: EventPayload<'payments.payment.authorized'>): Promise<void> {
    await this.placement.onAuthorized(event);
  }

  /** payments.payment.failed: A payment_pending or awaiting_action session becomes payment_failed; when the order had been created, restore the lines to the cart (cart.restoreItems) so the customer can pay another way */
  async onPaymentFailedFromPayments(event: EventPayload<'payments.payment.failed'>): Promise<void> {
    await this.placement.onFailed(event);
  }

  /** orders.order.cancelled: If the cancelled order came from a pending payment, keep the session in payment_failed and point the customer to a new attempt */
  async onOrderCancelledFromOrders(event: EventPayload<'orders.order.cancelled'>): Promise<void> {
    await this.placement.onOrderCancelled(event);
  }

  /** identity.guest_session.claimed: Attach open guest sessions to the customer who signed in (account step switches to the customer) */
  async onGuestSessionClaimedFromIdentity(event: EventPayload<'identity.guest_session.claimed'>): Promise<void> {
    const sessions = await this.repo.listGuestSessions(event.guestSessionId, ['open', 'changes_pending', 'payment_failed']);
    if (!sessions.length) return;
    const customer = await this.ctx.use('customers').getCustomerByUserId(event.accountId);
    if (!customer) return this.ctx.log.info({ accountId: event.accountId }, 'checkout: claimed guest session has no customer yet');
    for (const s of sessions) {
      const a = this.core.account(s);
      const account: StoredAccount = { ...a, kind: 'customer', customerId: customer.id, name: customer.displayName || a.name, email: customer.email || a.email, phone: a.phone ?? customer.phone ?? null, createAccountAfter: false };
      await this.repo.transaction(async (tx) => {
        const locked = await tx.getSession(s.id, { forUpdate: true });
        if (!locked || locked.customer_id) return;
        await tx.updateSession(s.id, { customer_id: customer.id, ...this.core.accountPatch(account), updated_at: this.now() });
      });
      await this.core.log(s.id, 'Signed in', 'The checkout now belongs to the customer account');
    }
  }

  /* ================================================================ jobs */

  /** Job checkout.expire-sessions (every 5 min): Expire idle open sessions (sessionTtlMinutes) and payment_failed sessions past holdUntil: release stock and promotion reservations, release credit holds, void authorizations; publish checkout.session.abandoned */
  async expireSessions(): Promise<void> {
    for (let batch = 0; batch < 20; batch++) {
      const due = await this.repo.listExpirable(this.now(), 100);
      let closed = 0;
      for (const s of due) {
        try {
          if (await this.close(s, 'expire', s.status === 'payment_failed' ? 'retry_window_closed' : 'expired', SYSTEM)) closed++;
        } catch (err) {
          this.ctx.log.error({ err, sessionId: s.id }, 'checkout: could not expire a session');
        }
      }
      if (due.length < 100 || closed === 0) return;
    }
  }

  /** Job checkout.extend-pending-holds (every 10 min): Keep stock holds alive for payment_pending sessions (inventory.extendHold) up to pendingHoldHours */
  async extendPendingHolds(): Promise<void> {
    const hours = Number(await this.ctx.settings.get('pendingHoldHours')) || 24;
    const pending = await this.repo.listByStatus(['payment_pending'], 500);
    for (const s of pending) {
      try {
        await this.placement.reconcilePending(s);
        const fresh = await this.repo.getSession(s.id);
        if (fresh?.status !== 'payment_pending' || !fresh.stock_reservation_id) continue;
        const placed = (await this.repo.latestPlaceRequest(s.id))?.created_at ?? s.updated_at;
        const until = new Date(placed.getTime() + hours * 3600_000);
        if (until.getTime() <= this.now().getTime()) continue;
        await this.ctx.use('inventory').extendHold(fresh.stock_reservation_id, until.toISOString());
        // the store credit hold too, so a long pending check does not end in INSUFFICIENT_CREDIT
        const wallet = this.ctx.tryUse('wallet');
        if (wallet && fresh.credit_hold_id) {
          const holdId = fresh.credit_hold_id;
          await this.core.optional('wallet.extendHold', () => wallet.extendHold(holdId, until.toISOString()));
        }
      } catch (err) {
        if (isAppError(err) && err.status < 500) this.ctx.log.info({ err, sessionId: s.id }, 'checkout: pending hold could not be extended');
        else this.ctx.log.error({ err, sessionId: s.id }, 'checkout: pending hold could not be extended');
      }
    }
  }

  /** Job checkout.purge-idempotency (daily 03:30 PT): Delete place_requests older than idempotencyRetentionDays */
  async purgeIdempotency(): Promise<void> {
    const days = Number(await this.ctx.settings.get('idempotencyRetentionDays')) || 7;
    const n = await this.repo.purgePlaceRequests(new Date(this.now().getTime() - days * 86_400_000));
    if (n) this.ctx.log.info({ purged: n }, 'checkout: old Place order keys purged');
  }

  /* ================================================================ helpers for handlers */

  ownerOf(scope: Scope): Promise<Owner> {
    return this.core.ownerOf(scope);
  }

  async readerOf(scope: Scope): Promise<Owner | null> {
    return this.core.readerOf(scope);
  }

  /** Lines still in the order (tests and GraphQL) */
  async includedLines(sessionId: string): Promise<LineRow[]> {
    return (await this.repo.listLines(sessionId)).filter(included);
  }
}
