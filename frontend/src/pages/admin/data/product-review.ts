import type { Tint } from '@/data/fixtures';
import type { IconName, Tone } from '@/ui';

// Sample data for the admin review queue (design: pages/admin/admin-product-review.html).

export type QueueKind = 'new' | 'shared';
export type Decision = 'approve' | 'changes' | 'reject';
export type SubmissionStatus = 'Submitted' | 'Approved' | 'Changes requested' | 'Rejected';

export interface QueueFlag {
  tone: Tone;
  icon: IconName;
  label: string;
}

/** Description text; `mark` segments are highlighted as problem claims. */
export type DescSegment = string | { mark: string };

export interface ReviewImage {
  icon: IconName;
  tint: Tint;
  caption: string;
  bad?: boolean;
}

export interface ReviewAttribute {
  name: string;
  value?: string;
  required?: boolean;
}

export interface ReviewCheck {
  id: string;
  tone: 'danger' | 'warning' | 'success';
  icon: IconName;
  title: string;
  badge: string;
  /** Paragraph, or bullet points. */
  body: string | string[];
}

export interface FieldComment {
  id: string;
  field: string;
  comment: string;
}

export interface HistoryEvent {
  t: string;
  d: string;
  state: 'current' | 'warn' | 'done';
}

export interface Submission {
  id: string;
  ref: string;
  kind: QueueKind;
  resubmitted?: boolean;
  title: string;
  icon: IconName;
  tint: Tint;
  seller: string;
  sellerInitials: string;
  sellerTint: Tint;
  cat: string;
  sub: string;
  flags: QueueFlag[];
  waiting: string;
  waitingTone: 'ok' | 'warning' | 'danger';
  submittedBy: string;
  submittedAt: string;
  reviewBy: string;
  brand: string;
  brandNote?: string;
  /** Category the attributes suggest, when it differs from the submitted one. */
  categoryDiffers?: boolean;
  model: string;
  upc: string;
  offer: string;
  description: DescSegment[];
  images: ReviewImage[];
  attributes: ReviewAttribute[];
  checks: ReviewCheck[];
  checksRan: string;
  comments: FieldComment[];
  history: HistoryEvent[];
  /** Existing product this may duplicate (opens the merge flow). */
  duplicateOf?: string;
  defaultDecision?: Decision;
  defaultReason?: string;
}

export const REASONS = ['Misleading or prohibited claims', 'Duplicate of an existing product', 'Images do not meet standards', 'Wrong category', 'Missing required information'];
export const QUEUE_CATEGORIES = ['Computers', 'Electronics', 'Home & Kitchen', 'Beauty', 'Sports & Outdoors'];
export const COMMENT_FIELDS = ['Title', 'Description', 'Images', 'Category', 'Attributes', 'Warranty', 'Identifiers'];

const passed = (seller: string): ReviewCheck[] => [
  { id: 'brand', tone: 'success', icon: 'shield-check', title: 'Brand authorization', badge: 'Passed', body: `${seller} may list this brand (checked at submission).` },
  { id: 'safety', tone: 'success', icon: 'circle-check', title: 'Restricted items and safety', badge: 'Passed', body: 'Not a restricted category.' },
  { id: 'ids', tone: 'success', icon: 'scan-barcode', title: 'Identifiers', badge: 'Passed', body: 'UPC is valid and not used by another product.' },
];

const basicHistory = (by: string, at: string): HistoryEvent[] => [
  { t: 'Waiting for a reviewer', d: 'Auto-assign by category', state: 'current' },
  { t: 'Submitted for review', d: `${at} · ${by}`, state: 'done' },
];

