import { gqlActor, type GraphQLContext, type ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { Page, PageInput, TimelineEvent } from '../../../spec/common.js';
import type { AuditEntry, AuditFilters } from '../../../spec/audit.js';
import type { AuditService } from '../service.js';

/** GraphQL enums are the upper-case names of the REST values (FINANCIAL ↔ financial). */
const up = (s: string) => s.toUpperCase();
const down = <T extends string>(s: string | null | undefined) => (s ? (s.toLowerCase() as T) : undefined);

const actorOut = gqlActor;
const stepOut = (s: TimelineEvent) => ({ ...s, actor: actorOut(s.actor) });

export function toGraphQL(e: AuditEntry) {
  return {
    ...e,
    actor: actorOut(e.actor),
    category: up(e.category),
    approval: { ...e.approval, state: up(e.approval.state), steps: e.approval.steps.map(stepOut) },
  };
}

const pageOut = (p: Page<AuditEntry>) => ({ ...p, items: p.items.map(toGraphQL) });

interface FilterInput extends Omit<AuditFilters, 'category' | 'approvalState'> {
  category?: string | null;
  approvalState?: string | null;
}

const filtersIn = (f: FilterInput | null | undefined): AuditFilters => {
  if (!f) return {};
  const { category, approvalState, ...rest } = f;
  return { ...rest, category: down(category), approvalState: down(approvalState) };
};

const pagingIn = (p: PageInput | null | undefined): PageInput => ({
  ...(p?.cursor ? { cursor: p.cursor } : {}),
  ...(p?.page ? { page: p.page } : {}),
  ...(p?.limit ? { limit: p.limit } : {}),
});

interface TrailArgs {
  category?: string | null;
  includeRelated?: boolean | null;
  paging?: PageInput | null;
}

/**
 * Batches the auditTrail field of a list (e.g. the orders of a page) into one trailOf call per
 * request, target type and arguments.
 */
interface Batch {
  ids: Set<string>;
  started: boolean;
  result: Promise<Map<string, Page<AuditEntry>>>;
}

function trailLoader(service: AuditService) {
  const perRequest = new WeakMap<object, Map<string, Batch>>();
  return (targetType: string) =>
    async (root: { id?: string }, args: TrailArgs, ctx: GraphQLContext) => {
      const id = root?.id;
      if (!id) return { items: [], nextCursor: null };
      const opts = { includeRelated: args.includeRelated ?? true, category: down(args.category), page: pagingIn(args.paging) };
      const key = `${targetType}|${JSON.stringify(opts)}`;
      let batches = perRequest.get(ctx);
      if (!batches) perRequest.set(ctx, (batches = new Map()));
      let batch = batches.get(key);
      if (!batch || batch.started) {
        const b = { ids: new Set<string>(), started: false } as Batch;
        // collect every sibling resolved in this tick, then ask once
        b.result = new Promise((resolve) => setImmediate(resolve)).then(() => {
          b.started = true;
          return service.trailOf(targetType, [...b.ids], opts);
        });
        batches.set(key, b);
        batch = b;
      }
      batch.ids.add(id);
      const page = (await batch.result).get(id) ?? { items: [], nextCursor: null };
      return pageOut(page);
    };
}

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "audit", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Query.auditEntries → service.searchEntries
 *   Query.auditEntry → service.getEntry
 *   Order.auditTrail → service.trailOf
 *   Seller.auditTrail → service.trailOf
 *   Customer.auditTrail → service.trailOf
 *   PayoutRun.auditTrail → service.trailOf
 */
export const resolvers = (service: AuditService): ModuleResolvers => {
  const trail = trailLoader(service);
  return {
    Query: {
      auditEntries: async (_root, args: { filter?: FilterInput | null; paging?: PageInput | null }) => pageOut(await service.searchEntries(filtersIn(args.filter), pagingIn(args.paging))),
      auditEntry: async (_root, args: { id: string }) => {
        const e = await service.getEntry(args.id);
        return e ? toGraphQL(e) : null;
      },
    },
    Order: { auditTrail: trail('order') },
    Seller: { auditTrail: trail('seller') },
    Customer: { auditTrail: trail('customer') },
    PayoutRun: { auditTrail: trail('payout_run') },
  };
};
