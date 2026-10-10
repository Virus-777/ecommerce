/**
 * Shared setup for the offers behaviour tests: offers with inventory (real), access, audit, media,
 * shipping and returns running, a movable clock, and recorded events, audit entries and calls.
 *
 * Stubbed APIs (modules not built yet, or answers the tests control):
 *   catalog.getProduct / getProductAdmin / getProductForSeller / isPurchasable → products in h.products
 *     (review state and publication set by each test).
 *   sellers.getSeller(s) / canSell / getPerformance / getStorefrontCard → sellers in h.sellers (status,
 *     launch readiness, restrictions with activities and scope, on-time dispatch).
 *   shipping.quote → h.shipping[profileId] price and transit days; postal codes starting 99 are not served.
 *   returns.resolveTerms → 30-day baseline (h.returnDays).
 *   access.check → h.access.decision; requestApproval → new request id; cancelApproval / approvalInfo recorded.
 *   audit.record → h.audits. media.getAsset / signedDownload (data: URL) / storeGeneratedFile → h.files.
 *   reports.registerDataset / requestExport → recorded.
 */
import type { FastifyInstance } from 'fastify';
import { devClaims, type DevOptions } from '../../../kernel/auth/dev.js';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as fulfillment from '../../../spec/fulfillment-service.js';
import type * as media from '../../../spec/media.js';
import type { OffersPublicApi } from '../../../spec/offers.js';
import type { OffersService } from '../service.js';
import type * as sellers from '../../../spec/sellers.js';
import type * as shipping from '../../../spec/shipping.js';
import { auth, buildTestApp, movingClock, token } from '../../../testing/app.js';

export const OFFER_EVENTS = [
  'offers.offer.created',
  'offers.offer.missing_items_stale',
  'offers.offer.missing_items_reviewed',
  'offers.offer.updated',
  'offers.offer.price_changed',
  'offers.offer.status_changed',
  'offers.offer.eligibility_changed',
  'offers.featured.changed',
  'offers.featured_rule.published',
  'offers.bulk_update.applied',
] as const;

export interface SellerState {
  status: sellers.SellerSnapshot['status'];
  launchReady: boolean;
  name: string;
  onTimePct: number | null;
  restrictions: { id: string; activities: string[]; scope: { conditions?: string[]; offerIds?: string[]; productIds?: string[]; categoryIds?: string[] } }[];
}

export interface Harness {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  api: OffersPublicApi;
  products: Map<string, catalog.ProductAdmin>;
  sellers: Map<string, SellerState>;
  shipping: Map<string, { price: number; days: number; owner?: string | null }>;
  access: { decision: access.AuthorityCheck['decision']; requests: access.RequestApprovalInput[]; cancelled: string[] };
  audits: audit.RecordInput[];
  events: { name: string; payload: any }[];
  files: Map<string, { name: string; owner: media.MediaOwner; text: string }>;
  exports: unknown[];
  /** inventory.updateStockItem calls */
  stockUpdates: { stockItemId: string; productId?: string; variantId?: string; condition?: string }[];
  /** returns.resolveTerms answers source category_exception with this summary for these category ids */
  returnExceptions: Map<string, string>;
}

const iso = (d: Date) => d.toISOString();
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10);

/**
 * o.serviceTerms: the fulfillment service is on, its getServiceTerms answering from the map (offers missing from it: null).
 * Without it the fulfillment service is off.
 */
