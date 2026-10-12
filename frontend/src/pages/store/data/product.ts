// Sample data for the product detail page (design: pages/store/store-product*.html).
// Two products: the Halden Aurora (reviews, several offers) and the Brightline desk lamp
// (new listing with no reviews, one offer: the "no-reviews-yet" view).
import { auroraOffers, P, type Offer, type SellerId, type Tint } from '@marketly/web-shared/data/fixtures';
import { money } from '@marketly/web-shared/lib/format';
import type { CardProduct, IconName } from '@marketly/web-shared/ui';

export interface Variant {
  name: string;
  tint: Tint;
  icon: IconName;
  /** Price/stock line under the swatch. */
  sub: string;
}

export interface Thumb {
  label: string;
  icon: IconName;
  /** Video length ("0:42"): the thumb plays a video. */
  video?: string;
  /** Fixed tint (video poster); photos follow the selected variant. */
  tint?: Tint;
}

export interface Review {
  id: string;
  name: string;
  verified: boolean;
  rating: number;
  title: string;
  date: string;
  color: string;
  soldBy: string;
  body: string;
  helpful: number;
  photos: boolean;
  reply?: { from: string; date: string; body: string };
}

export interface QaAnswer {
  role: 'staff' | 'seller' | 'customer';
  who: string;
  date: string;
  body: string;
}

export interface Question {
  q: string;
  answers: QaAnswer[];
  /** Shown instead of answers while the question is unanswered. */
  pending?: string;
}

/** One seller's offer as shown in the buy box. */
export interface BuyOffer {
  seller: SellerId;
  price: number;
  was?: number | null;
  ship: number;
  /** Sale copy under the price (featured sale offer). */
  saleEnds?: string;
  wasNote?: string;
  /** Show "+ $x shipping · $total before tax" under the price. */
  shippingNote?: boolean;
  stock: { tone: 'success' | 'warning'; label: string; available: number; condition: string };
  delivery: string;
  deliveryNote?: string;
  shipsFrom: string;
  carrier: string;
  /** Append " · Free" / " · $6.99" to the ships-from line. */
  showShipCost?: boolean;
  ratingsSuffix?: string;
  returns: string;
  warranty: string;
  limit: number;
  visit: string;
  /** Second line in the phone action bar. */
  barNote: string;
}

export interface ProductDetail {
  id: string;
  /** Id prefix used by the design for this product's headings and fields. */
  px: 'pdp' | 'pdl';
  appbarTitle: string;
  crumbs: { cat: string; sub: string; name: string };
  brand: string;
  name: string;
  thumbsLabel: string;
  thumbs: Thumb[];
  photosTotal: number;
  rating: number;
  ratings: number;
  written: number;
  questions: number;
  rank?: { badge: string; note: string };
  listed?: string;
  variants: Variant[];
  features: string[];
  about: string;
  inBox: string[];
  specs: Array<[string, string]>;
  offers: BuyOffer[];
  /** All marketplace offers for this item (the Offers page). Empty when the buy-box offer is the only one. */
  market: Offer[];
  ratingBars: Array<[number, number]>;
  reviews: Review[];
  questionList: Question[];
  qaPlaceholder: string;
  qaOrderNote: boolean;
  relatedMore: string;
  related: CardProduct[];
  sponsored: CardProduct[];
}

const official = auroraOffers.find((o) => o.seller === 'official')!;
const northwind = auroraOffers.find((o) => o.seller === 'northwind')!;

