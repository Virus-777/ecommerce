/**
 * Pure rules of the sellers module (no I/O): application completeness, payout details, dates and
 * deadlines, restriction scope matching, labels. Everything here is deterministic and unit-testable.
 */
import { isPoBoxLine } from '../../../kernel/lib/address.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import type * as common from '../../../spec/common.js';
import type {
  ApplicationAccountInput,
  ApplicationBusinessInput,
  BusinessOwner,
  PayoutDetailsInput,
  Restriction,
  RestrictionScope,
} from '../../../spec/sellers.js';

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

/* ------------------------------------------------------------------ application steps */

export const STEPS = ['account', 'business', 'verification', 'payout', 'return_address', 'agreement'] as const;
export type Step = (typeof STEPS)[number];
/** Steps saved through PATCH (the agreement step is completed by submit) */
export const DATA_STEPS = ['account', 'business', 'verification', 'payout', 'return_address'] as const;
export type DataStep = (typeof DATA_STEPS)[number];

export interface StoredOwner extends BusinessOwner {}

/** applications.verification (a stored object; the tax id is kept encrypted, never returned) */
export interface StoredVerification {
  owners: StoredOwner[];
  registrationDocumentIds: string[];
  taxIdType?: 'ein' | 'ssn';
  taxIdLast4?: string;
  taxIdEncrypted?: string;
  w9Method?: 'online' | 'uploaded';
  w9DocumentId?: string | null;
}

/**
 * applications.payout holds the destination collected in the application (current). The seller's payout
 * account itself is read from payout_changes and sellers.payout_blocked_reasons in the same shape (core.payoutState).
 */
export interface StoredPayout {
  current?: StoredPayoutDetails | null;
  pendingChange?: (StoredPayoutDetails & { changeId: string; requestedAt: string }) | null;
  blockedReasons?: string[];
  lastRejection?: string | null;
}

export interface StoredPayoutDetails {
  accountHolderName: string;
  accountType: string;
  label: string;
  providerDestinationId: string;
}

export interface StoredReturnAddress {
  sameAsBusiness: boolean;
  contactName: string;
  phone: string;
  address?: common.Address | null;
}

export interface ApplicationSections {
  account: Partial<ApplicationAccountInput> | null;
  business: Partial<ApplicationBusinessInput> | null;
  verification: StoredVerification | null;
  payout: StoredPayout | null;
  returnAddress: StoredReturnAddress | null;
}

const blank = (s: unknown) => typeof s !== 'string' || !s.trim();

/** Step → missing fields (the agreement step is checked at submit) */
export function missingFields(a: ApplicationSections): Record<string, string[]> {
  const missing: Record<string, string[]> = {};
  const add = (step: string, field: string) => (missing[step] ??= []).push(field);

  const acc = a.account ?? {};
  for (const f of ['contactName', 'contactPhone', 'workEmail', 'storeName', 'sellerType', 'market'] as const) if (blank(acc[f])) add('account', f);

  const b = a.business ?? {};
  for (const f of ['legalName', 'storeName', 'businessType', 'phone'] as const) if (blank(b[f])) add('business', f);
  if (!b.kind) add('business', 'kind');
  if (b.kind !== 'individual' && blank(b.stateOfRegistration)) add('business', 'stateOfRegistration');
  if (!b.address) add('business', 'address');
  if (!b.categoryIds?.length) add('business', 'categoryIds');
  if (!b.plannedProductCount) add('business', 'plannedProductCount');

  const v = a.verification;
  if (!v?.owners?.length) add('verification', 'owners');
  else {
    if (!v.owners.some((o) => o.isPrimary)) add('verification', 'owners.isPrimary');
    if (v.owners.some((o) => !o.idDocumentIds?.length)) add('verification', 'owners.idDocumentIds');
  }
  if (!v?.taxIdType || !v.taxIdLast4) add('verification', 'taxId');
  if (!v?.w9Method) add('verification', 'w9Method');
  else if (v.w9Method === 'uploaded' && !v.w9DocumentId) add('verification', 'w9DocumentId');
  if (b.kind === 'registered_business' && !v?.registrationDocumentIds?.length) add('verification', 'registrationDocumentIds');

  const p = a.payout?.current ?? a.payout?.pendingChange;
  if (!p?.providerDestinationId) add('payout', 'accountNumber');

  const r = a.returnAddress;
  if (!r) add('return_address', 'address');
  else {
    if (blank(r.contactName)) add('return_address', 'contactName');
    if (blank(r.phone)) add('return_address', 'phone');
    if (!r.sameAsBusiness && !r.address) add('return_address', 'address');
    if (r.sameAsBusiness && !b.address) add('return_address', 'address');
  }
  return missing;
}

