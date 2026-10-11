import { GraphQLError } from 'graphql';
import { gqlActor, type GraphQLContext, type ModuleResolvers } from '../../../kernel/graphql/index.js';
import { format as formatMoney } from '../../../kernel/lib/money.js';
import type { Money } from '../../../spec/common.js';
import type { Movement, StockItem } from '../../../spec/inventory.js';
import type { InventoryService } from '../service.js';

/* ---------------------------------------------------------------- REST shapes → GraphQL shapes (enums in capitals, Money.formatted) */

const up = (s: string) => s.toUpperCase();
const money = (m: Money | null | undefined) => (m ? { ...m, formatted: formatMoney(m) } : null);
const actorOut = gqlActor;

const movementOut = (m: Movement) => ({
  id: m.id,
  fromGroup: up(m.fromGroup),
  toGroup: up(m.toGroup),
  quantity: m.quantity,
  reasonCode: m.reasonCode,
  reasonLabel: m.reasonLabel,
  note: m.note ?? null,
  referenceLabel: m.reference?.label ?? null,
  actor: actorOut(m.actor),
  approvedBy: actorOut(m.approvedBy),
  at: m.at,
});

/**
 * Batches calls made by sibling fields of one request (e.g. Offer.availability on every offer of a
 * page) into one service call per tick and argument key.
 */
function batcher<K, V>(load: (keys: K[], arg: string) => Promise<Map<K, V>>) {
  const perRequest = new WeakMap<object, Map<string, { keys: Set<K>; started: boolean; result: Promise<Map<K, V>> }>>();
  return async (ctx: GraphQLContext, key: K, arg = ''): Promise<V | undefined> => {
    let batches = perRequest.get(ctx);
    if (!batches) perRequest.set(ctx, (batches = new Map()));
    let b = batches.get(arg);
    if (!b || b.started) {
      const next = { keys: new Set<K>(), started: false } as { keys: Set<K>; started: boolean; result: Promise<Map<K, V>> };
      next.result = new Promise((resolve) => setImmediate(resolve)).then(() => {
        next.started = true;
        return load([...next.keys], arg);
      });
      batches.set(arg, next);
      b = next;
    }
    b.keys.add(key);
    return (await b.result).get(key);
  };
}

/** Stock fields resolve for the owning seller (own items only) or staff holding inventory.stock.view */
async function assertStockReader(ctx: GraphQLContext) {
  if (ctx.principal?.kind === 'staff' && !(await ctx.can('inventory.stock.view'))) {
    throw new GraphQLError('Needs permission inventory.stock.view', { extensions: { code: 'FORBIDDEN' } });
  }
}

/** The seller the caller acts for in the Seller Center; staff see company and seller items */
const viewerOf = (ctx: GraphQLContext): { sellerId?: string } => (ctx.area === 'seller' || ctx.principal?.kind === 'seller' ? { sellerId: ctx.principal?.sellerId ?? '00000000-0000-0000-0000-000000000000' } : {});

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "inventory", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Offer.availability → service.getOfferAvailability
 *   Offer.stock → service.getStockForOffers
 *   Variant.stock → service.listStockForVariants
 *   Query.myStockSummary → service.getSellerStockSummary
 *   Query.stockSummary → service.getStockSummary
 */
export const resolvers = (service: InventoryService): ModuleResolvers => {
  const lastChange = batcher<string, string>(async (ids) => service.lastChangesFor(ids));
  const movements = batcher<string, Movement[]>(async (ids, arg) => service.recentMovementsFor(ids, Number(arg)));

  /** StockItem with its lazily resolved fields */
  const stockItemOut = (s: StockItem) => ({
    ...s,
    ownerType: up(s.ownerType),
    state: up(s.state),
    unitCost: money(s.unitCost),
    valueAtCost: money(s.valueAtCost),
    lastChange: (_args: unknown, ctx: GraphQLContext) => lastChange(ctx, s.id).then((v) => v ?? null),
    recentMovements: async (args: { limit?: number | null }, ctx: GraphQLContext) => {
      const limit = Math.min(Math.max(args?.limit ?? 10, 1), 50);
      return ((await movements(ctx, s.id, String(limit))) ?? []).map(movementOut);
    },
  });

  const availability = batcher<string, Awaited<ReturnType<InventoryService['getOfferAvailability']>>[string]>(async (keys) => {
    const offers = keys.map((k) => JSON.parse(k) as { offerId: string; stockItemId: string; purchaseLimit?: number });
    const res = await service.getOfferAvailability(offers);
    return new Map(keys.map((k, i) => [k, res[offers[i]!.offerId]!]));
  });
  const stockForOffers = batcher<string, StockItem | null>(async (ids, arg) => {
    const res = await service.getStockForOffers(ids, arg ? { sellerId: arg } : {});
    return new Map(ids.map((id) => [id, res[id] ?? null]));
  });
  const stockForVariants = batcher<string, StockItem[]>(async (ids, arg) => {
    const res = await service.listStockForVariants(ids, arg ? { sellerId: arg } : {});
    return new Map(ids.map((id) => [id, res[id] ?? []]));
  });

  return {
    Offer: {
      availability: async (root: { id: string; stockItemId?: string | null; purchaseLimit?: number | null }, _args, ctx) => {
        let stockItemId = root.stockItemId ?? null;
        if (!stockItemId) stockItemId = (await stockForOffers(ctx, root.id, ''))?.id ?? '';
        const a = await availability(ctx, JSON.stringify({ offerId: root.id, stockItemId, ...(root.purchaseLimit != null ? { purchaseLimit: root.purchaseLimit } : {}) }));
        return a ? { ...a, state: up(a.state) } : { state: 'OUT_OF_STOCK', quantity: null, maxPerOrder: 0, purchaseLimit: root.purchaseLimit ?? null, label: 'Out of stock', expectedRestockDate: null };
      },
      stock: async (root: { id: string }, _args, ctx) => {
        await assertStockReader(ctx);
        const s = await stockForOffers(ctx, root.id, viewerOf(ctx).sellerId ?? '');
        return s ? stockItemOut(s) : null;
      },
    },
    Variant: {
      stock: async (root: { id: string }, _args, ctx) => {
        await assertStockReader(ctx);
        return ((await stockForVariants(ctx, root.id, viewerOf(ctx).sellerId ?? '')) ?? []).map(stockItemOut);
      },
    },
    Query: {
      myStockSummary: async (_root, _args, ctx) => service.getSellerStockSummary(ctx.principal?.sellerId ?? '00000000-0000-0000-0000-000000000000'),
      stockSummary: async (_root, args: { locationId?: string | null }) => {
        const s = await service.getStockSummary(args.locationId ?? undefined);
        return { ...s, groups: s.groups.map((g) => ({ ...g, group: up(g.group), valueAtCost: money(g.valueAtCost) })) };
      },
    },
  };
};
