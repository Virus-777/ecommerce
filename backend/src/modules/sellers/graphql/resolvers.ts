import { AppError } from '../../../kernel/errors/index.js';
import { createBatchLoader, gqlActor, gqlDeadline, gqlEnum, type GraphQLContext, lazy, type ModuleResolvers, pageInput } from '../../../kernel/graphql/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { Appeal, ChangeRequest, PerformanceSummary, PerformanceTarget, Restriction, SellerSnapshot, SellerSummary, SellerWarning, VerificationLabel } from '../../../spec/sellers.js';
import * as map from '../mappers.js';
import type { SellerRec } from '../ports.js';
import type { SellersService } from '../service.js';
import { sellerPublicProfileOut } from './cards.js';

/* ---------------------------------------------------------------- REST shapes → GraphQL shapes (enums in capitals) */

const actor = gqlActor;
const timeline = (t: common.TimelineEvent) => ({ ...t, actor: actor(t.actor) });
const lower = (list: readonly string[] | null | undefined) => (list ?? []).map((s) => s.toLowerCase());

const verification = (v: VerificationLabel) => ({ ...v, state: gqlEnum(v.state) });
const target = (t: PerformanceTarget) => ({ ...t, metric: gqlEnum(t.metric), comparator: gqlEnum(t.comparator), unit: t.unit, category: null });
const warning = (w: SellerWarning) => ({ ...w, kind: gqlEnum(w.kind), issuedBy: actor(w.issuedBy) });
const performance = (p: PerformanceSummary) => ({
  from: p.period.from,
  to: p.period.to,
  orderCount: p.orderCount,
  overall: gqlEnum(p.overall),
  metrics: p.metrics.map((m) => ({ ...m, key: gqlEnum(m.key), status: gqlEnum(m.status), target: target(m.target) })),
  onTimeDispatchPct: p.metrics.find((m) => m.key === 'dispatch_reliability')?.value ?? null,
  warnings: p.warnings.map(warning),
  history: p.history.map(timeline),
  updatedAt: p.updatedAt,
});
const appeal = (a: Appeal) => {
  const d = a.decision as { outcome?: string; explanation?: string; changes?: string[]; decidedBy?: common.Actor; decidedAt?: string } | null;
  return {
    ...a,
    subject: gqlEnum(a.subject),
    state: gqlEnum(a.state),
    reviewer: actor(a.reviewer),
    originalDecider: actor(a.originalDecider),
    decideBy: gqlDeadline(a.decideBy),
    decision: d ? { outcome: d.outcome ?? '', explanation: d.explanation ?? '', changes: d.changes ?? [], decidedBy: actor(d.decidedBy), decidedAt: d.decidedAt } : null,
  };
};
const changeRequest = (c: ChangeRequest) => ({ ...c, state: gqlEnum(c.state), submittedBy: actor(c.submittedBy) });

/* ---------------------------------------------------------------- batching per request (one call per field and tick) */

