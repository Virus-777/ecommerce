// Sample data for the admin "Payout run" screen (design: pages/admin/admin-payouts.html and
// admin-payouts--approve-run.html). Replaced by the payout runs API later.
import type { IconName } from '@/ui';

export const RUN = {
  id: 'PO-RUN-261009',
  sub: 'Friday, Oct 9, 2026 · release 10:00 AM PT · weekly run · earnings from items delivered by Oct 2 and past the 7-day hold',
  release: 'Fri, Oct 9, 10:00 AM PT',
  total: 78420.55,
  payingNow: 72192.15,
  payingSellers: 38,
  held: 6228.4,
  heldSellers: 3,
  offset: 212.4,
  retries: { n: 2, amount: 1297.85 },
};

export interface PayoutKpi {
  icon: IconName;
  label: string;
  value: string;
  note: string;
}

export const PAYOUT_KPIS: PayoutKpi[] = [
  { icon: 'wallet', label: 'Run total', value: '$78,420.55', note: 'Needs two Finance approvals' },
  { icon: 'store', label: 'Sellers', value: '41', note: 'Weekly schedule' },
  { icon: 'circle-check', label: 'Ready', value: '38', note: '$72,192.15 · incl. 2 retries' },
  { icon: 'hand-coins', label: 'Held', value: '3', note: '$6,228.40 · each with review date' },
  { icon: 'circle-alert', label: 'Failed last run', value: '2', note: '$1,297.85 · retry or fix' },
];

export type DestState = 'verified' | 'review' | 'pending';

export interface RunSeller {
  seller: string;
  available: number;
  hold?: { amount: number; reason: string; review: string };
  negative?: { amount: number; note: string };
  dest: { bank: string; state: DestState };
  payout: number;
  status: 'Scheduled' | 'On hold';
}

export const RUN_SELLERS: RunSeller[] = [
  { seller: 'Northwind Audio', available: 6842.1, dest: { bank: 'Chase •••• 4021', state: 'verified' }, payout: 6842.1, status: 'Scheduled' },
  { seller: 'Pixel & Port', available: 9310.45, hold: { amount: 480, reason: 'Chargeback CB-2210', review: 'Oct 21' }, dest: { bank: 'Wells Fargo •••• 5521', state: 'verified' }, payout: 8830.45, status: 'Scheduled' },
  { seller: 'Casa Verde Home', available: 3912.6, hold: { amount: 1240, reason: 'Open dispute CS-104882', review: 'Oct 15' }, dest: { bank: 'US Bank •••• 3307', state: 'verified' }, payout: 2672.6, status: 'Scheduled' },
  { seller: 'Trailhead Outfitters', available: 5104.2, dest: { bank: 'Wells Fargo •••• 1184', state: 'review' }, payout: 5104.2, status: 'Scheduled' },
  { seller: 'Bayside Prints', available: 340, negative: { amount: 212.4, note: 'Refund after payout, offset now' }, dest: { bank: 'BECU •••• 6610', state: 'verified' }, payout: 127.6, status: 'Scheduled' },
  { seller: 'Moss & Mill', available: 485.5, dest: { bank: 'Citi •••• 2290', state: 'verified' }, payout: 485.5, status: 'Scheduled' },
  { seller: 'Gadget Grove', available: 4188.4, hold: { amount: 4188.4, reason: 'Seller restricted, counterfeit review TR-3391', review: 'Oct 16' }, dest: { bank: 'Chase •••• 8875', state: 'verified' }, payout: 0, status: 'On hold' },
  { seller: 'Lumen & Loom', available: 1460, hold: { amount: 1460, reason: 'First payout, identity re-check', review: 'Oct 12' }, dest: { bank: 'Ally •••• 0412', state: 'pending' }, payout: 0, status: 'On hold' },
  { seller: 'Fernway Garden', available: 580, hold: { amount: 580, reason: 'Unusual refund rate, 3 open returns', review: 'Oct 14' }, dest: { bank: 'Chase •••• 7719', state: 'verified' }, payout: 0, status: 'On hold' },
];

