/**
 * Test helpers for catalog: an app with catalog and real media (uploads through media's HTTP API), with the
 * modules built in other tranches stubbed:
 *   audit.record → recorded; access.check / requestApproval / approvalForTargets / getApproval → controlled per test;
 *   sellers.canSell → allowed unless a test says otherwise, getSellers → store names;
 *   offers.listActiveOffersForProduct / listOwnOffersForProduct → [] / {} unless a test says otherwise;
 *   reports.registerDataset / requestExport → recorded calls and an ExportJob;
 *   cart.countOfferInCarts → 2; orders.countOrderItemsForProducts → { open: 3, past: 5 };
 *   reviews.getRatingSummaries → 4 ratings averaging 4.5, listProductQuestions → total 2.
 * returns and support stay off, so their counts are null.
 */
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as audit from '../../../spec/audit.js';
import { auth, buildTestApp, callers, movingClock } from '../../../testing/app.js';
import type { CatalogService } from '../service.js';

export { auth, callers, newId };

export const stubs = () => ({
  audit: { record: vi.fn(async (_e: audit.RecordInput) => newId()) },
  access: {
    check: vi.fn(async (_p: unknown, action: string) => ({ decision: 'approval_required' as 'approval_required' | 'allowed' | 'denied', action, reason: 'Second reviewer needed', requiresSecondReviewer: true, approvalsNeeded: 1, eligibleApproverRoles: [], eligibleApprovers: [] })),
    requestApproval: vi.fn(async (_input: unknown) => ({ id: newId(), status: 'pending' }) as never),
    approvalForTargets: vi.fn(async (_p: unknown, _t: string, ids: string[]) => new Map(ids.map((id) => [id, null])) as never),
    getApproval: vi.fn(async (_id: string) => null as never),
    getStaffRef: vi.fn(async () => null),
    rolesOf: vi.fn(async () => []),
  },
  sellers: {
    canSell: vi.fn(async (_s: string, _c: unknown) => ({ allowed: true }) as { allowed: boolean; reason?: string; restrictionId?: string }),
    getSellers: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, storeName: 'Gadget Grove' })) as never),
  },
  offers: {
    listActiveOffersForProduct: vi.fn(async (_id: string) => [] as never[]),
    listOwnOffersForProduct: vi.fn(async (_s: string, ids: string[]) => Object.fromEntries(ids.map((id) => [id, []])) as never),
    getOffers: vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, null])) as never),
  },
  reports: {
    /** keeps every registration: boot-time calls happen before Vitest clears mock calls for each test */
    registered: [] as { key: string; owner: string }[],
    registerDataset: vi.fn(async (d: { key: string; owner: string }) => {
      registeredDatasets.push(d);
    }),
    requestExport: vi.fn(async (input: { dataset: string; format: string; filters: unknown }) => ({
      id: newId(),
      ref: 'EX-261009-0001',
      dataset: input.dataset,
      format: input.format,
      filters: input.filters,
      requestedBy: { kind: 'staff' },
      state: 'queued',
      columnsExcluded: [],
      createdAt: '2026-10-09T10:00:00Z',
    }) as never),
  },
  cart: { countOfferInCarts: vi.fn(async () => 2) },
  orders: { countOrderItemsForProducts: vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { open: 3, past: 5 }]))) },
  reviews: {
    getRatingSummaries: vi.fn(async (ids: string[]) => ids.map((productId) => ({ productId, hasReviews: true, average: 4.5, ratingCount: 4, writtenCount: 2, distribution: [], answeredQuestions: 1, withPhotos: 0 })) as never),
    listProductQuestions: vi.fn(async () => ({ items: [], nextCursor: null, total: 2 }) as never),
  },
});

/** Report datasets registered by the modules (at boot, through afterBoot; Vitest clears mock calls before each test) */
export const registeredDatasets: { key: string; owner: string }[] = [];

export type Stubs = ReturnType<typeof stubs>;

export interface CatalogTestApp {
  app: FastifyInstance;
  catalog: CatalogService;
  clock: ReturnType<typeof movingClock>;
  stubs: Stubs;
  events: EventEnvelope[];
  eventsNamed(name: string): EventEnvelope[];
  staff: Record<string, string>;
  staffId: string;
}

/** `extra`: more modules to enable and more API stubs (e.g. settings with a business calendar) */
export async function catalogApp(extra: { only?: string[]; apiStubs?: Record<string, object> } = {}): Promise<CatalogTestApp> {
  // follows real time (tokens are signed with it); tests move it forward by small steps
  const clock = movingClock();
  const s = stubs();
  const app = await buildTestApp({
    only: ['catalog', 'media', 'audit', 'access', 'sellers', 'offers', 'reports', 'cart', 'orders', 'reviews', ...(extra.only ?? [])],
    clock,
    config: { rateLimits: false },
    apiStubs: { ...s, ...extra.apiStubs } as never,
  });
  const events: EventEnvelope[] = [];
  const names = [
    'catalog.product.submitted', 'catalog.product.approved', 'catalog.product.changes_requested', 'catalog.product.rejected', 'catalog.product.publication_changed',
    'catalog.product.updated', 'catalog.product.merged', 'catalog.correction.suggested', 'catalog.correction.decided', 'catalog.category.changed', 'catalog.brand.requested', 'catalog.brand.changed',
  ];
  for (const n of names) app.kernel.events.subscribe('test', n, (e) => void events.push(e));
  const staffId = newId();
  return {
    app,
    catalog: app.kernel.boot.apis.get('catalog') as CatalogService,
    clock,
    stubs: s,
    events,
    eventsNamed: (name) => events.filter((e) => e.name === name),
    staff: auth(callers.staff(undefined, { sub: staffId, dev: { permissions: ['*'], name: 'Riley Chen' } } as never)),
    staffId,
  };
}