export const completedSteps = (missing: Record<string, string[]>): DataStep[] => DATA_STEPS.filter((s) => !missing[s]?.length);

export const percentComplete = (done: readonly string[], agreementDone: boolean) =>
  Math.round(((done.length + (agreementDone ? 1 : 0)) / STEPS.length) * 100);

/** The step to show next: the first incomplete one after `after` (or from the start) */
export function nextStep(done: readonly string[], after?: string): Step {
  const start = after ? STEPS.indexOf(after as Step) + 1 : 0;
  for (let i = start; i < STEPS.length; i++) if (!done.includes(STEPS[i]!)) return STEPS[i]!;
  for (const s of STEPS) if (!done.includes(s)) return s;
  return 'agreement';
}

/* ------------------------------------------------------------------ payout details */

/** ABA routing number check digit */
export function validRoutingNumber(n: string): boolean {
  if (!/^\d{9}$/.test(n)) return false;
  const d = n.split('').map(Number);
  const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}

export function payoutProblems(p: PayoutDetailsInput): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (blank(p.accountHolderName)) issues.push({ path: 'accountHolderName', message: 'Enter the name on the account' });
  if (!validRoutingNumber(p.routingNumber.trim())) issues.push({ path: 'routingNumber', message: 'Enter a valid 9-digit routing number' });
  if (!/^\d{4,17}$/.test(p.accountNumber.trim())) issues.push({ path: 'accountNumber', message: 'Account numbers have 4 to 17 digits' });
  if (p.accountNumber.trim() !== p.confirmAccountNumber.trim()) issues.push({ path: 'confirmAccountNumber', message: 'The account numbers do not match' });
  return issues;
}

const ACCOUNT_TYPE_LABEL: Record<string, string> = { business_checking: 'Checking', personal_checking: 'Checking', business_savings: 'Savings' };
export const payoutLabel = (accountType: string, accountNumber: string) => `${ACCOUNT_TYPE_LABEL[accountType] ?? 'Account'} •••• ${accountNumber.trim().slice(-4)}`;

export const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(llc|inc|corp|corporation|co|ltd)\b/g, '').trim();

/** The account holder must match the legal business name or an owner's name */
export function holderMatches(holder: string, legalName: string | undefined, owners: readonly { name: string }[]): boolean {
  const h = normalizeName(holder);
  if (!h) return false;
  if (legalName && normalizeName(legalName) === h) return true;
  return owners.some((o) => normalizeName(o.name) === h);
}

/* ------------------------------------------------------------------ tax ids, addresses, names */

export const taxIdDigits = (s: string) => s.replace(/[^0-9]/g, '');
export const validTaxId = (type: 'ein' | 'ssn', s: string) => taxIdDigits(s).length === 9 && (type === 'ein' || !/^(000|666|9)/.test(taxIdDigits(s)));

export const isPoBox = (a: common.Address | null | undefined) => Boolean(a && (isPoBoxLine(a.line1) || isPoBoxLine(a.line2)));

export const sameStoreName = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');

const phoneDigits = (s: string) => s.replace(/[^0-9]/g, '');

/** A storefront's phone numbers: the list when given (else the single phone), trimmed, blanks and repeats (same digits) dropped */
export function phoneList(c: { phone?: string | null; phones?: readonly string[] | null }): string[] {
  const seen = new Set<string>();
  return (c.phones ?? (c.phone ? [c.phone] : [])).map((n) => n.trim()).filter((n) => n && !seen.has(phoneDigits(n)) && seen.add(phoneDigits(n)));
}

/** Digits with an optional leading +, spaces, dots, dashes and brackets; 7 to 15 digits (E.164 allows at most 15) */
export const isPhoneNumber = (s: string) => /^\+?[\d\s().-]+$/.test(s) && phoneDigits(s).length >= 7 && phoneDigits(s).length <= 15;

export const locationOf =(a: common.Address | null | undefined) => (a ? `${a.city}, ${a.region}` : null);

/** Does the free-text product plan mention one of the categories referred to Trust and Risk? */
export function riskCategoriesIn(text: string | null | undefined, categories: readonly string[]): string[] {
  const t = (text ?? '').toLowerCase();
  return categories.filter((c) => c.trim() && t.includes(c.toLowerCase()));
}

/* ------------------------------------------------------------------ dates */

// market days and business days: Core.today(at) and Core.addBusinessDays (the market's calendar), never the UTC day
export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY);

