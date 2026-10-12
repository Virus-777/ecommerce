// Sample data for the admin "Payments and fees" screen (design: pages/admin/admin-finance.html,
// --disputes-and-chargebacks, --refunds-failing). Replaced by the finance reporting API later.
import type { IconName } from '@marketly/web-shared/ui';

export type Edge = 'flagged' | 'warn' | '';
export type Period = 'today' | '7d' | 'mtd';

export const PERIODS: Array<{ value: Period; label: string; range: string }> = [
  { value: 'today', label: 'Today', range: 'Oct 8, 2026' },
  { value: '7d', label: '7 days', range: 'Oct 2–8, 2026' },
  { value: 'mtd', label: 'Month to date', range: 'Oct 1–8, 2026' },
];

export interface FinanceKpi {
  icon: IconName;
  label: string;
  value: string;
  note: string;
}

export const FINANCE_KPIS: FinanceKpi[] = [
  { icon: 'credit-card', label: 'Collected payments', value: '$412,860.20', note: '5,742 accepted payments' },
  { icon: 'badge-check', label: 'Company product sales', value: '$236,410.00', note: 'Official Store · company trading' },
  { icon: 'landmark', label: 'Marketplace fee income', value: '$16,902.75', note: 'on $171,480.30 seller sales' },
  { icon: 'wallet', label: 'Owed to sellers', value: '$148,317.40', note: 'Pending $96,280.10 · available $52,037.30' },
  { icon: 'undo-2', label: 'Refunds sent', value: '$9,842.15', note: '31 sent · 2 failing' },
  { icon: 'hand-coins', label: 'Holds', value: '$12,640.00', note: '6 sellers · each with review date' },
];

export interface Person {
  name: string;
  role: string;
}

export interface UnexplainedRow {
  ref: string;
  /** The reference is an order number (links to the admin order page). */
  isOrder?: boolean;
  title: string;
  detail: string;
  /** Signed difference; negative amounts show in red. */
  diff: number;
  detected: string;
  owner: Person;
  action: string;
  edge: Edge;
}

export const UNEXPLAINED: UnexplainedRow[] = [
  { ref: 'STL-261007-ADY', title: 'Provider settlement for Oct 7 is short', detail: '2,114 captured payments vs settlement batch', diff: -12.4, detected: 'Oct 8, 6:00 AM', owner: { name: 'Priya Nair', role: 'Finance Manager' }, action: 'Investigate', edge: 'warn' },
  { ref: 'PAY-8F21C904', title: 'Payment captured with no order', detail: 'Checkout timed out. Duplicate check confirmed no order was created.', diff: 84.2, detected: 'Oct 7, 9:41 PM', owner: { name: 'Owen Price', role: 'Finance Specialist' }, action: 'Refund customer', edge: 'warn' },
  { ref: 'MK-261006-09977', isOrder: true, title: 'Seller amount differs from order lines', detail: 'Gadget Grove · shipping counted twice in seller proceeds', diff: 6.99, detected: 'Oct 7, 6:00 AM', owner: { name: 'Owen Price', role: 'Finance Specialist' }, action: 'Correct with reason', edge: '' },
];

export type EvidenceDue = { tone: 'ok' | 'warning'; text: string } | { note: string };
export type BalanceEffect = { held: number } | { note: string; released?: boolean };

export interface DisputeRow {
  ref: string;
  order: string;
  seller: string;
  customer: string;
  reason: string;
  amount: number;
  due: EvidenceDue;
  effect: BalanceEffect;
  status: 'Chargeback' | 'Disputed' | 'Under review' | 'Resolved';
  action: 'Submit evidence' | 'Open';
}

