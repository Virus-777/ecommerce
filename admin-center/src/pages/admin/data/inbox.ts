// Data helpers for the staff notifications inbox (design: pages/admin/admin-inbox.html).
// Sources: GET notifications/inbox (view all | needs_my_action | mentions, area, unreadOnly, cursor),
// GET notifications/inbox/summary (counts, routing today), POST inbox/{id}/read, POST inbox/read-all,
// GET/PUT notifications/my-preferences, GET/POST access/approval-requests/{id}[/approve|/reject].
import type { components } from '@marketly/web-shared/api';
import { dayKey, screenHref } from '@/app/parts';

export type Notice = components['schemas']['notifications.Notice'];
export type InboxSummary = components['schemas']['notifications.StaffInboxSummary'];
export type ApprovalRequest = components['schemas']['access.ApprovalRequest'];

export type Tab = '' | 'needs-my-action' | 'mentions';
export const API_VIEW: Record<Tab, 'all' | 'needs_my_action' | 'mentions'> = { '': 'all', 'needs-my-action': 'needs_my_action', mentions: 'mentions' };
export const ALL_AREAS = 'All areas';

export type NoticeTone = 'danger' | 'warning' | 'info';
export const noticeTone = (t: Notice['tone']): NoticeTone => (t === 'danger' ? 'danger' : t === 'warning' || t === 'deal' ? 'warning' : 'info');

/** A notice needs me while it asks for action and is still open. */
export const needsMe = (n: Notice) => n.actionRequired && !n.resolvedAt && n.state !== 'expired';

/** "Routed to Seller Manager · Riley Chen (backup for Grace Kim)". */
export function routeText(n: Notice): string | undefined {
  const r = n.routedTo;
  if (!r) return undefined;
  const names = r.recipients.map((p) => (p.as === 'backup' ? `${p.name} (backup)` : p.as === 'lead' ? `${p.name} (lead)` : p.name)).join(', ');
  return `Routed to ${r.roleName}${names ? ` · ${names}` : ''}${r.coveringFor ? `, covering for ${r.coveringFor}` : ''}`;
}

/** Where a notice's action button goes in this app (detail screens need the record's ref or id). */
export function noticeHref(n: Notice): string | undefined {
  const l = n.link;
  if (l.url) return l.url;
  const key = l.ref ?? l.id;
  return screenHref(l.screen, undefined, { ref: key, id: l.id, key, slug: key }) ?? screenHref(l.screen);
}

/** Notices grouped as the design does: today, then earlier. */
export function byDay(items: Notice[], now = new Date()): Array<{ key: string; label: string; rows: Notice[] }> {
  const today = dayKey(now);
  const label = `Today · ${now.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric' })}`;
  const t = items.filter((n) => dayKey(n.createdAt) === today);
  const e = items.filter((n) => dayKey(n.createdAt) !== today);
  return [
    { key: 'today', label, rows: t },
    { key: 'earlier', label: 'Earlier', rows: e },
  ].filter((g) => g.rows.length > 0);
}

export const APPROVAL_STATUS: Record<ApprovalRequest['status'], string> = {
  pending: 'Waiting for approval',
  partially_approved: 'First approval recorded, second reviewer needed',
  approved: 'Approved',
  rejected: 'Rejected',
  returned: 'Sent back to the requester',
  cancelled: 'Withdrawn',
  expired: 'Expired',
};
