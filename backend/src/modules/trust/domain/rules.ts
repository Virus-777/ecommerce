/**
 * Pure Trust and Risk rules: the action catalogue (who owns each enforcement, which permission accepts it, how
 * execution is confirmed, whether it can be appealed and where), parameter normalisation for the owning modules,
 * the explainable risk score, deadlines and the labels reporters and affected parties see. No I/O.
 */
import { createHash } from 'node:crypto';
import type * as common from '../../../spec/common.js';
import type { MyReport, Recommendation, RiskFactor, TrustReport, TrustSubject } from '../../../spec/trust.js';

export type ReportType = TrustReport['type'];
export type ReportStatus = TrustReport['status'];
export type Source = TrustReport['source'];
export type Action = Recommendation['action'];
export type OwnerTeam = Recommendation['ownerTeam'];
export type SubjectType = TrustSubject['type'];

export const REPORT_TYPES: readonly ReportType[] = ['counterfeit', 'suspicious_orders', 'fake_reviews', 'abuse', 'prohibited_item', 'misleading_listing', 'seller_application', 'account_risk', 'other'];
export const SUBJECT_TYPES: readonly SubjectType[] = ['seller', 'product', 'offer', 'order', 'customer', 'review', 'question', 'answer', 'message', 'conversation', 'application', 'storefront_claim', 'payment'];
export const OWNER_TEAMS: readonly OwnerTeam[] = ['catalog', 'sellers', 'support', 'finance', 'orders', 'reviews', 'customers', 'messaging'];
export const ACTIVE: readonly ReportStatus[] = ['open', 'under_review', 'escalated'];
export const OPEN_APPEAL = ['open', 'under_review'];
export const OUTCOMES = ['action_taken', 'no_violation', 'insufficient_evidence', 'referred'] as const;

export const SYSTEM: common.Actor = { kind: 'system', id: null, name: 'Trust and Risk' };

/* ------------------------------------------------------------------ the action catalogue */

/**
 * How an enforcement is confirmed:
 *  event      the owning module executes it on trust.enforcement.recorded (or in its own screen) and one of its events
 *             that trust consumes confirms it (it stays pending until then, even when accepted with externalRef);
 *             execution-check flags it failed after executionGraceMinutes
 *  on_record  nothing trust consumes can confirm it (keep_reviews, revoke_claim, request_identity_confirmation,
 *             other): the owner's acceptance is the confirmation, so it is applied when recorded
 */
export type Confirmation = 'event' | 'on_record';

export interface ActionDef {
  team: OwnerTeam;
  /** access role key of the default owner */
  role: string;
  /** The owner's own permission for the action (any of) */
  permissions: string[];
  /** access approval action checked at accept time (with params.amount for money limits) */
  authority?: string;
  /** The owning module runs its own second review (sellers suspensions): a permitted owner may accept */
  ownerSecondReview?: boolean;
  /** At least one target of these types (empty: any) */
  targets: SubjectType[];
  confirmation: Confirmation;
  /** Who executes it automatically on trust.enforcement.recorded (null: the owner acts in its own screen) */
  executor: string | null;
  /** No module executes it: the owner does it in its own screen first and accepts with externalRef (decision D4) */
  externalRefRequired?: boolean;
  /** Where it is appealed (null: not appealable) */
  appeal: 'trust' | 'sellers' | null;
  /** What the affected party sees */
  title: string;
  effects: string[];
}

const KEEPS = 'Valid order history and access to help stay available to everyone involved';

