/**
 * Test kit for reviews: boots reviews with its dependencies on in-memory PostgreSQL, a movable clock,
 * recorded events, audit entries and calls.
 *
 * Built modules run for real except where a test needs to control the answer:
 *   orders.getOrder / getOrderItem / listDeliveredItems → h.orders (controlled delivery times and states)
 *   catalog.getProduct → h.products (approved products need the whole submission flow)
 *   customers.getCustomerByUserId / getCustomer → customer id = account id, names from h.names
 *   sellers.getSeller / getSellers → h.sellers (store names, closed status)
 *   offers.listOwnOffersForProduct / getFeaturedOfferForProduct / listOffersAdmin / listActiveOffersForProduct → h.offers
 *   media.attach / detach / remove / refs → recorded; h.foreignAssets are refused with ASSET_NOT_OWNED
 *   shipping.dispatchMetrics (shipping is not built) → 20 dispatched, 95 % on time
 *   audit.record → h.audits
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../../kernel/errors/index.js';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as audit from '../../../spec/audit.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as offers from '../../../spec/offers.js';
import type * as orders from '../../../spec/orders.js';
import type * as sellers from '../../../spec/sellers.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';
import { spec } from '../../../spec/reviews.js';
import { OFFICIAL_STORE_ID } from '../domain/rules.js';
import type { ReviewsService } from '../service.js';

export const STORE = '/api/store/reviews';
export const SELLER = '/api/seller/reviews';
export const ADMIN = '/api/admin/reviews';
export const DAY = 86_400_000;
export { OFFICIAL_STORE_ID };

export interface Kit {
  app: FastifyInstance;
  svc: ReviewsService;
  clock: ReturnType<typeof movingClock>;
  events: EventEnvelope[];
  audits: audit.RecordInput[];
  calls: { fn: string; args: unknown[] }[];
  orders: Map<string, orders.OrderDetail>;
  products: Map<string, catalog.Product>;
  names: Map<string, string>;
  sellers: Map<string, sellers.SellerSnapshot>;
  offers: offers.Offer[];
  foreignAssets: Set<string>;
  of(name: string): any[];
  callsOf(fn: string): unknown[][];
  call(method: string, url: string, token: string, body?: unknown): Promise<{ status: number; body: any }>;
  emit(source: string, name: string, payload: unknown): Promise<void>;
  reset(): void;
}

export async function boot(): Promise<Kit> {
  const clock = movingClock();
  // tests move the clock by weeks (appeal and edit windows, invitations): tokens follow the app's time
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 500 * 86_400;
  const h = {
    events: [] as EventEnvelope[],
    audits: [] as audit.RecordInput[],
    calls: [] as Kit['calls'],
    orders: new Map<string, orders.OrderDetail>(),
    products: new Map<string, catalog.Product>(),
    names: new Map<string, string>(),
    sellers: new Map<string, sellers.SellerSnapshot>(),
    offers: [] as offers.Offer[],
    foreignAssets: new Set<string>(),
  };
  const rec = (fn: string, ...args: unknown[]) => void h.calls.push({ fn, args });
  /** orders.OrderItemInfo of every item of h.orders (what getOrderItem / listDeliveredItems answer) */
  const itemInfos = (): orders.OrderItemInfo[] =>
    [...h.orders.values()].flatMap((o) =>
      o.groups.flatMap((g) =>
        g.items.map((i) => ({
          id: i.id,
          orderId: o.id,
          orderRef: o.ref,
          groupId: g.id,
          ownerType: g.seller.ownerType,
          sellerId: g.seller.ownerType === 'official' ? null : (g.seller.id ?? null),
          customerId: o.contact.customerId ?? null,
          offerId: i.offer?.offerId ?? newId(),
          productId: i.product.productId,
          variantId: i.product.variantId,
          stockItemId: newId(),
          categoryId: null,
          quantity: 1,
          state: i.state,
          deliveredAt: i.deliveredAt ?? null,
          returnWindowEndsAt: null,
        })),
      ),
    );
  const customer = (id: string) => ({ id, userId: id, ref: 'CU-000001', displayName: h.names.get(id) ?? 'Sam Rivera', email: 'sam@example.com', accountStatus: 'active' as const, canOrder: true, canMessage: true });
  const live = (o: offers.Offer) => ['active', 'paused', 'out_of_stock'].includes(o.status);
  const app = await buildTestApp({
    only: ['reviews', 'offers', 'media', 'customers', 'audit', 'shipping', 'access'],
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      orders: {
        getOrder: async (id) => structuredClone(h.orders.get(id) ?? null),
        getOrderItem: async (id) => {
          rec('orders.getOrderItem', id);
          return itemInfos().find((i) => i.id === id) ?? null;
        },
        listDeliveredItems: async (customerId, since) => {
          rec('orders.listDeliveredItems', customerId, since);
          return itemInfos().filter((i) => i.customerId === customerId && i.deliveredAt && (!since || i.deliveredAt >= since));
        },
      },
      catalog: { getProduct: async (id) => structuredClone(h.products.get(id) ?? null) },
      customers: {
        getCustomerByUserId: async (id) => customer(id),
        getCustomer: async (id) => customer(id),
        // the invitations catch-up sweep: every customer with an order
        searchCustomers: async (_f, page) => {
          const ids = [...new Set([...h.orders.values()].map((o) => o.contact.customerId).filter((id): id is string => Boolean(id)))];
          const start = page.cursor ? Number(page.cursor) : 0;
          const limit = page.limit ?? 24;
          return { items: ids.slice(start, start + limit).map((id) => customer(id) as never), nextCursor: start + limit < ids.length ? String(start + limit) : null };
        },
      },
      sellers: {
        getSeller: async (id) => h.sellers.get(id) ?? null,
        getSellers: async (ids) => ids.flatMap((id) => (h.sellers.has(id) ? [h.sellers.get(id)!] : [])),
      },
      offers: {
        listOwnOffersForProduct: async (sellerId, productIds) => Object.fromEntries(productIds.map((p) => [p, h.offers.filter((o) => o.sellerId === sellerId && o.productId === p)])),
        getFeaturedOfferForProduct: async (items) => Object.fromEntries(items.map((i) => [i.productId, h.offers.find((o) => o.productId === i.productId && o.status === 'active') ?? null])),
        listOffersAdmin: async (f) => {
          const items = h.offers.filter((o) => live(o) && (f.sellerId ? o.sellerId === f.sellerId : true) && (f.official === undefined ? true : f.official === (o.ownerType === 'official')));
          return { items, nextCursor: null };
        },
        listActiveOffersForProduct: async (productId) =>
          h.offers.filter((o) => o.productId === productId && o.status === 'active').map((o) => ({ id: o.id, productId: o.productId, ownerType: o.ownerType }) as unknown as offers.OfferSummary),
      },
      media: {
        attach: async (assetId, usage, owner) => {
          rec('media.attach', assetId, usage, owner);
          if (h.foreignAssets.has(assetId)) throw new AppError('ASSET_NOT_OWNED', 'This file belongs to another owner and cannot be attached here.');
        },
        detach: async (assetId, usage) => rec('media.detach', assetId, usage),
        remove: async (assetId, input) => rec('media.remove', assetId, input),
        refs: async (ids) => ids.map((id) => ({ id, url: `https://cdn.example/${id}.jpg` })),
      },
      shipping: { dispatchMetrics: async () => ({ dispatched: 20, onTimePct: 95, validTrackingPct: 100, late: 1, overdueOpen: 0 }) },
      audit: {
        record: async (entry) => {
          h.audits.push(entry);
          return newId();
        },
      },
    },
  });
  for (const name of Object.keys(spec.events.publishes)) app.kernel.events.subscribe('test', name, (e) => void h.events.push(e));
  const svc = app.kernel.boot.apis.get('reviews') as ReviewsService;
  return {
    ...h,
    app,
    svc,
    clock,
    of: (name) => h.events.filter((e) => e.name === name).map((e) => e.payload),
    callsOf: (fn) => h.calls.filter((c) => c.fn === fn).map((c) => c.args),
    async call(method, url, token, body) {
      const res = await app.inject({ method: method as never, url, headers: auth(token), ...(body !== undefined ? { payload: body as never } : {}) });
      await app.kernel.events.drain();
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    },
    async emit(source, name, payload) {
      app.kernel.events.publish(source, name, payload);
      await app.kernel.events.drain();
    },
    reset() {
      h.events.length = 0;
      h.audits.length = 0;
      h.calls.length = 0;
    },
  };
}

