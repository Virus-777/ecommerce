// Search sample data: the design's query, its result page, suggestions and recent searches.
import { products } from '@/data/fixtures';
import { DEFAULT_FILTERS, type Filters } from './listing-filters';
import { HEADPHONES, type Listing } from './category';

/** The query the design shows, its misspelled original and the server's result count. */
export const DESIGN_QUERY = 'wireless headphones';
export const DESIGN_TYPED = 'wirless headfones';
export const DESIGN_TOTAL = 86;
export const DESIGN_PAGES = 8;
/** What the shopper had typed in the "suggestions open" view. */
export const DESIGN_PARTIAL = 'wireless h';

/** Filters the design's result page was loaded with. */
export const DESIGN_FILTERS: Filters = { ...DEFAULT_FILTERS, min: '50', max: '250', rating: '4', free: true };

const byId = (id: string) => HEADPHONES.find((h) => h.id === id)!;

export const SPONSORED: Listing[] = ['lumen-q3', 'aurora-buds', 'wave-pro', 'aria'].map(byId);
export const DESIGN_RESULTS: Listing[] = ['aurora', 'wave', 'aria', 'lumen-q1', 'wave-pro', 'aurora-buds', 'air', 'lumen-q3', 'stride', 'kids', 'loop', 'studio2'].map(byId);

/** Everything searchable in the mock: the headphone listings plus the shared catalogue sample. */
export const SEARCH_POOL: Listing[] = [
  ...HEADPHONES,
  ...products
    .filter((p) => !HEADPHONES.some((h) => h.id === p.id))
    .map<Listing>((p) => ({
      id: p.id, name: p.name, brand: p.brand, price: p.price, was: p.was, rating: p.rating, reviews: p.reviews, icon: p.icon, tint: p.tint,
      seller: p.seller, offers: p.offers, delivery: p.delivery, free: p.free, group: p.sub,
      condition: 'new', type: 'over', anc: 'none', battery: 0, connection: [], inStock: p.stock > 0, shipsToday: p.seller === 'official', byFri: true, age: 30,
    })),
];

export const SEARCH_CATS = [
  { name: 'Headphones', n: 64 },
  { name: 'Earbuds', n: 18 },
  { name: 'Speakers', n: 4 },
];

/** Query completions, most popular first. */
export const SUGGESTIONS = [
  'wireless headphones', 'wireless headphones noise cancelling', 'wireless headphones for running', 'wireless headphones under $100', 'wireless earbuds',
  'wireless charger', 'wireless keyboard', 'halden aurora', 'halden speaker', 'cast iron skillet', 'usb-c monitor 27', 'merino sweater', 'linen duvet cover',
  'portable ssd', 'yoga mat', 'hiking backpack', 'pour-over coffee set', 'robot vacuum', 'vitamin c serum', 'trail running shoes', 'insulated bottle', 'desk lamp',
];

export const RECENT_SEARCHES = ['cast iron skillet', 'usb-c monitor 27', 'merino sweater', 'halden speaker'];
