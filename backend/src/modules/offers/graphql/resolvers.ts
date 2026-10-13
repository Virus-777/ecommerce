import { isAppError } from '../../../kernel/errors/index.js';
import { gqlActor, type GraphQLContext, type ModuleResolvers } from '../../../kernel/graphql/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as common from '../../../spec/common.js';
import type { DeliverTo, FeaturedDecision, IneligibilityReason, Offer, OfferView, PriceChange, StatusReason } from '../../../spec/offers.js';
import { conditionLabel, formatMoney } from '../domain/rules.js';
import { pricePoint, statusEntry } from '../mappers.js';
import type { OffersService } from '../service.js';

/* ---------------------------------------------------------------- REST shapes → GraphQL shapes (enums in capitals, Money.formatted) */

const up = <T extends string | null | undefined>(s: T) => (s ? s.toUpperCase().replace(/-/g, '_') : s);
const low = (s: string | null | undefined) => (s ? s.toLowerCase() : undefined);
const money = (m: common.Money | null | undefined) => (m ? { ...m, formatted: formatMoney(m) } : null);
const actor = gqlActor;
const pairs = (m: Record<string, string> | null | undefined) => Object.entries(m ?? {}).map(([name, value]) => ({ name, value }));
const reasons = (list: readonly IneligibilityReason[]) => list.map((r) => ({ ...r, code: up(r.code) }));
const statusReason = (s: StatusReason | null | undefined) => (s ? { ...s, code: up(s.code), actor: actor(s.actor) } : null);
const deliverTo = (d: DeliverTo) => ({ ...d, source: up(d.source) });
const pageInput = (p: common.PageInput | null | undefined): common.PageInput => ({ ...(p?.cursor ? { cursor: p.cursor } : {}), ...(p?.page ? { page: p.page } : {}), ...(p?.limit ? { limit: p.limit } : {}) });

const productOut = (p: catalog.Product) => ({ ...p, category: null, specs: pairs(p.specs), variants: p.variants.map((v) => ({ ...v, options: pairs(v.options) })) });

const quoteOut = (v: OfferView, d: DeliverTo, quantity: number) => ({
  deliverTo: deliverTo(d),
  quantity,
  price: money(v.price),
  regularPrice: money(v.regularPrice),
  automaticDiscount: v.automaticDiscount ? { ...v.automaticDiscount, amount: money(v.automaticDiscount.amount) } : null,
  shippingCost: v.delivery.shipsToLocation ? money(v.delivery.shippingCost) : null,
  freeShipping: v.delivery.free,
  freeShippingOver: money(v.delivery.freeOver),
  total: money(v.total),
  featured: v.featured,
  featuredEligible: v.featuredEligible,
  ineligibleNote: v.ineligibleNote ?? null,
});

const priceChangeOut = (c: PriceChange) => ({
  ...c,
  from: money(c.from),
  to: money(c.to),
  compareAt: money(c.compareAt),
  revertTo: money(c.revertTo),
  source: up(c.source),
  state: up(c.state),
  requestedBy: actor(c.requestedBy),
});

/* ---------------------------------------------------------------- batching per request (one call per key and tick) */

type Batch<V> = { ids: Set<string>; promise: Promise<Map<string, V>> };
const batches = new WeakMap<object, Map<string, Batch<unknown>>>();

function load<V>(ctx: GraphQLContext, key: string, id: string, fetch: (ids: string[]) => Promise<Map<string, V>>): Promise<V | undefined> {
  let perCtx = batches.get(ctx);
  if (!perCtx) batches.set(ctx, (perCtx = new Map()));
  let batch = perCtx.get(key) as Batch<V> | undefined;
  if (!batch) {
    const ids = new Set<string>();
    const promise = new Promise<Map<string, V>>((resolve, reject) => {
      setImmediate(() => {
        perCtx!.delete(key);
        fetch([...ids]).then(resolve, reject);
      });
    });
    batch = { ids, promise };
    perCtx.set(key, batch as Batch<unknown>);
  }
  batch.ids.add(id);
  return batch.promise.then((m) => m.get(id));
}