export const aurora: ProductDetail = {
  id: 'aurora',
  px: 'pdp',
  appbarTitle: 'Halden Aurora',
  crumbs: { cat: 'Electronics', sub: 'Headphones', name: 'Halden Aurora' },
  brand: P.aurora.brand,
  name: P.aurora.name,
  thumbsLabel: 'Photos and video',
  thumbs: [
    { label: 'Play product video, 42 seconds', icon: 'headphones', video: '0:42', tint: '6' },
    { label: 'Photo 1', icon: 'headphones' },
    { label: 'Photo 2', icon: 'headphones' },
    { label: 'Photo 3', icon: 'briefcase' },
    { label: 'Photo 4', icon: 'battery-charging' },
    { label: 'Photo 5', icon: 'bluetooth' },
  ],
  photosTotal: 7,
  rating: P.aurora.rating,
  ratings: P.aurora.reviews,
  written: 412,
  questions: 38,
  rank: { badge: '#3 in Headphones', note: 'Ranked by units sold in the last 30 days' },
  variants: [
    { name: 'Midnight black', tint: '2', icon: 'headphones', sub: '$189.00 · In stock' },
    { name: 'Stone', tint: '5', icon: 'headphones', sub: '2 offers from $184.00' },
    { name: 'Sage', tint: '1', icon: 'headphones', sub: '$199.00 · In stock' },
  ],
  features: [
    'Hybrid active noise cancelling with 6 microphones and an adjustable transparency mode',
    'Up to 40 hours with ANC on, 55 hours off. 10 minutes of charging gives 5 hours',
    'Bluetooth 5.3 multipoint: stay connected to a phone and a laptop at once',
    'Folds flat into the included hard travel case',
    'Wired listening with the 3.5 mm cable when the battery is empty',
  ],
  about:
    'Aurora is Halden’s full-size travel headphone. It blocks steady noise like engines and air conditioning, and the transparency mode lets announcements through without taking the headphones off. Controls are physical buttons, so they work with gloves.',
  inBox: ['Aurora headphones', 'Hard travel case', 'USB-C to USB-C cable, 1 m', '3.5 mm audio cable, 1.2 m', 'Airplane adapter', 'Quick start guide'],
  specs: [
    ['Brand', 'Halden'],
    ['Model', 'Aurora (2026), HA-AUR26'],
    ['SKU', P.aurora.sku],
    ['Type', 'Over-ear, closed back'],
    ['Noise cancelling', 'Active, hybrid (6 microphones)'],
    ['Battery', '40 h ANC on · 55 h ANC off'],
    ['Charging', 'USB-C, 2 h full charge'],
    ['Bluetooth', '5.3, multipoint (2 devices)'],
    ['Codecs', 'SBC, AAC, LDAC'],
    ['Wired', '3.5 mm (cable included)'],
    ['Weight', '254 g (9 oz)'],
    ['Warranty', '2-year manufacturer warranty, US'],
  ],
  offers: [
    {
      seller: 'official',
      price: official.price,
      was: P.aurora.was,
      ship: official.ship,
      saleEnds: 'Sale ends Oct 19, 11:59 PM PT',
      wasNote: 'Was price is the Official Store’s lowest price in the 30 days before the sale.',
      stock: { tone: 'success', label: official.stock, available: P.aurora.stock, condition: official.condition },
      delivery: `Free delivery ${official.delivery}`,
      deliveryNote: 'Order within 4 h 12 min for this date',
      shipsFrom: 'Reno, NV',
      carrier: 'UPS Ground',
      showShipCost: true,
      returns: official.returns,
      warranty: official.warranty,
      limit: 3,
      visit: 'Visit the seller’s store',
      barNote: 'Free delivery Oct 15',
    },
    {
      seller: 'northwind',
      price: northwind.price,
      ship: northwind.ship,
      shippingNote: true,
      stock: { tone: 'success', label: northwind.stock, available: 23, condition: northwind.condition },
      delivery: 'Arrives Fri, Oct 16 – Mon, Oct 19',
      shipsFrom: 'Portland, OR',
      carrier: 'USPS Ground Advantage',
      showShipCost: true,
      returns: '30-day returns. You pay return shipping (about $8.50) unless the item is faulty.',
      warranty: northwind.warranty,
      limit: 3,
      visit: 'Visit Northwind Audio’s store',
      barNote: `+ ${money(northwind.ship)} shipping`,
    },
  ],
  market: auroraOffers,
  ratingBars: [
    [5, 72],
    [4, 17],
    [3, 6],
    [2, 2],
    [1, 3],
  ],
  reviews: [
    {
      id: 'r1',
      name: 'Mara D.',
      verified: true,
      rating: 5,
      title: 'Quiet enough for a six-hour flight',
      date: 'Oct 2, 2026',
      color: 'Midnight black',
      soldBy: 'Marketly Official',
      body: 'Wore them PDX to JFK and back. The engine noise drops to a low hum, and I still had 60% battery at the end. Clamping is firm for the first week.',
      helpful: 48,
      photos: false,
    },
    {
      id: 'r2',
      name: 'Devon P.',
      verified: true,
      rating: 4,
      title: 'Great noise cancelling, bulky case',
      date: 'Sep 27, 2026',
      color: 'Stone',
      soldBy: 'Northwind Audio',
      body: 'Sound and ANC are excellent for the price. The case takes up half my backpack. Multipoint between my phone and work laptop works without re-pairing.',
      helpful: 21,
      photos: false,
    },
    {
      id: 'r3',
      name: 'Ines K.',
      verified: true,
      rating: 2,
      title: 'Left ear cup crackles at high volume',
      date: 'Sep 19, 2026',
      color: 'Midnight black',
      soldBy: 'Marketly Official',
      body: 'Started after two weeks. Only above 80% volume. Otherwise comfortable.',
      helpful: 9,
      photos: false,
      reply: {
        from: 'Marketly Official Store',
        date: 'Sep 20, 2026',
        body: 'Sorry about this. This is covered by the 2-year warranty and by our 30-day return window. Start a return from your order and choose “Item is faulty” for a free replacement.',
      },
    },
  ],
  questionList: [
    {
      q: 'Can I connect it to my phone and laptop at the same time?',
      answers: [{ role: 'staff', who: 'Marketly Product Support', date: 'Oct 1, 2026', body: 'Yes. Aurora supports Bluetooth multipoint with two devices. Audio switches to whichever device starts playing.' }],
    },
    {
      q: 'Is the Northwind Audio offer a US unit with the US warranty?',
      answers: [{ role: 'seller', who: 'Northwind Audio', date: 'Sep 29, 2026', body: 'Yes. We sell US retail units bought from Halden’s US distributor. The 2-year warranty is registered in your name with Halden US.' }],
    },
    {
      q: 'Can the ear cushions be replaced?',
      answers: [
        { role: 'customer', who: 'Priya K.', date: 'Sep 22, 2026', body: 'Yes, they clip off. I bought a replacement pair from Halden for $24.' },
        { role: 'staff', who: 'Marketly Product Support', date: 'Sep 23, 2026', body: 'Replacement cushions (HAL-AUR-CUSH) are sold by the Official Store.' },
      ],
    },
  ],
  qaPlaceholder: 'Search 38 questions and answers',
  qaOrderNote: true,
  relatedMore: 'More headphones',
  related: [
    { name: 'Halden Aurora Buds ANC Earbuds', price: 139, was: 169, rating: 4.5, reviews: 912, icon: 'ear', tint: '2', seller: 'official', offers: 2, delivery: 'Thu, Oct 15', free: true },
    { name: 'Halden Studio 2 Wired Monitor Headphones', price: 149, rating: 4.7, reviews: 356, icon: 'headphones', tint: '5', seller: 'official', offers: 2, delivery: 'Thu, Oct 15', free: true },
    { name: 'Halden Aurora Hard Travel Case', price: 29, rating: 4.6, reviews: 188, icon: 'briefcase', tint: '5', seller: 'official', offers: 1, delivery: 'Wed, Oct 14', free: false },
    { name: 'Kestrel Wave Over-ear Bluetooth Headphones', price: 79, rating: 4.2, reviews: 1032, icon: 'headphones', tint: '6', seller: 'pixelport', offers: 3, delivery: 'Fri, Oct 16', free: true },
    { name: 'Halden Pocket Mini Bluetooth Speaker', price: 39, rating: 4.3, reviews: 410, icon: 'speaker', tint: '2', seller: 'northwind', offers: 2, delivery: 'Thu, Oct 15', free: true },
  ],
  sponsored: [
    { name: 'Lumen Q3 Noise Cancelling Headphones', price: 159, rating: 4.3, reviews: 421, icon: 'headphones', tint: '3', seller: 'pixelport', offers: 2, delivery: 'Fri, Oct 16', free: true },
    { name: 'Kestrel Wave Pro ANC Headphones', price: 129, was: 149, rating: 4.3, reviews: 577, icon: 'headphones', tint: '6', seller: 'pixelport', offers: 2, delivery: 'Fri, Oct 16', free: true },
    { name: 'Halden Aria True Wireless Earbuds', price: 99, was: 129, rating: 4.4, reviews: 688, icon: 'ear', tint: '2', seller: 'northwind', offers: 2, delivery: 'Fri, Oct 16', free: true },
    { name: 'Lumen Q1 On-ear Wireless Headphones', price: 69, rating: 4.0, reviews: 265, icon: 'headphones', tint: '3', seller: 'northwind', offers: 2, delivery: 'Fri, Oct 16', free: true },
    { name: 'Halden Air Open-ear Sport Headphones', price: 119, rating: 4.2, reviews: 204, icon: 'ear', tint: '1', seller: 'northwind', offers: 1, delivery: 'Fri, Oct 16', free: true },
  ],
};

