import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { Icon, type IconName } from './Icon';

export type Tone = '' | 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'deal' | 'deal-soft' | 'outline' | 'solid';

/** .badge with an optional tone (t-*) and leading icon. */
export function Badge({ tone, icon, className, children }: { tone?: Tone; icon?: IconName; className?: string; children: ReactNode }) {
  return (
    <span className={cx('badge', tone && `t-${tone}`, className)}>
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}

/** Every status model in the plan maps to one tone. Unknown statuses are neutral. */
export const STATUS_TONE: Record<string, Tone> = {
  // Product review & publication
  Draft: '', Submitted: 'info', 'Changes requested': 'warning', Approved: 'success', Rejected: 'danger',
  Active: 'success', Hidden: '', Suspended: 'danger',
  // Seller account
  Applied: 'info', 'Information required': 'warning', 'Under review': 'info', Restricted: 'warning', Closed: '',
  // Stock groups
  Available: 'success', Reserved: 'info', Incoming: '', Damaged: 'danger', Held: 'warning', Returned: 'warning',
  'In stock': 'success', 'Low stock': 'warning', 'Out of stock': 'danger',
  // Payment
  Accepted: 'success', Pending: 'warning', Failed: 'danger', Refunded: '', 'Partly refunded': '', Checking: 'warning', Authorized: 'info', Captured: 'success',
  // Order & item
  New: 'brand', Confirmed: 'info', Preparing: 'info', Delayed: 'warning', Shipped: 'info', 'In transit': 'info', 'Out for delivery': 'info',
  Delivered: 'success', 'Partly delivered': 'warning', Cancelled: '', 'Partly cancelled': '', Completed: 'success', Overdue: 'danger', 'Delivery failed': 'danger', Lost: 'danger',
  'Cancellation requested': 'warning', Received: 'info', Inspected: 'info', Triggered: 'success',
  // Returns & refunds
  'Return requested': 'warning', 'Return approved': 'info', 'Return in transit': 'info', Inspecting: 'info', Requested: 'info', Processing: 'info', Sent: 'success',
  // Payouts & balances
  Paid: 'success', Scheduled: 'info', 'On hold': 'warning', Negative: 'danger', Matched: 'success', Mismatch: 'danger', Chargeback: 'danger', Disputed: 'danger',
  // Cases
  Open: 'info', 'Waiting on customer': 'warning', 'Waiting on seller': 'warning', Escalated: 'danger', Resolved: 'success', Reopened: 'warning', Appealed: 'warning', 'Decision made': 'success',
  // Campaigns & content
  Live: 'success', Paused: 'warning', 'Ending soon': 'warning', Finished: '', Archived: '', Published: 'success', Unpublished: '', Expired: '', 'In review': 'info',
  // Misc
  'On time': 'success', Late: 'danger', 'Due today': 'warning', Verified: 'info', Invited: 'info', Disabled: '',
};
export const statusTone = (s: string): Tone => STATUS_TONE[s] ?? '';

/** Status pill: the tone comes from STATUS_TONE unless given. */
export function StatusBadge({ status, tone, className }: { status: string; tone?: Tone; className?: string }) {
  const t = tone !== undefined ? tone : statusTone(status);
  return <span className={cx('badge', t && `t-${t}`, className)}>{status}</span>;
}

/** "Sponsored" label on paid placements (plan ch. 13: ads are always labelled). */
export function Sponsored({ label = 'Sponsored' }: { label?: string }) {
  return (
    <span className="sponsored">
      <Icon name="info" className="ic-sm" />
      {label}
    </span>
  );
}

/** .count pill (nav and tab counts). tone 'danger' for urgent counts, with a screen-reader note. */
export function Count({ n, tone, sr, title }: { n: number | string; tone?: 'danger' | 'deal' | 'brand'; sr?: string; title?: string }) {
  return (
    <span className={cx('count', tone && `t-${tone}`)} title={title}>
      {n}
      {sr && <span className="sr-only"> {sr}</span>}
    </span>
  );
}