export async function harness(o: { serviceTerms?: Map<string, fulfillment.ServiceTerms | null> } = {}): Promise<Harness> {
  const clock = movingClock();
  const h = {
    clock,
    products: new Map<string, catalog.ProductAdmin>(),
    sellers: new Map<string, SellerState>(),
    shipping: new Map<string, { price: number; days: number; owner?: string | null }>(),
    access: { decision: 'allowed' as access.AuthorityCheck['decision'], requests: [] as access.RequestApprovalInput[], cancelled: [] as string[] },
    audits: [] as audit.RecordInput[],
    events: [] as { name: string; payload: any }[],
    files: new Map<string, { name: string; owner: media.MediaOwner; text: string }>(),
    exports: [] as unknown[],
    stockUpdates: [] as { stockItemId: string; productId?: string; variantId?: string; condition?: string }[],
    returnExceptions: new Map<string, string>(),
  };
  const seller = (id: string) => h.sellers.get(id);
  const snapshot = (id: string): sellers.SellerSnapshot | null => {
    const s = seller(id);
    return s ? { id, ref: 'SL-1', slug: s.name.toLowerCase().replace(/\s+/g, '-'), storeName: s.name, status: s.status, verified: true, canSellNew: s.status === 'approved' || s.status === 'restricted', activeRestrictionIds: s.restrictions.map((r) => r.id), launchReady: s.launchReady } : null;
  };
  const app = await buildTestApp({
    only: ['offers', 'access', 'audit', 'media', 'shipping', 'returns', 'reports'],
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      catalog: {
        getProduct: async (id) => h.products.get(id)?.product ?? null,
        getProductAdmin: async (id) => h.products.get(id) ?? null,
        getProductForSeller: async (sellerId, id) => {
          const p = h.products.get(id);
          if (!p) return null;
          if (p.ownerSellerId === sellerId) return { product: p, ownsSubmission: true };
          if (p.reviewState !== 'approved') return null;
          return { product: { ...p, reviewState: 'approved' }, ownsSubmission: false };
        },
        isPurchasable: async (id) => {
          const p = h.products.get(id);
          return Boolean(p && p.reviewState === 'approved' && p.publication === 'active');
        },
      },
      sellers: {
        getSeller: async (id) => snapshot(id),
        getSellers: async (ids) => ids.map(snapshot).filter((s): s is sellers.SellerSnapshot => Boolean(s)),
        getStorefrontCard: async (ids) => ids.flatMap((id) => (seller(id) ? [{ id, slug: id.slice(0, 8), storeName: seller(id)!.name, verified: true, location: 'Portland, OR', positivePct: 98, ratingCount: 120 }] : [])),
        canSell: async (id, check) => {
          const s = seller(id);
          if (!s) return { allowed: false, reason: 'Unknown seller' };
          if (s.status === 'suspended') return { allowed: false, reason: 'The seller account is suspended', restrictionId: 'susp' };
          if (s.status === 'closed') return { allowed: false, reason: 'The seller account is closed' };
          if (check.activity === 'sales' && !s.launchReady) return { allowed: false, reason: 'The launch readiness review has not passed yet' };
          for (const r of s.restrictions) {
            if (!r.activities.includes(check.activity)) continue;
            const sc = r.scope;
            const dims: boolean[] = [];
            if (sc.conditions?.length) dims.push(!check.condition || sc.conditions.includes(check.condition));
            if (sc.offerIds?.length) dims.push(!check.offerId || sc.offerIds.includes(check.offerId));
            if (sc.categoryIds?.length) dims.push(!check.categoryId || sc.categoryIds.includes(check.categoryId));
            if (!dims.length || dims.every(Boolean)) return { allowed: false, restrictionId: r.id, reason: 'Refurbished listings restricted', appealRoute: 'Appeal in Seller Center' };
          }
          return { allowed: true };
        },
        getPerformance: async (id) =>
          ({
            period: { from: '2026-07-01', to: '2026-09-30' },
            orderCount: seller(id)?.onTimePct === null ? 0 : 50,
            overall: 'good',
            metrics: seller(id)?.onTimePct === null ? [] : [{ key: 'dispatch_reliability', label: 'On-time dispatch', value: seller(id)?.onTimePct ?? 0, display: '', target: {} as never, status: 'meets', numerator: 45, denominator: 50, detail: '', definition: '' }],
            feedback: null,
            warnings: [],
            history: [],
            updatedAt: iso(clock.now()),
          }) as sellers.PerformanceSummary,
      },
      shipping: {
        quote: async (profileId, postalCode, _parcel, dispatch) => {
          const p = h.shipping.get(profileId);
          if (!p) throw new AppError('NOT_FOUND', 'Unknown shipping profile');
          if (postalCode.startsWith('99')) return { shipsToLocation: false, reason: 'Does not ship to Alaska', options: [], default: null };
          const now = clock.now();
          const option: shipping.DeliveryOption = {
            id: `${profileId}:std`,
            methodCode: 'standard',
            methodName: 'Standard',
            carrierService: 'UPS Ground',
            price: { amount: p.price, currency: 'USD' },
            free: p.price === 0,
            fundedBy: p.price === 0 ? 'seller' : 'customer',
            freeReason: null,
            arrival: { from: addDays(now, dispatch.businessDays + p.days - 1), to: addDays(now, dispatch.businessDays + p.days) },
            arrivalLabel: `Arrives ${addDays(now, dispatch.businessDays + p.days)}`,
            dispatchBy: iso(now),
            dispatchLabel: `Ships from ${dispatch.shipsFrom}`,
            cutoffAt: null,
            notices: [],
            isDefault: true,
          };
          return { shipsToLocation: true, reason: null, options: [option], default: option };
        },
        getSellerShippingSummaries: async () => ({}),
        getProfileOwners: async (ids) => Object.fromEntries(ids.map((id) => { const p = h.shipping.get(id); return [id, p ? { ownerType: p.owner ? ('seller' as const) : ('official' as const), sellerId: p.owner ?? null, status: 'active' } : null]; })),
      },
      returns: {
        resolveTerms: async (sellerId, categoryId, condition) => ({
          sellerId: sellerId ?? 'official',
          categoryId,
          windowDays: 30,
          changeOfMindAllowed: true,
          condition,
          responsibilities: [],
          remedies: ['refund'],
          responseTargetBusinessDays: 2,
          summary: (categoryId && h.returnExceptions.get(categoryId)) || '30-day returns',
          policyVersion: 'v1',
          sellerTermsVersion: null,
          source: categoryId && h.returnExceptions.has(categoryId) ? ('category_exception' as const) : ('baseline' as const),
        }),
      },
      access: {
        check: async (_p, action) => ({
          decision: h.access.decision,
          action,
          reason: h.access.decision === 'allowed' ? 'Within your 30% limit' : h.access.decision === 'denied' ? 'Your role cannot change prices' : 'Above your limit: Business Owner approval',
          requiresSecondReviewer: false,
          approvalsNeeded: h.access.decision === 'approval_required' ? 1 : 0,
          eligibleApproverRoles: [],
          eligibleApprovers: [],
          stepUpRequired: false,
        }),
        requestApproval: async (input) => {
          h.access.requests.push(input);
          return { id: newId(), ref: 'AP-261009-0001', target: input.target, summary: input.summary, status: 'pending' } as unknown as access.ApprovalRequest;
        },
        cancelApproval: async (requestId) => {
          h.access.cancelled.push(requestId);
        },
        approvalInfo: async (id) => ({ required: true, reason: 'Waiting for Olivia Owner', approvalRequestId: id, approvers: ['Olivia Owner'] }),
      },
      audit: {
        record: async (entry) => {
          h.audits.push(entry);
          return newId() as never;
        },
      },
      media: {
        getAsset: async (id) => {
          const f = h.files.get(id);
          return f ? ({ id, fileName: f.name, owner: f.owner, status: 'ready' } as unknown as media.MediaAsset) : null;
        },
        signedDownload: async (id) => {
          const f = h.files.get(id);
          if (!f) throw new AppError('NOT_FOUND', 'File not found');
          return { url: `data:text/csv;base64,${Buffer.from(f.text).toString('base64')}`, expiresAt: iso(new Date(clock.now().getTime() + 3_600_000)), fileName: f.name, contentType: 'text/csv', sizeBytes: f.text.length };
        },
        readFile: async (id) => {
          const f = h.files.get(id);
          if (!f) throw new AppError('NOT_FOUND', 'File not found');
          const body = new TextEncoder().encode(f.text);
          return { fileName: f.name, contentType: 'text/csv', sizeBytes: body.length, body };
        },
        storeGeneratedFile: async (input) => {
          const id = newId();
          const text = await new Response(input.body).text();
          h.files.set(id, { name: input.fileName, owner: input.owner, text });
          return { id, fileName: input.fileName, owner: input.owner, status: 'ready' } as unknown as media.MediaAsset;
        },
      },
      reports: {
        registerDataset: async () => {},
        requestExport: async (input) => {
          h.exports.push(input);
          return { id: newId(), ref: 'EX-1', dataset: input.dataset, format: input.format, filters: input.filters, requestedBy: { kind: 'seller', id: input.principal.accountId ?? null }, sellerId: input.sellerId ?? null, state: 'queued', columnsExcluded: [], createdAt: iso(clock.now()) };
        },
      },
    },
  });
  for (const name of OFFER_EVENTS) app.kernel.events.subscribe('test', name, (e) => void h.events.push({ name, payload: e.payload }));
  fakeInventory(app, h);
  if (o.serviceTerms) fakeFulfillmentService(app, o.serviceTerms);
  return { ...h, app, api: app.kernel.boot.apis.get('offers') as OffersPublicApi };
}

