import { createBatchLoader, gqlEnum, type GraphQLContext, type ModuleResolvers, pageInput } from '../../../kernel/graphql/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { CouponCard, DealProduct, DealsPage, FlashItem, FlashSaleBlock, FundingSplit, OfferPromotion, PromoBanner, PublicCampaign, UpcomingEvent } from '../../../spec/promotions.js';
import type { PromotionsService } from '../service.js';

/* ---------------------------------------------------------------- batching per request (one call per field and tick) */

const load = createBatchLoader();

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "promotions", …)` in graphql/schema.ts).
 * Fields of this module's own types resolve from the objects built here (lazy functions where they need
 * another module, so only what a query asks for is loaded).
 */
export const resolvers = (service: PromotionsService): ModuleResolvers => {
  const core = service.core;

  const customerIds = new WeakMap<object, Promise<string | undefined>>();
  /** The signed-in customer's id (customers), or the account id while customers is off */
  const customerOf = (ctx: GraphQLContext): Promise<string | undefined> => {
    const p = ctx.principal;
    if (p?.kind !== 'customer' || !p.accountId) return Promise.resolve(undefined);
    let v = customerIds.get(ctx);
    if (!v) customerIds.set(ctx, (v = core.optional('customers', (c) => c.getCustomerByUserId(p.accountId!)).then((c) => c?.id ?? p.accountId!)));
    return v;
  };

  const campaignOf = (ctx: GraphQLContext, id: string | null | undefined) => (id && isUuid(id) ? load<PublicCampaign | null>(ctx, 'campaign', id, async (ids) => new Map(await Promise.all(ids.map(async (i) => [i, await service.getPublicCampaign(i)] as const)))).then((c) => (c ? campaign(c) : null)) : Promise.resolve(null));
  const campaign = (c: PublicCampaign) => ({ ...c, status: gqlEnum(c.status) });
  const offerOf = (id: string) => () => core.ctx.use('offers').getOffer(id);
  const productOf = (id: string) => () => core.ctx.use('catalog').getProduct(id);

  const banner = (ctx: GraphQLContext) => (b: PromoBanner) => ({ ...b, campaign: () => campaignOf(ctx, b.campaignId) });
  const flashItem = (f: FlashItem) => ({ ...f, offer: offerOf(f.offerId), product: productOf(f.productId), state: gqlEnum(f.state) });
  const flashSale = (ctx: GraphQLContext) => (b: FlashSaleBlock) => ({ id: b.campaignId, campaign: () => campaignOf(ctx, b.campaignId), name: b.name, period: b.period, state: gqlEnum(b.state), secondsLeft: b.secondsLeft, items: b.items.map(flashItem) });
  const coupon = (ctx: GraphQLContext) => (c: CouponCard) => ({ ...c, id: c.campaignId, campaign: () => campaignOf(ctx, c.campaignId), state: gqlEnum(c.state) });
  const dealItem = (d: DealProduct) => ({ ...d, product: productOf(d.productId), offer: offerOf(d.offerId) });
  const event = (ctx: GraphQLContext) => (e: UpcomingEvent) => ({ campaign: () => campaignOf(ctx, e.campaignId), summary: e.summary, reminderSet: e.reminderSet });
  const deal = (ctx: GraphQLContext) => (p: OfferPromotion) => {
    const off = p.regularPrice.amount - p.price.amount;
    if (off <= 0 && !p.flash && !p.sellerPromos.length && !p.badges.length) return null;
    return {
      regularPrice: p.regularPrice,
      price: p.price,
      wasPrice: p.wasPrice ?? null,
      wasPriceRule: p.wasPriceRule ?? null,
      percentOffBps: off > 0 && p.regularPrice.amount ? Math.round((off * 10000) / p.regularPrice.amount) : null,
      badges: p.badges.map((b) => ({ label: b.label, kind: gqlEnum(b.kind) })),
      campaign: () => campaignOf(ctx, p.campaignId),
      purchaseLimit: p.purchaseLimit ?? null,
      flash: p.flash ? { ...p.flash, state: gqlEnum(p.flash.state) } : null,
      endsAt: async () => p.flash?.endsAt ?? (p.campaignId ? ((await service.getPublicCampaign(p.campaignId))?.period.endsAt ?? null) : null),
      sellerPromos: p.sellerPromos.map(banner(ctx)),
    };
  };
  const fundingSplit = (ctx: GraphQLContext) => (s: FundingSplit) => ({ allocations: s.allocations.map((a) => ({ ...a, campaign: () => campaignOf(ctx, a.campaignId) })), sellerFunded: s.sellerFunded, platformFunded: s.platformFunded });
  const overview = (ctx: GraphQLContext) => (d: DealsPage) => ({ serverTime: d.serverTime, tabs: d.tabs, flashSales: d.flashSales.map(flashSale(ctx)), coupons: d.coupons.map(coupon(ctx)), upcomingEvents: d.upcomingEvents.map(event(ctx)), rules: d.rules });
  const linkedCampaign = (root: { linkedPromotionId?: string | null; campaignId?: string | null }, _args: unknown, ctx: GraphQLContext) => campaignOf(ctx, root.linkedPromotionId ?? root.campaignId ?? null);

  return {
    DealsOverview: {
      clearance: async (_root, args: { paging?: common.PageInput | null }) => {
        const page = await service.listClearance(pageInput(args.paging));
        return { ...page, items: page.items.map(dealItem) };
      },
    },
    Offer: {
      deal: async (root: { id: string }, _args, ctx) => {
        const customerId = await customerOf(ctx);
        const p = await load<OfferPromotion>(ctx, `deal:${customerId ?? ''}`, root.id, async (ids) => new Map((await service.priceOffers(ids, { customerId })).map((x) => [x.offerId, x])));
        return p ? deal(ctx)(p) : null;
      },
    },
    Product: {
      coupons: async (root: { id: string }, _args, ctx) => {
        const customerId = await customerOf(ctx);
        const list = await load<CouponCard[]>(ctx, `coupons:${customerId ?? ''}`, root.id, async (ids) => new Map(Object.entries(await service.couponsForProduct(ids, { customerId }))));
        return (list ?? []).map(coupon(ctx));
      },
    },
    Customer: {
      coupons: async (root: { id: string }, _args, ctx) => {
        if (ctx.principal?.kind !== 'customer') return null;
        const own = await customerOf(ctx);
        if (own && root.id !== own && root.id !== ctx.principal.accountId) return null;
        const c = await service.couponsForCustomer(root.id);
        return { available: c.available.map(coupon(ctx)), usedOrExpired: c.usedOrExpired.map(coupon(ctx)), rules: c.rules };
      },
    },
    Seller: {
      activePromotions: async (root: { id: string }, _args, ctx) => {
        const customerId = await customerOf(ctx);
        const list = await load<PromoBanner[]>(ctx, `sellerPromos:${customerId ?? ''}`, root.id, async (ids) => new Map(Object.entries(await service.activeSellerPromotions(ids, { customerId }))));
        return (list ?? []).map(banner(ctx));
      },
    },
    OrderItem: {
      discountFunding: async (root: { id: string }, _args, ctx) => (isUuid(root.id) ? fundingSplit(ctx)(await service.fundingSplitFor(root.id)) : null),
    },
    HomeSection: {
      flashSales: async (root: { kind?: string | null }, args: { limit?: number | null }, ctx) => (String(root.kind ?? '').toLowerCase() === 'deals' ? (await service.liveDeals({ limit: args.limit ?? 1 })).map(flashSale(ctx)) : []),
      campaign: linkedCampaign,
    },
    ContentPage: {
      campaign: linkedCampaign,
    },
    Query: {
      deals: async (_root, _args, ctx) => overview(ctx)(await service.getDealsPage({ customerId: await customerOf(ctx) })),
      flashSales: async (_root, args: { limit?: number | null }, ctx) => (await service.liveDeals({ limit: args.limit ?? 4 })).map(flashSale(ctx)),
      flashSale: async (_root, args: { id: string }, ctx) => {
        const b = await service.getFlashSale(args.id);
        return b ? flashSale(ctx)(b) : null;
      },
    },
  };
};
