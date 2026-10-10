/**
 * Test kit for search: boots search with its optional dependencies and a small in-memory "world" behind
 * stubbed public APIs, so tests control what each source module answers:
 *   catalog: products, categories (with filterable attributes) and brands (active or not);
 *   offers (built in parallel): offers by product (listOffersAdmin), featured offer, delivery quotes, own-offer search;
 *   inventory: stock state per offer; reviews: rating summaries; promotions: campaign prices;
 *   sellers: store names, cards and slugs; customers: customer ids and the recent-searches preference;
 *   orders: order items (sales counts) and lookups; returns: seller lookups; advertising: sponsored products.
 * Events are published on the bus with the source specs' payloads.
 */
import type { FastifyInstance } from 'fastify';
import { notImplemented as ni } from '../../../kernel/errors/index.js';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as catalog from '../../../spec/catalog.js';
import { auth, buildTestApp, callers, movingClock } from '../../../testing/app.js';
import type { OpenSearchConfig } from '../infra/config.js';
import { openSearchTesting } from '../infra/select.js';
import type { SearchService } from '../service.js';
import { fakeClientOptions, FakeOpenSearch } from './opensearch-fake/connection.js';

export { auth, callers, newId };

export const STORE = '/api/store/search';
export const SELLER = '/api/seller/search';
export const ADMIN = '/api/admin/search';

