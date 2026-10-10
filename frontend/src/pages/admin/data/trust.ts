// Sample data for the admin "Trust and risk" screen (design: pages/admin/admin-trust.html).
// Replaced by the trust reports API later.
import type { ScreenId } from '@/routes/catalogue';
import type { IconName, Tone } from '@/ui';

export type ReportType = 'counterfeit' | 'suspicious' | 'reviews' | 'abuse';

export const REPORT_TYPES: Record<ReportType, { label: string; icon: IconName }> = {
  counterfeit: { label: 'Counterfeit', icon: 'badge-alert' },
  suspicious: { label: 'Suspicious orders', icon: 'credit-card' },
  reviews: { label: 'Fake reviews', icon: 'star' },
  abuse: { label: 'Abuse', icon: 'message-square-warning' },
};

export interface TrustKpi {
  icon: IconName;
  label: string;
  /** Which report type (or 'all' / 'appeals') the count comes from. */
  source: ReportType | 'all' | 'appeals';
  note: string;
}

export const TRUST_KPIS: TrustKpi[] = [
  { icon: 'shield-alert', label: 'Open reports', source: 'all', note: '1 high risk' },
  { icon: 'badge-alert', label: 'Counterfeit', source: 'counterfeit', note: 'Brand owner report' },
  { icon: 'credit-card', label: 'Suspicious orders', source: 'suspicious', note: '6 orders on hold' },
  { icon: 'star', label: 'Fake reviews', source: 'reviews', note: '11 reviews flagged' },
  { icon: 'message-square-warning', label: 'Abuse', source: 'abuse', note: 'Messaging' },
  { icon: 'scale', label: 'Appeals waiting', source: 'appeals', note: 'Decide by Oct 14' },
];

export interface Evidence {
  tone: 'fail' | 'warn' | 'info' | 'ok';
  text: string;
}

export interface RoutedAction {
  title: string;
  owner: string;
  status: 'Completed' | 'Sent to owner' | 'Pending';
  reason?: string;
}

export interface TrustReport {
  id: string;
  score: number;
  level: 'high' | 'med';
  type: ReportType;
  status: 'Escalated' | 'Open';
  title: string;
  meta: string;
  evidence: Evidence[];
  links: Array<{ icon: IconName; label: string; to: ScreenId }>;
  actions: RoutedAction[];
}

export const ACTION_TONE: Record<RoutedAction['status'], Tone> = { Completed: 'success', 'Sent to owner': 'info', Pending: 'warning' };

