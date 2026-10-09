/**
 * Test world for checkout: the real shopping path (identity, access, customers, sellers, catalog, inventory,
 * offers, cart, orders, promotions, content, notifications) with a launched seller and a product in two
 * variants. payments and shipping are being built in parallel, so their public APIs are stubbed exactly as
 * src/spec/payments.ts and src/spec/shipping.ts declare them:
 *
 *   payments.authorize: the provider token decides — tok_decline → failed, tok_pending → pending_check,
 *     tok_3ds → requires_action, tok_invalid → PAYMENT_METHOD_INVALID, anything else (and saved cards) → accepted.
 *     The same idempotency key returns the first result. completeAction: 'ok' → accepted, 'fail' → failed.
 *   payments.listOptions: one saved Visa for customers, wallets available.
 *   shipping.quoteOptions: Standard ($5.99, free from $50 per package) and Express ($14.99) with arrival dates;
 *     destinations in Alaska are not served. shipping.checkCoverage: Alaska → outside_seller_coverage.
 *     `ship.shiftDays` moves arrival dates, `ship.standardPrice` changes the Standard price.
 */
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { AppError } from '../../../kernel/errors/index.js';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import type * as payments from '../../../spec/payments.js';
import type * as shipping from '../../../spec/shipping.js';
import { auth, buildTestApp, callers, movingClock } from '../../../testing/app.js';
import { flows, type Flows, type Staff } from '../../../testing/flows.js';
import type { CheckoutService } from '../service.js';

export const STORE = '/api/store/checkout';
export const USD = (amount: number) => ({ amount, currency: 'USD' });
export const PORTLAND = { name: 'Ana Lopez', line1: '1120 SW 5th Ave', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US', phone: '+15035550101' };
export const SEATTLE = { name: 'Ben Ortiz', line1: '400 Pine St', city: 'Seattle', region: 'WA', postalCode: '98101', country: 'US' };
export const ANCHORAGE = { name: 'Cy Moe', line1: '600 W 5th Ave', city: 'Anchorage', region: 'AK', postalCode: '99501', country: 'US' };

export const SAVED_CARD_ID = newId();

/** A PNG header of the given size (what the dev media processor reads), for the product image */
function png(width: number, height: number): Buffer {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const chunk = (type: string, data: Buffer) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])])), chunk('IDAT', Buffer.from('pixels', 'latin1')), chunk('IEND', Buffer.alloc(0))]);
}

/* ================================================================ payments stub */

export interface FakeIntent {
  id: string;
  key: string;
  input: payments.AuthorizeInput;
  state: payments.AuthorizeResult['state'];
  methodLabel: string;
  decline: payments.Decline | null;
  orderId: string | null;
}