const nullOnNotFound = async <T,>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (err) {
    if (isAppError(err) && (err.status === 404 || err.code === 'VALIDATION_FAILED')) return null;
    throw err;
  }
};

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "offers", …)` in graphql/schema.ts).
 * Offer objects carry their own fields as values or lazy functions; Offer.quote uses views primed by
 * Product.offers when the arguments match, else a batched quoteOffer.
 *
 *   Offer.quote → service.quoteOffer
 *   Product.offers → service.compareOffers
 *   Product.featuredOffer → service.getFeaturedOfferForProduct
 *   Product.offer → service.getPurchaseBoxOffer
 *   Product.offerCount / Product.priceRange → service.getOfferStats
 *   Product.myOffers → service.listOwnOffersForProduct
 *   Product.featuredDecision → service.getFeaturedDecision
 *   SellerCollection.offers → service.listActiveOffersByIds
 *   Variant.offerSummary → service.getVariantOfferSummaries
 *   Query.offer / myOffer / offerAdmin / offersAdmin → getOffer / getOwnOffer / getOfferAdmin / listOffersAdmin
 */
export const resolvers = (service: OffersService): ModuleResolvers => {
  const core = service.core;

  const productOf = (ctx: GraphQLContext, id: string) =>
    load(ctx, 'products', id, async (ids) => {
      const out = new Map<string, catalog.Product>();
      for (const pid of ids) {
        const p = await core.soft('catalog.getProduct', () => core.ctx.use('catalog').getProduct(pid));
        if (p) out.set(pid, p);
      }
      return out;
    });

  const offersById = (ctx: GraphQLContext, id: string) => load(ctx, 'offers', id, async (ids) => new Map((await core.toOffers(await core.repo.getMany('offers', ids.filter(isUuid)))).map((o) => [o.id, o])));

  /**
   * An Offer for GraphQL is the REST Offer itself: its fields are converted by the Offer field resolvers below, so an
   * offer another module returns (search results, promotions) answers exactly like one from this module.
   * `primed` holds quotes computed for a comparison.
   */
  function offerOut(o: Offer, _ctx: GraphQLContext, primed?: { view: OfferView; deliverTo: DeliverTo }) {
    return { ...o, __primed: primed };
  }

  /** REST Offer → GraphQL Offer, field by field (the parent is always the REST Offer) */
  const offerFields = {
    ownerType: (o: Offer) => up(o.ownerType),
    official: (o: Offer) => o.ownerType === 'official',
    product: async (o: Offer, _args: unknown, ctx: GraphQLContext) => {
      const p = await productOf(ctx, o.productId);
      return p ? productOut(p) : null;
    },
    variant: async (o: Offer, _args: unknown, ctx: GraphQLContext) => {
      const v = (await productOf(ctx, o.productId))?.variants.find((x) => x.id === o.variantId);
      return { ...(v ?? { id: o.variantId, options: {}, gtin: null, images: [] }), options: pairs(v?.options) };
    },
    condition: (o: Offer) => up(o.condition),
    conditionLabel: (o: Offer) => conditionLabel(o.condition),
    price: (o: Offer) => money(o.price),
    compareAt: (o: Offer) => (o.compareAt ? { ...o.compareAt, amount: money(o.compareAt.amount), basis: up(o.compareAt.basis) } : null),
    // what customers get: Marketly's dispatch and ships-from for Fulfilled by Marketly offers (Offer.shipping)
    dispatch: (o: Offer) => o.shipping.dispatch,
    fulfilledBy: (o: Offer) => up(o.fulfilledBy),
    returnTerms: (o: Offer) => ({ ...o.returnTerms, kind: up(o.returnTerms.kind) }),
    warranty: (o: Offer) => ({ ...o.warranty, kind: up(o.warranty.kind), handledBy: up(o.warranty.handledBy ?? null) }),
    status: (o: Offer) => up(o.status),
    statusReason: (o: Offer) => statusReason(o.statusReason),
    featuredEligibility: (o: Offer) => ({ ...o.featuredEligibility, reasons: reasons(o.featuredEligibility.reasons) }),
    priceContext: async (o: Offer) => {
      const c = await service.views.priceContext(o.variantId, o.id);
      return { lowestNewPrice: money(c.lowestNewPrice), officialStorePrice: money(c.officialStorePrice), otherOfferCount: c.otherOfferCount };
    },
    priceHistory: async (o: Offer, args: { limit?: number | null }) =>
      (await core.repo.find('offer_price_history', { offer_id: o.id }, { orderBy: [['valid_from', 'desc']], limit: Math.min(Math.max(args?.limit ?? 20, 1), 200) })).map((h) => {
        const p = pricePoint(h, o.price.currency);
        return { ...p, price: money(p.price), compareAt: money(p.compareAt), changedBy: actor(p.changedBy) };
      }),
    statusLog: async (o: Offer, args: { limit?: number | null }) =>
      (await core.repo.find('offer_status_log', { offer_id: o.id }, { orderBy: [['at', 'desc']], limit: Math.min(Math.max(args?.limit ?? 20, 1), 200) })).map((l) => {
        const e = statusEntry(l);
        return { ...e, from: up(e.from ?? null), to: up(e.to), actor: actor(e.actor) };
      }),
    priceChanges: async (o: Offer) => (await service.pricing.changesFor(o.id)).map(priceChangeOut),
  };

  const out = (o: Offer | null | undefined, ctx: GraphQLContext) => (o ? offerOut(o, ctx) : null);

  const decisionOut = (d: FeaturedDecision, ctx: GraphQLContext) => ({
    ...d,
    deliverTo: deliverTo(d.deliverTo),
    candidates: d.candidates.map((c) => ({
      ...c,
      offer: async () => out(await offersById(ctx, c.offerId), ctx),
      reasons: reasons(c.reasons),
      total: money(c.total),
      adjustedTotal: money(c.adjustedTotal),
    })),
  });

  const statsFor = (ctx: GraphQLContext, productId: string, condition: string | null | undefined) =>
    load(ctx, `stats:${low(condition) ?? 'all'}`, productId, async (ids) => {
      const s = await service.getOfferStats(ids, { condition: (low(condition) ?? 'all') as 'all' });
      return new Map(Object.entries(s));
    });

  return {
    Offer: {
      ...offerFields,
      quote: async (root: { id: string; __primed?: { view: OfferView; deliverTo: DeliverTo } }, args: { postalCode?: string | null; quantity?: number | null }, ctx: GraphQLContext) => {
        const quantity = args.quantity && args.quantity > 0 ? args.quantity : 1;
        const d = service.storefront.deliverTo(args.postalCode);
        if (root.__primed && quantity === 1 && root.__primed.deliverTo.postalCode === d.postalCode) return quoteOut(root.__primed.view, d, 1);
        const view = await load(ctx, `quote:${d.postalCode}:${quantity}`, root.id, async (ids) => {
          const rows = await core.repo.getMany('offers', ids.filter(isUuid));
          return new Map((await service.storefront.views(rows, d, quantity)).map((v) => [v.offerId, v]));
        });
        if (!view) throw Object.assign(new Error('Offer not found'), { extensions: { code: 'NOT_FOUND' } });
        return quoteOut(view, d, quantity);
      },
    },
    Product: {
      offers: async (root: { id: string }, args: { variantId?: string | null; condition?: string | null; postalCode?: string | null; sort?: string | null }, ctx: GraphQLContext) => {
        const c = await nullOnNotFound(
          service.compareOffers(root.id, {
            ...(args.variantId ? { variantId: args.variantId } : {}),
            ...(args.condition ? { condition: low(args.condition) as 'all' } : {}),
            ...(args.postalCode ? { postalCode: args.postalCode } : {}),
            ...(args.sort ? { sort: low(args.sort) as 'total_cost' } : {}),
          }),
        );
        if (!c) return null;
        const rows = new Map((await core.toOffers(await core.repo.getMany('offers', c.offers.map((v) => v.offerId)))).map((o) => [o.id, o]));
        return {
          productId: c.product.id,
          variantId: c.variant.id,
          deliverTo: deliverTo(c.deliverTo),
          sort: up(c.sort),
          condition: up(args.condition ?? 'all'),
          featuredOfferId: c.featuredOfferId ?? null,
          items: c.offers.flatMap((v) => (rows.get(v.offerId) ? [offerOut(rows.get(v.offerId)!, ctx, { view: v, deliverTo: c.deliverTo })] : [])),
          conditionCounts: { all: c.conditionCounts.all ?? 0, new: c.conditionCounts.new ?? 0, used: c.conditionCounts.used ?? 0, refurbished: c.conditionCounts.refurbished ?? 0 },
          rule: c.rule,
          taxNote: c.taxNote,
        };
      },
      featuredOffer: async (root: { id: string }, args: { variantId?: string | null; postalCode?: string | null }, ctx: GraphQLContext) => {
        const o = await load(ctx, `featured:${args.postalCode ?? ''}:${args.variantId ?? ''}`, root.id, async (ids) =>
          new Map(Object.entries(await service.getFeaturedOfferForProduct(ids.map((productId) => ({ productId, ...(args.variantId ? { variantId: args.variantId } : {}) })), args.postalCode ?? undefined))),
        );
        return out(o, ctx);
      },
      offer: async (root: { id: string }, args: { id?: string | null; variantId?: string | null; postalCode?: string | null }, ctx: GraphQLContext) => {
        const r = await service.getPurchaseBoxOffer([{ productId: root.id, ...(args.id ? { offerId: args.id } : {}), ...(args.variantId ? { variantId: args.variantId } : {}) }], args.postalCode ?? undefined);
        return out(r[root.id], ctx);
      },
      offerCount: async (root: { id: string }, args: { condition?: string | null }, ctx: GraphQLContext) => (await statsFor(ctx, root.id, args.condition))?.count ?? 0,
      priceRange: async (root: { id: string }, args: { condition?: string | null }, ctx: GraphQLContext) => {
        const s = await statsFor(ctx, root.id, args.condition);
        return s ? { lowest: money(s.lowest), highest: money(s.highest), lowestOfferId: s.lowestOfferId, lowestSellerName: s.lowestSellerName, offerCount: s.count } : null;
      },
      myOffers: async (root: { id: string }, _args: unknown, ctx: GraphQLContext) => {
        const sellerId = ctx.principal?.sellerId;
        if (!sellerId) return [];
        const list = await load(ctx, `mine:${sellerId}`, root.id, async (ids) => new Map(Object.entries(await service.listOwnOffersForProduct(sellerId, ids))));
        return (list ?? []).map((o) => offerOut(o, ctx));
      },
      featuredDecision: async (root: { id: string }, args: { variantId?: string | null; postalCode?: string | null }, ctx: GraphQLContext) => {
        const d = await nullOnNotFound(service.getFeaturedDecision(root.id, args.variantId ?? undefined, args.postalCode ?? undefined));
        return d ? decisionOut(d, ctx) : null;
      },
    },
    SellerCollection: {
      offers: async (root: { offerIds?: string[] | null }, args: { limit?: number | null }, ctx: GraphQLContext) => (await service.listActiveOffersByIds(root.offerIds ?? [], args.limit ?? 8)).map((o) => offerOut(o, ctx)),
    },
    Variant: {
      offerSummary: async (root: { id: string }, args: { postalCode?: string | null }, ctx: GraphQLContext) => {
        const s = await load(ctx, `variants:${args.postalCode ?? ''}`, root.id, async (ids) => new Map(Object.entries(await service.getVariantOfferSummaries(ids, args.postalCode ?? undefined))));
        return s ? { variantId: s.variantId, offerCount: s.offerCount, lowestPrice: money(s.lowestPrice), inStock: s.inStock, summary: s.summary } : null;
      },
    },
    Query: {
      offer: async (_root, args: { id: string }, ctx: GraphQLContext) => {
        const o = await service.getOffer(args.id);
        return o && o.status !== 'draft' ? offerOut(o, ctx) : null;
      },
      myOffer: async (_root, args: { id: string }, ctx: GraphQLContext) => {
        const sellerId = ctx.principal?.sellerId;
        return sellerId ? out(await service.getOwnOffer(sellerId, args.id), ctx) : null;
      },
      offerAdmin: async (_root, args: { id: string }, ctx: GraphQLContext) => out(await service.getOfferAdmin(args.id), ctx),
      offersAdmin: async (_root, args: { filter?: { sellerId?: string | null; official?: boolean | null; productId?: string | null; status?: string[] | null; featuredEligible?: boolean | null; ineligibilityCode?: string | null; q?: string | null } | null; paging?: common.PageInput | null }, ctx: GraphQLContext) => {
        const f = args.filter ?? {};
        const page = await service.listOffersAdmin(
          {
            ...(f.sellerId ? { sellerId: f.sellerId } : {}),
            ...(f.official !== undefined && f.official !== null ? { official: f.official } : {}),
            ...(f.productId ? { productId: f.productId } : {}),
            ...(f.status?.length ? { status: f.status.map((s) => s.toLowerCase()) } : {}),
            ...(f.featuredEligible !== undefined && f.featuredEligible !== null ? { featuredEligible: f.featuredEligible } : {}),
            ...(f.ineligibilityCode ? { ineligibilityCode: f.ineligibilityCode.toLowerCase() } : {}),
            ...(f.q ? { q: f.q } : {}),
          },
          pageInput(args.paging),
        );
        return { ...page, items: page.items.map((o) => offerOut(o, ctx)) };
      },
    },
  };
};
