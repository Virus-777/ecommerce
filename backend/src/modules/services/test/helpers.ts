/**
 * Test harness for services: the module with real media, and the answers a test controls stubbed:
 * customers.getCustomerByUserId → `k.names`; audit.record → recorded; settings → `k.settingsValues`. The clock is set
 * to a Monday morning in the market zone (America/Los_Angeles), so slots are in the future.
 */
import type { FastifyInstance } from 'fastify';
import { newId } from '../../../kernel/lib/ids.js';
import type * as audit from '../../../spec/audit.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';

export { auth, callers, newId };

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export interface Kit {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  names: Map<string, string>;
  audits: audit.RecordInput[];
  events: { name: string; payload: any }[];
  settingsValues: Record<string, unknown>;
  staff(permissions?: string[]): Record<string, string>;
  customer(accountId: string): Record<string, string>;
  call(method: Method, url: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  admin(method: Method, path: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  store(method: Method, path: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
}

/** Monday 2030-01-07, 08:00 in Los Angeles */
export const MONDAY = '2030-01-07';
export const START = new Date('2030-01-07T16:00:00Z');

export async function boot(): Promise<Kit> {
  const clock = movingClock();
  clock.set(START);
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 3600;
  const k = { clock, names: new Map<string, string>(), audits: [] as audit.RecordInput[], events: [] as { name: string; payload: any }[], settingsValues: {} as Record<string, unknown> };
  const app = await buildTestApp({
    only: ['services', 'media'],
    clock,
    config: { rateLimits: false },
    apiStubs: {
      customers: { getCustomerByUserId: async (id: string) => (k.names.has(id) ? ({ id, userId: id, ref: 'CU-1', displayName: k.names.get(id)!, email: 'a@example.com', accountStatus: 'active', canOrder: true, canMessage: true } as never) : null) },
      audit: {
        record: async (entry) => {
          k.audits.push(entry);
          return newId();
        },
      },
      settings: { get: (async (key: string) => k.settingsValues[key] ?? null) as never },
    },
  });
  app.kernel.events.subscribe('test', 'services.request.status_changed', (e) => void k.events.push({ name: 'services.request.status_changed', payload: e.payload }));
  const staffId = newId();
  const staff = (permissions?: string[]) => auth(callers.staff(permissions, { sub: staffId } as never));
  const call: Kit['call'] = async (method, url, payload, headers) => {
    const res = await app.inject({ method, url, headers: { 'idempotency-key': newId(), ...(headers ?? staff()) }, ...(payload !== undefined ? { payload: payload as never } : {}) });
    await app.kernel.events.drain();
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  return Object.assign(k, {
    app,
    staff,
    customer: (accountId: string) => auth(callers.customer({ accountId })),
    call,
    admin: (method: Method, path: string, payload?: unknown, headers?: Record<string, string>) => call(method, `/api/admin/services${path}`, payload, headers ?? staff()),
    store: (method: Method, path: string, payload?: unknown, headers?: Record<string, string>) => call(method, `/api/store/services${path}`, payload, headers ?? auth(callers.visitor())),
  }) as Kit;
}

/** Monday to Friday 9:00–12:00, closed at the weekend */
export const MORNINGS = { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((weekday, i) => (i < 5 ? { weekday, open: true, from: '09:00', to: '12:00' } : { weekday, open: false })), timeZone: 'America/Los_Angeles' };
