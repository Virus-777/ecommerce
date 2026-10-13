// Sample data for admin/audit (design: pages/admin/admin-audit.html) and admin/audit-entry (designed in React).
// Shaped like the action history API: one append-only record per material change. Replaced by the API later.
import type { ScreenId } from '@marketly/web-shared/routes';
import type { IconName, TimelineEvent } from '@marketly/web-shared/ui';

export type AuditTarget = 'Orders' | 'Sellers' | 'Products' | 'Payouts' | 'Settings' | 'Staff';
export type AuditApproval = 'Approved' | 'Pending' | 'Not required';
export type AuditTag = 'financial' | 'enforcement' | 'settings';
export type AuditOutcome = 'Succeeded' | 'Pending approval' | 'Failed';
export type AuditApp = 'Admin Center' | 'Operations Center' | 'Seller Center' | 'API';

export interface FieldChange {
  /** Machine field name, as the API returns it. */
  field: string;
  /** Readable label. */
  label: string;
  before: string | null;
  after: string | null;
}

export interface AuditEntry {
  /** Stable entry ID: AE-<yymmdd>-<hhmm> of the PT time (a sequence suffix is added when two share a minute). */
  id: string;
  /** ISO time with the PT offset. */
  at: string;
  day: string;
  time: string;
  staff: string;
  role: string;
  action: string;
  /** Machine action name. */
  code: string;
  outcome: AuditOutcome;
  /** Readable sentence after the actor: "released a payout hold for Casa Verde Home". */
  phrase: string;
  target: AuditTarget;
  ref: string;
  sub: string;
  /** Who owns the target (seller, customer, team). */
  owner: string;
  reason: string;
  before: string;
  after: string;
  approval: AuditApproval;
  approvalNote: string;
  /** Second reviewer, when one approved. */
  approver?: { name: string; role: string; at: string; limit: string };
  tags: AuditTag[];
  origin: { app: AuditApp; ip: string; location: string; device: string };
  requestId: string;
  tokenId: string;
  changes: FieldChange[];
  extra?: Array<[string, string]>;
  history?: TimelineEvent[];
}

export const TARGET: Record<AuditTarget, { label: string; icon: IconName; to: ScreenId }> = {
  Payouts: { label: 'Payout', icon: 'wallet', to: 'admin/payouts' },
  Products: { label: 'Product', icon: 'package', to: 'admin/catalog' },
  Sellers: { label: 'Seller', icon: 'store', to: 'admin/seller' },
  Orders: { label: 'Order', icon: 'shopping-bag', to: 'admin/order' },
  Staff: { label: 'Staff', icon: 'user-cog', to: 'admin/staff' },
  Settings: { label: 'Setting', icon: 'settings', to: 'admin/settings' },
};

const ADMIN = (device: string, ip = '203.0.113.24', location = 'Seattle, WA, US') => ({ app: 'Admin Center' as const, ip, location, device });

