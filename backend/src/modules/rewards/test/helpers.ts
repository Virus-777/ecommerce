/**
 * Test harness for rewards: the module with real promotions (coupon campaigns and codes) and audit stubbed. customers
 * is stubbed: an account signs in as the customer `k.customerOf(accountId)` (a customers-module id other than the
 * account id), with names for the admin lists. The clock starts on Monday 2030-01-07, 08:00 in the market zone.
 */
import type { FastifyInstance } from 'fastify';
import { newId } from '../../../kernel/lib/ids.js';
import type * as audit from '../../../spec/audit.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';

export { newId };

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export interface Res {
  status: number;
  body: any;
}
export interface Kit {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  audits: audit.RecordInput[];
  events: { name: string; payload: any }[];
  /** customers-module id of an account (made up the first time) */
  customerOf(accountId: string): string;
  staff(permissions?: string[]): Record<string, string>;
  call(method: Method, url: string, payload?: unknown, headers?: Record<string, string>): Promise<Res>;
  admin(method: Method, path: string, payload?: unknown, headers?: Record<string, string>): Promise<Res>;
  store(accountId: string, method: Method, path: string, payload?: unknown, headers?: Record<string, string>): Promise<Res>;
  publish(name: string, payload: unknown): Promise<void>;
  /** A coupon campaign live now (create → submit → confirm funding → schedule through the promotions admin API) */
  couponCampaign(over?: Record<string, unknown>): Promise<{ id: string; status: string; period: { endsAt: string } }>;
  /** Moves the clock a number of days ahead */
  days(n: number): void;
}

export const START = new Date('2030-01-07T16:00:00Z');
export const usd = (dollars: number) => ({ amount: Math.round(dollars * 100), currency: 'USD' });

export async function boot(): Promise<Kit> {
  const clock = movingClock();
  clock.set(START);
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 3600;
  const customers = new Map<string, string>();
  const people = new Map<string, { name: string; email: string }>();
  const customerOf = (accountId: string) => {
    if (!customers.has(accountId)) {
      const id = newId();
      customers.set(accountId, id);
      people.set(id, { name: `Customer ${customers.size}`, email: `customer${customers.size}@example.com` });
    }
    return customers.get(accountId)!;
  };
  const snapshot = (id: string) => (people.has(id) ? ({ id, userId: id, ref: 'CU-1', displayName: people.get(id)!.name, email: people.get(id)!.email, accountStatus: 'active', canOrder: true, canMessage: true } as never) : null);
  const k = { clock, audits: [] as audit.RecordInput[], events: [] as { name: string; payload: any }[], customerOf };
  const app = await buildTestApp({
    only: ['rewards'],
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      customers: {
        getCustomerByUserId: async (accountId: string) => snapshot(customerOf(accountId)),
        getCustomer: async (id: string) => snapshot(id),
        searchCustomers: (async (f: { search?: string }) => {
          const q = f.search?.toLowerCase() ?? '';
          const items = [...people.keys()].filter((id) => people.get(id)!.email.includes(q) || people.get(id)!.name.toLowerCase().includes(q)).map(snapshot);
          return { items, nextCursor: null };
        }) as never,
      },
      access: {
        check: (async (_p: unknown, action: string) => ({ decision: 'allowed', action, reason: 'Within your limit', requiresSecondReviewer: false, approvalsNeeded: 0, eligibleApproverRoles: [], eligibleApprovers: [] })) as never,
      },
      audit: {
        record: async (entry) => {
          k.audits.push(entry);
          return newId();
        },
      },
    },
  });
  app.kernel.events.subscribe('test', 'rewards.reward.redeemed', (e) => void k.events.push({ name: 'rewards.reward.redeemed', payload: e.payload }));
  const staffId = newId();
  const financeId = newId();
  const staff = (permissions?: string[]) => auth(callers.staff(permissions, { sub: staffId } as never));
  const call: Kit['call'] = async (method, url, payload, headers) => {
    const res = await app.inject({ method, url, headers: { 'idempotency-key': newId(), ...(headers ?? staff()) }, ...(payload !== undefined ? { payload: payload as never } : {}) });
    await app.kernel.events.drain();
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  const couponCampaign: Kit['couponCampaign'] = async (over = {}) => {
    const now = clock.now().getTime();
    const created = await call('POST', '/api/admin/promotions/campaigns', {
      name: `Daily rewards ${newId().slice(-6)}`,
      description: '$5 off orders over $50',
      discount: { kind: 'fixed_coupon', amountOff: usd(5), minSpend: usd(50) },
      autoApply: false,
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 60 * 86_400_000).toISOString(),
      timeZone: 'America/Los_Angeles',
      scope: { mode: 'sitewide', include: [], exclude: [] },
      eligibility: { audience: 'signed_in' },
      limits: { budget: usd(5000) },
      funding: { owner: 'platform', costCenter: 'MKT-REWARDS' },
      stacking: { withSellerMarkdowns: true, withOtherCoupons: false, withFreeShipping: true, withFlashSalePrices: false },
      ...over,
    });
    if (created.status !== 201) throw new Error(`campaign: ${JSON.stringify(created.body)}`);
    const id = created.body.id;
    for (const step of ['submit', 'confirm-funding', 'schedule']) {
      const r = await call('POST', `/api/admin/promotions/campaigns/${id}/${step}`, {}, step === 'confirm-funding' ? auth(callers.staff(undefined, { sub: financeId } as never)) : staff());
      if (r.status !== 200) throw new Error(`${step}: ${JSON.stringify(r.body)}`);
    }
    return (await call('GET', `/api/admin/promotions/campaigns/${id}`)).body;
  };
  return Object.assign(k, {
    app,
    staff,
    call,
    admin: (method: Method, path: string, payload?: unknown, headers?: Record<string, string>) => call(method, `/api/admin/rewards${path}`, payload, headers ?? staff()),
    store: (accountId: string, method: Method, path: string, payload?: unknown, headers?: Record<string, string>) => call(method, `/api/store/rewards${path}`, payload, { ...auth(callers.customer({ accountId })), ...(headers ?? {}) }),
    publish: async (name: string, payload: unknown) => {
      app.kernel.events.publish('test', name, payload, { actor: { kind: 'system', id: null } });
      await app.kernel.events.drain();
    },
    couponCampaign,
    days: (n: number) => clock.advance(n * 86_400_000),
  }) as Kit;
}
