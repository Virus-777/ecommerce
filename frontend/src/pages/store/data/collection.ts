// Store merchandising data: products that appear on the brand, seller, Official Store, deals and
// collection pages but are not in the shared fixtures, the shared sort options, and the
// four collection views (New arrivals, Best sellers, Home Week, Desk setup for small spaces).
import { P } from '@marketly/web-shared/data/fixtures';
import type { CardProduct, IconName } from '@marketly/web-shared/ui';

/** A product card plus the fields the store pages filter on. */
export interface ShopItem extends CardProduct {
  id: string;
  /** Top-level category id (fixtures `categories`). */
  cat: string;
  /** Subcategory label (chip filters, rank labels). */
  sub: string;
}

/** Listings outside the shared fixtures (same shape as fixture products). */
export const EXTRA: Record<string, ShopItem> = {
  auroraBuds: { id: 'auroraBuds', name: 'Halden Aurora Buds ANC Earbuds', cat: 'electronics', sub: 'Earbuds', price: 139, was: 169, rating: 4.5, reviews: 912, icon: 'ear', tint: '2', seller: 'official', offers: 3, delivery: 'Thu, Oct 15', free: true },
  aria: { id: 'aria', name: 'Halden Aria True Wireless Earbuds', cat: 'electronics', sub: 'Earbuds', price: 99, was: 129, rating: 4.4, reviews: 688, icon: 'ear', tint: '2', seller: 'northwind', offers: 2, delivery: 'Fri, Oct 16', free: true },
  studio2: { id: 'studio2', name: 'Halden Studio 2 Wired Monitor Headphones', cat: 'electronics', sub: 'Headphones', price: 149, was: null, rating: 4.7, reviews: 356, icon: 'headphones', tint: '5', seller: 'official', offers: 2, delivery: 'Thu, Oct 15', free: true },
  pocketMini: { id: 'pocketMini', name: 'Halden Pocket Mini Bluetooth Speaker', cat: 'electronics', sub: 'Speakers', price: 39, was: null, rating: 4.3, reviews: 410, icon: 'speaker', tint: '2', seller: 'northwind', offers: 2, delivery: 'Thu, Oct 15', free: true },
  air: { id: 'air', name: 'Halden Air Open-ear Sport Headphones', cat: 'electronics', sub: 'Headphones', price: 119, was: null, rating: 4.2, reviews: 204, icon: 'ear', tint: '1', seller: 'northwind', offers: 1, delivery: 'Fri, Oct 16', free: true },
  travelCase: { id: 'travelCase', name: 'Halden Aurora Hard Travel Case', cat: 'electronics', sub: 'Accessories', price: 29, was: null, rating: 4.6, reviews: 188, icon: 'briefcase', tint: '5', seller: 'official', offers: 1, delivery: 'Wed, Oct 14', free: false },
  lumen: { id: 'lumen', name: 'Lumen Q1 On-ear Wireless Headphones', cat: 'electronics', sub: 'Headphones', price: 69, was: null, rating: 4.0, reviews: 265, icon: 'headphones', tint: '3', seller: 'northwind', offers: 2, delivery: 'Fri, Oct 16', free: true },
  cableKit: { id: 'cableKit', name: 'Northwind Studio Cable Kit, 3.5 mm to USB-C', cat: 'electronics', sub: 'Cables and accessories', price: 24, was: null, rating: 4.5, reviews: 96, icon: 'cable', tint: '2', seller: 'northwind', offers: 1, delivery: 'Fri, Oct 16', free: false },
  wave: { id: 'wave', name: 'Kestrel Wave Over-ear Bluetooth Headphones', cat: 'electronics', sub: 'Headphones', price: 79, was: null, rating: 4.2, reviews: 1032, icon: 'headphones', tint: '6', seller: 'northwind', offers: 3, delivery: 'Fri, Oct 16', free: true },
  kidsPhones: { id: 'kidsPhones', name: 'Brightline Kids Volume-limited Headphones', cat: 'electronics', sub: 'Headphones', price: 34, was: null, rating: 4.4, reviews: 731, icon: 'headphones', tint: '1', seller: 'official', offers: 2, delivery: 'Wed, Oct 14', free: false },
  dutchOven: { id: 'dutchOven', name: 'Pellar Enameled Dutch Oven 5.5 qt', cat: 'home', sub: 'Cookware', price: 96, was: 128, rating: 4.8, reviews: 1104, icon: 'cooking-pot', tint: '3', seller: 'official', offers: 2, delivery: 'Wed, Oct 14', free: true },
  stringLights: { id: 'stringLights', name: 'Brightline Warm White String Lights, 10 m', cat: 'home', sub: 'Lighting', price: 19, was: 26, rating: 4.3, reviews: 852, icon: 'lightbulb', tint: '5', seller: 'official', offers: 1, delivery: 'Wed, Oct 14', free: false },
  kettle: { id: 'kettle', name: 'Mosswood Gooseneck Pour-over Kettle', cat: 'home', sub: 'Coffee & tea', price: 48, was: 60, rating: 4.5, reviews: 377, icon: 'coffee', tint: '3', seller: 'casaverde', offers: 1, delivery: 'Mon, Oct 19', free: true },
  corvoStride: { id: 'corvoStride', name: 'Corvo Stride Sport Earbuds, Sweat-resistant', cat: 'electronics', sub: 'Earbuds', price: 49, was: 59, rating: 4.1, reviews: 540, icon: 'ear', tint: '4', seller: 'trailhead', offers: 1, delivery: 'Fri, Oct 16', free: false },
  percale: { id: 'percale', name: 'Mosswood Percale Sheet Set, Queen', cat: 'home', sub: 'Bedding', price: 79, was: 99, rating: 4.6, reviews: 640, icon: 'bed-double', tint: '1', seller: 'casaverde', offers: 2, delivery: 'Mon, Oct 19', free: true },
  arcLamp: { id: 'arcLamp', name: 'Brightline Arc Floor Lamp, Dimmable', cat: 'home', sub: 'Lighting', price: 89, was: 119, rating: 4.4, reviews: 233, icon: 'lamp-floor', tint: '5', seller: 'official', offers: 1, delivery: 'Thu, Oct 15', free: true },
};

