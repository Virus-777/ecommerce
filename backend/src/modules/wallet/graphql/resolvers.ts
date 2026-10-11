import { gqlActor, type GraphQLContext, type ModuleResolvers } from '../../../kernel/graphql/index.js';
import { format } from '../../../kernel/lib/money.js';
import type { CreditBalance, GoodwillGrant, LedgerEntry } from '../../../spec/wallet.js';
import type { WalletService } from '../service.js';

/** GraphQL enums are UPPER_CASE; REST values are lower case */
const up = (s: string | null | undefined) => (s ? s.toUpperCase() : s);

/** Money gets its display text (Money.formatted); lazy fields (functions) are kept */
function gql<T>(v: T): T {
  if (Array.isArray(v)) return v.map(gql) as T;
  if (!v || typeof v !== 'object' || v instanceof Date) return v;
  const o = v as Record<string, unknown>;
  if (typeof o.amount === 'number' && typeof o.currency === 'string' && Object.keys(o).length === 2) return { ...o, formatted: format(o as never) } as T;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = typeof x === 'function' ? x : gql(x);
  return out as T;
}

const actor = gqlActor;

const entry = (e: LedgerEntry) => ({ ...e, kind: up(e.kind), actor: actor(e.actor) });
const grant = (g: GoodwillGrant) => ({ ...g, state: up(g.state), chargedTo: up(g.chargedTo), requestedBy: actor(g.requestedBy), decidedBy: actor(g.decidedBy) });

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "wallet", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Customer.wallet → service.getBalance (store: only the signed-in customer's own wallet; anyone else's is null)
 *   Customer.walletAdmin → service.getCustomerWallet (admin, wallet.credit.view checked by @auth)
 */
export const resolvers = (service: WalletService): ModuleResolvers => {
  /** WalletBalance: the balance plus lots and the latest entries, loaded only when asked for */
  const balanceOf = (b: CreditBalance, staff: boolean) => gql({
    ...b,
    lots: async () => gql((await service.ledger.lots(b.customerId)).map((l) => ({ ...l, source: up(l.source) }))),
    recentEntries: async (args: { limit?: number | null }) => gql((await service.ledger.recent(b.customerId, args.limit ?? 5, { staff })).map(entry)),
  });

  return {
    Customer: {
      wallet: async (parent: { id: string }, _args: unknown, ctx: GraphQLContext) => {
        if (ctx.area !== 'store' || (await ctx.customerId()) !== parent.id) return null;
        return balanceOf(await service.getBalance(parent.id), false);
      },
      walletAdmin: async (parent: { id: string }) => {
        const w = await service.getCustomerWallet(parent.id);
        return gql({ ...w, balance: balanceOf(w.balance, true), pendingGrants: w.pendingGrants.map(grant) });
      },
    },
  };
};