/** EAN-13 with a valid check digit */
export function ean(seed: number): string {
  const body = `400${String(seed).padStart(9, '0')}`.slice(0, 12);
  const sum = body
    .split('')
    .reverse()
    .reduce((a, d, i) => a + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export interface WorldOffer {
  id: string;
  productId: string;
  variantId: string;
  sellerId: string | null;
  sellerName: string;
  condition: string;
  price: number;
  status: string;
  compareAt?: number | null;
  dispatchDays: number;
  cutoff?: string | null;
  free: boolean;
  stock: 'in_stock' | 'low_stock' | 'out_of_stock';
  eligible: boolean;
  sku: string;
}

export class World {
  categories: (catalog.Category & { filters: catalog.Attribute[] })[] = [];
  products = new Map<string, catalog.Product & { purchasable: boolean }>();
  brands = new Map<string, catalog.Brand & { active: boolean }>();
  offers = new Map<string, WorldOffer>();
  featured = new Map<string, string>();
  ratings = new Map<string, { average: number; count: number }>();
  sellers = new Map<string, { id: string; slug: string; storeName: string; verified: boolean; status: string }>();
  promos = new Map<string, { price: number; regular: number; endsAt: string }>();
  customers = new Map<string, { id: string; recentSearches: boolean; personalized?: boolean }>();
  orders = new Map<string, { productId: string; quantity: number }[]>();
  /** orderId → placedAt (default now) */
  placedAt = new Map<string, string>();
  /** What advertising.sponsoredForResults was asked */
  sponsoredCalls: unknown[] = [];
  /** audit.record entries */
  audits: { action: string; [k: string]: unknown }[] = [];
  sponsored: { position: number; productId: string; offerId: string; price: number; advertiser: string }[] = [];
  /** Modules answering NOT_IMPLEMENTED (like an unbuilt module) */
  down = new Set<string>();
  private seq = 1;

  private tree(): catalog.Category[] {
    const build = (parent: string | null): catalog.Category[] =>
      this.categories
        .filter((c) => (c.parentId ?? null) === parent)
        .map(({ filters: _f, ...c }) => ({ ...c, children: build(c.id) }));
    return build(null);
  }

  category(name: string, o: { parentId?: string; filters?: { name: string; kind?: catalog.Attribute['kind']; options?: string[]; unit?: string }[]; visible?: boolean } = {}) {
    const id = newId();
    const c = {
      id,
      parentId: o.parentId ?? null,
      name,
      slug: slugify(name),
      position: this.categories.length,
      visible: o.visible ?? true,
      comingSoon: false,
      productCount: 0,
      children: [],
      image: null,
      filters: (o.filters ?? []).map((f) => ({ id: newId(), categoryId: id, name: f.name, kind: f.kind ?? 'enum', unit: f.unit ?? null, options: f.options ?? [], required: false, filterable: true, variantDefining: false })),
    };
    this.categories.push(c);
    return c;
  }

  brand(name: string, active = true) {
    const b = { id: newId(), name, slug: slugify(name), logo: null, description: null, productCount: 0, banner: null, status: (active ? 'active' : 'blocked') as 'active' | 'blocked', active };
    this.brands.set(b.slug, b);
    return b;
  }

  seller(storeName: string, o: { verified?: boolean } = {}) {
    const s = { id: newId(), slug: slugify(storeName), storeName, verified: o.verified ?? true, status: 'approved' };
    this.sellers.set(s.id, s);
    return s;
  }

  product(o: { title: string; categoryId: string; brand?: { id: string; slug: string; name: string }; specs?: Record<string, string>; variants?: { options: Record<string, string>; gtin?: string | null }[]; description?: string; listedAt?: string; model?: string }) {
    const id = newId();
    const brand = o.brand ? [...this.brands.values()].find((b) => b.id === o.brand!.id) : undefined;
    const path: string[] = [];
    let cur = this.categories.find((c) => c.id === o.categoryId);
    while (cur) {
      path.unshift(cur.name);
      cur = this.categories.find((c) => c.id === cur!.parentId);
    }
    const p = {
      id,
      ref: `PRD-${String(this.seq++).padStart(5, '0')}`,
      title: o.title,
      slug: slugify(o.title),
      brand: brand ? { id: brand.id, name: brand.name, slug: brand.slug, logo: null, description: null, productCount: 0, banner: null, status: brand.status } : null,
      categoryId: o.categoryId,
      categoryPath: path,
      description: o.description ?? `${o.title}: a product for tests.`,
      keyFeatures: [],
      specs: o.specs ?? {},
      includedItems: [],
      images: [{ id: newId(), url: `https://media.example.com/${id}.jpg` }],
      video: null,
      modelNumber: o.model ?? null,
      manufacturerPartNumber: null,
      noGtin: false,
      variants: (o.variants ?? [{ options: {}, gtin: null }]).map((v) => ({ id: newId(), options: v.options, gtin: v.gtin ?? null, images: [] })),
      updatedAt: new Date().toISOString(),
      listedAt: o.listedAt ?? new Date(Date.now() - 60 * 86_400_000).toISOString(),
      purchasable: true,
    };
    this.products.set(id, p);
    return p;
  }

  offer(productId: string, o: Partial<Omit<WorldOffer, 'id' | 'productId'>> & { price: number }) {
    const p = this.products.get(productId);
    const id = newId();
    const seller = o.sellerId ? this.sellers.get(o.sellerId) : undefined;
    const offer: WorldOffer = {
      id,
      productId,
      variantId: o.variantId ?? p?.variants[0]?.id ?? newId(),
      sellerId: o.sellerId ?? null,
      sellerName: o.sellerName ?? seller?.storeName ?? 'Official Store',
      condition: o.condition ?? 'new',
      price: o.price,
      status: o.status ?? 'active',
      compareAt: o.compareAt ?? null,
      dispatchDays: o.dispatchDays ?? 1,
      cutoff: o.cutoff ?? null,
      free: o.free ?? false,
      stock: o.stock ?? 'in_stock',
      eligible: o.eligible ?? true,
      sku: o.sku ?? `SKU-${this.seq++}`,
    };
    this.offers.set(id, offer);
    return offer;
  }

  private offerOut(o: WorldOffer) {
    return {
      id: o.id,
      ownerType: o.sellerId ? 'seller' : 'official',
      sellerId: o.sellerId,
      sellerName: o.sellerName,
      productId: o.productId,
      variantId: o.variantId,
      condition: o.condition,
      includedItems: [],
      missingItems: [],
      complete: true,
      sellerSku: o.sku,
      stockItemId: o.id,
      price: { amount: o.price, currency: 'USD' },
      compareAt: o.compareAt ? { amount: { amount: o.compareAt, currency: 'USD' }, basis: 'lowest_30_days', verified: true, explanation: 'Lowest price in 30 days' } : null,
      saleEndsAt: null,
      purchaseLimit: null,
      dispatch: { businessDays: o.dispatchDays, sameDayCutoff: o.cutoff ?? null, shipsFrom: 'Reno, NV', label: 'Ships soon' },
      shippingProfileId: newId(),
      status: o.status,
      featuredEligibility: { eligible: o.eligible, reasons: [], evaluatedAt: new Date().toISOString() },
      publishOnApproval: false,
      termsVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never;
  }

  stubs() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const w = this;
    /** A module in `down` answers like an unbuilt one */
    const notImplemented = async (module: string) => {
      if (w.down.has(module)) throw ni(module);
    };
    return {
      catalog: {
        getProduct: async (id: string) => {
          const p = w.products.get(id);
          if (!p) return null;
          const { purchasable: _p, ...rest } = p;
          return rest as catalog.Product;
        },
        isPurchasable: async (id: string) => Boolean(w.products.get(id)?.purchasable),
        listCategories: async () => w.tree(),
        getCategoryBySlug: async (slug: string) => {
          const c = w.categories.find((x) => x.slug === slug);
          if (!c || !c.visible) return null;
          const find = (list: catalog.Category[], id: string): catalog.Category | undefined => {
            for (const x of list) {
              if (x.id === id) return x;
              const hit = find(x.children, id);
              if (hit) return hit;
            }
            return undefined;
          };
          const tree = w.tree();
          const breadcrumb: catalog.Category[] = [];
          for (let cur: typeof c | undefined = c; cur; cur = w.categories.find((x) => x.id === cur!.parentId)) breadcrumb.unshift({ ...find(tree, cur.id)!, children: [] });
          return { category: find(tree, c.id)!, breadcrumb, filters: c.filters };
        },
        getBrandBySlug: async (slug: string) => {
          const b = w.brands.get(slug);
          if (!b || !b.active) return null;
          const { active: _a, ...rest } = b;
          return rest;
        },
      },
      offers: {
        listOffersAdmin: async (filter: { productId?: string; status?: string[]; q?: string }) => {
          await notImplemented('offers');
          const items = [...w.offers.values()]
            .filter((o) => (!filter.productId || o.productId === filter.productId) && (!filter.status || filter.status.includes(o.status)) && (!filter.q || o.sku.toLowerCase().includes(filter.q.toLowerCase())))
            .map((o) => w.offerOut(o));
          return { items, nextCursor: null };
        },
        getFeaturedOfferForProduct: async (items: { productId: string }[]) => {
          await notImplemented('offers');
          return Object.fromEntries(items.map((i) => [i.productId, w.featured.has(i.productId) ? w.offerOut(w.offers.get(w.featured.get(i.productId)!)!) : null]));
        },
        quoteOffer: async (offerId: string) => {
          await notImplemented('offers');
          const o = w.offers.get(offerId);
          return { offerId, delivery: { free: Boolean(o?.free), label: 'Delivery', shipsToLocation: true, shipsFrom: 'Reno, NV', dispatchLabel: 'Ships soon' } } as never;
        },
        searchOwnOffers: async (sellerId: string, q: string, limit: number) => {
          await notImplemented('offers');
          const items = [...w.offers.values()]
            .filter((o) => o.sellerId === sellerId && (o.sku.toLowerCase().includes(q.toLowerCase()) || (w.products.get(o.productId)?.title ?? '').toLowerCase().includes(q.toLowerCase())))
            .map((o) => ({ id: o.id, productId: o.productId, variantId: o.variantId, productTitle: w.products.get(o.productId)?.title ?? '', variantLabel: 'Black', ownerType: 'seller', condition: o.condition, sellerSku: o.sku, price: { amount: o.price, currency: 'USD' }, status: o.status, featured: false, featuredEligible: true }));
          return { items: items.slice(0, limit), more: items.length > limit } as never;
        },
        getOffer: async (id: string) => {
          const o = w.offers.get(id);
          return o ? w.offerOut(o) : null;
        },
      },
      inventory: {
        getOfferAvailability: async (list: { offerId: string }[]) => {
          await notImplemented('inventory');
          return Object.fromEntries(list.map((l) => [l.offerId, { state: w.offers.get(l.offerId)?.stock ?? 'in_stock', quantity: 5, maxPerOrder: 5, purchaseLimit: null, label: 'In stock', expectedRestockDate: null }]));
        },
      },
      reviews: {
        getRatingSummaries: async (ids: string[]) => {
          await notImplemented('reviews');
          return ids.map((productId) => {
            const r = w.ratings.get(productId);
            return { productId, hasReviews: Boolean(r), average: r?.average ?? null, ratingCount: r?.count ?? 0, writtenCount: 0, distribution: [], answeredQuestions: 0, withPhotos: 0 };
          }) as never;
        },
      },
      promotions: {
        priceOffers: async (offerIds: string[]) => {
          await notImplemented('promotions');
          return offerIds
            .filter((id) => w.promos.has(id))
            .map((id) => {
              const p = w.promos.get(id)!;
              return { offerId: id, regularPrice: { amount: p.regular, currency: 'USD' }, price: { amount: p.price, currency: 'USD' }, wasPrice: null, badges: [], campaignId: newId(), flash: { campaignId: newId(), startsAt: new Date().toISOString(), endsAt: p.endsAt, claimedPct: 0, dealStockLeft: 10, state: 'active' }, sellerPromos: [] };
            }) as never;
        },
      },
      sellers: {
        getSellers: async (ids: string[]) => ids.map((id) => w.sellers.get(id)).filter(Boolean).map((s) => ({ id: s!.id, ref: 'SL-1', slug: s!.slug, storeName: s!.storeName, status: s!.status, verified: s!.verified, canSellNew: true, activeRestrictionIds: [], launchReady: true })) as never,
        getSeller: async (id: string) => {
          const s = w.sellers.get(id);
          return s ? ({ id: s.id, ref: 'SL-1', slug: s.slug, storeName: s.storeName, status: s.status, verified: s.verified, canSellNew: true, activeRestrictionIds: [], launchReady: true } as never) : null;
        },
        getStorefrontCard: async (ids: string[]) => ids.map((id) => w.sellers.get(id)).filter(Boolean).map((s) => ({ id: s!.id, slug: s!.slug, storeName: s!.storeName, logo: null, verified: s!.verified, location: 'Austin, TX', positivePct: 98.4, ratingCount: 120 })) as never,
        getStorefrontBySlug: async (slug: string) => {
          const s = [...w.sellers.values()].find((x) => x.slug === slug);
          return s ? ({ seller: { id: s.id, slug: s.slug, storeName: s.storeName, verified: s.verified } } as never) : null;
        },
        searchSellers: async (f: { search?: string }) => ({ items: [...w.sellers.values()].filter((s) => !f.search || s.storeName.toLowerCase().includes(f.search.toLowerCase())).map((s) => ({ id: s.id, ref: 'SL-1', slug: s.slug, storeName: s.storeName, status: s.status, verified: s.verified, canSellNew: true, activeRestrictionIds: [], launchReady: true })), nextCursor: null }) as never,
      },
      customers: {
        getCustomerByUserId: async (accountId: string) => {
          const c = w.customers.get(accountId);
          return c ? ({ id: c.id, userId: accountId, ref: 'CU-1', displayName: 'Ana Ruiz', email: 'ana@example.com', accountStatus: 'active', canOrder: true, canMessage: true } as never) : null;
        },
        getMarketingConsent: async (customerId: string) => {
          const c = [...w.customers.values()].find((x) => x.id === customerId);
          return { emailPromotions: false, smsPromotions: false, pushPromotions: false, wishlistAlerts: false, personalizedRecommendations: Boolean(c?.personalized), recentSearches: Boolean(c?.recentSearches), essentialAlwaysOn: true, updatedAt: new Date().toISOString() } as never;
        },
        searchCustomers: async (f: { search?: string }) => ({ items: f.search?.toLowerCase().startsWith('ana') ? [{ id: newId(), userId: newId(), ref: 'CU-208114', displayName: 'Ana Ruiz', email: 'ana@example.com', accountStatus: 'active', canOrder: true, canMessage: true }] : [], nextCursor: null }) as never,
      },
      orders: {
        getOrder: async (orderId: string) => {
          await notImplemented('orders');
          const items = w.orders.get(orderId);
          return items ? ({ id: orderId, placedAt: w.placedAt.get(orderId) ?? new Date().toISOString(), groups: [{ items: items.map((i) => ({ product: { productId: i.productId }, quantity: i.quantity })) }] } as never) : null;
        },
        listOrdersAdmin: async (f: { q?: string }) => {
          await notImplemented('orders');
          return { items: f.q?.startsWith('MK') ? [{ order: { id: newId(), ref: 'MK-261009-00001', statusLabel: 'Preparing' }, customer: { name: 'Ana Ruiz' } }] : [], nextCursor: null } as never;
        },
        listOrdersForSeller: async (_s: string, f: { q?: string }) => {
          await notImplemented('orders');
          return { items: f.q?.startsWith('MK') ? [{ order: { id: newId(), ref: 'MK-261009-00002', statusLabel: 'Preparing', contact: { name: 'Ana Ruiz' } }, groups: [{ buyerName: 'Ana R.', statusLabel: 'To ship' }] }] : [], nextCursor: null } as never;
        },
      },
      returns: {
        listForSeller: async () => {
          await notImplemented('returns');
          return { items: [], nextCursor: null } as never;
        },
      },
      audit: {
        record: async (e: { action: string }) => {
          w.audits.push(e);
          return newId();
        },
      },
      advertising: {
        sponsoredForResults: async (ctx: unknown) => {
          w.sponsoredCalls.push(ctx);
          await notImplemented('advertising');
          return w.sponsored.map((s) => ({
            position: s.position,
            impression: { impressionToken: `imp-${s.offerId}`, campaignId: newId(), creativeId: newId(), placementKey: 'search_top_row', label: 'Sponsored', advertiserName: s.advertiser, headline: 'Ad', buttonText: 'Shop', destination: '/x', dismissible: false, promotedOffer: { offerId: s.offerId, productId: s.productId, title: 'x', price: { amount: s.price, currency: 'USD' }, sellerName: s.advertiser } },
          })) as never;
        },
      },
    };
  }
}

export interface Kit {
  app: FastifyInstance;
  svc: SearchService;
  world: World;
  clock: ReturnType<typeof movingClock>;
  events: EventEnvelope[];
  of(name: string): any[];
  emit(source: string, name: string, payload: unknown): Promise<void>;
  call(method: string, url: string, token?: string, body?: unknown): Promise<{ status: number; body: any }>;
  staff: string;
  visitor: string;
  /** Index a product (catalog.product.approved) */
  index(productId: string): Promise<void>;
  job(name: string): Promise<void>;
  close(): Promise<void>;
  /** The engine under test, and the in-memory OpenSearch behind it (opensearch only) */
  engine: Engine;
  fake?: FakeOpenSearch;
}

/**
 * Which engine the kit boots: postgres (default) or opensearch (the OpenSearch adapter on the in-memory fake).
 * SEARCH_TEST_ENGINE=opensearch runs every search test file on the OpenSearch adapter.
 */
export type Engine = 'postgres' | 'opensearch';
export const defaultEngine = (): Engine => (process.env.SEARCH_TEST_ENGINE === 'opensearch' ? 'opensearch' : 'postgres');

/** OpenSearch settings for tests: no waiting on alias caches, writes visible at once */
export const testOpenSearchConfig = (o: Partial<OpenSearchConfig> = {}): OpenSearchConfig => ({
  nodes: ['http://opensearch.test:9200'],
  auth: null,
  indexPrefix: 'test',
  shards: 1,
  replicas: 0,
  refresh: 'false',
  requestTimeoutMs: 5_000,
  bulkAttempts: 3,
  aliasCacheMs: 0,
  ...o,
});

/** `settings`: search setting overrides by key (e.g. { transitBusinessDays: 0 }); others keep their defaults */
export async function boot(o: { settings?: Record<string, unknown>; engine?: Engine; fake?: FakeOpenSearch; opensearch?: Partial<OpenSearchConfig> } = {}): Promise<Kit> {
  const world = new World();
  const clock = movingClock();
  const overrides = o.settings ?? {};
  const engine = o.engine ?? defaultEngine();
  const fake = engine === 'opensearch' ? (o.fake ?? new FakeOpenSearch()) : undefined;
  if (fake) {
    openSearchTesting.config = { engine: 'opensearch', opensearch: testOpenSearchConfig(o.opensearch) };
    openSearchTesting.clientOptions = fakeClientOptions(fake);
    openSearchTesting.sleep = async () => {};
  } else openSearchTesting.config = { engine: 'postgres' };
  const app = await buildTestApp({
    only: ['search', 'inventory', 'reviews', 'sellers', 'advertising', 'promotions', 'customers', 'orders', 'returns', 'audit'],
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: { ...(world.stubs() as object), ...(o.settings ? { settings: { get: async (key: string) => (key.startsWith('search.') ? (overrides[key.slice(7)] ?? null) : null) } } : {}) } as never,
  }).finally(() => {
    delete openSearchTesting.config;
    delete openSearchTesting.clientOptions;
    delete openSearchTesting.sleep;
  });
  const events: EventEnvelope[] = [];
  for (const n of ['search.synonym.changed', 'search.index.rebuilt', 'search.ranking_policy.published']) app.kernel.events.subscribe('test', n, (e) => void events.push(e));
  const staff = callers.staff();
  const visitor = callers.visitor();
  const kit: Kit = {
    app,
    svc: app.kernel.boot.apis.get('search') as SearchService,
    world,
    clock,
    events,
    of: (name) => events.filter((e) => e.name === name).map((e) => e.payload),
    async emit(source, name, payload) {
      app.kernel.events.publish(source, name, payload);
      await app.kernel.events.drain();
    },
    async call(method, url, token = visitor, body) {
      const res = await app.inject({ method: method as never, url, headers: auth(token), ...(body !== undefined ? { payload: body as never } : {}) });
      await app.kernel.events.drain();
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    },
    staff,
    visitor,
    async index(productId) {
      await kit.emit('catalog', 'catalog.product.approved', { productId, ownerSellerId: null });
    },
    async job(name) {
      await app.kernel.jobs.runNow(name as never);
      await app.kernel.events.drain();
    },
    close: () => app.close(),
    engine,
    ...(fake ? { fake } : {}),
  };
  return kit;
}

/** A small shop: Electronics › Headphones (with filters), Home; brands; sellers; products with offers */
export async function shop(k: Kit) {
  const w = k.world;
  const electronics = w.category('Electronics');
  const headphones = w.category('Headphones', { parentId: electronics.id, filters: [{ name: 'Noise cancelling', options: ['Active', 'None'] }, { name: 'Color', options: ['Black', 'White', 'Silver'] }] });
  const speakers = w.category('Speakers', { parentId: electronics.id });
  const home = w.category('Home');
  const aurora = w.brand('Aurora');
  const halcyon = w.brand('Halcyon');
  const grove = w.seller('Gadget Grove');
  const casa = w.seller('Casa Verde');

  const wireless = w.product({ title: 'Aurora wireless headphones', categoryId: headphones.id, brand: aurora, specs: { 'Noise cancelling': 'Active', 'Battery life': '40 h' }, variants: [{ options: { Color: 'Black' }, gtin: ean(101) }, { options: { Color: 'White' }, gtin: ean(102) }] });
  const officialOffer = w.offer(wireless.id, { price: 18900, sellerId: null, sellerName: 'Official Store', free: true, dispatchDays: 0 });
  const groveOffer = w.offer(wireless.id, { price: 17900, sellerId: grove.id, condition: 'new' });
  const usedOffer = w.offer(wireless.id, { price: 9900, sellerId: casa.id, condition: 'used_good' });
  w.featured.set(wireless.id, officialOffer.id);

  const earphones = w.product({ title: 'Halcyon earphones', categoryId: headphones.id, brand: halcyon, specs: { 'Noise cancelling': 'None' }, variants: [{ options: { Color: 'Silver' }, gtin: ean(103) }] });
  const earOffer = w.offer(earphones.id, { price: 4900, sellerId: grove.id, free: true });
  w.featured.set(earphones.id, earOffer.id);

  const speaker = w.product({ title: 'Halcyon bookshelf speaker', categoryId: speakers.id, brand: halcyon, variants: [{ options: {}, gtin: ean(104) }] });
  const speakerOffer = w.offer(speaker.id, { price: 25900, sellerId: casa.id });

  const lamp = w.product({ title: 'Nordic desk lamp', categoryId: home.id, variants: [{ options: {}, gtin: ean(105) }] });
  const lampOffer = w.offer(lamp.id, { price: 3900, sellerId: casa.id, stock: 'out_of_stock', status: 'out_of_stock' });

  for (const p of [wireless, earphones, speaker, lamp]) await k.index(p.id);
  for (const s of [grove, casa]) await k.emit('sellers', 'sellers.seller.approved', { sellerId: s.id, applicationId: newId(), storeName: s.storeName, ownerAccountId: newId(), categoryIds: [], returnAddress: { name: 'Returns', line1: '1 Main St', city: 'Austin', region: 'TX', postalCode: '73301', country: 'US' }, returnContact: 'returns@example.com' });
  return { electronics, headphones, speakers, home, aurora, halcyon, grove, casa, wireless, earphones, speaker, lamp, officialOffer, groveOffer, usedOffer, earOffer, speakerOffer, lampOffer };
}
