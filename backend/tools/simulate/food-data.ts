/**
 * Sample restaurants for the app's Food delivery department (food module): the categories, four restaurants and their
 * menus from the approved designs (Food home, Napoli Corner, the Margherita pizza page). Written through the Admin
 * Center API, and only what is missing (a category or restaurant with the same slug, a section or item with the same
 * name in its restaurant, is kept as it is), so it is safe to run again. Used by tools/seed-departments.ts. Ratings
 * come only from real reviews (seedFoodReviews); the texts and prices are samples. Pictures are added in the Admin
 * Center. The restaurants sit at real Portland addresses with their map points (a staff pin), so customers with a
 * Portland default address see distances; a restaurant seeded before points existed gets its address and pin once.
 */
import type { AdminCall } from './departments-data.js';

const usd = (dollars: number) => ({ amount: Math.round(dollars * 100), currency: 'USD' });
const slug = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const daily = (from: string, to: string) => ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((weekday) => ({ weekday, open: true, from, to }));

export const FOOD_CATEGORIES = [
  { name: 'Pizza', icon: 'pizza' },
  { name: 'Burgers', icon: 'hamburger' },
  { name: 'Asian', icon: 'soup' },
  { name: 'Salads', icon: 'salad' },
  { name: 'Coffee', icon: 'coffee' },
  { name: 'Desserts', icon: 'cake-slice' },
];

const PIZZA_SIZES = {
  id: 'size',
  name: 'Size',
  required: true,
  min: 1,
  max: 1,
  choices: [
    { id: 'personal', name: '10" personal', priceDelta: usd(-3), default: false, available: true },
    { id: 'regular', name: '12" regular', priceDelta: usd(0), default: true, available: true },
    { id: 'family', name: '16" family', priceDelta: usd(6), default: false, available: true },
  ],
};
const PIZZA_EXTRAS = {
  id: 'extras',
  name: 'Extras',
  required: false,
  min: 0,
  max: 4,
  choices: [
    { id: 'mozzarella', name: 'Extra mozzarella', priceDelta: usd(2.4), default: false, available: true },
    { id: 'basil', name: 'Fresh basil', priceDelta: usd(1.5), default: false, available: true },
    { id: 'olives', name: 'Black olives', priceDelta: usd(1.2), default: false, available: true },
    { id: 'chili', name: 'Chili oil', priceDelta: usd(0.8), default: false, available: true },
  ],
};

type ItemSeed = { name: string; price: number; [k: string]: unknown };
type RestaurantSeed = { name: string; categories: string[]; menu: Record<string, ItemSeed[]>; [k: string]: unknown };

