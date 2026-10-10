import type { IconName, Tone } from '@/ui';
import type { Tint } from '@/data/fixtures';

// Sample data for admin Categories and brands (design: pages/admin/admin-categories.html, --brands).

export interface CategoryNode {
  id: string;
  name: string;
  /** Parent category id; null = top level. */
  parent: string | null;
  /** Active products with at least one eligible offer. */
  count: number;
  offers?: number;
  /** "Show in store menus and search filters". */
  visible: boolean;
  /** What the store shows when the category has no eligible inventory. */
  empty: 'hide' | 'soon';
}

const sub = (parent: string, rows: Array<[string, number]>): CategoryNode[] =>
  rows.map(([name, count]) => ({ id: `${parent}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name, parent, count, visible: true, empty: 'hide' }));

export const CATEGORY_TREE: CategoryNode[] = [
  { id: 'electronics', name: 'Electronics', parent: null, count: 1240, visible: true, empty: 'hide' },
  ...sub('electronics', [['Headphones', 312], ['Speakers', 188], ['Smart home', 240], ['Cameras', 96]]),
  { id: 'electronics-wearables', name: 'Wearables', parent: 'electronics', count: 0, visible: true, empty: 'soon' },
  { id: 'computers', name: 'Computers', parent: null, count: 860, visible: true, empty: 'hide' },
  ...sub('computers', [['Monitors', 142], ['Storage', 205]]),
  { id: 'computers-keyboards', name: 'Keyboards', parent: 'computers', count: 118, offers: 241, visible: true, empty: 'hide' },
  { id: 'computers-laptops', name: 'Laptops', parent: 'computers', count: 0, visible: true, empty: 'hide' },
  ...sub('computers', [['Accessories', 395]]),
  { id: 'home', name: 'Home & Kitchen', parent: null, count: 2105, visible: true, empty: 'hide' },
  ...sub('home', [['Cookware', 410], ['Bedding', 362], ['Lighting', 288], ['Coffee & tea', 254], ['Cleaning', 301], ['Kitchen linens', 190]]),
  { id: 'fashion', name: 'Fashion', parent: null, count: 1830, visible: true, empty: 'hide' },
  ...sub('fashion', [['Knitwear', 286], ['Shoes', 512], ['Bags', 340], ['Outerwear', 402], ['Accessories', 290]]),
  { id: 'sports', name: 'Sports & Outdoors', parent: null, count: 940, visible: true, empty: 'hide' },
  ...sub('sports', [['Hiking', 260], ['Running', 198], ['Yoga', 120], ['Cycling', 164], ['Camping', 198]]),
  { id: 'beauty', name: 'Beauty', parent: null, count: 620, visible: true, empty: 'hide' },
  ...sub('beauty', [['Skincare', 248], ['Hair', 160], ['Fragrance', 118], ['Bath', 94]]),
  { id: 'toys', name: 'Toys & Games', parent: null, count: 410, visible: true, empty: 'hide' },
  ...sub('toys', [['Puzzles', 132], ['Board games', 158], ['Building sets', 120]]),
  { id: 'pets', name: 'Pet Supplies', parent: null, count: 330, visible: true, empty: 'hide' },
  ...sub('pets', [['Dog', 164], ['Cat', 126], ['Small pets', 40]]),
  { id: 'music', name: 'Musical instruments', parent: null, count: 0, visible: false, empty: 'hide' },
  ...sub('music', [['Guitars', 0], ['Keyboards', 0]]),
];

export const INITIAL_EXPANDED = ['electronics', 'computers'];
export const INITIAL_ACTIVE = 'computers-keyboards';

export const ATTR_TYPES = ['Text', 'Number', 'List', 'List · variation', 'Yes / No'];

export interface CategoryAttribute {
  id: string;
  name: string;
  type: string;
  values: string;
  required: boolean;
  filterable: boolean;
  /** Products in the category with a value. */
  filled: number;
  /** Required flag in the published version (drift = unpublished change). */
  publishedRequired: boolean;
  /** Inherited from All products: not editable here. */
  inherited?: boolean;
}

const attr = (id: string, name: string, type: string, values: string, required: boolean, filterable: boolean, filled: number, publishedRequired = required): CategoryAttribute => ({ id, name, type, values, required, filterable, filled, publishedRequired });

export const BRAND_ATTRIBUTE: CategoryAttribute = { ...attr('brand', 'Brand', 'List', 'From brand list', true, true, 0), inherited: true };

/** Keyboards has a full attribute set; Warranty was just made required (not yet published). */
export const KEYBOARD_ATTRIBUTES: CategoryAttribute[] = [
  { ...BRAND_ATTRIBUTE, filled: 118 },
  attr('a1', 'Connection', 'List', 'Wired, Bluetooth, 2.4 GHz', true, true, 118),
  attr('a2', 'Layout size', 'List', 'Full, TKL, 75%, 65%, 60%', true, true, 116),
  attr('a3', 'Switch type', 'List', '14 values', true, true, 102),
  attr('a4', 'Color', 'List · variation', '11 values', true, true, 118),
  attr('a5', 'Backlight', 'Yes / No', '', false, true, 97),
  attr('a6', 'Keycap material', 'Text', '', false, false, 81),
  attr('a7', 'Battery capacity', 'Number', 'mAh', false, false, 64),
  attr('a8', 'Weight', 'Number', 'g', true, false, 109),
  attr('a9', 'Warranty', 'Text', '', true, false, 99, false),
];

/** Starter set for categories without their own attributes in the sample data. */
export const defaultAttributes = (count: number): CategoryAttribute[] => [
  { ...BRAND_ATTRIBUTE, filled: count },
  attr('d1', 'Color', 'List · variation', '12 values', true, true, count),
  attr('d2', 'Weight', 'Number', 'g', false, false, Math.round(count * 0.8)),
];

export const IMAGE_STANDARDS: Array<{ icon: IconName; text: string; level: 'Blocking' | 'Warning' }> = [
  { icon: 'maximize', text: 'Minimum 1000 × 1000 px, JPG or PNG, up to 10 MB', level: 'Blocking' },
  { icon: 'square', text: 'Main image on a white or light neutral background, product fills 80% of the frame', level: 'Blocking' },
  { icon: 'type', text: 'No text overlays, watermarks, prices or promotional badges', level: 'Blocking' },
  { icon: 'images', text: 'At least 3 images, including one of the ports or connection side', level: 'Warning' },
  { icon: 'scan-eye', text: 'Photos show the exact model and color sold, no renders of other variations', level: 'Warning' },
];

/* ---------------- Brands ---------------- */

export type BrandStatus = 'Active' | 'Under review' | 'Blocked';
export const BRAND_STATUSES: BrandStatus[] = ['Active', 'Under review', 'Blocked'];
export const BRAND_STATUS_TONE: Record<BrandStatus, Tone> = { Active: 'success', 'Under review': 'info', Blocked: 'danger' };
export const WHO_CAN_SELL = ['Authorized seller list', 'Open to all sellers', 'Official Store only'];

export interface BrandRow {
  id: string;
  name: string;
  initials: string;
  tint: Tint;
  products: number;
  offers: number;
  sellers: number;
  who: string;
  status: BrandStatus;
  note: string;
  /** At-risk row (amber edge) with the note in warning text. */
  warn?: boolean;
}

export const BRAND_ROWS: BrandRow[] = [
  { id: 'halden', name: 'Halden', initials: 'H', tint: '2', products: 48, offers: 131, sellers: 6, who: 'Authorized seller list', status: 'Active', note: 'Brand page live' },
  { id: 'kestrel', name: 'Kestrel', initials: 'K', tint: '6', products: 63, offers: 154, sellers: 5, who: 'Authorized seller list', status: 'Active', note: 'Brand page live' },
  { id: 'mosswood', name: 'Mosswood', initials: 'Mw', tint: '1', products: 37, offers: 52, sellers: 3, who: 'Open to all sellers', status: 'Active', note: 'Brand page live' },
  { id: 'brightline', name: 'Brightline', initials: 'B', tint: '5', products: 29, offers: 71, sellers: 4, who: 'Open to all sellers', status: 'Active', note: 'Brand page live' },
  { id: 'corvo', name: 'Corvo', initials: 'C', tint: '4', products: 41, offers: 66, sellers: 3, who: 'Open to all sellers', status: 'Active', note: 'Brand page live' },
  { id: 'pellar', name: 'Pellar', initials: 'P', tint: '3', products: 18, offers: 30, sellers: 2, who: 'Open to all sellers', status: 'Active', note: 'Brand page live' },
  { id: 'aster', name: 'Aster', initials: 'A', tint: '5', products: 22, offers: 25, sellers: 2, who: 'Authorized seller list', status: 'Active', note: 'Brand page live' },
  { id: 'nordvik', name: 'Nordvik', initials: 'N', tint: '4', products: 14, offers: 14, sellers: 1, who: 'Official Store only', status: 'Active', note: 'Brand page live' },
  { id: 'voltmax', name: 'Volt Max', initials: 'VM', tint: '3', products: 3, offers: 3, sellers: 1, who: 'Brand not verified', status: 'Under review', note: 'Counterfeit report CS-261004-0377 with Trust and Risk', warn: true },
];

export interface BrandClaim {
  id: string;
  initials: string;
  tint: Tint;
  title: string;
  detail: string;
}

export const BRAND_CLAIMS: BrandClaim[] = [
  { id: 'cl1', initials: 'PP', tint: '6', title: 'Pixel & Port · "Authorized Kestrel reseller" label', detail: 'Letter from Kestrel Peripherals US attached · Oct 5' },
  { id: 'cl2', initials: 'TO', tint: '5', title: 'Trailhead Outfitters · add brand "Ridgeback Gear"', detail: 'New brand request · Oct 7' },
];
