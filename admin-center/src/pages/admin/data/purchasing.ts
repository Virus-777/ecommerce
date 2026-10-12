// Sample data for admin/purchasing (design: pages/admin/admin-purchasing*.html).

export type PoStatus = 'Draft' | 'In review' | 'Sent' | 'Partly received' | 'Received';

export interface Supplier {
  name: string;
  city: string;
  contact: string;
  leadDays: number;
  /** On-time arrival over the last 90 days, % (null for a new supplier). */
  onTime: number | null;
}

export interface PoLine {
  sku: string;
  name: string;
  ordered: number;
  received: number;
  damaged: number;
  unit: number;
}

export interface PoEvent {
  t: string;
  d: string;
  state: 'done' | 'warn' | 'current';
}

export interface PurchaseOrder {
  ref: string;
  supplier: string;
  status: PoStatus;
  /** Expected arrival in the table. */
  expected: string;
  /** Expected arrival in the drawer. */
  expectedDetail: string;
  /** Short note under the date for later deliveries, e.g. "Rest due Oct 13". */
  restDue?: string;
  created: string;
  createdBy: string;
  shipTo: string;
  terms: string;
  freight: number;
  lines: PoLine[];
  events: PoEvent[];
  info?: { title: string; body: string };
}

export const PO_LIMIT = 25000;
export const BUYER = 'Ken Watanabe';
export const APPROVER = 'Morgan Hale';

export const SUPPLIERS: Supplier[] = [
  { name: 'Halden Audio Distribution', city: 'Los Angeles, CA', contact: 'Carla Nguyen', leadDays: 6, onTime: 94 },
  { name: 'Kestrel Peripherals US', city: 'San Jose, CA', contact: 'Ben Ortiz', leadDays: 8, onTime: 89 },
  { name: 'Pellar Cookware Co.', city: 'Chicago, IL', contact: 'Ruth Adler', leadDays: 10, onTime: 97 },
  { name: 'Brightline US', city: 'Dallas, TX', contact: 'Omar Said', leadDays: 7, onTime: 91 },
  { name: 'Mosswood Home Goods', city: 'Asheville, NC', contact: 'Ivy Chambers', leadDays: 12, onTime: 92 },
  { name: 'Aster Labs', city: 'Irvine, CA', contact: 'Kai Moreno', leadDays: 5, onTime: 98 },
];

/** On-time % below this is shown in warning colour. */
export const ON_TIME_WARN = 90;

/** What each supplier can supply, for adding PO lines. */
export const SUPPLIER_ITEMS: Record<string, Array<{ sku: string; name: string; unit: number }>> = {
  'Halden Audio Distribution': [
    { sku: 'HAL-AUR-BLK', name: 'Aurora ANC Headphones, Midnight black', unit: 128 },
    { sku: 'HAL-AUR-SLV', name: 'Aurora ANC Headphones, Silver', unit: 128 },
    { sku: 'HAL-PKT-TEAL', name: 'Pocket Bluetooth Speaker, Teal', unit: 38.5 },
    { sku: 'HAL-PKT-BLK', name: 'Pocket Bluetooth Speaker, Black', unit: 38.5 },
  ],
  'Kestrel Peripherals US': [
    { sku: 'KST-27UHD-OS', name: 'Kestrel 27" 4K IPS Monitor, USB-C 65 W', unit: 262 },
    { sku: 'KST-DOCK-C', name: 'Kestrel USB-C Docking Station', unit: 111 },
  ],
  'Pellar Cookware Co.': [
    { sku: 'PLR-CI26', name: 'Pre-seasoned Cast Iron Skillet 26 cm', unit: 34 },
    { sku: 'PLR-CI20', name: 'Pre-seasoned Cast Iron Skillet 20 cm', unit: 26 },
  ],
  'Brightline US': [
    { sku: 'BRL-LAMP-W', name: 'Smart LED Desk Lamp with Wireless Charger', unit: 24.5 },
    { sku: 'BRL-PLUG-4', name: 'Smart Plug, 4-pack', unit: 35 },
  ],
  'Mosswood Home Goods': [
    { sku: 'MSW-PO-CRM', name: 'Ceramic Pour-over Coffee Set', unit: 19.8 },
    { sku: 'MSW-DUV-Q', name: 'Linen Duvet Cover, Queen', unit: 46 },
    { sku: 'MSW-MUG-4', name: 'Stoneware Mug, set of 4', unit: 14.4 },
    { sku: 'MSW-THROW', name: 'Wool Throw Blanket', unit: 54 },
  ],
  'Aster Labs': [
    { sku: 'AST-VC30', name: 'Daily Vitamin C Serum 30 ml', unit: 9.6 },
    { sku: 'AST-SPF50', name: 'Daily SPF 50 Sunscreen 50 ml', unit: 7.2 },
  ],
};