export const RESTAURANTS: RestaurantSeed[] = [
  {
    name: 'Napoli Corner',
    cuisine: 'Pizza · Italian',
    categories: ['Pizza', 'Desserts'],
    address: '1022 NW Glisan St',
    city: 'Portland',
    region: 'OR',
    postalCode: '97209',
    point: { lat: 45.5265, lng: -122.6817 },
    phone: '503-555-0124',
    hours: daily('11:00', '23:00'),
    deliveryMinMinutes: 20,
    deliveryMaxMinutes: 30,
    deliveryFee: usd(1.99),
    freeDeliveryOver: usd(25),
    minOrder: usd(12),
    promoText: 'Free delivery on orders over $25 this week',
    promoBadge: 'Free delivery',
    menu: {
      Pizza: [
        { name: 'Margherita pizza 12"', price: 14.5, description: 'Neapolitan-style dough fermented for 48 hours, San Marzano tomato, fior di latte, fresh basil and extra-virgin olive oil. Baked at 900°F.', tag: 'Most ordered', dietTags: ['Vegetarian'], popular: true, recommended: true, optionGroups: [PIZZA_SIZES, PIZZA_EXTRAS] },
        { name: 'Diavola pizza 12"', price: 17, description: 'Spicy salami, chili flakes, mozzarella, oregano', popular: true, optionGroups: [PIZZA_SIZES, PIZZA_EXTRAS] },
      ],
      Sides: [
        { name: 'Garlic knots (6)', price: 5.5, description: 'Baked to order with parsley butter and parmesan', dietTags: ['Vegetarian'] },
        { name: 'Caesar salad', price: 8.9, description: 'Romaine, croutons, aged parmesan, house dressing' },
      ],
      Drinks: [
        { name: 'Sparkling lemonade', price: 3.5, description: 'Italian limonata, 330 ml can', dietTags: ['Vegan'] },
        { name: 'Cola', price: 2.75, description: '330 ml can' },
        { name: 'Still water', price: 2, description: '500 ml bottle' },
      ],
      Desserts: [{ name: 'Tiramisu', price: 6.5, description: 'Mascarpone, espresso-soaked ladyfingers, cocoa', dietTags: ['Vegetarian'] }],
    },
  },
  {
    name: 'Green Bowl Kitchen',
    cuisine: 'Salads · Healthy',
    categories: ['Salads'],
    address: '410 SW Alder St',
    city: 'Portland',
    region: 'OR',
    postalCode: '97204',
    point: { lat: 45.5196, lng: -122.676 },
    hours: daily('10:00', '21:00'),
    deliveryMinMinutes: 25,
    deliveryMaxMinutes: 35,
    deliveryFee: usd(2.49),
    menu: {
      Bowls: [
        { name: 'Chicken avocado bowl', price: 11.9, wasPrice: usd(14), description: 'Grilled chicken, avocado, brown rice, edamame and sesame dressing', popular: true, recommended: true },
        { name: 'Falafel power bowl', price: 10.5, description: 'Crispy falafel, quinoa, hummus, pickled red onion and tahini', dietTags: ['Vegan'] },
        { name: 'Salmon poke bowl', price: 14.2, description: 'Marinated salmon, sushi rice, cucumber, mango and ponzu' },
      ],
      Drinks: [{ name: 'Green detox juice', price: 5.2, description: 'Kale, apple, cucumber, lemon and ginger, cold-pressed', dietTags: ['Vegan'] }],
    },
  },
  {
    name: 'Tokyo Ramen House',
    cuisine: 'Japanese · Noodles',
    categories: ['Asian'],
    address: '126 NW 4th Ave',
    city: 'Portland',
    region: 'OR',
    postalCode: '97209',
    point: { lat: 45.524, lng: -122.6747 },
    hours: daily('17:00', '23:30'),
    deliveryMinMinutes: 35,
    deliveryMaxMinutes: 45,
    deliveryFee: usd(2.99),
    menu: {
      Ramen: [
        { name: 'Tonkotsu ramen', price: 15.2, description: 'Pork bone broth simmered for 18 hours, chashu, soft egg, nori and scallions', popular: true, recommended: true },
        { name: 'Spicy miso ramen', price: 14.8, description: 'Miso broth with chili oil, ground pork, corn and bean sprouts' },
        { name: 'Shoyu vegetable ramen', price: 13.4, description: 'Soy broth, tofu, bok choy, mushrooms and bamboo shoots', dietTags: ['Vegan'] },
      ],
      Sides: [{ name: 'Pork gyoza (6)', price: 6.9, description: 'Pan-fried dumplings with a soy and vinegar dip' }],
    },
  },
  {
    name: 'Harbor Grill',
    cuisine: 'Burgers · American',
    categories: ['Burgers'],
    address: '1510 SW Harbor Way',
    city: 'Portland',
    region: 'OR',
    postalCode: '97201',
    point: { lat: 45.5098, lng: -122.6745 },
    hours: daily('11:00', '22:00'),
    deliveryMinMinutes: 25,
    deliveryMaxMinutes: 35,
    deliveryFee: usd(1.49),
    menu: {
      Burgers: [
        { name: 'Double smash burger', price: 12.4, description: 'Two smashed beef patties, American cheese, pickles, onions and house sauce', popular: true, recommended: true },
        { name: 'Crispy chicken burger', price: 11.2, description: 'Buttermilk fried chicken, slaw and spicy mayo' },
      ],
      Sides: [
        { name: 'Fries', price: 3.9, description: 'Skin-on fries with sea salt', dietTags: ['Vegan'] },
        { name: 'Chocolate shake', price: 5.6, description: 'Vanilla ice cream blended with dark chocolate' },
      ],
    },
  },
];

