import { isAppError } from '../../../kernel/errors/index.js';
import type { GraphQLContext, ModuleResolvers } from '../../../kernel/graphql/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import { format } from '../../../kernel/lib/money.js';
import { toPageRequest } from '../../../kernel/lib/pagination.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as common from '../../../spec/common.js';
import type * as offers from '../../../spec/offers.js';
import type { Alert, WishlistList } from '../../../spec/wishlist.js';
import type { WishlistService } from '../service.js';
import type { ItemDetail, Lookups } from '../views.js';

/* ---------------------------------------------------------------- REST shapes → GraphQL shapes (enums in capitals, Money.formatted) */

const up = <T extends string | null | undefined>(s: T) => (s ? s.toUpperCase().replace(/-/g, '_') : s);
const money = (m: common.Money | null | undefined) => (m ? { ...m, formatted: format(m) } : null);
const pairs = (m: Record<string, string> | null | undefined) => Object.entries(m ?? {}).map(([name, value]) => ({ name, value }));
const pageInput = (p: common.PageInput | null | undefined): common.PageInput => ({ ...(p?.cursor ? { cursor: p.cursor } : {}), ...(p?.page ? { page: p.page } : {}), ...(p?.limit ? { limit: p.limit } : {}) });

const CONDITION_LABEL: Record<string, string> = { new: 'New', used_like_new: 'Used – Like new', used_good: 'Used – Good', used_acceptable: 'Used – Acceptable', refurbished: 'Refurbished' };

/** A catalog product as the Product type (catalog's fields; other modules add theirs by id) */
const productOut = (p: catalog.Product) => ({ ...p, category: null, specs: pairs(p.specs), variants: p.variants.map(variantOut) });
const variantOut = (v: catalog.Variant) => ({ ...v, options: pairs(v.options) });

/** An offers Offer as the Offer type (offers' own fields; quote, deal and stock resolve by id in their modules) */
const offerOut = (o: offers.Offer, product: () => Promise<catalog.Product | null>) => ({
  ...o,
  ownerType: up(o.ownerType),
  official: o.ownerType === 'official',
  product: async () => {
    const p = await product();
    return p ? productOut(p) : null;
  },
  variant: async () => {
    const v = (await product())?.variants.find((x) => x.id === o.variantId);
    return variantOut(v ?? { id: o.variantId, options: {}, gtin: null, images: [] });
  },
  condition: up(o.condition),
  conditionLabel: CONDITION_LABEL[o.condition] ?? o.condition,
  price: money(o.price),
  compareAt: o.compareAt ? { ...o.compareAt, amount: money(o.compareAt.amount), basis: up(o.compareAt.basis) } : null,
  returnTerms: { ...o.returnTerms, kind: up(o.returnTerms.kind) },
  warranty: { ...o.warranty, kind: up(o.warranty.kind), handledBy: up(o.warranty.handledBy ?? null) },
  status: up(o.status),
});

const listOut = (l: WishlistList) => l;

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

