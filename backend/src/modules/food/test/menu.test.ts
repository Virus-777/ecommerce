import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { item, pizzeria, regular, restaurant, section } from './fixtures.js';
import { boot, EXTRAS_GROUP, newId, SIZE_GROUP, START, usd, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

describe('categories', () => {
  it('keeps slugs unique, shows visible ones with their restaurant counts, and takes a deleted one off restaurants', async () => {
    const pizza = await k.admin('POST', '/categories', { name: 'Pizza', icon: 'pizza' });
    expect(pizza.status).toBe(201);
    expect(pizza.body).toMatchObject({ slug: 'pizza', icon: 'pizza', visible: true, restaurantCount: 0 });
    expect((await k.admin('POST', '/categories', { name: 'PIZZA' })).body.error.code).toBe('SLUG_TAKEN');
    expect((await k.admin('POST', '/categories', { name: 'Bad icon', icon: 'Not An Icon' })).body.error.details.issues[0].path).toBe('icon');
    const hidden = (await k.admin('POST', '/categories', { name: 'Hidden', visible: false })).body;
    const r = await restaurant(k, { categoryIds: [pizza.body.id, hidden.id] });
    await restaurant(k, { categoryIds: [pizza.body.id], status: 'draft' });

    const store = (await k.store('GET', '/categories')).body;
    expect(store.find((c: any) => c.slug === 'pizza')).toMatchObject({ restaurantCount: 1 });
    expect(store.some((c: any) => c.slug === 'hidden')).toBe(false);
    expect((await k.store('GET', '/restaurants?category=pizza')).body.items.map((x: any) => x.id)).toEqual([r.id]);

    expect((await k.admin('DELETE', `/categories/${pizza.body.id}`)).status).toBe(204);
    expect((await k.admin('GET', `/restaurants/${r.id}`)).body.categoryIds).toEqual([hidden.id]);
    expect(k.audits.map((a) => a.action)).toEqual(expect.arrayContaining(['food.category.create', 'food.category.delete']));
  });
});

describe('restaurants', () => {
  it('validates input and refuses a taken slug', async () => {
    const base = { name: 'Valid', cuisine: 'Pizza', deliveryMinMinutes: 20, deliveryMaxMinutes: 30, deliveryFee: usd(199) };
    expect((await k.admin('POST', '/restaurants', { ...base, deliveryMaxMinutes: 10 })).body.error.details.issues[0].path).toBe('deliveryMaxMinutes');
    expect((await k.admin('POST', '/restaurants', { ...base, hours: [{ weekday: 'mon', open: true, from: '25:00', to: '22:00' }] })).body.error.details.issues[0].path).toBe('hours[0].from');
    expect((await k.admin('POST', '/restaurants', { ...base, timeZone: 'Mars/Base' })).body.error.details.issues[0].path).toBe('timeZone');
    expect((await k.admin('POST', '/restaurants', { ...base, categoryIds: [newId()] })).body.error.details.issues[0].path).toBe('categoryIds[0]');
    const ok = await k.admin('POST', '/restaurants', base);
    expect(ok.status).toBe(201);
    // a new restaurant starts as a draft with every day 11:00–22:00 in the market zone
    expect(ok.body).toMatchObject({ slug: 'valid', status: 'draft', timeZone: 'America/Los_Angeles', ratings: { average: null, count: 0, stars: [0, 0, 0, 0, 0] }, itemCount: 0, openOrders: 0 });
    expect(ok.body.hours).toHaveLength(7);
    expect(ok.body.hours[0]).toEqual({ weekday: 'mon', open: true, from: '11:00', to: '22:00' });
    expect((await k.admin('POST', '/restaurants', base)).body.error.code).toBe('SLUG_TAKEN');
    expect((await k.store('GET', '/restaurants/valid')).status).toBe(404);
  });

  it('lists published restaurants open ones first, with card labels; paused ones read as closed', async () => {
    const tag = `cards${newId().slice(-6)}`;
    const evening = await restaurant(k, { name: `Evening ${tag}`, hours: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((weekday) => ({ weekday, open: true, from: '17:00', to: '23:00' })), position: 1 });
    const free = await restaurant(k, { name: `Free ${tag}`, deliveryFee: usd(0), promoBadge: 'Free delivery', promoText: 'Free delivery on orders over $25 this week', freeDeliveryOver: usd(2500), minOrder: usd(1200), city: 'Portland, OR', position: 2 });
    const paused = await restaurant(k, { name: `Paused ${tag}`, status: 'paused', position: 3 });
    const list = (await k.store('GET', `/restaurants?q=${tag}`)).body.items;
    expect(list.map((r: any) => r.id)).toEqual([free.id, evening.id, paused.id]);
    expect(list[0]).toMatchObject({ deliveryLabel: '20–30 min', feeLabel: 'Free delivery', promoBadge: 'Free delivery', open: true, openLabel: 'Open until 11 PM', city: 'Portland, OR', rating: null, ratingCount: 0 });
    expect(list[1]).toMatchObject({ feeLabel: '$1.99 delivery', open: false, openLabel: 'Closed · opens 5 PM' });
    expect(list[2]).toMatchObject({ open: false, openLabel: 'Closed today' });
    const page = (await k.store('GET', `/restaurants/${free.slug}`)).body;
    expect(page).toMatchObject({ minOrderLabel: 'Min. order $12.00', promoText: 'Free delivery on orders over $25 this week', freeDeliveryOver: usd(2500), deliveryFee: usd(0), sections: [] });
    expect(page.hours.map((d: any) => d.weekday)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    // sorted by fee: still open ones first
    expect((await k.store('GET', `/restaurants?q=${tag}&sort=fee`)).body.items[0].id).toBe(free.id);
    // hidden: gone from the store
    await k.admin('PATCH', `/restaurants/${paused.id}`, { name: paused.name, cuisine: paused.cuisine, deliveryMinMinutes: 20, deliveryMaxMinutes: 30, deliveryFee: usd(199), status: 'hidden' });
    expect((await k.store('GET', `/restaurants/${paused.slug}`)).status).toBe(404);
  });

  it('needs food.manage to change restaurants', async () => {
    expect((await k.admin('POST', '/restaurants', { name: 'Nope', cuisine: 'x', deliveryMinMinutes: 1, deliveryMaxMinutes: 2, deliveryFee: usd(0) }, k.staff(['food.view']))).status).toBe(403);
    expect((await k.admin('GET', '/restaurants', undefined, k.staff(['food.view']))).status).toBe(200);
  });
});

describe('menus', () => {
  it('validates option groups', async () => {
    const r = await restaurant(k);
    const s = await section(k, r.id);
    const post = (over: Record<string, unknown>) => k.admin('POST', `/restaurants/${r.id}/items`, { sectionId: s.id, name: 'Pizza', price: usd(1450), ...over });
    const path = async (over: Record<string, unknown>) => (await post(over)).body.error.details.issues[0].path;
    expect(await path({ optionGroups: [SIZE_GROUP, { ...EXTRAS_GROUP, id: 'size' }] })).toBe('optionGroups[1].id');
    expect(await path({ optionGroups: [{ ...SIZE_GROUP, min: 2, max: 1 }] })).toBe('optionGroups[0].min');
    expect(await path({ optionGroups: [{ ...SIZE_GROUP, required: true, min: 0 }] })).toBe('optionGroups[0].min');
    expect(await path({ optionGroups: [{ ...SIZE_GROUP, choices: [SIZE_GROUP.choices[0], SIZE_GROUP.choices[0]] }] })).toBe('optionGroups[0].choices[1].id');
    expect(await path({ optionGroups: [{ ...SIZE_GROUP, choices: SIZE_GROUP.choices.map((c) => ({ ...c, default: true })) }] })).toBe('optionGroups[0].choices');
    // the personal size takes $3.00 off: a $2.50 pizza would cost less than nothing
    expect(await path({ price: usd(250), optionGroups: [SIZE_GROUP] })).toBe('optionGroups');
    expect(await path({ wasPrice: usd(1000) })).toBe('wasPrice');
    expect(await path({ sectionId: newId() })).toBe('sectionId');
    expect(await path({ photoIds: [newId(), newId(), newId(), newId(), newId(), newId()] })).toBe('photoIds');
    expect((await post({ optionGroups: [SIZE_GROUP, EXTRAS_GROUP] })).status).toBe(201);
  });

  it('shows Popular first, then the sections in order with unavailable items marked', async () => {
    const { r, s, pizza } = await pizzeria(k);
    const sides = await section(k, r.id, 'Sides');
    const knots = await item(k, r.id, sides.id, { name: 'Garlic knots (6)', price: usd(550), wasPrice: usd(650) });
    const gone = await item(k, r.id, sides.id, { name: 'Tiramisu', price: usd(650), available: false });
    const page = (await k.store('GET', `/restaurants/${r.slug}`)).body;
    expect(page.sections.map((x: any) => x.name)).toEqual(['Popular', 'Pizza', 'Sides']);
    expect(page.sections[0].items.map((i: any) => i.id)).toEqual([pizza.id]);
    expect(page.sections[1].id).toBe(s.id);
    const card = page.sections[2].items.find((i: any) => i.id === knots.id);
    expect(card).toMatchObject({ priceLabel: '$5.50', wasLabel: '$6.50', badge: '-15%', hasOptions: false, available: true, restaurantSlug: r.slug });
    expect(page.sections[2].items.find((i: any) => i.id === gone.id).available).toBe(false);
    expect(page.sections[0].items[0]).toMatchObject({ hasOptions: true, tag: 'Most ordered', dietTags: ['Vegetarian'] });

    const detail = (await k.store('GET', `/items/${pizza.id}`)).body;
    expect(detail.optionGroups.map((g: any) => g.name)).toEqual(['Size', 'Extras']);
    expect(detail.optionGroups[0].choices[0]).toMatchObject({ name: '10" personal', priceDelta: usd(-300) });
    expect(detail.restaurant).toMatchObject({ id: r.id, openLabel: 'Open until 11 PM' });
    expect(detail.instructionsHint).toMatch(/allergy/);

    // a section with items can't go; recommended foods list available items only
    expect((await k.admin('DELETE', `/sections/${sides.id}`)).body.error.code).toBe('IN_USE');
    await k.admin('PATCH', `/items/${knots.id}`, { sectionId: sides.id, name: 'Garlic knots (6)', price: usd(550), recommended: true });
    await k.admin('PATCH', `/items/${gone.id}`, { sectionId: sides.id, name: 'Tiramisu', price: usd(650), recommended: true });
    const recommended = (await k.store('GET', '/items?recommended=true&limit=100')).body.items.map((i: any) => i.id);
    expect(recommended).toContain(knots.id);
    expect(recommended).not.toContain(gone.id);
    // PATCH keeps what it doesn't send
    expect((await k.admin('GET', `/restaurants/${r.id}/menu`)).body.find((x: any) => x.id === sides.id).items.find((i: any) => i.id === knots.id)).toMatchObject({ wasPrice: usd(650), recommended: true });
    expect((await k.store('GET', `/restaurants?q=garlic`)).body.items.map((x: any) => x.id)).toContain(r.id);
  });
});

describe('basket', () => {
  it('checks the options, works out prices and merges identical lines', async () => {
    const { r, pizza, drink } = await pizzeria(k, { freeDeliveryOver: usd(2500), minOrder: usd(1200) });
    const me = k.customer(newId());
    const add = (body: Record<string, unknown>) => k.store('POST', '/basket/lines', body, me);
    expect((await k.store('GET', '/basket', undefined, me)).body).toMatchObject({ restaurant: null, lines: [], itemCount: 0, total: usd(0), canOrder: false });
    expect((await k.store('GET', '/basket')).status).toBe(401);

    const noSize = await add({ itemId: pizza.id, quantity: 1 });
    expect(noSize.status).toBe(422);
    expect(noSize.body.error).toMatchObject({ code: 'OPTIONS_INVALID', details: { groupId: 'size' } });
    expect((await add({ itemId: pizza.id, quantity: 1, options: [...regular, { groupId: 'extras', choiceIds: ['mozzarella', 'basil', 'olives', 'chili', 'chili'] }] })).body.error.details.groupId).toBe('extras');
    expect((await add({ itemId: pizza.id, quantity: 1, options: [{ groupId: 'crust', choiceIds: ['thin'] }] })).body.error.details.groupId).toBe('crust');
    expect((await add({ itemId: pizza.id, quantity: 21, options: regular })).body.error.details.issues[0].path).toBe('quantity');
    expect((await add({ itemId: pizza.id, quantity: 1, options: regular, note: 'x'.repeat(201) })).body.error.details.issues[0].path).toBe('note');

    const one = await add({ itemId: pizza.id, quantity: 1, options: [...regular, { groupId: 'extras', choiceIds: ['mozzarella'] }] });
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.lines[0]).toMatchObject({ name: 'Margherita pizza 12"', optionsLabel: '12" regular · Extra mozzarella', unitPrice: usd(1690), total: usd(1690), available: true });
    // below the $25 free-delivery line: $1.99 delivery
    expect(one.body).toMatchObject({ subtotal: usd(1690), deliveryFee: usd(199), total: usd(1889), minOrder: usd(1200), missingForMinimum: null, canOrder: true, problems: [] });
    expect(one.body.restaurant.id).toBe(r.id);

    const two = await add({ itemId: pizza.id, quantity: 1, options: [{ groupId: 'extras', choiceIds: ['mozzarella'] }, ...regular] });
    expect(two.body.lines).toHaveLength(1);
    expect(two.body.lines[0].quantity).toBe(2);
    expect(two.body).toMatchObject({ subtotal: usd(3380), deliveryFee: usd(0), total: usd(3380), itemCount: 2 });
    const withNote = await add({ itemId: pizza.id, quantity: 1, options: regular, note: 'Well done' });
    expect(withNote.body.lines).toHaveLength(2);

    const line = withNote.body.lines[1];
    const changed = await k.store('PATCH', `/basket/lines/${line.id}`, { quantity: 0 }, me);
    expect(changed.body.lines).toHaveLength(1);
    expect((await k.store('PATCH', `/basket/lines/${newId()}`, { quantity: 1 }, me)).status).toBe(404);

    // below the minimum
    await k.store('PATCH', `/basket/lines/${changed.body.lines[0].id}`, { quantity: 0 }, me);
    const small = (await add({ itemId: drink.id, quantity: 1 })).body;
    expect(small).toMatchObject({ subtotal: usd(350), missingForMinimum: usd(850), canOrder: false });
    expect((await k.store('DELETE', '/basket', undefined, me)).body).toMatchObject({ restaurant: null, lines: [] });
  });

  it('holds one restaurant at a time unless replaced', async () => {
    const a = await pizzeria(k, { name: 'Napoli Corner Test' });
    const b = await pizzeria(k);
    const me = k.customer(newId());
    await k.store('POST', '/basket/lines', { itemId: a.drink.id, quantity: 2 }, me);
    const other = await k.store('POST', '/basket/lines', { itemId: b.drink.id, quantity: 1 }, me);
    expect(other.status).toBe(409);
    expect(other.body.error).toMatchObject({ code: 'OTHER_RESTAURANT', details: { restaurantName: 'Napoli Corner Test' } });
    const replaced = await k.store('POST', '/basket/lines', { itemId: b.drink.id, quantity: 1, replace: true }, me);
    expect(replaced.body.restaurant.id).toBe(b.r.id);
    expect(replaced.body.lines).toHaveLength(1);
  });

  it('refuses unavailable items and paused restaurants, and tells what stops an order already in the basket', async () => {
    const { r, pizza, drink } = await pizzeria(k, { name: 'Late Kitchen' });
    const me = k.customer(newId());
    await k.store('POST', '/basket/lines', { itemId: pizza.id, quantity: 1, options: regular }, me);
    await k.store('POST', '/basket/lines', { itemId: drink.id, quantity: 1 }, me);
    await k.admin('PATCH', `/items/${drink.id}`, { sectionId: drink.sectionId, name: drink.name, price: usd(350), available: false });
    expect((await k.store('POST', '/basket/lines', { itemId: drink.id, quantity: 1 }, me)).body.error).toMatchObject({ code: 'ITEM_UNAVAILABLE', details: { itemIds: [drink.id] } });
    let basket = (await k.store('GET', '/basket', undefined, me)).body;
    expect(basket.lines.find((l: any) => l.itemId === drink.id).available).toBe(false);
    expect(basket).toMatchObject({ subtotal: usd(1450), canOrder: false, problems: ['Lemonade is no longer available'] });

    // closed: after 11 PM
    k.clock.set(new Date(START.getTime() + 11.5 * 3_600_000));
    basket = (await k.store('GET', '/basket', undefined, me)).body;
    expect(basket.problems[0]).toBe('Late Kitchen is closed now · opens tomorrow 11 AM');
    k.clock.set(START);

    await k.admin('PATCH', `/restaurants/${r.id}`, { name: r.name, cuisine: r.cuisine, deliveryMinMinutes: 20, deliveryMaxMinutes: 30, deliveryFee: usd(199), status: 'paused' });
    expect((await k.store('POST', '/basket/lines', { itemId: pizza.id, quantity: 1, options: regular }, me)).body.error.code).toBe('RESTAURANT_UNAVAILABLE');
    expect((await k.store('GET', '/basket', undefined, me)).body.problems[0]).toBe("Late Kitchen isn't taking orders now");
    expect((await k.store('GET', '/payment-options', undefined, k.customer(newId()))).body.error.code).toBe('BASKET_EMPTY');
  });
});
