/**
 * Test harness for departments: the module with real media (uploads through media's HTTP API), and the answers a
 * test controls stubbed: search.getProductCards → cards from `k.cards` (missing ids are not shown);
 * catalog.getProduct → `k.products` (the phone picks import);
 * customers.getCustomerByUserId / getCustomer / searchCustomers → `k.names` (canWriteReviews refuses `k.blocked`);
 * promotions coupon campaigns → `k.campaigns` (issueCode records `k.issued`, the same key gives the same code);
 * audit.record → recorded; settings → `k.settingsValues`.
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as audit from '../../../spec/audit.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as search from '../../../spec/search.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';

export { auth, callers, newId };

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export interface Kit {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  cards: Map<string, search.ProductCard>;
  products: Map<string, catalog.Product>;
  names: Map<string, string>;
  /** Customer emails (customers.searchCustomers matches names and emails); a@example.com otherwise */
  emails: Map<string, string>;
  audits: audit.RecordInput[];
  /** Setting overrides by full key ('departments.blogRepliesOpen'); the spec default applies otherwise */
  settingsValues: Record<string, unknown>;
  /** Coupon campaigns promotions knows: active, or not (reason), and their names */
  campaigns: Map<string, { name: string; active: boolean; reason?: string }>;
  /** Codes promotions.issueCode gave, by idempotency key */
  issued: Map<string, { campaignId: string; customerId: string; code: string }>;
  /** Customers customers.canWriteReviews refuses */
  blocked: Set<string>;
  /** POST a score to the webhook with a game server key */
  postScore(key: string | undefined, body: unknown): Promise<{ status: number; body: any }>;
  staff(permissions?: string[]): Record<string, string>;
  customer(accountId: string): Record<string, string>;
  visitor(): Record<string, string>;
  call(method: Method, url: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  admin(method: Method, path: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  store(method: Method, path: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  card(over?: Partial<search.ProductCard>): search.ProductCard;
  /** A content_image upload (1200 × 675 unless given), ready */
  uploadImage(size?: { width: number; height: number }): Promise<{ id: string; url: string }>;
  /** Uploads a file as staff (platform-owned) and answers its asset id once processed */
  uploadFile(file: { purpose: string; fileName: string; contentType: string; body: Buffer }): Promise<string>;
  /** Departments' repository (picks from before standalone phones) */
  repo(): import('../repository.js').DepartmentsRepository;
}

export async function boot(): Promise<Kit> {
  const clock = movingClock();
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 3600;
  const k = { clock, cards: new Map<string, search.ProductCard>(), products: new Map<string, catalog.Product>(), names: new Map<string, string>(), emails: new Map<string, string>(), audits: [] as audit.RecordInput[], settingsValues: {} as Record<string, unknown>, campaigns: new Map<string, { name: string; active: boolean; reason?: string }>(), issued: new Map<string, { campaignId: string; customerId: string; code: string }>(), blocked: new Set<string>() };
    const snapshot = (id: string) => ({ id, userId: id, ref: 'CU-1', displayName: k.names.get(id)!, email: k.emails.get(id) ?? 'a@example.com', accountStatus: 'active', canOrder: true, canMessage: true }) as never;
  const app = await buildTestApp({
    only: ['departments', 'media'],
    clock,
    config: { rateLimits: false },
    apiStubs: {
      catalog: { getProduct: async (id: string) => k.products.get(id) ?? null },
      search: { getProductCards: async (ids: string[]) => ids.map((id) => k.cards.get(id)).filter((c): c is search.ProductCard => Boolean(c)) },
      customers: {
        getCustomerByUserId: async (id: string) => (k.names.has(id) ? snapshot(id) : null),
        getCustomer: async (id: string) => (k.names.has(id) ? snapshot(id) : null),
        canWriteReviews: async (id: string) => (k.blocked.has(id) ? { allowed: false, reason: 'restricted' } : { allowed: true }),
        searchCustomers: (async (filter: { search?: string }) => {
          const q = (filter.search ?? '').toLowerCase();
          const items = [...k.names.keys()].filter((id) => k.names.get(id)!.toLowerCase().includes(q) || (k.emails.get(id) ?? 'a@example.com').includes(q)).map(snapshot);
          return { items, nextCursor: null };
        }) as never,
      },
      promotions: {
        isCampaignActive: async (id: string) => {
          const c = k.campaigns.get(id);
          return !c ? { active: false, reason: 'not_found' } : c.active ? { active: true } : { active: false, reason: c.reason ?? 'ended' };
        },
        getPublicCampaign: (async (id: string) => (k.campaigns.has(id) ? { id, name: k.campaigns.get(id)!.name, description: null, period: { startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z' }, terms: null, status: 'running', code: null } : null)) as never,
        issueCode: async (campaignId: string, customerId: string, key: string) => {
          const c = k.campaigns.get(campaignId);
          if (!c?.active) throw new AppError('CONFLICT', 'Campaign not active', undefined, 409);
          const done = k.issued.get(key) ?? { campaignId, customerId, code: `PLAY-${k.issued.size + 1}` };
          k.issued.set(key, done);
          return { codeId: newId(), code: done.code, campaignId, title: c.name, endsAt: null };
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
  // one staff account, so its uploads are its own
  const staffId = newId();
  const staff = (permissions?: string[]) => auth(callers.staff(permissions, { sub: staffId } as never));
  const call: Kit['call'] = async (method, url, payload, headers) => {
    const res = await app.inject({ method, url, headers: { ...(headers ?? staff()), 'idempotency-key': newId() }, ...(payload !== undefined ? { payload: payload as never } : {}) });
    await app.kernel.events.drain();
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  let seq = 0;
  const uploadFile: Kit['uploadFile'] = async (file) => {
    const req = { purpose: file.purpose, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.body.length };
    const res = await app.inject({ method: 'POST', url: '/api/admin/media/uploads', headers: staff(), payload: { upload: req } });
    if (res.statusCode !== 201) throw new Error(`upload failed: ${res.statusCode} ${res.body}`);
    const ticket = res.json() as { uploadId: string; assetId: string; url: string; headers: Record<string, string> };
    const media = app.kernel.boot.apis.get('media') as unknown as { providers: { storage: { acceptSignedPut(url: string, body: Uint8Array, type?: string): Promise<unknown> } } };
    await media.providers.storage.acceptSignedPut(ticket.url, file.body, ticket.headers['content-type']);
    const done = await app.inject({ method: 'POST', url: `/api/admin/media/uploads/${ticket.uploadId}/complete`, headers: staff() });
    if (done.statusCode !== 202) throw new Error(`complete failed: ${done.statusCode} ${done.body}`);
    await app.kernel.jobs.runNow('media.process');
    await app.kernel.events.drain();
    return ticket.assetId;
  };
  return Object.assign(k, {
    app,
    staff,
    customer: (accountId: string) => auth(callers.customer({ accountId })),
    postScore: async (key: string | undefined, body: unknown) => {
      const res = await app.inject({ method: 'POST', url: '/webhooks/departments/play/scores', headers: key ? { 'x-game-key': key } : {}, payload: body as never });
      await app.kernel.events.drain();
      return { status: res.statusCode, body: res.body ? res.json() : null };
    },
    visitor: () => auth(callers.visitor()),
    call,
    admin: (method: Method, path: string, payload?: unknown, headers?: Record<string, string>) => call(method, `/api/admin/departments${path}`, payload, headers ?? staff()),
    store: (method: Method, path: string, payload?: unknown, headers?: Record<string, string>) => call(method, `/api/store/departments${path}`, payload, headers ?? auth(callers.visitor())),
    card: (over: Partial<search.ProductCard> = {}) => {
      seq++;
      return { productId: newId(), slug: `phone-${seq}`, title: `Phone ${seq}`, brandName: 'Pixel', image: null, rating: 4.5, ratingCount: 10, price: { amount: 49999, currency: 'USD' }, priceIsFrom: false, offerId: newId(), sellerName: 'Official Store', sellerId: null, official: true, condition: 'new', wasPrice: null, discountPct: null, freeDelivery: true, availability: 'in_stock', offerCount: 1, badges: [], ...over } as search.ProductCard;
    },
    repo: () => (app.kernel.boot.apis.get('departments') as unknown as { deps: { repo: import('../repository.js').DepartmentsRepository } }).deps.repo,
    uploadImage: async (size?: { width: number; height: number }) => {
      const body = png(size?.width ?? 1200, size?.height ?? 675, newId());
      return { id: await uploadFile({ purpose: 'content_image', fileName: 'cover.png', contentType: 'image/png', body }), url: 'https://cdn.example.com/placeholder.png' };
    },
    uploadFile,
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
