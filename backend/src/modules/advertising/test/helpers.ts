/**
 * Test kit for advertising: boots advertising with the modules it calls (offers, catalog, inventory, sellers,
 * promotions, finance, audit, and its dependencies media and access) and stubs the answers tests control:
 * offers and stock, products, seller names and restrictions, linked promotions, approval limits, uploaded
 * files and ad-charge postings. src/modules/advertising/test/integration.test.ts runs the same flows on the
 * real modules.
 */
import type { FastifyInstance } from 'fastify';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import type * as access from '../../../spec/access.js';
import type { AdCampaignInput } from '../../../spec/advertising.js';
import type * as audit from '../../../spec/audit.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';
import type { AdvertisingService } from '../service.js';

export const STORE = '/api/store/advertising';
export const SELLER = '/api/seller/advertising';
export const ADMIN = '/api/admin/advertising';
export const USD = (amount: number) => ({ amount, currency: 'USD' });

export interface FakeOffer {
  id: string;
  sellerId: string | null;
  productId: string;
  variantId: string;
  stockItemId: string;
  price: { amount: number; currency: string };
  status: string;
  stock: number;
  title: string;
  categoryId: string;
}

export interface FakeAsset {
  id: string;
  purpose: string;
  width: number;
  height: number;
  sizeBytes: number;
  contentType: string;
  owner: { kind: string; id?: string | null };
}

export interface FakePromotion {
  id: string;
  name: string;
  code: string | null;
  status: string;
  startsAt: string;
  endsAt: string;
  active: boolean;
  reason?: string;
}

export type Decision = 'allowed' | 'approval_required' | 'denied';

