// Detail for admin/trust-report (designed in React; blueprint: reports/Best ecommerce site UX patterns.md,
// "Trust and risk report detail"). Extends the queue rows in ./trust with factors, related entities,
// attachments, history and timeline. Full detail for TR-3391 and TR-3402; other reports get a generic
// detail built from their queue row. Replaced by the trust reports API later.
import type { ScreenId } from '@marketly/web-shared/routes';
import type { IconName, TimelineEvent } from '@marketly/web-shared/ui';
import { DISMISS_REASONS, REPORTS, type TrustReport } from './trust';

export type TrustActionKey = 'clear' | 'request-info' | 'restrict-listing' | 'hold-payouts' | 'suspend';
export type Reversible = 'yes' | 'partly' | 'no';

/** The fixed action set. Trust performs Clear and Request info; the others go to the owning team. */
export interface TrustActionDef {
  key: TrustActionKey;
  label: string;
  icon: IconName;
  owner: string;
  byTrust: boolean;
  reversible: Reversible;
  undo: string;
  reasons: string[];
  /** Primary button label in the dialog. */
  submit: string;
}

export const TRUST_ACTIONS: TrustActionDef[] = [
  { key: 'clear', label: 'Clear', icon: 'circle-check', owner: 'Trust and Risk', byTrust: true, reversible: 'yes', undo: 'Can be undone: the report can be reopened for 30 days.', reasons: [...DISMISS_REASONS, 'Seller proved the items are genuine'], submit: 'Clear report' },
  { key: 'request-info', label: 'Request info', icon: 'message-circle-question', owner: 'Trust and Risk', byTrust: true, reversible: 'yes', undo: 'Can be undone: you can withdraw the request. Nothing else changes while it is open.', reasons: ['Proof of authenticity needed', 'Supplier cannot be verified', 'Identity check needed', 'More detail needed from the reporter'], submit: 'Send request' },
  { key: 'restrict-listing', label: 'Restrict listing', icon: 'eye-off', owner: 'Catalog · Omar Haddad', byTrust: false, reversible: 'yes', undo: 'Can be undone: Catalog can lift the restriction and the offer returns as it was.', reasons: ['Suspected counterfeit', 'Listing policy violation', 'Product safety risk', 'Misleading listing'], submit: 'Send to Catalog' },
  { key: 'hold-payouts', label: 'Hold payouts', icon: 'wallet', owner: 'Finance · Priya Nair', byTrust: false, reversible: 'yes', undo: 'Can be undone: Finance releases the hold and the money goes out in the next payout run. A hold never takes money away.', reasons: ['Pending counterfeit review', 'Refund and chargeback exposure', 'Suspected fraud', 'Identity not verified'], submit: 'Send to Finance' },
  { key: 'suspend', label: 'Suspend', icon: 'ban', owner: 'Seller Manager · Grace Kim', byTrust: false, reversible: 'partly', undo: 'Only partly: a suspension can be lifted on appeal, but cancelled orders and lost search ranking are not restored.', reasons: ['Confirmed counterfeit goods', 'Repeated policy violations', 'Confirmed fraud', 'Identity could not be verified'], submit: 'Send to Seller Manager' },
];

export const actionDef = (k: TrustActionKey) => TRUST_ACTIONS.find((a) => a.key === k)!;

/** What an action means for this report. `unavailable` explains why it does not apply. */
export type CaseAction =
  | { what: string; consequence: string; owner?: string; submit?: string; secondReviewer?: string; done?: string; /** Reason codes for this report, when the defaults do not fit. */ reasons?: string[] }
  | { unavailable: string };

export interface RiskFactor {
  dir: 'raises' | 'lowers';
  title: string;
  detail: string;
  weight: 'Strong' | 'Moderate' | 'Weak';
}

export interface RelatedEntity {
  icon: IconName;
  kind: string;
  label: string;
  sub?: string;
  /** What links it to the report: same IP, card, address, bank account… */
  shared: string;
  status?: string;
  to: ScreenId;
}

export interface Attachment {
  icon: IconName;
  tint: string;
  name: string;
  by: string;
  when: string;
}

export interface HistoryRow {
  when: string;
  what: string;
  outcome: string;
  /** Action history entry, when there is one. */
  entry?: string;
}