const nullOnNotFound = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (err) {
    if (isAppError(err) && (err.status === 404 || err.code === 'VALIDATION_FAILED')) return null;
    throw err;
  }
};

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "wishlist", …)` in graphql/schema.ts).
 * Same record scope as REST: only the signed-in customer's own wishlist; guests and other callers read null.
 *
 *   Customer.wishlist → service.listItems
 *   Customer.wishlistLists → service.listLists
 *   Customer.wishlistAlerts → service.listAlerts
 *   Product.saved → service.isSaved (batched per request)
 */
export const resolvers = (service: WishlistService): ModuleResolvers => {
  const lookups = new WeakMap<object, Lookups>();
  const lk = (ctx: GraphQLContext) => {
    let l = lookups.get(ctx);
    if (!l) lookups.set(ctx, (l = service.views.lookups()));
    return l;
  };

  /** The signed-in customer's id (customers' id, or the account id while customers has none) */
  const viewer = async (ctx: GraphQLContext): Promise<string | null> => {
    const p = ctx.principal;
    if (p?.kind !== 'customer' || !p.accountId) return null;
    return (await ctx.customerId()) ?? p.accountId;
  };
  /** The viewer, when the Customer object is the viewer's own */
  const own = async (root: { id?: string } | null | undefined, ctx: GraphQLContext) => {
    const c = await viewer(ctx);
    if (!c) return null;
    if (root?.id && root.id !== c && root.id !== ctx.principal?.accountId) return null;
    return c;
  };

  const lists = (ctx: GraphQLContext, customerId: string) => load(ctx, 'lists', customerId, async (ids) => new Map(await Promise.all(ids.map(async (id) => [id, await service.listLists(id)] as const))));

  const itemOut = (d: ItemDetail, customerId: string, ctx: GraphQLContext) => ({
    id: d.item.id,
    list: async () => (await lists(ctx, customerId))?.find((l) => l.id === d.item.listId) ?? null,
    product: productOut(d.product!),
    variant: d.variant ? variantOut(d.variant) : null,
    offer: async () => {
      if (!d.savedOfferId) return null;
      const o = await lk(ctx).offer(d.savedOfferId);
      return o && o.status !== 'removed' && o.status !== 'draft' ? offerOut(o, () => lk(ctx).product(o.productId)) : null;
    },
    priceWhenSaved: money(d.item.priceWhenSaved),
    priceHint: { ...d.item.priceHint, kind: up(d.item.priceHint.kind), low: money(d.item.priceHint.low), high: money(d.item.priceHint.high) },
    alerts: d.item.alerts,
    canMoveToCart: d.item.canMoveToCart,
    note: d.item.note ?? null,
    addedAt: d.item.addedAt,
  });

  const alertOut = (a: Alert, ctx: GraphQLContext) => ({
    ...a,
    itemId: a.itemId ?? null,
    sellerId: a.sellerId ?? null,
    product: async () => {
      const p = await lk(ctx).product(a.productId);
      return p ? productOut(p) : null;
    },
    variant: async () => {
      if (!a.variantId) return null;
      const v = (await lk(ctx).product(a.productId))?.variants.find((x) => x.id === a.variantId);
      return v ? variantOut(v) : null;
    },
    // the seller's public profile belongs to sellers, which wishlist does not depend on: sellerId names the seller
    seller: null,
    kind: up(a.kind),
    state: up(a.state),
    targetPrice: money(a.targetPrice),
    referencePrice: money(a.referencePrice),
    triggeredPrice: money(a.triggeredPrice),
  });

  return {
    Customer: {
      wishlist: async (root: { id?: string }, args: { listId?: string | null; paging?: common.PageInput | null }, ctx: GraphQLContext) => {
        const c = await own(root, ctx);
        if (!c) return null;
        const listId = args.listId ?? undefined;
        if (listId && !isUuid(listId)) return null;
        const page = await nullOnNotFound(service.listItemDetails(c, listId, {}, toPageRequest(pageInput(args.paging))));
        if (!page) return null;
        const total = page.total ?? (await service.countListItems(c, listId));
        return {
          items: page.items.filter((d) => d.product).map((d) => itemOut(d, c, ctx)),
          nextCursor: page.nextCursor ?? null,
          page: page.page ?? null,
          totalPages: page.totalPages ?? null,
          total,
        };
      },
      wishlistLists: async (root: { id?: string }, _args: unknown, ctx: GraphQLContext) => {
        const c = await own(root, ctx);
        return c ? ((await lists(ctx, c)) ?? []).map(listOut) : null;
      },
      wishlistAlerts: async (root: { id?: string }, _args: unknown, ctx: GraphQLContext) => {
        const c = await own(root, ctx);
        if (!c) return null;
        const alerts = await service.listAlerts(c);
        const known = await Promise.all(alerts.map(async (a) => ((await lk(ctx).product(a.productId)) ? a : null)));
        return known.filter((a): a is Alert => a !== null).map((a) => alertOut(a, ctx));
      },
    },
    Product: {
      saved: async (root: { id: string }, _args: unknown, ctx: GraphQLContext) => {
        const c = await viewer(ctx);
        if (!c) return null;
        return (await load(ctx, `saved:${c}`, root.id, async (ids) => new Map(Object.entries(await service.isSaved(c, ids))))) ?? false;
      },
    },
  };
};
