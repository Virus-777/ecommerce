import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import { format as formatMoney } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import type { CartItem, CartNotice, CartPackage, CartView, CouponPreview, SavedItem, SellerLabel } from '../../../spec/cart.js';
import type { CartService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "cart", …)` in graphql/schema.ts).
 *   Query.cart → service.getCartView (the principal's cart, re-checked on read; null without one)
 * The Cart object is built here: GraphQL enums are upper case, Money carries `formatted`.
 */
const upper = <T extends string | null | undefined>(s: T) => (s ? s.toUpperCase() : s);
const gqlMoney = (m: common.Money | null | undefined) => (m ? { ...m, formatted: formatMoney(m) } : null);
const gqlSeller = (s: SellerLabel) => ({ id: s.id ?? null, name: s.name, slug: s.slug, official: s.official, verified: s.verified, logo: s.logo ?? null });

const gqlNotice = (n: CartNotice) => ({
  ...n,
  kind: upper(n.kind),
  severity: upper(n.severity),
  previousPrice: gqlMoney(n.previousPrice),
  currentPrice: gqlMoney(n.currentPrice),
  actions: n.actions.map((a) => a.toUpperCase()),
  alternatives: n.alternatives ? { ...n.alternatives, condition: upper(n.alternatives.condition), lowestPrice: gqlMoney(n.alternatives.lowestPrice) } : null,
});

const gqlLine = (i: CartItem) => ({
  ...i,
  options: Object.entries(i.options).map(([name, value]) => ({ name, value })),
  condition: upper(i.condition),
  state: upper(i.state),
  unitPrice: gqlMoney(i.unitPrice),
  compareAtPrice: gqlMoney(i.compareAtPrice),
  acceptedUnitPrice: gqlMoney(i.acceptedUnitPrice),
  lineTotal: gqlMoney(i.lineTotal),
  notices: i.notices.map(gqlNotice),
});

const gqlPackage = (p: CartPackage) => ({
  ...p,
  seller: gqlSeller(p.seller),
  items: p.items.map(gqlLine),
  subtotal: gqlMoney(p.subtotal),
  delivery: p.delivery
    ? {
        ...p.delivery,
        arrivalFrom: p.delivery.arrival.from,
        arrivalTo: p.delivery.arrival.to,
        shipping: gqlMoney(p.delivery.shipping),
        amountToFreeShipping: gqlMoney(p.delivery.amountToFreeShipping),
        estimateBasis: upper(p.delivery.estimateBasis),
      }
    : null,
});

const gqlCoupon = (c: CouponPreview) => ({
  ...c,
  status: upper(c.status),
  fundedBy: upper(c.fundedBy ?? null),
  amount: gqlMoney(c.amount),
  coverage: c.coverage.map((x) => ({ ...x, amount: gqlMoney(x.amount) })),
});

const gqlSaved = (s: SavedItem) => ({ ...s, seller: gqlSeller(s.seller), currentPrice: gqlMoney(s.currentPrice) });

export const gqlCart = (v: CartView, savedForLater: (limit: number) => Promise<SavedItem[]>) => ({
  ...v,
  destination: v.destination ? { ...v.destination, source: upper(v.destination.source) } : null,
  packages: v.packages.map(gqlPackage),
  coupons: v.coupons.map(gqlCoupon),
  totals: {
    ...v.totals,
    itemsSubtotal: gqlMoney(v.totals.itemsSubtotal),
    discounts: v.totals.discounts.map((d) => ({ ...d, amount: gqlMoney(d.amount), fundedBy: upper(d.fundedBy) })),
    shippingByPackage: v.totals.shippingByPackage.map((s) => ({ ...s, amount: gqlMoney(s.amount) })),
    shippingTotal: gqlMoney(v.totals.shippingTotal),
    total: gqlMoney(v.totals.total),
  },
  savedForLater: async (args: { limit?: number }) => (await savedForLater(args?.limit ?? 20)).map(gqlSaved),
});

export const resolvers = (service: CartService): ModuleResolvers => ({
  Query: {
    cart: async (_parent, _args, ctx) => {
      const found = await service.getCartViewFor(ctx.principal);
      if (!found) return null;
      return gqlCart(found.view, (limit) => service.savedForLaterOf(found.shopper, limit));
    },
  },
});
