/**
 * Approval limits and the second-reviewer rule (access spec notes, Approval request state machine).
 * Pure functions: no I/O, no clock. Money is integer minor units.
 *
 *   covers         the role's authority and limit cover the amount (it may approve, maybe with a second reviewer)
 *   needs second   permitted_with_second_review, or the amount is above the role's second-review threshold;
 *                  for the requester, also every action declared secondReviewer = always
 */
import type { LimitValue } from '../../../spec/access.js';
import type { Money } from '../../../spec/common.js';

export type LimitKind = 'money' | 'units' | 'percent' | 'none';
export type SecondMode = 'always' | 'above-limit' | 'never';

export interface Amount {
  money?: Money | null;
  number?: number | null;
}

export const NOT_PERMITTED: LimitValue = { authority: 'not_permitted', secondReviewerRoleKeys: [] };

const AUTHORITY_RANK: Record<LimitValue['authority'], number> = { not_permitted: 0, recommend_only: 1, permitted_with_second_review: 2, permitted: 3 };

export function normalizeLimit(v: Partial<LimitValue> & { authority: LimitValue['authority'] }): LimitValue {
  return {
    authority: v.authority,
    limitMoney: v.limitMoney ?? null,
    limitNumber: v.limitNumber ?? null,
    secondReviewerAboveMoney: v.secondReviewerAboveMoney ?? null,
    secondReviewerAboveNumber: v.secondReviewerAboveNumber ?? null,
    secondReviewerRoleKeys: [...(v.secondReviewerRoleKeys ?? [])],
  };
}

const canApprove = (v: LimitValue) => v.authority === 'permitted' || v.authority === 'permitted_with_second_review';

/** a > b for money (false when the currencies differ: no comparison is possible) */
const moneyAbove = (a: Money, b: Money) => a.currency === b.currency && a.amount > b.amount;

export function covers(kind: LimitKind, v: LimitValue, amt: Amount): boolean {
  if (!canApprove(v)) return false;
  if (kind === 'money') {
    if (v.limitMoney == null) return true;
    const m = amt.money;
    if (!m) return true;
    if (m.currency !== v.limitMoney.currency) return false;
    return m.amount <= v.limitMoney.amount;
  }
  if (kind === 'units' || kind === 'percent') {
    if (v.limitNumber == null || amt.number == null) return true;
    return Math.abs(amt.number) <= v.limitNumber;
  }
  return true;
}

/** Role-level second review: authority with second review, or above the role's threshold */
export function aboveSecondThreshold(kind: LimitKind, v: LimitValue, amt: Amount): boolean {
  if (v.authority === 'permitted_with_second_review') return true;
  if (kind === 'money' && v.secondReviewerAboveMoney && amt.money) return moneyAbove(amt.money, v.secondReviewerAboveMoney);
  if ((kind === 'units' || kind === 'percent') && v.secondReviewerAboveNumber != null && amt.number != null) return Math.abs(amt.number) > v.secondReviewerAboveNumber;
  return false;
}

/** The requester also needs someone else for actions declared secondReviewer = always */
export const requesterNeedsSecond = (kind: LimitKind, mode: SecondMode, v: LimitValue, amt: Amount) => mode === 'always' || aboveSecondThreshold(kind, v, amt);

/** 0 no authority · 1 recommend only or above the limit · 2 covers with a second reviewer · 3 covers alone */
export function standing(kind: LimitKind, mode: SecondMode, v: LimitValue, amt: Amount, asRequester: boolean): 0 | 1 | 2 | 3 {
  if (v.authority === 'not_permitted') return 0;
  if (!covers(kind, v, amt)) return 1;
  const second = asRequester ? requesterNeedsSecond(kind, mode, v, amt) : aboveSecondThreshold(kind, v, amt);
  return second ? 2 : 3;
}

/** Larger limit first (no limit = unlimited); positive when a > b */
export function compareSize(kind: LimitKind, a: LimitValue, b: LimitValue): number {
  if (kind === 'money') {
    const x = a.limitMoney?.amount ?? Infinity;
    const y = b.limitMoney?.amount ?? Infinity;
    return x === y ? 0 : x > y ? 1 : -1;
  }
  if (kind === 'units' || kind === 'percent') {
    const x = a.limitNumber ?? Infinity;
    const y = b.limitNumber ?? Infinity;
    return x === y ? 0 : x > y ? 1 : -1;
  }
  return 0;
}

