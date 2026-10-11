import { AppError } from '../../../kernel/errors/index.js';
import { gqlActor, type GraphQLContext, type ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { ApprovalRequest, MyActionLimit, RoleCoverage, StaffRef } from '../../../spec/access.js';
import type * as common from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import { formatMoney } from '../domain/limits.js';
import type { AccessService } from '../service.js';

/* ---------------------------------------------------------------- REST shapes → GraphQL shapes (enums in capitals, Money.formatted) */

const upper = (s: string) => s.toUpperCase().replace(/-/g, '_');
const money = (m: common.Money | null | undefined) => (m ? { ...m, formatted: formatMoney(m) } : null);
const actor = gqlActor;
const staff = (s: StaffRef | null | undefined) => (s ? { accountId: s.accountId, name: s.name, away: s.away } : null);
const deadline = (d: common.Deadline | null | undefined) => (d ? { dueAt: d.dueAt, state: upper(d.state) } : null);

/** One row per required approval: done, waiting, rejected/returned, or skipped when the request ended first */
function steps(r: ApprovalRequest) {
  const approved = r.approvals.filter((a) => a.decision === 'approved');
  const ending = r.approvals.find((a) => a.decision === 'rejected' || a.decision === 'returned');
  const open = r.status === 'pending' || r.status === 'partially_approved';
  const total = Math.max(r.status === 'approved' ? approved.length : r.requiredApprovals, approved.length + (open || ending ? 1 : 0), 1);
  const who = (a: (typeof r.approvals)[number]) => [a.by.name ?? 'Staff member', a.roles[0]?.name].filter(Boolean).join(' · ');
  return Array.from({ length: total }, (_, i) => {
    const step = i + 1;
    const done = approved[i];
    if (done) return { step, state: 'DONE', label: who(done), decidedBy: actor(done.by), decidedAt: done.at, assignedTo: null, deadline: null, note: done.note ?? null };
    if (ending && i === approved.length) return { step, state: ending.decision === 'rejected' ? 'REJECTED' : 'RETURNED', label: who(ending), decidedBy: actor(ending.by), decidedAt: ending.at, assignedTo: null, deadline: null, note: ending.note ?? null };
    if (!open) return { step, state: 'SKIPPED', label: 'Not reached', decidedBy: null, decidedAt: null, assignedTo: null, deadline: null, note: null };
    const names = r.eligibleApprovers.slice(0, 2).map((s) => s.name);
    const label = i === 0 && !r.requesterCountsAsFirst ? 'Approval' : 'Second reviewer';
    return {
      step,
      state: 'WAITING',
      label: r.nominatedReviewer ? `${label} · ${r.nominatedReviewer.name}` : names.length ? `${label} · ${names.join(' or ')}` : label,
      decidedBy: null,
      decidedAt: null,
      assignedTo: i === approved.length ? staff(r.nominatedReviewer) : null,
      deadline: deadline(r.deadline),
      note: null,
    };
  });
}

export function approvalToGraphQL(r: ApprovalRequest) {
  const approvedCount = r.approvals.filter((a) => a.decision === 'approved').length;
  const open = r.status === 'pending' || r.status === 'partially_approved' || r.status === 'returned';
  return {
    ...r,
    action: { key: r.action.key, module: r.action.module, label: r.action.label },
    amount: money(r.amount),
    requestedBy: actor(r.requestedBy),
    status: upper(r.status),
    approvalsRemaining: open ? Math.max(0, r.requiredApprovals - approvedCount) : 0,
    approvals: r.approvals.map((a) => ({ ...a, decision: upper(a.decision), by: actor(a.by), viaDelegationFrom: staff(a.viaDelegationFrom) })),
    steps: steps(r),
    eligibleApprovers: r.eligibleApprovers.map(staff),
    nominatedReviewer: staff(r.nominatedReviewer),
    deadline: deadline(r.deadline),
    timeline: r.timeline.map((t) => ({ ...t, actor: actor(t.actor) })),
  };
}

function limitToGraphQL(l: MyActionLimit) {
  return {
    actionKey: l.action.key,
    actionLabel: l.action.label,
    authority: upper(l.value.authority),
    limit: money(l.value.limitMoney),
    limitValue: l.value.limitNumber ?? null,
    unit: upper(l.action.limit),
    needsSecondReviewer: l.needsSecondReviewer,
    secondReviewerAbove: money(l.value.secondReviewerAboveMoney),
    route: l.route,
    summary: l.summary,
  };
}

const coverageToGraphQL = (c: RoleCoverage) => ({ ...c, lead: staff(c.lead), backups: c.backups.map(staff), receivingNow: c.receivingNow.map(staff) });

/* ---------------------------------------------------------------- batching per request (one call per parent type and tick) */

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

const principalOf = (ctx: GraphQLContext): identity.Principal => {
  if (!ctx.principal) throw new AppError('UNAUTHORIZED', 'Staff sign-in required');
  return ctx.principal as identity.Principal;
};

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "access", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 */
export const resolvers = (service: AccessService): ModuleResolvers => {
  const forTarget = (type: string, alsoType?: string) => async (root: { id: string }, _args: unknown, ctx: GraphQLContext) => {
    const p = principalOf(ctx);
    let r = await load(ctx, `target:${type}`, root.id, (ids) => service.approvalForTargets(p, type, ids));
    if (!r && alsoType) r = await load(ctx, `target:${alsoType}`, root.id, (ids) => service.approvalForTargets(p, alsoType, ids));
    return r ? approvalToGraphQL(r) : null;
  };
  return {
    Query: {
      myApprovalLimit: async (_root, args: { actionKey: string }, ctx) => {
        try {
          return limitToGraphQL(await service.myLimitFor(principalOf(ctx), args.actionKey));
        } catch (err) {
          if (err instanceof AppError && err.code === 'UNKNOWN_APPROVAL_ACTION') return null;
          throw err;
        }
      },
      approvalsWaitingForMe: async (_root, args: { module?: string | null; actionKey?: string | null; overdue?: boolean | null; paging?: common.PageInput | null }, ctx) => {
        const page = await service.listApprovalsToDecide(
          principalOf(ctx),
          { ...(args.module ? { module: args.module } : {}), ...(args.actionKey ? { actionKey: args.actionKey } : {}), ...(args.overdue ? { overdue: true } : {}) },
          { ...(args.paging?.cursor ? { cursor: args.paging.cursor } : {}), ...(args.paging?.page ? { page: args.paging.page } : {}), ...(args.paging?.limit ? { limit: args.paging.limit } : {}) },
        );
        return { ...page, items: page.items.map(approvalToGraphQL) };
      },
      myApprovalSummary: async (_root, _args, ctx) => service.approvalSummaryFor(principalOf(ctx)),
      approvalRequest: async (_root, args: { id: string }, ctx) => {
        const r = await service.getApprovalForViewer(principalOf(ctx), args.id);
        return r ? approvalToGraphQL(r) : null;
      },
      teamOnShift: async (_root, args: { workArea?: string | null }) => (await service.coverageNow(args.workArea ? { workArea: args.workArea } : {})).map(coverageToGraphQL),
    },
    PayoutRun: { approvalRequest: forTarget('payout_run') },
    Hold: { approvalRequest: forTarget('hold') },
    RefundRequest: { approvalRequest: forTarget('refund_request', 'refund') },
    Seller: {
      pendingApprovals: async (root: { id: string }, _args: unknown, ctx: GraphQLContext) => {
        const p = principalOf(ctx);
        const list = await load(ctx, 'sellers', root.id, (ids) => service.approvalsForSellers(p, ids));
        return (list ?? []).map(approvalToGraphQL);
      },
    },
  };
};