const line = (supplier: string, sku: string, ordered: number, received = 0, damaged = 0): PoLine => {
  const it = SUPPLIER_ITEMS[supplier].find((i) => i.sku === sku)!;
  return { sku, name: it.name, unit: it.unit, ordered, received, damaged };
};

const HALDEN = 'Halden Audio Distribution';
const WAREHOUSE = 'Marketly warehouse, Reno, NV';
const NET30 = 'Net 30 from invoice';

export const PURCHASE_ORDERS: PurchaseOrder[] = [
  {
    ref: 'PUR-2610-0051', supplier: HALDEN, status: 'Draft', expected: 'Not set', expectedDetail: 'Not set', created: 'Oct 8', createdBy: BUYER, shipTo: WAREHOUSE, terms: NET30, freight: 740,
    lines: [line(HALDEN, 'HAL-AUR-BLK', 120), line(HALDEN, 'HAL-AUR-SLV', 60), line(HALDEN, 'HAL-PKT-TEAL', 120)],
    events: [{ t: 'Draft created', d: 'Oct 8, 2:05 PM · Ken Watanabe', state: 'done' }],
  },
  {
    ref: 'PUR-2610-0049', supplier: 'Brightline US', status: 'Draft', expected: 'Not set', expectedDetail: 'Not set', created: 'Oct 7', createdBy: BUYER, shipTo: WAREHOUSE, terms: NET30, freight: 0,
    lines: [line('Brightline US', 'BRL-LAMP-W', 80), line('Brightline US', 'BRL-PLUG-4', 40)],
    events: [{ t: 'Draft created', d: 'Oct 7, 10:30 AM · Ken Watanabe', state: 'done' }],
  },
  {
    ref: 'PUR-2610-0047', supplier: 'Pellar Cookware Co.', status: 'Sent', expected: 'Oct 16', expectedDetail: 'Oct 16', restDue: 'Due Oct 16', created: 'Oct 3', createdBy: BUYER, shipTo: WAREHOUSE, terms: NET30, freight: 0,
    lines: [line('Pellar Cookware Co.', 'PLR-CI26', 120)],
    events: [
      { t: 'Sent to supplier', d: 'Oct 4, 9:00 AM · Ken Watanabe', state: 'done' },
      { t: 'Draft created', d: 'Oct 3, 3:15 PM · Ken Watanabe', state: 'done' },
    ],
  },
  {
    ref: 'PUR-2610-0045', supplier: 'Kestrel Peripherals US', status: 'Sent', expected: 'Oct 14', expectedDetail: 'Oct 14', restDue: 'Due Oct 14', created: 'Oct 1', createdBy: BUYER, shipTo: WAREHOUSE, terms: NET30, freight: 0,
    lines: [line('Kestrel Peripherals US', 'KST-27UHD-OS', 40), line('Kestrel Peripherals US', 'KST-DOCK-C', 40)],
    events: [
      { t: 'Sent to supplier', d: 'Oct 2, 11:20 AM · Ken Watanabe', state: 'done' },
      { t: 'Draft created', d: 'Oct 1, 4:40 PM · Ken Watanabe', state: 'done' },
    ],
  },
  {
    ref: 'PUR-2610-0042', supplier: HALDEN, status: 'Partly received', expected: 'Oct 6 · 80 due Oct 13', expectedDetail: 'Oct 6 · remaining 80 units Oct 13', restDue: 'Rest due Oct 13', created: 'Sep 24', createdBy: BUYER, shipTo: WAREHOUSE, terms: NET30, freight: 320,
    lines: [line(HALDEN, 'HAL-AUR-BLK', 100, 60, 2), line(HALDEN, 'HAL-AUR-SLV', 40, 40), line(HALDEN, 'HAL-PKT-TEAL', 120, 80)],
    events: [
      { t: 'Partly received · 180 of 260', d: 'Oct 6, 11:40 AM · Ana Silva, Warehouse', state: 'warn' },
      { t: 'Supplier confirmed backorder of 80 units', d: 'Oct 2 · new date Oct 13', state: 'done' },
      { t: 'Sent to supplier', d: 'Sep 25, 9:10 AM · Ken Watanabe', state: 'done' },
      { t: 'Draft created', d: 'Sep 24, 4:22 PM · Ken Watanabe', state: 'done' },
    ],
    info: { title: 'Stock made available', body: 'Ana Silva received 180 units on Oct 6 (receiving REC-261006-03). Inventory made 178 sellable; 2 damaged units are in Damaged or held until the supplier claim is settled.' },
  },
  {
    ref: 'PUR-2609-0038', supplier: 'Mosswood Home Goods', status: 'Received', expected: 'Sep 30', expectedDetail: 'Sep 30 · all units received', created: 'Sep 15', createdBy: BUYER, shipTo: WAREHOUSE, terms: NET30, freight: 0,
    lines: [
      line('Mosswood Home Goods', 'MSW-PO-CRM', 60, 60), line('Mosswood Home Goods', 'MSW-DUV-Q', 50, 50),
      line('Mosswood Home Goods', 'MSW-MUG-4', 60, 60), line('Mosswood Home Goods', 'MSW-THROW', 40, 40),
    ],
    events: [
      { t: 'Received in full · 210 of 210', d: 'Sep 30, 10:05 AM · Ana Silva, Warehouse', state: 'done' },
      { t: 'Sent to supplier', d: 'Sep 16, 9:30 AM · Ken Watanabe', state: 'done' },
      { t: 'Draft created', d: 'Sep 15, 2:10 PM · Ken Watanabe', state: 'done' },
    ],
  },
  {
    ref: 'PUR-2609-0035', supplier: 'Aster Labs', status: 'Received', expected: 'Sep 28', expectedDetail: 'Sep 28 · all units received', created: 'Sep 20', createdBy: BUYER, shipTo: WAREHOUSE, terms: NET30, freight: 0,
    lines: [line('Aster Labs', 'AST-VC30', 300, 300)],
    events: [
      { t: 'Received in full · 300 of 300', d: 'Sep 28, 1:45 PM · Ana Silva, Warehouse', state: 'done' },
      { t: 'Sent to supplier', d: 'Sep 21, 8:50 AM · Ken Watanabe', state: 'done' },
      { t: 'Draft created', d: 'Sep 20, 5:00 PM · Ken Watanabe', state: 'done' },
    ],
  },
];