const load = createBatchLoader();

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "sellers", …)` in graphql/schema.ts).
 * Seller objects carry their account fields as values or lazy functions (graphql's default resolver
 * calls a function property with the field's arguments), so only the fields a query asks for are loaded.
 */
export const resolvers = (service: SellersService): ModuleResolvers => {
  const { core, accounts, storefront, enforcement, performance: perf } = service;

  async function categoriesOf(ids: readonly string[] | null | undefined) {
    if (!ids?.length) return [];
    const tree = (await core.optional('catalog', 'categories', null, (c) => c.listCategories({ includeHidden: true }))) ?? [];
    const flat: Record<string, unknown>[] = [];
    const walk = (list: Record<string, unknown>[]) => list.forEach((c) => (flat.push({ filters: [], attributes: [], ...c }), walk((c.children ?? []) as Record<string, unknown>[])));
    walk(tree as unknown as Record<string, unknown>[]);
    return flat.filter((c) => ids.includes(c.id as string));
  }

  const restriction = (r: Restriction) => ({
    ...r,
    state: gqlEnum(r.state),
    reasonCode: gqlEnum(r.reasonCode),
    affectedActivities: r.affectedActivities.map(gqlEnum),
    scope: {
      wholeAccount: !r.scope.categoryIds?.length && !r.scope.conditions?.length && !r.scope.offerIds?.length && !r.scope.productIds?.length,
      categories: () => categoriesOf(r.scope.categoryIds),
      conditions: r.scope.conditions ?? [],
      offerIds: r.scope.offerIds ?? [],
      productIds: r.scope.productIds ?? [],
    },
    setBy: actor(r.setBy),
    recommendedBy: actor(r.recommendedBy),
    appeals: r.appeals.map(appeal),
  });

  /** Public card fields (every schema) plus lazy account fields (seller and admin schemas) */
  function seller(s: SellerRec, ctx: GraphQLContext, card?: SellerSummary) {
    const cardP = lazy(() => (card ? Promise.resolve(card) : storefront.cards([s]).then((c) => c[0]!)));
    const profile = lazy(() => storefront.profileOf(s.id));
    // the admin list row, built once for the fields below that come from it
    const row = lazy(() => accounts.sellerRows([s], { canSeeBalances: false }).then((r) => r[0]));
    const staff = ctx.principal?.kind === 'staff';
    return {
      id: s.id,
      ref: s.ref,
      slug: s.slug,
      storeName: s.store_name,
      logo: async () => (await cardP()).logo ?? null,
      location: async () => (await cardP()).location ?? null,
      verified: s.verification_state === 'verified',
      dispatchLabel: async () => (await cardP()).dispatchLabel ?? null,
      sellingSince: s.approved_at ? core.today(s.approved_at) : null,
      sellingNow: accounts.canSellNew(s),
      publicProfile: async () => {
        const p = await profile();
        const sf = PUBLIC.includes(s.status) && s.approved_at ? await storefront.storefront(s) : null;
        // the shared mapper other modules use too (contract.ts: sellerPublicProfileOut)
        return sellerPublicProfileOut({ sellerId: s.id, storefront: sf, verification: map.verificationLabel(s), tagline: p.tagline, introduction: p.introduction, warranty: p.warranty });
      },
      legalName: s.legal_name,
      status: gqlEnum(s.status),
      statusSince: map.isoReq(s.status_since),
      canSellNew: accounts.canSellNew(s),
      launchReady: accounts.launchReady(s),
      verification: verification(map.verificationLabel(s)),
      payoutReadiness: async () => {
        const p = await accounts.getPayoutAccount(s.id);
        return { ...p.readiness, state: gqlEnum(p.readiness.state) };
      },
      pendingAgreements: async () => (await accounts.pendingAgreements(s.id)).length,
      accountManager: async () => {
        const m = await accounts.accountManager(s);
        return m ? { name: m.name, replyTarget: m.replyTarget } : null;
      },
      performance: async () => performance(await perf.getPerformance(s.id)),
      restrictions: async (args: { states?: string[] | null }) => {
        const states = args?.states?.length ? lower(args.states) : ['pending_approval', 'active'];
        const list = await enforcement.restrictionsFor(s.id, states);
        return (staff ? list : list.map((r) => ({ ...r, approval: null, trustReportId: null }))).map(restriction);
      },
      appeals: async (args: { states?: string[] | null }) => (await enforcement.appealsFor(s.id, args?.states?.length ? lower(args.states) : undefined)).map(appeal),
      changeRequests: async (args: { states?: string[] | null }) => {
        const p = await storefront.listOwnChangeRequests(s.id, undefined, { mode: 'page', page: 1, limit: 100 });
        const states = args?.states?.length ? lower(args.states) : null;
        return p.items.filter((c) => !states || states.includes(c.state)).map(changeRequest);
      },
      business: async () => {
        if (!staff) {
          const access = ctx.auth?.sellerAccess;
          if (!access || (!access.isOwner && !access.permissions.includes('sellers.account.manage'))) return null;
        }
        const b = await accounts.getBusinessDetails(s.id);
        return { ...b, contact: b.contact ?? { name: '' } };
      },
      membership: () => {
        const a = ctx.auth?.sellerAccess;
        return a && ctx.principal?.sellerId === s.id ? { memberId: a.memberId, role: a.role, permissions: a.permissions, isOwner: a.isOwner } : null;
      },
      owner: async () => {
        const o = await service.members.ownerOf(s.id);
        const c = (s.contact ?? {}) as { name?: string; email?: string; phone?: string; supportHours?: string };
        return { name: o?.name ?? c.name ?? '', email: o?.email ?? c.email ?? null, phone: c.phone ?? null, supportHours: c.supportHours ?? null };
      },
      mainCategory: async () => (await row())?.mainCategory ?? null,
      restrictionSummary: async () => (await row())?.restrictionSummary ?? null,
      warningNote: async () => (await row())?.warningNote ?? null,
      notes: async () => (await core.repo.find('seller_notes', { seller_id: s.id }, { orderBy: [['created_at', 'desc']] })).map(map.note).map((n) => ({ ...n, author: actor(n.author) })),
      history: async () => (await perf.history(s.id, true)).map(timeline),
    };
  }

  const PUBLIC = ['approved', 'restricted', 'suspended'];

  const sellersById = (ctx: GraphQLContext, id: string) => load(ctx, 'sellers', id, async (ids) => new Map((await core.repo.getMany('sellers', ids.filter(isUuid))).map((s) => [s.id, s])));

  return {
    Offer: {
      seller: async (root: { sellerId?: string | null; ownerType?: string }, _args: unknown, ctx: GraphQLContext) => {
        if (!root.sellerId || root.ownerType === 'official') return null;
        const card = await load(ctx, 'cards', root.sellerId, async (ids) => new Map((await service.getStorefrontCard(ids)).map((c) => [c.id, c])));
        if (!card) return null;
        const s = await sellersById(ctx, root.sellerId);
        return s ? seller(s, ctx, card) : null;
      },
    },
    Product: {
      ownerSeller: async (root: { ownerSellerId?: string | null }, _args: unknown, ctx: GraphQLContext) => {
        if (!root.ownerSellerId) return null;
        const snap = await load(ctx, 'snapshots', root.ownerSellerId, async (ids) => new Map((await service.getSellers(ids)).map((x: SellerSnapshot) => [x.id, x])));
        if (!snap) return null;
        const s = await sellersById(ctx, root.ownerSellerId);
        return s ? seller(s, ctx) : null;
      },
    },
    Query: {
      sellerStorefront: async (_root, args: { slug: string }, ctx) => {
        const sf = await service.getStorefrontBySlug(args.slug);
        if (!sf) return null;
        const s = await core.repo.sellerBySlug(args.slug);
        return s ? seller(s, ctx, sf.seller) : null;
      },
      mySeller: async (_root, _args, ctx) => {
        const id = ctx.principal?.sellerId;
        if (!id) throw new AppError('UNAUTHORIZED', 'Choose the seller account to act for');
        if (!(await service.getSeller(id))) return null;
        return seller((await core.repo.get('sellers', id))!, ctx);
      },
      sellerAdmin: async (_root, args: { id: string }, ctx) => {
        if (!(await service.getSeller(args.id))) return null;
        return seller((await core.repo.get('sellers', args.id))!, ctx);
      },
      sellers: async (_root, args: { filter?: { search?: string | null; statuses?: string[] | null; verified?: boolean | null; dispatchBelowPct?: number | null; mainCategoryId?: string | null } | null; paging?: common.PageInput | null }, ctx) => {
        const f = args.filter ?? {};
        const page = await service.searchSellers(
          {
            ...(f.search ? { search: f.search } : {}),
            ...(f.statuses?.length ? { statuses: lower(f.statuses) } : {}),
            ...(f.verified !== undefined && f.verified !== null ? { verified: f.verified } : {}),
            ...(f.dispatchBelowPct !== undefined && f.dispatchBelowPct !== null ? { dispatchBelowPct: f.dispatchBelowPct } : {}),
            ...(f.mainCategoryId ? { mainCategoryId: f.mainCategoryId } : {}),
          },
          pageInput(args.paging),
        );
        const rows = new Map((await core.repo.getMany('sellers', page.items.map((x) => x.id))).map((s) => [s.id, s]));
        return { ...page, items: page.items.map((x) => seller(rows.get(x.id)!, ctx)) };
      },
    },
  };
};
