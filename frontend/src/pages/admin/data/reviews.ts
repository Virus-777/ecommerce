import type { Tint } from '@/data/fixtures';
import type { IconName, Tone } from '@/ui';

// Sample data for admin/reviews (design: pages/admin/admin-reviews*.html).

export type ReportKind = 'Product review' | 'Seller feedback' | 'Q&A answer';
export type ReportOutcome = 'Kept' | 'Removed' | 'Edit requested';

export interface ReportedItem {
  id: string;
  kind: ReportKind;
  /** Short title in the queue. */
  title: string;
  /** Full title in the detail card. */
  fullTitle: string;
  /** Link target: the product page or the seller storefront. */
  link: 'product' | 'seller';
  icon: IconName;
  tint: Tint;
  age: string;
  rating?: number;
  reason: string;
  reasonTone: Tone;
  reportedBy: string;
  /** Who reported, for the success message. */
  reporter: string;
  headline: string;
  author: string;
  byline: string;
  verified: boolean;
  seller?: string;
  condition?: string;
  body: string;
  photos: number;
  sellerResponse?: { date: string; text: string };
  kv: Array<{ k: string; v: string; mono?: string }>;
  note?: { title: string; text: string };
}

export const LEGIT = 'Legitimate experience, no policy breach';
export const POLICY_REASONS = ['Personal information', 'Hate or harassment', 'Spam or links', 'Off-topic', 'Conflict of interest', 'Proven fake'];

