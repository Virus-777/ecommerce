import type { Tint } from '@marketly/web-shared/data/fixtures';
import type { IconName } from '@marketly/web-shared/ui';

// Sample data for pages/ops/ReturnInspection.tsx (design: pages/ops/ops-return-inspection*.html).

export type ReturnStage = 'received' | 'arriving' | 'decided';

export interface ReturnRow {
  rt: string;
  order: string;
  item: string;
  icon: IconName;
  tint: Tint;
  reason: string;
  received: string;
  inspector: string;
  status: string;
  target: { tone: 'ok' | 'warning' | 'danger'; text: string };
  edge: 'flagged' | 'warn' | '';
  stage: ReturnStage;
  price: number;
  /** Customer pays the return label (change of mind) — amount deducted. */
  labelCost: number;
}

export const RETURNS: ReturnRow[] = [
  { rt: 'RT-261004-0197', order: 'MK-260926-29004', item: 'Pellar Cast Iron Skillet 26 cm', icon: 'cooking-pot', tint: '3', reason: 'Defective: cracked', received: 'Oct 6', inspector: 'Carlos Mendez', status: 'Returned', target: { tone: 'danger', text: 'Overdue 1 d' }, edge: 'flagged', stage: 'received', price: 49, labelCost: 0 },
  { rt: 'RT-261005-0212', order: 'MK-260928-30551', item: 'Halden Aurora ANC Headphones, Black', icon: 'headphones', tint: '2', reason: 'No longer needed', received: 'Oct 7', inspector: 'Carlos Mendez', status: 'Inspecting', target: { tone: 'warning', text: 'Inspect by Oct 9' }, edge: 'warn', stage: 'received', price: 189, labelCost: 0 },
  { rt: 'RT-261006-0226', order: 'MK-261001-32870', item: 'Aster Daily Vitamin C Serum 30 ml', icon: 'droplet', tint: '5', reason: 'Skin reaction, opened', received: 'Oct 8', inspector: 'Unassigned', status: 'Returned', target: { tone: 'ok', text: 'Inspect by Oct 12' }, edge: '', stage: 'received', price: 32, labelCost: 0 },
  { rt: 'RT-261006-0230', order: 'MK-260930-31207', item: 'Nordvik Merino Crew, M, Navy', icon: 'shirt', tint: '4', reason: 'Wrong size', received: 'Oct 8', inspector: 'Unassigned', status: 'Returned', target: { tone: 'ok', text: 'Inspect by Oct 12' }, edge: '', stage: 'received', price: 79, labelCost: 6.5 },
  { rt: 'RT-261002-0175', order: 'MK-260924-26618', item: 'Brightline Smart LED Desk Lamp', icon: 'lamp-desk', tint: '5', reason: 'Not as described', received: 'Oct 5', inspector: 'Carlos Mendez', status: 'Decision made', target: { tone: 'ok', text: 'Refund with Finance' }, edge: '', stage: 'decided', price: 59, labelCost: 0 },
  { rt: 'RT-261003-0188', order: 'MK-260914-48213', item: 'Mosswood Pour-over Coffee Set, Cream', icon: 'coffee', tint: '3', reason: 'Arrived chipped', received: 'Arriving Oct 9', inspector: '—', status: 'Return in transit', target: { tone: 'ok', text: 'Not received' }, edge: '', stage: 'arriving', price: 45, labelCost: 0 },
];

export type Condition = 'new' | 'like-new' | 'good' | 'damaged';
export const CONDITIONS: Array<{ id: Condition; title: string; body: string }> = [
  { id: 'new', title: 'New, sealed', body: 'Factory seal intact' },
  { id: 'like-new', title: 'Like new, opened', body: 'No marks, works fully' },
  { id: 'good', title: 'Good, light wear', body: 'Small marks, works fully' },
  { id: 'damaged', title: 'Damaged or not working', body: 'Needs repair or write-off' },
];

export type Outcome = 'restock' | 'repair' | 'regrade' | 'supplier' | 'writeoff';

