/**
 * Tranche 4 on top of 1–3, with no stubs and no development tokens: an order's whole life.
 *
 *   a live listing → customers check out with the real payments module (dev card processor)
 *   → orders accepts each order and inventory reserves exactly what was bought (also checks the
 *     race between payments' "authorized" event and checkout attaching the stock hold)
 *   → placing twice never creates a second order or charge.
 * Gap pass 3: a line split by a partial cancellation is followed by inventory (orders.item.split), so the
 * cancelled unit is released and the shipped units leave stock: nothing stays reserved.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withDependencies } from '../kernel/module-system/loader.js';
import { buildTestApp, movingClock, signWebhook } from '../testing/app.js';
import { flows, type Flows, type Listing } from '../testing/flows.js';

const clock = movingClock();
let app: FastifyInstance;
let f: Flows;
let listing: Listing;

const PORTLAND = { name: 'Ben Ortiz', line1: '1120 SW 5th Ave', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US', phone: '+15035550101' };

beforeAll(async () => {
  app = await buildTestApp({
    only: withDependencies(['identity', 'access', 'audit', 'media', 'notifications', 'settings', 'customers', 'sellers', 'catalog', 'inventory', 'offers', 'cart', 'orders', 'promotions', 'content', 'payments', 'shipping', 'checkout', 'returns', 'finance', 'reviews', 'messaging']),
    clock,
    config: { rateLimits: false },
  });
  f = flows(app, clock);
  listing = await f.liveListing({ quantity: 20 });
});
afterAll(async () => {
  await app?.close();
});

const key = () => crypto.randomUUID();

/** Cart → checkout ready to place (address, default delivery, a new card) → the session view */
async function readyCheckout(token: string, quantity: number, card = 'tok_visa') {
  const add = await f.call('POST', '/api/store/cart/cart/items', { token, body: { offerId: listing.offerId, quantity } });
  expect(add.status, JSON.stringify(add.body)).toBeLessThan(300);
  const started = await f.call('POST', '/api/store/checkout/sessions', { token, body: { source: 'cart' } });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const id = started.body.id as string;
  const address = await f.call('PUT', `/api/store/checkout/sessions/${id}/address`, { token, body: { address: PORTLAND } });
  expect(address.status, JSON.stringify(address.body)).toBe(200);
  const pay = await f.call('PUT', `/api/store/checkout/sessions/${id}/payment-method`, { token, body: { kind: 'new_card', providerToken: card, label: 'Visa •••• 4242' } });
  expect(pay.status, JSON.stringify(pay.body)).toBe(200);
  return pay.body as { id: string; quoteVersion: number; totals: { total: { amount: number; currency: string } }; readyToPlace: boolean; blockers: string[] };
}

const placeBody = (v: { quoteVersion: number; totals: { total: { amount: number; currency: string } } }) => ({
  quoteVersion: v.quoteVersion,
  expectedTotal: v.totals.total,
  acceptTerms: true,
  channel: 'web',
  returnUrl: 'https://store.marketly.test/checkout/return',
});

/** Reserved units of the listing's stock item, as the seller sees it */
async function reserved(): Promise<number> {
  const stock = await f.call('GET', '/api/seller/inventory/stock-items', { token: listing.sellerToken });
  expect(stock.status, JSON.stringify(stock.body)).toBe(200);
  const items = (stock.body.items ?? stock.body) as { offerId?: string; reserved?: number; quantities?: { reserved?: number } }[];
  const row = items.find((i) => JSON.stringify(i).includes(listing.offerId)) ?? items[0]!;
  return row.reserved ?? row.quantities?.reserved ?? Number(JSON.stringify(row).match(/"reserved":(\d+)/)?.[1]);
}