export interface ReorderSuggestion {
  sku: string;
  name: string;
  supplier: string;
  available: number;
  perDay: number;
  suggested: number;
}

export const REORDER: ReorderSuggestion[] = [
  { sku: 'KST-27UHD-OS', name: 'Kestrel 27" 4K IPS Monitor, USB-C 65 W', supplier: 'Kestrel Peripherals US', available: 4, perDay: 2, suggested: 40 },
  { sku: 'KST-DOCK-C', name: 'Kestrel USB-C Docking Station', supplier: 'Kestrel Peripherals US', available: 3, perDay: 1, suggested: 30 },
  { sku: 'BRL-LAMP-W', name: 'Smart LED Desk Lamp with Wireless Charger', supplier: 'Brightline US', available: 9, perDay: 3, suggested: 80 },
  { sku: 'HAL-AUR-SLV', name: 'Aurora ANC Headphones, Silver', supplier: 'Halden Audio Distribution', available: 5, perDay: 2, suggested: 60 },
  { sku: 'PLR-CI20', name: 'Pre-seasoned Cast Iron Skillet 20 cm', supplier: 'Pellar Cookware Co.', available: 6, perDay: 1, suggested: 60 },
  { sku: 'MSW-DUV-Q', name: 'Linen Duvet Cover, Queen', supplier: 'Mosswood Home Goods', available: 7, perDay: 1, suggested: 40 },
  { sku: 'AST-SPF50', name: 'Daily SPF 50 Sunscreen 50 ml', supplier: 'Aster Labs', available: 8, perDay: 4, suggested: 200 },
];