export interface TrustDetail {
  report: TrustReport;
  band: 'High' | 'Medium' | 'Low';
  why: string;
  scoredAt: string;
  sla: { label: string; seconds: number };
  assignee: string | null;
  subject: { kind: 'seller' | 'accounts'; name: string; sub: string };
  factors: RiskFactor[];
  entities: RelatedEntity[];
  attachments: Attachment[];
  history: { facts: Array<[string, string]>; rows: HistoryRow[] };
  /** reason: the reason code shown when the decision view is opened directly. */
  recommended: { action: TrustActionKey; text: string; reason: string };
  actions: Record<TrustActionKey, CaseAction>;
  timeline: TimelineEvent[];
}

const byId = (id: string) => REPORTS.find((r) => r.id === id)!;

const TR3391: TrustDetail = {
  report: byId('TR-3391'),
  band: 'High',
  why: "Four serial numbers photographed by buyers are not in Brightline's registry, and the brand owner and 3 customers reported the same listing within 2 days.",
  scoredAt: 'Scored Oct 7, 4:12 PM by risk rules v4',
  sla: { label: 'Decision due Oct 9, 5:00 PM PT', seconds: 30 * 3600 + 13 * 60 },
  assignee: 'Sven Larsen',
  subject: { kind: 'seller', name: 'Gadget Grove', sub: 'Seller since Oct 2024 · Ontario, CA · Restricted' },
  factors: [
    { dir: 'raises', title: 'Serial numbers not in the brand registry', detail: '4 of 4 serials in buyer photos are unknown to Brightline', weight: 'Strong' },
    { dir: 'raises', title: 'Packaging differs from the brand reference', detail: 'Charging dock label font and spacing do not match Brightline reference photos', weight: 'Strong' },
    { dir: 'raises', title: 'Price far below authorized offers', detail: '$279.00 is 20% below every authorized Brightline offer', weight: 'Moderate' },
    { dir: 'lowers', title: 'Long, clean selling history', detail: '4,120 orders since Oct 2024 and no earlier counterfeit reports', weight: 'Moderate' },
    { dir: 'raises', title: 'Supplier could not be confirmed', detail: 'Both invoices name a distributor Brightline does not list', weight: 'Moderate' },
    { dir: 'raises', title: 'High "not as described" returns', detail: '18% of BRL-S2 orders from Gadget Grove returned as not as described in 30 days (category 6%)', weight: 'Weak' },
    { dir: 'raises', title: 'Shares a bank account with another seller', detail: 'Payout account •••• 6610 is also on Brightfield Supply Co.', weight: 'Weak' },
    { dir: 'lowers', title: 'Answered quickly with documents', detail: 'Seller sent 2 purchase invoices within 6 hours of the first request', weight: 'Weak' },
  ],
  entities: [
    { icon: 'store', kind: 'Seller', label: 'Gadget Grove', sub: 'Subject of this report', shared: 'Reported seller', status: 'Restricted', to: 'admin/seller' },
    { icon: 'store', kind: 'Seller', label: 'Brightfield Supply Co.', sub: '12 offers · joined Aug 2026', shared: 'Same payout bank account •••• 6610', status: 'Approved', to: 'admin/sellers' },
    { icon: 'store', kind: 'Seller', label: 'HomeTech Outlet', sub: 'Closed Mar 2026 (counterfeit, TR-2210)', shared: 'Same return address, Ontario, CA', status: 'Closed', to: 'admin/sellers' },
    { icon: 'package', kind: 'Listing', label: 'Brightline S2 · BRL-S2', sub: 'Gadget Grove offer · $279.00', shared: 'Reported listing', status: 'Suspended', to: 'admin/catalog' },
    { icon: 'shopping-bag', kind: 'Orders', label: '14 orders in 30 days', sub: '3 reported by customers · 9 still open', shared: 'Bought the reported listing', status: 'Open', to: 'admin/orders' },
    { icon: 'life-buoy', kind: 'Case', label: 'CS-104933', sub: 'Chris Taylor · not as described', shared: 'Customer complaint on BRL-S2', status: 'Open', to: 'admin/case' },
    { icon: 'wallet', kind: 'Payment', label: 'Payout hold $4,188.40', sub: 'Review Oct 16', shared: 'Seller payout', status: 'On hold', to: 'admin/payouts' },
  ],
  attachments: [
    { icon: 'camera', tint: '3', name: 'Buyer photo: serial label (unit 1 of 4)', by: 'Chris Taylor, customer', when: 'Oct 5' },
    { icon: 'camera', tint: '3', name: 'Buyer photos: serial labels (units 2–4)', by: '3 customers', when: 'Oct 5' },
    { icon: 'image', tint: '2', name: 'Brand reference: dock label and box', by: 'Brightline brand protection', when: 'Oct 5' },
    { icon: 'file-text', tint: '5', name: 'Brightline report BP-88213 (PDF)', by: 'Brightline brand protection', when: 'Oct 5' },
    { icon: 'receipt', tint: '1', name: 'Invoice INV-20419 from Pacific Home Distribution', by: 'Gadget Grove', when: 'Oct 6' },
    { icon: 'receipt', tint: '1', name: 'Invoice INV-20577 from Pacific Home Distribution', by: 'Gadget Grove', when: 'Oct 6' },
  ],
  history: {
    facts: [
      ['Selling since', 'Oct 2024 · 4,120 orders'],
      ['Earlier trust reports', '1 (TR-2984, listing images, cleared Jun 2026)'],
      ['Late dispatch, 30 days', '11% (target under 4%)'],
      ['Open appeal', 'AP-0127, decide by Oct 14'],
    ],
    rows: [
      { when: 'Oct 8, 2026', what: 'Restricted: new sales paused for late dispatch', outcome: 'Restricted', entry: 'AE-261008-0847' },
      { when: 'Oct 7, 2026', what: 'Offer for Brightline S2 suspended (this report)', outcome: 'Suspended', entry: 'AE-261007-1640' },
      { when: 'Oct 7, 2026', what: 'Appeal AP-0127 filed against the listing restriction', outcome: 'Under review' },
      { when: 'Jun 12, 2026', what: 'TR-2984: listing images reused from another seller', outcome: 'Resolved' },
      { when: 'Oct 3, 2024', what: 'Seller application approved', outcome: 'Approved' },
    ],
  },
  recommended: {
    action: 'request-info',
    reason: 'Proof of authenticity needed',
    text: 'Ask Gadget Grove for supplier invoices that Brightline can trace and photos of every serial label in stock, due in 3 business days. Keep the payout hold. If the proof does not arrive or does not match, send a suspension to the Seller Manager.',
  },
  actions: {
    clear: { what: 'Close TR-3391 with no further action', consequence: 'The report closes. Brightline and the 3 customers are told no violation was found. Actions other teams already took stay in place until they reverse them.' },
    'request-info': { what: 'Ask Gadget Grove for proof of authenticity', consequence: 'Gadget Grove gets a request for traceable supplier invoices and serial label photos, due Oct 13. The SLA pauses while we wait. Listings and payouts stay as they are.' },
    'restrict-listing': { what: 'Restrict all 3 Brightline offers from Gadget Grove', consequence: 'The other 2 Brightline offers are hidden from search and product pages too. Open orders, returns and buyer help continue.', done: 'BRL-S2 is already suspended by Catalog (Oct 7).' },
    'hold-payouts': { what: 'Extend the payout hold on Gadget Grove to Oct 30', consequence: 'Finance keeps $4,188.40 on hold past the Oct 16 review, and new earnings are held too. The seller sees the hold and the reason in Seller Center.', secondReviewer: 'Holds above $1,000 need a second reviewer.', done: 'Finance already holds $4,188.40 until Oct 16.' },
    suspend: { what: 'Suspend Gadget Grove', consequence: 'All 46 offers are hidden and new orders stop. 9 open orders must still ship or are refunded; returns and buyer help continue.', secondReviewer: 'Suspensions always need a second reviewer.' },
  },
  timeline: [
    { t: 'Reported by Brightline (brand owner)', d: 'Oct 5, 9:12 AM · brand protection report BP-88213', state: 'done' },
    { t: '3 customer reports merged into TR-3391', d: 'Oct 5, 2:40 PM · automatic', state: 'done' },
    { t: 'Assigned to Sven Larsen', d: 'Oct 5, 3:05 PM · queue rules', state: 'done' },
    { t: 'Info requested from Gadget Grove', d: 'Oct 6, 10:20 AM · by Sven Larsen', state: 'done', body: 'Reason code: supplier_cannot_be_verified. Invoices received Oct 6, 4:31 PM.' },
    { t: 'Offer suspended by Catalog', d: 'Oct 7, 4:40 PM · Omar Haddad', state: 'done', body: 'Reason recorded: brand registry mismatch on 4 units' },
    { t: 'Payout hold placed by Finance: $4,188.40', d: 'Oct 7, 5:02 PM · Priya Nair', state: 'done' },
    { t: 'New listings restricted in Home & Kitchen', d: 'Oct 7, 5:15 PM · Grace Kim', state: 'done' },
    { t: 'Escalated: risk score 86', d: 'Oct 7, 5:20 PM · Sven Larsen', state: 'warn' },
    { t: 'Appeal AP-0127 filed by Gadget Grove', d: 'Oct 7, 6:48 PM', state: 'done' },
    { t: 'Buyer refund notice sent to Support', d: 'Oct 8, 8:10 AM · Isabel Cruz', state: 'current' },
  ],
};