export const tokens = {
  customer: (accountId: string) => callers.customer({ accountId }),
  seller: (sellerId: string, permissions?: string[]) => callers.seller({ sellerId, ...(permissions ? { permissions } : {}) }),
  staff: (accountId: string = newId(), permissions?: string[]) => callers.staff(permissions, { sub: accountId }),
  visitor: () => callers.visitor(),
};

/* ---------------------------------------------------------------- fixtures */

export function product(k: Kit, title = 'Kestrel 27" monitor'): { productId: string; variantId: string } {
  const productId = newId();
  const variantId = newId();
  k.products.set(productId, {
    id: productId,
    ref: 'PRD-00001',
    title,
    slug: 'kestrel',
    categoryId: null,
    categoryPath: [],
    description: '',
    keyFeatures: [],
    specs: {},
    includedItems: [],
    images: [{ id: newId(), url: 'https://cdn.example/p.jpg' }],
    noGtin: false,
    variants: [{ id: variantId, options: { color: 'Midnight black' }, images: [] }],
    updatedAt: new Date().toISOString(),
  } as catalog.Product);
  return { productId, variantId };
}

export function seller(k: Kit, storeName = 'Northwind Audio', status: sellers.SellerSnapshot['status'] = 'approved'): string {
  const id = newId();
  k.sellers.set(id, { id, ref: 'SL-1', slug: 'nw', storeName, status, verified: true, canSellNew: true, activeRestrictionIds: [], launchReady: true });
  return id;
}