export const REPORTED: ReportedItem[] = [
  {
    id: 'rv-1', kind: 'Product review', title: 'Brightline S2 Robot Vacuum', fullTitle: 'Brightline S2 Robot Vacuum with Mapping', link: 'product', icon: 'bot', tint: '1',
    age: '1 d', rating: 1, reason: 'Harms sales', reasonTone: 'warning', reportedBy: 'Reported by Gadget Grove (seller)', reporter: 'Gadget Grove',
    headline: 'Stopped mapping after a week', author: 'Chris T.', byline: 'Sep 30, 2026', verified: true, seller: 'Gadget Grove', condition: 'Refurbished',
    body: 'Worked fine for six days, then lost the floor map every run and kept bumping into the same chair. Reset it twice following the manual. Support from the seller took four days to answer. Would not buy refurbished again.',
    photos: 2,
    sellerResponse: { date: 'Oct 1', text: '"We tested this unit before shipping. Please contact us through your order for a replacement."' },
    kv: [
      { k: 'Reporter', v: 'Gadget Grove (seller)' },
      { k: 'Report reason', v: 'Harms sales · "Customer did not follow setup instructions"' },
      { k: 'Purchase', mono: 'MK-260912-30442', v: 'delivered Sep 22' },
      { k: 'Other reports', v: 'None' },
      { k: 'Helpful votes', v: '23' },
    ],
    note: { title: 'Note on separation', text: "The line about slow seller support is about the seller, not the product. It is part of the customer's honest experience, so it stays. Gadget Grove's seller rating comes only from seller feedback, which is reviewed separately." },
  },
  {
    id: 'rv-2', kind: 'Product review', title: 'Halden Pocket Bluetooth Speaker', fullTitle: 'Halden Pocket Bluetooth Speaker', link: 'product', icon: 'speaker', tint: '2',
    age: '20 h', rating: 5, reason: 'Spam or links', reasonTone: 'warning', reportedBy: 'Reported by 3 customers', reporter: 'The 3 reporting customers',
    headline: 'Great speaker, cheaper elsewhere', author: 'Sam R.', byline: 'Oct 8, 2026', verified: false, seller: 'Marketly Official Store', condition: 'New',
    body: 'Great sound for the size and the battery lasts all weekend. Found it for less at deals-hub.example/halden, use code SAVE15 there.',
    photos: 0,
    kv: [
      { k: 'Reporter', v: '3 customers' },
      { k: 'Report reason', v: 'Spam or links · "Link to another shop"' },
      { k: 'Purchase', v: 'No matching order' },
      { k: 'Other reports', v: 'Same link on 2 other products from this account' },
      { k: 'Helpful votes', v: '0' },
    ],
    note: { title: 'Pattern', text: 'The same link was posted on 3 products in 24 hours. If the review is removed for spam, Trust and Risk gets the account automatically.' },
  },
  {
    id: 'rv-3', kind: 'Product review', title: 'Mosswood Linen Duvet Cover', fullTitle: 'Mosswood Linen Duvet Cover, Queen', link: 'product', icon: 'bed-double', tint: '3',
    age: '14 h', rating: 2, reason: 'Personal information', reasonTone: 'danger', reportedBy: 'Reported by system', reporter: 'The reporting system',
    headline: 'Color is off and a seam split', author: 'Priya K.', byline: 'Oct 3, 2026', verified: true, seller: 'Casa Verde Home', condition: 'New',
    body: 'The color is greyer than the photos and a seam split on the second wash. I called the seller at (555) 014-2290 and emailed priya.k@example.com twice with no reply.',
    photos: 1,
    kv: [
      { k: 'Reporter', v: 'System (personal information filter)' },
      { k: 'Report reason', v: 'Personal information · phone number and email in the text' },
      { k: 'Purchase', mono: 'MK-260927-11873', v: 'delivered Oct 1' },
      { k: 'Other reports', v: 'None' },
      { k: 'Helpful votes', v: '4' },
    ],
    note: { title: 'Suggested action', text: 'Request an edit to remove the phone number and email. The rest is an honest product experience and can stay.' },
  },
  {
    id: 'rv-4', kind: 'Seller feedback', title: 'Pixel & Port', fullTitle: 'Pixel & Port', link: 'seller', icon: 'store', tint: '4',
    age: '11 h', rating: 1, reason: 'Abusive language', reasonTone: 'danger', reportedBy: 'Reported by Pixel & Port (seller)', reporter: 'Pixel & Port',
    headline: 'Sent a used charger as new', author: 'Dev M.', byline: 'Oct 7, 2026', verified: true,
    body: 'Shipped a used charger as new, scratches all over it. These people are crooks and idiots, avoid them.',
    photos: 0,
    kv: [
      { k: 'Reporter', v: 'Pixel & Port (seller)' },
      { k: 'Report reason', v: 'Abusive language' },
      { k: 'Purchase', mono: 'MK-260929-50418', v: 'delivered Oct 4' },
      { k: 'Other reports', v: 'None' },
      { k: 'Helpful votes', v: '2' },
    ],
    note: { title: 'Note on separation', text: "This is seller feedback, so it only affects Pixel & Port's seller rating. The complaint about a used item is fair; the insult is what breaks the policy." },
  },
  {
    id: 'rv-5', kind: 'Q&A answer', title: 'Tidewell Insulated Bottle 750 ml', fullTitle: 'Tidewell Insulated Bottle 750 ml', link: 'product', icon: 'cup-soda', tint: '6',
    age: '6 h', reason: 'Inaccurate answer', reasonTone: 'outline', reportedBy: 'Reported by Trailhead Outfitters', reporter: 'Trailhead Outfitters',
    headline: '"Is it dishwasher safe?"', author: 'Lena P.', byline: 'Oct 4, 2026 · customer answer', verified: false,
    body: '"Yes, totally fine in the dishwasher, I do it daily."',
    photos: 0,
    kv: [
      { k: 'Reporter', v: 'Trailhead Outfitters (seller)' },
      { k: 'Report reason', v: 'Inaccurate answer · "Brand says hand wash only"' },
      { k: 'Product listing', v: 'Care label: hand wash only' },
      { k: 'Other reports', v: 'None' },
      { k: 'Helpful votes', v: '5' },
    ],
    note: { title: 'Option', text: 'A wrong customer answer does not break the policy on its own. Keep it and add a staff answer from the care label.' },
  },
  {
    id: 'rv-6', kind: 'Product review', title: 'Corvo Grip Yoga Mat 6 mm', fullTitle: 'Corvo Grip Yoga Mat 6 mm', link: 'product', icon: 'activity', tint: '5',
    age: '2 h', rating: 5, reason: 'Suspected paid review', reasonTone: 'danger', reportedBy: 'Flagged by Trust and Risk', reporter: 'Trust and Risk',
    headline: 'Perfect mat!!!', author: 'Alex J.', byline: 'Oct 9, 2026', verified: true, seller: 'FlexFit Supply', condition: 'New',
    body: 'Perfect mat, amazing grip, best purchase ever. Five stars, highly recommend to everyone!!!',
    photos: 0,
    kv: [
      { k: 'Reporter', v: 'Trust and Risk (Sven Larsen)' },
      { k: 'Report reason', v: 'Suspected paid review · order refunded in full after posting' },
      { k: 'Purchase', mono: 'MK-261001-77302', v: 'refunded Oct 9' },
      { k: 'Other reports', v: '11 similar reviews for this seller in 7 days' },
      { k: 'Helpful votes', v: '0' },
    ],
    note: { title: 'Evidence', text: "Proven fake needs Trust and Risk evidence. Case TR-2210 links the refunds to the seller's reviewer group." },
  },
];