const TR3402: TrustDetail = {
  report: byId('TR-3402'),
  band: 'High',
  why: 'Six accounts created within 40 minutes paid with 5 different cards and ship to one parcel forwarding address in Reno.',
  scoredAt: 'Scored Oct 7, 11:48 AM by payment risk rules v4',
  sla: { label: 'First action due Oct 8, 2:00 PM PT', seconds: 3 * 3600 + 13 * 60 },
  assignee: null,
  subject: { kind: 'accounts', name: 'Kyle Benson + 5 accounts', sub: 'Created Oct 7, 11:02–11:42 AM · no earlier orders' },
  factors: [
    { dir: 'raises', title: 'Burst of new accounts', detail: '6 accounts created within 40 minutes from 2 IP addresses', weight: 'Strong' },
    { dir: 'raises', title: 'Many cards, one address', detail: '5 different cards ship to the same Reno address', weight: 'Strong' },
    { dir: 'raises', title: 'Address check failed on 2 payments', detail: 'Card billing ZIP does not match on 2 of 6 payments', weight: 'Moderate' },
    { dir: 'lowers', title: 'Payments were authorized', detail: 'All 6 payments passed 3-D Secure or issuer checks', weight: 'Moderate' },
    { dir: 'raises', title: 'Parcel forwarding address', detail: 'Shipping address belongs to a known forwarding service', weight: 'Moderate' },
    { dir: 'raises', title: 'High-resale product', detail: 'Every order is Kestrel portable SSDs, 2 per order', weight: 'Weak' },
    { dir: 'lowers', title: 'Normal order size', detail: 'Order values ($168–$219) are typical for the product', weight: 'Weak' },
  ],
  entities: [
    { icon: 'user-round', kind: 'Customer', label: 'Kyle Benson', sub: 'kyle.b.2026@example.com', shared: 'IP 198.51.100.73 · device D-4F21', status: 'Active', to: 'admin/customers' },
    { icon: 'user-round', kind: 'Customer', label: 'K. Benson', sub: 'kbenson.orders@example.com', shared: 'IP 198.51.100.73 · same address', status: 'Active', to: 'admin/customers' },
    { icon: 'user-round', kind: 'Customer', label: 'Kai Bennet', sub: 'kai.bennet88@example.com', shared: 'Device D-4F21 · same address', status: 'Active', to: 'admin/customers' },
    { icon: 'users', kind: 'Customers', label: '3 more accounts', sub: 'Created 11:31–11:42 AM', shared: 'IP 198.51.100.90 · same address', status: 'Active', to: 'admin/customers' },
    { icon: 'credit-card', kind: 'Payments', label: '5 cards on 6 orders', sub: 'Visa •••• 0213 used twice', shared: 'Same shipping address', status: 'Checking', to: 'admin/finance' },
    { icon: 'shopping-bag', kind: 'Orders', label: '6 orders · $1,140.94', sub: 'MK-261007-52018 and 5 more', shared: 'Same shipping address', status: 'Held', to: 'admin/orders' },
    { icon: 'store', kind: 'Seller', label: 'Pixel & Port', sub: 'Affected seller, not the subject', shared: 'Sold all 6 orders', status: 'Approved', to: 'admin/seller' },
  ],
  attachments: [
    { icon: 'file-text', tint: '5', name: 'Payment risk rule hits (6 payments)', by: 'Payment risk rules', when: 'Oct 7' },
    { icon: 'map-pin', tint: '2', name: 'Address lookup: parcel forwarder, Reno NV', by: 'Address check', when: 'Oct 7' },
    { icon: 'message-square', tint: '4', name: 'Seller note: "asked not to ship"', by: 'Pixel & Port', when: 'Oct 7' },
  ],
  history: {
    facts: [
      ['Accounts', '6 created Oct 7, 11:02–11:42 AM'],
      ['Earlier orders', 'None on any of the 6 accounts'],
      ['Earlier trust reports', 'None'],
      ['Identity request', 'Sent Oct 7, 2:15 PM · no answers yet'],
    ],
    rows: [
      { when: 'Oct 7, 2026', what: 'Identity confirmation requested from all 6 buyers', outcome: 'Pending' },
      { when: 'Oct 7, 2026', what: 'Dispatch held on 6 orders at the seller', outcome: 'Completed' },
      { when: 'Oct 7, 2026', what: '6 accounts created and 6 orders placed', outcome: 'Checking' },
    ],
  },
  recommended: {
    action: 'suspend',
    reason: 'Card testing pattern',
    text: 'Suspend the 6 new accounts and cancel their orders before anything ships. The pattern matches card testing, and no buyer has answered the identity request in 20 hours. Pixel & Port is not charged for the cancellations.',
  },
  actions: {
    clear: { what: 'Close TR-3402 and release the 6 orders for dispatch', consequence: 'Pixel & Port is told to ship. If the payments are fraudulent, chargebacks come back to the marketplace.', reasons: ['Buyers confirmed their identity', 'Payments confirmed by the card issuers', 'Reported in error'] },
    'request-info': { what: 'Remind the 6 buyers to confirm their identity', consequence: 'Each buyer gets a second request with a 24-hour deadline. Orders stay held while we wait.', owner: 'Support · Mateo Ruiz', submit: 'Send to Support', reasons: ['Identity check needed', 'Billing address does not match'] },
    'restrict-listing': { unavailable: 'No listing is involved: the seller, Pixel & Port, is not the subject of this report.' },
    'hold-payouts': { unavailable: 'The subjects are buyer accounts, which have no payouts. Finance is already reviewing the 6 payments.' },
    suspend: { what: 'Suspend the 6 buyer accounts and cancel their orders', consequence: 'The accounts cannot sign in or order. The 6 orders are cancelled and the payments refunded to the original cards. Pixel & Port is not charged.', owner: 'Support · Isabel Cruz', submit: 'Send to Support', secondReviewer: 'Suspending more than one account at once needs a second reviewer.', reasons: ['Card testing pattern', 'Confirmed fraud', 'Identity could not be verified', 'Accounts linked to earlier fraud'] },
  },
  timeline: [
    { t: 'Detected by payment risk rules', d: 'Oct 7, 11:48 AM · 6 orders, $1,140.94', state: 'done' },
    { t: 'Dispatch held on 6 orders', d: 'Oct 7, 12:05 PM · Theo Grant, Orders', state: 'done', body: 'Reason recorded: payment risk review; seller asked not to ship' },
    { t: 'Payments sent to Finance for review', d: 'Oct 7, 12:10 PM · Priya Nair', state: 'done' },
    { t: 'Identity confirmation requested from buyers', d: 'Oct 7, 2:15 PM · Support, Mateo Ruiz', state: 'done' },
    { t: 'Unassigned: waiting for a reviewer', d: 'Since Oct 7, 11:48 AM', state: 'current' },
  ],
};