/* ------------------------------------------------------------------ requests */

export type Res = Awaited<ReturnType<FastifyInstance['inject']>>;

export function api(t: CatalogTestApp) {
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, headers: Record<string, string>, payload?: unknown): Promise<Res> => {
    const res = await t.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as never } : {}) });
    await t.app.kernel.events.drain();
    return res;
  };
  return {
    admin: (method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, payload?: unknown, headers = t.staff) => call(method, `/api/admin/catalog${path}`, headers, payload),
    seller: (sellerId: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, payload?: unknown) => call(method, `/api/seller/catalog${path}`, auth(callers.seller({ sellerId })), payload),
    store: (path: string) => call('GET', `/api/store/catalog${path}`, auth(callers.visitor())),
    raw: call,
  };
}

/* ------------------------------------------------------------------ media */

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const chunk = (type: string, data: Buffer) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);

export function png(width: number, height: number, seed = 'pixels'): Buffer {
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from(seed, 'latin1')), chunk('IEND', Buffer.alloc(0))]);
}

/** Uploads a ready image through media's HTTP API (seller or staff) and returns its asset id */
export async function uploadImage(t: CatalogTestApp, who: { sellerId: string } | 'staff', opts: { width?: number; height?: number; purpose?: string } = {}): Promise<string> {
  const body = png(opts.width ?? 1200, opts.height ?? 1200, newId());
  const req = { purpose: opts.purpose ?? 'product_image', fileName: 'photo.png', contentType: 'image/png', sizeBytes: body.length };
  const area = who === 'staff' ? 'admin' : 'seller';
  const headers = who === 'staff' ? t.staff : auth(callers.seller({ sellerId: who.sellerId }));
  const res = await t.app.inject({ method: 'POST', url: `/api/${area}/media/uploads`, headers, payload: area === 'admin' ? { upload: req } : req });
  if (res.statusCode !== 201) throw new Error(`upload failed: ${res.statusCode} ${res.body}`);
  const ticket = res.json() as { uploadId: string; assetId: string; url: string; headers: Record<string, string> };
  const media = t.app.kernel.boot.apis.get('media') as unknown as { providers: { storage: { acceptSignedPut(url: string, body: Uint8Array, type?: string): Promise<unknown> } } };
  await media.providers.storage.acceptSignedPut(ticket.url, body, ticket.headers['content-type']);
  const done = await t.app.inject({ method: 'POST', url: `/api/${area}/media/uploads/${ticket.uploadId}/complete`, headers });
  if (done.statusCode !== 202) throw new Error(`complete failed: ${done.statusCode} ${done.body}`);
  await t.app.kernel.jobs.runNow('media.process');
  await t.app.kernel.events.drain();
  return ticket.assetId;
}

/* ------------------------------------------------------------------ fixtures */

/** EAN-13 with a valid check digit */
export function ean(seed: number): string {
  const body = `400${String(seed).padStart(9, '0')}`.slice(0, 12);
  const sum = body
    .split('')
    .reverse()
    .reduce((a, d, i) => a + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
}

let seq = 1;
export const unique = () => seq++;

export async function category(t: CatalogTestApp, name: string, extra: Record<string, unknown> = {}) {
  const res = await api(t).admin('POST', '/categories', { name, ...extra });
  if (res.statusCode !== 201) throw new Error(`category: ${res.statusCode} ${res.body}`);
  return res.json() as { id: string; slug: string };
}

export async function brand(t: CatalogTestApp, name: string, extra: Record<string, unknown> = {}) {
  const res = await api(t).admin('POST', '/brands', { name, ...extra });
  if (res.statusCode !== 201) throw new Error(`brand: ${res.statusCode} ${res.body}`);
  return (res.json() as { brand: { id: string; slug: string } }).brand;
}

/** A product input that passes submission */
export function productInput(o: { brandId?: string; categoryId: string; imageIds: string[]; title?: string; model?: string; gtin?: string; extra?: Record<string, unknown> }) {
  const n = unique();
  return {
    title: o.title ?? `Aurora wireless headphones ${n}`,
    brandId: o.brandId,
    categoryId: o.categoryId,
    description: 'Over-ear headphones with active noise cancelling and a 40 hour battery that charges over USB-C.',
    keyFeatures: ['Active noise cancelling', '40 h battery', 'USB-C charging'],
    specs: { 'Battery life': '40 h' },
    includedItems: ['Headphones', 'USB-C cable'],
    imageIds: o.imageIds,
    modelNumber: o.model ?? `AU-${n}00`,
    variants: [{ options: { Color: 'Black' }, gtin: o.gtin ?? ean(n) }],
    ...o.extra,
  };
}

/** A seller draft, submitted (and optionally approved) */
export async function sellerProduct(t: CatalogTestApp, sellerId: string, o: { brandId: string; categoryId: string; approve?: boolean; title?: string; model?: string; gtin?: string; extra?: Record<string, unknown> }) {
  const a = api(t);
  const image = await uploadImage(t, { sellerId });
  const created = await a.seller(sellerId, 'POST', '/products', productInput({ ...o, imageIds: [image] }));
  if (created.statusCode !== 201) throw new Error(`draft: ${created.statusCode} ${created.body}`);
  const id = created.json().product.id as string;
  const submitted = await a.seller(sellerId, 'POST', `/products/${id}/submit`, { note: 'First submission' });
  if (submitted.statusCode !== 200) throw new Error(`submit: ${submitted.statusCode} ${submitted.body}`);
  if (o.approve) {
    const approved = await a.admin('POST', `/products/${id}/approve`, {});
    if (approved.statusCode !== 200) throw new Error(`approve: ${approved.statusCode} ${approved.body}`);
  }
  return { id, image };
}
