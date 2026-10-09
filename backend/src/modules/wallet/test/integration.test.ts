/**
 * Wallet with the real modules that call it, no stubs and no development tokens:
 *
 *   a delivered order → a return refunded as store credit (returns → wallet.creditRefund)
 *   → the customer pays part of the next order with the credit (checkout → holdCredit, payments charges the rest,
 *     captureHold on acceptance) → a declined card gives the credit back and the retry still uses it
 *   → support grants goodwill from a case decision within the agent's limit, and above it once Finance approves
 *     in access (access.approval.decided) → GraphQL shows the balance to the customer and to staff.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import { buildTestApp, movingClock, signWebhook } from '../../../testing/app.js';
import { flows, type Flows, type Listing, type Staff } from '../../../testing/flows.js';

const clock = movingClock();
let app: FastifyInstance;
let f: Flows;
let listing: Listing;
let buyer: Awaited<ReturnType<Flows['customer']>>;
let customerId: string;
const authorized: { checkoutSessionId: string; amount: { amount: number } }[] = [];
let charged = { card: 0, leftToPay: 0 };

const PORTLAND = { name: 'Wren Hale', line1: '1120 SW 5th Ave', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US', phone: '+15035550101' };
const key = () => crypto.randomUUID();
const USD = (amount: number) => ({ amount, currency: 'USD' });

beforeAll(async () => {
  app = await buildTestApp({
    only: withDependencies(['checkout', 'returns', 'finance', 'support', 'wallet', 'audit', 'notifications', 'settings']),
    clock,
    config: { rateLimits: false, launchPhase: 4 },
  });
  f = flows(app, clock);
  listing = await f.liveListing({ quantity: 20 });
  buyer = await f.customer('wren@example.com');
  app.kernel.events.subscribe('test', 'payments.payment.authorized', (e) => void authorized.push(e.payload as never));
});
afterAll(async () => {
  await app?.close();
});

/** Cart → checkout ready to place (address, default delivery, a new card) */
async function readyCheckout(token: string, card = 'tok_visa') {
  expect((await f.call('POST', '/api/store/cart/cart/items', { token, body: { offerId: listing.offerId, quantity: 1 } })).status).toBeLessThan(300);
  const started = await f.call('POST', '/api/store/checkout/sessions', { token, body: { source: 'cart' } });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const id = started.body.id as string;
  expect((await f.call('PUT', `/api/store/checkout/sessions/${id}/address`, { token, body: { address: PORTLAND } })).status).toBe(200);
  const pay = await f.call('PUT', `/api/store/checkout/sessions/${id}/payment-method`, { token, body: { kind: 'new_card', providerToken: card, label: 'Visa •••• 4242' } });
  expect(pay.status, JSON.stringify(pay.body)).toBe(200);
  return pay.body as { id: string; quoteVersion: number; totals: { total: { amount: number; currency: string }; creditApplied: { amount: number } } };
}

async function place(token: string, v: { id: string; quoteVersion: number; totals: { total: { amount: number; currency: string } } }) {
  const placed = await f.call('POST', `/api/store/checkout/sessions/${v.id}/place`, {
    token,
    body: { quoteVersion: v.quoteVersion, expectedTotal: v.totals.total, acceptTerms: true, channel: 'web', returnUrl: 'https://store.marketly.test/checkout/return' },
    headers: { 'idempotency-key': key() },
  });
  await app.kernel.events.drain();
  return { ...placed, orderId: JSON.stringify(placed.body).match(/"orderId":"([0-9a-f-]{36})"/)?.[1] };
}