/**
 * fulfillment-service is being rebuilt in parallel and cannot boot yet, so apiStubs (which only replace functions of
 * running modules) cannot reach it: offers' optional-module lookup answers a stand-in whose getServiceTerms reads the map.
 */
function fakeFulfillmentService(app: FastifyInstance, terms: Map<string, fulfillment.ServiceTerms | null>) {
  const ctx = (app.kernel.boot.apis.get('offers') as OffersService).core.ctx as unknown as { tryUse: (m: string) => unknown };
  const tryUse = ctx.tryUse.bind(ctx);
  const stub = { getServiceTerms: async (offerIds: string[]) => Object.fromEntries(offerIds.map((id) => [id, terms.get(id) ?? null])) };
  ctx.tryUse = (m: string) => (m === 'fulfillment-service' ? stub : tryUse(m));
}

/**
 * In-memory stock behind the inventory functions offers calls (inventory itself is being changed in parallel):
 * stock items per offer with available units, SKU uniqueness per owner (SKU_TAKEN), availability cues and
 * inventory.stock.changed published the way inventory does. Replaced on the service instance, because apiStubs
 * would wrap the service in a proxy its private methods refuse.
 */
function fakeInventory(app: FastifyInstance, h: Pick<Harness, 'stockUpdates'> & { clock: ReturnType<typeof movingClock> }) {
  type Item = { id: string; ownerType: 'official' | 'seller'; sellerId: string | null; sku: string; offerId: string | null; productId: string; variantId: string; condition: string; label: string; available: number; lowStockThreshold: number | null; archived: boolean };
  const items = new Map<string, Item>();
  const stateOf = (i: Item) => (i.available <= 0 ? 'out_of_stock' : i.lowStockThreshold !== null && i.available <= i.lowStockThreshold ? 'low_stock' : 'in_stock');
  const changed = (i: Item, previousAvailable: number, cause: string) =>
    app.kernel.events.publish('inventory', 'inventory.stock.changed', { stockItemId: i.id, offerId: i.offerId, ownerType: i.ownerType, sellerId: i.sellerId, productId: i.productId, variantId: i.variantId, available: i.available, reserved: 0, previousAvailable, state: stateOf(i), archived: i.archived, cause }, { actor: { kind: 'system', id: null } });
  const api = (i: Item) => ({
    id: i.id,
    ownerType: i.ownerType,
    sellerId: i.sellerId,
    sku: i.sku,
    offerId: i.offerId,
    productId: i.productId,
    variantId: i.variantId,
    condition: i.condition,
    label: i.label,
    image: null,
    quantities: { available: i.available, reserved: 0, incoming: 0, damagedHeld: 0 },
    state: stateOf(i),
    lowStockThreshold: i.lowStockThreshold,
    nextIncoming: null,
    archived: i.archived,
    updatedAt: h.clock.now().toISOString(),
  });
  const inventory = app.kernel.boot.apis.get('inventory') as Record<string, unknown>;
  inventory.createStockItem = async (input: { ownerType: 'official' | 'seller'; sellerId?: string; offerId?: string; sku: string; productId: string; variantId: string; condition: string; label: string; initialAvailable: number; lowStockThreshold?: number }) => {
    const owner = input.ownerType === 'seller' ? (input.sellerId ?? null) : null;
    if ([...items.values()].some((i) => !i.archived && i.ownerType === input.ownerType && i.sellerId === owner && i.sku === input.sku)) throw new AppError('SKU_TAKEN', `SKU ${input.sku} is already used by another stock item`, undefined, 409);
    const item: Item = { id: newId(), ownerType: input.ownerType, sellerId: owner, sku: input.sku, offerId: input.offerId ?? null, productId: input.productId, variantId: input.variantId, condition: input.condition, label: input.label, available: input.initialAvailable, lowStockThreshold: input.lowStockThreshold ?? null, archived: false };
    items.set(item.id, item);
    changed(item, 0, 'receipt');
    return api(item);
  };
  inventory.getAvailability = async (ids: string[]) => Object.fromEntries(ids.filter((id) => items.has(id)).map((id) => [id, { available: items.get(id)!.archived ? 0 : items.get(id)!.available, state: stateOf(items.get(id)!), lowStockThreshold: items.get(id)!.lowStockThreshold, nextIncoming: null }]));
  inventory.applyBulkQuantities = async (_sellerId: string, rows: { stockItemId: string; newAvailable: number }[]) =>
    rows.map((r) => {
      const i = items.get(r.stockItemId);
      if (!i) return { stockItemId: r.stockItemId, ok: false, error: 'Unknown stock item' };
      const before = i.available;
      i.available = r.newAvailable;
      changed(i, before, 'bulk_update');
      return { stockItemId: r.stockItemId, ok: true };
    });
  inventory.getOfferAvailability = async (offers: { offerId: string; stockItemId: string; purchaseLimit?: number }[]) =>
    Object.fromEntries(
      offers.map((o) => {
        const i = items.get(o.stockItemId);
        const available = i && !i.archived ? i.available : 0;
        const state = i ? stateOf(i) : 'out_of_stock';
        const limit = o.purchaseLimit ?? null;
        return [o.offerId, { state, quantity: state === 'low_stock' ? available : null, maxPerOrder: Math.max(0, limit !== null ? Math.min(available, limit) : available), purchaseLimit: limit, label: state === 'out_of_stock' ? 'Out of stock' : state === 'low_stock' ? `Only ${available} left` : 'In stock', expectedRestockDate: null }];
      }),
    );
  inventory.getStockForOffers = async (offerIds: string[], viewer: { sellerId?: string }) =>
    Object.fromEntries(offerIds.map((id) => {
      const i = [...items.values()].find((x) => x.offerId === id && (!viewer.sellerId || (x.ownerType === 'seller' && x.sellerId === viewer.sellerId)));
      return [id, i ? api(i) : null];
    }));
  inventory.getUnitCost = async () => null;
  inventory.getDefaultLocation = async () => ({ id: newId(), code: 'RNO1', name: 'Reno warehouse', kind: 'warehouse', ownerType: 'official', sellerId: null, address: ADDRESS, timeZone: 'America/Los_Angeles', sellable: true, active: true, isDefault: true });
  inventory.updateStockItem = async (stockItemId: string, patch: { productId?: string; variantId?: string; condition?: string }) => {
    h.stockUpdates.push({ stockItemId, ...patch });
    const i = items.get(stockItemId);
    if (i) Object.assign(i, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    return i ? api(i) : { id: stockItemId };
  };
}

/* ---------------------------------------------------------------- callers */

export const staffHeaders = (permissions?: string[]) => auth(token({ ...devClaims('staff', { permissions }), dev: { permissions: permissions ?? ['*'], name: 'Priya Nair' } }, 400 * 86_400));
export const sellerHeaders = (o: DevOptions = {}) => {
  const c = devClaims('seller', o);
  return auth(token({ ...c, dev: { ...c.dev, name: 'Avery Stone' } }, 400 * 86_400));
};
export const visitorHeaders = () => auth(token(devClaims('visitor'), 400 * 86_400));

export async function call(h: Harness, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, headers: Record<string, string>, payload?: unknown) {
  const res = await h.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  await h.app.kernel.events.drain();
  return res;
}

export const asSeller = (h: Harness, sellerId: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: unknown) => call(h, method, `/api/seller/offers${path}`, sellerHeaders({ sellerId }), payload);
export const asStaff = (h: Harness, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: unknown) => call(h, method, `/api/admin/offers${path}`, staffHeaders(), payload);
export const asVisitor = (h: Harness, path: string) => call(h, 'GET', `/api/store/offers${path}`, visitorHeaders());

export const eventsNamed = (h: Harness, name: string) => h.events.filter((e) => e.name === name).map((e) => e.payload);

/* ---------------------------------------------------------------- fixtures */

export function addSeller(h: Harness, over: Partial<SellerState> = {}): string {
  const id = newId();
  h.sellers.set(id, { status: 'approved', launchReady: true, name: `Seller ${h.sellers.size + 1}`, onTimePct: 97, restrictions: [], ...over });
  return id;
}

export function addProduct(h: Harness, over: { reviewState?: catalog.ProductAdmin['reviewState']; publication?: catalog.ProductAdmin['publication']; ownerSellerId?: string | null; variants?: number; includedItems?: string[]; specs?: Record<string, string>; categoryId?: string } = {}) {
  const id = newId();
  const variants = Array.from({ length: over.variants ?? 2 }, (_, i) => ({ id: newId(), options: { Color: ['Black', 'Silver', 'Sage'][i] ?? `C${i}` }, gtin: null, images: [] }));
  const p = {
    product: {
      id,
      ref: `PRD-${Math.floor(Math.random() * 1e5)}`,
      title: 'Halden Aurora ANC Headphones',
      slug: `halden-aurora-${id.slice(0, 6)}`,
      brand: null,
      categoryId: over.categoryId ?? newId(),
      categoryPath: ['Electronics', 'Headphones'],
      description: 'Over-ear headphones',
      keyFeatures: [],
      specs: over.specs ?? {},
      includedItems: over.includedItems ?? ['Headphones', 'USB-C cable', 'Carry case'],
      images: [],
      video: null,
      modelNumber: 'HAL-AUR',
      manufacturerPartNumber: null,
      noGtin: false,
      variants,
      updatedAt: new Date().toISOString(),
      listedAt: null,
    },
    owner: over.ownerSellerId ? 'seller' : 'official',
    ownerSellerId: over.ownerSellerId ?? null,
    reviewState: over.reviewState ?? 'approved',
    publication: over.publication ?? 'active',
    version: 1,
    missing: [],
    reviewLog: [],
    duplicateCandidates: [],
    submission: null,
    checks: [],
    requestedBrand: null,
    contentScore: 90,
    duplicateSuspected: false,
    offerCount: 0,
    liveOfferCount: 0,
    bestPrice: null,
    offerNote: null,
    reviewDraft: null,
  } as catalog.ProductAdmin;
  h.products.set(id, p);
  return { id, variants: variants.map((v) => v.id), product: p };
}

/** A shipping profile owned by a seller (id) or the Official Store (null) */
export function profile(h: Harness, price = 599, days = 3, owner: string | null = null): string {
  const id = newId();
  h.shipping.set(id, { price, days, owner });
  return id;
}

let skuSeq = 0;
export const sku = (prefix = 'SKU') => `${prefix}-${++skuSeq}-${Math.floor(Math.random() * 1e6)}`;

export function offerInput(productId: string, variantId: string, profileId: string, over: Record<string, unknown> = {}) {
  return {
    productId,
    variantId,
    condition: 'new',
    price: { amount: 18900, currency: 'USD' },
    sellerSku: sku('NW'),
    quantity: 10,
    dispatchBusinessDays: 1,
    shippingProfileId: profileId,
    returnTerms: { kind: 'baseline' },
    warranty: { kind: 'manufacturer', months: 24 },
    ...over,
  };
}

/** A published seller offer; returns its id and stock item id */
export async function sellerOffer(h: Harness, sellerId: string, productId: string, variantId: string, over: Record<string, unknown> = {}) {
  const res = await asSeller(h, sellerId, 'POST', '/offers', offerInput(productId, variantId, (over.shippingProfileId as string) ?? profile(h, 599, 3, sellerId), { publish: true, ...over }));
  if (res.statusCode !== 201) throw new Error(res.body);
  const body = res.json();
  return { id: body.offer.id as string, stockItemId: body.offer.stockItemId as string, body };
}

export const ADDRESS = { name: 'Marketly Reno', line1: '100 Logistics Way', city: 'Reno', region: 'NV', postalCode: '89502', country: 'US' };

/** A company warehouse so Official Store offers can get stock items */
export async function warehouse(h: Harness) {
  const code = `W${Math.floor(Math.random() * 1e6)}`;
  const res = await call(h, 'POST', '/api/admin/inventory/locations', staffHeaders(), { code, name: `${code} warehouse`, address: ADDRESS, timeZone: 'America/Los_Angeles' });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().id as string;
}

/** Sets a seller offer's available quantity through inventory (stock.changed follows) */
export async function setStock(h: Harness, sellerId: string, stockItemId: string, available: number) {
  const inventory = h.app.kernel.boot.apis.get('inventory') as { applyBulkQuantities(s: string, rows: { stockItemId: string; newAvailable: number }[], jobId: string, actor: unknown): Promise<unknown> };
  await inventory.applyBulkQuantities(sellerId, [{ stockItemId, newAvailable: available }], newId(), { kind: 'seller', id: null });
  await h.app.kernel.events.drain();
}

export const DAY = 86_400_000;

/** Publishes another module's event and waits for the consumers */
export async function emit(h: Harness, name: string, payload: unknown) {
  h.app.kernel.events.publish(name.split('.')[0]!, name, payload, { actor: { kind: 'system', id: null } });
  await h.app.kernel.events.drain();
}