export function fakePayments(clock: { now(): Date }) {
  const intents = new Map<string, FakeIntent>();
  const byKey = new Map<string, string>();
  const calls = { authorize: [] as { input: payments.AuthorizeInput; key: string }[], linkOrder: [] as { intentId: string; orderId: string; allocations: payments.Allocation[] }[], voidIntent: [] as string[], completeAction: [] as string[] };
  const decline: payments.Decline = { code: '05', category: 'card_declined', message: 'Your bank declined Visa •••• 4242. Nothing was charged.', advice: 'Try another card or a digital wallet.', retryable: true };
  const label = (m: payments.MethodSelection) => (m.kind === 'saved_card' ? 'Visa •••• 4242' : m.kind === 'digital_wallet' ? 'Apple Pay' : 'Mastercard •••• 4444');
  const result = (i: FakeIntent): payments.AuthorizeResult => ({ intentId: i.id, state: i.state, decline: i.decline, nextAction: i.state === 'requires_action' ? { kind: 'three_ds_challenge', url: 'https://bank.example.com/3ds', clientSecret: 'cs_1' } : null, methodLabel: i.methodLabel });
  const api: Partial<payments.PaymentsPublicApi> = {
    listOptions: async (owner, _amount) => ({
      acceptedBrands: ['visa', 'mastercard', 'amex'],
      savedMethods: owner.customerId
        ? [{ id: SAVED_CARD_ID, kind: 'card', brand: 'visa', label: 'Everyday Visa', last4: '4242', expMonth: 12, expYear: 2030, expired: false, isDefault: true, billingSummary: 'Home, Portland 97204', createdAt: '2026-01-01T00:00:00.000Z' }]
        : [],
      walletAvailable: true,
      walletKinds: ['apple_pay', 'google_pay'],
      newCard: { provider: 'dev', clientSecret: 'seti_secret', publishableKey: 'pk_test', expiresAt: new Date(clock.now().getTime() + 3600_000).toISOString() },
      chargeNote: 'Your card is charged once, when the order is accepted. Each seller is paid by Marketly after delivery.',
    }),
    authorize: async (input, key) => {
      calls.authorize.push({ input, key });
      const existing = byKey.get(key);
      if (existing) return result(intents.get(existing)!);
      const token = input.method.providerToken ?? '';
      if (token === 'tok_invalid') throw new AppError('PAYMENT_METHOD_INVALID', 'This card cannot be used', undefined, 422);
      const state: FakeIntent['state'] = token === 'tok_decline' ? 'failed' : token === 'tok_pending' ? 'pending_check' : token === 'tok_3ds' ? 'requires_action' : 'accepted';
      const i: FakeIntent = { id: newId(), key, input, state, methodLabel: label(input.method), decline: state === 'failed' ? decline : null, orderId: null };
      intents.set(i.id, i);
      byKey.set(key, i.id);
      return result(i);
    },
    completeAction: async (intentId, resultToken) => {
      calls.completeAction.push(resultToken);
      const i = intents.get(intentId);
      if (!i) throw new AppError('NOT_FOUND', 'Payment not found');
      if (i.state === 'requires_action') {
        i.state = resultToken === 'fail' ? 'failed' : 'accepted';
        i.decline = i.state === 'failed' ? decline : null;
      }
      return result(i);
    },
    linkOrder: async (intentId, orderId, allocations) => {
      calls.linkOrder.push({ intentId, orderId, allocations });
      const i = intents.get(intentId);
      if (i) i.orderId = orderId;
    },
    voidIntent: async (intentId) => {
      calls.voidIntent.push(intentId);
    },
    getIntentStatus: async (intentId) => {
      const i = intents.get(intentId);
      if (!i) throw new AppError('NOT_FOUND', 'Payment not found');
      const state = i.state === 'pending_check' ? 'pending' : i.state;
      return {
        intentId: i.id,
        checkoutSessionId: i.input.checkoutSessionId,
        state,
        title: state === 'accepted' ? 'Payment accepted' : state === 'pending' ? 'Payment being checked' : state === 'failed' ? 'Payment declined' : 'Confirm with your bank',
        message: state === 'pending' ? "We're confirming your payment with your bank. Don't pay again." : state === 'failed' ? (i.decline?.message ?? 'Your bank declined the payment.') : 'Done',
        methodLabel: i.methodLabel,
        amount: i.input.amount,
        orderId: i.orderId,
        orderRef: null,
        lastCheckedAt: clock.now().toISOString(),
        nextCheckInSeconds: state === 'pending' ? 60 : null,
        decline: i.decline,
        retryAllowed: state === 'failed',
        holdNote: null,
        nextAction: state === 'requires_action' ? { kind: 'three_ds_challenge', url: 'https://bank.example.com/3ds', clientSecret: 'cs_1' } : null,
      };
    },
  };
  return { api, intents, calls };
}

/* ================================================================ shipping stub */

export function fakeShipping(clock: { now(): Date }) {
  const knobs = { shiftDays: 0, standardPrice: 599, calls: { quoteOptions: 0, checkCoverage: 0 } };
  const day = (n: number) => new Date(clock.now().getTime() + (n + knobs.shiftDays) * 86_400_000).toISOString().slice(0, 10);
  const api: Partial<shipping.ShippingPublicApi> = {
    // offers validates a seller's shipping profile through quote(); every profile id quotes in these tests
    quote: async () => ({ shipsToLocation: true, reason: null, options: [], default: null }),
    checkCoverage: async (profileIds, destination) => {
      knobs.calls.checkCoverage++;
      return profileIds.map((profileId) =>
        destination.region === 'AK' ? { profileId, shippable: false, reason: 'outside_seller_coverage', message: "The seller doesn't ship to Alaska." } : { profileId, shippable: true, reason: null, message: null },
      );
    },
    quoteOptions: async (input) => {
      knobs.calls.quoteOptions++;
      if (input.destination.region === 'AK') return { shipsToLocation: false, notShippableLineIds: input.items.map((i) => i.lineId), reason: "The seller doesn't ship to Alaska.", options: [], default: null };
      const value = input.items.reduce((s, i) => s + i.value.amount, 0);
      const free = value >= 5000;
      const dispatchBy = new Date(clock.now().getTime() + 86_400_000).toISOString();
      const std: shipping.DeliveryOption = {
        id: `std:${input.shipsFrom}`,
        methodCode: 'standard',
        methodName: 'Standard',
        carrierService: 'UPS Ground',
        price: USD(knobs.standardPrice),
        free,
        fundedBy: free ? 'seller' : 'customer',
        freeReason: free ? 'Free over $50' : null,
        arrival: { from: day(4), to: day(6) },
        arrivalLabel: `Arrives ${day(4)} – ${day(6)}`,
        dispatchBy,
        dispatchLabel: `Ships tomorrow from ${input.shipsFrom}`,
        cutoffAt: null,
        notices: knobs.shiftDays ? ['Carrier delays in your area'] : [],
        isDefault: true,
      };
      const exp: shipping.DeliveryOption = { ...std, id: `exp:${input.shipsFrom}`, methodCode: 'express', methodName: 'Express', carrierService: 'UPS 2nd Day Air', price: USD(1499), free: false, fundedBy: 'customer', freeReason: null, arrival: { from: day(2), to: day(2) }, arrivalLabel: `Arrives ${day(2)}`, isDefault: false };
      return { shipsToLocation: true, notShippableLineIds: [], reason: null, options: [std, exp], default: std };
    },
  };
  return { api, knobs };
}

