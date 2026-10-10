/**
 * Gap pass 3 with real modules: move to cart with the price the card showed, whole-product back-in-stock alerts from
 * company stock events (inventory.stock.changed carries productId), the evaluate-alerts job re-checking back-in-stock
 * alerts, the customer data export hook, account closure and WishlistAlert.sellerId in GraphQL.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { allSpecs, withDependencies } from '../../../kernel/module-system/loader.js';
import { auth, buildTestApp, movingClock, tokenClock } from '../../../testing/app.js';
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
const fired = () => events.filter((e) => e.name === 'wishlist.alert.triggered').map((e) => e.payload as any);

type Customer = Awaited<ReturnType<Flows['customer']>>;
let gia: Customer;
const S = '/api/store/wishlist';
const usd = (amount: number) => ({ amount, currency: 'USD' });

beforeAll(async () => {
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 3 * 86_400;
  app = await buildTestApp({ only: withDependencies([...launchModules, 'wishlist']), clock, config: { rateLimits: false, launchPhase: 4 } });
  f = flows(app, clock);
  service = app.kernel.boot.apis.get('wishlist') as WishlistService;
  app.kernel.events.subscribe('test', 'wishlist.alert.triggered', (e) => void events.push(e));
  listing = await f.liveListing({ price: 18900, quantity: 5 });
  gia = await f.customer('gia@example.com');
  const on = await f.call('PUT', '/api/store/customers/marketing-preferences', { token: gia.accessToken, body: { wishlistAlerts: true } });
  expect(on.status, JSON.stringify(on.body)).toBe(200);
}, 120_000);
afterAll(async () => {
  tokenClock.now = undefined;
  tokenClock.ttlSeconds = 900;
  await app?.close();
});

let itemId: string;
let alertId: string;
/** As if what the alert follows was seen out of stock (the listing stays in stock in these tests) */
const armed = (id: string) => sql`update wishlist.alerts set armed_at = now() where id = ${id}`.execute(app.kernel.database.kysely);
/** The customer id wishlist keeps for gia (customers' id of the signed-in account) */
const wishlistCustomerId = async () => (await sql<{ customer_id: string }>`select customer_id from wishlist.items where id = ${itemId}`.execute(app.kernel.database.kysely)).rows[0]!.customer_id;

describe('move to cart with the price the card showed', () => {
  it('refuses a different current price with OFFER_CHANGED and adds nothing; the shown price goes through', async () => {
    const saved = await f.call('POST', `${S}/items`, { token: gia.accessToken, body: { productId: listing.productId, offerId: listing.offerId, note: 'Desk set' } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    itemId = saved.body.id;

    const stale = await f.call('POST', `${S}/items/${itemId}/move-to-cart`, { token: gia.accessToken, body: { quantity: 1, expectedPrice: usd(17900) } });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'OFFER_CHANGED', details: { offerId: listing.offerId, price: usd(18900), previousPrice: usd(17900), availability: 'in_stock' } });
    expect((await f.call('GET', '/api/store/cart/cart', { token: gia.accessToken })).body.itemCount ?? 0).toBe(0);

    const ok = await f.call('POST', `${S}/items/${itemId}/move-to-cart`, { token: gia.accessToken, body: { quantity: 1, expectedPrice: usd(18900) } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ cartItemCount: 1, item: { id: itemId } });
  });
});

