/**
 * Rows (snake_case) → domain models and API types (camelCase), in one place per type.
 */
import type * as common from '../../spec/common.js';
import type { CampaignLogEntry, CampaignSummary, CouponCode, DealsPlacement, DiscountRule, Eligibility, FundingReview, ParticipationSettings, Redemption, ReviewCheck, SchedulePeriod, Scope, StackingRules, TargetRef } from '../../spec/promotions.js';
import { fundingLabel, m, periodDisplay, type CampaignModel, type Kind, type Status } from './domain/rules.js';
import type { CampaignRec, CodeRec, FundingReviewRec, LogRec, RedemptionRec, TargetRec } from './ports.js';


export const iso = (d: Date | string) => new Date(d).toISOString();
export const isoOrNull = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export function encodeActor(a: common.Actor): string {
  return JSON.stringify({ kind: a.kind, id: a.id ?? null, ...(a.name ? { name: a.name } : {}) });
}

export function decodeActor(s: string | null | undefined): common.Actor {
  if (!s) return { kind: 'system', id: null };
  try {
    const v = JSON.parse(s) as common.Actor;
    if (v && typeof v === 'object' && typeof v.kind === 'string') return { kind: v.kind, id: v.id ?? null, ...(v.name ? { name: v.name } : {}) };
  } catch {
    /* plain id */
  }
  return { kind: 'staff', id: s };
}

export function scopeOf(mode: string, targets: readonly TargetRec[]): Scope {
  const ref = (t: TargetRec): TargetRef => ({ kind: t.kind as TargetRef['kind'], id: t.target_id, label: t.label });
  return { mode: mode as Scope['mode'], include: targets.filter((t) => !t.excluded).map(ref), exclude: targets.filter((t) => t.excluded).map(ref) };
}

/** campaigns.deals holds the Deals placement (the funding note has its own column, funding_note, since pass 4) */
export const dealsOf = (row: Pick<CampaignRec, 'deals'>): DealsPlacement | null => (row.deals as unknown as DealsPlacement | null) ?? null;

/** The shared code of a campaign (latest shared row) */
export const sharedCodeOf = (codes: readonly CodeRec[]) => codes.filter((c) => c.kind === 'shared').sort((a, b) => Number(b.active) - Number(a.active) || +new Date(b.created_at) - +new Date(a.created_at))[0]?.code ?? null;

export function toModel(row: CampaignRec, targets: readonly TargetRec[], codes: readonly CodeRec[] = []): CampaignModel {
  const cur = row.currency;
  return {
    id: row.id,
    ref: row.ref,
    name: row.name,
    description: row.description,
    ownerKind: row.owner_kind,
    sellerId: row.seller_id,
    kind: row.kind as Kind,
    discount: row.discount as unknown as DiscountRule,
    code: sharedCodeOf(codes),
    autoApply: row.auto_apply,
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    timeZone: row.time_zone,
    scope: scopeOf(row.scope_mode, targets),
    eligibility: row.eligibility as unknown as Eligibility,
    limits: {
      budget: row.budget_amount !== null ? m(row.budget_amount, cur) : null,
      usageCap: row.usage_cap,
      perCustomer: row.per_customer,
      perOrder: row.per_order,
      perCustomerUnits: row.per_customer_units,
    },
    funding: { owner: row.funding_owner as 'platform' | 'seller' | 'shared', platformShareBps: row.platform_share_bps, costCenter: row.cost_center, note: row.funding_note },
    stacking: { ...(row.stacking as unknown as StackingRules), exclusiveGroup: row.exclusive_group },
    participation: (row.participation as unknown as ParticipationSettings | null) ?? null,
    deals: dealsOf(row),
    terms: row.terms,
    status: row.status as Status,
    budgetUsed: row.budget_used,
    usageCount: row.usage_count,
    currency: cur,
    hasUniqueCodes: codes.some((c) => c.kind === 'unique'),
  };
}

