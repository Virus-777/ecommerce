import type { Tint } from '@/data/fixtures';
import type { IconName } from '@/ui';

// Sample data for admin/official (design: pages/admin/admin-official*.html).

export type OfferStatus = 'Active' | 'Hidden' | 'Out of stock';

export interface CompanyOffer {
  id: string;
  name: string;
  /** Short name used in the price-change dialog title. */
  short: string;
  sku: string;
  icon: IconName;
  tint: Tint;
  category: string;
  price: number;
  /** List price shown as the was-price. */
  was: number | null;
  cost: number;
  available: number;
  status: OfferStatus;
  note?: string;
  /** Other sellers' offers on the same product. */
  otherOffers: string;
}

export const OFFERS: CompanyOffer[] = [
  { id: 'hal-aur', name: 'Halden Aurora ANC Wireless Headphones', short: 'Halden Aurora ANC Headphones', sku: 'HAL-AUR-BLK', icon: 'headphones', tint: '2', category: 'Electronics', price: 189, was: 229, cost: 128, available: 142, status: 'Active', otherOffers: 'Northwind Audio $184.00 + $6.99 shipping' },
  { id: 'kst-27', name: 'Kestrel 27" 4K IPS Monitor, USB-C 65 W', short: 'Kestrel 27" 4K Monitor', sku: 'KST-27UHD-OS', icon: 'monitor', tint: '6', category: 'Computers', price: 335, was: null, cost: 262, available: 4, status: 'Active', otherOffers: 'Pixel & Port $342.00, free shipping' },
  { id: 'plr-ci', name: 'Pellar Pre-seasoned Cast Iron Skillet 26 cm', short: 'Pellar Cast Iron Skillet', sku: 'PLR-CI26', icon: 'cooking-pot', tint: '3', category: 'Home & Kitchen', price: 58, was: 72, cost: 34, available: 77, status: 'Active', otherOffers: 'None' },
  { id: 'ndv-mer', name: 'Nordvik Merino Wool Crew Sweater', short: 'Nordvik Merino Sweater', sku: 'NDV-MER-M-NVY', icon: 'shirt', tint: '4', category: 'Fashion', price: 84, was: null, cost: 47, available: 52, status: 'Active', otherOffers: 'None' },
  { id: 'msw-po', name: 'Mosswood Ceramic Pour-over Coffee Set', short: 'Mosswood Pour-over Set', sku: 'MSW-PO-CRM', icon: 'coffee', tint: '3', category: 'Home & Kitchen', price: 36, was: null, cost: 19.8, available: 58, status: 'Active', otherOffers: 'Casa Verde Home $38.50 + $4.99 shipping' },
  { id: 'ast-vc', name: 'Aster Daily Vitamin C Serum 30 ml', short: 'Aster Vitamin C Serum', sku: 'AST-VC30', icon: 'droplet', tint: '5', category: 'Beauty', price: 24, was: 30, cost: 9.6, available: 140, status: 'Hidden', note: 'Product changes requested', otherOffers: 'None' },
  { id: 'brl-lamp', name: 'Brightline Smart LED Desk Lamp with Wireless Charger', short: 'Brightline Smart Desk Lamp', sku: 'BRL-LAMP-W', icon: 'lamp-desk', tint: '5', category: 'Home & Kitchen', price: 42, was: null, cost: 24.5, available: 9, status: 'Active', otherOffers: 'Gadget Grove $44.99, free shipping' },
  { id: 'hal-pkt', name: 'Halden Pocket Bluetooth Speaker', short: 'Halden Pocket Speaker', sku: 'HAL-PKT-TEAL-OS', icon: 'speaker', tint: '2', category: 'Electronics', price: 59, was: 79, cost: 41, available: 0, status: 'Out of stock', note: 'Incoming 120 on PUR-2610-0042', otherOffers: 'Northwind Audio $62.00 + $4.99 shipping' },
];

export const STATUS_FILTERS = ['All statuses', 'Active', 'Hidden', 'Out of stock', 'Low stock'];
export const CATEGORY_FILTERS = ['All categories', 'Electronics', 'Computers', 'Home & Kitchen', 'Fashion', 'Beauty'];

/** Official Store daily sales in $k, Sep 9 – Oct 8, 2026 (the last 14 days are the design's chart). */
export const DAILY_SALES_K = [
  16.4, 17.1, 18.9, 21.3, 15.8, 16.2, 17.5, 18.1, 19.6, 22.8, 23.4, 17.0, 16.6, 17.9, 18.8, 19.3,
  18.2, 19.1, 22.4, 24.8, 17.6, 16.9, 18.4, 20.2, 21.0, 25.6, 27.1, 19.4, 18.8, 20.6,
];
const FIRST_DAY = new Date(2026, 8, 9);
export const DAY_LABELS = DAILY_SALES_K.map((_, i) => new Date(FIRST_DAY.getFullYear(), FIRST_DAY.getMonth(), FIRST_DAY.getDate() + i).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));

export type Period = '7' | '14' | '30';

export interface PeriodStats {
  range: string;
  salesDelta: string;
  marginPct: number;
  discountPct: number;
  returnsK: number;
  returnsDelta: string;
  returnsPct: string;
  feeK: number;
  sellerSalesK: number;
}

export const PERIODS: Record<Period, PeriodStats> = {
  '7': { range: 'Oct 2 – Oct 8, 2026', salesDelta: '8.1%', marginPct: 31.0, discountPct: 6.8, returnsK: 4.0, returnsDelta: '0.2 pts', returnsPct: '2.6%', feeK: 10.6, sellerSalesK: 106.0 },
  '14': { range: 'Sep 25 – Oct 8, 2026', salesDelta: '6.4%', marginPct: 31.4, discountPct: 6.4, returnsK: 7.9, returnsDelta: '0.3 pts', returnsPct: '2.7%', feeK: 20.6, sellerSalesK: 206.0 },
  '30': { range: 'Sep 9 – Oct 8, 2026', salesDelta: '4.9%', marginPct: 31.6, discountPct: 6.2, returnsK: 16.4, returnsDelta: '0.1 pts', returnsPct: '2.8%', feeK: 42.1, sellerSalesK: 421.0 },
};

/** Price change limit for the Official Store Manager; above it the Business Owner approves. */
export const PRICE_LIMIT_PCT = 30;
