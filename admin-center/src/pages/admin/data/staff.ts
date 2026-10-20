import { fromZonedInput } from '@marketly/web-shared/lib/dates';
import type { components } from '@marketly/web-shared/api';
import type { IconName } from '@marketly/web-shared/ui';

// Staff and roles (design: pages/admin/admin-staff.html and admin-staff--edit-role.html), from the access API:
// roles, members, coverage, away periods, the role editor (permissions by area, approval limits) and limit changes.

type S = components['schemas'];
export type Role = S['access.Role'];
export type RoleDetail = S['access.RoleDetail'];
export type StaffMember = S['access.StaffMember'];
export type Coverage = S['access.Coverage'];
export type CoverageGap = S['access.CoverageGap'];
export type AwayPeriod = S['access.AwayPeriod'];
export type ApprovalLimit = S['access.ApprovalLimit'];
export type LimitValue = S['access.LimitValue'];
export type LimitChange = S['access.LimitChange'];
export type PermissionGroup = S['access.PermissionGroup'];

/** Permission areas on the role editor and the design's icon for each. */
const AREA_ICON: Record<string, IconName> = {
  Finance: 'landmark',
  'Orders and shipping': 'truck',
  'Returns and cases': 'undo-2',
  Sellers: 'store',
  'Catalog and offers': 'package',
  Reports: 'chart-column',
  Settings: 'settings',
  'Staff and access': 'users',
  Advertising: 'megaphone',
  Audit: 'history',
  'Customers and support': 'life-buoy',
  'Inventory and warehouse': 'warehouse',
  'Marketing and content': 'file-text',
  Notifications: 'bell',
  'Official store': 'shopping-bag',
  'Trust and reviews': 'shield',
  'Work queues': 'inbox',
};
export const areaIcon = (area: string): IconName => AREA_ICON[area] ?? 'settings';

export const AUTHORITY_OPTIONS: Array<{ value: LimitValue['authority']; label: string }> = [
  { value: 'not_permitted', label: 'Not permitted' },
  { value: 'recommend_only', label: 'Recommend only' },
  { value: 'permitted', label: 'Permitted' },
  { value: 'permitted_with_second_review', label: 'Permitted with second review' },
];

export const MEMBER_STATUS: Record<StaffMember['status'], string> = { invited: 'Invited', active: 'Active', locked: 'Locked', disabled: 'Disabled' };

export const GAP_TONE: Record<CoverageGap['severity'], 'danger' | 'warning' | 'success'> = { critical: 'danger', review: 'warning', ok: 'success' };
export const GAP_STATUS: Record<CoverageGap['severity'], string> = { critical: 'Gap', review: 'Review', ok: 'OK' };

/** Minor units → the text in a "$" field (1250000 → "12,500"). */
export const moneyField = (amount?: number | null) => (amount == null ? '' : (amount / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }));
/** "$" field text → minor units (null when empty, NaN when not a number). */
export const parseMoneyField = (s: string): number | null => {
  const t = s.replace(/[,$\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
};
export const numberField = (n?: number | null) => (n == null ? '' : String(n));
export const parseNumberField = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

/** The editable form of one approval limit. */
export interface LimitDraft {
  id: string;
  actionKey: string;
  title: string;
  summary: string;
  kind: 'money' | 'units' | 'percent' | 'none';
  authority: LimitValue['authority'];
  limit: string;
  review: string;
  secondReviewerRoleKeys: string[];
}

export function limitDraft(l: ApprovalLimit): LimitDraft {
  const money = l.action.limit === 'money';
  return {
    id: l.id,
    actionKey: l.action.key,
    title: l.action.label,
    summary: l.summary,
    kind: l.action.limit,
    authority: l.value.authority,
    limit: money ? moneyField(l.value.limitMoney?.amount) : numberField(l.value.limitNumber),
    review: money ? moneyField(l.value.secondReviewerAboveMoney?.amount) : numberField(l.value.secondReviewerAboveNumber),
    secondReviewerRoleKeys: l.value.secondReviewerRoleKeys,
  };
}

/** The LimitValue a draft row asks for (throws on a field that isn't a number). */
export function limitValue(d: LimitDraft, currency = 'USD'): LimitValue {
  const v: LimitValue = { authority: d.authority, secondReviewerRoleKeys: d.secondReviewerRoleKeys };
  if (d.kind === 'none') return v;
  if (d.kind === 'money') {
    const lim = parseMoneyField(d.limit);
    const rev = parseMoneyField(d.review);
    if (Number.isNaN(lim) || Number.isNaN(rev)) throw new Error(`Enter amounts in dollars for “${d.title}”.`);
    v.limitMoney = lim == null ? null : { amount: lim, currency };
    v.secondReviewerAboveMoney = rev == null ? null : { amount: rev, currency };
  } else {
    const lim = parseNumberField(d.limit);
    const rev = parseNumberField(d.review);
    if (Number.isNaN(lim) || Number.isNaN(rev)) throw new Error(`Enter numbers for “${d.title}”.`);
    v.limitNumber = lim;
    v.secondReviewerAboveNumber = rev;
  }
  return v;
}

export const sameLimit = (a: LimitDraft, b: LimitDraft) => a.authority === b.authority && a.limit === b.limit && a.review === b.review;

/** Granted permission keys of a role detail. */
export const grantedKeys = (groups: PermissionGroup[]) => groups.flatMap((g) => g.permissions.filter((p) => p.granted).map((p) => p.permission.key));

/** Today in Pacific time, YYYY-MM-DD. */
export const todayKey = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

/** An effective date (YYYY-MM-DD) as the instant the API takes: a minute from now for today, else the start of that Pacific day. */
export function effectiveInstant(day: string): string {
  if (day <= todayKey()) return new Date(Date.now() + 60_000).toISOString();
  return fromZonedInput(`${day}T00:00`) ?? new Date(Date.now() + 60_000).toISOString();
}