export const lamp: ProductDetail = {
  id: 'lamp',
  px: 'pdl',
  appbarTitle: 'Desk lamp',
  crumbs: { cat: 'Home & Kitchen', sub: 'Lighting', name: 'Brightline Smart LED Desk Lamp' },
  brand: P.lamp.brand,
  name: P.lamp.name,
  thumbsLabel: 'Photos',
  thumbs: [
    { label: 'Photo 1', icon: 'lamp-desk' },
    { label: 'Photo 2', icon: 'lamp-desk' },
    { label: 'Photo 3', icon: 'smartphone' },
    { label: 'Photo 4', icon: 'sun-dim' },
    { label: 'Photo 5', icon: 'plug' },
  ],
  photosTotal: 5,
  rating: 0,
  ratings: 0,
  written: 0,
  questions: 1,
  listed: 'Listed on Marketly Oct 6, 2026',
  variants: [
    { name: 'White', tint: '5', icon: 'lamp-desk', sub: '$42.00 · 9 left' },
    { name: 'Charcoal', tint: '6', icon: 'lamp-desk', sub: '$42.00 · In stock' },
  ],
  features: [
    'Built-in 15 W Qi wireless charger in the base',
    'Five color temperatures from 2700 K to 6500 K, stepless dimming',
    'App and voice control with a manual touch strip that works offline',
    'Folding arm and head reach 45 cm over the desk from a 14 cm base',
    'Auto-off timer and a night mode at 3% brightness',
  ],
  about:
    'A compact desk lamp that charges your phone in its base. The touch strip on the arm controls brightness and color without the app, so it still works if your Wi-Fi is down.',
  inBox: ['Lamp with charging base', '24 W USB-C power adapter', 'USB-C cable, 1.5 m', 'Quick start guide'],
  specs: [
    ['Brand', 'Brightline'],
    ['Model', 'Smart Desk Lamp W1'],
    ['SKU', P.lamp.sku],
    ['Light', '8 W LED, 520 lumens, CRI 90+'],
    ['Color temperature', '2700–6500 K'],
    ['Charging pad', 'Qi, up to 15 W'],
    ['Connectivity', 'Wi-Fi 2.4 GHz, Bluetooth for setup'],
    ['Power', '24 W USB-C adapter (included)'],
    ['Size', 'Base 14 cm, arm reach 45 cm'],
    ['Warranty', '2 years, handled by the Official Store'],
  ],
  offers: [
    {
      seller: 'official',
      price: P.lamp.price,
      ship: 0,
      stock: { tone: 'warning', label: 'Low stock', available: P.lamp.stock, condition: 'New' },
      delivery: `Free delivery ${P.lamp.delivery}`,
      deliveryNote: 'Free on Official Store orders over $35',
      shipsFrom: 'Reno, NV',
      carrier: 'UPS Ground',
      ratingsSuffix: ' for this seller',
      returns: '30-day free returns',
      warranty: '2-year warranty on electronics, handled by Marketly',
      limit: 2,
      visit: 'Visit the Official Store',
      barNote: 'Free delivery Oct 14',
    },
  ],
  market: [],
  ratingBars: [],
  reviews: [],
  questionList: [
    {
      q: 'Will the charging pad work through a phone case?',
      answers: [{ role: 'staff', who: 'Marketly Product Support', date: 'Oct 7, 2026', body: 'Yes, through cases up to 5 mm thick without metal or magnets.' }],
    },
    {
      q: 'Does it need the app to change brightness?',
      answers: [],
      pending: 'Not answered yet. Asked Oct 8, 2026. The Official Store usually answers within 1 business day.',
    },
  ],
  qaPlaceholder: 'Search questions and answers',
  qaOrderNote: false,
  relatedMore: 'More lighting',
  related: [
    { name: 'Brightline Arc Floor Lamp, Dimmable', price: 89, was: 119, rating: 4.4, reviews: 233, icon: 'lamp-floor', tint: '5', seller: 'official', offers: 1, delivery: 'Thu, Oct 15', free: true },
    { name: 'Brightline Warm White String Lights, 10 m', price: 19, was: 26, rating: 4.3, reviews: 852, icon: 'lightbulb', tint: '5', seller: 'official', offers: 1, delivery: 'Wed, Oct 14', free: false },
    P.keyboard,
    P.kestrel27,
    P.pourover,
  ],
  sponsored: [
    P.ssd1tb,
    { name: 'Northwind Studio Cable Kit, 3.5 mm to USB-C', price: 24, rating: 4.5, reviews: 96, icon: 'cable', tint: '2', seller: 'northwind', offers: 1, delivery: 'Fri, Oct 16', free: false },
    { name: 'Mosswood Gooseneck Pour-over Kettle', price: 48, was: 60, rating: 4.5, reviews: 377, icon: 'coffee', tint: '3', seller: 'casaverde', offers: 1, delivery: 'Mon, Oct 19', free: true },
    { name: 'Mosswood Percale Sheet Set, Queen', price: 79, was: 99, rating: 4.6, reviews: 640, icon: 'bed-double', tint: '1', seller: 'casaverde', offers: 2, delivery: 'Mon, Oct 19', free: true },
    P.speaker,
  ],
};