export const SUBMISSIONS: Submission[] = [
  {
    id: 'sub-26100614', ref: 'SUB-26100614', kind: 'new', title: 'Kestrel K75 Wireless Mechanical Keyboard, Lavender', icon: 'keyboard', tint: '6',
    seller: 'Pixel & Port', sellerInitials: 'PP', sellerTint: '6', cat: 'Computers', sub: 'Accessories',
    flags: [{ tone: 'danger', icon: 'circle-alert', label: 'Possible duplicate' }], waiting: 'Waiting 2 d', waitingTone: 'warning',
    submittedBy: 'Dev Malik', submittedAt: 'Oct 6, 2:14 PM PT', reviewBy: 'Oct 9',
    brand: 'Kestrel', brandNote: 'Pixel & Port is an authorized reseller', categoryDiffers: true, model: 'K75-LV-BR', upc: '0 84172 55613 9',
    offer: '$114.00 · New · 20 in stock · ships in 1–2 business days',
    description: [
      'Compact 75% wireless mechanical keyboard in lavender with hot-swappable Kestrel Brown tactile switches, PBT double-shot keycaps and a 4,000 mAh battery. Connect over Bluetooth 5.1, 2.4 GHz or USB-C. ',
      { mark: 'The #1 rated keyboard for creators' }, ', backed by a ', { mark: 'lifetime warranty' }, '.',
    ],
    images: [
      { icon: 'keyboard', tint: '6', caption: '1 · Main · 2000 px' },
      { icon: 'keyboard', tint: '6', caption: '2 · Side · 2000 px' },
      { icon: 'badge-percent', tint: '4', caption: '3 · Text overlay', bad: true },
      { icon: 'cable', tint: '6', caption: '4 · Ports · 1600 px' },
      { icon: 'image', tint: '6', caption: '5 · 640 px, too small', bad: true },
    ],
    attributes: [
      { name: 'Connection', value: 'Bluetooth 5.1, 2.4 GHz, USB-C' },
      { name: 'Layout size', value: '75%' },
      { name: 'Switch type', value: 'Kestrel Brown (tactile)' },
      { name: 'Keycaps', value: 'PBT double-shot' },
      { name: 'Battery', value: '4,000 mAh' },
      { name: 'Weight', value: '830 g' },
      { name: 'Color', value: 'Lavender' },
      { name: 'Warranty', required: true },
    ],
    checksRan: 'Oct 6, 2:15 PM',
    checks: [
      { id: 'dup', tone: 'danger', icon: 'copy', title: 'Possible duplicate of PRD-10233', badge: 'Blocking', body: 'Same brand, model family and UPC prefix as an existing product. Only the color differs, so this is likely a new variation, not a new product.' },
      { id: 'img', tone: 'warning', icon: 'image', title: 'Image standards: 2 issues', badge: 'Needs fix', body: ['Image 3 has a "50% OFF" text overlay. Promotional text is not allowed on product images.', 'Image 5 is 640 × 640 px. The minimum is 1000 × 1000 px.'] },
      { id: 'cat', tone: 'warning', icon: 'folder-tree', title: 'Category mismatch', badge: 'Needs fix', body: 'Submitted under Computers › Accessories. Attributes match Computers › Keyboards (94% match). Keyboards requires Switch type and Warranty.' },
      { id: 'claims', tone: 'danger', icon: 'ban', title: 'Prohibited claims', badge: 'Blocking', body: ['"#1 rated keyboard for creators" is an unverifiable ranking claim.', '"Lifetime warranty" conflicts with the Kestrel brand warranty of 2 years. Offer-specific warranties go in the offer terms.'] },
      { id: 'brand', tone: 'success', icon: 'shield-check', title: 'Brand authorization', badge: 'Passed', body: 'Pixel & Port is on the Kestrel authorized seller list (checked Oct 6).' },
      { id: 'safety', tone: 'success', icon: 'circle-check', title: 'Restricted items and safety', badge: 'Passed', body: 'Not a restricted category. Lithium battery is built in and under 100 Wh, so ground shipping is allowed.' },
      { id: 'ids', tone: 'success', icon: 'scan-barcode', title: 'Identifiers', badge: 'Passed', body: 'UPC is valid and not used by another product.' },
    ],
    comments: [
      { id: 'c1', field: 'Description', comment: 'Remove "#1 rated" and "lifetime warranty". Put any seller warranty in your offer terms.' },
      { id: 'c2', field: 'Images 3 and 5', comment: 'Replace image 3 with one without text. Upload image 5 at 1000 px or larger.' },
      { id: 'c3', field: 'Category', comment: 'Move to Computers › Keyboards.' },
      { id: 'c4', field: 'Warranty', comment: 'Add the manufacturer warranty (Kestrel: 2 years).' },
    ],
    history: [
      { t: 'Assigned to Omar Haddad', d: 'Oct 7, 9:00 AM · auto-assign by category', state: 'current' },
      { t: 'Automated checks finished', d: 'Oct 6, 2:15 PM · 4 issues, 3 passed', state: 'warn' },
      { t: 'Submitted for review', d: 'Oct 6, 2:14 PM · Dev Malik, Pixel & Port', state: 'done' },
      { t: 'Draft saved', d: 'Oct 5, 6:02 PM · Dev Malik', state: 'done' },
    ],
    duplicateOf: 'PRD-10233', defaultDecision: 'changes', defaultReason: 'Misleading or prohibited claims',
  },
  {
    id: 'sub-26100571', ref: 'SUB-26100571', kind: 'new', resubmitted: true, title: 'Aster Retinol Night Cream 50 ml', icon: 'droplet', tint: '5',
    seller: 'Marketly Official', sellerInitials: 'MO', sellerTint: 'brand', cat: 'Beauty', sub: 'Skincare',
    flags: [{ tone: 'info', icon: 'info', label: 'Resubmitted' }], waiting: 'Waiting 1 d 4 h', waitingTone: 'ok',
    submittedBy: 'Lena Ortiz', submittedAt: 'Oct 7, 10:20 AM PT', reviewBy: 'Oct 10',
    brand: 'Aster', model: 'AST-RN50', upc: '0 71622 30418 2', offer: '$32.00 · New · 140 in stock · ships in 1 business day',
    description: ['Overnight retinol cream with ceramides and squalane. Fragrance-free. Full ingredients list added after the previous change request.'],
    images: [
      { icon: 'droplet', tint: '5', caption: '1 · Main · 2000 px' },
      { icon: 'droplet', tint: '5', caption: '2 · Back label · 2000 px' },
      { icon: 'list', tint: '5', caption: '3 · Ingredients · 1800 px' },
    ],
    attributes: [{ name: 'Volume', value: '50 ml' }, { name: 'Skin type', value: 'All' }, { name: 'Ingredients', value: 'Listed', required: true }],
    checksRan: 'Oct 7, 10:21 AM', checks: passed('Marketly Official'), comments: [],
    history: [
      { t: 'Resubmitted for review', d: 'Oct 7, 10:20 AM · Lena Ortiz, Marketly Official', state: 'current' },
      { t: 'Changes requested', d: 'Oct 5, 3:40 PM · Noor Aziz · Missing required information', state: 'warn' },
      { t: 'Submitted for review', d: 'Oct 4, 9:12 AM · Lena Ortiz', state: 'done' },
    ],
    defaultDecision: 'approve',
  },
  {
    id: 'sub-26100602', ref: 'SUB-26100602', kind: 'new', title: 'Northwind Studio Cable Kit, 3-pack', icon: 'cable', tint: '2',
    seller: 'Northwind Audio', sellerInitials: 'NA', sellerTint: '2', cat: 'Electronics', sub: 'Accessories',
    flags: [], waiting: 'Waiting 1 d', waitingTone: 'ok', submittedBy: 'Sam Rivera', submittedAt: 'Oct 7, 2:02 PM PT', reviewBy: 'Oct 10',
    brand: 'Northwind', model: 'NW-CBL-3', upc: '0 66310 22109 4', offer: '$24.00 · New · 80 in stock · ships in 1–2 business days',
    description: ['Three braided 3.5 mm audio cables (1 m, 2 m, 3 m) with gold-plated connectors.'],
    images: [{ icon: 'cable', tint: '2', caption: '1 · Main · 2000 px' }, { icon: 'cable', tint: '2', caption: '2 · Detail · 2000 px' }],
    attributes: [{ name: 'Connector', value: '3.5 mm' }, { name: 'Length', value: '1 m, 2 m, 3 m' }],
    checksRan: 'Oct 7, 2:03 PM', checks: passed('Northwind Audio'), comments: [], history: basicHistory('Sam Rivera, Northwind Audio', 'Oct 7, 2:02 PM'), defaultDecision: 'approve',
  },
  {
    id: 'sub-26100623', ref: 'SUB-26100623', kind: 'new', title: 'Mosswood Linen Napkins, set of 4', icon: 'layers', tint: '1',
    seller: 'Casa Verde Home', sellerInitials: 'CV', sellerTint: '1', cat: 'Home & Kitchen', sub: 'Kitchen linens',
    flags: [{ tone: 'warning', icon: 'triangle-alert', label: 'Image issues' }], waiting: 'Waiting 20 h', waitingTone: 'ok',
    submittedBy: 'Ana Costa', submittedAt: 'Oct 7, 6:40 PM PT', reviewBy: 'Oct 10',
    brand: 'Mosswood', model: 'MSW-NAP4', upc: '0 81245 77310 6', offer: '$28.00 · New · 45 in stock · ships in 2 business days',
    description: ['Stonewashed linen napkins, 45 × 45 cm, set of 4 in sage.'],
    images: [{ icon: 'layers', tint: '1', caption: '1 · Main · 2000 px' }, { icon: 'image', tint: '1', caption: '2 · 700 px, too small', bad: true }],
    attributes: [{ name: 'Material', value: 'Linen' }, { name: 'Size', value: '45 × 45 cm' }],
    checksRan: 'Oct 7, 6:41 PM',
    checks: [{ id: 'img', tone: 'warning', icon: 'image', title: 'Image standards: 1 issue', badge: 'Needs fix', body: 'Image 2 is 700 × 700 px. The minimum is 1000 × 1000 px.' }, ...passed('Casa Verde Home')],
    comments: [], history: basicHistory('Ana Costa, Casa Verde Home', 'Oct 7, 6:40 PM'), defaultDecision: 'changes', defaultReason: 'Images do not meet standards',
  },
  {
    id: 'sub-26100630', ref: 'SUB-26100630', kind: 'new', title: 'Halden Aurora Replacement Ear Cushions', icon: 'headphones', tint: '3',
    seller: 'Gadget Grove', sellerInitials: 'GG', sellerTint: '3', cat: 'Electronics', sub: 'Headphones',
    flags: [{ tone: 'warning', icon: 'triangle-alert', label: 'Seller restricted' }], waiting: 'Waiting 18 h', waitingTone: 'ok',
    submittedBy: 'Chris Wu', submittedAt: 'Oct 7, 8:55 PM PT', reviewBy: 'Oct 10',
    brand: 'Halden', model: 'HAL-AUR-EC', upc: '0 85501 12043 7', offer: '$29.00 · New · 60 in stock · ships in 3 business days',
    description: ['Protein-leather replacement ear cushions for Halden Aurora ANC headphones.'],
    images: [{ icon: 'headphones', tint: '3', caption: '1 · Main · 2000 px' }],
    attributes: [{ name: 'Compatible with', value: 'Halden Aurora ANC' }],
    checksRan: 'Oct 7, 8:56 PM', checks: passed('Gadget Grove'), comments: [], history: basicHistory('Chris Wu, Gadget Grove', 'Oct 7, 8:55 PM'), defaultDecision: 'approve',
  },
  {
    id: 'sub-26100641', ref: 'SUB-26100641', kind: 'new', title: 'Trailhead Summit 2-Person Tent', icon: 'tent', tint: '5',
    seller: 'Trailhead Outfitters', sellerInitials: 'TO', sellerTint: '5', cat: 'Sports & Outdoors', sub: 'Camping',
    flags: [], waiting: 'Waiting 9 h', waitingTone: 'ok', submittedBy: 'Maya Brooks', submittedAt: 'Oct 8, 7:30 AM PT', reviewBy: 'Oct 10',
    brand: 'Trailhead', model: 'TRH-SUM2', upc: '0 69012 44871 3', offer: '$249.00 · New · 18 in stock · ships in 1–2 business days',
    description: ['Freestanding 3-season backpacking tent, 2.1 kg packed, two doors and vestibules.'],
    images: [{ icon: 'tent', tint: '5', caption: '1 · Main · 2000 px' }, { icon: 'tent', tint: '5', caption: '2 · Pitched · 2000 px' }, { icon: 'backpack', tint: '5', caption: '3 · Packed · 1600 px' }],
    attributes: [{ name: 'Capacity', value: '2 people' }, { name: 'Weight', value: '2.1 kg' }],
    checksRan: 'Oct 8, 7:31 AM', checks: passed('Trailhead Outfitters'), comments: [], history: basicHistory('Maya Brooks, Trailhead Outfitters', 'Oct 8, 7:30 AM'), defaultDecision: 'approve',
  },
  {
    id: 'sub-26100655', ref: 'SUB-26100655', kind: 'new', title: 'Brightline Smart Plug, 2-pack', icon: 'plug', tint: '6',
    seller: 'Pixel & Port', sellerInitials: 'PP', sellerTint: '6', cat: 'Electronics', sub: 'Smart home',
    flags: [{ tone: 'info', icon: 'info', label: 'Safety listing check' }], waiting: 'Waiting 3 h', waitingTone: 'ok',
    submittedBy: 'Dev Malik', submittedAt: 'Oct 8, 1:10 PM PT', reviewBy: 'Oct 10',
    brand: 'Brightline', model: 'BRL-PLG2', upc: '0 84172 90114 5', offer: '$26.00 · New · 120 in stock · ships in 1–2 business days',
    description: ['Wi-Fi smart plugs with energy monitoring. Works with major voice assistants. UL listed.'],
    images: [{ icon: 'plug', tint: '6', caption: '1 · Main · 2000 px' }, { icon: 'plug', tint: '6', caption: '2 · Side · 2000 px' }],
    attributes: [{ name: 'Certification', value: 'UL listed', required: true }, { name: 'Max load', value: '15 A' }],
    checksRan: 'Oct 8, 1:11 PM',
    checks: [{ id: 'safety', tone: 'warning', icon: 'shield-alert', title: 'Safety listing', badge: 'Needs check', body: 'Electrical products need a UL or ETL certificate on file. Confirm the certificate number before approving.' }, ...passed('Pixel & Port').slice(0, 1), ...passed('Pixel & Port').slice(2)],
    comments: [], history: basicHistory('Dev Malik, Pixel & Port', 'Oct 8, 1:10 PM'), defaultDecision: 'approve',
  },
  {
    id: 'chg-26100417', ref: 'CHG-26100417', kind: 'shared', title: 'Halden Aurora ANC Wireless Headphones', icon: 'headphones', tint: '2',
    seller: 'Northwind Audio', sellerInitials: 'NA', sellerTint: '2', cat: 'Electronics', sub: 'Headphones',
    flags: [{ tone: 'info', icon: 'info', label: 'Description change' }], waiting: 'Waiting 1 d', waitingTone: 'ok',
    submittedBy: 'Sam Rivera', submittedAt: 'Oct 7, 1:15 PM PT', reviewBy: 'Oct 10',
    brand: 'Halden', model: 'HAL-AUR-BLK', upc: '0 85501 10022 4', offer: 'Shared product · 4 offers',
    description: ['Adds battery life with ANC on (30 h) and off (40 h) to the shared description.'],
    images: [], attributes: [{ name: 'Battery life', value: '30 h ANC on · 40 h ANC off' }],
    checksRan: 'Oct 7, 1:16 PM', checks: passed('Northwind Audio').slice(2), comments: [], history: basicHistory('Sam Rivera, Northwind Audio', 'Oct 7, 1:15 PM'), defaultDecision: 'approve',
  },
  {
    id: 'chg-26100433', ref: 'CHG-26100433', kind: 'shared', title: 'Kestrel 27" 4K IPS Monitor, USB-C 65 W', icon: 'monitor', tint: '6',
    seller: 'Gadget Grove', sellerInitials: 'GG', sellerTint: '3', cat: 'Computers', sub: 'Monitors',
    flags: [{ tone: 'warning', icon: 'triangle-alert', label: 'Image change' }], waiting: 'Waiting 6 h', waitingTone: 'ok',
    submittedBy: 'Chris Wu', submittedAt: 'Oct 8, 9:40 AM PT', reviewBy: 'Oct 10',
    brand: 'Kestrel', model: 'KST-27UHD', upc: '0 84172 33019 8', offer: 'Shared product · 3 offers',
    description: ['Replaces the main image with a new front-facing photo.'],
    images: [{ icon: 'monitor', tint: '6', caption: '1 · New main · 2000 px' }], attributes: [],
    checksRan: 'Oct 8, 9:41 AM', checks: passed('Gadget Grove').slice(2), comments: [], history: basicHistory('Chris Wu, Gadget Grove', 'Oct 8, 9:40 AM'), defaultDecision: 'approve',
  },
];

