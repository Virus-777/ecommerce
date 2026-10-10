/** Rows (snake_case) to API types (camelCase), in one place per type. */
import type * as common from '../../spec/common.js';
import type {
  Attribute,
  Brand,
  BrandAdmin,
  CorrectionSuggestion,
  ImageRule,
  ProductCheck,
  ProductCheckEvidence,
  ReviewDraft,
  ReviewLogEntry,
  Submission,
} from '../../spec/catalog.js';
import { deadlineState } from './domain/rules.js';
import type { AttributeRow, AuthorizedSellerRow, BrandRow, CheckDismissalRow, CheckRow, CorrectionRow, ReviewDraftRow, ReviewLogRow, SubmissionRow } from './ports.js';

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => x != null).map(String) : []);
export const stringMap = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x != null).map(([k, x]) => [k, String(x)])) : {};

export function toAttribute(r: AttributeRow): Attribute {
  return {
    id: r.id,
    categoryId: r.category_id,
    name: r.name,
    kind: r.kind as Attribute['kind'],
    unit: r.unit,
    options: strings(r.options),
    required: r.required,
    filterable: r.filterable,
    variantDefining: r.variant_defining,
  };
}

export const imageRulesOfRow = (rules: unknown): ImageRule[] =>
  Array.isArray(rules)
    ? rules
        .filter((r) => r && typeof r === 'object' && typeof (r as ImageRule).text === 'string')
        .map((r) => ({ text: (r as ImageRule).text, severity: (r as ImageRule).severity === 'warning' ? 'warning' : 'blocking', check: (r as ImageRule).check ?? null }))
    : [];

export function toBrand(r: BrandRow, productCount: number, refs: Map<string, common.MediaRef>): Brand {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    logo: (r.logo_media_id && refs.get(r.logo_media_id)) || null,
    description: r.description,
    productCount,
    banner: (r.banner_media_id && refs.get(r.banner_media_id)) || null,
    status: r.status as Brand['status'],
  };
}

export function toBrandAdmin(
  r: BrandRow,
  extra: { brand: Brand; authorized: AuthorizedSellerRow[]; productCount: number; offerCount: number; sellerCount: number; liveProducts: number },
): BrandAdmin {
  return {
    brand: extra.brand,
    status: r.status,
    statusReason: r.status_reason,
    flagNote: r.flag_note,
    trustReportId: r.trust_report_id,
    sellingPolicy: r.selling_policy,
    authorizedSellerIds: extra.authorized.map((a) => a.seller_id),
    productCount: extra.productCount,
    offerCount: extra.offerCount,
    sellerCount: extra.sellerCount,
    pageLive: r.status === 'active' && extra.liveProducts > 0,
    requestedBy: r.requested_by_seller_id
      ? {
          sellerId: r.requested_by_seller_id,
          productId: r.requested_for_product_id,
          submissionId: null,
          changeRequestId: r.requested_change_request_id,
          at: r.created_at.toISOString(),
        }
      : null,
    updatedAt: r.updated_at.toISOString(),
  };
}

const actorOf = (v: unknown): common.Actor => {
  const a = (v ?? {}) as common.Actor;
  return { kind: a.kind ?? 'system', ...(a.id != null ? { id: a.id } : {}), ...(a.name != null ? { name: a.name } : {}) };
};

/** Actions shown in the product history (every action catalog logs) */
export const LOG_ACTIONS: readonly ReviewLogEntry['action'][] = [
  'submitted',
  'approved',
  'changes_requested',
  'rejected',
  'publication_changed',
  'merged',
  'check_dismissed',
  'correction_accepted',
  'variant_details_changed',
];

export function toLogEntry(r: ReviewLogRow): ReviewLogEntry {
  return {
    id: r.id,
    action: r.action as ReviewLogEntry['action'],
    reason: r.reason,
    fields: stringMap(r.fields),
    actor: { kind: r.actor_kind as common.Actor['kind'], ...(r.actor_id ? { id: r.actor_id } : {}) },
    at: r.at.toISOString(),
  };
}

export function toSubmission(r: SubmissionRow, now: Date, opts: { staff: boolean }): Submission {
  return {
    id: r.id,
    ref: r.ref,
    productId: r.product_id,
    kind: r.kind,
    state: r.state,
    version: r.product_version,
    submittedAt: r.submitted_at.toISOString(),
    submittedBy: actorOf(r.submitted_by),
    lastSavedAt: iso(r.last_saved_at),
    lastSavedBy: r.last_saved_by ? actorOf(r.last_saved_by) : null,
    expectedReviewBy: iso(r.expected_review_by),
    reviewDeadline: r.review_due_at && r.state === 'open' ? { dueAt: r.review_due_at.toISOString(), state: deadlineState(r.review_due_at, now) } : null,
    pausedAt: r.state === 'open' ? iso(r.paused_at) : null,
    assignee: opts.staff && r.assignee_staff_id ? { kind: 'staff', id: r.assignee_staff_id, ...(r.assignee_name ? { name: r.assignee_name } : {}) } : null,
    decidedAt: iso(r.decided_at),
    note: r.note,
  };
}

/** Evidence as stored on the check (per-candidate dismissals live in check_dismissals) */
export const evidenceOf = (v: unknown): ProductCheckEvidence[] => (Array.isArray(v) ? (v as ProductCheckEvidence[]) : []);

/** `dismissals`: the check's check_dismissals rows (duplicate candidates marked not a duplicate) */
export function toCheck(r: CheckRow, dismissals: CheckDismissalRow[] = []): ProductCheck {
  const dismissedBy = r.dismissed_by ? actorOf(r.dismissed_by) : null;
  const dismissedAt = new Map(dismissals.filter((d) => d.check_id === r.id).map((d) => [d.matched_product_id, d.dismissed_at.toISOString()]));
  return {
    kind: r.kind as ProductCheck['kind'],
    result: r.result,
    message: r.message,
    details: strings(r.details),
    evidence: evidenceOf(r.evidence).map((e) => ({
      label: e.label,
      field: e.field ?? null,
      text: e.text ?? null,
      score: e.score ?? null,
      matchedProductId: e.matchedProductId ?? null,
      mediaId: e.mediaId ?? null,
      suggestedCategoryId: e.suggestedCategoryId ?? null,
      dismissedAt: e.matchedProductId ? (dismissedAt.get(e.matchedProductId) ?? null) : null,
    })),
    ranAt: r.ran_at.toISOString(),
    dismissal:
      r.dismissed_at && dismissedBy
        ? { reason: r.dismiss_reason ?? '', matchedProductId: r.dismissed_matched_product_id, by: dismissedBy, at: r.dismissed_at.toISOString() }
        : null,
  };
}

export function toReviewDraft(r: ReviewDraftRow, savedBy: common.Actor): ReviewDraft {
  return {
    submissionId: r.submission_id,
    decision: (r.decision as ReviewDraft['decision']) ?? null,
    reason: r.reason,
    fields: stringMap(r.fields),
    savedBy,
    savedAt: r.saved_at.toISOString(),
  };
}

export function toCorrection(r: CorrectionRow, refs: Map<string, common.MediaRef>): CorrectionSuggestion {
  return {
    id: r.id,
    productId: r.product_id,
    sellerId: r.seller_id,
    field: r.field,
    current: r.current,
    proposed: r.proposed,
    evidence: strings(r.evidence_media_ids).flatMap((id) => (refs.has(id) ? [refs.get(id)!] : [])),
    state: r.state as CorrectionSuggestion['state'],
    decisionReason: r.decision_reason,
    createdAt: r.created_at.toISOString(),
  };
}
