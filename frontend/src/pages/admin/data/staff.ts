import { staffRoles } from '@/data/fixtures';
import type { IconName } from '@/ui';

// Design: pages/admin/admin-staff.html and admin-staff--edit-role.html.

export interface Role {
  role: string;
  area: string;
  /** Lead (first) and other holders. */
  people: string[];
  backup: string;
  limit: string;
}

const BACKUP: Record<string, string> = {
  'Business Owner': 'Dana Ortiz',
  'Platform Administrator': 'Mei Lin',
  'Official Store Manager': 'Ken Watanabe',
  'Purchasing Manager': 'Dana Ortiz',
  'Inventory Manager': 'Theo Grant',
  'Warehouse Manager': 'Theo Grant',
  'Order Manager': 'Ana Silva',
  'Shipping Manager': 'Ana Silva',
  'Returns Manager': 'Isabel Cruz',
  'Catalog Manager': 'Noor Aziz',
  'Seller Manager': 'Sven Larsen',
  'Customer Support Manager': 'Lena Park',
  'Finance Manager': 'Morgan Hale',
  'Marketing Manager': 'Dana Ortiz',
  'Advertising Manager': 'Noor Aziz',
  'Content Manager': 'Jamie Brooks',
  'Trust and Risk Manager': 'Grace Kim',
  'Reports Analyst': 'Riley Chen',
};

export const ROLES: Role[] = staffRoles.map((r) => ({ ...r, backup: BACKUP[r.role] ?? '—' }));

/** Roles that are not management roles but can be given in an invitation. */
export const STAFF_ROLES = ['Warehouse worker', 'Finance staff', 'Support agent'];

export interface StaffMember {
  name: string;
  email: string;
  roles: string[];
  lastActive: string;
  status: 'Active' | 'Invited';
  /** Invitations only. */
  invited?: string;
}

const active = (name: string, roles: string[], lastActive: string): StaffMember => ({
  name,
  email: `${name.toLowerCase().replace(' ', '.')}@marketly.example`,
  roles,
  lastActive,
  status: 'Active',
});

export const STAFF: StaffMember[] = [
  active('Morgan Hale', ['Business Owner'], 'Today 9:41 AM'),
  active('Riley Chen', ['Platform Administrator'], 'Active now'),
  active('Dana Ortiz', ['Official Store Manager'], 'Today 8:55 AM'),
  active('Ken Watanabe', ['Purchasing Manager'], 'Yesterday'),
  active('Ana Silva', ['Inventory Manager', 'Warehouse Manager'], 'Active now'),
  active('Theo Grant', ['Order Manager', 'Shipping Manager'], 'Active now'),
  active('Lena Park', ['Returns Manager'], 'Today 7:58 AM'),
  active('Omar Haddad', ['Catalog Manager'], 'Today 9:02 AM'),
  active('Grace Kim', ['Seller Manager'], 'Today 8:47 AM'),
  active('Isabel Cruz', ['Customer Support Manager'], 'Active now'),
  active('Priya Nair', ['Finance Manager'], 'Active now'),
  active('Jamie Brooks', ['Marketing Manager', 'Advertising Manager'], 'Yesterday'),
  active('Noor Aziz', ['Content Manager'], 'Oct 6'),
  active('Sven Larsen', ['Trust and Risk Manager'], 'Today 8:50 AM'),
  active('Mei Lin', ['Reports Analyst'], 'Today 9:15 AM'),
  { name: 'Carlos Mendez', email: 'carlos.mendez@marketly.example', roles: ['Warehouse worker'], lastActive: 'Not signed in', status: 'Invited', invited: 'Oct 7' },
  { name: 'Hannah Wu', email: 'hannah.wu@marketly.example', roles: ['Finance staff'], lastActive: 'Not signed in', status: 'Invited', invited: 'Oct 7' },
];

export const MANAGERS = ['Theo Grant', 'Ana Silva', 'Priya Nair', 'Isabel Cruz', 'Lena Park'];

export interface Gap {
  title: string;
  sub: string;
  status: string;
  tone: 'warning' | 'success' | 'info';
}

export const GAPS: Gap[] = [
  { title: 'Theo Grant leads 2 roles', sub: 'Order Manager and Shipping Manager share one backup (Ana Silva)', status: 'Review', tone: 'warning' },
  { title: 'Jamie Brooks leads 2 roles', sub: 'Marketing and Advertising, different backups', status: 'OK', tone: 'success' },
  { title: 'Warehouse workers', sub: '1 active, 1 invited for Reno, NV', status: 'Invited', tone: 'info' },
];