export async function seedFood(admin: AdminCall): Promise<Record<string, number>> {
  const added = { categories: 0, restaurants: 0, placed: 0, sections: 0, items: 0 };
  const categories = (await admin('GET', '/admin/food/categories')) as { id: string; slug: string }[];
  const categoryId = new Map(categories.map((c) => [c.slug, c.id]));
  for (const c of FOOD_CATEGORIES) {
    if (categoryId.has(slug(c.name))) continue;
    const row = await admin('POST', '/admin/food/categories', { name: c.name, icon: c.icon });
    categoryId.set(row.slug, row.id);
    added.categories++;
  }
  type Row = { id: string; slug: string; name: string; cuisine: string; deliveryMinMinutes: number; deliveryMaxMinutes: number; deliveryFee: unknown; pointSource?: string | null };
  const restaurants = (await admin('GET', '/admin/food/restaurants?limit=100')) as { items: Row[] };
  const existingRows = new Map(restaurants.items.map((r) => [r.slug, r]));
  for (const [i, r] of RESTAURANTS.entries()) {
    const { menu, categories: cats, ...fields } = r;
    const before = existingRows.get(slug(r.name));
    let id = before?.id;
    // seeded before restaurant points: the real address and its pin (a pin staff set is kept)
    if (before && before.pointSource !== 'staff') {
      const { name, cuisine, deliveryMinMinutes, deliveryMaxMinutes, deliveryFee } = before;
      await admin('PATCH', `/admin/food/restaurants/${before.id}`, { name, cuisine, deliveryMinMinutes, deliveryMaxMinutes, deliveryFee, address: r.address, city: r.city, region: r.region, postalCode: r.postalCode, point: r.point });
      added.placed++;
    }
    if (!id) {
      const row = await admin('POST', '/admin/food/restaurants', { ...fields, categoryIds: cats.map((c) => categoryId.get(slug(c))).filter(Boolean), status: 'published', position: i + 1 });
      id = row.id as string;
      added.restaurants++;
    }
    const existing = (await admin('GET', `/admin/food/restaurants/${id}/menu`)) as { id: string; name: string; items: { name: string }[] }[];
    const sectionId = new Map(existing.map((s) => [s.name, s.id]));
    const itemNames = new Set(existing.flatMap((s) => s.items.map((x) => x.name)));
    for (const [name, items] of Object.entries(menu)) {
      let sid = sectionId.get(name);
      if (!sid) {
        sid = (await admin('POST', `/admin/food/restaurants/${id}/sections`, { name })).id as string;
        sectionId.set(name, sid);
        added.sections++;
      }
      for (const it of items) {
        if (itemNames.has(it.name)) continue;
        await admin('POST', `/admin/food/restaurants/${id}/items`, { ...it, sectionId: sid, price: usd(it.price) });
        added.items++;
      }
    }
  }
  return added;
}

/* ---------------------------------------------------------------- reviews */

/** One HTTP call to the running server: full path (/api/…), optional bearer token and extra headers */
export type ApiRequest = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, token?: string, headers?: Record<string, string>) => Promise<any>;

/** Sample customers who rate the restaurants; their default addresses are real Portland addresses (they see distances) */
export const FOOD_REVIEWERS = [
  { firstName: 'Maya', lastName: 'Reyes', email: 'maya.reyes.food@example.com', address: { line1: '1120 SW 5th Ave', postalCode: '97204' } },
  { firstName: 'Owen', lastName: 'Park', email: 'owen.park.food@example.com', address: { line1: '2045 NE Broadway', postalCode: '97232' } },
  { firstName: 'Lena', lastName: 'Fox', email: 'lena.fox.food@example.com', address: { line1: '3530 SE Hawthorne Blvd', postalCode: '97214' } },
];
const REVIEWER_PASSWORD = 'Tasty-Crust-4471Q';

