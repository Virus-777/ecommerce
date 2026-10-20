import { actorOf } from '../../../kernel/auth/index.js';
import { createBatchLoader, type GraphQLContext, type ModuleResolvers, pageInput } from '../../../kernel/graphql/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import { toPageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { PayoutRun, SellerFinanceDetail } from '../../../spec/finance.js';
import type { By } from '../service/core.js';
import type { FinanceService } from '../service.js';

/** Fields that are GraphQL enums (UPPER_CASE) in finance's types; REST values are lower case */
const ENUM_KEYS = new Set(['kind', 'status', 'reasonCode', 'type', 'bucket', 'key', 'direction', 'level', 'result', 'fundedBy']);

/** Deep copy with enum values in upper case; functions (lazy fields) are kept */
export function gql<T>(v: T): T {
  if (Array.isArray(v)) return v.map(gql) as T;
  if (!v || typeof v !== 'object' || v instanceof Date) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = ENUM_KEYS.has(k) && typeof x === 'string' ? x.toUpperCase() : typeof x === 'function' ? x : gql(x);
  return out as T;
}

const lower = (s: string | null | undefined) => (s ? s.toLowerCase() : undefined);

/* ---------------------------------------------------------------- batching per request (one call per field and tick) */

const load = createBatchLoader();

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "finance", …)` in graphql/schema.ts).
 * A seller reaches only its own money (another seller's → null); staff fields are permission-checked by @auth.
 */
export const resolvers = (service: FinanceService): ModuleResolvers => {
  const byOf = (ctx: GraphQLContext): By => ({ actor: actorOf(ctx.principal ? { via: 'token', principal: ctx.principal } : undefined), requestId: ctx.requestId, principal: ctx.principal, can: (p) => ctx.can(p) });
  const ownSeller = (ctx: GraphQLContext, sellerId: string) => ctx.area !== 'seller' || (ctx.principal?.kind === 'seller' && ctx.principal.sellerId === sellerId);

  const runOf = (ctx: GraphQLContext) => (r: PayoutRun) =>
    gql({
      ...r,
      sellers: async (args: { filter?: string | null; search?: string | null; paging?: common.PageInput | null }) => gql(await service.payouts.listRunPayouts(r.id, { q: args.search ?? null, filter: lower(args.filter) ?? null }, toPageRequest(pageInput(args.paging)))),
      failedPayouts: async () => gql((await service.payouts.runDetail(r.id, byOf(ctx)))?.failedPayouts ?? []),
      destinationReviews: async () => gql((await service.payouts.runDetail(r.id, byOf(ctx)))?.destinationReviews ?? []),
    });

  const account = (ctx: GraphQLContext, sellerId: string, d: SellerFinanceDetail) =>
    gql({
      sellerId,
      balance: d.balances,
      ledger: async (args: { type?: string | null; types?: string[] | null; from?: string | null; to?: string | null; paging?: common.PageInput | null }) =>
        gql(await service.ledger.listLedger(sellerId, { type: lower(args.type) ?? null, types: args.types?.length ? args.types.map((t) => t.toLowerCase()).join(',') : null, from: args.from ?? null, to: args.to ?? null }, toPageRequest(pageInput(args.paging)))),
      payouts: async (args: { status?: string | null; paging?: common.PageInput | null }) => gql(await service.payouts.payoutsForSeller(sellerId, lower(args.status) ?? null, toPageRequest(pageInput(args.paging)))),
      statements: async (args: { paging?: common.PageInput | null }) => gql(await service.statements.listFull(sellerId, toPageRequest(pageInput(args.paging)))),
      openHolds: d.openHolds,
      amountsOwed: d.owed,
      feeRuleVersion: d.feeRuleVersion,
      recentAdjustments: ctx.area === 'admin' ? d.recentAdjustments : [],
    });

  return {
    Offer: {
      earningsPreview: async (root: { id: string; sellerId?: string | null; price?: common.Money }, args: { price?: number | null }, ctx) => {
        if (ctx.principal?.kind !== 'seller' || !root.sellerId || root.sellerId !== ctx.principal.sellerId || !root.price) return null;
        const price = { amount: args.price ?? root.price.amount, currency: root.price.currency };
        const res = await service.previewOfferEarnings([{ offerId: root.id, sellerId: root.sellerId, categoryId: null, price }]);
        return res[root.id] ?? null;
      },
    },
    Seller: {
      balance: async (root: { id: string }, _args, ctx) => {
        if (!isUuid(root.id) || !ownSeller(ctx, root.id)) return null;
        return gql(await load(ctx, 'balance', root.id, async (ids) => new Map(await Promise.all(ids.map(async (id) => [id, await service.getSellerBalances(id)] as const)))));
      },
      finance: async (root: { id: string }, _args, ctx) => (isUuid(root.id) ? account(ctx, root.id, await service.getSellerAccount(root.id)) : null),
    },
    Case: {
      holds: async (root: { id: string }, _args, ctx) => {
        const list = await load(ctx, 'caseHolds', root.id, async (ids) => {
          const holds = await service.holdsForReference(ids.map((id) => ({ kind: 'case', id })));
          return new Map(ids.map((id) => [id, holds.filter((h) => h.reference?.id === id)]));
        });
        return gql(list ?? []);
      },
    },
    Query: {
      sellerFinance: async (_root, _args, ctx) => {
        const sellerId = ctx.principal?.kind === 'seller' ? ctx.principal.sellerId : null;
        return sellerId ? account(ctx, sellerId, await service.getSellerAccount(sellerId)) : null;
      },
      statement: async (_root, args: { ref: string }, ctx) => {
        const sellerId = ctx.principal?.kind === 'seller' ? ctx.principal.sellerId : null;
        return sellerId ? gql(await service.getStatementForSeller(sellerId, args.ref)) : null;
      },
      statementAdmin: async (_root, args: { ref: string }) => gql(await service.getStatement(args.ref)),
      payoutRun: async (_root, args: { ref: string }, ctx) => {
        const r = await service.payouts.runDetail(args.ref, byOf(ctx));
        if (!r) return null;
        const { sellers: _s, failedPayouts, destinationReviews, ...run } = r;
        return { ...runOf(ctx)(run), failedPayouts: gql(failedPayouts), destinationReviews: gql(destinationReviews) };
      },
      nextPayoutRun: async (_root, _args, ctx) => {
        const r = await service.payouts.nextRun(byOf(ctx));
        return r ? runOf(ctx)(r) : null;
      },
      refundImpactPreview: async (_root, args: { orderRef: string; items?: { orderItemId: string; quantity?: number | null }[] | null; amount?: number | null; fundedBy?: string | null }) => {
        const p = await service.previewRefundImpactForOrder(args.orderRef, args.items?.map((i) => ({ orderItemId: i.orderItemId, ...(i.quantity ? { quantity: i.quantity } : {}) })) ?? null, args.amount === undefined || args.amount === null ? null : { amount: args.amount, currency: service.core.currency() }, lower(args.fundedBy) ?? 'seller');
        return gql(p);
      },
      payoutRuns: async (_root, args: { status?: string | null; paging?: common.PageInput | null }, ctx) => {
        const page = await service.payouts.listRuns({ status: lower(args.status) ?? null }, toPageRequest(pageInput(args.paging)), byOf(ctx));
        return { ...page, items: page.items.map(runOf(ctx)) };
      },
    },
  };
};