/** Page 1 of the action history list (newest first). */
export const ENTRIES: AuditEntry[] = [
  {
    id: 'AE-261008-0932', at: '2026-10-08T09:32:00-07:00', day: 'Oct 8', time: '9:32 AM', staff: 'Priya Nair', role: 'Finance Manager', action: 'Released payout hold', code: 'payout.hold.release', outcome: 'Succeeded',
    phrase: 'released a payout hold for Casa Verde Home', target: 'Payouts', ref: 'PO-261009-0418', sub: 'Casa Verde Home', owner: 'Casa Verde Home (seller) · Finance',
    reason: 'Carrier confirmed delivery for disputed order MK-260921-18320', before: 'Held $1,240.00', after: 'Available $1,240.00', approval: 'Approved', approvalNote: 'Morgan Hale, 9:41 AM',
    approver: { name: 'Morgan Hale', role: 'Business Owner', at: 'Oct 8, 9:41 AM PT', limit: 'Releases above $1,000 need a second reviewer. Priya Nair can release up to $1,000 alone.' },
    tags: ['financial'], origin: ADMIN('Chrome 129 on macOS · managed laptop ML-0214'), requestId: 'req_7Hq2LmX9aP4c', tokenId: 'tkn_adm_01J9Z4K7QW2M',
    changes: [
      { field: 'hold.status', label: 'Hold status', before: 'held', after: 'released' },
      { field: 'balance.held', label: 'Held balance', before: '$1,240.00', after: '$0.00' },
      { field: 'balance.available', label: 'Available balance', before: '$0.00', after: '$1,240.00' },
      { field: 'hold.release_reason', label: 'Release reason', before: null, after: 'Carrier confirmed delivery for disputed order MK-260921-18320' },
    ],
    extra: [['Hold placed', 'Sep 29 · review date Oct 9'], ['Evidence', 'UPS proof of delivery, case CS-260930-1172']],
    history: [
      { t: 'Requested by Priya Nair', d: 'Oct 8, 9:32 AM', state: 'done', body: 'Above $1,000 threshold, second review required' },
      { t: 'Approved by Morgan Hale, Business Owner', d: 'Oct 8, 9:41 AM', state: 'done' },
      { t: 'Included in payout run', d: 'Fri, Oct 9, 10:00 AM PT', state: 'current', body: 'Approved is not paid. Status shows Paid only after the bank confirms.' },
    ],
  },
  {
    id: 'AE-261008-0905', at: '2026-10-08T09:05:00-07:00', day: 'Oct 8', time: '9:05 AM', staff: 'Ana Silva', role: 'Inventory Manager', action: 'Stock adjustment', code: 'inventory.stock.adjust', outcome: 'Succeeded',
    phrase: 'moved 2 units of Pellar Cast Iron Skillet to Damaged', target: 'Products', ref: 'PLR-CI26', sub: 'Pellar Cast Iron Skillet', owner: 'Official Store · Inventory',
    reason: 'Damaged in receiving, PUR-2610-0039', before: 'Available 79', after: 'Available 77, Damaged 2', approval: 'Not required', approvalNote: 'Under 50 units', tags: [],
    origin: { app: 'Operations Center', ip: '198.51.100.40', location: 'Reno, NV, US · warehouse network', device: 'Zebra TC52 handheld · Android 13' }, requestId: 'req_2Kd8VnR4tB1x', tokenId: 'tkn_ops_01J9Z3W1HC7E',
    changes: [
      { field: 'stock.available', label: 'Available', before: '79', after: '77' },
      { field: 'stock.damaged', label: 'Damaged', before: '0', after: '2' },
      { field: 'adjustment.source', label: 'Source document', before: null, after: 'PUR-2610-0039' },
    ],
  },
  {
    id: 'AE-261008-0847', at: '2026-10-08T08:47:00-07:00', day: 'Oct 8', time: '8:47 AM', staff: 'Grace Kim', role: 'Seller Manager', action: 'Restricted seller', code: 'seller.status.restrict', outcome: 'Succeeded',
    phrase: 'restricted Gadget Grove', target: 'Sellers', ref: 'Gadget Grove', sub: 'New sales paused', owner: 'Gadget Grove (seller) · Seller Manager',
    reason: 'Late dispatch 11% over 30 days, target under 4%', before: 'Approved', after: 'Restricted', approval: 'Approved', approvalNote: 'Sven Larsen, 8:52 AM',
    approver: { name: 'Sven Larsen', role: 'Trust and Risk Manager', at: 'Oct 8, 8:52 AM PT', limit: 'Seller restrictions need Trust and Risk sign-off.' },
    tags: ['enforcement'], origin: ADMIN('Edge 129 on Windows 11 · managed laptop ML-0188', '203.0.113.31', 'Portland, OR, US'), requestId: 'req_9Wm3QeT6yN2p', tokenId: 'tkn_adm_01J9Z2PB5R4S',
    changes: [
      { field: 'seller.status', label: 'Seller status', before: 'approved', after: 'restricted' },
      { field: 'seller.can_accept_new_orders', label: 'Accepts new orders', before: 'true', after: 'false' },
      { field: 'seller.restriction_review_date', label: 'Review date', before: null, after: '2026-10-22' },
    ],
  },
  {
    id: 'AE-261007-1812', at: '2026-10-07T18:12:00-07:00', day: 'Oct 7', time: '6:12 PM', staff: 'Isabel Cruz', role: 'Customer Support Manager', action: 'Goodwill credit', code: 'order.goodwill_credit.create', outcome: 'Succeeded',
    phrase: 'gave Jordan Lee a $15.00 goodwill credit', target: 'Orders', ref: 'MK-261002-55410', sub: 'Jordan Lee', owner: 'Jordan Lee (customer) · sold by Casa Verde Home',
    reason: 'Delivery 4 days late, seller Casa Verde Home', before: '$0.00', after: '$15.00 credit', approval: 'Not required', approvalNote: 'Within $50 limit', tags: ['financial'],
    origin: ADMIN('Chrome 129 on Windows 11 · managed laptop ML-0102', '203.0.113.52', 'Austin, TX, US'), requestId: 'req_4Ty7HbW2cL8v', tokenId: 'tkn_adm_01J9X8DE3F6G',
    changes: [
      { field: 'customer.credit_balance', label: 'Store credit', before: '$0.00', after: '$15.00' },
      { field: 'credit.funded_by', label: 'Funded by', before: null, after: 'platform' },
    ],
  },
  {
    id: 'AE-261007-1640', at: '2026-10-07T16:40:00-07:00', day: 'Oct 7', time: '4:40 PM', staff: 'Omar Haddad', role: 'Catalog Manager', action: 'Suspended offer', code: 'catalog.offer.suspend', outcome: 'Succeeded',
    phrase: "suspended Gadget Grove's offer for Brightline S2", target: 'Products', ref: 'BRL-S2', sub: 'Gadget Grove offer', owner: 'Gadget Grove (seller) · Catalog',
    reason: 'Counterfeit report TR-261007-004 under review', before: 'Active', after: 'Suspended', approval: 'Not required', approvalNote: 'Catalog role', tags: ['enforcement'],
    origin: ADMIN('Firefox 131 on Ubuntu · managed laptop ML-0230', '203.0.113.24', 'Seattle, WA, US'), requestId: 'req_6Pz1KfJ8sD3m', tokenId: 'tkn_adm_01J9X5MN8P2Q',
    changes: [
      { field: 'offer.status', label: 'Offer status', before: 'active', after: 'suspended' },
      { field: 'offer.visible_in_search', label: 'Visible in search', before: 'true', after: 'false' },
      { field: 'offer.suspension_case', label: 'Linked report', before: null, after: 'TR-3391' },
    ],
  },
  {
    id: 'AE-261007-1518', at: '2026-10-07T15:18:00-07:00', day: 'Oct 7', time: '3:18 PM', staff: 'Priya Nair', role: 'Finance Manager', action: 'Refund without return', code: 'order.refund.approve_without_return', outcome: 'Pending approval',
    phrase: 'approved a $329.00 refund without return on order MK-260930-21877', target: 'Orders', ref: 'MK-260930-21877', sub: 'Kestrel 27" Monitor', owner: 'Customer Sam Rivera · sold by Pixel & Port',
    reason: 'Package lost by carrier, claim USPS-CLM-4410', before: 'Requested', after: 'Approved $329.00', approval: 'Pending', approvalNote: 'Waiting for Morgan Hale', tags: ['financial'],
    origin: ADMIN('Chrome 129 on macOS · managed laptop ML-0214'), requestId: 'req_3Gx5NcY7wQ9k', tokenId: 'tkn_adm_01J9X4RS2T7U',
    changes: [
      { field: 'refund.status', label: 'Refund status', before: 'requested', after: 'approved (waiting for second review)' },
      { field: 'refund.amount', label: 'Refund amount', before: null, after: '$329.00' },
      { field: 'refund.return_required', label: 'Return required', before: 'true', after: 'false' },
    ],
  },
  {
    id: 'AE-261007-1102', at: '2026-10-07T11:02:00-07:00', day: 'Oct 7', time: '11:02 AM', staff: 'Riley Chen', role: 'Platform Administrator', action: 'Assigned role', code: 'staff.role.assign', outcome: 'Succeeded',
    phrase: 'gave Hannah Wu the Finance staff role', target: 'Staff', ref: 'Hannah Wu', sub: 'Finance staff', owner: 'Hannah Wu (staff) · Finance team',
    reason: 'New finance staff member, invited', before: 'No role', after: 'Finance staff, view only', approval: 'Not required', approvalNote: 'Access only', tags: [],
    origin: ADMIN('Chrome 129 on macOS · managed laptop ML-0007', '203.0.113.10', 'San Francisco, CA, US'), requestId: 'req_8Lr2DpM5vF1h', tokenId: 'tkn_adm_01J9WZ6A1B3C',
    changes: [
      { field: 'staff.roles', label: 'Roles', before: '[]', after: '["finance_staff"]' },
      { field: 'staff.permissions.payouts', label: 'Payout permissions', before: 'none', after: 'view' },
    ],
  },
  {
    id: 'AE-261007-1015', at: '2026-10-07T10:15:00-07:00', day: 'Oct 7', time: '10:15 AM', staff: 'Riley Chen', role: 'Platform Administrator', action: 'Scheduled setting change', code: 'settings.returns.window.schedule', outcome: 'Succeeded',
    phrase: 'scheduled a shorter Electronics return window from Nov 1', target: 'Settings', ref: 'Returns · Electronics', sub: 'From Nov 1', owner: 'Platform settings · Returns policy',
    reason: 'Align with manufacturer return terms', before: '30 days', after: '15 days', approval: 'Approved', approvalNote: 'Morgan Hale, Oct 7',
    approver: { name: 'Morgan Hale', role: 'Business Owner', at: 'Oct 7, 2:20 PM PT', limit: 'Policy changes that affect customers need Business Owner approval.' },
    tags: ['settings'], origin: ADMIN('Chrome 129 on macOS · managed laptop ML-0007', '203.0.113.10', 'San Francisco, CA, US'), requestId: 'req_5Nv9AsK3xE7r', tokenId: 'tkn_adm_01J9WY2G4H8J',
    changes: [
      { field: 'returns.electronics.window_days', label: 'Return window', before: '30', after: '15' },
      { field: 'returns.electronics.effective_from', label: 'Effective from', before: null, after: '2026-11-01T00:00:00-07:00' },
    ],
  },
  {
    id: 'AE-261006-1755', at: '2026-10-06T17:55:00-07:00', day: 'Oct 6', time: '5:55 PM', staff: 'Theo Grant', role: 'Shipping Manager', action: 'Opened carrier claim', code: 'shipping.carrier_claim.open', outcome: 'Succeeded',
    phrase: 'opened a $116.00 UPS claim on order MK-261001-33019', target: 'Orders', ref: 'MK-261001-33019', sub: 'UPS-CLM-88412', owner: 'Official Store order · Shipping',
    reason: 'UPS scan shows damage in transit', before: 'No claim', after: 'Claim $116.00', approval: 'Not required', approvalNote: 'Within $1,000 limit', tags: ['financial'],
    origin: { app: 'Operations Center', ip: '198.51.100.40', location: 'Reno, NV, US · warehouse network', device: 'Chrome 129 on Windows 11 · packing station PS-04' }, requestId: 'req_1Bw6ZtH9qU4n', tokenId: 'tkn_ops_01J9V7KL5M9N',
    changes: [
      { field: 'shipment.claim.status', label: 'Claim status', before: null, after: 'open' },
      { field: 'shipment.claim.amount', label: 'Claim amount', before: null, after: '$116.00' },
      { field: 'shipment.claim.carrier_ref', label: 'Carrier reference', before: null, after: 'UPS-CLM-88412' },
    ],
  },
  {
    id: 'AE-261006-1431', at: '2026-10-06T14:31:00-07:00', day: 'Oct 6', time: '2:31 PM', staff: 'Dana Ortiz', role: 'Official Store Manager', action: 'Price change', code: 'catalog.offer.price.update', outcome: 'Succeeded',
    phrase: 'lowered the Official Store price of Halden Aurora ANC to $189.00', target: 'Products', ref: 'HAL-AUR-BLK', sub: 'Official Store offer', owner: 'Official Store · Company trading',
    reason: 'Home Week markdown, Oct 6–19', before: '$229.00', after: '$189.00 (−17%)', approval: 'Not required', approvalNote: 'Within 30% limit', tags: [],
    origin: { app: 'API', ip: '192.0.2.18', location: 'us-west-2 · pricing-sync job', device: 'API key "Official Store pricing" (owner Dana Ortiz)' }, requestId: 'req_0Ck4RyG2mV6t', tokenId: 'tkn_api_01J9V2QW7E1R',
    changes: [
      { field: 'offer.price', label: 'Price', before: '$229.00', after: '$189.00' },
      { field: 'offer.compare_at_price', label: 'Was price shown', before: null, after: '$229.00' },
      { field: 'offer.price_ends_at', label: 'Markdown ends', before: null, after: '2026-10-19T23:59:00-07:00' },
    ],
  },
];