/** Who rates which restaurant, what they ordered (item name and quantity) and what they wrote */
export const FOOD_REVIEWS: { restaurant: string; by: string; order: [string, number][]; stars: number; text?: string }[] = [
  { restaurant: 'Napoli Corner', by: 'Maya', order: [['Margherita pizza 12"', 2]], stars: 5, text: 'Best crust in town, and still hot when it arrived.' },
  { restaurant: 'Napoli Corner', by: 'Owen', order: [['Diavola pizza 12"', 1], ['Garlic knots (6)', 1]], stars: 4, text: 'Great Diavola. The garlic knots were a little soft.' },
  { restaurant: 'Napoli Corner', by: 'Lena', order: [['Margherita pizza 12"', 1], ['Tiramisu', 1]], stars: 5 },
  { restaurant: 'Green Bowl Kitchen', by: 'Owen', order: [['Chicken avocado bowl', 1]], stars: 5, text: 'Fresh and generous. My lunch go-to now.' },
  { restaurant: 'Green Bowl Kitchen', by: 'Lena', order: [['Falafel power bowl', 1], ['Green detox juice', 1]], stars: 4, text: 'Tasty falafel bowl; dressing on the side would be nice.' },
  { restaurant: 'Tokyo Ramen House', by: 'Maya', order: [['Tonkotsu ramen', 1], ['Pork gyoza (6)', 1]], stars: 5, text: 'Rich broth, perfect egg.' },
  { restaurant: 'Tokyo Ramen House', by: 'Lena', order: [['Spicy miso ramen', 1]], stars: 3, text: 'Good flavour, but the noodles were soft by the time it got here.' },
  { restaurant: 'Harbor Grill', by: 'Owen', order: [['Double smash burger', 1], ['Fries', 1]], stars: 4, text: 'Solid smash burger, crispy fries.' },
  { restaurant: 'Harbor Grill', by: 'Maya', order: [['Crispy chicken burger', 1], ['Chocolate shake', 1]], stars: 5 },
];

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type AddressRow = { id: string; address: { line1: string } };

/**
 * A few real reviews through the flows the app and the Admin Center use: each sample customer registers (the code
 * from the development outbox; DEV_TOKENS must be on) or signs in, saves a Portland default address, orders from the
 * restaurant with the development test card (tok_visa), staff accept, send and deliver the order (food.orders.manage),
 * and the customer rates it. A restaurant that already has reviews is skipped, so it is safe to run again. Ordering
 * needs the restaurant open: a closed one is skipped and reported (run again during its hours).
 */