export const periodOf = (c: Pick<CampaignModel, 'startsAt' | 'endsAt' | 'timeZone'>): SchedulePeriod => ({
  startsAt: c.startsAt.toISOString(),
  endsAt: c.endsAt.toISOString(),
  timeZone: c.timeZone,
  display: periodDisplay(c.startsAt, c.endsAt, c.timeZone),
});

/** Next step in words for the campaign list */
export function nextAction(c: CampaignModel, review: FundingReviewRec | undefined): string | null {
  switch (c.status) {
    case 'draft':
      return c.ownerKind === 'seller' ? 'Schedule to publish' : 'Send to Finance';
    case 'in_review':
      return review?.approval_request_id ? 'Waiting for approval' : 'Waiting for Finance';
    case 'changes_requested':
      return 'Changes requested by Finance';
    case 'approved':
      return 'Ready to schedule';
    case 'scheduled':
      return 'Starts automatically';
    case 'paused':
      return 'Paused: resume or end';
    default:
      return null;
  }
}

export function toSummary(c: CampaignModel, review: FundingReviewRec | undefined): CampaignSummary {
  return {
    id: c.id,
    ref: c.ref,
    name: c.name,
    description: c.description,
    kind: c.kind,
    code: c.code,
    period: periodOf(c),
    ownerKind: c.ownerKind,
    sellerId: c.sellerId,
    fundingOwner: c.funding.owner,
    fundingLabel: fundingLabel(c.funding),
    budget: c.limits.budget ?? null,
    budgetUsed: m(c.budgetUsed, c.currency),
    usageCap: c.limits.usageCap ?? null,
    redemptions: c.usageCount,
    status: c.status,
    nextAction: nextAction(c, review),
  };
}

const REVIEW_STATES = new Set(['not_sent', 'waiting', 'confirmed', 'changes_requested']);

export function toFundingReview(r: FundingReviewRec, currency: string, reviewer: common.Actor | null, approval: common.ApprovalInfo | null): FundingReview {
  return {
    state: (REVIEW_STATES.has(r.state) ? r.state : 'not_sent') as FundingReview['state'],
    sentAt: isoOrNull(r.sent_at),
    reviewer,
    decidedAt: isoOrNull(r.decided_at),
    checks: (r.checks as unknown as ReviewCheck[]) ?? [],
    platformMaximum: m(r.platform_max, currency),
    sellersMaximum: m(r.sellers_max, currency),
    expectedSales: r.expected_sales !== null ? m(r.expected_sales, currency) : null,
    officialMarginImpactPts: r.margin_impact_pts !== null ? Number(r.margin_impact_pts) : null,
    costCenter: null,
    costCenterRemaining: null,
    comment: r.comment,
    approval,
  };
}

export const toCode = (c: CodeRec): CouponCode => ({
  id: c.id,
  campaignId: c.campaign_id,
  code: c.code,
  kind: c.kind,
  maxRedemptions: c.max_redemptions,
  redemptions: c.redemptions,
  active: c.active,
  assignedCustomerId: c.assigned_customer_id,
  createdAt: iso(c.created_at),
});

export function toRedemption(r: RedemptionRec, o: { code: string | null; orderRef: string | null; items: number }): Redemption {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    code: o.code,
    orderId: r.order_id,
    orderRef: o.orderRef,
    customer: r.customer_id ? { kind: 'customer', id: r.customer_id } : r.guest_key ? { kind: 'visitor', id: null } : null,
    state: r.state as Redemption['state'],
    discount: { total: m(r.amount, r.currency), platform: m(r.platform_part, r.currency), seller: m(r.seller_part, r.currency) },
    reversed: m(r.reversed, r.currency),
    items: o.items,
    at: iso(r.created_at),
  };
}

export const toLogEntry = (l: LogRec): CampaignLogEntry => ({
  id: l.id,
  action: l.action,
  reason: l.reason,
  detail: l.detail ?? null,
  actor: { kind: l.actor_kind as common.Actor['kind'], id: l.actor_id },
  at: iso(l.at),
});