/** Deadline state: overdue once past, due soon within a day */
export function deadline(dueAt: Date | string, now: Date): common.Deadline {
  const due = typeof dueAt === 'string' ? new Date(dueAt) : dueAt;
  const left = due.getTime() - now.getTime();
  return { dueAt: due.toISOString(), state: left < 0 ? 'overdue' : left <= DAY ? 'due_soon' : 'on_time' };
}

/** The market day from which a rejected applicant may apply again; null when never */
export function reapplyFrom(rule: 'immediately' | 'after_30_days' | 'after_90_days' | 'not_eligible', now: Date, timeZone: string): string | null {
  if (rule === 'not_eligible') return null;
  return dateInZone(addDays(now, rule === 'after_30_days' ? 30 : rule === 'after_90_days' ? 90 : 0), timeZone);
}

/* ------------------------------------------------------------------ restrictions */

export type Activity = Restriction['affectedActivities'][number];

export const ACTIVITY_LABEL: Record<Activity, string> = {
  new_listings: 'new listings',
  product_submissions: 'product submissions',
  new_offers: 'new offers',
  offer_reactivation: 'offer reactivation',
  sales: 'sales',
  advertising: 'advertising',
  promotions: 'promotions',
  payout_schedule: 'payout schedule',
};

export const DEFAULT_STILL_WORKS = ['Existing orders, dispatch and shipping', 'Returns, refunds and cases', 'Messages with buyers', 'Payouts (unless finance holds them)'];

export const isWholeAccount = (s: RestrictionScope | null | undefined) =>
  !s?.categoryIds?.length && !s?.conditions?.length && !s?.offerIds?.length && !s?.productIds?.length;

export const normalizeScope = (s: RestrictionScope | null | undefined): RestrictionScope => ({
  categoryIds: [...new Set(s?.categoryIds ?? [])],
  conditions: [...new Set(s?.conditions ?? [])],
  offerIds: [...new Set(s?.offerIds ?? [])],
  productIds: [...new Set(s?.productIds ?? [])],
});

/** One line for the seller, e.g. "New offers and sales paused in 2 categories (refurbished)" */
export function affectedSummary(activities: readonly Activity[], scope: RestrictionScope): string {
  const what = activities.map((a) => ACTIVITY_LABEL[a]);
  const list = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what.at(-1)}` : (what[0] ?? 'selling');
  const head = list.charAt(0).toUpperCase() + list.slice(1);
  if (isWholeAccount(scope)) return `${head} paused for the whole account`;
  const parts: string[] = [];
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (scope.categoryIds?.length) parts.push(n(scope.categoryIds.length, 'category', 'categories'));
  if (scope.productIds?.length) parts.push(n(scope.productIds.length, 'product', 'products'));
  if (scope.offerIds?.length) parts.push(n(scope.offerIds.length, 'offer', 'offers'));
  const cond = scope.conditions?.length ? ` (${scope.conditions.join(', ')})` : '';
  return `${head} paused for ${parts.join(', ') || 'some listings'}${cond}`;
}

/** canSell activities are covered by the restriction's activities (new_listings and new_offers both stop new offers) */
const COVERS: Record<string, readonly Activity[]> = {
  new_offers: ['new_offers', 'new_listings'],
  new_listings: ['new_listings', 'new_offers'],
  product_submissions: ['product_submissions'],
  offer_reactivation: ['offer_reactivation', 'sales'],
  sales: ['sales'],
  advertising: ['advertising'],
  promotions: ['promotions'],
};

/** Whether an active restriction blocks this activity for this category / condition / offer */
export function restrictionBlocks(
  r: { affectedActivities: readonly string[]; scope: RestrictionScope },
  check: { activity: string; categoryId?: string; condition?: string; offerId?: string },
): boolean {
  const acts = COVERS[check.activity] ?? [check.activity];
  if (!r.affectedActivities.some((a) => acts.includes(a as Activity))) return false;
  const s = r.scope;
  if (isWholeAccount(s)) return true;
  // a scoped restriction blocks when every dimension it names matches; unknown dimensions of the check count as in scope
  const dims: boolean[] = [];
  if (s.categoryIds?.length) dims.push(!check.categoryId || s.categoryIds.includes(check.categoryId));
  if (s.conditions?.length) dims.push(!check.condition || s.conditions.includes(check.condition));
  if (s.offerIds?.length) dims.push(!check.offerId || s.offerIds.includes(check.offerId));
  if (s.productIds?.length && !s.categoryIds?.length && !s.offerIds?.length) dims.push(!check.offerId && !check.categoryId);
  return dims.length > 0 && dims.every(Boolean);
}

/* ------------------------------------------------------------------ misc */

export const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

