// Sample content for theme-components.html.

/** Status models from the plan: each row lists its statuses; tones come from STATUS_TONE. */
export const STATUS_ROWS: Array<{ label: string; statuses: string[] }> = [
  { label: 'Order and item', statuses: ['New', 'Confirmed', 'Preparing', 'Delayed', 'Shipped', 'In transit', 'Delivered', 'Partly delivered', 'Cancelled', 'Overdue'] },
  { label: 'Payment and refund', statuses: ['Accepted', 'Pending', 'Checking', 'Failed', 'Refunded', 'Requested', 'Under review', 'Approved', 'Processing', 'Sent'] },
  { label: 'Product review & publication', statuses: ['Draft', 'Submitted', 'Changes requested', 'Approved', 'Rejected', 'Active', 'Hidden', 'Suspended'] },
  { label: 'Seller account', statuses: ['Applied', 'Information required', 'Under review', 'Approved', 'Restricted', 'Suspended', 'Closed'] },
  { label: 'Stock groups', statuses: ['Available', 'Reserved', 'Incoming', 'Damaged', 'Held', 'Returned'] },
  { label: 'Payouts', statuses: ['Pending', 'Processing', 'Paid', 'Failed', 'On hold', 'Negative'] },
  { label: 'Ad campaigns', statuses: ['Draft', 'In review', 'Approved', 'Scheduled', 'Live', 'Paused', 'Finished', 'Archived'] },
  { label: 'Cases', statuses: ['Open', 'Waiting on seller', 'Escalated', 'Decision made', 'Appealed', 'Resolved', 'Reopened'] },
];

export interface DemoOrder {
  ref: string;
  customer: string;
  items: number;
  total: number;
  status: string;
  deadline: { tone: 'ok' | 'warning' | 'danger'; text: string };
  /** Missed a promise: red left edge (.is-flagged). */
  flagged?: boolean;
}

export const DEMO_ORDERS: DemoOrder[] = [
  { ref: 'MK-261008-12077', customer: 'Sam R.', items: 2, total: 118, status: 'New', deadline: { tone: 'warning', text: 'Today 5:00 PM' } },
  { ref: 'MK-261007-10433', customer: 'Alex M.', items: 1, total: 59, status: 'Preparing', deadline: { tone: 'danger', text: 'Overdue 3 h' }, flagged: true },
  { ref: 'MK-261007-09811', customer: 'Chris T.', items: 1, total: 190.99, status: 'Shipped', deadline: { tone: 'ok', text: 'Shipped Oct 8' } },
];

/** Daily gross sales, Official Store vs marketplace sellers (USD). */
export const SALES_CHART = {
  labels: ['Sep 25', 'Sep 26', 'Sep 27', 'Sep 28', 'Sep 29', 'Sep 30', 'Oct 1', 'Oct 2', 'Oct 3', 'Oct 4', 'Oct 5', 'Oct 6', 'Oct 7', 'Oct 8'],
  series: [
    { name: 'Official', data: [18200, 19100, 22400, 24800, 17600, 16900, 18400, 20200, 21000, 25600, 27100, 19400, 18800, 20600] },
    { name: 'Sellers', data: [11400, 12000, 14800, 16200, 12100, 12600, 13000, 14400, 15100, 18900, 20300, 14200, 14900, 16100] },
  ],
};