export const ACTIONS: Record<Action, ActionDef> = {
  suspend_offer: {
    team: 'catalog',
    role: 'catalog_manager',
    permissions: ['offers.offers.remove'],
    targets: ['offer'],
    confirmation: 'event',
    executor: 'offers',
    appeal: 'trust',
    title: 'Offer suspended',
    effects: ['The offer stops selling; other sellers’ offers on the product are not affected', 'Open orders, returns and cases on the offer stay active', KEEPS],
  },
  suspend_product: {
    team: 'catalog',
    role: 'catalog_manager',
    permissions: ['catalog.products.publish'],
    targets: ['product'],
    confirmation: 'event',
    executor: 'catalog',
    appeal: 'trust',
    title: 'Product suspended',
    effects: ['The product page and its offers are hidden from the store', 'Open orders, returns and cases stay active', KEEPS],
  },
  remove_reviews: {
    team: 'reviews',
    role: 'trust_and_risk_manager',
    permissions: ['reviews.moderation.decide'],
    targets: ['review', 'question', 'answer'],
    confirmation: 'event',
    executor: 'reviews',
    appeal: 'trust',
    title: 'Reviews removed',
    effects: ['The named reviews, questions or answers are removed and ratings are recalculated', 'Authors are told why', KEEPS],
  },
  keep_reviews: {
    team: 'reviews',
    role: 'trust_and_risk_manager',
    permissions: ['reviews.moderation.decide'],
    targets: ['review', 'question', 'answer'],
    confirmation: 'on_record',
    executor: null,
    appeal: null,
    title: 'Reviews kept',
    effects: ['The reviews stay published', KEEPS],
  },
  restrict_seller: {
    team: 'sellers',
    role: 'seller_manager',
    permissions: ['sellers.accounts.restrict'],
    authority: 'sellers.sellers.restrict',
    targets: ['seller'],
    confirmation: 'event',
    executor: 'sellers',
    appeal: 'sellers',
    title: 'Selling restricted',
    effects: ['The restricted activities stop in the restriction’s scope', 'Existing orders, dispatch, returns, refunds, cases, messages and payouts keep working', KEEPS],
  },
  suspend_seller: {
    team: 'sellers',
    role: 'seller_manager',
    permissions: ['sellers.accounts.suspend'],
    authority: 'sellers.sellers.suspend',
    ownerSecondReview: true,
    targets: ['seller'],
    confirmation: 'event',
    executor: 'sellers',
    appeal: 'sellers',
    title: 'Account suspended',
    effects: ['All new sales stop once the second reviewer confirms', 'Open orders follow the chosen handling; returns, refunds and cases stay active', KEEPS],
  },
  warn_seller: {
    team: 'sellers',
    role: 'seller_manager',
    permissions: ['sellers.accounts.restrict', 'sellers.accounts.manage'],
    targets: ['seller'],
    confirmation: 'event',
    executor: 'sellers',
    appeal: 'sellers',
    title: 'Warning',
    effects: ['A warning is added to Account health', 'Selling is not affected', KEEPS],
  },
  revoke_claim: {
    team: 'sellers',
    role: 'seller_manager',
    permissions: ['sellers.storefronts.review'],
    targets: ['storefront_claim', 'seller'],
    confirmation: 'on_record',
    executor: null,
    externalRefRequired: true,
    appeal: 'trust',
    title: 'Storefront claim removed',
    effects: ['The claim is removed from the storefront', 'Selling is not affected', KEEPS],
  },
  hold_payout: {
    team: 'finance',
    role: 'finance_manager',
    permissions: ['finance.holds.manage'],
    authority: 'finance.holds.place',
    targets: ['seller'],
    confirmation: 'event',
    executor: null,
    externalRefRequired: true,
    appeal: null,
    title: 'Payout held',
    effects: ['The held amount is kept out of payouts until the review date', 'Sales, orders and the rest of the balance are not affected', KEEPS],
  },
  hold_dispatch: {
    team: 'orders',
    role: 'order_manager',
    permissions: ['orders.orders.manage', 'orders.orders.cancel'],
    targets: ['order'],
    confirmation: 'event',
    executor: null,
    externalRefRequired: true,
    appeal: null,
    title: 'Dispatch held',
    effects: ['The named orders are held or cancelled before dispatch', KEEPS],
  },
  review_payments: {
    team: 'finance',
    role: 'finance_manager',
    permissions: ['payments.payments.manage'],
    targets: ['order', 'payment', 'customer'],
    confirmation: 'event',
    executor: null,
    externalRefRequired: true,
    appeal: null,
    title: 'Payments reviewed',
    effects: ['Finance reviews the payments; orders it cancels are refunded', KEEPS],
  },
  refund_buyers: {
    team: 'finance',
    role: 'finance_manager',
    permissions: ['returns.refunds.approve'],
    authority: 'returns.refunds.approve',
    targets: ['order'],
    confirmation: 'event',
    executor: null,
    externalRefRequired: true,
    appeal: null,
    title: 'Buyers refunded',
    effects: ['Buyers of the named orders are refunded', KEEPS],
  },
  inform_customers: {
    team: 'support',
    role: 'customer_support_manager',
    permissions: ['support.cases.handle'],
    targets: ['customer', 'order'],
    confirmation: 'event',
    executor: null,
    externalRefRequired: true,
    appeal: null,
    title: 'Customers informed',
    effects: ['Support contacts the affected customers', KEEPS],
  },
  request_identity_confirmation: {
    team: 'customers',
    role: 'customer_support_manager',
    permissions: ['customers.accounts.security', 'customers.accounts.act'],
    targets: ['customer', 'seller'],
    confirmation: 'on_record',
    executor: null,
    externalRefRequired: true,
    appeal: null,
    title: 'Identity confirmation requested',
    effects: ['The account holder is asked to confirm their identity', KEEPS],
  },
  restrict_customer_messaging: {
    team: 'customers',
    role: 'customer_support_manager',
    permissions: ['customers.accounts.act'],
    targets: ['customer'],
    confirmation: 'event',
    executor: 'customers',
    appeal: 'trust',
    title: 'Messaging restricted',
    effects: ['New messages to sellers are paused', 'Replies inside open cases, orders, returns and refunds keep working', KEEPS],
  },
  restrict_customer_account: {
    team: 'customers',
    role: 'customer_support_manager',
    permissions: ['customers.accounts.act'],
    targets: ['customer'],
    confirmation: 'event',
    executor: 'customers',
    appeal: 'trust',
    title: 'Account restricted',
    effects: ['New orders and messages are paused', 'Existing orders, returns, refunds and cases stay reachable', KEEPS],
  },
  lock_conversation: {
    team: 'messaging',
    role: 'customer_support_manager',
    permissions: ['messaging.conversations.moderate'],
    targets: ['conversation', 'message'],
    confirmation: 'event',
    executor: 'messaging',
    appeal: 'trust',
    title: 'Conversation locked',
    effects: ['No new messages in the conversation', 'The order, returns and cases stay reachable through support', KEEPS],
  },
  other: {
    team: 'support',
    role: 'customer_support_manager',
    permissions: [],
    targets: [],
    confirmation: 'on_record',
    executor: null,
    externalRefRequired: true,
    appeal: null,
    title: 'Trust and Risk action',
    effects: [KEEPS],
  },
};

