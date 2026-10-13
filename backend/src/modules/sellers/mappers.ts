/** Row (snake_case) → API type (camelCase) mapping, in one place per type. */
import type * as common from '../../spec/common.js';
import type {
  AgreementAcceptance,
  Appeal,
  ApplicationDocument,
  ChangeRequest,
  FeaturedCollection,
  InformationRequest,
  InfoRequestItem,
  LaunchReview,
  PayoutReadiness,
  PendingStaffChange,
  PerformanceTarget,
  PublicClaim,
  Restriction,
  RestrictionScope,
  RiskReview,
  SellerInvitation,
  SellerMember,
  SellerNote,
  SellerWarning,
  VerificationCheck,
  VerificationLabel,
} from '../../spec/sellers.js';
import { NOT_CHECKED, targetDisplay } from './domain/catalogue.js';
import { deadline, normalizeScope, type StoredPayout } from './domain/rules.js';
import type {
  AcceptanceRec,
  AccountEventRec,
  AppealRec,
  ChangeRequestRec,
  CheckRec,
  ClaimRec,
  CollectionRec,
  DocumentRec,
  InfoRequestRec,
  InvitationRec,
  MemberRec,
  NoteRec,
  PendingChangeRec,
  RestrictionRec,
  RiskReviewRec,
  SellerRec,
  TargetRec,
  WarningRec,
} from './ports.js';

export const iso = (d: Date | string | null | undefined): string | null => (d ? (typeof d === 'string' ? new Date(d).toISOString() : d.toISOString()) : null);
export const isoReq = (d: Date | string) => iso(d)!;

/** A staff change waiting for a second reviewer (pending_changes) */
export const pendingStaffChange = (r: PendingChangeRec): PendingStaffChange => ({
  id: r.id,
  kind: r.kind as PendingStaffChange['kind'],
  state: r.state as PendingStaffChange['state'],
  approvalRequestId: r.approval_request_id,
  proposed: r.payload,
  reason: r.reason,
  requestedBy: (r.requested_by ?? { kind: 'system', id: null }) as unknown as common.Actor,
  requestedAt: isoReq(r.requested_at),
  decidedAt: iso(r.decided_at),
});

/** Actors live in text columns as JSON */
export const actorText = (a: common.Actor): string => JSON.stringify({ kind: a.kind, id: a.id ?? null, ...(a.name ? { name: a.name } : {}) });
export function actorOf(s: string | null | undefined): common.Actor | null {
  if (!s) return null;
  try {
    const a = JSON.parse(s);
    if (a && typeof a === 'object' && typeof a.kind === 'string') return { kind: a.kind, id: a.id ?? null, ...(a.name ? { name: a.name } : {}) };
  } catch {
    /* plain id */
  }
  return { kind: 'system', id: s };
}
export const actorReq = (s: string | null | undefined): common.Actor => actorOf(s) ?? { kind: 'system', id: null };
/** The id of an actor stored as text (for "never the original decider" checks) */
export const actorIdOf = (s: string | null | undefined) => actorOf(s)?.id ?? null;

export type Refs = (id: string | null | undefined) => common.MediaRef | null;
export const refList = (refs: Refs, ids: unknown): common.MediaRef[] => (Array.isArray(ids) ? ids.map((i) => refs(String(i))).filter((r): r is common.MediaRef => Boolean(r)) : []);
export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/* ------------------------------------------------------------------ seller account pieces */

interface StoredLabel {
  checked?: string[];
  reason?: string | null;
}

export function verificationLabel(s: SellerRec): VerificationLabel {
  const v = (s.verification_checked ?? {}) as StoredLabel;
  return {
    state: s.verification_state as VerificationLabel['state'],
    checked: v.checked ?? [],
    notChecked: NOT_CHECKED,
    lastCheckedAt: iso(s.verified_at),
    expiresAt: iso(s.verification_expires_at),
    reason: v.reason ?? null,
  };
}

/** sellers.launch_review: the LaunchReview plus the first product submission (setup checklist) */
export interface StoredLaunchReview {
  state: LaunchReview['state'];
  requestedAt?: string | null;
  decidedAt?: string | null;
  decidedBy?: common.Actor | null;
  issues?: string[];
  note?: string | null;
  firstSubmittedAt?: string | null;
  lastProductEventAt?: string | null;
}

export const storedLaunch = (s: SellerRec): StoredLaunchReview => ({ state: 'not_started', issues: [], ...((s.launch_review ?? {}) as object) }) as StoredLaunchReview;

export function launchReview(s: SellerRec): LaunchReview {
  const l = storedLaunch(s);
  return { state: l.state, requestedAt: l.requestedAt ?? null, decidedAt: l.decidedAt ?? null, decidedBy: l.decidedBy ?? null, issues: l.issues ?? [], note: l.note ?? null };
}