/** Older or system entries that are not on page 1 of the list but are linked as related events. */
export const OLDER_ENTRIES: AuditEntry[] = [
  {
    id: 'AE-261008-0941', at: '2026-10-08T09:41:00-07:00', day: 'Oct 8', time: '9:41 AM', staff: 'Morgan Hale', role: 'Business Owner', action: 'Approved payout hold release', code: 'approval.grant', outcome: 'Succeeded',
    phrase: "approved Priya Nair's payout hold release for Casa Verde Home", target: 'Payouts', ref: 'PO-261009-0418', sub: 'Casa Verde Home', owner: 'Casa Verde Home (seller) · Finance',
    reason: 'Proof of delivery checked', before: 'Waiting for second review', after: 'Approved', approval: 'Not required', approvalNote: 'Is the second review', tags: ['financial'],
    origin: { app: 'Admin Center', ip: '203.0.113.77', location: 'Los Angeles, CA, US', device: 'Safari 18 on iPadOS · managed tablet MT-0011' }, requestId: 'req_7Hq2LmX9aP4c', tokenId: 'tkn_adm_01J9Z5C2DX8K',
    changes: [{ field: 'approval.status', label: 'Approval', before: 'pending', after: 'approved' }],
  },
  {
    id: 'AE-260929-1104', at: '2026-09-29T11:04:00-07:00', day: 'Sep 29', time: '11:04 AM', staff: 'Priya Nair', role: 'Finance Manager', action: 'Placed payout hold', code: 'payout.hold.place', outcome: 'Succeeded',
    phrase: 'placed a $1,240.00 payout hold on Casa Verde Home', target: 'Payouts', ref: 'PO-261009-0418', sub: 'Casa Verde Home', owner: 'Casa Verde Home (seller) · Finance',
    reason: 'Disputed delivery on order MK-260921-18320', before: 'Available $1,240.00', after: 'Held $1,240.00', approval: 'Not required', approvalNote: 'Holds need no second review', tags: ['financial'],
    origin: ADMIN('Chrome 129 on macOS · managed laptop ML-0214'), requestId: 'req_5Fr8WjB1nK2y', tokenId: 'tkn_adm_01J8T1F6GZ4P',
    changes: [
      { field: 'hold.status', label: 'Hold status', before: null, after: 'held' },
      { field: 'balance.held', label: 'Held balance', before: '$0.00', after: '$1,240.00' },
      { field: 'hold.review_date', label: 'Review date', before: null, after: '2026-10-09' },
    ],
  },
  {
    id: 'AE-261007-1519', at: '2026-10-07T15:19:00-07:00', day: 'Oct 7', time: '3:19 PM', staff: 'Approval workflow', role: 'System', action: 'Requested second review', code: 'approval.request', outcome: 'Pending approval',
    phrase: 'asked Morgan Hale to review a $329.00 refund without return', target: 'Orders', ref: 'MK-260930-21877', sub: 'Kestrel 27" Monitor', owner: 'Customer Sam Rivera · sold by Pixel & Port',
    reason: 'Refunds without return above $250 need a second reviewer', before: 'No review', after: 'Review requested', approval: 'Not required', approvalNote: 'System event', tags: ['financial'],
    origin: { app: 'API', ip: '10.0.4.12', location: 'us-west-2 · approvals service', device: 'Service token "approvals"' }, requestId: 'req_3Gx5NcY7wQ9k', tokenId: 'tkn_svc_01J9X4RT9W2A',
    changes: [{ field: 'approval.status', label: 'Approval', before: null, after: 'pending' }, { field: 'approval.reviewer', label: 'Reviewer', before: null, after: 'Morgan Hale' }],
  },
];

