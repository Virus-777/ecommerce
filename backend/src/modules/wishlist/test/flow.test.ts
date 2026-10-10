/**
 * Wishlist with real modules (no stubs, no development tokens for shoppers): a seller with a live offer,
 * customers who save it, lists, sharing, alerts that fire when the seller lowers the price or restocks,
 * notifications that deliver them under the customer's wishlist-alert consent, move to cart and GraphQL.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { allSpecs, withDependencies } from '../../../kernel/module-system/loader.js';
import { persistedQueries } from '../../../spec/graphql.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';
import { flows, type Flows, type Listing } from '../../../testing/flows.js';
import type { WishlistService } from '../service.js';

const clock = movingClock();
const launchModules = Object.values(allSpecs)
  .filter((s) => s.phase <= 2)
  .map((s) => s.name);
let app: FastifyInstance;
let f: Flows;
let listing: Listing;
let service: WishlistService;
const events: EventEnvelope[] = [];
const named = (name: string) => events.filter((e) => e.name === name).map((e) => e.payload as any);

type Customer = Awaited<ReturnType<Flows['customer']>>;
let bea: Customer; // allows wishlist alerts
let carl: Customer; // does not
const S = '/api/store/wishlist';
const usd = (amount: number) => ({ amount, currency: 'USD' });

beforeAll(async () => {
  tokenClock.now = () => clock.now(); // staff dev tokens stay valid when the clock moves past the alert cooldown
  tokenClock.ttlSeconds = 3 * 86_400;
  // every launch module plus wishlist: the persisted store screens select fields of many modules
  app = await buildTestApp({ only: withDependencies([...launchModules, 'wishlist']), clock, config: { rateLimits: false, launchPhase: 4 } });
  f = flows(app, clock);
  service = app.kernel.boot.apis.get('wishlist') as WishlistService;
  for (const name of ['wishlist.item.saved', 'wishlist.item.removed', 'wishlist.alert.triggered']) app.kernel.events.subscribe('test', name, (e) => void events.push(e));
  listing = await f.liveListing({ price: 18900, quantity: 5 });
  bea = await f.customer('bea@example.com');
  carl = await f.customer('carl@example.com');
  const on = await f.call('PUT', '/api/store/customers/marketing-preferences', { token: bea.accessToken, body: { wishlistAlerts: true } });
  expect(on.status, JSON.stringify(on.body)).toBe(200);
  expect(on.body.wishlistAlerts).toBe(true);
}, 120_000);
afterAll(async () => {
  tokenClock.now = undefined;
  tokenClock.ttlSeconds = 900;
  await app?.close();
});

let beaItemId: string;
let carlItemId: string;

describe('saving products', () => {
  it('saves the offer with a price-drop alert and shows it with live price, seller, stock and a price hint', async () => {
    const res = await f.call('POST', `${S}/items`, { token: bea.accessToken, body: { productId: listing.productId, offerId: listing.offerId, priceDropAlert: true, note: 'For the trip' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      productId: listing.productId,
      variantId: listing.variantId,
      offerId: listing.offerId,
      title: 'Aurora wireless headphones',
      options: { Color: 'Black' },
      sellerName: 'Northwind Audio',
      officialStore: false,
      price: usd(18900),
      priceWhenSaved: usd(18900),
      availability: 'in_stock',
      alerts: { priceDrop: true, backInStock: false },
      canMoveToCart: true,
      note: 'For the trip',
    });
    expect(['unchanged', 'lowest_in_window']).toContain(res.body.priceHint.kind);
    expect(res.body.priceHint.windowDays).toBe(30);
    beaItemId = res.body.id;
    expect(named('wishlist.item.saved')).toContainEqual({ customerId: expect.any(String), productId: listing.productId, variantId: listing.variantId });

    const again = await f.call('POST', `${S}/items`, { token: bea.accessToken, body: { productId: listing.productId, variantId: listing.variantId } });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(beaItemId); // the same product and variant twice is one item
    expect(named('wishlist.item.saved')).toHaveLength(1);

    const carlSave = await f.call('POST', `${S}/items`, { token: carl.accessToken, body: { productId: listing.productId, offerId: listing.offerId, priceDropAlert: true } });
    expect(carlSave.status, JSON.stringify(carlSave.body)).toBe(201);
    carlItemId = carlSave.body.id;
  });

  it('answers heart icons and the wishlist page', async () => {
    const other = newId();
    const saved = await f.call('GET', `${S}/saved?productIds=${listing.productId},${other},not-an-id`, { token: bea.accessToken });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toEqual({ [listing.productId]: true, [other]: false, 'not-an-id': false });

    const page = await f.call('GET', `${S}/wishlist`, { token: bea.accessToken });
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.list).toMatchObject({ name: 'Wishlist', isDefault: true, itemCount: 1, shared: false });
    expect(page.body.lists).toHaveLength(1);
    expect(page.body.items.map((i: any) => i.id)).toEqual([beaItemId]);
    expect(page.body.alerts).toHaveLength(1);
    expect(page.body.alerts[0]).toMatchObject({ kind: 'price_drop', state: 'active', itemId: beaItemId, referencePrice: usd(18900), condition: 'Any drop below $189.00, from Northwind Audio', title: 'Aurora wireless headphones' });
    expect(page.body).toMatchObject({ alertsEnabledByPreference: true, deliveryNote: expect.stringContaining('Alerts arrive as notifications') });

    const carlPage = await f.call('GET', `${S}/wishlist`, { token: carl.accessToken });
    expect(carlPage.body.alertsEnabledByPreference).toBe(false);
    expect(carlPage.body.items.map((i: any) => i.id)).toEqual([carlItemId]);
  });

  it("keeps each customer's items, lists and alerts their own (others get 404)", async () => {
    const alertId = (await f.call('GET', `${S}/alerts`, { token: bea.accessToken })).body.items[0].id;
    const listId = (await f.call('GET', `${S}/lists`, { token: bea.accessToken })).body[0].id;
    for (const [method, url, body] of [
      ['DELETE', `${S}/items/${beaItemId}`, undefined],
      ['PUT', `${S}/items/${beaItemId}/alerts`, { priceDrop: false, backInStock: false }],
      ['POST', `${S}/items/${beaItemId}/move-to-cart`, { quantity: 1 }],
      ['POST', `${S}/alerts/${alertId}/transition`, { action: 'pause' }],
      ['DELETE', `${S}/alerts/${alertId}`, undefined],
      ['GET', `${S}/lists/${listId}/items`, undefined],
      ['PATCH', `${S}/lists/${listId}`, { name: 'Mine now' }],
      ['POST', `${S}/lists/${listId}/share`, { enabled: true }],
    ] as const) {
      const res = await f.call(method, url, { token: carl.accessToken, body });
      expect(res.status, `${method} ${url}: ${JSON.stringify(res.body)}`).toBe(404);
    }
    const mine = await f.call('GET', `${S}/wishlist`, { token: bea.accessToken });
    expect(mine.body.items).toHaveLength(1);
  });

  it('validates what is saved', async () => {
    const unknown = await f.call('POST', `${S}/items`, { token: bea.accessToken, body: { productId: newId() } });
    expect(unknown.status).toBe(404);
    const wrongVariant = await f.call('POST', `${S}/items`, { token: bea.accessToken, body: { productId: listing.productId, variantId: newId() } });
    expect(wrongVariant.status).toBe(400);
    expect(wrongVariant.body.error.details.issues[0].path).toBe('variantId');
  });
});

describe('lists', () => {
  it('creates, renames, moves items between and deletes named lists; the default list stays', async () => {
    const created = await f.call('POST', `${S}/lists`, { token: bea.accessToken, body: { name: '  Gift ideas ' } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ name: 'Gift ideas', isDefault: false, itemCount: 0, shared: false });
    const renamed = await f.call('PATCH', `${S}/lists/${created.body.id}`, { token: bea.accessToken, body: { name: 'Birthday' } });
    expect(renamed.body.name).toBe('Birthday');
    expect((await f.call('POST', `${S}/lists`, { token: bea.accessToken, body: { name: '   ' } })).status).toBe(400);

    const moved = await f.call('POST', `${S}/items/${beaItemId}/move`, { token: bea.accessToken, body: { listId: created.body.id } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ id: beaItemId, listId: created.body.id, alerts: { priceDrop: true } });
    const lists = (await f.call('GET', `${S}/lists`, { token: bea.accessToken })).body;
    expect(lists.map((l: any) => [l.name, l.itemCount])).toEqual([
      ['Wishlist', 0],
      ['Birthday', 1],
    ]);
    const items = await f.call('GET', `${S}/lists/${created.body.id}/items?sort=price`, { token: bea.accessToken });
    expect(items.body.items.map((i: any) => i.id)).toEqual([beaItemId]);

    const back = await f.call('POST', `${S}/items/${beaItemId}/move`, { token: bea.accessToken, body: { listId: lists[0].id } });
    expect(back.body.listId).toBe(lists[0].id);
    expect((await f.call('DELETE', `${S}/lists/${lists[0].id}`, { token: bea.accessToken })).status).toBe(409); // ILLEGAL_TRANSITION
    expect((await f.call('DELETE', `${S}/lists/${created.body.id}`, { token: bea.accessToken })).status).toBe(204);
    expect((await f.call('GET', `${S}/lists`, { token: bea.accessToken })).body).toHaveLength(1);
  });

  it('stops at maxLists', async () => {
    const dana = await f.customer('dana@example.com');
    for (let i = 1; i < 10; i++) expect((await f.call('POST', `${S}/lists`, { token: dana.accessToken, body: { name: `List ${i}` } })).status).toBe(201);
    const over = await f.call('POST', `${S}/lists`, { token: dana.accessToken, body: { name: 'One too many' } });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('LIST_LIMIT_REACHED');
  });

  it('shares a list read-only by a signed link and revokes it', async () => {
    const listId = (await f.call('GET', `${S}/lists`, { token: bea.accessToken })).body[0].id;
    const shared = await f.call('POST', `${S}/lists/${listId}/share`, { token: bea.accessToken, body: { enabled: true } });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    expect(shared.body.shared).toBe(true);
    const token = shared.body.shareUrl.split('/wishlist/shared/')[1];
    expect(token).toMatch(/^[\w-]+\.[\w-]+$/);

    const visitor = await f.visitor();
    const view = await f.call('GET', `${S}/shared/${token}`, { token: visitor });
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body).toMatchObject({ name: 'Wishlist', ownerFirstName: 'Ana' });
    expect(view.body.items[0]).toMatchObject({ id: beaItemId, price: usd(18900), note: null, priceWhenSaved: null, alerts: { priceDrop: false, backInStock: false }, canMoveToCart: false, priceHint: { kind: 'none' } });

    const forged = token.replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A'));
    expect((await f.call('GET', `${S}/shared/${forged}`, { token: visitor })).status).toBe(404);
    await f.call('POST', `${S}/lists/${listId}/share`, { token: bea.accessToken, body: { enabled: false } });
    expect((await f.call('GET', `${S}/shared/${token}`, { token: visitor })).status).toBe(404);
  });
});

describe('alerts', () => {
  it('notifies a consenting customer when the seller lowers the price, and pauses the alert of one who opted out', async () => {
    events.length = 0;
    const drop = await f.call('POST', '/api/seller/offers/price-changes', { token: listing.sellerToken, body: { items: [{ offerId: listing.offerId, price: usd(15900) }] } });
    expect(drop.status, JSON.stringify(drop.body)).toBeLessThan(300);
    await app.kernel.events.drain();

    const fired = named('wishlist.alert.triggered');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ kind: 'price_drop', productId: listing.productId, offerId: listing.offerId, price: usd(15900), previousPrice: usd(18900) });

    const inbox = await f.call('GET', '/api/store/notifications/inbox?group=promotions', { token: bea.accessToken });
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    expect(inbox.body.items[0]).toMatchObject({ topicKey: 'customer.wishlist.alert', category: 'promotional' });

    const beaAlerts = (await f.call('GET', `${S}/alerts`, { token: bea.accessToken })).body.items;
    expect(beaAlerts[0]).toMatchObject({ state: 'triggered', triggeredPrice: usd(15900) });
    const carlAlerts = (await f.call('GET', `${S}/alerts`, { token: carl.accessToken })).body.items;
    expect(carlAlerts[0]).toMatchObject({ state: 'paused', pausedReason: 'Wishlist alerts are off in your notification preferences' });
    expect((await f.call('GET', '/api/store/notifications/inbox?group=promotions', { token: carl.accessToken })).body.items).toHaveLength(0);

    const item = (await f.call('GET', `${S}/wishlist`, { token: bea.accessToken })).body.items[0];
    expect(item).toMatchObject({ price: usd(15900), priceWhenSaved: usd(18900), priceHint: { kind: 'lowest_in_window', label: 'Lowest in 30 days' } });
  });

  it('sends no second notice for the same drop or inside the cooldown, then rearms at the notified price', async () => {
    events.length = 0;
    await f.call('POST', '/api/seller/offers/price-changes', { token: listing.sellerToken, body: { items: [{ offerId: listing.offerId, price: usd(15000) }] } });
    await app.kernel.events.drain();
    await app.kernel.jobs.runNow('wishlist.evaluate-alerts');
    await app.kernel.events.drain();
    expect(named('wishlist.alert.triggered')).toHaveLength(0); // triggered, and inside the 24 h cooldown

    clock.advance(25 * 3_600_000);
    await app.kernel.jobs.runNow('wishlist.evaluate-alerts');
    await app.kernel.events.drain();
    const fired = named('wishlist.alert.triggered');
    expect(fired).toHaveLength(1); // rearmed with $159.00 as the reference, and $150.00 is below it
    expect(fired[0]).toMatchObject({ price: usd(15000), previousPrice: usd(15900) });

    // tokens issued before the clock moved have expired: sign in again
    bea = { ...bea, accessToken: (await f.signIn({ email: bea.email, password: bea.password, audience: 'store' })).body.tokens.accessToken };
    carl = { ...carl, accessToken: (await f.signIn({ email: carl.email, password: carl.password, audience: 'store' })).body.tokens.accessToken };
    const seller = await f.signIn({ email: listing.sellerOwner.email, password: listing.sellerOwner.password, audience: 'seller', sellerId: listing.sellerId });
    listing = { ...listing, sellerToken: seller.body.tokens.accessToken };
  });

  it("brings alerts paused by preferences back when the customer turns wishlist alerts on", async () => {
    await f.call('PUT', '/api/store/customers/marketing-preferences', { token: carl.accessToken, body: { wishlistAlerts: true } });
    const page = await f.call('GET', `${S}/wishlist`, { token: carl.accessToken });
    expect(page.body.alertsEnabledByPreference).toBe(true);
    expect(page.body.alerts[0]).toMatchObject({ state: 'active', pausedReason: null });
  });

  it('pauses, resumes, rearms and removes alerts through the state machine', async () => {
    const alert = (await f.call('GET', `${S}/alerts`, { token: bea.accessToken })).body.items[0];
    expect(alert.state).toBe('triggered');
    const pause = await f.call('POST', `${S}/alerts/${alert.id}/transition`, { token: bea.accessToken, body: { action: 'pause' } });
    expect(pause.status).toBe(409); // triggered → pause is not a transition
    expect(pause.body.error.code).toBe('ILLEGAL_TRANSITION');
    const rearm = await f.call('POST', `${S}/alerts/${alert.id}/transition`, { token: bea.accessToken, body: { action: 'rearm' } });
    expect(rearm.body).toMatchObject({ state: 'active', referencePrice: usd(15000) });
    const paused = await f.call('POST', `${S}/alerts/${alert.id}/transition`, { token: bea.accessToken, body: { action: 'pause' } });
    expect(paused.body).toMatchObject({ state: 'paused', pausedReason: 'Paused by you' });
    expect((await f.call('GET', `${S}/alerts?state=paused`, { token: bea.accessToken })).body.items.map((a: any) => a.id)).toEqual([alert.id]);
    const resumed = await f.call('POST', `${S}/alerts/${alert.id}/transition`, { token: bea.accessToken, body: { action: 'resume' } });
    expect(resumed.body).toMatchObject({ state: 'active', pausedReason: null });
    expect((await f.call('DELETE', `${S}/alerts/${alert.id}`, { token: bea.accessToken })).status).toBe(204);
    expect((await f.call('GET', `${S}/alerts`, { token: bea.accessToken })).body.items).toHaveLength(0);
    const item = (await f.call('GET', `${S}/wishlist`, { token: bea.accessToken })).body.items[0];
    expect(item.alerts).toEqual({ priceDrop: false, backInStock: false });
  });

  it('turns item alerts on and off and creates alerts for products that are not saved', async () => {
    const on = await f.call('PUT', `${S}/items/${beaItemId}/alerts`, { token: bea.accessToken, body: { priceDrop: true, backInStock: true } });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.alerts).toEqual({ priceDrop: true, backInStock: true });
    const off = await f.call('PUT', `${S}/items/${beaItemId}/alerts`, { token: bea.accessToken, body: { priceDrop: false, backInStock: true } });
    expect(off.body.alerts).toEqual({ priceDrop: false, backInStock: true });

    const eve = await f.customer('eve@example.com');
    const target = await f.call('POST', `${S}/alerts`, { token: eve.accessToken, body: { productId: listing.productId, kind: 'price_drop', targetPrice: usd(12000) } });
    expect(target.status, JSON.stringify(target.body)).toBe(201);
    expect(target.body).toMatchObject({ itemId: null, kind: 'price_drop', state: 'active', targetPrice: usd(12000), condition: 'At or below $120.00' });
    const same = await f.call('POST', `${S}/alerts`, { token: eve.accessToken, body: { productId: listing.productId, kind: 'price_drop', targetPrice: usd(11000) } });
    expect(same.body).toMatchObject({ id: target.body.id, targetPrice: usd(11000) });
    const wrong = await f.call('POST', `${S}/alerts`, { token: eve.accessToken, body: { productId: listing.productId, kind: 'back_in_stock', targetPrice: usd(100) } });
    expect(wrong.status).toBe(400);
  });

  it('notifies back in stock when the seller restocks, once', async () => {
    const stock = await f.call('GET', '/api/seller/inventory/stock-items', { token: listing.sellerToken });
    const stockItemId = JSON.stringify(stock.body).match(/"(?:id|stockItemId)":"([0-9a-f-]{36})"/)?.[1];
    expect(stockItemId).toBeDefined();
    const zero = await f.call('POST', `/api/seller/inventory/stock-items/${stockItemId}/adjustments`, { token: listing.sellerToken, body: { newAvailable: 0, reasonCode: 'moved_to_another_channel', note: 'Sold elsewhere' } });
    expect(zero.status, JSON.stringify(zero.body)).toBeLessThan(300);
    await app.kernel.events.drain();
    const out = (await f.call('GET', `${S}/wishlist`, { token: bea.accessToken })).body.items[0];
    expect(out).toMatchObject({ availability: 'out_of_stock', canMoveToCart: false });

    events.length = 0;
    const back = await f.call('POST', `/api/seller/inventory/stock-items/${stockItemId}/adjustments`, { token: listing.sellerToken, body: { newAvailable: 4, reasonCode: 'received_stock', note: 'Delivery arrived' } });
    expect(back.status, JSON.stringify(back.body)).toBeLessThan(300);
    await app.kernel.events.drain();
    const fired = named('wishlist.alert.triggered').filter((e) => e.kind === 'back_in_stock');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ productId: listing.productId, offerId: listing.offerId });
    const alerts = (await f.call('GET', `${S}/alerts?state=triggered`, { token: bea.accessToken })).body.items;
    expect(alerts.map((a: any) => a.kind)).toEqual(['back_in_stock']); // stays triggered until rearmed
  });
});

describe('move to cart', () => {
  it('adds the saved offer to the cart (created when the customer has none) and keeps or removes the item', async () => {
    const added: any[] = [];
    app.kernel.events.subscribe('test', 'cart.item.added', (e) => void added.push(e.payload));
    expect((await f.call('GET', '/api/store/cart/cart', { token: carl.accessToken })).body.itemCount).toBe(0);
    const moved = await f.call('POST', `${S}/items/${carlItemId}/move-to-cart`, { token: carl.accessToken, body: { quantity: 2 } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ cartLineId: expect.any(String), cartItemCount: 2, item: { id: carlItemId } });
    const cart = (await f.call('GET', '/api/store/cart/cart', { token: carl.accessToken })).body;
    const line = cart.packages.flatMap((p: any) => p.items).find((i: any) => i.offerId === listing.offerId);
    expect(line).toMatchObject({ id: moved.body.cartLineId, quantity: 2 });
    expect(added.at(-1)).toMatchObject({ itemId: moved.body.cartLineId, offerId: listing.offerId, quantity: 2, ownerKind: 'customer' });

    // the same offer again: the cart line grows, as with Add to cart
    events.length = 0;
    const removed = await f.call('POST', `${S}/items/${carlItemId}/move-to-cart`, { token: carl.accessToken, body: { quantity: 1, removeFromList: true } });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ cartLineId: moved.body.cartLineId, cartItemCount: 3, item: null });
    expect(named('wishlist.item.removed')).toHaveLength(1);
    expect((await f.call('GET', `${S}/wishlist`, { token: carl.accessToken })).body.items).toHaveLength(0);
  });

  it('refuses an amount above what is available', async () => {
    const res = await f.call('POST', `${S}/items/${beaItemId}/move-to-cart`, { token: bea.accessToken, body: { quantity: 50 } });
    expect(res.status).toBe(400);
  });
});

describe('GraphQL', () => {
  it('runs the persisted ProductPage query with Product.saved', async () => {
    const [id] = Object.entries(persistedQueries.store).find(([, q]) => q.name === 'ProductPage')!;
    expect(app.kernel.unusableQueries.filter((q) => q.name === 'ProductPage').flatMap((q) => q.errors)).toEqual([]);
    const res = await app.inject({ method: 'POST', url: '/graphql/store', payload: { persisted: true, query: id, variables: { id: listing.productId } }, headers: auth(bea.accessToken) });
    expect(res.json().errors, res.body).toBeUndefined();
    expect(res.json().data.product.saved).toBe(true);
    const guest = await app.inject({ method: 'POST', url: '/graphql/store', payload: { persisted: true, query: id, variables: { id: listing.productId } }, headers: auth(await f.visitor()) });
    expect(guest.json().errors, guest.body).toBeUndefined();
    expect(guest.json().data.product.saved).toBeNull();
  });

  it("reads the customer's wishlist, lists and alerts", async () => {
    const query = `{ me { wishlist { total items { id list { name } product { id title } variant { id options { name value } } offer { id sellerName price { formatted } status }
      priceWhenSaved { amount formatted } priceHint { kind label } alerts { priceDrop backInStock } canMoveToCart addedAt } }
      wishlistLists { name itemCount shared } wishlistAlerts { kind state condition product { title } seller { id storeName } } } }`;
    const res = await app.inject({ method: 'POST', url: '/graphql/store', payload: { query }, headers: auth(bea.accessToken) });
    expect(res.json().errors, res.body).toBeUndefined();
    const me = res.json().data.me;
    expect(me.wishlist.total).toBe(1);
    expect(me.wishlist.items[0]).toMatchObject({ id: beaItemId, list: { name: 'Wishlist' }, product: { id: listing.productId }, offer: { id: listing.offerId, sellerName: 'Northwind Audio', status: 'ACTIVE' }, priceWhenSaved: { formatted: '$189.00' } });
    expect(me.wishlistLists).toEqual([{ name: 'Wishlist', itemCount: 1, shared: false }]);
    expect(me.wishlistAlerts.map((a: any) => a.kind)).toEqual(['BACK_IN_STOCK']);
  });
});

describe('aggregates, catalog changes and offers closing', () => {
  it('gives staff aggregate insights and other modules the saved count', async () => {
    const res = await f.call('GET', '/api/admin/wishlist/insights', { token: callers.staff(['wishlist.insights.view']) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items[0]).toMatchObject({ productId: listing.productId, title: 'Aurora wireless headphones', saves: 1, outOfStock: false });
    expect(Object.keys(res.body.items[0]).sort()).toEqual(['activePriceAlerts', 'activeStockAlerts', 'outOfStock', 'productId', 'saves', 'title']);
    const inCategory = await f.call('GET', `/api/admin/wishlist/insights?categoryId=${listing.categoryId}`, { token: callers.staff(['wishlist.insights.view']) });
    expect(inCategory.body.items.map((i: any) => i.productId)).toEqual([listing.productId]);
    const elsewhere = await f.call('GET', `/api/admin/wishlist/insights?categoryId=${newId()}`, { token: callers.staff(['wishlist.insights.view']) });
    expect(elsewhere.body.items).toEqual([]);
    expect(await service.savedCount(listing.productId)).toBe(1);
    expect(await service.isSaved(newId(), [listing.productId])).toEqual({ [listing.productId]: false });
  });

  it('pauses alerts while a product is suspended and resumes them when it is active again', async () => {
    const eveAlerts = async () => (await f.call('GET', `${S}/alerts`, { token: (await f.signIn({ email: 'eve@example.com', password: bea.password, audience: 'store' })).body.tokens.accessToken })).body.items;
    app.kernel.events.publish('catalog', 'catalog.product.publication_changed', { productId: listing.productId, from: 'active', to: 'suspended', reason: 'Report', trustReportId: null });
    await app.kernel.events.drain();
    expect((await eveAlerts())[0]).toMatchObject({ state: 'paused', pausedReason: 'This product is not available right now' });
    app.kernel.events.publish('catalog', 'catalog.product.publication_changed', { productId: listing.productId, from: 'suspended', to: 'active', reason: 'Cleared', trustReportId: null });
    await app.kernel.events.drain();
    expect((await eveAlerts())[0]).toMatchObject({ state: 'active' });
  });

  it('clears saved offers that close and moves items and alerts of a merged product', async () => {
    app.kernel.events.publish('offers', 'offers.offer.status_changed', { offerId: listing.offerId, productId: listing.productId, variantId: listing.variantId, sellerId: listing.sellerId, ownerType: 'seller', from: 'active', to: 'removed', stockItemId: ((await (app.kernel.boot.apis.get('offers') as any).getOffer(listing.offerId)) as { stockItemId: string }).stockItemId });
    await app.kernel.events.drain();
    const res = await app.inject({ method: 'POST', url: '/graphql/store', payload: { query: '{ me { wishlist { items { id offer { id } } } } }' }, headers: auth(bea.accessToken) });
    expect(res.json().data.me.wishlist.items).toEqual([{ id: beaItemId, offer: null }]); // the card falls back to the featured offer

    const kept = newId();
    app.kernel.events.publish('catalog', 'catalog.product.merged', { keptProductId: kept, duplicateProductId: listing.productId, newVariantId: null, intoVariantId: null, reason: 'Duplicate' });
    await app.kernel.events.drain();
    const saved = await f.call('GET', `${S}/saved?productIds=${kept},${listing.productId}`, { token: bea.accessToken });
    expect(saved.body).toEqual({ [kept]: true, [listing.productId]: false });
  });
});