describe('an order, end to end', () => {
  const orders: { orderId: string; token: string }[] = [];

  it('checks out with the real payment processor; each accepted order reserves exactly what was bought', async () => {
    let expected = await reserved();
    for (let i = 0; i < 4; i++) {
      const c = await f.customer(`shopper${i}@example.com`);
      const quantity = (i % 2) + 1;
      const v = await readyCheckout(c.accessToken, quantity);
      expect(v.readyToPlace, JSON.stringify(v.blockers)).toBe(true);
      const placed = await f.call('POST', `/api/store/checkout/sessions/${v.id}/place`, { token: c.accessToken, body: placeBody(v), headers: { 'idempotency-key': key() } });
      expect(placed.status, JSON.stringify(placed.body)).toBeLessThan(300);
      await app.kernel.events.drain();
      const orderId = JSON.stringify(placed.body).match(/"orderId":"([0-9a-f-]{36})"/)?.[1];
      expect(orderId, JSON.stringify(placed.body)).toBeDefined();
      orders.push({ orderId: orderId!, token: c.accessToken });
      const order = await f.call('GET', `/api/store/orders/orders/${orderId}`, { token: c.accessToken });
      expect(order.status, JSON.stringify(order.body)).toBe(200);
      expect(JSON.stringify(order.body)).not.toContain('payment_failed');
      expected += quantity;
      expect(await reserved(), `after order ${i + 1}`).toBe(expected);
    }
  });

  it('never creates a second order or charge when the customer taps Place twice', async () => {
    const c = await f.customer('twice@example.com');
    const v = await readyCheckout(c.accessToken, 1);
    const k = key();
    const first = await f.call('POST', `/api/store/checkout/sessions/${v.id}/place`, { token: c.accessToken, body: placeBody(v), headers: { 'idempotency-key': k } });
    const again = await f.call('POST', `/api/store/checkout/sessions/${v.id}/place`, { token: c.accessToken, body: placeBody(v), headers: { 'idempotency-key': k } });
    const newKey = await f.call('POST', `/api/store/checkout/sessions/${v.id}/place`, { token: c.accessToken, body: placeBody(v), headers: { 'idempotency-key': key() } });
    await app.kernel.events.drain();
    const ids = [first, again, newKey].map((r) => JSON.stringify(r.body).match(/"orderId":"([0-9a-f-]{36})"/)?.[1]).filter(Boolean);
    expect(new Set(ids).size, JSON.stringify(newKey.body)).toBe(1);
    const mine = await f.call('GET', '/api/store/orders/orders', { token: c.accessToken });
    expect(mine.body.items).toHaveLength(1);
  });

  it('turns a declined card into a clear result without an order', async () => {
    const c = await f.customer('declined@example.com');
    const v = await readyCheckout(c.accessToken, 1, 'tok_declined');
    const placed = await f.call('POST', `/api/store/checkout/sessions/${v.id}/place`, { token: c.accessToken, body: placeBody(v), headers: { 'idempotency-key': key() } });
    await app.kernel.events.drain();
    expect(JSON.stringify(placed.body)).toMatch(/declined|payment_failed/);
    expect((await f.call('GET', '/api/store/orders/orders', { token: c.accessToken })).body.items).toHaveLength(0);
  });
});

describe('a line split by a partial cancellation', () => {
  it('releases the cancelled unit and ships the rest: nothing of the order stays reserved', async () => {
    const before = await reserved();
    const c = await f.customer('split@example.com');
    const v = await readyCheckout(c.accessToken, 3);
    const placed = await f.call('POST', `/api/store/checkout/sessions/${v.id}/place`, { token: c.accessToken, body: placeBody(v), headers: { 'idempotency-key': key() } });
    await app.kernel.events.drain();
    const orderId = JSON.stringify(placed.body).match(/"orderId":"([0-9a-f-]{36})"/)![1]!;
    expect(await reserved(), 'the order reserves 3').toBe(before + 3);
    const order = await f.call('GET', `/api/store/orders/orders/${orderId}`, { token: c.accessToken });
    const groupId = order.body.groups[0].id as string;
    const itemId = order.body.groups[0].items[0].id as string;

    // the seller cancels 1 of the 3 units: orders splits the line
    const cancelled = await f.call('POST', `/api/seller/orders/orders/${groupId}/cancel-items`, { token: listing.sellerToken, body: { items: [{ itemId, quantity: 1 }], reasonCode: 'out_of_stock' }, headers: { 'idempotency-key': key() } });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBeLessThan(300);
    await app.kernel.events.drain();
    expect(await reserved(), 'the cancelled unit is released').toBe(before + 2);

    // the remaining 2 units are on the split-off line; shipping them takes them out of stock
    const after = await f.call('GET', `/api/store/orders/orders/${orderId}`, { token: c.accessToken });
    const open = (after.body.groups[0].items as { id: string; quantity: number; state: string }[]).find((i) => i.state !== 'cancelled')!;
    expect(open.quantity, JSON.stringify(after.body.groups[0].items)).toBe(2);
    const tracking = `1ZSPLIT0${String(Date.now()).slice(-10)}`;
    const shipped = await f.call('POST', '/api/seller/shipping/shipments', {
      token: listing.sellerToken,
      body: { groupId, carrierCode: 'ups', serviceName: 'UPS Ground', trackingNumber: tracking, shippedAt: clock.now().toISOString(), items: [{ orderItemId: open.id, quantity: 2 }] },
    });
    expect(shipped.status, JSON.stringify(shipped.body)).toBe(201);
    await app.kernel.events.drain();
    expect(await reserved(), 'nothing of the order stays reserved').toBe(before);
  });
});