const KIND: Partial<Record<ScreenId, string>> = { 'admin/seller': 'Seller', 'admin/catalog': 'Listing', 'admin/customers': 'Customer', 'admin/reviews': 'Reviews', 'admin/cases': 'Case', 'admin/case': 'Case', 'admin/orders': 'Orders' };

const BAND = (score: number): TrustDetail['band'] => (score >= 70 ? 'High' : score >= 40 ? 'Medium' : 'Low');

/** Generic detail for reports without a full sample, built from the queue row. */
function generic(r: TrustReport): TrustDetail {
  const factors: RiskFactor[] = r.evidence.map((e) => ({
    dir: e.tone === 'ok' || e.tone === 'info' ? 'lowers' : 'raises',
    title: e.text,
    detail: e.tone === 'fail' ? 'Failed check' : e.tone === 'warn' ? 'Warning' : e.tone === 'ok' ? 'Passed check' : 'Context',
    weight: e.tone === 'fail' ? 'Strong' : e.tone === 'warn' ? 'Moderate' : 'Weak',
  }));
  const first = r.links[0];
  const isSeller = r.links.some((l) => l.to === 'admin/seller') && r.type !== 'abuse';
  return {
    report: r,
    band: BAND(r.score),
    why: r.evidence[0]?.text ? `${r.evidence[0].text}.` : r.title,
    scoredAt: `Scored ${r.meta.match(/Oct \d+/)?.[0] ?? 'Oct 7'} by risk rules v4`,
    sla: { label: 'Decision due Oct 10, 5:00 PM PT', seconds: 2 * 86400 + 7 * 3600 },
    assignee: r.meta.match(/assigned to ([A-Z][a-z]+ [A-Z][a-z]+)/)?.[1] ?? (r.type === 'abuse' ? 'Sven Larsen' : null),
    subject: { kind: isSeller ? 'seller' : 'accounts', name: first?.label.split(' · ')[0] ?? r.title, sub: r.meta },
    factors,
    entities: r.links.map((l) => ({ icon: l.icon, kind: KIND[l.to] ?? 'Record', label: l.label.split(' · ')[0], sub: l.label.split(' · ')[1], shared: 'Linked record', status: l.label.includes('Restricted') ? 'Restricted' : undefined, to: l.to })),
    attachments: [{ icon: 'file-text', tint: '5', name: `${r.id} detection summary`, by: 'Trust and Risk', when: r.meta.match(/Oct \d+/)?.[0] ?? 'Oct 7' }],
    history: { facts: [['Earlier trust reports', 'None in the last 12 months']], rows: [{ when: r.meta.match(/Oct \d+/)?.[0] ?? 'Oct 7', what: `${r.id} opened`, outcome: r.status }] },
    recommended: { action: r.score >= 50 ? 'restrict-listing' : 'request-info', reason: r.score >= 50 ? 'Listing policy violation' : 'More detail needed from the reporter', text: r.actions[0] ? `${r.actions[0].title}. ${r.actions[0].owner.split(' · ')[0]} owns this step.` : 'Ask the reported party for more information before deciding.' },
    actions: {
      clear: { what: `Close ${r.id} with no further action`, consequence: 'The report closes and the reporter is told the outcome.' },
      'request-info': { what: 'Ask the reported party for more information', consequence: 'They get a request with a 3-business-day deadline. The SLA pauses while we wait.' },
      'restrict-listing': r.links.some((l) => l.to === 'admin/catalog' || l.to === 'admin/reviews') ? { what: 'Restrict the linked listing', consequence: 'The listing is hidden from search and product pages. Open orders and returns continue.' } : { unavailable: 'No listing is linked to this report.' },
      'hold-payouts': isSeller ? { what: 'Hold the linked seller’s payouts', consequence: 'New earnings are held until the review date. The seller sees the hold and the reason.', secondReviewer: 'Holds above $1,000 need a second reviewer.' } : { unavailable: 'No seller payouts are linked to this report.' },
      suspend: { what: isSeller ? 'Suspend the linked seller' : 'Suspend the reported account', consequence: isSeller ? 'All offers are hidden and new orders stop. Open orders must still ship or are refunded.' : 'The account cannot sign in or order. Open orders and refunds are not affected.', owner: isSeller ? undefined : 'Support · Isabel Cruz', submit: isSeller ? undefined : 'Send to Support', secondReviewer: 'Suspensions always need a second reviewer.' },
    },
    timeline: [
      { t: r.meta.split(' · ')[0], d: r.id, state: 'done' },
      ...r.actions.filter((a) => a.status === 'Completed').map((a) => ({ t: a.title, d: a.owner, state: 'done' as const, body: a.reason ? `Reason recorded: ${a.reason}` : undefined })),
      { t: r.status === 'Escalated' ? 'Escalated' : 'Waiting for a decision', d: 'Now', state: 'current' as const },
    ],
  };
}

const FULL: Record<string, TrustDetail> = { 'TR-3391': TR3391, 'TR-3402': TR3402 };

export function trustDetail(ref: string | undefined): TrustDetail | null {
  if (!ref) return null;
  if (FULL[ref]) return FULL[ref];
  const r = REPORTS.find((x) => x.id === ref);
  return r ? generic(r) : null;
}

/** Second reviewers (never the person taking the action). */
export const REVIEWERS = [
  { name: 'Morgan Hale', role: 'Business Owner' },
  { name: 'Sven Larsen', role: 'Trust and Risk Manager' },
  { name: 'Grace Kim', role: 'Seller Manager' },
];
