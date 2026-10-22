import type { FoodPublicApi } from '../../spec/food.js';
import { FoodOrders } from './service/orders.js';

export type { FoodServiceDeps } from './service/base.js';

/**
 * Food delivery use cases: categories, restaurants and menus (service/catalog.ts), the basket (service/basket.ts) and
 * orders with their card payments, staff moves, reviews, the payments event consumers, the expiry job and the data
 * export (service/orders.ts), on the shared base (service/base.ts).
 */
export class FoodService extends FoodOrders implements FoodPublicApi {}