/** Resolves a fixture product (`P`) or a store listing (`EXTRA`) by id. */
export const item = (id: string): ShopItem => P[id] ?? EXTRA[id];
export const items = (ids: string[]): ShopItem[] => ids.map(item);

/* ---------------- Sorting (shared by the shop toolbars) ---------------- */

export const SORT_OPTIONS = ['Recommended', 'Price: low to high', 'Price: high to low', 'Newest', 'Highest rated'] as const;
export type SortKey = (typeof SORT_OPTIONS)[number];

/** Re-sorts a list. "Recommended" keeps the merchandised order; "Newest" uses the listing order reversed (newest listed last). */
export function sortItems<T extends CardProduct>(list: T[], sort: SortKey): T[] {
  const l = [...list];
  switch (sort) {
    case 'Price: low to high':
      return l.sort((a, b) => a.price - b.price);
    case 'Price: high to low':
      return l.sort((a, b) => b.price - a.price);
    case 'Newest':
      return l.reverse();
    case 'Highest rated':
      return l.sort((a, b) => b.rating - a.rating || b.reviews - a.reviews);
    default:
      return l;
  }
}

/* ---------------- New arrivals (default view) ---------------- */

export const NEW_CHIPS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All' },
  { value: 'electronics', label: 'Electronics' },
  { value: 'home', label: 'Home & Kitchen' },
  { value: 'fashion', label: 'Fashion' },
  { value: 'sports', label: 'Sports & Outdoors' },
  { value: 'beauty', label: 'Beauty' },
];

export const NEW_GROUPS: Array<{ added: string; ids: string[] }> = [
  { added: 'Oct 6', ids: ['lamp', 'yogamat', 'auroraBuds', 'stringLights'] },
  { added: 'Oct 2', ids: ['serum', 'keyboard', 'studio2', 'kettle'] },
  { added: 'Sep 28', ids: ['sweater', 'pourover', 'kidsPhones', 'air'] },
];
export const NEW_PAGES = 4;

