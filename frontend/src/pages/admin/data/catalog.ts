import type { Tint } from '@/data/fixtures';
import type { IconName } from '@/ui';

// Sample rows for the admin Products table (design: pages/admin/admin-catalog.html).

export type ReviewState = 'Draft' | 'Submitted' | 'Changes requested' | 'Approved' | 'Rejected';
export type Publication = 'Active' | 'Hidden' | 'Suspended';
export type MissingContent = 'Missing images' | 'Missing required attributes' | 'Missing description' | 'Missing warranty';

export interface CatalogRow {
  id: string;
  /** Seller SKU; submissions not yet in the catalog have none. */
  sku?: string;
  name: string;
  icon: IconName;
  tint: Tint;
  brand: string;
  cat: string;
  sub: string;
  offers: number;
  price: number;
  review: ReviewState;
  pub: Publication;
  score: number;
  /** Short content problem shown under the score. */
  issue?: string;
  missing: MissingContent[];
  /** Extra note after the SKU. */
  note?: string;
  /** A new submission (links to the review queue instead of the store page). */
  submission?: boolean;
  duplicate?: boolean;
  /** Row edge: flagged = urgent (red), warn = at risk (amber). */
  edge?: 'flagged' | 'warn';
  sellers: string[];
}

export const CATALOG_TABS = [
  { value: 'all', label: 'All', count: '8,335' },
  { value: 'active', label: 'Active', count: '7,912' },
  { value: 'hidden', label: 'Hidden', count: '341' },
  { value: 'suspended', label: 'Suspended', count: '82' },
  { value: 'missing', label: 'Missing content', count: '516' },
  { value: 'duplicates', label: 'Duplicates suspected', count: '12' },
] as const;
export type CatalogTab = (typeof CATALOG_TABS)[number]['value'];

export const CATEGORY_OPTIONS = ['Electronics', 'Computers', 'Home & Kitchen', 'Fashion', 'Sports & Outdoors', 'Beauty'];
export const BRAND_OPTIONS = ['Halden', 'Kestrel', 'Mosswood', 'Brightline', 'Corvo', 'Pellar'];
export const SELLER_OPTIONS = ['Marketly Official', 'Northwind Audio', 'Pixel & Port', 'Casa Verde Home', 'Trailhead Outfitters', 'Gadget Grove'];
export const REVIEW_OPTIONS: ReviewState[] = ['Draft', 'Submitted', 'Changes requested', 'Approved', 'Rejected'];
export const MISSING_OPTIONS: MissingContent[] = ['Missing images', 'Missing required attributes', 'Missing description', 'Missing warranty'];
export const PUBLICATION_OPTIONS: Publication[] = ['Active', 'Hidden', 'Suspended'];

/** Rows the design's "bulk-selection" view has selected. */
export const BULK_PRESELECTED = ['p-hal-aur', 'p-brl-lamp', 'p-msw-lin'];

