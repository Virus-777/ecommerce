import type { FoodDb, LineOptionInput } from '../../spec/food.js';

/** Rows of the food collections (spec tables) */
export type CategoryRow = FoodDb['categories'];
export type RestaurantRow = FoodDb['restaurants'];
export type SectionRow = FoodDb['sections'];
export type ItemRow = FoodDb['items'];
export type BasketRow = FoodDb['baskets'];
export type OrderRow = FoodDb['orders'];
export type ReviewRow = FoodDb['reviews'];
export type SavedRestaurantRow = FoodDb['saved_restaurants'];

/** A basket line as stored (baskets.lines): the item, its choices, quantity and note, with the name and unit price when added (shown if the item goes away) */
export interface StoredLine {
  id: string;
  itemId: string;
  quantity: number;
  options: LineOptionInput[];
  note: string | null;
  name: string;
  unitPrice: number;
}

/** The restaurant as it was when the order was placed (orders.restaurant) */
export interface RestaurantSnapshot {
  name: string;
  slug: string;
  cuisine: string;
  city: string | null;
  imageId: string | null;
  logoId: string | null;
  timeZone: string;
  deliveryMin: number;
  deliveryMax: number;
}

/** An order line as stored (orders.lines): OrderLine with the picture's asset id */
export interface StoredOrderLine {
  itemId: string;
  name: string;
  imageId: string | null;
  optionsLabel: string | null;
  note: string | null;
  unitPrice: number;
  quantity: number;
  total: number;
}

/** A history entry as stored (orders.history); `by` is shown to staff only */
export interface StoredChange {
  status: string;
  at: string;
  by: string | null;
  note: string | null;
}
