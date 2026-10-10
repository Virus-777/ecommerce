// Sample rows for the seller Returns and cases list (design: seller-returns*.html).

export type ReturnTab = '' | 'received-to-inspect' | 'disputes' | 'closed';

export interface ReturnRow {
  ref: string;
  order: string;
  tab: ReturnTab;
  item: string;
  sku: string;
  reason: string;
  detail: string;
  /** Amount column (Refunded on the Closed tab). */
  amount: number;
  /** Amount shown on the phone card when it differs (closed, rejected). */
  phoneAmount?: number;
  requested: string;
  /** Deadline chip, or plain text when there is no tone. */
  due: { text: string; tone?: 'ok' | 'warning' | 'danger' };
  status: string;
  edge?: 'flagged' | 'warn';
  /** "Marketly support involved" badge tone (disputes). */
  support?: 'danger' | 'info';
}

export const RETURN_ROWS: ReturnRow[] = [
  // Return requests
  { ref: 'RT-261004-0871', order: 'MK-260929-05518', tab: '', item: 'Studio Cable Kit', sku: 'NWA-CBL-KIT', reason: 'Missing parts', detail: 'No 3.5 mm adapter in the box', amount: 24, requested: 'Oct 4, 7:02 PM', due: { text: 'Overdue 6 h', tone: 'danger' }, status: 'Return requested', edge: 'flagged' },
  { ref: 'RT-261005-0912', order: 'MK-260926-31840', tab: '', item: 'Halden Pocket Bluetooth Speaker', sku: 'HAL-PKT-TEAL', reason: 'Defective', detail: 'Audio cuts out after a few minutes', amount: 59, requested: 'Oct 5, 4:12 PM', due: { text: 'Oct 9, 4:00 PM', tone: 'warning' }, status: 'Return requested', edge: 'warn' },
  { ref: 'RT-261007-0977', order: 'MK-261001-03321', tab: '', item: 'Halden Aurora ANC Wireless Headphones', sku: 'HAL-AUR-BLK', reason: 'Changed mind', detail: 'Prefers a different fit', amount: 184, requested: 'Oct 7, 9:40 AM', due: { text: 'Oct 10, 9:40 AM', tone: 'ok' }, status: 'Return requested' },
  { ref: 'RT-261006-0941', order: 'MK-260930-06102', tab: '', item: 'Halden Pocket Bluetooth Speaker', sku: 'HAL-PKT-SND', reason: 'Not as described', detail: 'Color differs from photos; you asked for a photo', amount: 59, requested: 'Oct 6, 1:15 PM', due: { text: 'Customer replies by Oct 11' }, status: 'Waiting on customer' },
  { ref: 'RT-261003-0855', order: 'MK-260927-02233', tab: '', item: 'Studio Cable Kit', sku: 'NWA-CBL-KIT', reason: 'Arrived damaged', detail: 'Bent connector; prepaid label sent Oct 4', amount: 24, requested: 'Oct 3, 10:05 AM', due: { text: 'Arrives Oct 9' }, status: 'Return in transit' },
  // Received, to inspect
  { ref: 'RT-261001-0745', order: 'MK-260925-04410', tab: 'received-to-inspect', item: 'Halden Pocket Bluetooth Speaker × 2', sku: 'HAL-PKT-TEAL', reason: 'Changed mind', detail: 'Received Oct 7, 2:00 PM', amount: 118, requested: 'Oct 1, 8:30 PM', due: { text: 'Oct 9, 2:00 PM', tone: 'warning' }, status: 'Inspecting', edge: 'warn' },
  { ref: 'RT-260930-0730', order: 'MK-260922-01954', tab: 'received-to-inspect', item: 'Halden Aurora ANC Wireless Headphones', sku: 'HAL-AUR-BLK', reason: 'Defective', detail: 'Received Oct 8, 9:05 AM', amount: 184, requested: 'Sep 30, 6:44 PM', due: { text: 'Oct 10, 9:05 AM', tone: 'ok' }, status: 'Inspecting' },
  // Disputes
  { ref: 'RT-260927-0622', order: 'MK-260920-88341', tab: 'disputes', item: 'Halden Aurora ANC Wireless Headphones', sku: 'HAL-AUR-BLK', reason: 'Not as described', detail: 'Customer disputes your $46.00 partial refund · case CS-261002-1180', amount: 184, requested: 'Sep 27, 11:20 AM', due: { text: 'Evidence due Oct 9, 5:00 PM', tone: 'warning' }, status: 'Escalated', edge: 'flagged', support: 'danger' },
  { ref: 'RT-260919-0410', order: 'MK-260914-71206', tab: 'disputes', item: 'Studio Cable Kit', sku: 'NWA-CBL-KIT', reason: 'Wrong item', detail: 'Marketly decided: refund without return · case CS-260923-1033', amount: 24, requested: 'Sep 19, 3:02 PM', due: { text: 'Appeal by Oct 16', tone: 'ok' }, status: 'Decision made', support: 'info' },
  // Closed
  { ref: 'RT-261002-0804', order: 'MK-260928-04877', tab: 'closed', item: 'Studio Cable Kit', sku: 'NWA-CBL-KIT', reason: 'Missing parts', detail: 'Partial refund $8.00 for missing adapter', amount: 8, requested: 'Oct 2, 9:12 AM', due: { text: 'Closed Oct 3' }, status: 'Partly refunded' },
  { ref: 'RT-260930-0718', order: 'MK-260923-09310', tab: 'closed', item: 'Halden Pocket Bluetooth Speaker', sku: 'HAL-PKT-TEAL', reason: 'Defective', detail: 'Full refund after inspection', amount: 59, requested: 'Sep 30, 8:51 AM', due: { text: 'Closed Oct 2' }, status: 'Refunded' },
  { ref: 'RT-260924-0533', order: 'MK-260912-55102', tab: 'closed', item: 'Halden Aurora ANC Wireless Headphones', sku: 'HAL-AUR-BLK', reason: 'Defective', detail: 'Refunded after payout; deducted on statement Sep 28 – Oct 4', amount: 184, requested: 'Sep 24, 5:30 PM', due: { text: 'Closed Sep 30' }, status: 'Refunded' },
  { ref: 'RT-260921-0498', order: 'MK-260815-20661', tab: 'closed', item: 'Halden Pocket Bluetooth Speaker', sku: 'HAL-PKT-SND', reason: 'Changed mind', detail: 'Rejected: requested 7 days after the 30-day window', amount: 0, phoneAmount: 59, requested: 'Sep 21, 12:40 PM', due: { text: 'Closed Sep 22' }, status: 'Rejected' },
];

export const RETURN_REASONS = ['All reasons', 'Defective', 'Changed mind', 'Not as described', 'Missing parts', 'Arrived damaged', 'Wrong item'];
export const RETURN_PERIODS = ['Last 30 days', 'Last 90 days', 'This year'];
