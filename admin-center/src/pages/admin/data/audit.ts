import { actorLabel } from '@/app/parts';
import { useQuery } from '@tanstack/react-query';
import { call, useApi, type components } from '@marketly/web-shared/api';
import type { ScreenId } from '@marketly/web-shared/routes';
import type { IconName, TimelineEvent } from '@marketly/web-shared/ui';

// Action history (admin/audit, design: pages/admin/admin-audit.html; admin/audit-entry, designed in React),
// from the audit API: append-only entries with filters, one entry with before/after, retention.

type S = components['schemas'];
export type AuditEntry = S['audit.AuditEntry'];
export type AuditTarget = S['audit.AuditTarget'];
export type AuditCategory = AuditEntry['category'];
export type ApprovalState = AuditEntry['approval']['state'];

/** Target types the list filter offers (label → API target type). */
export const TARGET_FILTERS: Array<{ label: string; type?: string }> = [
  { label: 'All targets' },
  { label: 'Orders', type: 'order' },
  { label: 'Sellers', type: 'seller' },
  { label: 'Products', type: 'product' },
  { label: 'Payouts', type: 'payout_run' },
  { label: 'Settings', type: 'setting' },
  { label: 'Staff', type: 'staff' },
];

const TARGET_META: Record<string, { label: string; icon: IconName; screen?: ScreenId }> = {
  order: { label: 'Order', icon: 'shopping-bag', screen: 'admin/order' },
  order_item: { label: 'Order item', icon: 'shopping-bag' },
  seller: { label: 'Seller', icon: 'store', screen: 'admin/sellers' },
  product: { label: 'Product', icon: 'package', screen: 'admin/catalog' },
  offer: { label: 'Offer', icon: 'tag' },
  payout: { label: 'Payout', icon: 'wallet', screen: 'admin/payouts' },
  payout_run: { label: 'Payout run', icon: 'wallet', screen: 'admin/payouts' },
  hold: { label: 'Hold', icon: 'lock', screen: 'admin/finance' },
  refund: { label: 'Refund', icon: 'undo-2', screen: 'admin/returns' },
  return: { label: 'Return', icon: 'undo-2', screen: 'admin/returns' },
  case: { label: 'Case', icon: 'life-buoy', screen: 'admin/case' },
  setting: { label: 'Setting', icon: 'settings', screen: 'admin/settings' },
  setting_change: { label: 'Setting change', icon: 'settings', screen: 'admin/settings' },
  role: { label: 'Role', icon: 'users', screen: 'admin/staff' },
  staff: { label: 'Staff', icon: 'users', screen: 'admin/staff' },
  customer: { label: 'Customer', icon: 'user-round', screen: 'admin/customers' },
  campaign: { label: 'Campaign', icon: 'megaphone', screen: 'admin/promotions' },
};
export const targetMeta = (type: string) => TARGET_META[type] ?? { label: type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), icon: 'file-text' as IconName };

export const APPROVAL_LABEL: Record<ApprovalState, string> = {
  not_required: 'Not required',
  pending: 'Pending',
  partially_approved: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  returned: 'Returned',
  cancelled: 'Cancelled',
  expired: 'Expired',
};
export const isPending = (e: AuditEntry) => e.approval.state === 'pending' || e.approval.state === 'partially_approved';

/** Staff for the "All staff" filter (account id → name); a picker, so it needs access.roles.view. */
export function useStaffOptions(enabled = true): Map<string, string> {
  const { api } = useApi();
  const q = useQuery({ queryKey: ['access', 'members'], queryFn: () => call(api.GET('/api/admin/access/members', { params: { query: { limit: 100 } } })), enabled, staleTime: 5 * 60_000, retry: false });
  return new Map((q.data?.items ?? []).map((m) => [m.account.id, m.account.displayName]));
}

/** The actor's name as recorded (G70); records from before names were recorded fall back to the actor kind. */
export { actorLabel };
export const rolesLabel = (e: AuditEntry) => e.actorRoles.map((r) => r.name).join(', ') || (e.actor.kind === 'staff' ? 'Staff' : e.actor.kind === 'system' ? 'System' : e.actor.kind.replace(/^./, (c) => c.toUpperCase()));

/** "Oct 8, 2026, 10:05 AM PT" style label pieces come from the shared Pacific-time helpers. */
export function approvalSteps(e: AuditEntry, fmt: (iso: string) => string): TimelineEvent[] {
  if (e.approval.steps.length) {
    return e.approval.steps.map((s, i) => ({ t: s.label, d: fmt(s.at), body: s.detail ?? undefined, state: i === e.approval.steps.length - 1 && isPending(e) ? 'current' : 'done' }));
  }
  if (isPending(e)) return [{ t: 'Requested', d: fmt(e.at), state: 'done' }, { t: e.approval.note ?? 'Waiting for a second reviewer', d: 'Not yet reviewed', state: 'current' }];
  return [{ t: 'Recorded', d: fmt(e.at), state: 'done', body: e.approval.state === 'not_required' ? `No second review${e.approval.note ? `: ${e.approval.note}` : ' needed'}` : (e.approval.note ?? undefined) }];
}

export interface FieldChange {
  field: string;
  label: string;
  before: string | null;
  after: string | null;
}

const show = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const m = v as { amount?: unknown; currency?: unknown };
  if (typeof m.amount === 'number' && typeof m.currency === 'string') return (m.amount / 100).toLocaleString('en-US', { style: 'currency', currency: m.currency });
  return JSON.stringify(v);
};
const labelOf = (field: string) => field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** The fields that changed between before and after (top-level keys), plus the entry's own change text. */
export function fieldChanges(e: AuditEntry): FieldChange[] {
  const b = (e.before ?? {}) as Record<string, unknown>;
  const a = (e.after ?? {}) as Record<string, unknown>;
  const objects = typeof b === 'object' && typeof a === 'object' && !Array.isArray(b) && !Array.isArray(a);
  const out: FieldChange[] = [];
  if (objects) {
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
      const bv = show(b[k]);
      const av = show(a[k]);
      if (bv !== av) out.push({ field: k, label: labelOf(k), before: bv, after: av });
    }
  } else if (e.before != null || e.after != null) {
    out.push({ field: 'value', label: 'Value', before: show(e.before), after: show(e.after) });
  }
  if (!out.length && (e.change.before || e.change.after)) out.push({ field: 'change', label: 'Change', before: e.change.before ?? null, after: e.change.after ?? null });
  return out;
}

/** Link to the screen that opens an entry's target (detail screens by ref where the route takes one). */
export function targetHref(t: AuditTarget, screenHref: (screen?: string | null, state?: string | null, params?: Record<string, string>) => string | undefined): string | undefined {
  if (t.type === 'order' && t.ref) return screenHref('admin/order', null, { ref: t.ref });
  if (t.type === 'case' && t.ref) return screenHref('admin/case', null, { ref: t.ref });
  return screenHref(t.screen ?? targetMeta(t.type).screen);
}