export const ACTION_KEYS = Object.keys(ACTIONS) as Action[];
export const isAction = (a: unknown): a is Action => typeof a === 'string' && a in ACTIONS;
export const isTeam = (t: unknown): t is OwnerTeam => typeof t === 'string' && (OWNER_TEAMS as readonly string[]).includes(t);

/** Default owner role of a team (when a recommendation names a team other than the action's default) */
export const TEAM_ROLES: Record<OwnerTeam, string> = {
  catalog: 'catalog_manager',
  sellers: 'seller_manager',
  support: 'customer_support_manager',
  finance: 'finance_manager',
  orders: 'order_manager',
  reviews: 'trust_and_risk_manager',
  customers: 'customer_support_manager',
  messaging: 'customer_support_manager',
};

/** Work queue of each owner team (same mapping workqueues uses for trust.recommendation.routed) */
export const TEAM_QUEUES: Record<OwnerTeam, string> = {
  catalog: 'catalog.product_review',
  sellers: 'sellers.performance',
  support: 'support.cases_waiting',
  customers: 'support.cases_waiting',
  messaging: 'support.cases_waiting',
  orders: 'support.cases_waiting',
  finance: 'finance.daily_checks',
  reviews: 'trust.reports',
};

/** Where staff open a subject */
export const SCREENS: Partial<Record<SubjectType, string>> = {
  seller: 'admin/seller',
  product: 'admin/product',
  offer: 'admin/offers',
  order: 'admin/order',
  customer: 'admin/customer',
  review: 'admin/reviews',
  question: 'admin/reviews',
  answer: 'admin/reviews',
  message: 'admin/case',
  conversation: 'admin/case',
  application: 'admin/seller-application',
  storefront_claim: 'admin/seller',
  payment: 'admin/finance',
};

/* ------------------------------------------------------------------ parameters the owning modules read */

type Issue = { path: string; message: string };
type Params = Record<string, unknown>;

const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const isDateTime = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isMoney = (v: unknown): v is common.Money => !!v && typeof v === 'object' && Number.isInteger((v as common.Money).amount) && (v as common.Money).amount > 0 && typeof (v as common.Money).currency === 'string';
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