export interface FailedPayout {
  ref: string;
  seller: string;
  amount: number;
  reason: string;
  fix: string;
  /** The seller has already fixed the problem (shown in green). */
  fixed?: boolean;
  canRetry: boolean;
  status: 'Failed' | 'Pending';
  edge: 'flagged' | 'warn' | '';
}

export const FAILED_PAYOUTS: FailedPayout[] = [
  { ref: 'PO-261002-0187', seller: 'Rowan Leather Co.', amount: 812.35, reason: 'Account closed (bank code R02)', fix: 'Seller must add and verify a new account', canRetry: false, status: 'Failed', edge: 'flagged' },
  { ref: 'PO-261002-0191', seller: 'Moss & Mill', amount: 485.5, reason: 'Account holder name does not match', fix: 'Seller corrected name Oct 6', fixed: true, canRetry: true, status: 'Failed', edge: 'warn' },
];

export interface DestinationChange {
  id: string;
  seller: string;
  from: string;
  to: string;
  requested: string;
  checks: Array<{ tone: 'ok' | 'warn'; text: string }>;
  note: string;
  state: 'review' | 'approved' | 'rejected';
  decided?: string;
}

export const DESTINATION_CHANGES: DestinationChange[] = [
  {
    id: 'dc-1',
    seller: 'Trailhead Outfitters',
    from: 'Wells Fargo •••• 1184',
    to: 'First Tech •••• 7730',
    requested: 'requested Oct 7 by owner Lucia Ramos',
    checks: [
      { tone: 'ok', text: 'Micro-deposits confirmed' },
      { tone: 'ok', text: 'Owner signed in again with two-step verification' },
      { tone: 'warn', text: 'Callback to the registered phone not answered yet' },
    ],
    note: 'This run pays the verified account •••• 1184 until the change is approved.',
    state: 'review',
  },
  { id: 'dc-2', seller: 'Pixel & Port', from: 'Chase •••• 3318', to: 'Wells Fargo •••• 5521', requested: '', checks: [], note: '', state: 'approved', decided: 'Approved Oct 3 by Priya Nair · reason: bank switch confirmed by phone and statement' },
];

export interface ApprovalStep {
  who: string;
  role: string;
  /** Page card sub line and dialog sub line. */
  meta: string;
  dialogMeta: string;
  /** Title on the page card while this step waits. */
  pendingTitle?: string;
  state: 'approved' | 'pending' | 'sent-back';
}

export const APPROVALS: ApprovalStep[] = [
  { who: 'Priya Nair', role: 'Finance Manager', meta: 'Approved Oct 8, 8:52 AM', dialogMeta: 'First approval · Oct 8, 8:52 AM', state: 'approved' },
  { who: 'Owen Price', role: 'Finance Specialist', pendingTitle: 'Second Finance reviewer', meta: 'Assigned to Owen Price · due Oct 9, 9:30 AM', dialogMeta: 'Second approval · now', state: 'pending' },
];

export const RUN_CHECKS: Array<{ tone: 'ok' | 'info' | 'warn'; text: string; sub?: string }> = [
  { tone: 'ok', text: 'Daily finance check for Oct 7 settled', sub: 'One $12.40 settlement difference is logged and does not affect seller amounts' },
  { tone: 'ok', text: 'Every paid destination is verified' },
  { tone: 'info', text: 'Trailhead Outfitters is paid to its current verified account', sub: 'The requested new account is still under review' },
  { tone: 'info', text: 'Bayside Prints negative balance of $212.40 is offset in this run' },
  { tone: 'warn', text: 'Rowan Leather Co. stays unpaid', sub: 'No valid account. The seller has been notified.' },
];

export const STATUS_MEANING: Array<{ status: string; text: string }> = [
  { status: 'Pending', text: 'In a run, not yet released' },
  { status: 'Processing', text: 'Sent to the bank, not yet confirmed' },
  { status: 'Paid', text: 'Bank confirmed the deposit' },
  { status: 'Failed', text: 'Returned by the bank with a reason' },
];
