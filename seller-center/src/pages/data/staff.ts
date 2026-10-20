import type { components } from '@marketly/web-shared/api';
import type { IconName } from '@marketly/web-shared/ui';

// Staff and permissions (seller/staff): API types and the mappings between the API's permission catalogue
// (GET sellers/roles) and the design's permission matrix and notification table.

export type Member = components['schemas']['sellers.SellerMember'];
export type PermissionEntry = components['schemas']['sellers.PermissionEntry'];
export type MemberPreference = components['schemas']['notifications.MemberPreference'];
export type StaffRole = Exclude<Member['role'], 'owner'>;
export type Channel = MemberPreference['channel'];

export type Level = 'full' | 'view' | 'none' | 'lock';

/** Matrix rows: permission areas of the catalogue, in the design's order and wording. */
export const MATRIX_AREAS: Array<{ area: PermissionEntry['area']; label: string }> = [
  { area: 'products', label: 'Products' },
  { area: 'inventory', label: 'Inventory' },
  { area: 'orders_shipping', label: 'Orders and shipping' },
  { area: 'returns', label: 'Returns' },
  { area: 'customers', label: 'Customers' },
  { area: 'finance', label: 'Finance (view)' },
  { area: 'payouts', label: 'Payout changes' },
];

export const LEVEL: Record<Level, { icon: IconName; text?: string }> = {
  full: { icon: 'check', text: 'Manage' },
  view: { icon: 'eye', text: 'View' },
  none: { icon: 'minus' },
  lock: { icon: 'lock', text: 'Owner only' },
};

/** A member's access to one area: Manage if any manage permission of the area, View if any view one. */
export function levelOf(m: Member, area: PermissionEntry['area'], catalogue: PermissionEntry[]): Level {
  if (m.isOwner) return area === 'payouts' ? 'lock' : 'full';
  const held = catalogue.filter((p) => p.area === area && m.permissions.includes(p.key));
  if (held.some((p) => p.level === 'manage')) return 'full';
  if (held.length) return 'view';
  return 'none';
}

/** Notification columns: topic groups (GET notifications/preferences) in the design's order. */
export const NOTE_COLS: Array<{ key: string; label: string }> = [
  { key: 'new_orders', label: 'New orders' },
  { key: 'dispatch_overdue', label: 'Dispatch overdue' },
  { key: 'returns_cases', label: 'Returns and cases' },
  { key: 'customer_messages', label: 'Customer messages' },
  { key: 'payouts_holds', label: 'Payouts and holds' },
];

export const CHANNELS: Array<{ value: Channel; label: string }> = [
  { value: 'in_app', label: 'In-app' },
  { value: 'in_app_and_email', label: 'In-app and email' },
  { value: 'email', label: 'Email' },
];

export const MEMBER_STATUS: Record<Member['status'], string> = {
  invited: 'Invited',
  active: 'Active',
  suspended: 'Suspended',
  removed: 'Removed',
  expired: 'Expired',
  revoked: 'Revoked',
};

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
