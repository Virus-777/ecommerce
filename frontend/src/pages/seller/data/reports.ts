import type { IconName } from '@/ui';

// Design: pages/seller/seller-reports.html shows the 30-day period. The 7- and 90-day periods are
// sample data in the same shape (API: GET /seller/reports?period=7d|30d|90d).

export type Period = '7d' | '30d' | '90d';

export interface ProductSales {
  name: string;
  icon: IconName;
  sku: string;
  units: number;
  gross: number;
  returns: number;
  liveDiscount?: boolean;
}

export interface Delta {
  value: string;
  dir: 'up' | 'down';
  good: boolean;
}

export interface PeriodReport {
  label: string;
  range: string;
  chartRange: string;
  /** First day of the period (Pacific Time) used to build the chart labels. */
  start: Date;
  orders: number[];
  returnsByReason: number[];
  products: ProductSales[];
  /** null: no prior period to compare with (store opened Jul 14). */
  deltas: { gross: Delta; orders: Delta; returnRate: Delta } | null;
  compare: string;
  note: string;
}

export const RETURN_REASONS = ['Defective', 'Changed mind', 'Not as desc.', 'Missing parts', 'Damaged', 'Wrong item'];

const product = (name: string, icon: IconName, sku: string, units: number, price: number, returns: number, liveDiscount?: boolean): ProductSales => ({
  name, icon, sku, units, gross: Math.round(units * price * 100) / 100, returns, liveDiscount,
});

/** Deterministic sample for Jul 11 – Sep 8: the store opened Jul 14 and grew through the summer. */
function firstSixtyDays(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 60; i++) {
    if (i < 3) out.push(0);
    else out.push(Math.max(1, Math.round(2 + (i / 59) * 7 + ((i * 7) % 5) - 2 + (i % 7 === 5 ? 3 : 0))));
  }
  return out;
}

const ORDERS_30 = [9, 11, 8, 14, 15, 10, 9, 12, 11, 13, 16, 18, 12, 10, 11, 13, 12, 15, 17, 11, 10, 12, 14, 13, 12, 16, 19, 13, 12, 14];

export const REPORTS: Record<Period, PeriodReport> = {
  '7d': {
    label: '7 days',
    range: 'Oct 2 – Oct 8, 2026',
    chartRange: 'Oct 2 – Oct 8',
    start: new Date(2026, 9, 2),
    orders: ORDERS_30.slice(-7),
    returnsByReason: [2, 1, 0, 1, 0, 0],
    products: [
      product('Halden Pocket Bluetooth Speaker', 'speaker', 'HAL-PKT-TEAL / SND', 56, 55.48, 2, true),
      product('Halden Aurora ANC Wireless Headphones', 'headphones', 'HAL-AUR-BLK', 16, 184, 1),
      product('Studio Cable Kit', 'cable', 'NWA-CBL-KIT', 22, 24, 1),
      product('Ardent USB Desk Microphone', 'mic', 'ARD-USB-MIC', 4, 100, 0),
    ],
    deltas: { gross: { value: '3.2%', dir: 'up', good: true }, orders: { value: '2.1%', dir: 'up', good: true }, returnRate: { value: '0.4 pts', dir: 'down', good: true } },
    compare: 'vs prior 7 days',
    note: 'Defective returns this week are both the Pocket Speaker.',
  },
  '30d': {
    label: '30 days',
    range: 'Sep 9 – Oct 8, 2026',
    chartRange: 'Sep 9 – Oct 8',
    start: new Date(2026, 8, 9),
    orders: ORDERS_30,
    returnsByReason: [7, 5, 2, 2, 1, 1],
    products: [
      { name: 'Halden Pocket Bluetooth Speaker', icon: 'speaker', sku: 'HAL-PKT-TEAL / SND', units: 214, gross: 11872.4, returns: 9, liveDiscount: true },
      { name: 'Halden Aurora ANC Wireless Headphones', icon: 'headphones', sku: 'HAL-AUR-BLK', units: 61, gross: 11224, returns: 4 },
      { name: 'Studio Cable Kit', icon: 'cable', sku: 'NWA-CBL-KIT', units: 88, gross: 2112, returns: 5 },
      { name: 'Ardent USB Desk Microphone', icon: 'mic', sku: 'ARD-USB-MIC', units: 17, gross: 1700, returns: 0 },
    ],
    deltas: { gross: { value: '6.1%', dir: 'up', good: true }, orders: { value: '4.3%', dir: 'up', good: true }, returnRate: { value: '0.6 pts', dir: 'down', good: true } },
    compare: 'vs prior 30 days',
    note: 'Defective returns are mostly the Pocket Speaker (6 of 7). Consider checking the batch received Sep 3.',
  },
  '90d': {
    label: '90 days',
    range: 'Jul 11 – Oct 8, 2026',
    chartRange: 'Jul 11 – Oct 8',
    start: new Date(2026, 6, 11),
    orders: [...firstSixtyDays(), ...ORDERS_30],
    returnsByReason: [13, 9, 4, 4, 2, 2],
    products: [
      product('Halden Pocket Bluetooth Speaker', 'speaker', 'HAL-PKT-TEAL / SND', 410, 55.48, 17, true),
      product('Halden Aurora ANC Wireless Headphones', 'headphones', 'HAL-AUR-BLK', 117, 184, 8),
      product('Studio Cable Kit', 'cable', 'NWA-CBL-KIT', 169, 24, 9),
      product('Ardent USB Desk Microphone', 'mic', 'ARD-USB-MIC', 32, 100, 0),
    ],
    deltas: null,
    compare: 'no prior period: selling since Jul 14',
    note: 'Defective returns are mostly the Pocket Speaker. Most came from the batch received Sep 3.',
  },
};

export interface ServiceMetric {
  name: string;
  target: string;
  value: string;
  /** Bar fill: the value, or its position against the target scale for rates and times. */
  pct: number;
  meets: boolean;
  near?: boolean;
  how: string;
}

export const SERVICE: ServiceMetric[] = [
  { name: 'On-time dispatch', target: 'At least 95%', value: '96.4%', pct: 96.4, meets: true, how: 'Orders dispatched by their deadline ÷ all dispatched orders' },
  { name: 'Cancellation rate', target: 'At most 2.5%', value: '0.8%', pct: 32, meets: true, how: 'Orders you cancelled ÷ all orders' },
  { name: 'Median first response', target: 'Within 24 h', value: '9 h 30 min', pct: 40, meets: true, how: 'Time from a buyer message to your first reply' },
  { name: 'Valid tracking uploaded', target: 'At least 95%', value: '93.1%', pct: 93.1, meets: false, near: true, how: 'Shipments with a carrier-scanned tracking number' },
];
