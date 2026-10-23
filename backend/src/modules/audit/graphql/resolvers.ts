import { createBatchLoader, gqlActor, gqlEnum, type GraphQLContext, type ModuleResolvers, pageInput } from '../../../kernel/graphql/index.js';
import type { Page, PageInput, TimelineEvent } from '../../../spec/common.js';
import type { AuditEntry, AuditFilters } from '../../../spec/audit.js';
import type { AuditService } from '../service.js';

const down = <T extends string>(s: string | null | undefined) => (s ? (s.toLowerCase() as T) : undefined);

const actorOut = gqlActor;
const stepOut = (s: TimelineEvent) => ({ ...s, actor: actorOut(s.actor) });

export function toGraphQL(e: AuditEntry) {
  return {
    ...e,
    actor: actorOut(e.actor),
    category: gqlEnum(e.category),
    approval: { ...e.approval, state: gqlEnum(e.approval.state), steps: e.approval.steps.map(stepOut) },
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

interface TrailArgs {
  category?: string | null;
  includeRelated?: boolean | null;
  paging?: PageInput | null;
}

/**
 * Batches the auditTrail field of a list (e.g. the orders of a page) into one trailOf call per
 * request, target type and arguments. This used to be a batcher of its own here; it is the kernel's
 * since 2026-10-24 (docs/10 §16.2, Appendix D), which adds a per-request result cache and a chunk cap.
 * The key carries the target type and the arguments, so two lists asking with different paging do not share.
 */
function trailLoader(service: AuditService) {
  const load = createBatchLoader();
  return (targetType: string) =>
    async (root: { id?: string }, args: TrailArgs, ctx: GraphQLContext) => {
      const id = root?.id;
      if (!id) return { items: [], nextCursor: null };
      const opts = { includeRelated: args.includeRelated ?? true, category: down(args.category), page: pageInput(args.paging) };
      const key = `${targetType}|${JSON.stringify(opts)}`;
      const page = (await load<Page<AuditEntry>>(ctx, key, id, (ids) => service.trailOf(targetType, ids, opts))) ?? { items: [], nextCursor: null };
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
      auditEntries: async (_root, args: { filter?: FilterInput | null; paging?: PageInput | null }) => pageOut(await service.searchEntries(filtersIn(args.filter), pageInput(args.paging))),
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
