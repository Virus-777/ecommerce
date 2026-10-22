/** Restaurants, sections and items made through the Admin API for the food tests */
import { expect } from 'vitest';
import { EXTRAS_GROUP, LUNCH_TO_LATE, SIZE_GROUP, usd, type Kit } from './helpers.js';

let seq = 0;

export async function restaurant(k: Kit, over: Record<string, unknown> = {}) {
  const res = await k.admin('POST', '/restaurants', { name: `Restaurant ${++seq}`, cuisine: 'Pizza · Italian', hours: LUNCH_TO_LATE, deliveryMinMinutes: 20, deliveryMaxMinutes: 30, deliveryFee: usd(199), status: 'published', ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

export async function section(k: Kit, restaurantId: string, name = 'Pizza') {
  const res = await k.admin('POST', `/restaurants/${restaurantId}/sections`, { name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

export async function item(k: Kit, restaurantId: string, sectionId: string, over: Record<string, unknown> = {}) {
  const res = await k.admin('POST', `/restaurants/${restaurantId}/items`, { sectionId, name: `Dish ${++seq}`, price: usd(1450), ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** A published restaurant (11:00–23:00, $1.99 delivery, 20–30 min) with a pizza (sizes and extras) and a drink */
export async function pizzeria(k: Kit, over: Record<string, unknown> = {}) {
  const r = await restaurant(k, over);
  const s = await section(k, r.id);
  const pizza = await item(k, r.id, s.id, { name: 'Margherita pizza 12"', price: usd(1450), optionGroups: [SIZE_GROUP, EXTRAS_GROUP], popular: true, tag: 'Most ordered', dietTags: ['Vegetarian'] });
  const drink = await item(k, r.id, s.id, { name: 'Lemonade', price: usd(350) });
  return { r, s, pizza, drink };
}

export const regular = [{ groupId: 'size', choiceIds: ['regular'] }];