export interface Check {
  label: string;
  ok: boolean;
  /** Accessory: unchecked means a missing part with this deduction. */
  part?: { name: string; value: number };
}

export interface Inspection {
  photos: Array<{ label: string; icon: IconName }>;
  condition: Condition | '';
  checks: Check[];
  outcome: Outcome | '';
  why: string;
  sku: string;
  bin: string;
  brand: string;
  supplier: string;
  serviceDays: number;
  /** Return record before the inspection step. */
  requested: { d: string; note?: string };
  receivedAt: string;
  payment: string;
}

/** The design's inspection of RT-261005-0212. */
export const DESIGN_INSPECTION: Inspection = {
  photos: [
    { label: 'Front, headband', icon: 'headphones' },
    { label: 'Ear cushions', icon: 'headphones' },
    { label: 'Accessories laid out', icon: 'cable' },
    { label: 'Box and seal', icon: 'package-open' },
  ],
  condition: 'like-new',
  checks: [
    { label: 'USB-C charging cable', ok: true, part: { name: 'USB-C charging cable', value: 9 } },
    { label: '3.5 mm audio cable', ok: true, part: { name: 'audio cable', value: 7 } },
    { label: 'Carry case', ok: false, part: { name: 'carry case', value: 15 } },
    { label: 'Serial number matches order (HA24-0918-7731)', ok: true },
    { label: 'Powers on, pairs, noise cancelling works', ok: true },
    { label: 'No odor, hygiene OK', ok: true },
  ],
  outcome: 'regrade',
  why: 'Carry case missing from return. Accessory value $15.00 per Halden price list.',
  sku: 'HAL-AUR-BLK',
  bin: 'R-01-3',
  brand: 'Halden',
  supplier: 'Halden Audio Distribution',
  serviceDays: 10,
  requested: { d: 'Oct 2 · Jordan Lee', note: '"Opened, used once. Prefer over-ear."' },
  receivedAt: 'Oct 7, 2:14 PM · UPS 1Z84E2W70392096631',
  payment: 'Visa •••• 2203',
};

const SKU_BY_ITEM: Record<string, { sku: string; brand: string; supplier: string }> = {
  'Pellar Cast Iron Skillet 26 cm': { sku: 'PLR-CI26', brand: 'Pellar', supplier: 'Pellar Cookware Co.' },
  'Aster Daily Vitamin C Serum 30 ml': { sku: 'AST-VC30', brand: 'Aster', supplier: 'Aster Skincare Labs' },
  'Nordvik Merino Crew, M, Navy': { sku: 'NDV-MER-M-NVY', brand: 'Nordvik', supplier: 'Nordvik Knitwear' },
  'Brightline Smart LED Desk Lamp': { sku: 'BRL-LAMP-W', brand: 'Brightline', supplier: 'Brightline Lighting' },
  'Mosswood Pour-over Coffee Set, Cream': { sku: 'MSW-PO-CRM', brand: 'Mosswood', supplier: 'Mosswood Home Goods' },
};

/** A fresh inspection for a return that has not been inspected yet. */
export function newInspection(r: ReturnRow): Inspection {
  const s = SKU_BY_ITEM[r.item] ?? { sku: 'SKU', brand: 'Brand', supplier: 'Supplier' };
  return {
    photos: [],
    condition: '',
    checks: [
      { label: 'All parts and packaging present', ok: false, part: { name: 'parts or packaging', value: 0 } },
      { label: `Item matches order ${r.order}`, ok: false },
      { label: 'Works as described', ok: false },
      { label: 'No odor, hygiene OK', ok: false },
    ],
    outcome: '',
    why: '',
    sku: s.sku,
    bin: 'R-01-4',
    brand: s.brand,
    supplier: s.supplier,
    serviceDays: 10,
    requested: { d: 'Customer request' },
    receivedAt: `${r.received} · Reno, NV`,
    payment: 'the original payment method',
  };
}