export interface Kit {
  app: FastifyInstance;
  svc: AdvertisingService;
  clock: ReturnType<typeof movingClock>;
  offers: Map<string, FakeOffer>;
  assets: Map<string, FakeAsset>;
  promotions: Map<string, FakePromotion>;
  events: EventEnvelope[];
  audits: audit.RecordInput[];
  approvals: Map<string, access.RequestApprovalInput>;
  authority: Map<string, Decision>;
  restricted: Map<string, string>;
  /** access.rolesOf answers by account id (default business_owner) */
  roles: Map<string, string[]>;
  /** finance.recordAdCharge calls, with the ledger entry id returned */
  adCharges: { sellerId: string; campaignId: string; amount: { amount: number; currency: string }; period: { from: string; to: string }; entryId: string }[];
  /** finance.creditSellerCharge calls (stubbed per src/spec/finance.ts: the same idempotencyKey returns the first entry) */
  chargeCredits: { sellerId: string; amount: { amount: number; currency: string }; originalEntryId: string; reason: string; idempotencyKey: string }[];
  staff: string;
  of(name: string): any[];
  call(method: string, url: string, token: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  emit(name: string, payload: unknown): Promise<void>;
  job(name: string): Promise<void>;
  offer(o?: Partial<FakeOffer>): FakeOffer;
  asset(width: number, height: number, o?: Partial<FakeAsset>): FakeAsset;
  promotion(o?: Partial<FakePromotion>): FakePromotion;
  close(): Promise<void>;
}

export const SELLER_A = newId();
export const SELLER_B = newId();
export const HOME = newId();
export const KITCHEN = newId();

const toOffer = (o: FakeOffer) =>
  ({
    id: o.id,
    ownerType: o.sellerId ? 'seller' : 'official',
    sellerId: o.sellerId,
    sellerName: 'Seller',
    productId: o.productId,
    variantId: o.variantId,
    condition: 'new',
    includedItems: [],
    missingItems: [],
    complete: true,
    sellerSku: `SKU-${o.id.slice(-4)}`,
    stockItemId: o.stockItemId,
    price: o.price,
    compareAt: { amount: USD(o.price.amount + 1000), basis: 'lowest_30_days', verified: true, explanation: 'Lowest price in 30 days' },
    dispatch: { businessDays: 1, shipsFrom: 'Reno, NV', label: 'Ships in 1 business day' },
    shippingProfileId: newId(),
    status: o.status,
    termsVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as any;

export async function boot(): Promise<Kit> {
  const clock = movingClock();
  // tests move the clock days ahead (expiry, suppression windows): tokens follow the app clock
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 40 * 86_400;
  const offers = new Map<string, FakeOffer>();
  const assets = new Map<string, FakeAsset>();
  const promotions = new Map<string, FakePromotion>();
  const audits: audit.RecordInput[] = [];
  const approvals = new Map<string, access.RequestApprovalInput>();
  const authority = new Map<string, Decision>();
  const restricted = new Map<string, string>();
  /** access.rolesOf by account id; anyone not listed is a Business Owner (may act on every review step) */
  const roles = new Map<string, string[]>();
  const adCharges: Kit['adCharges'] = [];
  const chargeCredits: Kit['chargeCredits'] = [];
  const creditEntries = new Map<string, string>();
  const byProduct = () => new Map([...offers.values()].map((o) => [o.productId, o]));
  const app = await buildTestApp({
    modules: withDependencies(['advertising', 'audit', 'offers', 'catalog', 'inventory', 'sellers', 'promotions', 'finance']),
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      offers: {
        getOffer: async (id: string) => (offers.has(id) ? toOffer(offers.get(id)!) : null),
        getOffers: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, offers.has(id) ? toOffer(offers.get(id)!) : null])),
        getOwnOffer: async (sellerId: string, id: string) => (offers.get(id)?.sellerId === sellerId ? toOffer(offers.get(id)!) : null),
        listOffersAdmin: async (f: any) => {
          const items = [...offers.values()].filter((o) => (!f.sellerId || o.sellerId === f.sellerId) && (!f.status?.length || f.status.includes(o.status))).map(toOffer);
          return { items, nextCursor: null };
        },
      },
      catalog: {
        getProduct: async (id: string) => {
          const o = byProduct().get(id);
          return o ? ({ id, title: o.title, images: [{ id: newId(), url: 'https://cdn.test/p.png' }], categoryId: o.categoryId, brand: null } as any) : null;
        },
      },
      inventory: {
        getAvailability: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { available: [...offers.values()].find((o) => o.stockItemId === id)?.stock ?? 0, state: 'in_stock', lowStockThreshold: null, nextIncoming: null }])),
      },
      sellers: {
        getSellers: async (ids: string[]) => ids.map((id) => ({ id, ref: 'SL-1', slug: 's', storeName: id === SELLER_A ? 'Casa Verde Home' : id === SELLER_B ? 'Northwind Audio' : 'Seller', status: 'approved', verified: true, canSellNew: true, activeRestrictionIds: [], launchReady: true }) as any),
        canSell: async (id: string) => (restricted.has(id) ? { allowed: false, reason: restricted.get(id) } : { allowed: true }),
      },
      promotions: {
        getPublicCampaign: async (id: string) => {
          const p = promotions.get(id);
          return p ? ({ id, name: p.name, code: p.code, status: p.status, period: { startsAt: p.startsAt, endsAt: p.endsAt, timeZone: 'America/Los_Angeles', display: '' } } as any) : null;
        },
        isCampaignActive: async (id: string) => {
          const p = promotions.get(id);
          return p ? { active: p.active, ...(p.reason ? { reason: p.reason } : {}) } : { active: false, reason: 'not_found' };
        },
      },
      media: {
        getAsset: async (id: string) => {
          const a = assets.get(id);
          return a ? ({ id, kind: a.purpose === 'ad_video' ? 'video' : 'image', purpose: a.purpose, status: 'ready', fileName: `${id.slice(0, 6)}.png`, contentType: a.contentType, sizeBytes: a.sizeBytes, width: a.width, height: a.height, owner: a.owner, visibility: 'public', renditions: [], inUse: false, usageCount: 0, createdAt: new Date().toISOString() } as any) : null;
        },
        attach: async (id: string, _usage: any, owner: any) => {
          const a = assets.get(id);
          if (!a) throw new Error('no asset');
          if (a.owner.kind !== owner.kind || (a.owner.id ?? null) !== (owner.id ?? null)) throw Object.assign(new Error('ASSET_NOT_OWNED'), { code: 'ASSET_NOT_OWNED' });
        },
        detach: async () => {},
        refs: async (ids: string[]) => ids.map((id) => ({ id, url: `https://cdn.test/${id}.png`, width: assets.get(id)?.width ?? null, height: assets.get(id)?.height ?? null })),
      },
      access: {
        check: async (_p: any, action: string) => {
          const decision = authority.get(action) ?? 'allowed';
          return { decision, action, reason: decision === 'allowed' ? 'Within your limit' : decision === 'denied' ? 'Your role cannot do this' : 'Above your limit: Finance approval', requiresSecondReviewer: false, approvalsNeeded: decision === 'approval_required' ? 1 : 0, eligibleApproverRoles: [{ id: newId(), key: 'finance_manager', name: 'Finance Manager' }], eligibleApprovers: [] } as any;
        },
        requestApproval: async (input: access.RequestApprovalInput) => {
          const existing = [...approvals.entries()].find(([, v]) => v.action === input.action && v.target.id === input.target.id);
          if (existing) return { id: existing[0], ref: 'AP-1', status: 'pending' } as any;
          const id = newId();
          approvals.set(id, input);
          return { id, ref: 'AP-1', status: 'pending' } as any;
        },
        getApproval: async (id: string) => (approvals.has(id) ? ({ id, reason: approvals.get(id)!.reason } as any) : null),
        approvalInfo: async (id: string) => ({ required: true, approvalRequestId: id, approvers: ['Business Owner'] }),
        cancelApproval: async () => {},
        getStaffRef: async (id: string) => ({ id, name: `Staff ${id.slice(0, 4)}` }) as any,
        rolesOf: async (accountId: string) => (roles.get(accountId) ?? ['business_owner']).map((key) => ({ id: newId(), key, name: key })),
      },
      finance: {
        recordAdCharge: async (input: any) => {
          const entryId = newId();
          adCharges.push({ ...input, entryId });
          return { id: entryId, type: 'ad_charge', statementRef: 'ST-2610-0001' } as any;
        },
        creditSellerCharge: async (input: any) => {
          if (!creditEntries.has(input.idempotencyKey)) {
            chargeCredits.push(input);
            creditEntries.set(input.idempotencyKey, newId());
          }
          return { id: creditEntries.get(input.idempotencyKey)!, type: 'charge_credit' } as any;
        },
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
  for (const name of Object.keys((await import('../../../spec/advertising.js')).spec.events.publishes)) app.kernel.events.subscribe('test', name, async (e) => void events.push(e));
  const svc = app.kernel.boot.apis.get('advertising') as AdvertisingService;
  const kit: Kit = {
    app,
    svc,
    clock,
    offers,
    assets,
    promotions,
    events,
    audits,
    approvals,
    authority,
    restricted,
    roles,
    adCharges,
    chargeCredits,
    staff: callers.staff(),
    of: (name) => events.filter((e) => e.name === name).map((e) => e.payload),
    async call(method, url, token, body, headers = {}) {
      const res = await app.inject({ method: method as any, url, headers: { ...auth(token), ...headers }, ...(body !== undefined ? { payload: body as any } : {}) });
      await app.kernel.events.drain();
      return { status: res.statusCode, body: res.body ? res.json() : null };
    },
    async emit(name, payload) {
      app.kernel.events.publish('test', name, payload, { actor: { kind: 'system', id: null } });
      await app.kernel.events.drain();
    },
    async job(name) {
      await app.kernel.jobs.runNow(name as never);
      await app.kernel.events.drain();
    },
    offer(o = {}) {
      const off: FakeOffer = { id: newId(), sellerId: SELLER_A, productId: newId(), variantId: newId(), stockItemId: newId(), price: USD(4900), status: 'active', stock: 50, title: 'Linen duvet cover', categoryId: KITCHEN, ...o };
      offers.set(off.id, off);
      return off;
    },
    asset(width, height, o = {}) {
      const a: FakeAsset = { id: newId(), purpose: 'ad_creative', width, height, sizeBytes: 300_000, contentType: 'image/png', owner: { kind: 'platform' }, ...o };
      assets.set(a.id, a);
      return a;
    },
    promotion(o = {}) {
      const now = clock.now().getTime();
      const p: FakePromotion = { id: newId(), name: 'Fall Home Week', code: 'HOME20', status: 'live', startsAt: new Date(now - 86_400_000).toISOString(), endsAt: new Date(now + 10 * 86_400_000).toISOString(), active: true, ...o };
      promotions.set(p.id, p);
      return p;
    },
    close: () => app.close(),
  };
  return kit;
}

