/**
 * Test harness for farm: the module with real payments (the development card processor: tok_visa approves,
 * tok_declined declines, tok_3ds asks for a bank challenge; a capture of an amount ending in 22 fails), and the
 * answers a test controls stubbed: departments.getFarmMachine → `k.machines`, customers.customerLocation →
 * `k.locations`, customers.geocodeAddress → `k.zips` by postal code (else null), customers.getAddressForOrder → ADDRESS
 * for ADDRESS_ID only, customers.getCustomer → `k.names`, audit.record → recorded, settings → `k.settingsValues`.
 * The clock starts on Wednesday 2030-01-09 at noon in the market zone (America/Los_Angeles).
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type * as departments from '../../../spec/departments.js';
import type * as search from '../../../spec/search.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';

export { auth, callers, newId };

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type Point = { lat: number; lng: number };
export interface Kit {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  names: Map<string, string>;
  machines: Map<string, departments.FarmMachine>;
  locations: Map<string, Point>;
  zips: Map<string, Point>;
  audits: audit.RecordInput[];
  events: { name: string; payload: any }[];
  settingsValues: Record<string, unknown>;
  staff(permissions?: string[]): Record<string, string>;
  customer(accountId: string): Record<string, string>;
  call(method: Method, url: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  admin(method: Method, path: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  store(method: Method, path: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
}

/** Wednesday 2030-01-09, 12:00 in Los Angeles */
export const START = new Date('2030-01-09T20:00:00Z');
export const TODAY = '2030-01-09';
export const ADDRESS_ID = '0190a000-0000-7000-8000-000000000001';
export const ADDRESS: common.Address = { name: 'Dana Ross', line1: '4410 County Rd 12', city: 'Canby', region: 'OR', postalCode: '97013', country: 'US', phone: '503-555-0101' };

/** ZIP centroids the geocoder stub knows */
export const PORTLAND: Point = { lat: 45.5152, lng: -122.6784 }; // 97204
export const HILLSBORO: Point = { lat: 45.5229, lng: -122.9898 }; // 97123
export const CANBY: Point = { lat: 45.2629, lng: -122.6926 }; // 97013
export const SALEM: Point = { lat: 44.9429, lng: -123.0351 }; // 97301

export async function boot(): Promise<Kit> {
  const clock = movingClock();
  clock.set(START);
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 30 * 86_400;
  const k = {
    clock,
    names: new Map<string, string>(),
    machines: new Map<string, departments.FarmMachine>(),
    locations: new Map<string, Point>(),
    zips: new Map<string, Point>([
      ['97204', PORTLAND],
      ['97123', HILLSBORO],
      ['97013', CANBY],
      ['97301', SALEM],
    ]),
    audits: [] as audit.RecordInput[],
    events: [] as { name: string; payload: any }[],
    settingsValues: {} as Record<string, unknown>,
  };
  const app = await buildTestApp({
    only: ['farm', 'payments'],
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      departments: {
        getFarmMachine: async (productId: string) => {
          const m = k.machines.get(productId);
          if (!m) throw new AppError('NOT_FOUND', 'Machine not found');
          return structuredClone(m);
        },
        // The type of each picked machine, named after its id ("tractors" → "Tractors"), as the department would
        farmMachineTypes: async (productIds: string[]) => {
          const out: Record<string, departments.FarmMachineType> = {};
          for (const id of productIds) {
            const typeId = k.machines.get(id)?.typeId;
            if (typeId) out[id] = { typeId, typeName: typeId.charAt(0).toUpperCase() + typeId.slice(1) };
          }
          return out;
        },
      },
      customers: {
        getCustomer: async (id: string) => (k.names.has(id) ? ({ id, userId: id, ref: 'CU-1', displayName: k.names.get(id)!, email: 'dana@example.com', accountStatus: 'active', canOrder: true, canMessage: true } as never) : null),
        getAddressForOrder: async (_customerId: string, addressId: string) => {
          if (addressId !== ADDRESS_ID) throw new AppError('NOT_FOUND', 'Address not found');
          return { ...ADDRESS };
        },
        searchCustomers: (async () => ({ items: [], nextCursor: null })) as never,
        getCustomerByUserId: async () => null,
        customerLocation: async (customerId: string) => {
          const p = k.locations.get(customerId);
          return p ? { point: p, city: 'Portland', region: 'OR', addressId: ADDRESS_ID, label: '1120 SW 5th Ave', precision: 'zip' as const } : null;
        },
        geocodeAddress: async (a: { postalCode?: string }) => (a.postalCode ? (k.zips.get(a.postalCode) ?? null) : null),
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
  for (const name of ['farm.order.placed', 'farm.order.status_changed', 'payments.purchase.captured', 'payments.purchase.voided'] as const) app.kernel.events.subscribe('test', name, (e) => void k.events.push({ name, payload: e.payload }));
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
    admin: (method: Method, path: string, payload?: unknown, headers?: Record<string, string>) => call(method, `/api/admin/farm${path}`, payload, headers ?? staff()),
    store: (method: Method, path: string, payload?: unknown, headers?: Record<string, string>) => call(method, `/api/store/farm${path}`, payload, headers ?? auth(callers.visitor())),
  }) as Kit;
}

export const usd = (amount: number) => ({ amount, currency: 'USD' });

/** A product card as search answers it */
export function card(title: string, price: number, over: Partial<search.ProductCard> = {}): search.ProductCard {
  return {
    productId: newId(),
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    title,
    brandName: null,
    image: null,
    rating: null,
    ratingCount: 0,
    price: usd(price),
    priceIsFrom: false,
    sellerName: 'Marketly',
    official: true,
    condition: 'new',
    freeDelivery: true,
    availability: 'in_stock',
    offerCount: 1,
    badges: [],
    ...over,
  } as search.ProductCard;
}

/** A Kubota tractor ($18,900) with a front loader (+$3,200), a tiller (+$1,850) and a rear blade (+$640) */
export function tractor(k: Kit, over: { price?: number; availability?: search.ProductCard['availability'] } = {}) {
  const loader = card('Front loader LA344', 320_000);
  const tiller = card('Rotary tiller, 5 ft', 185_000);
  const blade = card('Rear blade, 6 ft', 64_000);
  const product = card('Kubota L2502 compact tractor', over.price ?? 1_890_000, over.availability ? { availability: over.availability } : {});
  const machine: departments.FarmMachine = { product, typeId: 'tractors', highlights: ['25 hp', '4WD'], attachments: [loader, tiller, blade] };
  k.machines.set(product.productId, machine);
  return { machine, product, loader, tiller, blade };
}

/** A dealer made through the Admin API */
export async function dealer(k: Kit, over: Record<string, unknown> = {}) {
  const res = await k.admin('POST', '/dealers', { name: 'Greenfield Agri Equipment', address: { line1: 'Route 9', city: 'Canby', region: 'OR', postalCode: '97013' }, hours: 'Mon–Sat 7:00–18:00', phone: '(503) 555-0142', messagePhone: '(503) 555-0143', ...over });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body;
}
