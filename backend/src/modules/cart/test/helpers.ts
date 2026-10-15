/**
 * Test kit for cart: boots cart on the in-memory MongoDB with an in-memory "offer world" behind stubs
 * of offers, catalog (product content) and inventory availability (stock changes are published as
 * inventory.stock.changed, as inventory does). Shipping and promotions are optional: tests that need
 * them boot them and stub them.
 */
import type { FastifyInstance } from 'fastify';
import type { BuildOptions } from '../../../app.js';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { money } from '../../../kernel/lib/money.js';
import type * as catalog from '../../../spec/catalog.js';
import { spec } from '../../../spec/cart.js';
import { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import type * as offers from '../../../spec/offers.js';
import { auth, buildTestApp, callers, movingClock } from '../../../testing/app.js';

import type { CartService } from '../service.js';

export const STORE = '/api/store/cart';
export const ADMIN = '/api/admin/cart';

export interface Res {
  status: number;
  body: any;
}

export interface World {
  offers: Map<string, offers.Offer>;
  products: Map<string, catalog.Product>;
  /** offers revalidate reports as seller_restricted */
  restricted: Set<string>;
  /** offers that don't ship to the location (quoteOffer delivery) */
  notShippable: Set<string>;
  purchasable: Map<string, boolean>;
  /** available units per stock item (inventory.getAvailability stub) */
  stock: Map<string, number>;
  /** postal codes offers.revalidate was called with */
  revalidatedFor: string[];
}

export interface Kit {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  world: World;
  service: CartService;
  events: EventEnvelope[];
  of(name: string): any[];
  call(method: string, url: string, o?: { token?: string; body?: unknown }): Promise<Res>;
  publish(source: string, name: string, payload: unknown): Promise<void>;
  /** A product with one variant (or more) in the catalog stub */
  product(o?: { title?: string; variants?: number }): Promise<{ productId: string; variantIds: string[] }>;
  /**
   * An active offer with stock (inventory availability stub). o.service: Fulfilled by Marketly (Offer.shipping from
   * the service terms: Marketly's profile, dispatch and ships-from)
   */
  offer(o: { productId: string; variantId: string; price: number; stock?: number; sellerName?: string; official?: boolean; sellerId?: string; purchaseLimit?: number | null; shipsFrom?: string; condition?: offers.Offer['condition']; service?: boolean }): Promise<offers.Offer>;
  /** Marketly's service terms in the world: profile, dispatch and ships-from of Fulfilled by Marketly offers */
  serviceTerms: offers.OfferShipping;
  /** The effective shipping of an offer when Marketly fulfils it (or stops fulfilling it) */
  shipping(offer: offers.Offer, service: boolean): Pick<offers.Offer, 'fulfilledBy' | 'shipping'>;
  /** Change an offer in the world (price, status, purchase limit …); bumps termsVersion */
  change(offerId: string, patch: Partial<offers.Offer>): void;
  /** Set available stock (publishes inventory.stock.changed as inventory would) */
  stock(offerId: string, available: number): Promise<void>;
  visitor(sid?: string): { sid: string; token: string };
  customer(accountId?: string): { accountId: string; token: string };
  staff(permissions?: string[]): string;
  drain(): Promise<void>;
}

/** Free shipping threshold of every offer in the world (offers' estimate is per offer: price × quantity) */
export const FREE_OVER = 3500;

const viewOf = (o: offers.Offer, world: World, quantity = 1): offers.OfferView => ({
  offerId: o.id,
  seller: { sellerId: o.sellerId ?? null, name: o.sellerName, official: o.ownerType === 'official', verified: true, storeSlug: o.ownerType === 'official' ? 'official-store' : `store-${o.sellerName.toLowerCase().replace(/\W+/g, '-')}` },
  condition: o.condition,
  conditionLabel: o.condition,
  conditionNotes: o.conditionNotes ?? null,
  missingItems: [],
  complete: true,
  price: o.price,
  delivery: {
    shipsToLocation: !world.notShippable.has(o.id),
    arrivesFrom: '2026-10-14',
    arrivesTo: '2026-10-16',
    label: 'Arrives Wed, Oct 14 – Fri, Oct 16',
    // like offers: the estimate for this offer alone, free once its own value reaches the threshold
    shippingCost: o.price.amount * quantity >= FREE_OVER ? money(0) : money(599),
    free: o.price.amount * quantity >= FREE_OVER,
    freeOver: money(FREE_OVER),
    shipsFrom: (o.shipping ?? o).dispatch.shipsFrom,
    dispatchLabel: (o.shipping ?? o).dispatch.label,
    fulfilledByLabel: o.fulfilledBy === 'marketly_service' ? 'Ships from Marketly' : null,
  },
  fulfilledBy: o.fulfilledBy,
  total: o.price,
  availability: { state: 'in_stock', maxPerOrder: 10, label: 'In stock' },
  returns: o.returnTerms,
  warranty: o.warranty,
  featured: false,
  featuredEligible: true,
  status: o.status,
  termsVersion: o.termsVersion,
});

export async function boot(opts: BuildOptions & { only?: string[] } = {}): Promise<Kit> {
  const clock = movingClock();
  const world: World = { offers: new Map(), products: new Map(), restricted: new Set(), notShippable: new Set(), purchasable: new Map(), stock: new Map(), revalidatedFor: [] };
  const alternatives = (o: offers.Offer) => [...world.offers.values()].filter((x) => x.id !== o.id && x.variantId === o.variantId && x.status === 'active').map((x) => viewOf(x, world));
  const app = await buildTestApp({
    clock,
    ...opts,
    only: ['cart', ...(opts.only ?? [])],
    config: { launchPhase: 4, rateLimits: false, ...opts.config },
    apiStubs: {
      ...opts.apiStubs,
      offers: {
        getOffer: async (id) => (world.offers.has(id) ? structuredClone(world.offers.get(id)!) : null),
        getOffers: async (ids) => Object.fromEntries(ids.map((id) => [id, world.offers.has(id) ? structuredClone(world.offers.get(id)!) : null])),
        quoteOffer: async (id, quantity) => {
          const o = world.offers.get(id);
          if (!o) throw new Error('unknown offer');
          return viewOf(o, world, quantity);
        },
        revalidate: async (lines, postalCode) => {
          world.revalidatedFor.push(postalCode);
          const changes: offers.OfferChange[] = [];
          for (const l of lines) {
            const o = world.offers.get(l.offerId);
            if (!o) continue;
            if (world.restricted.has(o.id)) changes.push({ offerId: o.id, kind: 'seller_restricted', message: `${o.sellerName} can't sell right now`, alternatives: alternatives(o) });
            if (o.price.amount !== l.price.amount) changes.push({ offerId: o.id, kind: 'price', before: String(l.price.amount), after: String(o.price.amount), message: 'Price changed', alternatives: alternatives(o) });
            if (o.status !== 'active') changes.push({ offerId: o.id, kind: o.status === 'out_of_stock' ? 'availability' : 'removed', message: 'Not available', alternatives: alternatives(o) });
            else if (o.price.amount === l.price.amount && l.termsVersion !== o.termsVersion) changes.push({ offerId: o.id, kind: 'terms', before: `v${l.termsVersion}`, after: `v${o.termsVersion}`, message: `${o.sellerName} updated the delivery, return or warranty terms of this offer.`, alternatives: [] });
          }
          return { ok: changes.length === 0, changes };
        },
        compareOffers: async (productId, q) => ({ offers: [...world.offers.values()].filter((x) => x.productId === productId && (!q.variantId || x.variantId === q.variantId) && x.status === 'active').map((x) => viewOf(x, world)) }) as never,
        ...(opts.apiStubs?.offers ?? {}),
      },
      catalog: {
        getProduct: async (id) => world.products.get(id) ?? null,
        isPurchasable: async (id) => world.purchasable.get(id) ?? true,
        ...(opts.apiStubs?.catalog ?? {}),
      },
      inventory: {
        getAvailability: async (ids) =>
          Object.fromEntries(
            ids.filter((id) => world.stock.has(id)).map((id) => {
              const available = world.stock.get(id)!;
              return [id, { available, state: available > 0 ? 'in_stock' : 'out_of_stock', lowStockThreshold: null, nextIncoming: null }];
            }),
          ),
        ...(opts.apiStubs?.inventory ?? {}),
      },
    },
  });
  const events: EventEnvelope[] = [];
  const bus = app.kernel.events;
  for (const name of Object.keys(spec.events.publishes)) bus.subscribe('test', name, (e) => void events.push(e));


  const service: offers.OfferShipping = {
    fulfilledBy: 'marketly_service',
    profileId: newId(),
    dispatch: { businessDays: 0, sameDayCutoff: '14:00', shipsFrom: 'Reno, NV (Marketly warehouse)', label: 'Ships today' },
  };
  const shippingFor = (o: Pick<offers.Offer, 'ownerType' | 'shippingProfileId' | 'dispatch'>, onService: boolean): Pick<offers.Offer, 'fulfilledBy' | 'shipping'> =>
    onService
      ? { fulfilledBy: 'marketly_service', shipping: structuredClone(service) }
      : { fulfilledBy: o.ownerType === 'official' ? 'official_warehouse' : 'seller', shipping: { fulfilledBy: o.ownerType === 'official' ? 'official_warehouse' : 'seller', profileId: o.shippingProfileId, dispatch: o.dispatch } };
  const kit: Kit = {
    app,
    serviceTerms: service,
    shipping: shippingFor,
    clock,
    world,
    service: app.kernel.boot.apis.get('cart') as CartService,
    events,
    of: (name) => events.filter((e) => e.name === name).map((e) => e.payload),
    async call(method, url, o = {}) {
      const res = await app.inject({ method: method as never, url, headers: o.token ? auth(o.token) : {}, ...(o.body !== undefined ? { payload: o.body as never } : {}) });
      await bus.drain();
      let body: any = res.body;
      try {
        body = res.body ? JSON.parse(res.body) : null;
      } catch {
        /* not JSON */
      }
      return { status: res.statusCode, body };
    },
    async publish(source, name, payload) {
      bus.publish(source, name, payload);
      await bus.drain();
    },
    async product(o = {}) {
      const productId = newId();
      const n = o.variants ?? 1;
      const colors = ['Sage', 'Slate', 'Sand'];
      const variants = Array.from({ length: n }, (_, i) => ({ id: newId(), options: { size: 'Queen', color: colors[i % 3]! }, images: [] }));
      world.products.set(productId, {
        id: productId,
        ref: 'PRD-00001',
        title: o.title ?? 'Linen Duvet Cover',
        slug: 'linen-duvet-cover',
        categoryId: newId(),
        categoryPath: ['Home'],
        description: '',
        keyFeatures: [],
        specs: {},
        includedItems: [],
        images: [{ id: newId(), url: 'https://cdn.example.com/p.jpg' }],
        noGtin: true,
        variants,
        updatedAt: clock.now().toISOString(),
      });
      return { productId, variantIds: variants.map((v) => v.id) };
    },
    async offer(o) {
      const id = newId();
      const official = o.official ?? false;
      const sellerId = official ? null : (o.sellerId ?? newId());
      const stock = { id: newId() };
      world.stock.set(stock.id, o.stock ?? 20);
      const now = clock.now().toISOString();
      const offer: offers.Offer = {
        id,
        ownerType: official ? 'official' : 'seller',
        sellerId,
        sellerName: o.sellerName ?? (official ? OFFICIAL_STORE_NAME : 'Northwind Audio'),
        title: 'Linen Duvet Cover – Queen',
        missingItemsStale: false,
        productId: o.productId,
        variantId: o.variantId,
        condition: o.condition ?? 'new',
        includedItems: [],
        missingItems: [],
        complete: true,
        sellerSku: 'S-1',
        stockItemId: stock.id,
        price: money(o.price),
        purchaseLimit: o.purchaseLimit ?? null,
        dispatch: { businessDays: 1, shipsFrom: o.shipsFrom ?? 'Reno, NV', label: 'Ships in 1 business day' },
        shippingProfileId: newId(),
        returnTerms: { kind: 'baseline', windowDays: 30, freeReturnShipping: false, summary: '30-day returns.' },
        warranty: { kind: 'none', summary: 'No warranty' },
        status: 'active',
        featuredEligibility: { eligible: true, reasons: [], evaluatedAt: now },
        publishOnApproval: false,
        termsVersion: 1,
        createdAt: now,
        updatedAt: now,
      } as Omit<offers.Offer, 'fulfilledBy' | 'shipping'> as offers.Offer;
      Object.assign(offer, shippingFor(offer, o.service ?? false));
      world.offers.set(id, offer);
      return offer;
    },
    change(offerId, patch) {
      const o = world.offers.get(offerId)!;
      world.offers.set(offerId, { ...o, ...patch, termsVersion: o.termsVersion + 1, updatedAt: clock.now().toISOString() });
    },
    async stock(offerId, available) {
      const o = world.offers.get(offerId)!;
      const previousAvailable = world.stock.get(o.stockItemId) ?? 0;
      world.stock.set(o.stockItemId, available);
      bus.publish('inventory', 'inventory.stock.changed', {
        stockItemId: o.stockItemId,
        offerId: o.id,
        ownerType: o.ownerType,
        sellerId: o.sellerId ?? null,
        productId: o.productId,
        variantId: o.variantId,
        available,
        reserved: 0,
        previousAvailable,
        state: available > 0 ? 'in_stock' : 'out_of_stock',
        archived: false,
        cause: 'bulk_update',
      });
      await bus.drain();
    },
    visitor(sid = newId()) {
      return { sid, token: callers.visitor({}, { sid }) };
    },
    customer(accountId = newId()) {
      return { accountId, token: callers.customer({ accountId }) };
    },
    staff: (permissions) => callers.staff(permissions),
    drain: () => bus.drain(),
  };
  return kit;
}

/** Every line of a cart view, flattened */
export const linesOf = (view: any): any[] => view.packages.flatMap((p: any) => p.items);
export const lineOf = (view: any, offerId: string): any => linesOf(view).find((i: any) => i.offerId === offerId);