/** An image creative for a placement and device (uploaded through media first) */
export async function creative(k: Kit, placementKey: string, device: 'desktop' | 'phone' | 'any', dims: [number, number], o: { token?: string; seller?: boolean; headline?: string; link?: string } = {}) {
  const a = k.asset(dims[0], dims[1], o.seller ? { owner: { kind: 'seller', id: SELLER_A } } : {});
  const url = o.seller ? `${SELLER}/creatives` : `${ADMIN}/creatives`;
  const res = await k.call('POST', url, o.token ?? k.staff, { kind: 'image', device, placementKey, mediaId: a.id, headline: o.headline ?? 'Fall Home Week: up to 30% off', buttonText: 'Shop the sale', link: o.link ?? '/deals' });
  if (res.status !== 201) throw new Error(`creative: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Desktop and phone creatives for the opening full-screen ad */
export async function openingCreatives(k: Kit) {
  return [await creative(k, 'opening_fullscreen', 'desktop', [1600, 900]), await creative(k, 'opening_fullscreen', 'phone', [1080, 1920])];
}

export function campaignInput(k: Kit, over: Partial<AdCampaignInput> = {}): AdCampaignInput {
  const now = k.clock.now().getTime();
  return {
    name: 'Fall Home Week opening',
    advertiser: { kind: 'platform' },
    goal: 'company_promotion',
    placementKey: 'opening_fullscreen',
    pages: ['home'],
    audience: { mode: 'all', regions: [], visitors: 'all', signIn: 'everyone', categoryIds: [] },
    destination: { kind: 'url', url: '/deals' },
    startsAt: new Date(now - 60_000).toISOString(),
    endsAt: new Date(now + 7 * 86_400_000).toISOString(),
    timeZone: 'America/Los_Angeles',
    priority: 2,
    stopWithPromotion: false,
    creativeIds: [],
    afterApproval: 'schedule',
    ...over,
  };
}

/** Create → submit → Advertising and Content approve (two people) → scheduled → live */
export async function liveCampaign(k: Kit, over: Partial<AdCampaignInput> = {}): Promise<any> {
  const creativeIds = over.creativeIds ?? (await openingCreatives(k)).map((c: any) => c.id);
  const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { ...over, creativeIds }));
  if (created.status !== 201) throw new Error(`create: ${JSON.stringify(created.body)}`);
  const id = created.body.id;
  const steps: [string, string, unknown][] = [
    [`${ADMIN}/campaigns/${id}/submit`, k.staff, {}],
    [`${ADMIN}/campaigns/${id}/approve`, callers.staff(), { role: 'advertising' }],
    [`${ADMIN}/campaigns/${id}/approve`, callers.staff(), { role: 'content' }],
  ];
  for (const [url, token, body] of steps) {
    const r = await k.call('POST', url, token, body);
    if (r.status !== 200) throw new Error(`${url}: ${JSON.stringify(r.body)}`);
  }
  return (await k.call('GET', `${ADMIN}/campaigns/${id}`, k.staff)).body;
}

/** A page view's decision */
export async function serve(k: Kit, o: { page?: string; visitorId?: string; sessionId?: string; entry?: boolean; slots?: string[]; device?: string; token?: string; overlayShown?: boolean; context?: Record<string, unknown>; personalization?: boolean; region?: string } = {}) {
  const res = await k.call('POST', `${STORE}/decisions`, o.token ?? callers.visitor(), {
    page: o.page ?? 'home',
    context: o.context ?? {},
    device: o.device ?? 'desktop',
    visitorId: o.visitorId ?? 'visitor-1',
    sessionId: o.sessionId ?? 'session-1',
    isEntryPage: o.entry ?? true,
    slots: o.slots ?? [],
    overlayShownThisSession: o.overlayShown ?? false,
    personalizationAllowed: o.personalization ?? true,
    ...(o.region ? { region: o.region } : {}),
  });
  if (res.status !== 200) throw new Error(`serve: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function track(k: Kit, events: { impressionToken: string; kind: string }[], token = callers.visitor()) {
  return k.call('POST', `${STORE}/events`, token, { events: events.map((e) => ({ ...e, at: k.clock.now().toISOString() })) });
}