export const SELLER_REASON_CODES = ['performance', 'policy_violation', 'brand_claim', 'counterfeit_risk', 'fraud_risk', 'unresolved_cases', 'verification_lapsed', 'approval_condition', 'other'];
export const SELLER_ACTIVITIES = ['new_listings', 'product_submissions', 'new_offers', 'offer_reactivation', 'sales', 'advertising', 'promotions', 'payout_schedule'];
export const WARNING_KINDS = ['performance', 'listing', 'policy', 'conduct'];
export const CUSTOMER_REASON_CODES = ['customer_request', 'suspected_takeover', 'abusive_messages', 'payment_fraud_review', 'policy_violation', 'other'];

/**
 * Checks and completes the parameters the executing module reads from trust.enforcement.recorded, so every
 * owner acts on the same, exact shape:
 *  restrict_seller   sellers.RestrictionInput fields { title, reasonCode, reason, ruleRef?, affectedActivities, scope?, stillWorks?, toResolve, appealDays, reviewDate, endsAt? }
 *  warn_seller       { kind, title, detail }
 *  suspend_seller    { reasonCode, reason, reviewDate, openOrders, secondReviewerId? }
 *  suspend_offer     { mode: 'remove' | 'hold', reviewDate? }
 *  restrict_customer_*  { endsAt?, customerMessage?, reasonCode }
 *  hold_payout       { amount: Money, reviewDate }
 *  refund_buyers     { amount?: Money }
 * Defaults come from the recommendation (rationale) so a recommendation drafted without params still executes.
 */
export function normalizeParams(action: Action, raw: unknown, o: { now: Date; rationale: string; appealWindowDays: number }): { params: Params; issues: Issue[] } {
  const p: Params = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Params) } : {};
  const issues: Issue[] = [];
  const bad = (k: string, message: string) => issues.push({ path: `params.${k}`, message });
  const today = isoDate(o.now);
  switch (action) {
    case 'restrict_seller': {
      if (p.reasonCode !== undefined && !SELLER_REASON_CODES.includes(p.reasonCode as string)) bad('reasonCode', `One of ${SELLER_REASON_CODES.join(', ')}`);
      if (p.affectedActivities !== undefined && (!Array.isArray(p.affectedActivities) || !p.affectedActivities.length || p.affectedActivities.some((a) => !SELLER_ACTIVITIES.includes(a as string)))) bad('affectedActivities', `Choose from ${SELLER_ACTIVITIES.join(', ')}`);
      if (p.reviewDate !== undefined && (!isDate(p.reviewDate) || (p.reviewDate as string) < today)) bad('reviewDate', 'A review date from today on (YYYY-MM-DD)');
      if (p.endsAt !== undefined && p.endsAt !== null && !isDateTime(p.endsAt)) bad('endsAt', 'A date and time');
      p.title ??= 'Selling restricted after a Trust and Risk review';
      p.reasonCode ??= 'policy_violation';
      p.reason ??= o.rationale;
      p.affectedActivities ??= ['new_offers', 'new_listings'];
      p.toResolve ??= 'Contact your Seller Manager or appeal with documents that answer the findings.';
      p.appealDays ??= o.appealWindowDays;
      p.reviewDate ??= isoDate(addDays(o.now, 30));
      break;
    }
    case 'warn_seller':
      if (p.kind !== undefined && !WARNING_KINDS.includes(p.kind as string)) bad('kind', `One of ${WARNING_KINDS.join(', ')}`);
      p.kind ??= 'policy';
      p.title ??= 'Policy warning after a Trust and Risk review';
      p.detail ??= o.rationale;
      break;
    case 'suspend_seller':
      if (p.reasonCode !== undefined && !SELLER_REASON_CODES.includes(p.reasonCode as string)) bad('reasonCode', `One of ${SELLER_REASON_CODES.join(', ')}`);
      if (p.openOrders !== undefined && !['seller_keeps_fulfilling', 'cancel_unshipped_and_refund'].includes(p.openOrders as string)) bad('openOrders', 'seller_keeps_fulfilling or cancel_unshipped_and_refund');
      if (p.reviewDate !== undefined && (!isDate(p.reviewDate) || (p.reviewDate as string) < today)) bad('reviewDate', 'A review date from today on (YYYY-MM-DD)');
      p.reasonCode ??= 'policy_violation';
      p.reason ??= o.rationale;
      p.reviewDate ??= isoDate(addDays(o.now, 30));
      p.openOrders ??= 'seller_keeps_fulfilling';
      break;
    case 'suspend_offer':
      if (p.mode !== undefined && !['remove', 'hold'].includes(p.mode as string)) bad('mode', 'remove or hold');
      if (p.reviewDate !== undefined && p.reviewDate !== null && !isDate(p.reviewDate)) bad('reviewDate', 'A date (YYYY-MM-DD)');
      p.mode ??= 'remove';
      break;
    case 'restrict_customer_messaging':
    case 'restrict_customer_account':
      if (p.endsAt !== undefined && p.endsAt !== null && (!isDateTime(p.endsAt) || Date.parse(p.endsAt as string) <= o.now.getTime())) bad('endsAt', 'A future date and time, or leave it out (until lifted)');
      if (p.reasonCode !== undefined && !CUSTOMER_REASON_CODES.includes(p.reasonCode as string)) bad('reasonCode', `One of ${CUSTOMER_REASON_CODES.join(', ')}`);
      p.reasonCode ??= action === 'restrict_customer_messaging' ? 'abusive_messages' : 'policy_violation';
      break;
    case 'hold_payout':
      if (p.amount !== undefined && !isMoney(p.amount)) bad('amount', 'An amount in minor units with a currency');
      if (p.reviewDate !== undefined && (!isDate(p.reviewDate) || (p.reviewDate as string) < today)) bad('reviewDate', 'A review date from today on (YYYY-MM-DD)');
      p.reviewDate ??= isoDate(addDays(o.now, 14));
      break;
    case 'refund_buyers':
      if (p.amount !== undefined && !isMoney(p.amount)) bad('amount', 'An amount in minor units with a currency');
      break;
    default:
      break;
  }
  return { params: p, issues };
}

