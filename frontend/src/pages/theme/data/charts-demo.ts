import type { ChartRow, DonutSlice, WaterfallStepInput } from '@marketly/web-shared/ui';

// Sample figures for the chart gallery on the design components page (/design/components). Money is in cents, as
// the reports API sends it. The numbers are made up but add up (the waterfall ends at the profit it shows).

const LABELS = ['Sep 25', 'Sep 26', 'Sep 27', 'Sep 28', 'Sep 29', 'Sep 30', 'Oct 1', 'Oct 2', 'Oct 3', 'Oct 4', 'Oct 5', 'Oct 6', 'Oct 7', 'Oct 8'];
const OFFICIAL = [18200, 19100, 22400, 24800, 17600, 16900, 18400, 20200, 21000, 25600, 27100, 19400, 18800, 20600];
const SELLERS = [11400, 12000, 14800, 16200, 12100, 12600, 13000, 14400, 15100, 18900, 20300, 14200, 14900, 16100];
// the same days a period earlier (the `<key>:compare` twins the backend sends)
const OFFICIAL_BEFORE = [16100, 17400, 19800, 21000, 16300, 15900, 17000, 18800, 19600, 22100, 23900, 18200, 17700, 18900];

/** Daily sales, Official Store vs sellers, with the Official Store's previous period. */
export const DEMO_TREND: ChartRow[] = LABELS.map((label, i) => ({
  x: `2026-${i < 6 ? '09' : '10'}-${String(i < 6 ? 25 + i : i - 5).padStart(2, '0')}`,
  label,
  official: OFFICIAL[i] * 100,
  sellers: SELLERS[i] * 100,
  'official:compare': OFFICIAL_BEFORE[i] * 100,
}));

/** Weekly product cost and profit (cents) with the margin in percent. */
export const DEMO_COMBO: ChartRow[] = [
  { x: 'w36', label: 'Sep 1', cost: 412000, profit: 168000, margin: 24.1 },
  { x: 'w37', label: 'Sep 8', cost: 398000, profit: 181000, margin: 26.3 },
  { x: 'w38', label: 'Sep 15', cost: 455000, profit: 152000, margin: 21.4 },
  { x: 'w39', label: 'Sep 22', cost: 470000, profit: 205000, margin: 27.0 },
  { x: 'w40', label: 'Sep 29', cost: 431000, profit: 199000, margin: 28.2 },
  { x: 'w41', label: 'Oct 6', cost: 446000, profit: -12000, margin: -1.9 },
];

/** Profit by product, a ranking with one loss. */
export const DEMO_RANKING: ChartRow[] = [
  { x: 'p1', label: 'Aurora wireless headphones', profit: 284000 },
  { x: 'p2', label: 'Kestrel 27" monitor', profit: 231500 },
  { x: 'p3', label: 'Linen duvet cover, queen', profit: 118200 },
  { x: 'p4', label: 'Vitamin C serum', profit: 64000 },
  { x: 'p5', label: 'Trail running shoes', profit: -21800 },
];

/** Item sales to profit for a month. */
export const DEMO_WATERFALL: WaterfallStepInput[] = [
  { key: 'item_sales', label: 'Item sales', amount: 2480000, step: 'start' },
  { key: 'shipping', label: 'Shipping charged', amount: 96000, step: 'plus' },
  { key: 'refunds', label: 'Refunds', amount: 148000, step: 'minus' },
  { key: 'fees', label: 'Fees', amount: 297600, step: 'minus' },
  { key: 'ads', label: 'Ad spend', amount: 120000, step: 'minus' },
  { key: 'labels', label: 'Labels', amount: 41200, step: 'minus' },
  { key: 'net', label: 'Net earnings', amount: 1969200, step: 'total' },
  { key: 'cost', label: 'Product cost', amount: 1302000, step: 'minus' },
  { key: 'profit', label: 'Profit', amount: 667200, step: 'total' },
];

/** Fees by type: eight kinds, folded to six slices (five + Other). */
export const DEMO_FEES: DonutSlice[] = [
  { key: 'commission', label: 'Commission', value: 214000 },
  { key: 'fulfilment', label: 'Fulfilment', value: 38200 },
  { key: 'payment', label: 'Payment processing', value: 26400 },
  { key: 'storage', label: 'Storage', value: 9800 },
  { key: 'returns', label: 'Return handling', value: 5600 },
  { key: 'labels', label: 'Labels', value: 2100 },
  { key: 'disputes', label: 'Disputes', value: 1000 },
  { key: 'other', label: 'Adjustments', value: 500 },
];
