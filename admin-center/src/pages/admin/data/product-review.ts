import { initials } from '@marketly/web-shared/lib/format';
import type { components } from '@marketly/web-shared/api';
import type { IconName } from '@marketly/web-shared/ui';

// Admin review queue (design: pages/admin/admin-product-review.html). The queue is REST
// GET /api/admin/catalog/review-queue; the open submission is the AdminProductReview screen query.

export type QueueItem = components['schemas']['catalog.ProductAdmin'];
export type Decision = 'approve' | 'changes' | 'reject';
export type SubmissionKind = 'new' | 'content_change' | 'resubmitted';

export const DECISION_API: Record<Decision, 'approve' | 'request_changes' | 'reject'> = { approve: 'approve', changes: 'request_changes', reject: 'reject' };
export const DECISION_FROM_API: Record<string, Decision> = { approve: 'approve', request_changes: 'changes', reject: 'reject' };

/** Reviewer vocabulary for the reason select (the API takes the reason as text). */
export const REASONS = ['Misleading or prohibited claims', 'Duplicate of an existing product', 'Images do not meet standards', 'Wrong category', 'Missing required information'];
/** Fields a reviewer can comment on (keys of request-changes `fields`). */
export const COMMENT_FIELDS = ['Title', 'Description', 'Images', 'Category', 'Attributes', 'Warranty', 'Identifiers'];

export const REVIEW_STATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  rejected: 'Rejected',
};

/** The AdminProductReview fields this screen reads (GraphQL enums arrive in capitals). */
export interface ReviewScreen {
  productAdmin: {
    id: string;
    ref: string | null;
    title: string;
    brand: { name: string } | null;
    category: { id: string; name: string } | null;
    categoryPath: string[] | null;
    modelNumber: string | null;
    description: string | null;
    keyFeatures: string[] | null;
    specs: Array<{ name: string; value: string }> | null;
    images: Array<{ id: string; url: string; alt: string | null; width: number | null; height: number | null }>;
    variants: Array<{ id: string; gtin: string | null; options: Array<{ name: string; value: string }> }>;
    reviewState: string;
    publication: string;
    missing: string[] | null;
    submission: {
      id: string;
      ref: string;
      kind: string;
      state: string;
      note: string | null;
      submittedAt: string;
      submittedBy: { kind: string; name: string | null } | null;
      lastSavedAt: string | null;
      lastSavedBy: { name: string | null } | null;
      reviewDeadline: { dueAt: string; state: string } | null;
      assignee: { name: string | null } | null;
    } | null;
    checks: Array<{
      kind: string;
      result: string;
      message: string;
      details: string[] | null;
      ranAt: string;
      evidence: Array<{ label: string; field: string | null; text: string | null; score: number | null; matchedProduct: { id: string; ref: string | null; title: string } | null }> | null;
      dismissal: { reason: string; at: string; by: { name: string | null } | null } | null;
    }>;
    reviewDraft: { decision: string | null; reason: string | null; fields: Array<{ name: string; value: string }> | null; savedAt: string; savedBy: { name: string | null } | null } | null;
    owner: { type: string; sellerId: string | null } | null;
    ownerSeller: { id: string; storeName: string; verified: boolean } | null;
    duplicateCandidates: Array<{
      id: string;
      ref: string | null;
      title: string;
      brand: { name: string } | null;
      categoryPath: string[] | null;
      modelNumber: string | null;
      images: Array<{ url: string }> | null;
      variants: Array<{ options: Array<{ name: string; value: string }> }> | null;
      offerCount: number | null;
      reviewSummary: { ratingCount: number; average: number | null } | null;
      updatedAt: string | null;
    }>;
    reviewLog: Array<{ action: string; reason: string | null; fields: Array<{ name: string; value: string }> | null; actor: { kind: string; name: string | null } | null; at: string }>;
  } | null;
  offersAdmin: {
    items: Array<{ id: string; sellerName: string | null; conditionLabel: string | null; price: { formatted: string } | null; dispatch: { label: string } | null; stock: { quantities: { available: number } | null } | null; status: string }>;
  } | null;
}
export type ReviewProduct = NonNullable<ReviewScreen['productAdmin']>;
export type ReviewCheck = ReviewProduct['checks'][number];

const CHECK_META: Record<string, { icon: IconName; title: string }> = {
  duplicate: { icon: 'copy', title: 'Duplicates' },
  image_standard: { icon: 'image', title: 'Image standards' },
  category_fit: { icon: 'folder-tree', title: 'Category fit' },
  prohibited_claim: { icon: 'ban', title: 'Prohibited claims' },
  brand_authorization: { icon: 'shield-check', title: 'Brand authorization' },
  restricted_item: { icon: 'shield-alert', title: 'Restricted items and safety' },
  identifier: { icon: 'scan-barcode', title: 'Identifiers' },
};

/** A check as the design's check row shows it. */
export function checkView(c: ReviewCheck) {
  const kind = c.kind.toLowerCase();
  const result = c.result.toLowerCase();
  const meta = CHECK_META[kind] ?? { icon: 'circle-check' as IconName, title: kind };
  const dismissed = !!c.dismissal;
  const tone: 'danger' | 'warning' | 'success' = dismissed || result === 'pass' ? 'success' : result === 'fail' ? 'danger' : 'warning';
  const badge = dismissed ? (kind === 'duplicate' ? 'Not a duplicate' : 'Dismissed') : result === 'fail' ? 'Blocking' : result === 'warn' ? 'Needs fix' : 'Passed';
  const evidence = (c.evidence ?? []).map((e) => [e.label, e.text].filter(Boolean).join(': ')).filter(Boolean);
  const details = c.details?.length ? c.details : evidence;
  const body: string | string[] = dismissed
    ? `Marked not applicable${c.dismissal?.by?.name ? ` by ${c.dismissal.by.name}` : ''}: ${c.dismissal?.reason ?? ''}`
    : details.length > 1
      ? details
      : details[0] ?? c.message;
  return { kind, icon: meta.icon, title: result === 'pass' || dismissed ? meta.title : `${meta.title}: ${c.message}`, tone, badge, body };
}

export const LOG_LABEL: Record<string, string> = {
  submitted: 'Submitted for review',
  approved: 'Approved and published',
  changes_requested: 'Changes requested',
  rejected: 'Rejected',
  publication_changed: 'Publication changed',
  merged: 'Merged',
  check_dismissed: 'Check marked not applicable',
  correction_accepted: 'Correction accepted',
  variant_details_changed: 'Variant details changed',
};

export { initials };