/** The amount an approval limit is checked against */
export const amountOf = (params: Params): common.Money | null => (isMoney(params.amount) ? params.amount : null);

/* ------------------------------------------------------------------ risk score */

export interface RiskInput {
  type: string;
  source: string;
  reporterCount: number;
  /** Score the detector or calling module gave (raiseSignal score, detection rule baseScore) */
  signalScore: number | null;
  evidence: { kind: string; result: string | null; source: string }[];
  /** Enforcement recorded earlier against the same subjects (other reports, not reversed) */
  priorEnforcements: number;
  /** Raw risk signals about the subjects in the last 30 days */
  recentSignals: number;
  /** Evidence requests that expired without proof */
  missingProof: number;
}

const TYPE_BASE: Record<string, number> = {
  counterfeit: 35,
  prohibited_item: 35,
  suspicious_orders: 35,
  account_risk: 25,
  fake_reviews: 25,
  abuse: 20,
  seller_application: 20,
  misleading_listing: 15,
  other: 10,
};

const label = (s: string) => s.replace(/_/g, ' ');

/** Explainable score: every point comes from a listed factor; the total is capped to 0–100 */
export function riskScore(i: RiskInput): { score: number; factors: RiskFactor[] } {
  const factors: RiskFactor[] = [];
  const base = TYPE_BASE[i.type] ?? 10;
  if (i.signalScore !== null && i.signalScore > base) factors.push({ factor: 'signal', weight: Math.round(i.signalScore), detail: `Detector score ${Math.round(i.signalScore)} (above the ${label(i.type)} base of ${base})` });
  else factors.push({ factor: 'type', weight: base, detail: `Base score for ${label(i.type)} reports` });
  if (i.source === 'brand_owner') factors.push({ factor: 'brand_owner', weight: 15, detail: 'Reported by a brand or rights owner' });
  if (i.reporterCount > 1) factors.push({ factor: 'reporters', weight: Math.min(20, (i.reporterCount - 1) * 5), detail: `${i.reporterCount} reporters` });
  const fails = i.evidence.filter((e) => e.result === 'fail').length;
  const warns = i.evidence.filter((e) => e.result === 'warn').length;
  if (fails) factors.push({ factor: 'failed_checks', weight: Math.min(30, fails * 10), detail: `${fails} failed check${fails === 1 ? '' : 's'}` });
  if (warns) factors.push({ factor: 'warning_checks', weight: Math.min(12, warns * 4), detail: `${warns} check${warns === 1 ? '' : 's'} with warnings` });
  if (i.priorEnforcements) factors.push({ factor: 'prior_enforcement', weight: Math.min(20, i.priorEnforcements * 10), detail: `${i.priorEnforcements} earlier enforcement${i.priorEnforcements === 1 ? '' : 's'} on the same subjects` });
  if (i.recentSignals) factors.push({ factor: 'recent_signals', weight: Math.min(10, i.recentSignals * 2), detail: `${i.recentSignals} automated signal${i.recentSignals === 1 ? '' : 's'} in the last 30 days` });
  if (i.missingProof) factors.push({ factor: 'missing_proof', weight: Math.min(20, i.missingProof * 10), detail: `${i.missingProof} evidence request${i.missingProof === 1 ? '' : 's'} not answered by the deadline` });
  const score = Math.max(0, Math.min(100, factors.reduce((n, f) => n + f.weight, 0)));
  return { score, factors };
}