/* ---------------- Best sellers ---------------- */

export const BEST_TABS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All categories' },
  { value: 'electronics', label: 'Electronics' },
  { value: 'computers', label: 'Computers' },
  { value: 'home', label: 'Home & Kitchen' },
  { value: 'fashion', label: 'Fashion' },
  { value: 'sports', label: 'Sports & Outdoors' },
  { value: 'beauty', label: 'Beauty' },
];

/** Rank order (units sold, last 30 days) with the label under ranks 4+. */
export const BEST_SELLERS: Array<{ id: string; label: string }> = [
  { id: 'skillet', label: 'Cookware' },
  { id: 'aurora', label: 'Headphones' },
  { id: 'bottle', label: 'Hiking' },
  { id: 'ssd1tb', label: 'Storage' },
  { id: 'duvet', label: 'Bedding' },
  { id: 'speaker', label: 'Speakers' },
  { id: 'serum', label: 'Skincare' },
  { id: 'keyboard', label: 'Keyboards' },
  { id: 'auroraBuds', label: '' },
  { id: 'backpack', label: 'Hiking' },
];

/* ---------------- Seasonal: Home Week ---------------- */

export const SEASON_SECTIONS: Array<{ name: string; icon: IconName; ids: string[] }> = [
  { name: 'Bedding', icon: 'bed-double', ids: ['duvet', 'percale'] },
  { name: 'Lighting', icon: 'lamp', ids: ['lamp', 'arcLamp', 'stringLights'] },
  { name: 'Cookware and coffee', icon: 'cooking-pot', ids: ['skillet', 'dutchOven', 'kettle', 'pourover'] },
];

export const SEASON_TERMS = [
  'Offers end Oct 19, 11:59 PM PT, or earlier if the listed seller’s deal stock runs out.',
  'Deal prices apply only to the seller named on each product. Other sellers of the same product may charge a different price.',
  'Purchase limits are shown on each product page. Home Week prices can’t be combined with other coupons unless stated.',
  'Was prices are each seller’s lowest price in the 30 days before Oct 6.',
];

/* ---------------- Curated: Desk setup for small spaces ---------------- */

export interface CuratedPick {
  id: string;
  stock: 'In stock' | 'Low stock';
  available: number;
}

export const CURATED_SECTIONS: Array<{ name: string; icon: IconName; note: string; picks: CuratedPick[] }> = [
  {
    name: 'One screen, fewer cables',
    icon: 'monitor',
    note: 'A single USB-C cable from this monitor charges a laptop and carries the picture, so the desk only needs one cord. Add the SSD for backups that fit in a drawer.',
    picks: [
      { id: 'kestrel27', stock: 'In stock', available: 18 },
      { id: 'ssd1tb', stock: 'In stock', available: 64 },
      { id: 'cableKit', stock: 'In stock', available: 27 },
    ],
  },
  {
    name: 'Light that doesn’t take up desk space',
    icon: 'lamp-desk',
    note: 'We picked lamps with small bases or none at all. The Brightline desk lamp also charges your phone, which frees up another outlet.',
    picks: [
      { id: 'lamp', stock: 'Low stock', available: 9 },
      { id: 'stringLights', stock: 'In stock', available: 112 },
      { id: 'arcLamp', stock: 'In stock', available: 14 },
    ],
  },
  {
    name: 'Type and listen quietly',
    icon: 'keyboard',
    note: 'A compact 75% keyboard leaves room for a notebook. Closed-back headphones keep calls private in a shared room.',
    picks: [
      { id: 'keyboard', stock: 'In stock', available: 35 },
      { id: 'aurora', stock: 'In stock', available: 142 },
      { id: 'studio2', stock: 'In stock', available: 23 },
    ],
  },
  {
    name: 'Coffee within reach',
    icon: 'coffee',
    note: 'Small-footprint brewing for a desk or a side shelf, plus a bottle that won’t sweat onto your papers.',
    picks: [
      { id: 'pourover', stock: 'In stock', available: 58 },
      { id: 'kettle', stock: 'In stock', available: 19 },
      { id: 'bottle', stock: 'In stock', available: 220 },
    ],
  },
];