/** The strongest of several limits for a display without an amount: authority first, then size. */
export function strongest<T extends { value: LimitValue }>(kind: LimitKind, items: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const it of items) {
    if (!best) {
      best = it;
      continue;
    }
    const r = AUTHORITY_RANK[it.value.authority] - AUTHORITY_RANK[best.value.authority];
    if (r > 0 || (r === 0 && compareSize(kind, it.value, best.value) > 0)) best = it;
  }
  return best;
}

/** The best limit for one amount: covers alone, then covers with a second reviewer, then the largest. */
export function bestFor<T extends { value: LimitValue }>(kind: LimitKind, mode: SecondMode, items: readonly T[], amt: Amount, asRequester: boolean): T | undefined {
  let best: T | undefined;
  let bestStanding = -1;
  for (const it of items) {
    const s = standing(kind, mode, it.value, amt, asRequester);
    if (s > bestStanding || (s === bestStanding && best && compareSize(kind, it.value, best.value) > 0)) {
      best = it;
      bestStanding = s;
    }
  }
  return best;
}

/* ---------------------------------------------------------------- display */

export function formatMoney(m: Money): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency }).format(m.amount / 100);
}

const formatNumber = (kind: LimitKind, n: number) => (kind === 'percent' ? `±${n}%` : `${n} units`);

/** "Up to $2,000.00 · second reviewer above $1,000.00", "No limit", "Recommend only", "Not permitted" */
export function limitSummary(kind: LimitKind, mode: SecondMode, v: LimitValue): string {
  if (v.authority === 'not_permitted') return 'Not permitted';
  if (v.authority === 'recommend_only') return 'Recommend only';
  const parts: string[] = [];
  if (kind === 'money') parts.push(v.limitMoney ? `Up to ${formatMoney(v.limitMoney)}` : 'No limit');
  else if (kind === 'units' || kind === 'percent') parts.push(v.limitNumber != null ? `Up to ${formatNumber(kind, v.limitNumber)}` : 'No limit');
  else parts.push('Permitted');
  if (v.authority === 'permitted_with_second_review' || mode === 'always') parts.push('always with a second reviewer');
  else if (kind === 'money' && v.secondReviewerAboveMoney) parts.push(`second reviewer above ${formatMoney(v.secondReviewerAboveMoney)}`);
  else if ((kind === 'units' || kind === 'percent') && v.secondReviewerAboveNumber != null) parts.push(`second reviewer above ${formatNumber(kind, v.secondReviewerAboveNumber)}`);
  return parts.join(' · ');
}

export function amountText(kind: LimitKind, amt: Amount): string {
  if (kind === 'money' && amt.money) return formatMoney(amt.money);
  if ((kind === 'units' || kind === 'percent') && amt.number != null) return formatNumber(kind, amt.number);
  return '';
}

/* ---------------------------------------------------------------- validation */

export interface Issue {
  path: string;
  message: string;
}

export function validateLimit(kind: LimitKind, v: LimitValue, path: string, currency: string): Issue[] {
  const issues: Issue[] = [];
  const money = (m: Money | null | undefined, field: string) => {
    if (!m) return;
    if (kind !== 'money') issues.push({ path: `${path}.${field}`, message: 'Only money actions take an amount' });
    else if (m.currency !== currency) issues.push({ path: `${path}.${field}`, message: `Use ${currency}` });
    else if (!Number.isSafeInteger(m.amount) || m.amount < 0) issues.push({ path: `${path}.${field}`, message: 'Amounts are whole minor units, zero or more' });
  };
  const num = (n: number | null | undefined, field: string) => {
    if (n == null) return;
    if (kind !== 'units' && kind !== 'percent') issues.push({ path: `${path}.${field}`, message: 'Only percent and units actions take a number' });
    else if (n < 0) issues.push({ path: `${path}.${field}`, message: 'Must be zero or more' });
  };
  money(v.limitMoney, 'limitMoney');
  money(v.secondReviewerAboveMoney, 'secondReviewerAboveMoney');
  num(v.limitNumber, 'limitNumber');
  num(v.secondReviewerAboveNumber, 'secondReviewerAboveNumber');
  if (!canApprove(v) && (v.limitMoney || v.limitNumber != null)) issues.push({ path: `${path}.authority`, message: 'A limit needs a permitted authority' });
  return issues;
}

/* ---------------------------------------------------------------- approval requests */