export interface DecidedRow {
  id: string;
  title: string;
  kind: ReportKind;
  outcome: ReportOutcome;
  reason: string;
  by: string;
  when: string;
}

export const DECIDED_SEED: DecidedRow[] = [
  { id: 'd-1', title: 'Nordvik Merino Wool Crew Sweater', kind: 'Product review', outcome: 'Kept', reason: LEGIT, by: 'Noor Aziz', when: 'Oct 9' },
  { id: 'd-2', title: 'Halden Aurora ANC Headphones', kind: 'Q&A answer', outcome: 'Removed', reason: 'Spam or links', by: 'Isabel Cruz', when: 'Oct 9' },
];

/* ---------- Q&A answers and seller responses ---------- */

export type RowAction = 'keep' | 'staff' | 'edit' | 'remove' | 'publish' | 'reject' | 'trust';
export type Edge = '' | 'warn' | 'flagged';

export interface QaRow {
  id: string;
  product: string;
  question: string;
  answer: string;
  by: { label: string; tone: Tone };
  why: string;
  edge: Edge;
  actions: RowAction[];
}

export const QA_ROWS: QaRow[] = [
  { id: 'qa-1', product: 'Tidewell Insulated Bottle 750 ml', question: '"Is it dishwasher safe?"', answer: '"Yes, totally fine in the dishwasher, I do it daily."', by: { label: 'Customer', tone: '' }, why: 'Reported by seller: brand says hand wash only', edge: '', actions: ['keep', 'staff'] },
  { id: 'qa-2', product: 'Halden Aurora ANC Headphones', question: '"Does it work with two phones at once?"', answer: '"Yes, multipoint with 2 devices. Buy from us at northwind-audio.example for 10% off."', by: { label: 'Seller · Northwind Audio', tone: 'info' }, why: 'Off-platform link and offer', edge: 'warn', actions: ['edit', 'remove'] },
  { id: 'qa-3', product: 'Kestrel 27" 4K Monitor', question: '"Can it charge a 16-inch laptop?"', answer: '"It delivers 65 W over USB-C. Some 16-inch laptops need 90 W or more and will charge slowly."', by: { label: 'Marketly staff', tone: 'brand' }, why: 'New staff answer, second check', edge: '', actions: ['publish'] },
  { id: 'qa-4', product: 'Aster Vitamin C Serum 30 ml', question: '"Will this cure acne scars?"', answer: '"It removes scars in 2 weeks, guaranteed."', by: { label: 'Customer', tone: '' }, why: 'Medical claim filter', edge: 'flagged', actions: ['remove'] },
];

export interface ResponseRow {
  id: string;
  rating: number;
  review: string;
  context: string;
  seller: string;
  response: string;
  check: { label: string; tone: Tone };
  edge: Edge;
  actions: RowAction[];
}

export const RESPONSE_ROWS: ResponseRow[] = [
  { id: 'sr-1', rating: 2, review: '"Duvet faded after the second wash."', context: 'Product review · Mosswood Duvet Cover', seller: 'Casa Verde Home', response: '"Sorry to hear this. Wash below 40 °C. Message us through your order and we\'ll help with a replacement."', check: { label: 'Passed', tone: 'success' }, edge: '', actions: ['publish'] },
  { id: 'sr-2', rating: 1, review: '"Package arrived 9 days late, no updates."', context: 'Seller feedback · Gadget Grove', seller: 'Gadget Grove', response: '"Delete this review and we\'ll refund you $20."', check: { label: 'Offers payment to change a review', tone: 'danger' }, edge: 'flagged', actions: ['reject', 'trust'] },
];

export const ROW_REASONS = ['Off-platform link or offer', 'Medical or safety claim', 'Inaccurate information', 'Offers payment to change a review', 'Personal information', 'Hate or harassment', 'Off-topic'];
