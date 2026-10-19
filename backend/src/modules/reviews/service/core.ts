/**
 * Shared plumbing of the reviews use cases: time, settings, events, audit, other modules' answers
 * (orders for purchases, catalog for product titles, sellers for names, customers for display names,
 * media for photos) and the product and seller summaries. The use cases live in the part classes.
 */
import { zonedDayRange } from '../../../kernel/lib/clock.js';
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type { ModuleContext, PublicApiMap } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as common from '../../../spec/common.js';
import type * as orders from '../../../spec/orders.js';
import { isOfficial, OFFICIAL_STORE_ID, OFFICIAL_STORE_NAME, sellerKey, shortName, variantLabelOf } from '../domain/rules.js';
import type { ReviewsRepository } from '../repository.js';

export interface ReviewsServiceDeps {
  repo: ReviewsRepository;
  ctx: ModuleContext<'reviews'>;
}

/** Who acts, as the HTTP layer (or an event) knows it */
export interface By {
  actor: common.Actor;
  requestId?: string;
}

/** A signed-in customer: customer id (record owner) and account id (media ownership) */
export interface CustomerWho extends By {
  customerId: string | null;
  accountId: string | null;
}

export interface SellerWho extends By {
  sellerId: string;
}

type OwnEvent = keyof EventMap & `reviews.${string}`;
type Optional = Parameters<ModuleContext<'reviews'>['tryUse']>[0];
type Setting = Parameters<ModuleContext<'reviews'>['settings']['get']>[0];

export const SYSTEM: common.Actor = { kind: 'system', id: null };
export const TRUST_ACTOR: common.Actor = { kind: 'system', id: null, name: 'Trust and Risk' };

export const invalid = (issues: { path: string; message: string }[], message = issues[0]?.message ?? 'Some details need fixing') => new AppError('VALIDATION_FAILED', message, { issues });
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);

const DELIVERED_LIKE = new Set(['delivered', 'return_requested', 'returned', 'refunded']);

/** One purchased item of a customer, flattened from orders.OrderDetail */
export interface Purchase {
  orderItemId: string;
  orderId: string;
  orderRef: string;
  groupId: string;
  packageLabel: string;
  productId: string;
  variantId: string;
  title: string;
  imageUrl: string | null;
  variantLabel: string | null;
  condition: string | null;
  ownerType: 'official' | 'seller';
  /** Seller id, or OFFICIAL_STORE_ID */
  sellerId: string;
  sellerName: string;
  state: string;
  deliveredAt: Date | null;
  delivered: boolean;
}

/** One seller package of a customer's order */
export interface Package {
  orderId: string;
  orderRef: string;
  groupId: string;
  packageLabel: string;
  ownerType: 'official' | 'seller';
  sellerId: string;
  sellerName: string;
  status: string;
  /** First delivery in the package */
  deliveredAt: Date | null;
  /** End of the promised delivery window (feedback opens once it has passed) */
  arrivalTo: Date | null;
  itemTitles: string[];
  itemIds: string[];
}


export class Core {
  readonly repo: ReviewsRepository;
  readonly ctx: ModuleContext<'reviews'>;

  constructor(deps: ReviewsServiceDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
  }

  now = () => this.ctx.clock.now();
  iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
  setting = <K extends Setting>(key: K) => this.ctx.settings.get(key);

  async num(key: Setting): Promise<number> {
    return Number(await this.ctx.settings.get(key));
  }

  publish<N extends OwnEvent>(name: N, payload: EventMap[N], by: { actor?: common.Actor; requestId?: string } = {}) {
    this.ctx.events.publish(name as never, payload as never, { actor: by.actor ?? SYSTEM, ...(by.requestId ? { requestId: by.requestId } : {}) });
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: By) {
    await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
  }