/** Limits in force when a request was created (approval_requests.limit_snapshot) */
export interface Snapshot {
  actionKey: string;
  limitKind: LimitKind;
  secondReviewer: SecondMode;
  /** roleKey → limit in force for this action */
  roles: Record<string, LimitValue>;
  /** The requester's best limit and the role it comes from */
  requester: { roleKey: string | null; value: LimitValue } | null;
  /** Only holders of these roles may decide (access.limits.change, access.delegations.approve, …) */
  restrictRoleKeys?: string[];
  /** Authority from a permission instead of limits (access.roles.sensitive-grant): holders of it or of these roles decide */
  permissionRule?: { permission: string; roleKeys: string[] };
}

export interface Candidate {
  accountId: string;
  /** Roles held now */
  roleKeys: readonly string[];
  /** Roles covered with delegated approval authority: roleKey → away person */
  delegated: Readonly<Record<string, string>>;
  /** For permission rules */
  hasPermission: boolean;
  /** Approval limits waiting for the Business Owner's review: may prepare, never approve */
  blocked: boolean;
}

export interface RequestState {
  requesterId: string;
  requesterCountsAsFirst: boolean;
  /** Approvals of the current round, in order; roleKeys[0] is the role whose authority was used */
  approvals: readonly { accountId: string; roleKeys: readonly string[] }[];
  amount: Amount;
}

export type Eligibility =
  | { ok: true; roleKey: string; viaDelegationFrom?: string; completes: boolean; stage: 'primary' | 'second' | 'rule' }
  | { ok: false; code: 'SELF_APPROVAL_NOT_ALLOWED' | 'ALREADY_APPROVED_BY_YOU' | 'NOT_ELIGIBLE_APPROVER'; reason: string };

const coversIn = (s: Snapshot, roleKey: string, amt: Amount) => {
  const v = s.roles[roleKey];
  return v ? covers(s.limitKind, v, amt) : false;
};

/** The approval that carries the authority: the requester (counts as first) or the first approver whose role covers */
export function primaryOf(s: Snapshot, st: RequestState): { by: 'requester' | 'approver'; value: LimitValue; index: number } | null {
  if (st.requesterCountsAsFirst && s.requester) return { by: 'requester', value: s.requester.value, index: -1 };
  for (const [i, a] of st.approvals.entries()) {
    const rk = a.roleKeys[0];
    if (rk && coversIn(s, rk, st.amount)) return { by: 'approver', value: s.roles[rk]!, index: i };
  }
  return null;
}

const needsSecondFor = (s: Snapshot, st: RequestState, p: NonNullable<ReturnType<typeof primaryOf>>) =>
  p.by === 'requester' ? requesterNeedsSecond(s.limitKind, s.secondReviewer, p.value, st.amount) : aboveSecondThreshold(s.limitKind, p.value, st.amount);

const allowedByRestriction = (s: Snapshot, roleKey: string) => !s.restrictRoleKeys?.length || s.restrictRoleKeys.includes(roleKey);

/** Roles that may give the second approval after `primary` */
function secondRoleOk(s: Snapshot, st: RequestState, primary: { value: LimitValue }, roleKey: string): boolean {
  if (!allowedByRestriction(s, roleKey)) return false;
  const listed = primary.value.secondReviewerRoleKeys;
  return listed.length ? listed.includes(roleKey) : coversIn(s, roleKey, st.amount);
}

export function isComplete(s: Snapshot, st: RequestState): boolean {
  if (s.permissionRule) return st.approvals.length > 0;
  const p = primaryOf(s, st);
  if (!p) return false;
  if (!needsSecondFor(s, st, p)) return true;
  return st.approvals.some((a, j) => j !== p.index && a.roleKeys[0] !== undefined && secondRoleOk(s, st, p, a.roleKeys[0]));
}

/** Roles that may decide the current step (for listings, notices and "who must approve") */
export function stepRoleKeys(s: Snapshot, st: RequestState): string[] {
  const all = Object.keys(s.roles);
  if (s.permissionRule) return s.restrictRoleKeys?.length ? [...s.restrictRoleKeys] : [...s.permissionRule.roleKeys];
  const p = primaryOf(s, st);
  if (!p) return all.filter((rk) => allowedByRestriction(s, rk) && coversIn(s, rk, st.amount));
  if (!needsSecondFor(s, st, p)) return [];
  const listed = p.value.secondReviewerRoleKeys;
  const keys = listed.length ? listed : all.filter((rk) => coversIn(s, rk, st.amount));
  return keys.filter((rk) => allowedByRestriction(s, rk));
}

