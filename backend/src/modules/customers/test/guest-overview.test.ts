import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import type * as notifications from '../../../spec/notifications.js';
import { boot, STORE, type Kit } from './helpers.js';

const ORDER = { orderId: newId(), ref: 'MK-261009-48213', email: 'guest.buyer@example.com' };
const notify = vi.fn(async (_i: notifications.NotifyInput) => ({ noticeIds: [], deliveryIds: [] }));
const slow = { cases: false };

let kit: Kit;
beforeAll(async () => {
  kit = await boot({
    only: ['orders', 'support', 'messaging', 'notifications'],
    apiStubs: {
      orders: {
        findGuestOrder: async (ref, email) => (ref === ORDER.ref && email === ORDER.email ? { orderId: ORDER.orderId } : null),
        listGuestOrdersByEmail: async (email) => (email === ORDER.email ? [{ orderId: ORDER.orderId, ref: ORDER.ref, placedAt: new Date().toISOString() }] : []),
        countInProgress: async () => ({ inProgress: 2, delayedPackages: 1 }),
        listRecentForCustomer: async () => [
          {
            id: ORDER.orderId,
            ref: ORDER.ref,
            placedAt: new Date().toISOString(),
            status: { value: 'partly_shipped', flags: ['payment_checking'] },
            statusLabel: 'Partly shipped',
            total: { amount: 51398, currency: 'USD' },
            itemCount: 4,
            itemStates: { shipped: 3, accepted: 1 },
            sellerCount: 3,
            packageCount: 2,
            packages: [
              { label: 'Package 1', sellerName: 'A', status: 'Shipped', note: '' },
              { label: 'Package 2', sellerName: 'B', status: 'Delayed', note: '' },
            ],
            thumbnails: [],
            actions: ['view'],
          },
        ],
        listDelayedItemsForCustomer: async () => [{ orderId: ORDER.orderId, orderRef: ORDER.ref, groupId: newId(), title: 'Desk lamp', sellerName: 'Casa Verde Home', options: ['wait', 'cancel'] }],
      },
      support: {
        listOpenCasesForCustomer: async () => {
          if (slow.cases) await new Promise((r) => setTimeout(r, 1000));
          return { items: [], total: 0 };
        },
      },
      messaging: { unreadCount: async () => 4 },
      notifications: { notify },
    },
  });
});
afterAll(() => kit.app.close());

/** A real visitor session from identity's bootstrap endpoint (guest grants need it) */
async function guestSession() {
  const res = await kit.call('POST', '/api/public/identity/app-sessions', { headers: { 'x-app-proof': 'dev' }, body: { audience: 'store', device: { kind: 'android', name: 'Pixel', appVersion: '1.0.0', installationId: `inst-${newId()}` } } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { sessionId: string; accessToken: string };
}

describe('guest order lookup', () => {
  it('grants the caller’s guest session access to the order through identity', async () => {
    const v = await guestSession();
    const res = await kit.call('POST', `${STORE}/guest-orders/lookup`, { token: v.accessToken, body: { orderRef: ORDER.ref.toLowerCase(), email: 'Guest.Buyer@Example.com' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ orderId: ORDER.orderId, orderRef: ORDER.ref, granted: true, canCreateAccount: true });
    const identity = kit.service.core.deps.ctx.use('identity');
    expect(await identity.hasGuestOrderAccess(v.sessionId, ORDER.orderId)).toBe(true);
  });

  it('answers the same not-found for a wrong reference or a wrong email, and limits attempts', async () => {
    const v = await guestSession();
    const wrongRef = await kit.call('POST', `${STORE}/guest-orders/lookup`, { token: v.accessToken, body: { orderRef: 'MK-000000-00000', email: ORDER.email } });
    const wrongEmail = await kit.call('POST', `${STORE}/guest-orders/lookup`, { token: v.accessToken, body: { orderRef: ORDER.ref, email: 'someone@example.com' } });
    expect([wrongRef.status, wrongEmail.status]).toEqual([404, 404]);
    expect(wrongRef.body.error).toEqual(wrongEmail.body.error);
    expect(wrongRef.body.error.code).toBe('GUEST_ORDER_NOT_FOUND');
    let last = wrongEmail;
    for (let i = 0; i < 12 && last.status !== 429; i++) {
      last = await kit.call('POST', `${STORE}/guest-orders/lookup`, { token: v.accessToken, body: { orderRef: 'MK-000000-00001', email: 'probe@example.com' } });
    }
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('RATE_LIMITED');
    kit.clock.advance(61 * 60_000);
  });

  it('emails fresh order links and always answers 202', async () => {
    const res = await kit.call('POST', `${STORE}/guest-orders/links`, { token: kit.token('visitor'), body: { email: ORDER.email } });
    expect(res.status).toBe(202);
    expect(notify).toHaveBeenCalledTimes(1);
    const input = notify.mock.calls[0]![0];
    expect(input).toMatchObject({ topic: 'customer.order.guest_link', recipients: [{ kind: 'guest_email', email: ORDER.email }], link: { kind: 'order', id: ORDER.orderId } });
    expect((input.context as any).guest.url).toMatch(/#token=/);
    const unknown = await kit.call('POST', `${STORE}/guest-orders/links`, { token: kit.token('visitor'), body: { email: 'nobody@example.com' } });
    expect(unknown.status).toBe(202);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('account overview', () => {
  it('aggregates the sources it can reach and lists the rest as unavailable', async () => {
    const c = await kit.customer();
    const res = await kit.call('GET', `${STORE}/overview`, { token: c.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const o = res.body;
    expect(o.customer).toMatchObject({ firstName: 'Ana', displayName: 'Ana Lopez', email: c.email });
    expect(o.tiles).toEqual([
      { key: 'orders_in_progress', count: 2, note: '1 package delayed', available: true },
      { key: 'open_returns', count: null, available: false },
      { key: 'unread_messages', count: 4, available: true },
      { key: 'store_credit', amount: null, available: false },
    ]);
    expect(o.alerts.map((a: any) => a.kind)).toEqual(['item_delayed', 'payment_being_checked']);
    expect(o.recentOrders[0]).toMatchObject({ ref: ORDER.ref, packageCount: 2, itemStates: { shipped: 3, accepted: 1 } });
    expect(o.menuCounts).toEqual({ 'account/orders': 2, 'account/messages': 4 });
    expect(o.unavailable.sort()).toEqual(['open_returns', 'store_credit']);
  });

  it('a source slower than overviewSourceTimeoutMs is reported, not awaited', async () => {
    const c = await kit.customer();
    slow.cases = true;
    const t0 = Date.now();
    const res = await kit.call('GET', `${STORE}/overview`, { token: c.token });
    slow.cases = false;
    expect(Date.now() - t0).toBeLessThan(900);
    expect(res.body.unavailable).toContain('open_cases');
  });
});