describe('after the purchase', () => {
  let buyer: Awaited<ReturnType<Flows['customer']>>;
  let orderId: string;
  let groupId: string;
  let itemId: string;
  const tracking = `1Z${'LIFE01'}${String(Date.now()).slice(-10)}`;

  it('ships through the carrier and marks the item delivered from the carrier event', async () => {
    buyer = await f.customer('lifecycle@example.com');
    const v = await readyCheckout(buyer.accessToken, 1);
    const placed = await f.call('POST', `/api/store/checkout/sessions/${v.id}/place`, { token: buyer.accessToken, body: placeBody(v), headers: { 'idempotency-key': key() } });
    await app.kernel.events.drain();
    orderId = JSON.stringify(placed.body).match(/"orderId":"([0-9a-f-]{36})"/)![1]!;
    const mine = await f.call('GET', `/api/store/orders/orders/${orderId}`, { token: buyer.accessToken });
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    groupId = mine.body.groups[0].id;
    itemId = mine.body.groups[0].items[0].id;
    // the seller sees the same group through its own seller-group path
    expect((await f.call('GET', `/api/seller/orders/orders/${groupId}`, { token: listing.sellerToken })).status).toBe(200);

    const shipped = await f.call('POST', '/api/seller/shipping/shipments', {
      token: listing.sellerToken,
      body: { groupId, carrierCode: 'ups', serviceName: 'UPS Ground', trackingNumber: tracking, shippedAt: clock.now().toISOString(), items: [{ orderItemId: itemId, quantity: 1 }] },
    });
    expect(shipped.status, JSON.stringify(shipped.body)).toBe(201);
    const raw = JSON.stringify({ id: `evt-${tracking}-delivered`, trackingNumber: tracking, code: 'delivered', at: clock.now().toISOString(), location: 'Portland, OR' });
    const hook = await app.inject({ method: 'POST', url: '/webhooks/shipping/carriers/ups/events', headers: { 'content-type': 'application/json', ...signWebhook('dev-webhook-secret', raw, Math.floor(clock.now().getTime() / 1000)) }, payload: raw });
    expect(hook.statusCode, hook.body).toBeLessThan(300);
    await app.kernel.events.drain();
    const order = await f.call('GET', `/api/store/orders/orders/${orderId}`, { token: buyer.accessToken });
    expect(JSON.stringify(order.body)).toContain('delivered');
  });

  it('credits the seller ledger with the sale', async () => {
    const ledger = await f.call('GET', '/api/seller/finance/ledger', { token: listing.sellerToken });
    expect(ledger.status, JSON.stringify(ledger.body)).toBe(200);
    expect(JSON.stringify(ledger.body)).toContain(orderId);
  });

  it('returns the item: request, seller approval, receipt, inspection and a refund the seller ledger reflects', async () => {
    const created = await f.call('POST', '/api/store/returns/requests', {
      token: buyer.accessToken,
      body: { orderId, items: [{ orderItemId: itemId, quantity: 1 }], reason: 'damaged', details: 'Cracked headband', remedy: 'refund' },
      headers: { 'idempotency-key': key() },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const returnId = created.body.returns[0].id as string;
    const approved = await f.call('POST', `/api/seller/returns/requests/${returnId}/approve`, { token: listing.sellerToken, body: { labelMethod: 'prepaid_qr' } });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const received = await f.call('POST', `/api/seller/returns/requests/${returnId}/receive`, { token: listing.sellerToken, body: {} });
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    const inspected = await f.call('POST', `/api/seller/returns/requests/${returnId}/inspection`, {
      token: listing.sellerToken,
      body: { conditionOutcome: 'as_described', grade: 'good', proposedStockOutcome: 'restock', checks: [{ label: 'Powers on', passed: true }] },
    });
    expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
    const refund = await f.call('POST', `/api/seller/returns/requests/${returnId}/remedy`, { token: listing.sellerToken, body: { kind: 'full_refund' }, headers: { 'idempotency-key': key() } });
    expect(refund.status, JSON.stringify(refund.body)).toBeLessThan(300);
    await app.kernel.jobs.runNow('payments.process-refunds'); // submits requested refunds to the card processor
    await app.kernel.events.drain();
    const ret = await f.call('GET', `/api/store/returns/requests/${returnId}`, { token: buyer.accessToken });
    expect(JSON.stringify(ret.body)).toMatch(/refund/i);
    const ledger = await f.call('GET', '/api/seller/finance/ledger', { token: listing.sellerToken });
    expect(JSON.stringify(ledger.body)).toMatch(/"type":"[a-z_]*refund[a-z_]*"/); // a refund entry, booked when payments sent the refund
  });
});