const READINESS_NOTE: Record<string, string> = {
  not_added: 'Add a payout account to receive payouts',
  verification_pending: 'Confirm the 2 small deposits in Finance to verify your payout account',
  verified: 'Payouts go to this account',
  change_under_review: 'Your new account is being verified; payouts keep going to the current account meanwhile',
  blocked: 'Payouts are blocked; see the reasons',
};

export function payoutReadiness(s: SellerRec, payout: StoredPayout | null | undefined): PayoutReadiness {
  return {
    state: s.payout_readiness as PayoutReadiness['state'],
    destinationLabel: s.payout_destination_label ?? payout?.current?.label ?? payout?.pendingChange?.label ?? null,
    note: READINESS_NOTE[s.payout_readiness] ?? '',
    blockedReasons: s.payout_readiness === 'blocked' ? (payout?.blockedReasons ?? []) : [],
  };
}

/* ------------------------------------------------------------------ restrictions, warnings, appeals */

export function restriction(r: RestrictionRec, extra: { appeals?: Appeal[]; refs: Refs; approval?: common.ApprovalInfo | null }): Restriction {
  return {
    id: r.id,
    ref: r.ref,
    sellerId: r.seller_id,
    state: r.state as Restriction['state'],
    title: r.title,
    reasonCode: r.reason_code as Restriction['reasonCode'],
    reason: r.reason,
    ruleRef: r.rule_ref,
    affectedActivities: strings(r.affected_activities) as Restriction['affectedActivities'],
    scope: normalizeScope(r.scope as RestrictionScope),
    affectedSummary: r.affected_summary,
    stillWorks: strings(r.still_works),
    toResolve: r.to_resolve,
    appealRoute: r.appeal_route as unknown as Restriction['appealRoute'],
    reviewDate: r.review_date,
    startedAt: iso(r.started_at),
    endsAt: iso(r.ends_at),
    setBy: actorReq(r.set_by),
    recommendedBy: actorOf(r.recommended_by),
    trustReportId: r.trust_report_id,
    trustEnforcementId: r.trust_enforcement_id,
    approval: extra.approval ?? null,
    appeals: extra.appeals ?? [],
    resolutionEvidence: refList(extra.refs, ((r.resolution_evidence ?? []) as { mediaId?: string }[]).map((e) => (typeof e === 'string' ? e : e.mediaId))),
    liftedAt: iso(r.lifted_at),
    liftReason: r.lift_reason,
  };
}

export const warning = (w: WarningRec): SellerWarning => ({
  id: w.id,
  kind: w.kind as SellerWarning['kind'],
  title: w.title,
  detail: w.detail,
  issuedAt: isoReq(w.issued_at),
  issuedBy: actorReq(w.issued_by),
  state: w.state as SellerWarning['state'],
  resolvedAt: iso(w.resolved_at),
  resolutionNote: w.resolution_note,
});

export const appeal = (a: AppealRec, x: { storeName: string; subjectRef: string; refs: Refs; now: Date; reviewerName?: string | null }): Appeal => ({
  id: a.id,
  ref: a.ref,
  sellerId: a.seller_id,
  storeName: x.storeName,
  subject: a.subject as Appeal['subject'],
  subjectId: a.subject_id,
  subjectRef: x.subjectRef,
  level: a.level,
  argument: a.argument,
  evidence: refList(x.refs, a.evidence_media_ids),
  state: a.state as Appeal['state'],
  reviewer: a.reviewer_id ? { kind: 'staff', id: a.reviewer_id, ...(x.reviewerName ? { name: x.reviewerName } : {}) } : null,
  originalDecider: a.original_decider_id === 'system' ? { kind: 'system', id: null } : { kind: 'staff', id: a.original_decider_id },
  decideBy: deadline(a.decide_by, x.now),
  decision: a.decision ?? null,
  submittedAt: isoReq(a.submitted_at),
  trustReportId: a.trust_report_id,
});

/* ------------------------------------------------------------------ storefront */

export const changeRequest = (c: ChangeRequestRec, x: { storeName: string; refs: Refs }): ChangeRequest => ({
  id: c.id,
  kind: c.kind as ChangeRequest['kind'],
  current: c.current ?? null,
  proposed: c.proposed,
  evidence: refList(x.refs, c.evidence_media_ids),
  state: c.state as ChangeRequest['state'],
  decisionReason: c.decision_reason,
  impact: c.impact,
  submittedBy: actorReq(c.submitted_by),
  submittedAt: isoReq(c.submitted_at),
  decidedBy: actorOf(c.decided_by),
  decidedAt: iso(c.decided_at),
  sellerId: c.seller_id,
  storeName: x.storeName,
});

