/**
 * Test harness: reports booted with the modules it reads from. The built ones run for real; the answers a
 * test needs to control are stubbed (and recorded):
 *   audit.record → h.audits; media.storeGeneratedFile / signedDownload → h.files (the file bodies);
 *   access.getStaffRef / hasPermission → a small staff directory (h.staff, h.denied);
 *   orders.getOrder / countSellerOrders / listOrdersForSeller → h.orders and h.sellerCounts;
 *   workqueues.exportRows / sellerTaskCounts → h.rows (pages of 2 rows);
 *   finance.marketplaceIncomeByDay / getSellerBalances, advertising.dailyPerformance (advertising is being
 *   built in parallel), search.zeroResultStats, offers.getOffer, inventory.getUnitCost, sellers.getPerformance;
 *   settings.get → h.settings overrides (e.g. reports.maxExportRows);
 *   finance.companyCostsByDay, support.caseStatsByDay, messaging.replyStatsByDay → h.companyCosts, h.caseStats,
 *   h.replyStats (h.responseApis.off makes support and messaging fail).
 * Events of other modules are published on the bus with payloads matching their spec.
 */
import type { FastifyInstance } from 'fastify';
import { newId } from '../../../kernel/lib/ids.js';
import type { Money } from '../../../spec/common.js';
import type * as audit from '../../../spec/audit.js';
import type * as finance from '../../../spec/finance.js';
import type * as messaging from '../../../spec/messaging.js';
import type * as support from '../../../spec/support.js';
import type * as orders from '../../../spec/orders.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';
import type { ReportsService } from '../service.js';

export const usd = (amount: number): Money => ({ amount, currency: 'USD' });
/** The balances finance's stub answers for every seller */
const balanceOf = (sellerId: string) => ({ sellerId, pending: usd(1000), available: usd(2500), held: usd(0), nextPayout: { scheduledFor: '2026-10-15', estimatedAmount: usd(2500), destination: { label: 'Bank •••• 6620', status: 'verified' } } }) as never;

export interface ItemSpec {
  id?: string;
  productId?: string;
  offerId?: string;
  quantity?: number;
  unit?: number;
  discount?: { amount: number; fundedBy: 'platform' | 'seller' | 'shared' } | null;
  shipping?: number;
  tax?: number;
  stockItemId?: string;
  categoryId?: string | null;
}

export interface OrderSpec {
  id?: string;
  placedAt?: string;
  sellerId?: string | null;
  customerId?: string;
  items?: ItemSpec[];
  pending?: boolean;
  /** The group's fulfilledBy (default: seller for a seller, official_warehouse for the Official Store) */
  fulfilledBy?: 'official_warehouse' | 'seller' | 'marketly_service';
}

