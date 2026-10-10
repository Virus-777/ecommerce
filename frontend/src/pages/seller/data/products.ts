// Seller "Products and offers" rows (design: pages/seller/seller-products.html).
import type { IconName } from '@/ui';
import type { ScreenId } from '@/routes/catalogue';

export type Review = 'Approved' | 'Draft' | 'Submitted' | 'Changes requested' | 'Rejected';
export type Publication = 'Active' | 'Hidden' | 'Suspended' | 'Not published';

export interface ProductRow {
  sku: string;
  name: string;
  variant: string;
  category: string;
  icon: IconName;
  tint: string;
  price: number;
  stock: number;
  condition: string;
  review: Review;
  publication: Publication;
  /** Grey note under the name (hidden by you, submitted, missing content). */
  note?: string;
  /** Reviewer / restriction message (.sa-reason). danger = red. */
  reason?: { text: string; danger?: boolean };
  /** Where the product name links. */
  link: { id: ScreenId; view?: string };
  /** Phone card links to the offer for every row. */
  missing?: Array<'images' | 'identifiers'>;
  action: { label: string; kind: 'link' | 'show' | 'button'; variant: 'ghost' | 'primary' | 'secondary'; to?: { id: ScreenId; view?: string } };
}

const offer = { id: 'seller/offer' as const };
const editOffer = { label: 'Edit offer', kind: 'link' as const, variant: 'ghost' as const, to: offer };

export const PRODUCT_ROWS: ProductRow[] = [
  { sku: 'NWA-PKT-TEAL', name: 'Halden Pocket Bluetooth Speaker', variant: 'Teal', category: 'Speakers', icon: 'speaker', tint: '2', price: 59, stock: 88, condition: 'New', review: 'Approved', publication: 'Active', link: offer, action: editOffer },
  { sku: 'NWA-PKT-CHR', name: 'Halden Pocket Bluetooth Speaker', variant: 'Charcoal', category: 'Speakers', icon: 'speaker', tint: '6', price: 59, stock: 6, condition: 'New', review: 'Approved', publication: 'Active', link: offer, action: editOffer },
  { sku: 'NWA-AUR-BLK', name: 'Halden Aurora ANC Wireless Headphones', variant: 'Midnight black', category: 'Headphones', icon: 'headphones', tint: '2', price: 184, stock: 14, condition: 'New', review: 'Approved', publication: 'Active', link: offer, action: editOffer },
  { sku: 'NWA-AUR-SLV', name: 'Halden Aurora ANC Wireless Headphones', variant: 'Silver', category: 'Headphones', icon: 'headphones', tint: '1', price: 184, stock: 0, condition: 'New', review: 'Approved', publication: 'Active', link: offer, action: editOffer },
  { sku: 'NWA-CBL-KIT', name: 'Northwind Studio Cable Kit', variant: '3.5 mm + 6.35 mm, 2 m', category: 'Cables and adapters', icon: 'cable', tint: '3', price: 24, stock: 42, condition: 'New', review: 'Approved', publication: 'Active', link: offer, action: editOffer },
  { sku: 'NWA-AUR-BLK-U', name: 'Halden Aurora ANC Wireless Headphones', variant: 'Midnight black', category: 'Headphones', icon: 'headphones', tint: '2', price: 139, stock: 2, condition: 'Used – Good', review: 'Approved', publication: 'Hidden', note: 'Hidden by you on Oct 2', link: offer, action: { label: 'Show offer', kind: 'show', variant: 'ghost' } },
  {
    sku: 'NWA-FER-HD60', name: 'Ferro HD-60 Studio Monitor Headphones', variant: '2 colors · Black, White', category: 'Headphones', icon: 'headphones', tint: '4', price: 129, stock: 20, condition: 'New', review: 'Changes requested', publication: 'Not published',
    reason: { text: 'Catalog team, Oct 6: Main image has a text overlay. Frequency response differs from the manufacturer spec. Carry pouch is shown but not listed.' },
    link: { id: 'seller/product-new', view: 'changes-requested' },
    action: { label: 'Fix and resubmit', kind: 'link', variant: 'primary', to: { id: 'seller/product-new', view: 'changes-requested' } },
  },
  { sku: 'NWA-LUM-B5-WAL', name: 'Lumen B5 Bookshelf Speakers (pair)', variant: 'Walnut', category: 'Speakers', icon: 'speaker', tint: '3', price: 249, stock: 8, condition: 'New', review: 'Submitted', publication: 'Not published', note: 'Submitted Oct 7 · review usually takes 2 business days', link: { id: 'seller/product-new' }, action: { label: 'View submission', kind: 'link', variant: 'ghost', to: { id: 'seller/product-new' } } },
  { sku: 'NWA-ARC-DAC', name: 'Arclight Mini USB-C DAC', variant: 'Graphite', category: 'DACs and amplifiers', icon: 'usb', tint: '6', price: 79, stock: 0, condition: 'New', review: 'Draft', publication: 'Not published', note: 'Missing images and identifiers', missing: ['images', 'identifiers'], link: { id: 'seller/product-new' }, action: { label: 'Continue draft', kind: 'link', variant: 'secondary', to: { id: 'seller/product-new' } } },
  {
    sku: 'NWA-SORA-SX7', name: 'Sora SX-7 Cassette Deck', variant: 'Silver', category: 'Turntables and decks', icon: 'cassette-tape', tint: '5', price: 210, stock: 1, condition: 'Refurbished', review: 'Rejected', publication: 'Not published',
    reason: { text: 'Refurbished audio equipment needs category approval first. Apply for Refurbished in Store and settings, then submit again.', danger: true },
    link: { id: 'seller/product-new' },
    action: { label: 'See options', kind: 'button', variant: 'ghost' },
  },
  {
    sku: 'NWA-BUDS-CHR', name: 'Halden Buds Pro True Wireless Earbuds', variant: 'Charcoal', category: 'Headphones', icon: 'ear', tint: '1', price: 149, stock: 12, condition: 'New', review: 'Approved', publication: 'Suspended',
    reason: { text: 'Proof of purchase from an authorized distributor requested. Send an invoice by Oct 12 to restore the offer.', danger: true },
    link: offer,
    action: { label: 'Send documents', kind: 'button', variant: 'secondary' },
  },
];

/** Server totals per tab (24 offers; one page of 11 is loaded). */
export const PRODUCT_TAB_TOTALS = { all: 24, active: 14, draft: 2, submitted: 3, changes: 1, rejected: 1, hidden: 3 };
export const PRODUCT_TOTAL = 24;
export const PRODUCT_CATEGORIES = ['Headphones', 'Speakers', 'Cables and adapters', 'DACs and amplifiers', 'Turntables and decks'];
/** Stock at or below this shows "Low". */
export const LOW_STOCK = 6;