export interface MergeTarget {
  id: string;
  title: string;
  meta: string;
  icon: IconName;
  tint: Tint;
}

export const MERGE_TARGETS: MergeTarget[] = [
  { id: 'PRD-10233', title: 'Kestrel K75 Wireless Mechanical Keyboard', meta: 'Computers › Keyboards · 2 offers · 731 reviews · rating 4.6 · created Mar 2026', icon: 'keyboard', tint: '6' },
  { id: 'PRD-30418', title: 'Kestrel K75 Mech Keyboard Wireless, Gray', meta: 'Computers › Accessories · 1 offer · 9 reviews · created Jun 2026', icon: 'keyboard', tint: '4' },
];

export const MERGE_RECORDS = [
  { id: 'aa-mg-s1', ref: 'Submission SUB-26100614', text: ' (Lavender) becomes a new variation: Color "Lavender", Switch "Kestrel Brown"' },
  { id: 'aa-mg-s2', ref: 'PRD-30418', text: ' (older duplicate, Gray) merges into the existing Gray variation' },
];

export const MERGE_EFFECTS = [
  { what: 'Offers', how: 'Pixel & Port offer moves to the new Lavender variation. Gadget Grove offer from PRD-30418 moves to Gray and stays paused while the seller is restricted.', after: '4 offers · 3 on sale' },
  { what: 'Reviews', how: '9 reviews from PRD-30418 move with their variation label, date and Verified Purchase status. Seller feedback stays with each seller, not the product.', after: '740 reviews · 4.6' },
  { what: 'Past orders', how: '17 past orders keep their purchase snapshot: title, variation, condition and price accepted at purchase. Order pages link to PRD-10233.', after: 'No order changes' },
  { what: 'Questions and answers', how: '4 questions move and show the variation they were asked about.', after: '58 questions' },
  { what: 'Links', how: 'Old product URLs redirect to PRD-10233. Ads and coupons that targeted PRD-30418 now target PRD-10233.', after: '2 redirects' },
];

export const MERGE_REASON_DEFAULT = 'Same model (K75), same brand and UPC family. Lavender is a color variation of the existing product. PRD-30418 is an older duplicate of the Gray variation.';