describe('back-in-stock alerts', () => {
  it('fires a whole-product alert from a company stock change that names the product (no offer, no matching variant row)', async () => {
    const created = await f.call('POST', `${S}/alerts`, { token: gia.accessToken, body: { productId: listing.productId, kind: 'back_in_stock' } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // switched on while the listing is in stock: it waits for a stock-out (pass 4, armed_at)
    expect(created.body).toMatchObject({ variantId: null, sellerId: null, state: 'active', armedAt: null });
    alertId = created.body.id;
    await armed(alertId);

    events.length = 0;
    app.kernel.events.publish('inventory', 'inventory.stock.changed', {
      stockItemId: newId(),
      offerId: null,
      ownerType: 'official',
      sellerId: null,
      productId: listing.productId,
      variantId: newId(), // a variant nobody saved: before productId was on the payload this alert was never found
      available: 3,
      reserved: 0,
      previousAvailable: 0,
      state: 'in_stock',
      archived: false,
      cause: 'receipt',
    });
    await app.kernel.events.drain();
    expect(fired()).toEqual([expect.objectContaining({ alertId, kind: 'back_in_stock', productId: listing.productId })]);
  });

  it('the evaluate-alerts job re-checks back-in-stock alerts: nothing inside the cooldown, fires once it has passed', async () => {
    const rearm = await f.call('POST', `${S}/alerts/${alertId}/transition`, { token: gia.accessToken, body: { action: 'rearm' } });
    // rearmed while in stock: unarmed until a stock-out is seen; here the item went out of stock and came back
    expect(rearm.body).toMatchObject({ state: 'active', armedAt: null });
    await armed(alertId);

    events.length = 0;
    await app.kernel.jobs.runNow('wishlist.evaluate-alerts');
    await app.kernel.events.drain();
    expect(fired()).toHaveLength(0); // notified less than alertCooldownHours ago

    clock.advance(25 * 3_600_000);
    await app.kernel.jobs.runNow('wishlist.evaluate-alerts');
    await app.kernel.events.drain();
    expect(fired()).toEqual([expect.objectContaining({ alertId, kind: 'back_in_stock', offerId: listing.offerId, price: usd(18900) })]); // the offer is in stock: no event needed

    await app.kernel.jobs.runNow('wishlist.evaluate-alerts');
    await app.kernel.events.drain();
    expect(fired()).toHaveLength(1); // triggered alerts are not re-sent
    gia = { ...gia, accessToken: (await f.signIn({ email: gia.email, password: gia.password, audience: 'store' })).body.tokens.accessToken };
  });

  it('shows the alert seller id and the seller card in GraphQL (sellers shared mapper)', async () => {
    const seller = await f.call('POST', `${S}/alerts`, { token: gia.accessToken, body: { productId: listing.productId, kind: 'price_drop', sellerId: listing.sellerId } });
    expect(seller.status, JSON.stringify(seller.body)).toBe(201);
    const res = await app.inject({ method: 'POST', url: '/graphql/store', payload: { query: '{ me { wishlistAlerts { kind sellerId seller { id ref slug storeName verified sellingNow sellingSince publicProfile { sellerId verification { state } contact { canMessage } } } } } }' }, headers: auth(gia.accessToken) });
    expect(res.json().errors, res.body).toBeUndefined();
    const alerts = res.json().data.me.wishlistAlerts;
    expect(alerts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'PRICE_DROP', sellerId: listing.sellerId }), { kind: 'BACK_IN_STOCK', sellerId: null, seller: null }]));
    const card = alerts.find((a: any) => a.kind === 'PRICE_DROP').seller;
    expect(card).toMatchObject({ id: listing.sellerId, ref: expect.any(String), slug: expect.any(String), storeName: 'Northwind Audio', sellingNow: true, sellingSince: expect.any(String) });
    expect(card.publicProfile).toMatchObject({ sellerId: listing.sellerId, verification: { state: expect.any(String) }, contact: { canMessage: expect.any(Boolean) } });
  });
});

describe('customer data', () => {
  it('exports lists, saved items with notes and alerts as sections', async () => {
    const sections = await service.exportCustomerData({ customerId: await wishlistCustomerId(), accountId: gia.accountId });
    expect(sections.map((s) => [s.key, s.module])).toEqual([
      ['wishlist_lists', 'wishlist'],
      ['wishlist_items', 'wishlist'],
      ['wishlist_alerts', 'wishlist'],
    ]);
    expect(sections[0]!.records).toEqual([expect.objectContaining({ name: 'Wishlist', isDefault: true })]);
    expect(sections[1]!.records).toEqual([expect.objectContaining({ productId: listing.productId, title: 'Aurora wireless headphones', note: 'Desk set', priceWhenSaved: usd(18900) })]);
    expect(sections[2]!.records.map((r: any) => r.kind).sort()).toEqual(['back_in_stock', 'price_drop']);
    expect(await service.exportCustomerData({ customerId: newId(), accountId: newId() })).toEqual(sections.map((s) => ({ ...s, records: [] })));
  });

  it('deletes lists, items and alerts when the account is closed (share links stop working), once', async () => {
    const listId = (await f.call('GET', `${S}/lists`, { token: gia.accessToken })).body[0].id;
    const shared = await f.call('POST', `${S}/lists/${listId}/share`, { token: gia.accessToken, body: { enabled: true } });
    const token = shared.body.shareUrl.split('/wishlist/shared/')[1];
    const visitor = await f.visitor();
    expect((await f.call('GET', `${S}/shared/${token}`, { token: visitor })).status).toBe(200);
    const customerId = await wishlistCustomerId();

    const other = await f.customer('hal@example.com');
    expect((await f.call('POST', `${S}/items`, { token: other.accessToken, body: { productId: listing.productId } })).status).toBe(201);

    const closed = { customerId, userId: gia.accountId };
    app.kernel.events.publish('customers', 'customers.account.closed', closed);
    await app.kernel.events.drain();
    const left = await service.exportCustomerData({ customerId, accountId: gia.accountId });
    expect(left.map((s) => s.records.length)).toEqual([0, 0, 0]);
    expect((await f.call('GET', `${S}/shared/${token}`, { token: visitor })).status).toBe(404);
    expect(await service.savedCount(listing.productId)).toBe(1); // the other customer's item stays

    app.kernel.events.publish('customers', 'customers.account.closed', closed); // redelivery changes nothing
    await app.kernel.events.drain();
    expect(await service.savedCount(listing.productId)).toBe(1);
  });
});