export function offer(k: Kit, productId: string, o: { sellerId?: string | null; ownerType?: 'official' | 'seller'; status?: offers.Offer['status'] } = {}) {
  const ownerType = o.ownerType ?? (o.sellerId ? 'seller' : 'official');
  const x = { id: newId(), ownerType, sellerId: o.sellerId ?? null, sellerName: o.sellerId ? (k.sellers.get(o.sellerId)?.storeName ?? 'Seller') : 'Marketly Official Store', productId, variantId: newId(), sellerSku: 'SKU-1', status: o.status ?? 'active' };
  k.offers.push(x as unknown as offers.Offer);
  return x;
}

export interface Line {
  productId: string;
  variantId?: string;
  title?: string;
  delivered?: boolean | Date;
  state?: string;
}

/** An order of the customer with one package per seller; items delivered `deliveredDaysAgo` days ago by default */
export function order(k: Kit, customerId: string, packages: { sellerId?: string | null; lines: Line[]; arrivalTo?: string; status?: string }[], deliveredDaysAgo = 1) {
  const id = newId();
  const ref = `MK-261009-${String(Math.floor(Math.random() * 90000) + 10000)}`;
  const deliveredAt = new Date(k.clock.now().getTime() - deliveredDaysAgo * DAY).toISOString();
  const groups = packages.map((p, gi) => {
    const groupId = newId();
    const official = !p.sellerId;
    const items = p.lines.map((l) => {
      const delivered = l.delivered === undefined ? true : Boolean(l.delivered);
      const at = l.delivered instanceof Date ? l.delivered.toISOString() : deliveredAt;
      return {
        id: newId(),
        groupId,
        title: l.title ?? k.products.get(l.productId)?.title ?? 'Item',
        variantLabel: 'Midnight black',
        product: { productId: l.productId, variantId: l.variantId ?? k.products.get(l.productId)?.variants[0]?.id ?? newId(), productVersion: 1, title: l.title ?? 'Item', options: { color: 'Midnight black' }, imageUrl: 'https://cdn.example/i.jpg', takenAt: deliveredAt },
        offer: { offerId: newId(), conditionLabel: 'New' },
        state: l.state ?? (delivered ? 'delivered' : 'shipped'),
        deliveredAt: delivered ? at : null,
      };
    });
    return {
      id: groupId,
      packageLabel: `Package ${gi + 1} of ${packages.length}`,
      seller: { ownerType: official ? 'official' : 'seller', id: official ? null : p.sellerId, name: official ? 'Marketly Official Store' : (k.sellers.get(p.sellerId!)?.storeName ?? 'Seller'), slug: 's', verified: true },
      status: p.status ?? (items.every((i) => i.deliveredAt) ? 'delivered' : 'shipped'),
      delivery: { arrival: { from: '2026-01-01', to: p.arrivalTo ?? new Date(k.clock.now().getTime() + 3 * DAY).toISOString().slice(0, 10) } },
      items,
    };
  });
  const o = { id, ref, contact: { kind: 'customer', customerId, name: 'Sam Rivera', email: 'sam@example.com' }, groups } as unknown as orders.OrderDetail;
  k.orders.set(id, o);
  return { orderId: id, ref, groups: groups.map((g) => ({ groupId: g.id, items: g.items.map((i) => i.id) })), itemIds: groups.flatMap((g) => g.items.map((i) => i.id)) };
}

export const LONG = 'Sharp panel, easy to set up and the stand is sturdy. Colours look accurate out of the box.';

export const reviewInput = (orderItemId: string, over: Record<string, unknown> = {}) => ({ orderItemId, rating: 5, headline: 'Great monitor', text: LONG, showName: true, ...over });
