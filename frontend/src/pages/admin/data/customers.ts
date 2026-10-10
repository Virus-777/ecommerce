// Sample data for the admin "Customers" screen (design: pages/admin/admin-customers.html and
// admin-customers--customer-detail.html). Replaced by the customer search API later.

export type AccountStatus = 'Active' | 'Restricted' | 'Under review' | 'Suspended' | 'Closed';
export type Verification = 'Email and phone' | 'Email only' | 'Not verified';

export interface CustomerRow {
  id: string;
  name: string;
  email: string;
  location: string;
  orders: number;
  spend: number;
  openCases: number;
  status: AccountStatus;
  verified: Verification;
  joined: string;
  /** Filter tags for the chips. */
  tags: Array<'abuse' | 'new' | 'guest'>;
}

export const CUSTOMERS: CustomerRow[] = [
  { id: 'CU-208114', name: 'Jordan Lee', email: 'jordan.lee@example.com', location: 'Portland, OR', orders: 5, spend: 911.48, openCases: 1, status: 'Active', verified: 'Email and phone', joined: 'Aug 2026', tags: [] },
  { id: 'CU-201377', name: 'Priya Kapoor', email: 'priya.k@example.com', location: 'Seattle, WA', orders: 12, spend: 1842.3, openCases: 0, status: 'Active', verified: 'Email and phone', joined: 'Jun 2026', tags: [] },
  { id: 'CU-210552', name: 'Sam Rivera', email: 'sam.rivera@example.com', location: 'Oakland, CA', orders: 3, spend: 296, openCases: 1, status: 'Active', verified: 'Email only', joined: 'Sep 2026', tags: [] },
  { id: 'CU-201902', name: 'Alex Morgan', email: 'alex.morgan@example.com', location: 'Boise, ID', orders: 7, spend: 1104.75, openCases: 1, status: 'Active', verified: 'Email and phone', joined: 'Jun 2026', tags: [] },
  { id: 'CU-204418', name: 'Derek Mills', email: 'dmills@example.com', location: 'Tacoma, WA', orders: 4, spend: 612.4, openCases: 1, status: 'Restricted', verified: 'Email and phone', joined: 'Jul 2026', tags: ['abuse'] },
  { id: 'CU-212930', name: 'Kyle Benson', email: 'kb.orders@example.com', location: 'Reno, NV', orders: 1, spend: 189.98, openCases: 1, status: 'Under review', verified: 'Email only', joined: 'Oct 2026', tags: ['new'] },
  { id: 'CU-213004', name: 'Nina Okafor', email: 'nina.o@example.com', location: 'Eugene, OR', orders: 1, spend: 42, openCases: 1, status: 'Active', verified: 'Not verified', joined: 'Oct 2026', tags: ['new'] },
  { id: 'CU-201655', name: 'Ella Fischer', email: 'ella.fischer@example.com', location: 'Spokane, WA', orders: 6, spend: 540.1, openCases: 0, status: 'Closed', verified: 'Email only', joined: 'Jun 2026', tags: [] },
];

export const TOTAL_CUSTOMERS = 18406;

export interface CustomerOrder {
  ref: string;
  date: string;
  sellers: number;
  total: number;
  status: string;
}

export interface CustomerDetail {
  phone: string;
  address: string;
  signIn: string;
  marketing: string;
  orders: CustomerOrder[];
  openCase?: { ref: string; summary: string; status: string };
  messages: string;
  notes: Array<{ who: string; date: string; text: string }>;
  abuse: string;
}

/** Detail records by customer id (only the sample customer has a full record). */
export const CUSTOMER_DETAIL: Record<string, CustomerDetail> = {
  'CU-208114': {
    phone: '(503) 555-0148',
    address: '2140 Alder St, Apt 5, Portland, OR 97205',
    signIn: 'Password + two-step code · last Oct 8, 7:02 AM',
    marketing: 'Email offers on · essential updates always on',
    orders: [
      { ref: 'MK-261006-90127', date: 'Oct 6, 2026', sellers: 1, total: 88.5, status: 'Preparing' },
      { ref: 'MK-260914-48213', date: 'Sep 14, 2026', sellers: 3, total: 513.98, status: 'Partly delivered' },
      { ref: 'MK-260830-11764', date: 'Aug 30, 2026', sellers: 1, total: 58, status: 'Delivered' },
      { ref: 'MK-260818-07352', date: 'Aug 18, 2026', sellers: 1, total: 139, status: 'Refunded' },
      { ref: 'MK-260811-03309', date: 'Aug 11, 2026', sellers: 1, total: 112, status: 'Cancelled' },
    ],
    openCase: { ref: 'CS-104882', summary: 'Dispute · delayed duvet cover · Casa Verde Home', status: 'Waiting on seller' },
    messages: '2 order conversations · last message Oct 6 to Casa Verde Home',
    notes: [{ who: 'Isabel Cruz', date: 'Oct 6', text: 'Polite and clear. Delay is on the seller side. Offer refund if no scan by Oct 9.' }],
    abuse: 'None filed by or against this customer.',
  },
};

export const ACCOUNT_ACTIONS = ['Send password reset link', 'Sign out of all devices', 'Restrict messaging', 'Restrict account', 'Close account'] as const;
export type AccountAction = (typeof ACCOUNT_ACTIONS)[number];

/** Account status after an action (actions not listed leave the status unchanged). */
export const ACTION_STATUS: Partial<Record<AccountAction, AccountStatus>> = { 'Restrict account': 'Restricted', 'Close account': 'Closed' };

export const ACTION_REASONS = ['Customer request', 'Suspected account takeover', 'Abusive messages', 'Payment fraud review', 'Policy violation'];