/* ================================================================ the world */

export interface World {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  f: Flows;
  pay: ReturnType<typeof fakePayments>;
  ship: ReturnType<typeof fakeShipping>;
  events: EventEnvelope[];
  owner: Staff;
  sellerId: string;
  sellerToken: string;
  productId: string;
  offers: { black: string; white: string; officialWhite: string };
  stock: { black: string; white: string; officialWhite: string };
  service: CheckoutService;
  call(method: string, url: string, token?: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  named(name: string): any[];
  api<T = any>(module: string): T;
  customer(email: string): Promise<{ token: string; accountId: string; customerId: string; email: string }>;
  /** Sid of a token (the visitor session of a visitor token) */
  sid(token: string): string;
}

export async function world(): Promise<World> {
  const clock = movingClock();
  const pay = fakePayments(clock);
  const ship = fakeShipping(clock);
  const app = await buildTestApp({
    only: withDependencies(['identity', 'access', 'audit', 'media', 'notifications', 'settings', 'customers', 'sellers', 'catalog', 'inventory', 'offers', 'cart', 'orders', 'promotions', 'content', 'checkout']),
    clock,
    config: { rateLimits: false },
    apiStubs: { payments: pay.api, shipping: ship.api },
  });
  const f = flows(app, clock);
  const events: EventEnvelope[] = [];
  for (const name of ['checkout.session.started', 'checkout.changes.detected', 'checkout.changes.accepted', 'checkout.payment.retried', 'checkout.session.completed', 'checkout.session.abandoned', 'orders.order.placed', 'orders.order.accepted', 'orders.order.cancelled', 'inventory.reservation.allocated']) {
    app.kernel.events.subscribe('checkout-test', name, (e) => void events.push(e));
  }

  const owner = await f.bootstrapOwner();
  const sellerManager = await f.staffWithRoles(owner, 'sam@marketly.test', 'Sam Sellers', ['seller_manager']);
  const catalogManager = await f.staffWithRoles(owner, 'cat@marketly.test', 'Cara Catalog', ['catalog_manager']);
  const catalogToken = catalogManager.accessToken;
  const category = await f.call('POST', '/api/admin/catalog/categories', { token: catalogToken, body: { name: 'Headphones', parentId: null } });
  expect(category.status, JSON.stringify(category.body)).toBe(201);
  const brand = await f.call('POST', '/api/admin/catalog/brands', { token: catalogToken, body: { name: 'Aurora Sound' } });
  expect(brand.status, JSON.stringify(brand.body)).toBe(201);
  const applicant = await f.customer('nora@example.com');
  const seller = await f.approvedSeller({ applicant, sellerManager, categoryId: category.body.id, storeName: 'Northwind Audio' });
  const imageId = await f.upload('seller', seller.sellerToken, { purpose: 'product_image', fileName: 'front.png', contentType: 'image/png', body: png(1600, 1600) });
  const draft = await f.call('POST', '/api/seller/catalog/products', {
    token: seller.sellerToken,
    body: {
      title: 'Aurora wireless headphones',
      brandId: brand.body.brand.id,
      categoryId: category.body.id,
      description: 'Over-ear headphones with active noise cancelling and a 40 hour battery that charges over USB-C.',
      keyFeatures: ['Active noise cancelling', '40 h battery', 'USB-C charging'],
      specs: { 'Battery life': '40 h' },
      includedItems: ['Headphones', 'USB-C cable'],
      imageIds: [imageId],
      modelNumber: 'AU-100',
      variants: [
        { options: { Color: 'Black' }, gtin: '4006381333931' },
        { options: { Color: 'White' }, gtin: '5901234123457' },
      ],
    },
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const productId = draft.body.product.id as string;
  const [black, white] = draft.body.product.variants as { id: string; options: Record<string, string> }[];
  expect((await f.call('POST', `/api/seller/catalog/products/${productId}/submit`, { token: seller.sellerToken, body: { note: 'First submission' } })).status).toBe(200);
  await f.passLaunchReview({ ...seller, sellerManager });

  const offerFor = async (variantId: string, price: number, sku: string) => {
    const r = await f.call('POST', '/api/seller/offers/offers', {
      token: seller.sellerToken,
      body: { productId, variantId, condition: 'new', price: USD(price), sellerSku: sku, quantity: 40, dispatchBusinessDays: 1, shippingProfileId: newId(), returnTerms: { kind: 'baseline' }, warranty: { kind: 'manufacturer', months: 24 }, publish: true },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.offer as { id: string; stockItemId: string };
  };
  const ob = await offerFor(black!.id, 18900, 'NW-AU-100-BK');
  const ow = await offerFor(white!.id, 2500, 'NW-AU-100-WH');
  const approved = await f.call('POST', `/api/admin/catalog/products/${productId}/approve`, { token: catalogToken, body: {} });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  await app.kernel.events.drain();

  // the Official Store sells the white variant too (company stock received through inventory's public API)
  const location = await f.call('POST', '/api/admin/inventory/locations', {
    token: callers.staff(),
    body: { code: 'RNO-1', name: 'Reno warehouse', address: { name: 'Marketly', line1: '100 Logistics Way', city: 'Reno', region: 'NV', postalCode: '89502', country: 'US' }, timeZone: 'America/Los_Angeles', sellable: true, active: true },
  });
  expect(location.status, JSON.stringify(location.body)).toBe(201);
  const officialStock = await (app.kernel.boot.apis.get('inventory') as any).createStockItem({ ownerType: 'official', sku: 'HAL-AU-100-WH', productId, variantId: white!.id, condition: 'new', label: 'Aurora headphones, White', initialAvailable: 30 });
  const official = await f.call('POST', '/api/admin/offers/official/offers', {
    token: callers.staff(),
    body: { productId, variantId: white!.id, condition: 'new', price: USD(2300), purchaseLimit: 3, sku: 'HAL-AU-100-WH', stockItemId: officialStock.id, dispatchBusinessDays: 0, shippingProfileId: newId(), returnTerms: { kind: 'baseline' }, warranty: { kind: 'manufacturer', months: 24 }, publish: true },
  });
  expect(official.status, JSON.stringify(official.body)).toBe(201);
  await app.kernel.events.drain();

  const w: World = {
    app,
    clock,
    f,
    pay,
    ship,
    events,
    owner,
    sellerId: seller.sellerId,
    sellerToken: seller.sellerToken,
    productId,
    offers: { black: ob.id, white: ow.id, officialWhite: official.body.offer.id },
    stock: { black: ob.stockItemId, white: ow.stockItemId, officialWhite: officialStock.id },
    service: app.kernel.boot.apis.get('checkout') as CheckoutService,
    async call(method, url, token, body, headers) {
      const res = await app.inject({ method: method as never, url, headers: { ...(token ? auth(token) : {}), ...headers }, ...(body !== undefined ? { payload: body as never } : {}) });
      await app.kernel.events.drain();
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    },
    named: (name) => events.filter((e) => e.name === name).map((e) => e.payload),
    api: (module) => app.kernel.boot.apis.get(module) as never,
    async customer(email) {
      const c = await f.customer(email);
      const snap = await (app.kernel.boot.apis.get('customers') as any).getCustomerByUserId(c.accountId);
      return { token: c.accessToken, accountId: c.accountId, customerId: snap.id, email };
    },
    sid: (token) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')).sid,
  };
  return w;
}

/** Adds offers to the shopper's cart */
export async function fillCart(w: World, token: string, lines: { offerId: string; quantity: number }[]) {
  for (const l of lines) {
    const r = await w.call('POST', '/api/store/cart/cart/items', token, l);
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  }
}

/** Starts a checkout and takes it to a ready-to-place state (address, default delivery, a card) */
export async function readyCheckout(w: World, token: string, start: Record<string, unknown>, o: { address?: object; card?: string } = {}) {
  const started = await w.call('POST', `${STORE}/sessions`, token, start);
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const id = started.body.id as string;
  if (!started.body.account) {
    const c = await w.call('PUT', `${STORE}/sessions/${id}/contact`, token, { email: `guest-${id.slice(-6)}@example.com`, phone: '+15035550123', createAccountAfter: true });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
  }
  const a = await w.call('PUT', `${STORE}/sessions/${id}/address`, token, { address: o.address ?? PORTLAND });
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  const p = await w.call('PUT', `${STORE}/sessions/${id}/payment-method`, token, { kind: 'new_card', providerToken: o.card ?? 'tok_visa', label: 'Mastercard •••• 4444' });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  return p.body as any;
}

export const placeBody = (view: { quoteVersion: number; totals: { total: { amount: number; currency: string } } }, over: Record<string, unknown> = {}) => ({
  quoteVersion: view.quoteVersion,
  expectedTotal: view.totals.total,
  acceptTerms: true,
  channel: 'web',
  returnUrl: 'https://store.marketly.test/checkout/return',
  ...over,
});

export const key = () => `key-${newId()}`;