export const REPORTS: TrustReport[] = [
  {
    id: 'TR-3391', score: 86, level: 'high', type: 'counterfeit', status: 'Escalated',
    title: 'Brightline S2 Robot Vacuum offered by Gadget Grove may be counterfeit',
    meta: 'Reported Oct 5 by Brightline (brand owner) and 3 customers · assigned to Sven Larsen',
    evidence: [
      { tone: 'fail', text: '4 serial numbers from buyer photos are not in the Brightline registry' },
      { tone: 'fail', text: 'Charging dock label and font differ from the brand reference photos' },
      { tone: 'warn', text: 'Offer price $279.00 is 20% below every authorized offer' },
      { tone: 'info', text: 'Seller supplied 2 purchase invoices · supplier could not be confirmed' },
    ],
    links: [
      { icon: 'store', label: 'Gadget Grove · Restricted', to: 'admin/seller' },
      { icon: 'package', label: 'Brightline S2 · BRL-S2', to: 'admin/catalog' },
      { icon: 'users', label: '14 buyers in 30 days', to: 'admin/customers' },
      { icon: 'life-buoy', label: 'CS-104933', to: 'admin/case' },
    ],
    actions: [
      { title: 'Suspend the Gadget Grove offer for BRL-S2', owner: 'Catalog · Omar Haddad', status: 'Completed', reason: 'Brand registry mismatch on 4 units' },
      { title: 'Restrict new listings in Home & Kitchen', owner: 'Seller Manager · Grace Kim', status: 'Completed', reason: 'Counterfeit risk pending review; open orders and returns stay active' },
      { title: 'Tell the 14 recent buyers how to get a refund', owner: 'Support · Isabel Cruz', status: 'Sent to owner' },
      { title: 'Hold seller payout until review', owner: 'Finance · Priya Nair', status: 'Completed', reason: 'Held $4,188.40, review Oct 16' },
    ],
  },
  {
    id: 'TR-3402', score: 74, level: 'high', type: 'suspicious', status: 'Open',
    title: '6 orders from new accounts ship to one Reno address with different cards',
    meta: 'Detected Oct 7 by payment risk rules · $1,140.94 total · Kestrel portable SSDs',
    evidence: [
      { tone: 'fail', text: '6 accounts created within 40 minutes, 5 different cards' },
      { tone: 'warn', text: '2 card payments passed with address mismatch' },
      { tone: 'info', text: 'Shipping address is a parcel forwarding service' },
    ],
    links: [
      { icon: 'user-round', label: 'Kyle Benson + 5 accounts', to: 'admin/customers' },
      { icon: 'store', label: 'Pixel & Port', to: 'admin/seller' },
      { icon: 'shopping-bag', label: '6 orders', to: 'admin/orders' },
    ],
    actions: [
      { title: 'Hold dispatch on 6 orders', owner: 'Orders · Theo Grant', status: 'Completed', reason: 'Payment risk review; seller asked not to ship' },
      { title: 'Review payments and refund if unconfirmed', owner: 'Finance · Priya Nair', status: 'Sent to owner' },
      { title: 'Ask buyers to confirm identity', owner: 'Support · Mateo Ruiz', status: 'Pending' },
    ],
  },
  {
    id: 'TR-3405', score: 58, level: 'med', type: 'reviews', status: 'Open',
    title: '11 five-star reviews on Aster Daily Vitamin C Serum posted within 2 hours',
    meta: 'Detected Oct 7 by review pattern check · product sold by Marketly Official',
    evidence: [
      { tone: 'warn', text: '9 of 11 reviewers have no recorded purchase (not Verified Purchase)' },
      { tone: 'warn', text: 'Similar wording in 7 reviews' },
      { tone: 'ok', text: '2 reviews are Verified Purchase and stay published' },
    ],
    links: [
      { icon: 'package', label: 'Aster Vitamin C Serum · AST-VC30', to: 'admin/catalog' },
      { icon: 'star', label: '11 reviews', to: 'admin/reviews' },
    ],
    actions: [
      { title: 'Remove 9 unverified reviews', owner: 'Catalog · reviews moderation · Omar Haddad', status: 'Sent to owner', reason: 'Coordinated posting by accounts with no purchase' },
      { title: 'Keep legitimate reviews, including negative ones', owner: 'Catalog · Omar Haddad', status: 'Pending' },
    ],
  },
  {
    id: 'TR-3410', score: 41, level: 'med', type: 'abuse', status: 'Open',
    title: 'Customer sent abusive messages to Pixel & Port',
    meta: 'Reported Oct 7 by the seller · linked case CS-104947',
    evidence: [
      { tone: 'warn', text: '4 messages with insults and threats after a return was approved' },
      { tone: 'info', text: 'Return itself was handled on time' },
    ],
    links: [
      { icon: 'user-round', label: 'Derek Mills · Restricted', to: 'admin/customers' },
      { icon: 'store', label: 'Pixel & Port', to: 'admin/seller' },
      { icon: 'life-buoy', label: 'CS-104947', to: 'admin/cases' },
    ],
    actions: [
      { title: 'Restrict messaging for 30 days', owner: 'Support · Isabel Cruz', status: 'Completed', reason: 'Abusive messages to seller staff; orders and refund unaffected' },
      { title: 'Send warning with appeal route', owner: 'Support · Isabel Cruz', status: 'Completed' },
    ],
  },
];

export interface Appeal {
  ref: string;
  filedBy: string;
  decision: string;
  filed: string;
  reviewer: { name: string; role: string };
  decideBy: { date: string } | { decided: string };
  status: 'Under review' | 'Open' | 'Resolved';
}

export const APPEALS: Appeal[] = [
  { ref: 'AP-0127', filedBy: 'Gadget Grove', decision: 'Listing restriction, Home & Kitchen (TR-3391)', filed: 'Oct 7', reviewer: { name: 'Morgan Hale', role: 'Business Owner' }, decideBy: { date: 'Oct 14' }, status: 'Under review' },
  { ref: 'AP-0125', filedBy: 'Derek Mills', decision: 'Messaging restricted 30 days (TR-3410)', filed: 'Oct 8', reviewer: { name: 'Grace Kim', role: 'Seller Manager' }, decideBy: { date: 'Oct 15' }, status: 'Open' },
  { ref: 'AP-0119', filedBy: 'Bayside Prints', decision: 'Review removal on 3 products', filed: 'Sep 28', reviewer: { name: 'Omar Haddad', role: 'Catalog' }, decideBy: { decided: 'Decided Oct 2' }, status: 'Resolved' },
];

export const DISMISS_REASONS = ['Evidence does not support the report', 'Duplicate of another report', 'Resolved by the seller', 'Reported in error'];
