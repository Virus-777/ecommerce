/**
 * Gap pass 4 with real modules: alerts.armed_at. A back-in-stock alert switched on while the item is in stock no
 * longer fires at the next evaluate-alerts run; it is armed when the item goes out of stock and fires on the restock.
 * One switched on while the item is out of stock is armed at once.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import { allSpecs, withDependencies } from '../../../kernel/module-system/loader.js';
import { buildTestApp, movingClock, tokenClock } from '../../../testing/app.js';
import { flows, type Flows, type Listing } from '../../../testing/flows.js';

const clock = movingClock();
const launchModules = Object.values(allSpecs)
  .filter((s) => s.phase <= 2)
  .map((s) => s.name);
let app: FastifyInstance;
let f: Flows;
let listing: Listing;
const events: EventEnvelope[] = [];
const fired = () => events.filter((e) => e.name === 'wishlist.alert.triggered').map((e) => e.payload as any);
let ann: Awaited<ReturnType<Flows['customer']>>;
const S = '/api/store/wishlist';

beforeAll(async () => {
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 3 * 86_400;
  app = await buildTestApp({ only: withDependencies([...launchModules, 'wishlist']), clock, config: { rateLimits: false, launchPhase: 4 } });
  f = flows(app, clock);
  app.kernel.events.subscribe('test', 'wishlist.alert.triggered', (e) => void events.push(e));
  listing = await f.liveListing({ price: 18900, quantity: 5 });
  ann = await f.customer('ann@example.com');
  expect((await f.call('PUT', '/api/store/customers/marketing-preferences', { token: ann.accessToken, body: { wishlistAlerts: true } })).status).toBe(200);
}, 120_000);
afterAll(async () => {
  tokenClock.now = undefined;
  tokenClock.ttlSeconds = 900;
  await app?.close();
});

async function setStock(n: number) {
  const stock = await f.call('GET', '/api/seller/inventory/stock-items', { token: listing.sellerToken });
  const stockItemId = JSON.stringify(stock.body).match(/"(?:id|stockItemId)":"([0-9a-f-]{36})"/)?.[1];
  const res = await f.call('POST', `/api/seller/inventory/stock-items/${stockItemId}/adjustments`, { token: listing.sellerToken, body: { newAvailable: n, reasonCode: n ? 'received_stock' : 'moved_to_another_channel', note: 'Test' } });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  await app.kernel.events.drain();
}
const alertOf = async (id: string) => {
  const res = await f.call("GET", `${S}/alerts?limit=100`, { token: ann.accessToken });
  if (!res.body?.items) throw new Error(JSON.stringify(res.body));
  return res.body.items.find((a: any) => a.id === id);
};

describe('back-in-stock alerts switched on while in stock', () => {
  it('wait for a stock-out: the job does not fire them; the restock after it does', async () => {
    const created = await f.call('POST', `${S}/alerts`, { token: ann.accessToken, body: { productId: listing.productId, kind: 'back_in_stock' } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ state: 'active', armedAt: null });
    const id = created.body.id;

    events.length = 0;
    await app.kernel.jobs.runNow('wishlist.evaluate-alerts');
    await app.kernel.events.drain();
    expect(fired()).toEqual([]); // before pass 4 this fired although nothing had been out of stock
    expect(await alertOf(id)).toMatchObject({ state: 'active', armedAt: null });

    await setStock(0);
    expect((await alertOf(id)).armedAt).toEqual(expect.any(String));

    // switched on now, while out of stock: armed at once
    const later = await f.call('POST', `${S}/alerts`, { token: ann.accessToken, body: { productId: listing.productId, variantId: listing.variantId, kind: 'back_in_stock' } });
    expect(later.body.armedAt).toEqual(expect.any(String));

    await setStock(3);
    expect(fired().map((e) => e.alertId).sort()).toEqual([id, later.body.id].sort());
  });
});