export async function seedFoodReviews(admin: AdminCall, api: ApiRequest, storeApp: () => Promise<string>): Promise<{ reviews: number; skipped: string[] }> {
  const out = { reviews: 0, skipped: [] as string[] };
  const restaurants = ((await admin('GET', '/admin/food/restaurants?limit=100')) as { items: { id: string; slug: string; name: string }[] }).items;
  const todo = [];
  for (const r of restaurants) {
    if (!FOOD_REVIEWS.some((v) => v.restaurant === r.name)) continue;
    const existing = (await admin('GET', `/admin/food/reviews?restaurantId=${r.id}&limit=1`)) as { items: unknown[] };
    if (!existing.items.length) todo.push(r);
  }
  if (!todo.length) return out;

  const signedIn = new Map<string, { token: string; addressId: string }>();
  const customer = async (first: string) => {
    const known = signedIn.get(first);
    if (known) return known;
    const p = FOOD_REVIEWERS.find((x) => x.firstName === first)!;
    const app = await storeApp();
    const device = { kind: 'web' };
    let token: string | undefined;
    try {
      const session = await api('POST', '/api/public/identity/sessions', { email: p.email, password: REVIEWER_PASSWORD, audience: 'store', keepSignedIn: false, device }, app);
      if (session.status === 'signed_in') token = session.tokens.accessToken;
    } catch {
      // not registered yet
    }
    if (!token) {
      const since = new Date(Date.now() - 1000).toISOString();
      const reg = await api('POST', '/api/public/identity/registrations', { email: p.email, password: REVIEWER_PASSWORD, firstName: p.firstName, lastName: p.lastName, marketingOptIn: false, acceptedTermsVersion: '2026-01', device }, app);
      let code: string | undefined;
      // the code arrives with the next notifications dispatch
      for (let i = 0; i < 45 && !code; i++) {
        const box = (await api('GET', `/api/dev/notifications/outbox?to=${encodeURIComponent(p.email)}&channel=email&since=${encodeURIComponent(since)}`, undefined, app)) as { items: { subject: string | null; text: string }[] };
        code = box.items.map((m) => `${m.subject ?? ''}\n${m.text}`.match(/\b(\d{6})\b/)?.[1]).find(Boolean);
        if (!code) await pause(2000);
      }
      if (!code) throw new Error(`no verification code reached ${p.email}`);
      const done = await api('POST', `/api/public/identity/verifications/${reg.id}/confirm`, { code, keepSignedIn: false, device }, app);
      token = done.tokens.accessToken as string;
    }
    const listed = (await api('GET', '/api/store/customers/addresses', undefined, token)) as AddressRow[] | { items: AddressRow[] };
    const addresses = Array.isArray(listed) ? listed : listed.items;
    let addressId = addresses.find((a) => a.address.line1 === p.address.line1)?.id;
    if (!addressId) {
      const address = { name: `${p.firstName} ${p.lastName}`, line1: p.address.line1, city: 'Portland', region: 'OR', postalCode: p.address.postalCode, country: 'US', phone: '503-555-0188' };
      addressId = (await api('POST', '/api/store/customers/addresses', { label: 'Home', address, makeDefault: true }, token)).id as string;
    }
    const me = { token: token!, addressId: addressId! };
    signedIn.set(first, me);
    return me;
  };

  for (const r of todo) {
    const menu = (await api('GET', `/api/store/food/restaurants/${r.slug}`, undefined, await storeApp())) as { open: boolean; sections: { items: { id: string; name: string; hasOptions: boolean }[] }[] };
    if (!menu.open) {
      out.skipped.push(`${r.name} (closed now)`);
      continue;
    }
    const items = new Map(menu.sections.flatMap((s) => s.items).map((i) => [i.name, i]));
    for (const v of FOOD_REVIEWS.filter((x) => x.restaurant === r.name)) {
      try {
        const me = await customer(v.by);
        await api('DELETE', '/api/store/food/basket', undefined, me.token);
        let basket: any;
        for (const [name, quantity] of v.order) {
          const it = items.get(name);
          if (!it) throw new Error(`${name} is not on the menu`);
          // required options (pizza sizes) take their default choice
          const groups = it.hasOptions ? ((await api('GET', `/api/store/food/items/${it.id}`, undefined, me.token)).optionGroups as { id: string; required: boolean; choices: { id: string; default: boolean }[] }[]) : [];
          const options = groups.filter((g) => g.required).map((g) => ({ groupId: g.id, choiceIds: [(g.choices.find((c) => c.default) ?? g.choices[0])!.id] }));
          basket = await api('POST', '/api/store/food/basket/lines', { itemId: it.id, quantity, options, replace: true }, me.token);
        }
        if (!basket?.canOrder) throw new Error(`the basket can't be ordered: ${(basket?.problems ?? []).join('; ')}`);
        const order = await api('POST', '/api/store/food/orders', { addressId: me.addressId, expectedTotal: basket.total, method: { kind: 'new_card', providerToken: 'tok_visa' }, returnUrl: 'https://marketly.example/food/return' }, me.token, { 'idempotency-key': crypto.randomUUID() });
        if (order.status !== 'placed') throw new Error(`order ${order.ref} is ${order.status}`);
        for (const action of ['accept', 'send', 'deliver']) await admin('POST', `/admin/food/orders/${order.id}/status`, { action });
        await api('POST', `/api/store/food/orders/${order.id}/review`, { stars: v.stars, ...(v.text ? { text: v.text } : {}) }, me.token);
        out.reviews++;
      } catch (err) {
        out.skipped.push(`${r.name} by ${v.by}: ${(err as Error).message.slice(0, 200)}`);
      }
    }
  }
  return out;
}