export const claim = (c: ClaimRec, refs: Refs): PublicClaim => ({
  id: c.id,
  kind: c.kind as PublicClaim['kind'],
  text: c.text,
  brandId: c.brand_id,
  evidence: refList(refs, c.evidence_media_ids),
  state: c.state as PublicClaim['state'],
  decisionReason: c.decision_reason,
  submittedAt: isoReq(c.submitted_at),
  decidedAt: iso(c.decided_at),
  expiresAt: iso(c.expires_at),
});

export const collection = (c: CollectionRec, refs: Refs): FeaturedCollection => {
  const offerIds = strings(c.offer_ids);
  return { id: c.id, title: c.title, image: refs(c.image_media_id), offerIds, offerCount: offerIds.length, position: c.position, visible: c.visible };
};

/* ------------------------------------------------------------------ members */

export const member = (m: MemberRec): SellerMember => ({
  id: m.id,
  accountId: m.account_id,
  name: m.name,
  email: m.email,
  role: m.role as SellerMember['role'],
  permissions: strings(m.permissions),
  isOwner: m.is_owner,
  status: m.status as SellerMember['status'],
  lastActiveAt: iso(m.last_active_at),
  invitedAt: iso(m.invited_at),
  inviteExpiresAt: iso(m.invite_expires_at),
  joinedAt: iso(m.joined_at),
});

/* ------------------------------------------------------------------ applications */

export const note = (n: NoteRec): SellerNote => ({ id: n.id, body: n.body, author: { ...actorReq(n.author_id), name: n.author_name }, createdAt: isoReq(n.created_at) });

export const check = (c: CheckRec): VerificationCheck => ({
  id: c.id,
  kind: c.kind as VerificationCheck['kind'],
  result: c.result as VerificationCheck['result'],
  summary: c.summary,
  source: c.source as VerificationCheck['source'],
  provider: c.provider,
  checkedAt: iso(c.checked_at),
  checkedBy: actorOf(c.checked_by),
  acceptedWithNote: c.accepted_note,
});

export const riskReview = (r: RiskReviewRec | undefined): RiskReview =>
  r
    ? {
        state: r.state as RiskReview['state'],
        trustReportId: r.trust_report_id,
        level: (r.level as RiskReview['level']) ?? null,
        flags: Array.isArray(r.flags) ? r.flags : [],
        recommendation: r.recommendation,
        reviewedBy: actorOf(r.reviewed_by),
        reviewedAt: iso(r.reviewed_at),
      }
    : { state: 'not_needed', flags: [] };

export const document = (d: DocumentRec, refs: Refs, fallbackUrl: (id: string) => string): ApplicationDocument => ({
  id: d.id,
  kind: d.kind as ApplicationDocument['kind'],
  file: refs(d.media_id) ?? { id: d.media_id, url: fallbackUrl(d.media_id) },
  fileName: d.file_name,
  sizeBytes: d.size_bytes,
  uploadedAt: isoReq(d.uploaded_at),
  status: d.status as ApplicationDocument['status'],
  note: d.note,
  deleteAfter: d.delete_after,
});

export const infoRequest = (r: InfoRequestRec, now: Date): InformationRequest => ({
  id: r.id,
  items: (Array.isArray(r.items) ? r.items : []) as unknown as InfoRequestItem[],
  message: r.message,
  dueAt: isoReq(r.due_at),
  reminder: r.reminder as InformationRequest['reminder'],
  requestedBy: actorReq(r.requested_by),
  requestedAt: isoReq(r.requested_at),
  respondedAt: iso(r.responded_at),
  deadline: deadline(r.due_at, now),
});

export const invitation = (i: InvitationRec): SellerInvitation => ({
  id: i.id,
  email: i.email,
  businessName: i.business_name,
  message: i.message,
  invitedBy: actorReq(i.invited_by),
  sentAt: isoReq(i.sent_at),
  expiresAt: isoReq(i.expires_at),
  state: i.state as SellerInvitation['state'],
  applicationId: i.application_id,
});

export const target = (t: TargetRec): PerformanceTarget => {
  const base = { metric: t.metric as PerformanceTarget['metric'], comparator: t.comparator as PerformanceTarget['comparator'], threshold: Number(t.threshold), unit: t.unit as PerformanceTarget['unit'] };
  return { ...base, windowDays: t.window_days, categoryId: t.category_id, display: targetDisplay(base), isExample: t.is_example, effectiveFrom: t.effective_from };
};

export const acceptance = (a: AcceptanceRec): AgreementAcceptance => ({
  key: a.policy_key,
  versionLabel: a.version_label,
  policyVersionId: a.policy_version_id,
  signedName: a.signed_name,
  acceptedBy: actorReq(a.accepted_by),
  acceptedAt: isoReq(a.accepted_at),
});

export const timelineEvent = (e: AccountEventRec): common.TimelineEvent => ({
  at: isoReq(e.at),
  label: e.title,
  detail: e.detail,
  actor: e.actor_kind ? ({ kind: e.actor_kind as common.Actor['kind'], id: e.actor_id } as common.Actor) : null,
});
