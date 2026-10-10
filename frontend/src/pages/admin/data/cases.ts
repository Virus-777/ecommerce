// Sample data for admin/cases (design: pages/admin/admin-cases.html). Shaped like the cases API.

export type CasePriority = 'High' | 'Medium' | 'Low';
export type DeadlineTone = 'danger' | 'warning' | 'ok';

export interface CaseRow {
  id: string;
  /** Order reference, or null for account cases. */
  order: string | null;
  category: string;
  detail: string;
  priority: CasePriority;
  customer: string;
  seller: string | null;
  /** Staff owner, or null while unassigned. */
  owner: string | null;
  status: string;
  next: { label: string; tone: DeadlineTone };
  /** Opened at (for "Sort: newest"). */
  opened: string;
}

export const CASES: CaseRow[] = [
  { id: 'CS-104921', order: 'MK-260930-44310', category: 'Delivery', detail: 'lost package', priority: 'High', customer: 'Alex Morgan', seller: 'Marketly Official', owner: null, status: 'Open', next: { label: 'Overdue 1 h', tone: 'danger' }, opened: '2026-10-07T09:10' },
  { id: 'CS-104915', order: 'MK-261001-30554', category: 'Return dispute', detail: 'damaged on arrival', priority: 'High', customer: 'Sam Rivera', seller: 'Pixel & Port', owner: 'Lena Park', status: 'Escalated', next: { label: 'Overdue 4 h', tone: 'danger' }, opened: '2026-10-06T15:22' },
  { id: 'CS-104933', order: 'MK-261006-09977', category: 'Dispute', detail: 'not as described', priority: 'Medium', customer: 'Chris Taylor', seller: 'Gadget Grove', owner: null, status: 'Open', next: { label: 'Overdue 30 min', tone: 'danger' }, opened: '2026-10-07T13:40' },
  { id: 'CS-104882', order: 'MK-260914-48213', category: 'Dispute', detail: 'delayed item', priority: 'High', customer: 'Jordan Lee', seller: 'Casa Verde Home', owner: 'Isabel Cruz', status: 'Waiting on seller', next: { label: 'Due 12:00 PM', tone: 'warning' }, opened: '2026-09-23T20:14' },
  { id: 'CS-104930', order: 'MK-260926-37720', category: 'Refund', detail: 'not received', priority: 'Medium', customer: 'Priya Kapoor', seller: 'Northwind Audio', owner: 'Isabel Cruz', status: 'Open', next: { label: 'Due 1:30 PM', tone: 'warning' }, opened: '2026-10-07T11:05' },
  { id: 'CS-104944', order: 'MK-261007-52018', category: 'Order change', detail: 'cancel item', priority: 'Medium', customer: 'Kyle Benson', seller: 'Pixel & Port', owner: null, status: 'Open', next: { label: 'Due 3:00 PM', tone: 'ok' }, opened: '2026-10-08T07:50' },
  { id: 'CS-104947', order: 'MK-260929-41175', category: 'Seller report', detail: 'abusive messages', priority: 'Medium', customer: 'Derek Mills', seller: 'Pixel & Port', owner: 'Sven Larsen', status: 'Open', next: { label: 'Due 4:00 PM', tone: 'ok' }, opened: '2026-10-08T08:30' },
  { id: 'CS-104940', order: null, category: 'Account', detail: 'cannot sign in', priority: 'Low', customer: 'Nina Okafor', seller: null, owner: 'Mateo Ruiz', status: 'Waiting on customer', next: { label: 'Oct 9, 10:00 AM', tone: 'ok' }, opened: '2026-10-07T18:00' },
  { id: 'CS-104951', order: 'MK-261003-48802', category: 'Delivery', detail: 'delayed', priority: 'Low', customer: 'Hana Sato', seller: 'Trailhead Outfitters', owner: 'Aisha Bello', status: 'Reopened', next: { label: 'Oct 9, 11:00 AM', tone: 'ok' }, opened: '2026-10-08T09:15' },
  { id: 'CS-104802', order: 'MK-260920-30017', category: 'Dispute', detail: 'wrong item sent', priority: 'Medium', customer: 'Ben Alvarez', seller: 'Gadget Grove', owner: 'Isabel Cruz', status: 'Appealed', next: { label: 'Appeal ends Oct 9', tone: 'warning' }, opened: '2026-09-21T10:00' },
];

/** People a case can be assigned to, with their current open-case load. */
export interface Assignee {
  name: string;
  team?: string;
  open: number;
}

export const ASSIGNEES: Assignee[] = [
  { name: 'Mateo Ruiz', open: 2 },
  { name: 'Aisha Bello', open: 5 },
  { name: 'Isabel Cruz', open: 9 },
  { name: 'Lena Park', team: 'Returns', open: 6 },
];

export const CASE_CATEGORIES = ['Delivery', 'Return dispute', 'Dispute', 'Refund', 'Order change', 'Account', 'Seller report'];

/** Queue totals across every page (the table shows page 1 of 4). */
export const CASE_TOTALS = { all: 31, mine: 0, unassigned: 6, overdue: 5, disputes: 4 } as const;