export async function harness() {
  const clock = movingClock();
  // tokens are signed at the app's time, so tests can move the clock days ahead
  tokenClock.now = () => clock.now();
  const audits: audit.RecordInput[] = [];
  const files: { fileName: string; contentType: string; body: Buffer; owner: unknown; ttlHours?: number }[] = [];
  const staff = new Map<string, { name: string; roleLabel: string }>();
  const denied = new Set<string>();
  const ordersById = new Map<string, orders.OrderDetail>();
  const sellerCounts = new Map<string, orders.SellerOrderCounts>();
  const rows: { value: Record<string, unknown>[] } = { value: [] };
  const settings = new Map<string, unknown>();
  const income: { date: string; sellerId: string; netFeeIncome: Money }[] = [];
  const adPerf: { date: string; campaignId: string; displays: number; clicks: number; dismissals: number; attributedOrders: number }[] = [];
  const zeroResults: { query: string; normalized: string; count: number }[] = [];
  const offerProducts = new Map<string, string>();
  /** offers.getOffers: the seller's SKU of an offer (with offerProducts for its product) */
  const offerSkus = new Map<string, string>();
  /** promotions.priceOffers: offers with a live discount */
  const discountedOffers = new Set<string>();
  /** catalog.getProducts / getProduct: title and main image */
  const products = new Map<string, { title: string; imageUrl?: string }>();
  const unitCosts = new Map<string, number>();
  /** offers.unitCostsAt: a seller's unit costs per offer, each from an instant (the latest from on or before `at` applies) */
  const offerCosts = new Map<string, { from: string; amount: number }[]>();
  const exportRowsCalls: { dataset: string; filters: unknown; principal: unknown; cursor?: string }[] = [];
  /** finance.companyCostsByDay, support.caseStatsByDay and messaging.replyStatsByDay answer these rows (by date and seller) */
  const companyCosts: finance.DailyCompanyCost[] = [];
  const caseStats: support.DailyCaseStats[] = [];
  const replyStats: messaging.DailyReplyStats[] = [];
  /** off: support and messaging fail (as when switched off or failing) */
  const responseApis = { off: false };
  const inRange = (date: string, range: { from: string; to: string }) => date >= range.from && date <= range.to;

  const app: FastifyInstance = await buildTestApp({
    only: ['reports', 'audit', 'media', 'access', 'settings', 'workqueues', 'orders', 'finance', 'advertising', 'search', 'inventory', 'sellers'],
    clock,
    config: { launchPhase: 4, rateLimits: false },
    apiStubs: {
      audit: {
        record: async (e) => {
          audits.push(e);
          return newId();
        },
      },
      media: {
        storeGeneratedFile: async (input) => {
          const body = Buffer.from(await new Response(input.body).arrayBuffer());
          files.push({ fileName: input.fileName, contentType: input.contentType, body, owner: input.owner, ttlHours: input.ttlHours });
          const now = clock.now().toISOString();
          return { id: newId(), kind: 'spreadsheet', purpose: input.purpose, status: 'ready', fileName: input.fileName, contentType: input.contentType, sizeBytes: body.length, owner: input.owner, visibility: 'private', createdAt: now } as never;
        },
        signedDownload: async (assetId) => ({ url: `https://files.marketly.test/${assetId}?sig=${newId()}`, expiresAt: new Date(clock.now().getTime() + 600_000).toISOString(), fileName: 'export.csv', contentType: 'text/csv', sizeBytes: 1 }),
      },
      access: {
        getStaffRef: async (id) => (staff.has(id) ? { accountId: id, name: staff.get(id)!.name, email: null, away: false, roleLabel: staff.get(id)!.roleLabel } : null),
        hasPermission: async (p, key) => !denied.has(`${p.accountId}:${key}`) && !denied.has(`*:${key}`),
      },
      settings: { get: async (key: string) => settings.get(key) as never },
      orders: {
        getOrder: async (id) => ordersById.get(id) ?? null,
        countSellerOrders: async (sellerId) => sellerCounts.get(sellerId) ?? { new: 0, preparing: 0, shipped: 0, completed: 0, cancellationRequests: 0, overdue: 0, dueToday: 0, fulfilledByMarketly: 0 },
        listOrdersForSeller: async () => ({ items: [], nextCursor: null }),
      },
      workqueues: {
        exportRows: async (dataset, filters, principal, cursor) => {
          exportRowsCalls.push({ dataset, filters, principal, cursor });
          const start = cursor ? Number(cursor) : 0;
          const page = rows.value.slice(start, start + 2);
          return { rows: page, ...(start + 2 < rows.value.length ? { nextCursor: String(start + 2) } : {}) };
        },
        sellerTaskCounts: async () => ({}),
      },
      finance: {
        marketplaceIncomeByDay: async (range) => income.filter((r) => r.date >= range.from && r.date <= range.to).map((r) => ({ ...r, feeIncome: r.netFeeIncome, feeRefunds: usd(0), adIncome: usd(0) })),
        getSellerBalances: async (sellerId) => balanceOf(sellerId),
        balancesForSellers: async (sellerIds) => new Map(sellerIds.map((id) => [id, balanceOf(id)])),
        companyCostsByDay: async (range) => companyCosts.filter((r) => inRange(r.date, range)),
      },
      support: {
        caseStatsByDay: async (range, sellerId) => {
          if (responseApis.off) throw new Error('support is off');
          return caseStats.filter((r) => inRange(r.date, range) && (!sellerId || r.sellerId === sellerId));
        },
      },
      messaging: {
        replyStatsByDay: async (range, sellerId) => {
          if (responseApis.off) throw new Error('messaging is off');
          return replyStats.filter((r) => inRange(r.date, range) && (!sellerId || r.sellerId === sellerId));
        },
      },
      advertising: {
        dailyPerformance: async (range) => adPerf.filter((r) => r.date >= range.from && r.date <= range.to).map((r) => ({ ...r, campaignRef: 'AD-1', sellerId: null, attributedSales: usd(0), spend: usd(0), partial: false })),
      },
      search: { zeroResultStats: async () => zeroResults.map((z) => ({ ...z, lastAt: clock.now().toISOString(), correctionOffered: false })) },
      offers: {
        getOffer: async (id) => (offerProducts.has(id) ? ({ id, productId: offerProducts.get(id)! } as never) : null),
        getOffers: async (ids) => Object.fromEntries(ids.map((id) => [id, offerProducts.has(id) ? ({ id, productId: offerProducts.get(id)!, sellerSku: offerSkus.get(id) ?? '' } as never) : null])),
        unitCostsAt: async (items) =>
          items.map(({ offerId, at }) => {
            const cost = (offerCosts.get(offerId) ?? []).filter((c) => c.from <= at).sort((a, b) => a.from.localeCompare(b.from)).at(-1);
            return cost ? usd(cost.amount) : null;
          }),
      },
      promotions: {
        priceOffers: async (ids) => ids.map((offerId) => ({ offerId, regularPrice: usd(5000), price: usd(discountedOffers.has(offerId) ? 4000 : 5000), badges: [], sellerPromos: [] })),
      },
      catalog: {
        getProduct: async (id) => (products.has(id) ? ({ id, title: products.get(id)!.title } as never) : null),
        getProducts: async (ids) => ids.filter((id) => products.has(id)).map((id) => ({ product: { id, title: products.get(id)!.title, images: products.get(id)!.imageUrl ? [{ id: newId(), url: products.get(id)!.imageUrl, alt: products.get(id)!.title }] : [] } }) as never),
        getCategoryPaths: async (ids) => Object.fromEntries(ids.map((id) => [id, { categoryId: id, names: ['Home', `Category ${id.slice(0, 4)}`], ids: [newId(), id] }])),
      },
      inventory: {
        getUnitCost: async (stockItemId) => (unitCosts.has(stockItemId) ? usd(unitCosts.get(stockItemId)!) : null),
        getSellerStockSummary: async () => ({ inStockSkus: 4, inStockUnits: 40, lowStockSkus: 1, outOfStockSkus: 1, reservedUnits: 2, outOfStockLabels: ['Aurora, Silver'] }),
      },
      sellers: { getPerformance: async () => ({ period: { from: '2026-09-01', to: '2026-09-30' }, orderCount: 3, overall: 'good', metrics: [], warnings: [], history: [], updatedAt: clock.now().toISOString() }) as never },
    },
  });

  const service = app.kernel.boot.apis.get('reports') as unknown as ReportsService;

  const call = async (method: string, url: string, token: string, body?: unknown) => {
    const res = await app.inject({ method: method as never, url, headers: auth(token), ...(body === undefined ? {} : { payload: body as never }) });
    let json: any = null;
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      json = res.body;
    }
    return { status: res.statusCode, body: json };
  };

  const gql = async (area: 'admin' | 'seller', token: string, query: string) => {
    const res = await app.inject({ method: 'POST', url: `/graphql/${area}`, headers: { ...auth(token), 'content-type': 'application/json' }, payload: { query } });
    return JSON.parse(res.body);
  };

  /** A staff member known to access (name and role label) */
  const person = (name = 'Maya Chen', roleLabel = 'Reports Analyst') => {
    const id = newId();
    staff.set(id, { name, roleLabel });
    return id;
  };

  /** An order as orders.getOrder answers it */
  const order = (o: OrderSpec = {}): orders.OrderDetail => {
    const id = o.id ?? newId();
    const sellerId = o.sellerId === undefined ? newId() : o.sellerId;
    const items = (o.items ?? [{}]).map((i) => {
      const quantity = i.quantity ?? 1;
      const unit = i.unit ?? 5000;
      return {
        id: i.id ?? newId(),
        groupId: 'g',
        product: { productId: i.productId ?? newId(), variantId: newId(), productVersion: 1, title: 'Lamp', options: {}, takenAt: clock.now().toISOString() },
        offer: { offerId: i.offerId ?? newId() },
        stockItemId: i.stockItemId ?? newId(),
        categoryId: i.categoryId ?? null,
        title: 'Lamp',
        quantity,
        unitPrice: usd(unit),
        lineSubtotal: usd(unit * quantity),
        discounts: i.discount ? [{ label: 'Coupon', amount: usd(i.discount.amount), fundedBy: i.discount.fundedBy }] : [],
        shippingShare: usd(i.shipping ?? 500),
        taxShare: usd(i.tax ?? 400),
        deliveredAt: null,
      };
    });
    const detail = {
      id,
      ref: `MK-261009-${String(Math.floor(Math.random() * 99999)).padStart(5, '0')}`,
      placedAt: o.placedAt ?? clock.now().toISOString(),
      acceptedAt: o.pending ? null : (o.placedAt ?? clock.now().toISOString()),
      lifecycle: o.pending ? 'payment_pending' : 'open',
      contact: { kind: 'customer', customerId: o.customerId ?? null, name: 'Ben Ortiz', email: 'ben@example.com' },
      groups: [{ id: newId(), seller: { ownerType: sellerId ? 'seller' : 'official', id: sellerId, name: 'Casa Verde', slug: 'casa-verde', verified: true }, fulfilledBy: o.fulfilledBy ?? (sellerId ? 'seller' : 'official_warehouse'), items }],
    } as unknown as orders.OrderDetail;
    ordersById.set(id, detail);
    return detail;
  };

  /** orders.order.placed (+ accepted when paid) as orders publishes them */
  const placed = (d: orders.OrderDetail, paymentState: 'accepted' | 'pending_check' = 'accepted', customerId?: string) => {
    const g = d.groups[0]!;
    const group = { groupId: g.id, ownerType: g.seller.ownerType, sellerId: g.seller.id ?? null, fulfilledBy: g.fulfilledBy, dispatchBy: clock.now().toISOString(), itemIds: g.items.map((i) => i.id), total: usd(1) };
    app.kernel.events.publish('orders', 'orders.order.placed', {
      orderId: d.id,
      ref: d.ref,
      checkoutSessionId: newId(),
      customerId: customerId ?? null,
      guestEmail: customerId ? null : 'ben@example.com',
      paymentIntentId: newId(),
      paymentState,
      total: usd(1),
      couponCodes: [],
      groups: [group],
      placedAt: d.placedAt,
      attemptNo: 1,
      contactName: 'Ben Buyer',
    });
    return group;
  };

  /** orders.order.accepted as orders publishes it: reports records the facts, finance (real) books the sale and fee */
  const accepted = (d: orders.OrderDetail) => {
    const g = d.groups[0]!;
    app.kernel.events.publish('orders', 'orders.order.accepted', {
      orderId: d.id,
      ref: d.ref,
      customerId: null,
      contactEmail: 'ben@example.com',
      total: usd(1),
      groups: [{ groupId: g.id, ownerType: g.seller.ownerType, sellerId: g.seller.id ?? null, fulfilledBy: g.fulfilledBy, dispatchBy: d.placedAt, itemIds: g.items.map((i) => i.id), total: usd(1) }],
      items: g.items.map((i) => ({ orderItemId: i.id, offerId: i.offer.offerId, stockItemId: i.stockItemId, quantity: i.quantity })),
      acceptedAt: d.placedAt,
    });
  };

  const publish = (source: string, name: string, payload: unknown) => app.kernel.events.publish(source, name, payload);
  const drain = () => app.kernel.events.drain();

  const tokens = {
    staff: (permissions?: string[], accountId?: string) => callers.staff(permissions, accountId ? { sub: accountId } : {}),
    seller: (sellerId: string, permissions?: string[]) => callers.seller({ sellerId, ...(permissions ? { permissions } : {}) }),
    customer: () => callers.customer(),
    visitor: () => callers.visitor(),
  };

  return { app, service, clock, audits, files, staff, denied, ordersById, sellerCounts, rows, settings, income, adPerf, zeroResults, offerProducts, offerSkus, discountedOffers, products, unitCosts, offerCosts, exportRowsCalls, companyCosts, caseStats, replyStats, responseApis, call, gql, person, order, placed, accepted, publish, drain, tokens };
}

export type Harness = Awaited<ReturnType<typeof harness>>;
