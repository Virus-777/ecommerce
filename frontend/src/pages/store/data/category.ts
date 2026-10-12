// Category page sample: the first page of "Headphones" listings, with the attributes the filters use.
import type { CardProduct } from '@marketly/web-shared/ui';

export type HeadphoneType = 'over' | 'in' | 'on';
export type Anc = 'active' | 'passive' | 'none';
export type Connection = 'bt53' | 'bt50' | 'usbc' | 'jack';
export type Condition = 'new' | 'used' | 'refurbished';

export interface Listing extends CardProduct {
  id: string;
  brand: string;
  sponsored?: boolean;
  /** Result group for the search Category facet (default: Earbuds for in-ear, else Headphones). */
  group?: string;
  condition: Condition;
  type: HeadphoneType;
  anc: Anc;
  battery: number;
  connection: Connection[];
  sport?: boolean;
  kids?: boolean;
  inStock: boolean;
  shipsToday: boolean;
  /** Arrives by Fri, Oct 16. */
  byFri: boolean;
  /** Days since listed (Newest sort). */
  age: number;
}

export const HEADPHONES: Listing[] = [
  { id: 'aurora', name: 'Halden Aurora ANC Wireless Headphones', brand: 'Halden', price: 189, was: 229, rating: 4.6, reviews: 1284, icon: 'headphones', tint: '2', seller: 'official', offers: 4, delivery: 'Thu, Oct 15', free: true, condition: 'new', type: 'over', anc: 'active', battery: 40, connection: ['bt53', 'usbc'], inStock: true, shipsToday: true, byFri: true, age: 40 },
  { id: 'aria', name: 'Halden Aria True Wireless Earbuds', brand: 'Halden', price: 99, was: 129, rating: 4.4, reviews: 688, icon: 'ear', tint: '2', seller: 'northwind', offers: 3, delivery: 'Fri, Oct 16', free: true, condition: 'new', type: 'in', anc: 'active', battery: 28, connection: ['bt53'], inStock: true, shipsToday: false, byFri: true, age: 22 },
  { id: 'lumen-q3', name: 'Lumen Q3 Noise Cancelling Headphones', brand: 'Lumen', price: 159, was: null, rating: 4.3, reviews: 421, icon: 'headphones', tint: '3', seller: 'pixelport', offers: 2, delivery: 'Fri, Oct 16', free: true, sponsored: true, condition: 'new', type: 'over', anc: 'active', battery: 30, connection: ['bt50'], inStock: true, shipsToday: false, byFri: true, age: 12 },
  { id: 'wave', name: 'Kestrel Wave Over-ear Bluetooth Headphones', brand: 'Kestrel', price: 79, was: null, rating: 4.2, reviews: 1032, icon: 'headphones', tint: '6', seller: 'pixelport', offers: 3, delivery: 'Fri, Oct 16', free: true, condition: 'new', type: 'over', anc: 'passive', battery: 35, connection: ['bt50', 'jack'], inStock: true, shipsToday: false, byFri: true, age: 90 },
  { id: 'studio2', name: 'Halden Studio 2 Wired Monitor Headphones', brand: 'Halden', price: 149, was: null, rating: 4.7, reviews: 356, icon: 'headphones', tint: '5', seller: 'official', offers: 2, delivery: 'Thu, Oct 15', free: true, condition: 'new', type: 'over', anc: 'passive', battery: 0, connection: ['jack'], inStock: true, shipsToday: true, byFri: true, age: 60 },
  { id: 'aurora-buds', name: 'Halden Aurora Buds ANC Earbuds', brand: 'Halden', price: 139, was: 169, rating: 4.5, reviews: 912, icon: 'ear', tint: '2', seller: 'official', offers: 2, delivery: 'Thu, Oct 15', free: true, condition: 'new', type: 'in', anc: 'active', battery: 24, connection: ['bt53'], inStock: true, shipsToday: true, byFri: true, age: 5 },
  { id: 'wave-pro', name: 'Kestrel Wave Pro ANC Headphones', brand: 'Kestrel', price: 129, was: 149, rating: 4.3, reviews: 577, icon: 'headphones', tint: '6', seller: 'pixelport', offers: 2, delivery: 'Fri, Oct 16', free: true, condition: 'refurbished', type: 'over', anc: 'active', battery: 45, connection: ['bt53', 'usbc'], inStock: true, shipsToday: false, byFri: true, age: 18 },
  { id: 'lumen-q1', name: 'Lumen Q1 On-ear Wireless Headphones', brand: 'Lumen', price: 69, was: null, rating: 4.0, reviews: 265, icon: 'headphones', tint: '3', seller: 'northwind', offers: 2, delivery: 'Fri, Oct 16', free: true, sponsored: true, condition: 'new', type: 'on', anc: 'none', battery: 20, connection: ['bt50'], inStock: true, shipsToday: false, byFri: true, age: 30 },
  { id: 'stride', name: 'Corvo Stride Sport Earbuds, Sweat-resistant', brand: 'Corvo', price: 49, was: 59, rating: 4.1, reviews: 540, icon: 'ear', tint: '4', seller: 'trailhead', offers: 1, delivery: 'Fri, Oct 16', free: false, condition: 'new', type: 'in', anc: 'none', battery: 8, connection: ['bt53'], sport: true, inStock: true, shipsToday: false, byFri: true, age: 45 },
  { id: 'kids', name: 'Brightline Kids Volume-limited Headphones', brand: 'Brightline', price: 34, was: null, rating: 4.4, reviews: 731, icon: 'headphones', tint: '1', seller: 'official', offers: 2, delivery: 'Wed, Oct 14', free: false, condition: 'new', type: 'on', anc: 'none', battery: 20, connection: ['bt50', 'jack'], kids: true, inStock: true, shipsToday: true, byFri: true, age: 75 },
  { id: 'air', name: 'Halden Air Open-ear Sport Headphones', brand: 'Halden', price: 119, was: null, rating: 4.2, reviews: 204, icon: 'ear', tint: '1', seller: 'northwind', offers: 1, delivery: 'Fri, Oct 16', free: true, condition: 'used', type: 'in', anc: 'none', battery: 10, connection: ['bt53'], sport: true, inStock: true, shipsToday: false, byFri: true, age: 8 },
  { id: 'loop', name: 'Kestrel Loop Neckband Earphones', brand: 'Kestrel', price: 39, was: null, rating: 3.9, reviews: 318, icon: 'ear', tint: '6', seller: 'pixelport', offers: 1, delivery: 'Fri, Oct 16', free: false, condition: 'new', type: 'in', anc: 'passive', battery: 14, connection: ['bt50'], inStock: true, shipsToday: false, byFri: false, age: 120 },
];

