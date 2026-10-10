/**
 * Test kit for promotions: boots promotions with its dependencies and audit. offers (built in parallel) is
 * stubbed from an in-memory offer list per src/spec/offers.ts; catalog, inventory, sellers and access answers
 * are stubbed where tests control them (categories, stock, seller restrictions, approval limits).
 */
import type { FastifyInstance } from 'fastify';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import { auth, buildTestApp, callers, movingClock } from '../../../testing/app.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import type { CampaignInput } from '../../../spec/promotions.js';
import type { PromotionsService } from '../service.js';

export const STORE = '/api/store/promotions';
export const SELLER = '/api/seller/promotions';
export const ADMIN = '/api/admin/promotions';
export const USD = (amount: number) => ({ amount, currency: 'USD' });

export interface FakeOffer {
  id: string;
  sellerId: string | null;
  ownerType: 'official' | 'seller';
  productId: string;
  variantId: string;
  price: { amount: number; currency: string };
  status: string;
  stockItemId: string;
  sellerSku: string;
  dispatchDays: number;
  categoryId: string;
  brandId: string | null;
  stock: number;
  lowest?: number | null;
}

export type Decision = 'allowed' | 'approval_required' | 'denied';

export interface Kit {
  app: FastifyInstance;
  svc: PromotionsService;
  clock: ReturnType<typeof movingClock>;
  offers: Map<string, FakeOffer>;
  events: EventEnvelope[];
  audits: audit.RecordInput[];
  approvals: Map<string, access.RequestApprovalInput>;
  authority: Map<string, Decision>;
  blockedSellers: Map<string, string>;
  staff: string;
  of(name: string): any[];
  call(method: string, url: string, token: string, body?: unknown): Promise<{ status: number; body: any }>;
  emit(name: string, payload: unknown): Promise<void>;
  offer(o?: Partial<FakeOffer>): FakeOffer;
  close(): Promise<void>;
}

export const SELLER_A = newId();
export const SELLER_B = newId();
export const OFFICIAL_SELLER = newId();
export const HOME = newId();
export const KITCHEN = newId();
export const ELECTRONICS = newId();

function toOffer(o: FakeOffer) {
  return {
    id: o.id,
    ownerType: o.ownerType,
    sellerId: o.sellerId,
    sellerName: o.ownerType === 'official' ? OFFICIAL_STORE_NAME : 'Seller',
    title: `Product ${o.sellerSku}`,
    missingItemsStale: false,
    productId: o.productId,
    variantId: o.variantId,
    condition: 'new',
    includedItems: [],
    missingItems: [],
    complete: true,
    sellerSku: o.sellerSku,
    stockItemId: o.stockItemId,
    price: o.price,
    dispatch: { businessDays: o.dispatchDays, shipsFrom: 'Reno, NV', label: 'Ships in 1 business day' },
    shippingProfileId: newId(),
    status: o.status,
    termsVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any;
}

export async function boot(): Promise<Kit> {
  const clock = movingClock();
  const offers = new Map<string, FakeOffer>();
  const audits: audit.RecordInput[] = [];
  const approvals = new Map<string, access.RequestApprovalInput>();
  const authority = new Map<string, Decision>();
  const blockedSellers = new Map<string, string>();
  const products = () => new Map([...offers.values()].map((o) => [o.productId, o]));
  const app = await buildTestApp({
    modules: withDependencies(['promotions', 'audit']),
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      offers: {
        getOffer: async (id: string) => (offers.has(id) ? toOffer(offers.get(id)!) : null),
        getOffers: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, offers.has(id) ? toOffer(offers.get(id)!) : null])),
        getOwnOffer: async (sellerId: string, id: string) => (offers.get(id)?.sellerId === sellerId ? toOffer(offers.get(id)!) : null),
        listActiveOffersByIds: async (ids: string[]) => ids.map((id) => offers.get(id)).filter((o): o is FakeOffer => Boolean(o && o.status === 'active')).map(toOffer),
        listOffersAdmin: async (f: any, page: any) => {
          const all = [...offers.values()].filter((o) => (!f.sellerId || o.sellerId === f.sellerId) && (!f.productId || o.productId === f.productId) && (f.official === undefined || (o.ownerType === 'official') === f.official) && (!f.status?.length || f.status.includes(o.status)));
          const start = page?.cursor ? Number(page.cursor) : 0;
          const limit = page?.limit ?? 100;
          const items = all.slice(start, start + limit).map(toOffer);
          return { items, nextCursor: start + limit < all.length ? String(start + limit) : null };
        },
        lowestPrice: async (id: string) => {
          const o = offers.get(id);
          return o?.lowest ? USD(o.lowest) : null;
        },
        priceRange: async (id: string) => {
          const o = offers.get(id);
          return o ? { lowest: USD(o.lowest ?? o.price.amount), highest: o.price, current: o.price, unchanged: !o.lowest } : null;
        },
      },
      catalog: {
        getProduct: async (id: string) => {
          const o = products().get(id);
          return o ? ({ id, title: `Product ${o.sellerSku}`, images: [], categoryId: o.categoryId, brand: o.brandId ? { id: o.brandId, name: 'Brand' } : null } as any) : null;
        },
        listCategories: async () => [{ id: HOME, parentId: null, name: 'Home', children: [{ id: KITCHEN, parentId: HOME, name: 'Kitchen', children: [] }] }, { id: ELECTRONICS, parentId: null, name: 'Electronics', children: [] }] as any,
      },
      inventory: {
        getAvailability: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { available: [...offers.values()].find((o) => o.stockItemId === id)?.stock ?? 0, state: 'in_stock', lowStockThreshold: null, nextIncoming: null }])),
      },
      sellers: {
        getSellers: async (ids: string[]) => ids.map((id) => ({ id, ref: 'SL-1', slug: 's', storeName: id === SELLER_A ? 'Casa Verde Home' : id === SELLER_B ? 'Northwind Audio' : 'Seller', status: 'approved', verified: true, canSellNew: true, activeRestrictionIds: [], launchReady: true }) as any),
        canSell: async (id: string) => (blockedSellers.has(id) ? { allowed: false, reason: blockedSellers.get(id) } : { allowed: true }),
      },
      access: {
        check: async (_p: any, action: string) => {
          const decision = authority.get(action) ?? 'allowed';
          return { decision, action, reason: decision === 'allowed' ? 'Within your limit' : decision === 'denied' ? 'Your role cannot do this' : 'Above your limit: Finance approval', requiresSecondReviewer: false, approvalsNeeded: decision === 'approval_required' ? 1 : 0, eligibleApproverRoles: [], eligibleApprovers: [] } as any;
        },
        requestApproval: async (input: access.RequestApprovalInput) => {
          const id = newId();
          approvals.set(id, input);
          return { id, ref: 'AP-1', status: 'pending' } as any;
        },
        approvalInfo: async (id: string) => ({ required: true, approvalRequestId: id, approvers: ['Finance Manager'] }),
        cancelApproval: async () => {},
        getStaffRef: async (id: string) => ({ id, name: 'Fran Finance' }) as any,
      },
      audit: {
        record: async (e: audit.RecordInput) => {
          audits.push(e);
          return newId();
        },
      },
    },
  });
  const events: EventEnvelope[] = [];
  for (const name of Object.keys((await import('../../../spec/promotions.js')).spec.events.publishes)) app.kernel.events.subscribe('test', name, async (e) => void events.push(e));
  const svc = app.kernel.boot.apis.get('promotions') as PromotionsService;
  const staff = callers.staff();
  const kit: Kit = {
    app,
    svc,
    clock,
    offers,
    events,
    audits,
    approvals,
    authority,
    blockedSellers,
    staff,
    of: (name) => events.filter((e) => e.name === name).map((e) => e.payload),
    async call(method, url, token, body) {
      const res = await app.inject({ method: method as any, url, headers: auth(token), ...(body !== undefined ? { payload: body as any } : {}) });
      await app.kernel.events.drain();
      return { status: res.statusCode, body: res.body ? res.json() : null };
    },
    async emit(name, payload) {
      app.kernel.events.publish('test', name, payload, { actor: { kind: 'system', id: null } });
      await app.kernel.events.drain();
    },
    offer(o = {}) {
      const off: FakeOffer = { id: newId(), sellerId: SELLER_A, ownerType: 'seller', productId: newId(), variantId: newId(), price: USD(10000), status: 'active', stockItemId: newId(), sellerSku: `SKU-${offers.size + 1}`, dispatchDays: 1, categoryId: KITCHEN, brandId: null, stock: 50, lowest: null, ...o };
      if (o.ownerType === 'official' && o.sellerId === undefined) off.sellerId = null;
      offers.set(off.id, off);
      return off;
    },
    close: () => app.close(),
  };
  return kit;
}

