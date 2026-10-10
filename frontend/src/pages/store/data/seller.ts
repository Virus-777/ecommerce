// Seller storefront sample: Northwind Audio (fixtures `sellers.northwind`) plus its storefront copy,
// listings, feedback and policies.
export const STORE = {
  rating: 4.8,
  since: 'Mar 2026',
  banner: 'Sound for small apartments and long commutes',
  about: 'Independent audio shop in Portland since 2019. We test every returned unit before reselling it as used, and we answer warranty questions for everything we sell.',
  productCount: 86,
  perPage: 12,
  promo: {
    title: '10% off orders over $100 from Northwind Audio',
    terms: 'Oct 1–31, 2026. Applied automatically at checkout to Northwind Audio items. Funded by the seller.',
  },
  featured: { title: 'Featured collection: Travel-ready audio', count: 12, ids: ['aria', 'speaker', 'lumen', 'cableKit'] },
};

/** Chip value = product `sub`; counts are the whole store catalogue. */
export const STORE_CHIPS: Array<{ value: string; label: string; count: number }> = [
  { value: '', label: 'All', count: 86 },
  { value: 'Headphones', label: 'Headphones', count: 31 },
  { value: 'Earbuds', label: 'Earbuds', count: 22 },
  { value: 'Speakers', label: 'Speakers', count: 19 },
  { value: 'Cables and accessories', label: 'Cables and accessories', count: 14 },
];

export const STORE_PRODUCT_IDS = ['aurora', 'pocketMini', 'air', 'aria', 'speaker', 'lumen', 'cableKit', 'wave'];

export const FEEDBACK_STATS: Array<{ k: string; v: string; d: string }> = [
  { k: 'Positive, last 12 months', v: '98%', d: '4,812 ratings' },
  { k: 'On-time dispatch', v: '97%', d: 'Last 90 days' },
  { k: 'Replies within 24 h', v: '94%', d: 'Median 3 h' },
];

export interface Feedback {
  id: string;
  positive: boolean;
  buyer: string;
  date: string;
  item: string;
  text: string;
  reply?: string;
}

export const FEEDBACK: Feedback[] = [
  { id: 'f1', positive: true, buyer: 'Sam R.', date: 'Oct 5, 2026', item: 'Halden Pocket Bluetooth Speaker', text: 'Shipped the next morning and arrived in two days. Very well packed.' },
  { id: 'f2', positive: true, buyer: 'Chris T.', date: 'Oct 1, 2026', item: 'Halden Aurora ANC Wireless Headphones', text: 'Answered my question about the warranty within an hour.' },
  {
    id: 'f3',
    positive: false,
    buyer: 'Alex M.',
    date: 'Sep 24, 2026',
    item: 'Halden Aria True Wireless Earbuds',
    text: 'Package left Portland a day later than promised.',
    reply: 'We missed our dispatch time on Sep 22 because of a carrier pickup problem. We refunded your shipping cost. Sorry for the wait.',
  },
];

export const VERIFIED = [
  'Business identity: Northwind Audio LLC, registered in Oregon',
  'Payout bank account in the business’s name',
  'US return address in Portland, OR',
];

export const POLICIES: Array<[string, string]> = [
  ['Ships from', 'Portland, OR'],
  ['Ships to', 'Contiguous US (48 states). No P.O. boxes.'],
  ['Dispatch', 'Within 1 business day. Orders by 2 PM PT ship same day.'],
  ['Carriers', 'USPS, UPS'],
  ['Returns', '30 days. You pay return shipping unless the item is faulty or not as described.'],
  ['Warranty', 'Manufacturer warranty honored'],
  ['Replies', 'Usually within 6 hours, Mon–Sat'],
];