export const DISPUTES: DisputeRow[] = [
  { ref: 'CB-2210', order: 'MK-260921-33018', seller: 'Pixel & Port', customer: 'Marcus Webb', reason: 'Item not received (card issuer)', amount: 480, due: { tone: 'ok', text: 'Oct 14 · 6 days' }, effect: { held: 480 }, status: 'Chargeback', action: 'Submit evidence' },
  { ref: 'CB-2214', order: 'MK-260928-40112', seller: 'Marketly Official', customer: 'Hannah Wu', reason: 'Unrecognized charge', amount: 189, due: { tone: 'warning', text: 'Oct 9 · tomorrow' }, effect: { note: 'Company sale. A loss is recorded in company trading.' }, status: 'Chargeback', action: 'Submit evidence' },
  { ref: 'DP-0318', order: 'MK-261002-51207', seller: 'Trailhead Outfitters', customer: 'Leo Park', reason: 'Charged twice (wallet provider dispute)', amount: 139, due: { tone: 'ok', text: 'Oct 12 · 4 days' }, effect: { held: 139 }, status: 'Disputed', action: 'Open' },
  { ref: 'CB-2201', order: 'MK-260919-28870', seller: 'Northwind Audio', customer: 'Tara Singh', reason: 'Item not as described', amount: 59, due: { note: 'Evidence sent Oct 5' }, effect: { held: 59 }, status: 'Under review', action: 'Open' },
  { ref: 'CB-2189', order: 'MK-260911-17342', seller: 'Casa Verde Home', customer: 'Owen Hart', reason: 'Item not received', amount: 72, due: { note: 'Won Oct 6' }, effect: { note: 'Hold released Oct 6', released: true }, status: 'Resolved', action: 'Open' },
];

export interface RefundRow {
  ref: string;
  order: string;
  customer: string;
  amount: number;
  why: string;
  whyDetail: string;
  attempts: string;
  status: 'Failed' | 'Checking' | 'Waiting on customer' | 'Sent';
  edge: Edge;
  action: { kind: 'ask' | 'check'; label: string; icon?: IconName; srRef?: boolean } | null;
}

export const REFUNDS: RefundRow[] = [
  { ref: 'RF-261006-0419', order: 'MK-260927-21877', customer: 'Ella Fischer', amount: 212.4, why: 'Card closed by the issuer', whyDetail: 'Visa •••• 9012 · Oct 6, 4:12 PM', attempts: '2 of 3', status: 'Failed', edge: 'flagged', action: { kind: 'ask', label: 'Ask customer for a new method' } },
  { ref: 'RF-261007-0433', order: 'MK-261001-30554', customer: 'Sam Rivera', amount: 106, why: 'Provider timed out, outcome unknown', whyDetail: 'We check the provider before any retry', attempts: '1 of 3', status: 'Checking', edge: 'warn', action: { kind: 'check', label: 'Check status', icon: 'refresh-cw', srRef: true } },
];

export interface FlowRow {
  label: string;
  value: string;
  pct: number;
  tone?: 'warning';
  note?: string;
}

export const MONEY_FLOW: FlowRow[] = [
  { label: 'Company product sales (Official Store)', value: '$236,410.00', pct: 57 },
  { label: 'Seller sales (marketplace)', value: '$171,480.30', pct: 42, tone: 'warning', note: 'Near target' },
  { label: 'Shipping charges collected', value: '$4,969.90', pct: 1 },
];

export const MONEY_PANELS: Array<{ k: string; v: string; note: string }> = [
  { k: 'From seller sales: fee income', v: '$16,902.75', note: 'Earned by the marketplace' },
  { k: 'From seller sales: seller earnings', v: '$154,577.55', note: 'Before refunds and holds' },
  { k: 'Paid out to sellers', v: '$61,340.80', note: 'Run of Oct 2 · 39 sellers' },
];

export const FEE_RULES: Array<[string, string]> = [
  ['Commission basis', 'Item price after seller-funded discounts'],
  ['Shipping', 'Not included in commission'],
  ['Platform-funded discounts', 'Do not reduce seller proceeds. Platform pays the difference.'],
  ['Seller-funded discounts', 'Reduce the item price that commission is charged on'],
  ['Cancellation before dispatch', 'No fee'],
  ['Returns and refunds', 'Fee returned in proportion to the refunded item value'],
  ['Payment disputes', 'Fee kept while open; returned if we win'],
];

export const CATEGORY_RATES: Array<{ category: string; rate: number }> = [
  { category: 'Electronics', rate: 8 },
  { category: 'Computers', rate: 7 },
  { category: 'Home & Kitchen', rate: 12 },
  { category: 'Fashion', rate: 15 },
  { category: 'Sports & Outdoors', rate: 10 },
  { category: 'Beauty', rate: 12 },
];

export const DISCOUNT_FUNDING: Array<{ label: string; amount: number }> = [
  { label: 'Platform-funded coupons', amount: 6420 },
  { label: 'Seller-funded markdowns', amount: 4180 },
  { label: 'Shared campaigns', amount: 1270 },
];