export const CATALOG_ROWS: CatalogRow[] = [
  { id: 'sub-26100614', name: 'Kestrel K75 Wireless Mechanical Keyboard, Lavender', icon: 'keyboard', tint: '6', brand: 'Kestrel', cat: 'Computers', sub: 'Accessories', offers: 1, price: 114, review: 'Submitted', pub: 'Hidden', score: 71, issue: 'Missing warranty', missing: ['Missing warranty'], submission: true, duplicate: true, edge: 'warn', sellers: ['Pixel & Port'] },
  { id: 'sub-26100588', name: 'Volt Max Pro X9 Wireless Earbuds', icon: 'headphones', tint: '4', brand: 'Volt Max', cat: 'Electronics', sub: 'Headphones', offers: 1, price: 19.99, review: 'Rejected', pub: 'Suspended', score: 40, issue: 'Brand not verified', missing: ['Missing required attributes'], submission: true, edge: 'flagged', sellers: ['Gadget Grove'] },
  { id: 'p-hal-aur', sku: 'HAL-AUR-BLK', name: 'Halden Aurora ANC Wireless Headphones', icon: 'headphones', tint: '2', brand: 'Halden', cat: 'Electronics', sub: 'Headphones', offers: 4, price: 189, review: 'Approved', pub: 'Active', score: 96, missing: [], sellers: ['Marketly Official', 'Northwind Audio', 'Pixel & Port', 'Gadget Grove'] },
  { id: 'p-kst-27', sku: 'KST-27UHD', name: 'Kestrel 27" 4K IPS Monitor, USB-C 65 W', icon: 'monitor', tint: '6', brand: 'Kestrel', cat: 'Computers', sub: 'Monitors', offers: 3, price: 329, review: 'Approved', pub: 'Active', score: 91, missing: [], sellers: ['Marketly Official', 'Pixel & Port', 'Gadget Grove'] },
  { id: 'p-kst-ssd', sku: 'KST-SSD1T', name: 'Kestrel 1 TB Portable SSD, USB 3.2', icon: 'hard-drive', tint: '6', brand: 'Kestrel', cat: 'Computers', sub: 'Storage', offers: 5, price: 94.99, review: 'Approved', pub: 'Active', score: 94, missing: [], sellers: ['Marketly Official', 'Pixel & Port', 'Gadget Grove', 'Northwind Audio'] },
  { id: 'p-brl-lamp', sku: 'BRL-LAMP-W', name: 'Brightline Smart LED Desk Lamp with Wireless Charger', icon: 'lamp-desk', tint: '5', brand: 'Brightline', cat: 'Home & Kitchen', sub: 'Lighting', offers: 1, price: 42, review: 'Approved', pub: 'Active', score: 68, issue: 'Missing dimensions, 2 images', missing: ['Missing images', 'Missing required attributes'], edge: 'warn', sellers: ['Casa Verde Home'] },
  { id: 'p-msw-lin', sku: 'MSW-LIN-Q-SAGE', name: 'Mosswood Washed Linen Duvet Cover, Queen', icon: 'bed-double', tint: '1', brand: 'Mosswood', cat: 'Home & Kitchen', sub: 'Bedding', offers: 2, price: 119, review: 'Approved', pub: 'Active', score: 92, missing: [], sellers: ['Marketly Official', 'Casa Verde Home'] },
  { id: 'p-tdw-750', sku: 'TDW-750-SLT', name: 'Tidewell Insulated Bottle 750 ml', icon: 'cup-soda', tint: '6', brand: 'Tidewell', cat: 'Sports & Outdoors', sub: 'Hiking', offers: 3, price: 29.5, review: 'Approved', pub: 'Active', score: 88, missing: [], sellers: ['Marketly Official', 'Trailhead Outfitters', 'Gadget Grove'] },
  { id: 'p-trh-r40', sku: 'TRH-R40-OLV', name: 'Trailhead Ridge 40 L Hiking Backpack', icon: 'backpack', tint: '5', brand: 'Trailhead', cat: 'Sports & Outdoors', sub: 'Hiking', offers: 1, price: 139, review: 'Approved', pub: 'Active', score: 85, missing: [], sellers: ['Trailhead Outfitters'] },
  { id: 'p-crv-swf', sku: 'CRV-SWF-10', name: 'Corvo Swift Trail Running Shoes', icon: 'footprints', tint: '4', brand: 'Corvo', cat: 'Fashion', sub: 'Shoes', offers: 2, price: 112, review: 'Approved', pub: 'Hidden', score: 74, issue: 'Missing size chart', missing: ['Missing required attributes'], edge: 'warn', sellers: ['Marketly Official', 'Trailhead Outfitters'] },
  { id: 'p-plr-ci26', sku: 'PLR-CI26', name: 'Pellar Pre-seasoned Cast Iron Skillet 26 cm', icon: 'cooking-pot', tint: '3', brand: 'Pellar', cat: 'Home & Kitchen', sub: 'Cookware', offers: 3, price: 58, review: 'Approved', pub: 'Active', score: 97, missing: [], sellers: ['Marketly Official', 'Casa Verde Home', 'Gadget Grove'] },
  { id: 'p-ndv-mer', sku: 'NDV-MER-M-NVY', name: 'Nordvik Merino Wool Crew Sweater', icon: 'shirt', tint: '4', brand: 'Nordvik', cat: 'Fashion', sub: 'Knitwear', offers: 1, price: 84, review: 'Approved', pub: 'Active', score: 83, missing: [], sellers: ['Marketly Official'] },
  { id: 'p-hal-pkt', sku: 'HAL-PKT-TEAL', name: 'Halden Pocket Bluetooth Speaker', icon: 'speaker', tint: '2', brand: 'Halden', cat: 'Electronics', sub: 'Speakers', offers: 3, price: 59, review: 'Approved', pub: 'Active', score: 90, missing: [], sellers: ['Marketly Official', 'Northwind Audio', 'Gadget Grove'] },
  { id: 'p-brl-s2', sku: 'BRL-S2', name: 'Brightline S2 Robot Vacuum with Mapping', icon: 'bot', tint: '1', brand: 'Brightline', cat: 'Home & Kitchen', sub: 'Cleaning', offers: 4, price: 279, review: 'Approved', pub: 'Active', score: 81, note: 'Gadget Grove offer paused · 3 other offers live', missing: [], sellers: ['Marketly Official', 'Casa Verde Home', 'Pixel & Port', 'Gadget Grove'] },
  { id: 'p-kst-k75', sku: 'KST-K75-GRY', name: 'Kestrel K75 Wireless Mechanical Keyboard', icon: 'keyboard', tint: '6', brand: 'Kestrel', cat: 'Computers', sub: 'Keyboards', offers: 2, price: 109, review: 'Approved', pub: 'Active', score: 93, missing: [], sellers: ['Marketly Official', 'Pixel & Port'] },
  { id: 'p-msw-po', sku: 'MSW-PO-CRM', name: 'Mosswood Ceramic Pour-over Coffee Set', icon: 'coffee', tint: '3', brand: 'Mosswood', cat: 'Home & Kitchen', sub: 'Coffee & tea', offers: 2, price: 36, review: 'Approved', pub: 'Active', score: 89, missing: [], sellers: ['Marketly Official', 'Casa Verde Home'] },
  { id: 'p-ast-vc30', sku: 'AST-VC30', name: 'Aster Daily Vitamin C Serum 30 ml', icon: 'droplet', tint: '5', brand: 'Aster', cat: 'Beauty', sub: 'Skincare', offers: 2, price: 24, review: 'Changes requested', pub: 'Hidden', score: 62, issue: 'Missing ingredients list', missing: ['Missing required attributes', 'Missing description'], edge: 'warn', sellers: ['Marketly Official', 'Gadget Grove'] },
  { id: 'p-crv-ym6', sku: 'CRV-YM6-SAGE', name: 'Corvo Grip Yoga Mat 6 mm', icon: 'activity', tint: '1', brand: 'Corvo', cat: 'Sports & Outdoors', sub: 'Yoga', offers: 2, price: 45, review: 'Approved', pub: 'Active', score: 86, missing: [], sellers: ['Marketly Official', 'Trailhead Outfitters'] },
];
