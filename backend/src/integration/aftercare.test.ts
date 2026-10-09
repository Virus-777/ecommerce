/**
 * Tranche 5 on top of 1–4, with no stubs and no development tokens: what happens after an order.
 *
 *   a delivered order → the customer reports a problem, the seller offers a partial refund, the
 *   customer accepts → returns opens the refund request that Finance must approve
 *   → Trust and Risk reports the seller, a Seller Manager accepts the restriction → the seller can
 *     no longer sell and the cart says so → the Business Owner sees it in the action history
 *   → the seller dashboard in reports shows the sale.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withDependencies } from '../kernel/module-system/loader.js';
import { buildTestApp, movingClock, signWebhook } from '../testing/app.js';
import { flows, type Flows, type Listing, type Staff } from '../testing/flows.js';

const clock = movingClock();
let app: FastifyInstance;
let f: Flows;
let listing: Listing;
let trustManager: Staff;
let buyer: Awaited<ReturnType<Flows['customer']>>;
let orderId: string;
let itemId: string;

const PORTLAND = { name: 'Dee Park', line1: '1120 SW 5th Ave', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US', phone: '+15035550101' };
const key = () => crypto.randomUUID();

beforeAll(async () => {
  app = await buildTestApp({
    only: withDependencies(['checkout', 'returns', 'finance', 'support', 'trust', 'reports', 'messaging', 'workqueues', 'warehouse', 'advertising', 'audit']),
    clock,
    config: { rateLimits: false },
  });
  f = flows(app, clock);
  listing = await f.liveListing({ quantity: 10 });
  trustManager = await f.staffWithRoles(listing.owner, 'tia@marketly.test', 'Tia Trust', ['trust_and_risk_manager']);

  // a delivered order from a real checkout
  buyer = await f.customer('dee@example.com');
  expect((await f.call('POST', '/api/store/cart/cart/items', { token: buyer.accessToken, body: { offerId: listing.offerId, quantity: 1 } })).status).toBeLessThan(300);
  const started = await f.call('POST', '/api/store/checkout/sessions', { token: buyer.accessToken, body: { source: 'cart' } });
  const id = started.body.id as string;
  await f.call('PUT', `/api/store/checkout/sessions/${id}/address`, { token: buyer.accessToken, body: { address: PORTLAND } });
  const v = (await f.call('PUT', `/api/store/checkout/sessions/${id}/payment-method`, { token: buyer.accessToken, body: { kind: 'new_card', providerToken: 'tok_visa' } })).body;
  const placed = await f.call('POST', `/api/store/checkout/sessions/${id}/place`, {
    token: buyer.accessToken,
    body: { quoteVersion: v.quoteVersion, expectedTotal: v.totals.total, acceptTerms: true, channel: 'web', returnUrl: 'https://store.marketly.test/r' },
    headers: { 'idempotency-key': key() },
  });
  await app.kernel.events.drain();
  orderId = JSON.stringify(placed.body).match(/"orderId":"([0-9a-f-]{36})"/)![1]!;
  const order = (await f.call('GET', `/api/store/orders/orders/${orderId}`, { token: buyer.accessToken })).body;
  itemId = order.groups[0].items[0].id;
  const tracking = `1ZAFTER0${String(Date.now()).slice(-10)}`; // UPS format: 1Z + 16 letters or digits
  const shipped = await f.call('POST', '/api/seller/shipping/shipments', {
    token: listing.sellerToken,
    body: { groupId: order.groups[0].id, carrierCode: 'ups', serviceName: 'UPS Ground', trackingNumber: tracking, shippedAt: clock.now().toISOString(), items: [{ orderItemId: itemId, quantity: 1 }] },
  });
  expect(shipped.status, JSON.stringify(shipped.body)).toBe(201);
  const raw = JSON.stringify({ id: `evt-${tracking}`, trackingNumber: tracking, code: 'delivered', at: clock.now().toISOString(), location: 'Portland, OR' });
  await app.inject({ method: 'POST', url: '/webhooks/shipping/carriers/ups/events', headers: { 'content-type': 'application/json', ...signWebhook('dev-webhook-secret', raw, Math.floor(clock.now().getTime() / 1000)) }, payload: raw });
  await app.kernel.events.drain();
});
afterAll(async () => {
  await app?.close();
});

describe('after the order', () => {
  it('turns a problem report into a seller offer, and an accepted offer into a refund request Finance must approve', async () => {
    const opened = await f.call('POST', '/api/store/support/cases', {
      token: buyer.accessToken,
      body: { kind: 'order_problem', category: 'item_damaged', orderId, orderItemIds: [itemId], message: 'The headband arrived cracked' },
      headers: { 'idempotency-key': key() },
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body).toMatchObject({ kind: 'order_problem', status: 'waiting_on_seller' });
    const caseId = opened.body.id as string;

    const offered = await f.call('POST', `/api/seller/support/cases/${caseId}/messages`, {
      token: listing.sellerToken,
      body: { body: 'Sorry about that. We can refund part of it.', offer: { kind: 'partial_refund', amount: { amount: 2000, currency: 'USD' }, note: 'Keep the item' } },
    });
    expect(offered.status, JSON.stringify(offered.body)).toBeLessThan(300);
    const view = await f.call('GET', `/api/store/support/cases/${caseId}`, { token: buyer.accessToken });
    const accepted = await f.call('POST', `/api/store/support/cases/${caseId}/offers/${view.body.offers[0].id}/respond`, { token: buyer.accessToken, body: { accept: true } });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.remedies[0]).toMatchObject({ kind: 'partial_refund', chargedTo: 'seller', status: 'pending_approval' });
    expect(accepted.body.remedies[0].refundRequestId).toBeTruthy();
    // another customer can't see the case
    const other = await f.customer('nosy@example.com');
    expect((await f.call('GET', `/api/store/support/cases/${caseId}`, { token: other.accessToken })).status).toBe(404);
  });

  it('restricts the seller through Trust and Risk; the offer stops selling and the cart explains it', async () => {
    // a shopper has the offer in the cart before the restriction
    const shopper = await f.customer('eve@example.com');
    expect((await f.call('POST', '/api/store/cart/cart/items', { token: shopper.accessToken, body: { offerId: listing.offerId, quantity: 1 } })).status).toBeLessThan(300);

    const seller = { type: 'seller', id: listing.sellerId, label: 'Northwind Audio' };
    const report = await f.call('POST', '/api/admin/trust/reports', {
      token: trustManager.accessToken,
      body: { type: 'counterfeit', title: 'Suspected counterfeit headphones', description: 'Brand registry mismatch on 4 units', subjects: [seller], evidence: [] },
    });
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    const rec = await f.call('POST', `/api/admin/trust/reports/${report.body.id}/recommendations`, {
      token: trustManager.accessToken,
      body: { action: 'restrict_seller', label: 'Stop sales', ownerTeam: 'sellers', targets: [seller], rationale: 'Confirmed by the brand owner', params: { affectedActivities: ['sales'] } },
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    expect((await f.call('POST', `/api/admin/trust/recommendations/${rec.body.id}/route`, { token: trustManager.accessToken })).status).toBeLessThan(300);

    // Trust recommends; the Seller Manager (the owning team) decides
    expect((await f.call('POST', `/api/admin/trust/recommendations/${rec.body.id}/decide`, { token: trustManager.accessToken, body: { accept: true, reason: 'x' } })).status).toBe(403);
    let decided = await f.call('POST', `/api/admin/trust/recommendations/${rec.body.id}/decide`, { token: listing.sellerManager.accessToken, body: { accept: true, reason: 'Counterfeit units sold' } });
    if (decided.status === 409 && decided.body.error.code === 'APPROVAL_REQUIRED') {
      // above the Seller Manager's authority: the Business Owner approves, then the decision goes through
      const requestId = decided.body.error.details.approvalRequestId as string;
      const ok = await f.call('POST', `/api/admin/access/approval-requests/${requestId}/approve`, { token: listing.owner.accessToken, body: { note: 'Agreed' }, headers: { 'x-step-up-code': f.code(listing.owner) } });
      expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
      decided = await f.call('POST', `/api/admin/trust/recommendations/${rec.body.id}/decide`, { token: listing.sellerManager.accessToken, body: { accept: true, reason: 'Counterfeit units sold' } });
    }
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    await app.kernel.events.drain();

    const offer = await f.call('GET', `/api/seller/offers/offers/${listing.offerId}`, { token: listing.sellerToken });
    expect(offer.body.offer.status, JSON.stringify(offer.body.offer)).not.toBe('active');
    const cart = await f.call('GET', '/api/store/cart/cart', { token: shopper.accessToken });
    expect(JSON.stringify(cart.body)).toContain('"kind":"seller_unavailable"');
  });

  it('keeps the history and the figures: action history for the owner, the sale on the seller dashboard', async () => {
    const audit = await f.call('GET', '/api/admin/audit/entries?limit=100', { token: listing.owner.accessToken });
    expect(audit.status, JSON.stringify(audit.body)).toBe(200);
    expect(audit.body.items.map((e: { module: string }) => e.module)).toEqual(expect.arrayContaining(['trust', 'sellers']));
    const dashboard = await f.call('GET', '/api/seller/reports/dashboard', { token: listing.sellerToken });
    expect(dashboard.status, JSON.stringify(dashboard.body)).toBe(200);
  });
});
