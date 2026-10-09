import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { unzip, zip } from '../domain/zip.js';
import { ADMIN, boot, STORE, type Kit } from './helpers.js';

/** Stand-ins for modules not built yet (orders, support): what they answer is set per test */
const world = { inProgress: 0, openCases: 0, ordersBroken: false };
const closeAccount = vi.fn(async () => {});

let kit: Kit;
beforeAll(async () => {
  kit = await boot({
    only: ['media', 'orders', 'support'],
    apiStubs: {
      orders: {
        countInProgress: async () => ({ inProgress: world.inProgress, delayedPackages: 0 }),
        listOrdersForCustomer: async () => {
          if (world.ordersBroken) throw new Error('orders database unavailable');
          return { items: [{ id: 'order-1' } as never], nextCursor: null };
        },
        getOrder: async () => null,
      },
      support: {
        listOpenCasesForCustomer: async () => ({ items: [], total: world.openCases }),
        listCasesForCustomer: async () => ({ items: [], nextCursor: null }),
      },
      identity: { closeAccount },
    },
  });
});
afterAll(() => kit.app.close());

const DAY = 86_400_000;

describe('zip', () => {
  it('round-trips stored entries', () => {
    const z = zip([{ name: 'a.json', data: '{"x":1}' }, { name: 'b/ü.txt', data: Buffer.from('héllo') }], new Date('2026-10-09T10:00:00Z'));
    expect(z.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(unzip(z).map((e) => [e.name, e.data.toString()])).toEqual([
      ['a.json', '{"x":1}'],
      ['b/ü.txt', 'héllo'],
    ]);
  });
});

describe('data export', () => {
  it('requested → processing → ready (signed link) → expired', async () => {
    const c = await kit.customer();
    const res = await kit.call('POST', `${STORE}/data-requests/exports`, { token: c.token });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ kind: 'export', state: 'requested', downloadUrl: null });
    expect(Date.parse(res.body.dueBy) - Date.parse(res.body.requestedAt)).toBe(48 * 3_600_000);
    expect(kit.of('customers.data_export.requested')).toContainEqual({ customerId: c.customerId, requestId: res.body.id });

    const again = await kit.call('POST', `${STORE}/data-requests/exports`, { token: c.token });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DATA_REQUEST_IN_PROGRESS');

    expect(await kit.service.buildDataExports()).toMatchObject({ built: 1 });
    await kit.drain();
    const ready = kit.of('customers.data_export.ready').find((e) => e.requestId === res.body.id);
    expect(ready).toBeTruthy();
    let list = (await kit.call('GET', `${STORE}/data-requests`, { token: c.token })).body;
    expect(list[0]).toMatchObject({ id: res.body.id, state: 'ready' });
    expect(list[0].downloadUrl).toMatch(/^https?:\/\//);

    // not the owner: no access to the request
    const other = await kit.customer();
    expect((await kit.call('POST', `${STORE}/data-requests/${res.body.id}/cancel`, { token: other.token })).status).toBe(404);

    kit.clock.advance(8 * DAY);
    await kit.app.kernel.jobs.runNow('customers.expire-export-links');
    list = (await kit.call('GET', `${STORE}/data-requests`, { token: c.token })).body;
    expect(list[0]).toMatchObject({ state: 'expired', downloadUrl: null });
  });

  it('a customer can cancel a requested export; a ready one cannot be cancelled (409)', async () => {
    const c = await kit.customer();
    const r = (await kit.call('POST', `${STORE}/data-requests/exports`, { token: c.token })).body;
    const cancelled = await kit.call('POST', `${STORE}/data-requests/${r.id}/cancel`, { token: c.token });
    expect(cancelled.body).toMatchObject({ state: 'cancelled' });
    const twice = await kit.call('POST', `${STORE}/data-requests/${r.id}/cancel`, { token: c.token });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('failed exports show in the privacy queue and staff can retry them', async () => {
    const c = await kit.customer();
    const r = (await kit.call('POST', `${STORE}/data-requests/exports`, { token: c.token })).body;
    world.ordersBroken = true;
    expect(await kit.service.buildDataExports()).toMatchObject({ failed: 1 });
    world.ordersBroken = false;
    const queue = await kit.call('GET', `${ADMIN}/data-requests?kind=export&state=failed`, { token: kit.staff(['customers.data-requests.manage']) });
    expect(queue.status).toBe(200);
    expect(queue.body.items.find((x: any) => x.request.id === r.id)).toMatchObject({ customerId: c.customerId, customerName: 'Ana Lopez', request: { state: 'failed' } });

    const retried = await kit.call('POST', `${ADMIN}/data-requests/${r.id}/retry`, { token: kit.staff() });
    expect(retried.body.state).toBe('processing');
    expect((await kit.call('POST', `${ADMIN}/data-requests/${r.id}/retry`, { token: kit.staff() })).status).toBe(409);
    await kit.service.buildDataExports();
    expect((await kit.call('GET', `${STORE}/data-requests`, { token: c.token })).body[0].state).toBe('ready');
  });
});

describe('account closure', () => {
  it('eligibility lists open obligations and blocks the request', async () => {
    const c = await kit.customer();
    world.inProgress = 2;
    world.openCases = 1;
    const e = await kit.call('GET', `${STORE}/closure-eligibility`, { token: c.token });
    expect(e.body).toMatchObject({ eligible: false, blockers: [{ kind: 'open_orders', count: 2 }, { kind: 'open_cases', count: 1 }] });
    expect(e.body.retainedRecords.length).toBeGreaterThan(0);
    const res = await kit.call('POST', `${STORE}/data-requests/closure`, { token: c.token, body: { reauthToken: 'dev-reauth.account-closure' } });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CLOSURE_BLOCKED', details: { blockers: [{ kind: 'open_orders' }, { kind: 'open_cases' }] } });
    world.inProgress = 0;
    world.openCases = 0;
  });

  it('needs a fresh re-auth token', async () => {
    const c = await kit.customer();
    const res = await kit.call('POST', `${STORE}/data-requests/closure`, { token: c.token, body: { reauthToken: 'nope' } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('STEP_UP_REQUIRED');
  });

  it('is scheduled after the cooling-off period, can be cancelled, and completes: closed, anonymised, identity told', async () => {
    const c = await kit.customer();
    await kit.call('POST', `${STORE}/addresses`, { token: c.token, body: { address: { name: 'Ana Lopez', line1: '1 Main St', city: 'Portland', region: 'OR', postalCode: '97201', country: 'US' } } });
    const first = await kit.call('POST', `${STORE}/data-requests/closure`, { token: c.token, body: { reauthToken: 'dev-reauth.account-closure', reason: 'Moving away' } });
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(Date.parse(first.body.scheduledFor) - Date.parse(first.body.requestedAt)).toBe(14 * DAY);
    expect(kit.of('customers.closure.requested')).toContainEqual({ customerId: c.customerId, requestId: first.body.id, scheduledFor: first.body.scheduledFor });
    const dup = await kit.call('POST', `${STORE}/data-requests/closure`, { token: c.token, body: { reauthToken: 'dev-reauth.account-closure' } });
    expect(dup.body.error.code).toBe('DATA_REQUEST_IN_PROGRESS');
    expect((await kit.call('POST', `${STORE}/data-requests/${first.body.id}/cancel`, { token: c.token })).body.state).toBe('cancelled');

    const r = (await kit.call('POST', `${STORE}/data-requests/closure`, { token: c.token, body: { reauthToken: 'dev-reauth.account-closure' } })).body;
    // before the date nothing happens
    await kit.service.completeClosures();
    expect((await kit.service.getCustomer(c.customerId))!.accountStatus).toBe('active');

    // a new obligation keeps it waiting
    kit.clock.advance(15 * DAY);
    world.inProgress = 1;
    expect(await kit.service.completeClosures()).toMatchObject({ completed: 0 });
    world.inProgress = 0;
    expect(await kit.service.completeClosures()).toMatchObject({ completed: 1 });
    await kit.drain();

    const snap = await kit.service.getCustomer(c.customerId);
    expect(snap).toMatchObject({ accountStatus: 'closed', canOrder: false, canMessage: false, displayName: 'Closed account', phone: null });
    expect(snap!.email).toMatch(/@deleted\.marketly\.invalid$/);
    expect(closeAccount).toHaveBeenCalledWith(c.accountId, expect.any(String));
    expect(kit.of('customers.account.closed')).toContainEqual({ customerId: c.customerId, userId: c.accountId });
    expect(kit.of('customers.account.status_changed')).toContainEqual({ customerId: c.customerId, from: 'active', to: 'closed', reasonCode: 'customer_request' });
    expect(await kit.service.getMarketingConsent(c.customerId)).toMatchObject({ emailPromotions: false, smsPromotions: false, pushPromotions: false });
    const requests = await kit.service.dataRequestsOf(c.customerId, null);
    expect(requests.find((x) => x.id === r.id)).toMatchObject({ state: 'completed' });
    const addresses = await kit.service.addressesOf(c.customerId);
    expect(addresses).toEqual([]);
  });
});
