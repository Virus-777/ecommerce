import { createBatchLoader, gqlActor, gqlDeadline, gqlEnum, type GraphQLContext, type ModuleResolvers, pageInput } from '../../../kernel/graphql/index.js';
import type * as common from '../../../spec/common.js';
import type { Enforcement, TrustReport } from '../../../spec/trust.js';
import type { TrustService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "trust", …)` in graphql/schema.ts).
 * Admin Center only (the fields carry @auth); reports come as summaries, never with reporter identity, evidence or
 * notes. REST shapes are mapped to the GraphQL shapes (enums in capitals, Actor kinds).
 */

const lower = (s: string | null | undefined) => (s ? s.toLowerCase() : undefined);
const actor = gqlActor;

const enforcement = (e: Enforcement) => ({
  id: e.id,
  ref: e.ref,
  action: e.action,
  ownerTeam: e.ownerTeam,
  reason: e.reason,
  effects: e.effects,
  recordedBy: actor(e.recordedBy),
  recordedAt: e.recordedAt,
  executionState: gqlEnum(e.executionState),
  appliedRef: e.appliedRef ?? null,
  appealable: e.appealable,
  appealDeadline: e.appealDeadline ?? null,
  reversedAt: e.reversedAt ?? null,
});

export function gqlReport(r: TrustReport) {
  const res = (r.resolution ?? null) as { outcome?: string; summary?: string; decidedBy?: common.Actor; decidedAt?: string } | null;
  const recs = r.recommendations;
  return {
    id: r.id,
    ref: r.ref,
    type: gqlEnum(r.type),
    title: r.title,
    description: r.description,
    source: gqlEnum(r.source),
    reporterCount: r.reporterCount,
    subjects: r.subjects.map((s) => ({ type: gqlEnum(s.type), id: s.id, ref: s.ref ?? null, label: s.label, statusLabel: s.statusLabel ?? null, screen: s.screen ?? null })),
    status: gqlEnum(r.status),
    riskScore: r.riskScore,
    riskLevel: gqlEnum(r.riskLevel),
    assignee: r.assignee ? { kind: 'STAFF', id: r.assignee.staffId, name: r.assignee.name } : null,
    deadline: gqlDeadline(r.deadline),
    recommendations: {
      total: recs.length,
      pending: recs.filter((x) => x.state === 'pending').length,
      sentToOwner: recs.filter((x) => x.state === 'sent_to_owner').length,
      completed: recs.filter((x) => x.state === 'completed').length,
      declined: recs.filter((x) => x.state === 'declined').length,
    },
    enforcements: r.enforcements.map(enforcement),
    linkedCaseRefs: r.linkedCaseRefs,
    resolution: res && res.outcome ? { outcome: res.outcome, summary: res.summary ?? '', decidedBy: actor(res.decidedBy) ?? { kind: 'SYSTEM', id: null, name: null }, decidedAt: res.decidedAt ?? r.updatedAt } : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/* ---------------------------------------------------------------- batching per request (one call per field and tick) */

const load = createBatchLoader();

export const resolvers = (service: TrustService): ModuleResolvers => {
  const counts = (type: 'customer' | 'seller') => async (parent: { id?: string }) => {
    if (!parent?.id) return null;
    const c = await service.reportsAbout(type, parent.id);
    return { filedBy: c.filedBy, against: c.against, open: c.open };
  };
  const reports =
    (type: 'customer' | 'seller') =>
    async (parent: { id?: string }, args: { role?: string | null; statuses?: string[] | null; paging?: common.PageInput | null }) => {
      if (!parent?.id) return null;
      const role = lower(args.role) as 'filed_by' | 'against' | undefined;
      const statuses = args.statuses?.map((s) => s.toLowerCase());
      const page = await service.listReportsAbout(type, parent.id, { ...(role ? { role } : {}), ...(statuses?.length ? { statuses } : {}) }, pageInput(args.paging));
      return { ...page, items: page.items.map(gqlReport) };
    };
  const behind = async (parent: { trustReportId?: string | null }, _args: unknown, ctx: GraphQLContext) => {
    if (!parent?.trustReportId) return null;
    const r = await load(ctx, 'trust.reportSummaries', parent.trustReportId, async (ids) => new Map((await service.getReportSummaries(ids)).map((x) => [x.id, x])));
    return r ? gqlReport(r) : null;
  };
  return {
    Customer: { trustReportCounts: counts('customer'), trustReports: reports('customer') },
    Seller: { trustReportCounts: counts('seller'), trustReports: reports('seller') },
    SellerRestriction: { trustReport: behind },
    CustomerRestriction: { trustReport: behind },
  };
};
