/**
 * Customer restrictions with the real modules: an ordering restriction that starts after a declined payment stops the
 * retry, guest checkout with the restricted customer's email is refused too, and a reviews restriction stops
 * questions and other review content.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withDependencies } from '../kernel/module-system/loader.js';
import type { CustomersService } from '../modules/customers/service.js';
import { buildTestApp, movingClock } from '../testing/app.js';
import { flows, type Flows, type Listing } from '../testing/flows.js';

const clock = movingClock();
let app: FastifyInstance;
let f: Flows;
let listing: Listing;
let care: Awaited<ReturnType<Flows['staffWithRoles']>>;

const ADDRESS = { name: 'Rae Restricted', line1: '1120 SW 5th Ave', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US', phone: '+15035550101' };
const key = () => crypto.randomUUID();

beforeAll(async () => {
  app = await buildTestApp({
    only: withDependencies(['identity', 'access', 'audit', 'media', 'notifications', 'settings', 'customers', 'sellers', 'catalog', 'inventory', 'offers', 'cart', 'orders', 'promotions', 'content', 'payments', 'shipping', 'checkout', 'returns', 'finance', 'reviews']),
    clock,
    config: { rateLimits: false },
  });
  f = flows(app, clock);
  listing = await f.liveListing({ quantity: 20 });
  care = await f.staffWithRoles(listing.owner, 'care@marketly.test', 'Casey Care', ['customer_support_manager']);
});
afterAll(async () => {
  await app?.close();
});

/** Cart → checkout ready to place, as the customer or as a guest (contact email) */
async function ready(token: string, card: string, guestEmail?: string) {
  expect((await f.call('POST', '/api/store/cart/cart/items', { token, body: { offerId: listing.offerId, quantity: 1 } })).status).toBeLessThan(300);
  const id = (await f.call('POST', '/api/store/checkout/sessions', { token, body: { source: 'cart' } })).body.id as string;
  if (guestEmail) expect((await f.call('PUT', `/api/store/checkout/sessions/${id}/contact`, { token, body: { email: guestEmail, phone: '+15035550142', createAccountAfter: false, marketingOptIn: false } })).status).toBe(200);
  expect((await f.call('PUT', `/api/store/checkout/sessions/${id}/address`, { token, body: { address: ADDRESS } })).status).toBe(200);
  const pay = await f.call('PUT', `/api/store/checkout/sessions/${id}/payment-method`, { token, body: { kind: 'new_card', providerToken: card, label: 'Card' } });
  expect(pay.status, JSON.stringify(pay.body)).toBe(200);
  return pay.body as { id: string; quoteVersion: number; totals: { total: { amount: number; currency: string } } };
}
const place = (token: string, v: { id: string; quoteVersion: number; totals: { total: { amount: number; currency: string } } }) =>
  f.call('POST', `/api/store/checkout/sessions/${v.id}/place`, { token, body: { quoteVersion: v.quoteVersion, expectedTotal: v.totals.total, acceptTerms: true, channel: 'web', returnUrl: 'https://store.marketly.test/r' }, headers: { 'idempotency-key': key() } });

async function restrict(accountId: string, action: 'restrict_ordering' | 'restrict_reviews') {
  const customer = await (app.kernel.boot.apis.get('customers') as unknown as CustomersService).getCustomerByUserId(accountId);
  const res = await f.call('POST', `/api/admin/customers/customers/${customer!.id}/actions`, { token: care.accessToken, body: { action, reasonCode: 'policy_violation', details: 'Audit H12 check', endsAt: null } });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  await app.kernel.events.drain();
}

describe('customer restrictions', () => {
  let rae: Awaited<ReturnType<Flows['customer']>>;

  it('stops a payment retry once ordering is restricted after the decline', async () => {
    rae = await f.customer('rae@example.com');
    const v = await ready(rae.accessToken, 'tok_declined');
    const failed = await place(rae.accessToken, v);
    await app.kernel.events.drain();
    expect(JSON.stringify(failed.body)).toMatch(/payment_failed|declined/);
    await restrict(rae.accountId, 'restrict_ordering');
    const session = (await f.call('GET', `/api/store/checkout/sessions/${v.id}`, { token: rae.accessToken })).body;
    const retry = await f.call('POST', `/api/store/checkout/sessions/${v.id}/retry-payment`, { token: rae.accessToken, body: { method: { kind: 'new_card', providerToken: 'tok_visa' }, quoteVersion: session.quoteVersion, expectedTotal: session.totals.total, returnUrl: 'https://store.marketly.test/r' }, headers: { 'idempotency-key': key() } });
    expect(retry.status, JSON.stringify(retry.body)).toBe(403);
    expect(retry.body.error.code).toBe('ORDERING_RESTRICTED');
  });

  it('refuses guest checkout with the restricted customer’s email', async () => {
    const guest = await f.visitor('store');
    const v = await ready(guest, 'tok_visa', 'rae@example.com');
    const res = await place(guest, v);
    expect(res.body.error?.code, JSON.stringify(res.body)).toBe('ORDERING_RESTRICTED');
    expect(res.body.error.message).not.toMatch(/restrict|suspend|paused/i); // nothing about the account is revealed
  });

  it('stops questions from a customer whose reviews are restricted', async () => {
    const quinn = await f.customer('quinn@example.com');
    const ok = await f.call('POST', `/api/store/reviews/products/${listing.productId}/questions`, { token: quinn.accessToken, body: { text: 'Does it fold flat for travel?' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    await restrict(quinn.accountId, 'restrict_reviews');
    const res = await f.call('POST', `/api/store/reviews/products/${listing.productId}/questions`, { token: quinn.accessToken, body: { text: 'And does it come with a case?' } });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('REVIEWS_RESTRICTED');
  });
});