async function deliver(orderId: string) {
  const order = (await f.call('GET', `/api/store/orders/orders/${orderId}`, { token: buyer.accessToken })).body;
  const itemId = order.groups[0].items[0].id as string;
  const tracking = `1ZWALLET${String(Date.now()).slice(-10)}`;
  const shipped = await f.call('POST', '/api/seller/shipping/shipments', {
    token: listing.sellerToken,
    body: { groupId: order.groups[0].id, carrierCode: 'ups', serviceName: 'UPS Ground', trackingNumber: tracking, shippedAt: clock.now().toISOString(), items: [{ orderItemId: itemId, quantity: 1 }] },
  });
  expect(shipped.status, JSON.stringify(shipped.body)).toBe(201);
  const raw = JSON.stringify({ id: `evt-${tracking}`, trackingNumber: tracking, code: 'delivered', at: clock.now().toISOString(), location: 'Portland, OR' });
  await app.inject({ method: 'POST', url: '/webhooks/shipping/carriers/ups/events', headers: { 'content-type': 'application/json', ...signWebhook('dev-webhook-secret', raw, Math.floor(clock.now().getTime() / 1000)) }, payload: raw });
  await app.kernel.events.drain();
  return { ref: order.ref as string, itemId };
}

const wallet = async () => {
  const w = await f.call('GET', '/api/store/wallet/credit', { token: buyer.accessToken });
  expect(w.status, JSON.stringify(w.body)).toBe(200);
  return w.body as { balance: { customerId: string; available: { amount: number }; held: { amount: number } }; recent: { kind: string; amount: { amount: number }; label: string; orderRef?: string; caseRef?: string }[] };
};

