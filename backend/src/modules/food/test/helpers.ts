/**
 * Test harness for food: the module with real media and payments (the development card processor: tok_visa approves,
 * tok_declined declines, tok_3ds asks for a bank challenge, tok_pending stays unanswered; a capture of an amount
 * ending in 22 fails), and the answers a test controls stubbed: customers.getCustomer → `k.names`,
 * customers.getAddressForOrder → ADDRESS for ADDRESS_ID only, customers.customerLocation → `k.locations` (by customer id),
 * customers.geocodeAddress → `k.places` (by postal code, then "City, ST"; calls in `k.geocodes`, throws while `k.geocoderDown`),
 * audit.record → recorded, settings → `k.settingsValues`.
 * The clock starts on a Wednesday at noon in the market zone (America/Los_Angeles).
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type { GeoPoint } from '../../../kernel/lib/geo.js';
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
  locations: Map<string, GeoPoint>;
  places: Map<string, GeoPoint>;
  geocodes: { line1?: string; city: string; region: string; postalCode?: string }[];
  geocoderDown: boolean;
  staff(permissions?: string[]): Record<string, string>;
  customer(accountId: string): Record<string, string>;
  call(method: Method, url: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  admin(method: Method, path: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  store(method: Method, path: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
}

/** Wednesday 2030-01-09, 12:00 in Los Angeles */
export const START = new Date('2030-01-09T20:00:00Z');
export const ADDRESS_ID = '0190a000-0000-7000-8000-000000000001';
/** Pioneer Courthouse Square and the Pearl District (97209), Portland */
export const DOWNTOWN: GeoPoint = { lat: 45.5189, lng: -122.6793 };
export const PEARL: GeoPoint = { lat: 45.5311, lng: -122.6848 };
export const ADDRESS: common.Address = { name: 'Dana Ross', line1: '12 Pine St', city: 'Portland', region: 'OR', postalCode: '97201', country: 'US', phone: '503-555-0101' };

export async function boot(): Promise<Kit> {
  const clock = movingClock();
  clock.set(START);
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 3 * 86_400;
  const k = { clock, names: new Map<string, string>(), audits: [] as audit.RecordInput[], events: [] as { name: string; payload: any }[], settingsValues: {} as Record<string, unknown>, locations: new Map<string, GeoPoint>(), places: new Map<string, GeoPoint>([['Portland, OR', DOWNTOWN], ['97209', PEARL]]), geocodes: [] as Kit['geocodes'], geocoderDown: false };
  const app = await buildTestApp({
    only: ['food', 'media', 'payments'],
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      customers: {
        getCustomer: async (id: string) => (k.names.has(id) ? ({ id, userId: id, ref: 'CU-1', displayName: k.names.get(id)!, email: 'dana@example.com', accountStatus: 'active', canOrder: true, canMessage: true } as never) : null),
        getAddressForOrder: async (_customerId: string, addressId: string) => {
          if (addressId !== ADDRESS_ID) throw new AppError('NOT_FOUND', 'Address not found');
          return { ...ADDRESS };
        },
        searchCustomers: (async () => ({ items: [], nextCursor: null })) as never,
        customerLocation: async (id: string) => (k.locations.has(id) ? { point: k.locations.get(id)!, city: 'Portland', region: 'OR', addressId: ADDRESS_ID, label: '12 Pine St', precision: 'zip' as const } : null),
        geocodeAddress: async (input) => {
          k.geocodes.push(input);
          if (k.geocoderDown) throw new Error('geocoder down');
          return (input.postalCode ? k.places.get(input.postalCode) : undefined) ?? k.places.get(`${input.city}, ${input.region}`) ?? null;
        },
      },
      audit: {
        record: async (entry) => {
          k.audits.push(entry);
          return newId();
        },
      },
      settings: { get: (async (key: string) => k.settingsValues[key] ?? null) as never },
    },
  });
  app.kernel.events.subscribe('test', 'food.order.status_changed', (e) => void k.events.push({ name: 'food.order.status_changed', payload: e.payload }));
  const staffId = newId();
  const staff = (permissions?: string[]) => auth(callers.staff(permissions, { sub: staffId, name: 'Sam Staff' } as never));
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
    admin: (method: Method, path: string, payload?: unknown, headers?: Record<string, string>) => call(method, `/api/admin/food${path}`, payload, headers ?? staff()),
    store: (method: Method, path: string, payload?: unknown, headers?: Record<string, string>) => call(method, `/api/store/food${path}`, payload, headers ?? auth(callers.visitor())),
  }) as Kit;
}

export const usd = (amount: number) => ({ amount, currency: 'USD' });
/** Every day 11:00–23:00 */
export const LUNCH_TO_LATE = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((weekday) => ({ weekday, open: true, from: '11:00', to: '23:00' }));
export const SIZE_GROUP = {
  id: 'size',
  name: 'Size',
  required: true,
  min: 1,
  max: 1,
  choices: [
    { id: 'personal', name: '10" personal', priceDelta: usd(-300), default: false, available: true },
    { id: 'regular', name: '12" regular', priceDelta: usd(0), default: true, available: true },
    { id: 'family', name: '16" family', priceDelta: usd(600), default: false, available: true },
  ],
};
export const EXTRAS_GROUP = {
  id: 'extras',
  name: 'Extras',
  required: false,
  min: 0,
  max: 4,
  choices: [
    { id: 'mozzarella', name: 'Extra mozzarella', priceDelta: usd(240), default: false, available: true },
    { id: 'basil', name: 'Fresh basil', priceDelta: usd(150), default: false, available: true },
    { id: 'olives', name: 'Black olives', priceDelta: usd(120), default: false, available: true },
    { id: 'chili', name: 'Chili oil', priceDelta: usd(80), default: false, available: true },
  ],
};
