import type { FoodPublicApi } from '../../spec/food.js';
import { FoodSearchPart } from './service/search.js';

export type { FoodServiceDeps } from './service/base.js';

/**
 * Food delivery use cases: categories, restaurants and menus (service/catalog.ts), the basket (service/basket.ts),
 * orders with their card payments, staff moves, reviews, the payments event consumers, the expiry job and the data
 * export (service/orders.ts), the customer's food statistics (service/statistics.ts) and this department's part of
 * the integrated search (service/search.ts), on the shared base (service/base.ts).
 */
export class FoodService extends FoodSearchPart implements FoodPublicApi {}