/* ---------------- Edit role ---------------- */

export interface PermArea {
  title: string;
  icon: IconName;
  actions: string[];
  note?: { icon: IconName; text: string };
}

export const PERM_AREAS: PermArea[] = [
  {
    title: 'Finance',
    icon: 'landmark',
    actions: ['View payments, balances and statements', 'Approve refunds within limit', 'Place and release seller holds', 'Release payout runs', 'Record financial corrections with a reason', 'Change seller payout destinations'],
    note: { icon: 'lock', text: 'Payout destination changes always need verification by a second person and are not part of this role.' },
  },
  { title: 'Orders and shipping', icon: 'truck', actions: ['View orders, seller groups and shipments', 'Cancel items', 'Open carrier claims'] },
  { title: 'Returns and cases', icon: 'undo-2', actions: ['View return and dispute cases', 'Decide return eligibility', 'Approve refund without return'] },
  { title: 'Sellers', icon: 'store', actions: ['View seller accounts and statements', 'Restrict or suspend sellers'] },
  { title: 'Catalog and content', icon: 'package', actions: ['View products and offers', 'Publish, hide or suspend products'] },
  { title: 'Reports', icon: 'chart-column', actions: ['View finance and commerce reports', 'Export reports'] },
  {
    title: 'Settings and staff',
    icon: 'settings',
    actions: ['Change fee and payout settings', 'Manage staff accounts and roles'],
    note: { icon: 'info', text: 'Fee and payout settings are proposed by the Platform Administrator and approved by the Business Owner.' },
  },
];

export interface LimitDef {
  title: string;
  sub: string;
  limitLabel: string;
}

export const LIMITS: LimitDef[] = [
  { title: 'Payouts', sub: 'Release payout runs', limitLabel: 'Limit per run' },
  { title: 'Refunds', sub: 'Approve customer refunds and refund overrides', limitLabel: 'Limit per refund' },
  { title: 'Holds', sub: 'Place or release seller balance holds', limitLabel: 'Limit per hold' },
];

export interface AuthorityDef {
  id: string;
  title: string;
  sub: string;
  hint?: string;
}

export const AUTHORITIES: AuthorityDef[] = [
  { id: 'er-restr', title: 'Seller restrictions', sub: 'Restrict or suspend a seller account', hint: 'Owned by Seller Manager' },
  { id: 'er-pub', title: 'Publication overrides', sub: 'Publish or restore content against a review decision' },
];

export const AUTHORITY_OPTIONS = ['Not permitted', 'Recommend only', 'Permitted', 'Permitted with second review'];
export const SECOND_REVIEWERS = ['Morgan Hale, Business Owner', 'Hannah Wu, Finance staff (after onboarding)'];

export interface RoleDraft {
  perms: boolean[][];
  limits: Array<{ limit: string; review: string }>;
  authorities: string[];
  second: boolean;
  secondWho: string;
  reason: string;
  effective: string;
}

/** The Finance Manager draft shown in the design's edit-role view. */
export const FINANCE_DRAFT: RoleDraft = {
  perms: [
    [true, true, true, true, true, false],
    [true, false, false],
    [true, false, true],
    [true, false],
    [true, false],
    [true, true],
    [false, false],
  ],
  limits: [
    { limit: '50,000', review: '25,000' },
    { limit: '2,000', review: '1,000' },
    { limit: '10,000', review: '5,000' },
  ],
  authorities: ['Recommend only', 'Not permitted'],
  second: true,
  secondWho: SECOND_REVIEWERS[0],
  reason: 'Raise refund limit from $1,500 to $2,000 to cover monitor and furniture returns without waiting for a second review.',
  effective: 'Oct 12, 2026',
};

/** Starting point for roles the design does not detail: view access in every area, no limits changed. */
export const defaultDraft = (): RoleDraft => ({
  ...FINANCE_DRAFT,
  perms: PERM_AREAS.map((a) => a.actions.map((_, i) => i === 0 && a.title !== 'Settings and staff')),
  authorities: ['Not permitted', 'Not permitted'],
  reason: '',
});

/** People holding a role, where the design states it (the lead plus staff covering it). */
export const HOLDERS: Record<string, number> = { 'Finance Manager': 2 };