  /**
   * Calls an optional module for a read. Off, not built yet or failing → undefined (the answer degrades,
   * e.g. no answer expectation or no on-time dispatch figure).
   */
  async optional<M extends Optional, R>(module: M, fn: (api: PublicApiMap[M & keyof PublicApiMap]) => Promise<R>): Promise<R | undefined> {
    const api = this.ctx.tryUse(module) as PublicApiMap[M & keyof PublicApiMap] | undefined;
    if (!api) return undefined;
    try {
      return await fn(api);
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err, module }, `reviews: ${module} could not answer`);
      return undefined;
    }
  }

  /** A required module's read that may fail without failing the whole answer (names, titles) */
  async soft<R>(what: string, fn: () => Promise<R>): Promise<R | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err }, `reviews: ${what} failed`);
      return undefined;
    }
  }

  /**
   * Who is told about a new question: the sellers with an active offer on the product, and whether the Official
   * Store has one (its questions go to staff). Offers off or failing: nobody beyond the asker's own notice.
   */
  async questionAudience(p: EventMap['reviews.question.asked']): Promise<EventMap['reviews.question.asked']> {
    const page = await this.optional('offers', (o) => o.listOffersAdmin({ productId: p.productId, status: ['active'] }, { limit: 100 }));
    const offers = page?.items ?? [];
    const sellerIds = [...new Set(offers.filter((o) => o.ownerType === 'seller' && o.sellerId && !isOfficial(o.sellerId)).map((o) => o.sellerId!))];
    return { ...p, sellerIds, officialStore: offers.some((o) => o.ownerType === 'official') };
  }

  /* ---------------------------------------------------------------- lookups */

  /** Products by id (catalog); unknown products are missing from the map */
  async products(ids: readonly string[]): Promise<Map<string, catalog.Product>> {
    const unique = [...new Set(ids.filter(isUuid))];
    const out = new Map<string, catalog.Product>();
    // batched reads (catalog answers up to 200 products a call) instead of one read per product
    const chunks = Array.from({ length: Math.ceil(unique.length / 200) }, (_, i) => unique.slice(i * 200, i * 200 + 200));
    const records = await Promise.all(chunks.map((chunk) => this.soft('catalog.getProducts', () => this.ctx.use('catalog').getProducts(chunk))));
    for (const r of records.flatMap((list) => list ?? [])) out.set(r.product.id, r.product);
    return out;
  }

  async product(id: string): Promise<catalog.Product | null> {
    return (await this.products([id])).get(id) ?? null;
  }

  variantLabel(p: catalog.Product | undefined | null, variantId: string | null | undefined): string | null {
    if (!p || !variantId) return null;
    const v = p.variants.find((x) => x.id === variantId);
    return v ? variantLabelOf(v.options) : null;
  }

  productImage(p: catalog.Product | undefined | null): common.MediaRef | null {
    return p?.images?.[0] ?? null;
  }

  /** Seller store names; the Official Store has its own name */
  async sellerNames(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const real = [...new Set(ids.filter((id) => isUuid(id) && !isOfficial(id)))];
    if (ids.some((id) => isOfficial(id))) out.set(OFFICIAL_STORE_ID, OFFICIAL_STORE_NAME);
    if (real.length) {
      const list = await this.soft('sellers.getSellers', () => this.ctx.use('sellers').getSellers(real));
      for (const s of list ?? []) out.set(s.id, s.storeName);
    }
    return out;
  }

  /** Storefront slugs of marketplace sellers (sellers.getSellers); the Official Store has none */
  async sellerSlugs(ids: readonly string[]): Promise<Map<string, string>> {
    const real = [...new Set(ids.filter((id) => isUuid(id) && !isOfficial(id)))];
    if (!real.length) return new Map();
    const list = await this.soft('sellers.getSellers', () => this.ctx.use('sellers').getSellers(real));
    return new Map((list ?? []).map((s) => [s.id, s.slug]));
  }

  sellerName = (names: Map<string, string>, id: string) => names.get(sellerKey(id)) ?? (isOfficial(id) ? OFFICIAL_STORE_NAME : 'Marketplace seller');

  /** A customer under a reviews restriction (or suspended) writes no reviews, questions, votes or seller feedback */
  async assertMayWrite(who: CustomerWho): Promise<void> {
    if (!who.customerId) return;
    const can = await this.optional('customers', (c) => c.canWriteReviews(who.customerId!));
    if (can && !can.allowed) throw this.ctx.error('REVIEWS_RESTRICTED', can.reason ?? 'Reviews are paused on this account');
  }

  /** Conflict of interest: the account is on the seller's team (owner or member), so it does not review that seller */
  async assertNotSellerTeam(who: CustomerWho, sellerId: string, what: string): Promise<void> {
    if (!who.accountId || isOfficial(sellerId) || !isUuid(sellerId)) return;
    const member = await this.soft('sellers.getMemberAccess', () => this.ctx.use('sellers').getMemberAccess(sellerKey(sellerId), who.accountId!));
    if (member) throw this.ctx.error('REVIEW_NOT_ELIGIBLE', `You're on this seller's team, so you can't leave ${what} for it.`);
  }

  /** Customers' full display names (customers, optional) */
  async customerNames(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unique = [...new Set(ids.filter(isUuid))];
    if (!unique.length) return out;
    await this.optional('customers', async (c) => {
      await Promise.all(
        unique.map(async (id) => {
          const s = await c.getCustomer(id).catch(() => null);
          if (s) out.set(id, s.displayName);
        }),
      );
    });
    return out;
  }

  /** "Sam R." for the customer, or a neutral name */
  async shortNameOf(customerId: string): Promise<string> {
    return shortName((await this.customerNames([customerId])).get(customerId));
  }

  /** Photos (media, optional) */
  async mediaRefs(ids: readonly string[]): Promise<Map<string, common.MediaRef>> {
    const unique = [...new Set(ids.filter(isUuid))];
    const out = new Map<string, common.MediaRef>();
    if (!unique.length) return out;
    const refs = await this.optional('media', (m) => m.refs(unique, 'medium'));
    for (const r of refs ?? []) out.set(r.id, r);
    return out;
  }

  /** Orders by id (orders.getOrder, no access check: callers have already scoped the records) */
  async orders(ids: readonly string[]): Promise<Map<string, orders.OrderDetail>> {
    const unique = [...new Set(ids.filter(isUuid))];
    const out = new Map<string, orders.OrderDetail>();
    await Promise.all(
      unique.map(async (id) => {
        const o = await this.soft('orders.getOrder', () => this.ctx.use('orders').getOrder(id));
        if (o) out.set(id, o);
      }),
    );
    return out;
  }

  /* ---------------------------------------------------------------- purchases (Verified Purchase eligibility) */

  /** One order item of the customer (orders.getOrderItem); null when unknown or another customer's */
  async orderItem(customerId: string, orderItemId: string): Promise<orders.OrderItemInfo | null> {
    if (!isUuid(orderItemId)) return null;
    const info = await this.ctx.use('orders').getOrderItem(orderItemId);
    return info && info.customerId === customerId ? info : null;
  }

  /** The customer's order items, batched lookups; unknown and other customers' items are missing */
  async orderItems(customerId: string, orderItemIds: readonly string[]): Promise<Map<string, orders.OrderItemInfo>> {
    const unique = [...new Set(orderItemIds.filter(isUuid))];
    const out = new Map<string, orders.OrderItemInfo>();
    const api = this.ctx.use('orders');
    await Promise.all(
      unique.map(async (id) => {
        const info = await api.getOrderItem(id);
        if (info && info.customerId === customerId) out.set(id, info);
      }),
    );
    return out;
  }

  /** Items delivered to the customer since a time (orders.listDeliveredItems) */
  async deliveredItems(customerId: string, since: Date): Promise<orders.OrderItemInfo[]> {
    return (await this.ctx.use('orders').listDeliveredItems(customerId, since.toISOString())).filter((i) => i.customerId == null || i.customerId === customerId);
  }

  /** Delivered (and not since cancelled): returned and refunded items were delivered too */
  isDelivered = (info: Pick<orders.OrderItemInfo, 'state' | 'deliveredAt'>) => Boolean(info.deliveredAt) && DELIVERED_LIKE.has(info.state);

  /**
   * A purchase from orders' item facts (owner, state, delivery: these decide eligibility), with titles and
   * images from the purchase snapshot of its order when the order is given.
   */
  purchaseOf(info: orders.OrderItemInfo, order?: orders.OrderDetail | null): Purchase {
    const official = info.ownerType === 'official';
    const shown = order ? this.purchasesOf(order).find((p) => p.orderItemId === info.id) : undefined;
    return {
      title: shown?.title ?? 'Item',
      imageUrl: shown?.imageUrl ?? null,
      variantLabel: shown?.variantLabel ?? null,
      condition: shown?.condition ?? null,
      packageLabel: shown?.packageLabel ?? '',
      sellerName: shown?.sellerName ?? (official ? OFFICIAL_STORE_NAME : 'Marketplace seller'),
      orderItemId: info.id,
      orderId: info.orderId,
      orderRef: info.orderRef,
      groupId: info.groupId,
      productId: info.productId,
      variantId: info.variantId,
      ownerType: info.ownerType,
      sellerId: official ? OFFICIAL_STORE_ID : sellerKey(info.sellerId),
      state: info.state,
      deliveredAt: info.deliveredAt ? new Date(info.deliveredAt) : null,
      delivered: this.isDelivered(info),
    };
  }

  purchasesOf(order: orders.OrderDetail): Purchase[] {
    return order.groups.flatMap((g) =>
      g.items.map((i) => ({
        orderItemId: i.id,
        orderId: order.id,
        orderRef: order.ref,
        groupId: g.id,
        packageLabel: g.packageLabel,
        productId: i.product.productId,
        variantId: i.product.variantId,
        title: i.title || i.product.title,
        imageUrl: i.image?.url ?? i.product.imageUrl ?? null,
        variantLabel: variantLabelOf(i.product.options) ?? (i.variantLabel || null),
        condition: i.offer?.conditionLabel ?? null,
        ownerType: g.seller.ownerType,
        sellerId: g.seller.ownerType === 'official' ? OFFICIAL_STORE_ID : sellerKey(g.seller.id),
        sellerName: g.seller.ownerType === 'official' ? OFFICIAL_STORE_NAME : g.seller.name,
        state: i.state,
        deliveredAt: i.deliveredAt ? new Date(i.deliveredAt) : null,
        delivered: Boolean(i.deliveredAt) && DELIVERED_LIKE.has(i.state),
      })),
    );
  }

  packagesOf(order: orders.OrderDetail): Package[] {
    return order.groups.map((g) => {
      const delivered = g.items.map((i) => (i.deliveredAt && DELIVERED_LIKE.has(i.state) ? new Date(i.deliveredAt) : null)).filter((d): d is Date => Boolean(d));
      const to = g.delivery?.arrival?.to;
      return {
        orderId: order.id,
        orderRef: order.ref,
        groupId: g.id,
        packageLabel: g.packageLabel,
        ownerType: g.seller.ownerType,
        sellerId: g.seller.ownerType === 'official' ? OFFICIAL_STORE_ID : sellerKey(g.seller.id),
        sellerName: g.seller.ownerType === 'official' ? OFFICIAL_STORE_NAME : g.seller.name,
        status: g.status,
        deliveredAt: delivered.length ? new Date(Math.min(...delivered.map((d) => d.getTime()))) : null,
        arrivalTo: to ? new Date(zonedDayRange({ to }, this.ctx.config.market.timeZone).end!.getTime() - 1) : null,
        itemTitles: g.items.filter((i) => i.state !== 'cancelled').map((i) => i.title),
        itemIds: g.items.map((i) => i.id),
      };
    });
  }

  /** Feedback opens once the package is delivered or its promised delivery date has passed */
  packageOpensAt(p: Package): Date | null {
    if (p.status === 'cancelled') return null;
    if (p.deliveredAt) return p.deliveredAt;
    return p.arrivalTo;
  }

  /** Item title for the storefront: "Kestrel 27\" monitor" or "Kestrel 27\" monitor and 2 more" */
  itemTitle(p: Package | undefined): string | null {
    if (!p || !p.itemTitles.length) return null;
    return p.itemTitles.length > 1 ? `${p.itemTitles[0]} and ${p.itemTitles.length - 1} more` : p.itemTitles[0]!;
  }

  /** The seller package behind a feedback row, from its order */
  packageFor(order: orders.OrderDetail | undefined, sellerId: string): Package | undefined {
    if (!order) return undefined;
    return this.packagesOf(order).find((p) => p.sellerId === sellerKey(sellerId));
  }

  /* ---------------------------------------------------------------- summaries */

  /** Recomputes the product summary (inside the caller's transaction); true when the rating changed */
  async refreshProduct(repo: ReviewsRepository, productId: string): Promise<{ changed: boolean; count: number; average: number | null }> {
    const before = (await repo.productSummaries([productId]))[0];
    const after = await repo.recomputeProductSummary(productId, this.now());
    const average = after.rating_count ? Math.round((after.sum_ratings / after.rating_count) * 10) / 10 : null;
    return { changed: !before || before.rating_count !== after.rating_count || before.sum_ratings !== after.sum_ratings, count: after.rating_count, average };
  }

  async sellerPeriodStart(): Promise<Date> {
    const months = await this.num('sellerRatingPeriodMonths');
    const d = new Date(this.now());
    d.setUTCMonth(d.getUTCMonth() - months);
    return d;
  }

  /** Recomputes the 12-month seller summary; true when it changed */
  async refreshSeller(repo: ReviewsRepository, sellerId: string, since: Date, positiveThreshold: number): Promise<{ changed: boolean; count: number; positive: number }> {
    const before = (await repo.sellerSummaries([sellerId]))[0];
    const after = await repo.recomputeSellerSummary(sellerId, since, positiveThreshold, this.now());
    const changed = !before || (['count', 'positive', 'neutral', 'negative', 'as_described_yes', 'dispatch_sum', 'communication_sum', 'communication_count'] as const).some((k) => before[k] !== after[k]);
    return { changed, count: after.count, positive: after.positive };
  }

  /** Inside a transaction: refresh the product summary and remember a rating change for after the commit */
  async touchProduct(tx: ReviewsRepository, fx: Effects, productId: string) {
    const r = await this.refreshProduct(tx, productId);
    if (r.changed) fx.productRatings.set(productId, { count: r.count, average: r.average });
  }

  /** Inside a transaction: refresh the seller summary and remember a rating change for after the commit */
  async touchSeller(tx: ReviewsRepository, fx: Effects, sellerId: string) {
    // settings come from another module's connection: they are read before the transaction (prepare)
    if (!fx.sellerSince || fx.threshold === undefined) throw new Error('reviews: Effects not prepared before the transaction');
    const r = await this.refreshSeller(tx, sellerId, fx.sellerSince, fx.threshold);
    if (r.changed) fx.sellers.add(sellerId);
  }

  /** Before a transaction: settings touchSeller needs (settings are read outside transactions) */
  async prepare(fx: Effects) {
    fx.sellerSince = await this.sellerPeriodStart();
    fx.threshold = await this.num('positiveThreshold');
    return fx;
  }

  /** After the commit: events, rating changes and photo takedowns, in that order */
  async flush(fx: Effects, by: By) {
    for (const e of fx.events) {
      const payload = e.name === 'reviews.question.asked' ? await this.questionAudience(e.payload as EventMap['reviews.question.asked']) : e.payload;
      this.publish(e.name as OwnEvent, payload as never, by);
    }
    for (const [productId, r] of fx.productRatings) this.publish('reviews.rating.changed', { productId, sellerId: null, average: r.average, count: r.count }, by);
    if (fx.sellers.size) {
      const ids = [...fx.sellers];
      const summaries = await this.repo.sellerSummaries(ids);
      for (const id of ids) {
        const row = summaries.find((s) => s.seller_id === id);
        const avg = row && row.count ? row.overall_sum / row.count : null;
        this.publish('reviews.rating.changed', { productId: null, sellerId: id, average: avg != null ? Math.round(avg * 10) / 10 : null, count: row?.count ?? 0 }, by);
      }
    }
    const media = this.ctx.tryUse('media');
    if (media) {
      for (const assetId of fx.takedown) {
        await media.remove(assetId, { reason: fx.takedownReason ?? 'Review content removed by moderation', by: by.actor }).catch((err) => this.ctx.log.warn({ err, assetId }, 'reviews: photo takedown failed'));
      }
      for (const d of fx.detach) {
        await media.detach(d.assetId, { module: 'reviews', kind: 'review_photo', refId: d.refId }).catch((err) => this.ctx.log.warn({ err, assetId: d.assetId }, 'reviews: photo detach failed'));
      }
    }
  }
}

/** What a write leaves to do after its transaction commits */
export class Effects {
  events: { name: string; payload: unknown }[] = [];
  productRatings = new Map<string, { count: number; average: number | null }>();
  sellers = new Set<string>();
  takedown: string[] = [];
  takedownReason?: string;
  detach: { assetId: string; refId: string }[] = [];
  sellerSince?: Date;
  threshold?: number;

  emit<N extends OwnEvent>(name: N, payload: EventMap[N]) {
    this.events.push({ name, payload });
  }
}
