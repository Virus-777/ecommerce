// Deals page sample: today's flash sale (per-offer deal prices), coupons, clearance and upcoming events.

export type DealTab = 'all' | 'flash' | 'clearance' | 'coupons' | 'events';

export const DEAL_TABS: Array<{ value: DealTab; label: string; count: number }> = [
  { value: 'all', label: 'All deals', count: 148 },
  { value: 'flash', label: 'Flash sales', count: 5 },
  { value: 'clearance', label: 'Clearance', count: 36 },
  { value: 'coupons', label: 'Coupons', count: 12 },
  { value: 'events', label: 'Upcoming events', count: 3 },
];

export const FLASH = {
  window: 'Today, Oct 8, 6:00 AM – 11:59 PM PT',
  /** Seconds left when the page opens (05:42:18). */
  endsIn: 5 * 3600 + 42 * 60 + 18,
};

export interface FlashDeal {
  /** Fixture product id (`P`). */
  p: string;
  price: number;
  was: number;
  seller: string;
  limit: number;
  /** Share of deal stock claimed, 0–100. */
  claimed: number;
  /** Deal stock ran out: the card shows the regular offer instead. */
  soldOutAt?: string;
  regular?: { price: number; was: number };
}

export const FLASH_DEALS: FlashDeal[] = [
  { p: 'kestrel27', price: 279, was: 329, seller: 'Pixel & Port', limit: 1, claimed: 41 },
  { p: 'speaker', price: 49, was: 79, seller: 'Northwind Audio', limit: 2, claimed: 72 },
  { p: 'duvet', price: 99, was: 149, seller: 'Casa Verde Home', limit: 2, claimed: 58 },
  { p: 'skillet', price: 49, was: 72, seller: 'Marketly Official', limit: 2, claimed: 86 },
  { p: 'ssd1tb', price: 79.99, was: 119.99, seller: 'Pixel & Port', limit: 1, claimed: 100, soldOutAt: '2:14 PM', regular: { price: 94.99, was: 119.99 } },
];

export interface Coupon {
  id: string;
  amt: string;
  unit: string;
  title: string;
  terms: string;
  expires: string;
  clipped: boolean;
}

export const COUPONS: Coupon[] = [
  { id: 'c1', amt: '$10', unit: 'off', title: '$10 off Kestrel storage', terms: 'Pixel & Port items over $75 · New customers and returning', expires: 'Expires Oct 31, 2026 · Funded by Pixel & Port', clipped: false },
  { id: 'c2', amt: '15%', unit: 'off', title: '15% off Mosswood bedding', terms: 'Casa Verde Home · minimum spend $100 · one use per customer', expires: 'Expires Oct 19, 2026 · Funded by Casa Verde Home', clipped: false },
  { id: 'c3', amt: 'Free', unit: 'shipping', title: 'Free shipping from Trailhead', terms: 'Trailhead Outfitters orders over $50', expires: 'Expires Nov 15, 2026 · Funded by Trailhead Outfitters', clipped: true },
  { id: 'c4', amt: '$5', unit: 'off', title: '$5 off your first Official Store order', terms: 'Official Store items over $25 · first Official Store order only', expires: 'Expires Dec 31, 2026 · Funded by Marketly', clipped: false },
];

export const CLEARANCE_IDS = ['backpack', 'serum', 'auroraBuds', 'corvoStride', 'aria'];
export const CLEARANCE_TOTAL = 36;

export interface DealEvent {
  id: string;
  month: string;
  day: string;
  title: string;
  when: string;
}

export const EVENTS: DealEvent[] = [
  { id: 'e1', month: 'Oct', day: '20', title: 'Home Week, part 2: Kitchen', when: 'Oct 20, 6:00 AM – Oct 26, 11:59 PM PT · Cookware and coffee from the Official Store and Casa Verde' },
  { id: 'e2', month: 'Oct', day: '27', title: 'Outdoor gear clearance', when: 'Oct 27, 6:00 AM – Nov 2, 11:59 PM PT · Trailhead Outfitters end-of-season stock' },
  { id: 'e3', month: 'Nov', day: '23', title: 'Black Friday week', when: 'Nov 23, 12:00 AM – Nov 30, 11:59 PM PT · Daily flash sales across all categories' },
];