export interface Thresholds {
  medium: number;
  high: number;
}

export function thresholdsOf(v: unknown): Thresholds {
  const t = (v && typeof v === 'object' ? v : {}) as Partial<Thresholds>;
  return { medium: Number.isFinite(t.medium) ? Number(t.medium) : 40, high: Number.isFinite(t.high) ? Number(t.high) : 70 };
}

export const riskLevel = (score: number, t: Thresholds): 'low' | 'medium' | 'high' => (score >= t.high ? 'high' : score >= t.medium ? 'medium' : 'low');

/* ------------------------------------------------------------------ deadlines and labels */

/** Deadline state: overdue once past, due soon inside the last quarter of its window (at most a day) */
export function deadline(dueAt: Date | string, now: Date, windowMs = 86_400_000): common.Deadline {
  const due = new Date(dueAt);
  const left = due.getTime() - now.getTime();
  const soon = Math.min(86_400_000, Math.max(3_600_000, windowMs / 4));
  return { dueAt: due.toISOString(), state: left < 0 ? 'overdue' : left <= soon ? 'due_soon' : 'on_time' };
}

/** What the reporter sees for the report's status (merged reports follow the kept one) */
export function reporterStatus(status: string, outcome: string | null | undefined): MyReport['statusLabel'] {
  if (status === 'open') return 'received';
  if (status === 'under_review' || status === 'escalated') return 'under_review';
  if (status === 'dismissed') return 'no_violation';
  if (status === 'resolved') return outcome === 'action_taken' ? 'action_taken' : outcome === 'no_violation' ? 'no_violation' : 'decision_made';
  return 'under_review';
}

export const WHAT: Record<string, string> = {
  offer: 'Report on a listing',
  product: 'Report on a listing',
  seller: 'Report on a seller',
  order: 'Report on an order',
  message: 'Report on a message',
  conversation: 'Report on a conversation',
  customer: 'Report on a customer',
  review: 'Report on a review',
};

export const TYPE_LABELS: Record<string, string> = {
  counterfeit: 'Possible counterfeit',
  suspicious_orders: 'Suspicious orders',
  suspicious_order: 'Suspicious order',
  fake_reviews: 'Fake reviews',
  abuse: 'Abuse',
  prohibited_item: 'Prohibited item',
  misleading_listing: 'Misleading listing',
  seller_application: 'Seller application assessment',
  account_risk: 'Account risk assessment',
  other: 'Other concern',
};

/** Store and seller report form types → report types */
export const FORM_TYPES: Record<string, ReportType> = {
  counterfeit: 'counterfeit',
  prohibited_item: 'prohibited_item',
  misleading_listing: 'misleading_listing',
  abuse: 'abuse',
  suspicious_order: 'suspicious_orders',
  other: 'other',
};

export const humanize = (s: string) => {
  const t = s.replace(/[_.-]+/g, ' ').trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
};

/** Where the affected party appeals */
export function appealRoute(def: ActionDef, deadlineAt: Date | null): string {
  const by = deadlineAt ? ` before ${deadlineAt.toISOString().slice(0, 10)}` : '';
  if (def.appeal === 'sellers') return `Appeal in Account health (Seller Center)${by}`;
  if (def.appeal === 'trust') return `Appeal to Trust and Risk${by}; someone other than the original decider reviews it`;
  return 'This action cannot be appealed; contact support if you think it is wrong';
}

/** A stable uuid for a key (idempotent signal rows) */
export function detId(key: string): string {
  const h = createHash('sha1').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Address key for linked-account detection (case and spacing do not matter) */
export const addressKey = (a: { line1?: string | null; postalCode?: string | null; country?: string | null } | null | undefined) =>
  a?.line1 && a.postalCode ? `${a.line1}|${a.postalCode}|${a.country ?? ''}`.toLowerCase().replace(/[^a-z0-9|]/g, '') : null;