/** Sub-category chips; `slug` is the category route param. */
export const CHIPS: Array<{ slug: string; label: string; match?: (l: Listing) => boolean }> = [
  { slug: 'headphones', label: 'All headphones' },
  { slug: 'over-ear', label: 'Over-ear', match: (l) => l.type === 'over' },
  { slug: 'in-ear-and-earbuds', label: 'In-ear and earbuds', match: (l) => l.type === 'in' },
  { slug: 'on-ear', label: 'On-ear', match: (l) => l.type === 'on' },
  { slug: 'noise-cancelling', label: 'Noise cancelling', match: (l) => l.anc === 'active' },
  { slug: 'sport', label: 'Sport', match: (l) => !!l.sport },
  { slug: 'kids', label: 'Kids', match: (l) => !!l.kids },
  { slug: 'studio-and-wired', label: 'Studio and wired', match: (l) => l.connection.includes('jack') || l.connection.includes('usbc') },
];

export const TOTAL_RESULTS = 128;
export const PAGE_SIZE = 12;

// Facet options with catalogue-wide counts (all 128 results).
export const PRICE_RANGES = [
  { id: 'u50', label: 'Under $50', n: 18, min: 0, max: 50 },
  { id: '50-100', label: '$50 to $100', n: 34, min: 50, max: 100 },
  { id: '100-200', label: '$100 to $200', n: 51, min: 100, max: 200 },
  { id: '200', label: '$200 and up', n: 25, min: 200, max: Infinity },
];
export const RATINGS = [
  { id: '4', stars: 4, n: 96 },
  { id: '3', stars: 3, n: 121 },
];
export const BRANDS = [
  { name: 'Halden', n: 21 }, { name: 'Kestrel', n: 18 }, { name: 'Lumen', n: 12 }, { name: 'Corvo', n: 9 }, { name: 'Brightline', n: 6 },
  { name: 'Sonora', n: 5 }, { name: 'Vela', n: 4 }, { name: 'Arden', n: 3 }, { name: 'Brio', n: 2 }, { name: 'Quill', n: 2 }, { name: 'Ostra', n: 1 }, { name: 'Tamber', n: 1 },
];
export const BRANDS_SHOWN = 5;
export const SELLERS = [
  { id: 'official', label: 'Official Store', n: 34, hint: 'Shows company offers at the prices listed' },
  { id: 'northwind', label: 'Northwind Audio', n: 22 },
  { id: 'pixelport', label: 'Pixel & Port', n: 19 },
  { id: 'trailhead', label: 'Trailhead Outfitters', n: 7 },
] as const;
export const CONDITIONS: Array<{ id: Condition; label: string; n: number }> = [
  { id: 'new', label: 'New', n: 112 },
  { id: 'used', label: 'Used', n: 11 },
  { id: 'refurbished', label: 'Refurbished', n: 5 },
];
export const TYPES: Array<{ id: HeadphoneType; label: string; n: number }> = [
  { id: 'over', label: 'Over-ear', n: 54 },
  { id: 'in', label: 'In-ear and earbuds', n: 49 },
  { id: 'on', label: 'On-ear', n: 25 },
];
export const ANCS: Array<{ id: Anc; label: string; n: number }> = [
  { id: 'active', label: 'Active (ANC)', n: 61 },
  { id: 'passive', label: 'Passive', n: 44 },
  { id: 'none', label: 'None', n: 23 },
];
export const BATTERY = [
  { id: '20', hours: 20, label: '20 hours or more', n: 88 },
  { id: '30', hours: 30, label: '30 hours or more', n: 52 },
  { id: '40', hours: 40, label: '40 hours or more', n: 17 },
];
export const CONNECTIONS: Array<{ id: Connection; label: string; n: number }> = [
  { id: 'bt53', label: 'Bluetooth 5.3', n: 72 },
  { id: 'bt50', label: 'Bluetooth 5.0 to 5.2', n: 31 },
  { id: 'usbc', label: 'USB-C wired', n: 14 },
  { id: 'jack', label: '3.5 mm wired', n: 26 },
];
export const SORTS = ['Recommended', 'Price: low to high', 'Price: high to low', 'Newest', 'Highest rated'] as const;
export type Sort = (typeof SORTS)[number];
