/**
 * Sample restaurants for the app's Food delivery department (food module): the categories, four restaurants and their
 * menus from the approved designs (Food home, Napoli Corner, the Margherita pizza page). Written through the Admin
 * Center API, and only what is missing (a category or restaurant with the same slug, a section or item with the same
 * name in its restaurant, is kept as it is), so it is safe to run again. Used by tools/seed-departments.ts. Ratings
 * come only from real reviews; the texts and prices are samples. Pictures are added in the Admin Center.
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
    address: '118 Bay Rd',
    city: 'Portland, OR',
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
    address: '410 Alder St',
    city: 'Portland, OR',
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
    address: '27 Couch St',
    city: 'Portland, OR',
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
    address: '9 Harbor Way',
    city: 'Portland, OR',
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
  const added = { categories: 0, restaurants: 0, sections: 0, items: 0 };
  const categories = (await admin('GET', '/admin/food/categories')) as { id: string; slug: string }[];
  const categoryId = new Map(categories.map((c) => [c.slug, c.id]));
  for (const c of FOOD_CATEGORIES) {
    if (categoryId.has(slug(c.name))) continue;
    const row = await admin('POST', '/admin/food/categories', { name: c.name, icon: c.icon });
    categoryId.set(row.slug, row.id);
    added.categories++;
  }
  const restaurants = (await admin('GET', '/admin/food/restaurants?limit=100')) as { items: { id: string; slug: string }[] };
  const restaurantId = new Map(restaurants.items.map((r) => [r.slug, r.id]));
  for (const [i, r] of RESTAURANTS.entries()) {
    const { menu, categories: cats, ...fields } = r;
    let id = restaurantId.get(slug(r.name));
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
