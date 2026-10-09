import type { GraphQLContext, ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { IdentityService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "identity", …)` in graphql/schema.ts).
 *   Customer.security → service.accountSecurityOf (batched: one call for every customer in the response)
 * @auth(STAFF, identity.accounts.view) is enforced by the kernel before the resolver runs.
 */
interface Batch {
  ids: Set<string>;
  started: boolean;
  result: Promise<Map<string, unknown>>;
}

export const resolvers = (service: IdentityService): ModuleResolvers => {
  const batches = new WeakMap<GraphQLContext, Batch>();

  const load = (ctx: GraphQLContext, accountId: string) => {
    let b = batches.get(ctx);
    if (!b || b.started) {
      const fresh: Batch = { ids: new Set(), started: false, result: Promise.resolve(new Map()) };
      // collect every id asked for in this tick (all customers of a list), then load them at once
      fresh.result = new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
        fresh.started = true;
        return service.accountSecurityOf([...fresh.ids], { activityLimit: 50 });
      });
      batches.set(ctx, fresh);
      b = fresh;
    }
    b.ids.add(accountId);
    return b.result.then((m) => m.get(accountId) ?? null);
  };

  return {
    Customer: {
      // the customer's identity account (customers.Customer.userId)
      security: (parent: { userId?: string | null; accountId?: string | null }, _args, ctx: GraphQLContext) => {
        const id = parent?.userId ?? parent?.accountId;
        return id ? load(ctx, id) : null;
      },
    },
  };
};