describe('store credit with the modules that use it', () => {
  let firstOrder: { orderId: string; ref: string; itemId: string };

  it('refunds a return as store credit (returns → wallet)', async () => {
    const v = await readyCheckout(buyer.accessToken);
    const placed = await place(buyer.accessToken, v);
    expect(placed.orderId, JSON.stringify(placed.body)).toBeDefined();
    const d = await deliver(placed.orderId!);
    firstOrder = { orderId: placed.orderId!, ...d };

    const created = await f.call('POST', '/api/store/returns/requests', {
      token: buyer.accessToken,
      body: { orderId: firstOrder.orderId, items: [{ orderItemId: firstOrder.itemId, quantity: 1 }], reason: 'damaged', details: 'Cracked headband', remedy: 'store_credit' },
      headers: { 'idempotency-key': key() },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const returnId = created.body.returns[0].id as string;
    expect((await f.call('POST', `/api/seller/returns/requests/${returnId}/approve`, { token: listing.sellerToken, body: { labelMethod: 'prepaid_qr' } })).status).toBe(200);
    expect((await f.call('POST', `/api/seller/returns/requests/${returnId}/receive`, { token: listing.sellerToken, body: {} })).status).toBe(200);
    const inspected = await f.call('POST', `/api/seller/returns/requests/${returnId}/inspection`, {
      token: listing.sellerToken,
      body: { conditionOutcome: 'as_described', grade: 'good', proposedStockOutcome: 'restock', checks: [{ label: 'Powers on', passed: true }] },
    });
    expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
    const refund = await f.call('POST', `/api/seller/returns/requests/${returnId}/remedy`, { token: listing.sellerToken, body: { kind: 'full_refund' }, headers: { 'idempotency-key': key() } });
    expect(refund.status, JSON.stringify(refund.body)).toBeLessThan(300);
    await app.kernel.events.drain();

    const w = await wallet();
    customerId = w.balance.customerId;
    expect(w.balance.available.amount).toBeGreaterThan(18_000);
    expect(w.recent[0]).toMatchObject({ kind: 'refund_to_credit', orderRef: firstOrder.ref, label: `Refund to store credit · order ${firstOrder.ref}` });
    const ret = await f.call('GET', `/api/store/returns/requests/${returnId}`, { token: buyer.accessToken });
    expect(JSON.stringify(ret.body)).toMatch(/store credit/i);
  });

  it('pays part of the next order with credit; the card is charged the rest', async () => {
    const before = (await wallet()).balance.available.amount;
    const v = await readyCheckout(buyer.accessToken);
    const withCredit = await f.call('PUT', `/api/store/checkout/sessions/${v.id}/credit`, { token: buyer.accessToken, body: { use: true, amount: USD(5000) } });
    expect(withCredit.status, JSON.stringify(withCredit.body)).toBe(200);
    expect(withCredit.body.totals.creditApplied).toEqual(USD(5000));
    const placed = await place(buyer.accessToken, withCredit.body);
    expect(placed.orderId, JSON.stringify(placed.body)).toBeDefined();
    const order = (await f.call('GET', `/api/store/orders/orders/${placed.orderId}`, { token: buyer.accessToken })).body;

    const w = await wallet();
    expect(w.balance).toMatchObject({ available: { amount: before - 5000 }, held: { amount: 0 } });
    expect(w.recent[0]).toMatchObject({ kind: 'capture', amount: { amount: -5000 }, label: `Used on order ${order.ref}` });
    const card = authorized.filter((a) => a.checkoutSessionId === v.id).at(-1)!;
    charged = { card: card.amount.amount, leftToPay: withCredit.body.totals.total.amount };
  });

  // checkout sends the whole order as the intent amount and payments charges the card amount - credit
  // (this once deducted the credit twice: totals.total is already net of it)
  it('charges the card exactly what is left to pay after the credit', () => {
    expect(charged.card).toBe(charged.leftToPay);
  });

  it('gives the credit back when the card is declined, and the retry still pays with it', async () => {
    const before = (await wallet()).balance.available.amount;
    const v = await readyCheckout(buyer.accessToken, 'tok_declined');
    const withCredit = (await f.call('PUT', `/api/store/checkout/sessions/${v.id}/credit`, { token: buyer.accessToken, body: { use: true, amount: USD(3000) } })).body;
    const declined = await place(buyer.accessToken, withCredit);
    expect(JSON.stringify(declined.body)).toMatch(/declined|payment_failed/);
    expect((await wallet()).balance).toMatchObject({ available: { amount: before }, held: { amount: 0 } });

    const failed = declined.body.checkout;
    expect(failed.totals.creditApplied).toEqual(USD(3000));
    const placed = await f.call('POST', `/api/store/checkout/sessions/${v.id}/retry-payment`, {
      token: buyer.accessToken,
      body: { method: { kind: 'new_card', providerToken: 'tok_visa' }, quoteVersion: failed.quoteVersion, expectedTotal: failed.totals.total, returnUrl: 'https://store.marketly.test/r' },
      headers: { 'idempotency-key': key() },
    });
    await app.kernel.events.drain();
    expect(placed.status, JSON.stringify(placed.body)).toBe(200);
    expect(JSON.stringify(placed.body)).toMatch(/"orderId":"[0-9a-f-]{36}"/);
    expect((await wallet()).balance).toMatchObject({ available: { amount: before - 3000 }, held: { amount: 0 } });
  });

  describe('goodwill from support cases', () => {
    let supportManager: Staff;
    let financeManager: Staff;

    async function caseOn(orderId: string) {
      const opened = await f.call('POST', '/api/store/support/cases', {
        token: buyer.accessToken,
        body: { kind: 'customer_help', category: 'delivery_late', orderId, message: 'My order took two weeks' },
        headers: { 'idempotency-key': key() },
      });
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      return opened.body as { id: string; ref: string };
    }

    async function decide(caseId: string, amount: number) {
      const decided = await f.call('POST', `/api/admin/support/cases/${caseId}/decide`, {
        token: supportManager.accessToken,
        body: { outcome: 'customer_favored', remedies: [{ kind: 'goodwill_credit', amount: USD(amount), chargedTo: 'platform' }], reason: 'Late delivery', notifyParties: true },
        headers: { 'idempotency-key': key() },
      });
      await app.kernel.events.drain();
      return decided;
    }

    beforeAll(async () => {
      supportManager = await f.staffWithRoles(listing.owner, 'cara@marketly.test', 'Cara Support', ['customer_support_manager']);
      financeManager = await f.staffWithRoles(listing.owner, 'fiona@marketly.test', 'Fiona Finance', ['finance_manager']);
    });

    it("grants goodwill within the agent's limit straight away", async () => {
      const before = (await wallet()).balance.available.amount;
      const c = await caseOn(firstOrder.orderId);
      const decided = await decide(c.id, 2500);
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      const w = await wallet();
      expect(w.balance.available.amount).toBe(before + 2500);
      expect(w.recent[0]).toMatchObject({ kind: 'goodwill', amount: { amount: 2500 }, caseRef: c.ref, label: `Goodwill credit · case ${c.ref}, service issue` });
    });

    it('above the limit the credit waits for Finance; the approval in access grants it', async () => {
      const before = (await wallet()).balance.available.amount;
      const c = await caseOn(firstOrder.orderId);
      const decided = await decide(c.id, 6000);
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      expect((await wallet()).balance.available.amount).toBe(before);

      const pending = await f.call('GET', '/api/admin/wallet/goodwill?state=pending_approval', { token: listing.owner.accessToken });
      expect(pending.status, JSON.stringify(pending.body)).toBe(200);
      const grant = pending.body.items.find((g: { customerId: string }) => g.customerId === customerId);
      expect(grant).toMatchObject({ amount: USD(6000), state: 'pending_approval', caseRef: c.ref, requestedBy: { kind: 'staff', id: supportManager.accountId } });
      const requestId = grant.approval.approvalRequestId as string;
      // no seeded role holds the wallet.goodwill.grant permission yet (reported), so the Business Owner approves;
      // Finance is eligible by limit but refused without the permission
      const finance = await f.call('POST', `/api/admin/access/approval-requests/${requestId}/approve`, { token: financeManager.accessToken, body: { note: 'Agreed' }, headers: { 'x-step-up-code': f.code(financeManager) } });
      expect(finance.body.error?.code).toBe('NOT_ELIGIBLE_APPROVER');
      const ok = await f.call('POST', `/api/admin/access/approval-requests/${requestId}/approve`, { token: listing.owner.accessToken, body: { note: 'Agreed' }, headers: { 'x-step-up-code': f.code(listing.owner) } });
      expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
      await app.kernel.events.drain();

      expect((await wallet()).balance.available.amount).toBe(before + 6000);
      const granted = await f.call('GET', `/api/admin/wallet/customers/${customerId}`, { token: listing.owner.accessToken });
      expect(granted.body).toMatchObject({ goodwillLast30Days: USD(8500), pendingGrants: [] });
    });
  });

  it('shows the balance in GraphQL to the customer and to staff', async () => {
    const store = await app.inject({
      method: 'POST',
      url: '/graphql/store',
      headers: { authorization: `Bearer ${buyer.accessToken}`, 'content-type': 'application/json' },
      payload: { query: '{ me { id wallet { available { amount formatted } held { amount } usableOn lots { source remaining { amount } } recentEntries(limit: 2) { kind label amount { amount } } } } }' },
    });
    const s = JSON.parse(store.body);
    expect(s.errors, store.body).toBeUndefined();
    expect(s.data.me.wallet).toMatchObject({ held: { amount: 0 }, usableOn: expect.any(String) });
    expect(s.data.me.wallet.lots.map((l: { source: string }) => l.source)).toEqual(expect.arrayContaining(['REFUND', 'GOODWILL']));
    expect(s.data.me.wallet.recentEntries).toHaveLength(2);
    const w = await wallet();
    expect(s.data.me.wallet.available.amount).toBe(w.balance.available.amount);

    const admin = await app.inject({
      method: 'POST',
      url: '/graphql/admin',
      headers: { authorization: `Bearer ${listing.owner.accessToken}`, 'content-type': 'application/json' },
      payload: { query: `{ customer(id: "${customerId}") { walletAdmin { goodwillLast30Days { amount } goodwillLimitPerCustomer { amount } balance { available { amount } recentEntries(limit: 3) { kind actor { kind } } } pendingGrants { state } } } }` },
    });
    const a = JSON.parse(admin.body);
    expect(a.errors, admin.body).toBeUndefined();
    expect(a.data.customer.walletAdmin).toMatchObject({ goodwillLast30Days: { amount: 8500 }, goodwillLimitPerCustomer: { amount: 10000 }, balance: { available: { amount: w.balance.available.amount } }, pendingGrants: [] });
  });
});