/** A campaign input with sensible defaults (platform-funded 20% coupon on Home, live now) */
export function campaignInput(clock: { now(): Date }, over: Partial<CampaignInput> = {}): CampaignInput {
  const now = clock.now().getTime();
  return {
    name: 'Fall Home Week',
    description: '20% off bedding and lighting',
    discount: { kind: 'percent_coupon', percentOffBps: 2000 },
    startsAt: new Date(now - 60_000).toISOString(),
    endsAt: new Date(now + 7 * 86_400_000).toISOString(),
    timeZone: 'America/Los_Angeles',
    scope: { mode: 'categories', include: [{ kind: 'category', id: HOME, label: 'Home' }], exclude: [] },
    eligibility: { audience: 'everyone' },
    limits: { budget: USD(1_000_000) },
    funding: { owner: 'platform', costCenter: 'MKT-01' },
    stacking: { withSellerMarkdowns: true, withOtherCoupons: false, withFreeShipping: true, withFlashSalePrices: false },
    ...over,
  };
}

/** Create → submit → confirm → schedule through the admin API; returns the campaign */
export async function liveCampaign(k: Kit, input: CampaignInput): Promise<any> {
  const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, input);
  if (created.status !== 201) throw new Error(`create: ${JSON.stringify(created.body)}`);
  const id = created.body.id;
  const steps = [`${ADMIN}/campaigns/${id}/submit`, `${ADMIN}/campaigns/${id}/confirm-funding`, `${ADMIN}/campaigns/${id}/schedule`];
  for (const url of steps) {
    const r = await k.call('POST', url, k.staff, {});
    if (r.status !== 200) throw new Error(`${url}: ${JSON.stringify(r.body)}`);
  }
  return (await k.call('GET', `${ADMIN}/campaigns/${id}`, k.staff)).body;
}

/** A cart line for an offer */
export function line(o: FakeOffer, qty = 1, packageId?: string) {
  return { lineId: `L-${o.id.slice(-6)}`, offerId: o.id, productId: o.productId, variantId: o.variantId, sellerId: o.sellerId ?? OFFICIAL_SELLER, officialStore: o.ownerType === 'official', categoryId: o.categoryId, brandId: o.brandId, quantity: qty, unitPrice: o.price, packageId: packageId ?? `P-${o.sellerId ?? 'official'}` };
}
