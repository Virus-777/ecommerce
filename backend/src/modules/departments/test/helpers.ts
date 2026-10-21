/**
 * Test harness for departments: the module with real media (uploads through media's HTTP API), and the answers a
 * test controls stubbed: search.getProductCards → cards from `k.cards` (missing ids are not shown);
 * customers.getCustomerByUserId → `k.names`; audit.record → recorded; settings → `k.settingsValues`.
 */
import type { FastifyInstance } from 'fastify';
import { newId } from '../../../kernel/lib/ids.js';
import type * as audit from '../../../spec/audit.js';
import type * as search from '../../../spec/search.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';

export { auth, callers, newId };

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export interface Kit {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  cards: Map<string, search.ProductCard>;
  names: Map<string, string>;
  audits: audit.RecordInput[];
  /** Setting overrides by full key ('departments.blogRepliesOpen'); the spec default applies otherwise */
  settingsValues: Record<string, unknown>;
  staff(permissions?: string[]): Record<string, string>;
  customer(accountId: string): Record<string, string>;
  visitor(): Record<string, string>;
  call(method: Method, url: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  admin(method: Method, path: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  store(method: Method, path: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  card(over?: Partial<search.ProductCard>): search.ProductCard;
  uploadImage(): Promise<{ id: string; url: string }>;
}

export async function boot(): Promise<Kit> {
  const clock = movingClock();
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 3600;
  const k = { clock, cards: new Map<string, search.ProductCard>(), names: new Map<string, string>(), audits: [] as audit.RecordInput[], settingsValues: {} as Record<string, unknown> };
  const app = await buildTestApp({
    only: ['departments', 'media'],
    clock,
    config: { rateLimits: false },
    apiStubs: {
      search: { getProductCards: async (ids: string[]) => ids.map((id) => k.cards.get(id)).filter((c): c is search.ProductCard => Boolean(c)) },
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
  // one staff account, so its uploads are its own
  const staffId = newId();
  const staff = (permissions?: string[]) => auth(callers.staff(permissions, { sub: staffId } as never));
  const call: Kit['call'] = async (method, url, payload, headers) => {
    const res = await app.inject({ method, url, headers: { ...(headers ?? staff()), 'idempotency-key': newId() }, ...(payload !== undefined ? { payload: payload as never } : {}) });
    await app.kernel.events.drain();
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  let seq = 0;
  return Object.assign(k, {
    app,
    staff,
    customer: (accountId: string) => auth(callers.customer({ accountId })),
    visitor: () => auth(callers.visitor()),
    call,
    admin: (method: Method, path: string, payload?: unknown, headers?: Record<string, string>) => call(method, `/api/admin/departments${path}`, payload, headers ?? staff()),
    store: (method: Method, path: string, payload?: unknown, headers?: Record<string, string>) => call(method, `/api/store/departments${path}`, payload, headers ?? auth(callers.visitor())),
    card: (over: Partial<search.ProductCard> = {}) => {
      seq++;
      return { productId: newId(), slug: `phone-${seq}`, title: `Phone ${seq}`, brandName: 'Pixel', image: null, rating: 4.5, ratingCount: 10, price: { amount: 49999, currency: 'USD' }, priceIsFrom: false, offerId: newId(), sellerName: 'Official Store', sellerId: null, official: true, condition: 'new', wasPrice: null, discountPct: null, freeDelivery: true, availability: 'in_stock', offerCount: 1, badges: [], ...over } as search.ProductCard;
    },
    uploadImage: async () => {
      const body = png(1200, 675, newId());
      const req = { purpose: 'content_image', fileName: 'cover.png', contentType: 'image/png', sizeBytes: body.length };
      const res = await app.inject({ method: 'POST', url: '/api/admin/media/uploads', headers: staff(), payload: { upload: req } });
      if (res.statusCode !== 201) throw new Error(`upload failed: ${res.statusCode} ${res.body}`);
      const ticket = res.json() as { uploadId: string; assetId: string; url: string; headers: Record<string, string> };
      const media = app.kernel.boot.apis.get('media') as unknown as { providers: { storage: { acceptSignedPut(url: string, body: Uint8Array, type?: string): Promise<unknown> } } };
      await media.providers.storage.acceptSignedPut(ticket.url, body, ticket.headers['content-type']);
      const done = await app.inject({ method: 'POST', url: `/api/admin/media/uploads/${ticket.uploadId}/complete`, headers: staff() });
      if (done.statusCode !== 202) throw new Error(`complete failed: ${done.statusCode} ${done.body}`);
      await app.kernel.jobs.runNow('media.process');
      await app.kernel.events.drain();
      return { id: ticket.assetId, url: 'https://cdn.example.com/placeholder.png' };
    },
  }) as Kit;
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const chunk = (type: string, data: Buffer) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
const png = (w: number, hgt: number, seed: string) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.concat([u32(w), u32(hgt), Buffer.from([8, 2, 0, 0, 0])])), chunk('IDAT', Buffer.from(seed, 'latin1')), chunk('IEND', Buffer.alloc(0))]);