/** Approvals by other people expected on the usual route (the Business Owner is the route of last resort). */
export function expectedApprovals(s: Snapshot, st: Pick<RequestState, 'amount' | 'requesterCountsAsFirst'>): number {
  if (s.permissionRule || st.requesterCountsAsFirst) return 1;
  const covering = Object.entries(s.roles).filter(([rk, v]) => allowedByRestriction(s, rk) && covers(s.limitKind, v, st.amount));
  const usual = covering.filter(([rk]) => rk !== 'business_owner');
  const route = usual.length ? usual : covering;
  if (!route.length) return 1;
  return route.some(([, v]) => !aboveSecondThreshold(s.limitKind, v, st.amount)) ? 1 : 2;
}

/** Whether a person may approve the request now, and with which role. */
export function evaluate(s: Snapshot, st: RequestState, c: Candidate): Eligibility {
  if (c.accountId === st.requesterId) return { ok: false, code: 'SELF_APPROVAL_NOT_ALLOWED', reason: 'Your own request' };
  if (st.approvals.some((a) => a.accountId === c.accountId)) return { ok: false, code: 'ALREADY_APPROVED_BY_YOU', reason: 'Already approved by you' };
  if (c.blocked) return { ok: false, code: 'NOT_ELIGIBLE_APPROVER', reason: "Your approval limits are waiting for the Business Owner's review" };

  // own roles first, then roles covered with delegated authority
  const options: { roleKey: string; from?: string }[] = [
    ...c.roleKeys.map((roleKey) => ({ roleKey })),
    ...Object.entries(c.delegated)
      .filter(([rk]) => !c.roleKeys.includes(rk))
      .map(([roleKey, from]) => ({ roleKey, from })),
  ];
  const pick = (ok: (rk: string) => boolean, rank: (rk: string) => number = () => 0) => {
    const fits = options.filter((o) => ok(o.roleKey));
    fits.sort((a, b) => rank(b.roleKey) - rank(a.roleKey) || Number(Boolean(a.from)) - Number(Boolean(b.from)));
    return fits[0];
  };

  if (s.permissionRule) {
    const rule = s.permissionRule;
    if (s.restrictRoleKeys?.length) {
      const o = pick((rk) => s.restrictRoleKeys!.includes(rk));
      return o ? { ok: true, roleKey: o.roleKey, viaDelegationFrom: o.from, completes: true, stage: 'rule' } : { ok: false, code: 'NOT_ELIGIBLE_APPROVER', reason: 'Needs the Business Owner' };
    }
    const o = pick((rk) => rule.roleKeys.includes(rk));
    if (o) return { ok: true, roleKey: o.roleKey, viaDelegationFrom: o.from, completes: true, stage: 'rule' };
    if (c.hasPermission && c.roleKeys[0]) return { ok: true, roleKey: c.roleKeys[0], completes: true, stage: 'rule' };
    return { ok: false, code: 'NOT_ELIGIBLE_APPROVER', reason: `Needs a staff member with ${rule.permission}` };
  }

  const p = primaryOf(s, st);
  if (!p) {
    const o = pick(
      (rk) => allowedByRestriction(s, rk) && coversIn(s, rk, st.amount),
      (rk) => standing(s.limitKind, s.secondReviewer, s.roles[rk]!, st.amount, false),
    );
    if (!o) {
      const any = options.some((x) => (s.roles[x.roleKey]?.authority ?? 'not_permitted') !== 'not_permitted');
      return { ok: false, code: 'NOT_ELIGIBLE_APPROVER', reason: any ? 'Above your limit' : 'Your role has no authority for this action' };
    }
    const next: RequestState = { ...st, approvals: [...st.approvals, { accountId: c.accountId, roleKeys: [o.roleKey] }] };
    return { ok: true, roleKey: o.roleKey, viaDelegationFrom: o.from, completes: isComplete(s, next), stage: 'primary' };
  }
  if (!needsSecondFor(s, st, p)) return { ok: false, code: 'NOT_ELIGIBLE_APPROVER', reason: 'No further approval is needed' };
  const o = pick((rk) => secondRoleOk(s, st, p, rk));
  if (!o) return { ok: false, code: 'NOT_ELIGIBLE_APPROVER', reason: 'Your role cannot give the second approval' };
  return { ok: true, roleKey: o.roleKey, viaDelegationFrom: o.from, completes: true, stage: 'second' };
}