export const ALL_ENTRIES: AuditEntry[] = [...ENTRIES, ...OLDER_ENTRIES];

export const findEntry = (id: string | undefined) => ALL_ENTRIES.find((e) => e.id === id);

export type Relation = 'Same request' | 'Same target' | 'Same seller';

/** Related events: same request ID first, then same target, then other records of the same seller. */
export function relatedTo(e: AuditEntry): Array<{ entry: AuditEntry; why: Relation }> {
  const seller = (x: AuditEntry) => (x.owner.includes('(seller)') ? x.owner.split(' (seller)')[0] : null);
  const out: Array<{ entry: AuditEntry; why: Relation }> = [];
  for (const x of ALL_ENTRIES) {
    if (x.id === e.id) continue;
    if (x.requestId === e.requestId) out.push({ entry: x, why: 'Same request' });
    else if (x.ref === e.ref) out.push({ entry: x, why: 'Same target' });
    else if (seller(e) && seller(x) === seller(e)) out.push({ entry: x, why: 'Same seller' });
  }
  const rank: Record<Relation, number> = { 'Same request': 0, 'Same target': 1, 'Same seller': 2 };
  return out.sort((a, b) => rank[a.why] - rank[b.why] || b.entry.at.localeCompare(a.entry.at));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 8, 2026, 16:32:00 UTC" from the entry's ISO time. */
export function utcLabel(e: AuditEntry) {
  const d = new Date(e.at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

/** Local (PT) label: "Oct 8, 2026, 9:32 AM PDT". */
export const localLabel = (e: AuditEntry) => `${e.day}, ${e.at.slice(0, 4)}, ${e.time} ${e.at.endsWith('-07:00') ? 'PDT' : 'PST'}`;

/** The raw record as the API returns it. */
export function rawRecord(e: AuditEntry) {
  return {
    id: e.id,
    occurred_at: new Date(e.at).toISOString(),
    action: e.code,
    outcome: e.outcome.toLowerCase().replace(/ /g, '_'),
    actor: { name: e.staff, role_at_time: e.role },
    target: { type: TARGET[e.target].label.toLowerCase(), ref: e.ref, label: e.sub, owner: e.owner },
    reason: e.reason,
    changes: Object.fromEntries(e.changes.map((c) => [c.field, { before: c.before, after: c.after }])),
    approval: e.approver ? { status: 'approved', by: e.approver.name, role: e.approver.role, at: e.approver.at } : { status: e.approval.toLowerCase().replace(/ /g, '_'), note: e.approvalNote },
    origin: { app: e.origin.app, ip: e.origin.ip, location: e.origin.location, device: e.origin.device },
    request_id: e.requestId,
    token_id: e.tokenId,
  };
}
