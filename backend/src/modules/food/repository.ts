import type { ModuleStore } from '../../kernel/mongo/index.js';
import { escapeRegExp } from '../../kernel/lib/text.js';
import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import type { BasketRow, CategoryRow, ItemRow, OrderRow, RestaurantRow, ReviewRow, SectionRow } from './ports.js';

export type Lock = { forUpdate?: boolean };

/**
 * The food module's collections (food.<table>): categories, restaurants, sections, items, baskets, orders and reviews.
 * The catalog is small (a market's restaurants and their menus), so catalog lists are read whole and paged in the
 * service; orders and reviews are paged here.
 */
export class FoodRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
      categories: store.table<CategoryRow>('categories'),
      restaurants: store.table<RestaurantRow>('restaurants'),
      sections: store.table<SectionRow>('sections'),
      items: store.table<ItemRow>('items'),
      baskets: store.table<BasketRow>('baskets'),
      orders: store.table<OrderRow>('orders'),
      reviews: store.table<ReviewRow>('reviews'),
    };
  }

  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: FoodRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new FoodRepository(tx)));
  }

  /** Inbox for event consumers: true the first time the key is claimed (inside the transaction of the effects) */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /* ---------------------------------------------------------------- categories */

  listCategories(f: { visibleOnly?: boolean } = {}): Promise<CategoryRow[]> {
    return this.#t.categories.find(f.visibleOnly ? { visible: true } : {}, { sort: { position: 1, name: 1 } });
  }
  getCategory(id: string): Promise<CategoryRow | undefined> {
    return this.#t.categories.get(id);
  }
  categoryBySlug(slug: string): Promise<CategoryRow | undefined> {
    return this.#t.categories.findOne({ slug });
  }
  categoriesByIds(ids: string[]): Promise<CategoryRow[]> {
    return this.#t.categories.getMany(ids);
  }
  insertCategory(row: CategoryRow): Promise<CategoryRow> {
    return this.#t.categories.insert(row);
  }
  updateCategory(id: string, patch: Partial<CategoryRow>): Promise<CategoryRow | undefined> {
    return this.#t.categories.update(id, patch);
  }
  deleteCategory(id: string): Promise<boolean> {
    return this.#t.categories.delete(id);
  }
  async maxCategoryPosition(): Promise<number> {
    const rows = await this.#t.categories.find({}, { sort: { position: -1 }, limit: 1 });
    return rows[0]?.position ?? 0;
  }

  /* ---------------------------------------------------------------- restaurants */

  listRestaurants(f: { statuses?: string[] } = {}): Promise<RestaurantRow[]> {
    return this.#t.restaurants.find(f.statuses ? { status: { $in: f.statuses } } : {}, { sort: { position: 1, name: 1 } });
  }
  getRestaurant(id: string, lock?: Lock): Promise<RestaurantRow | undefined> {
    return this.#t.restaurants.get(id, lock);
  }
  restaurantBySlug(slug: string): Promise<RestaurantRow | undefined> {
    return this.#t.restaurants.findOne({ slug });
  }
  restaurantsByIds(ids: string[]): Promise<RestaurantRow[]> {
    return this.#t.restaurants.getMany(ids);
  }
  insertRestaurant(row: RestaurantRow): Promise<RestaurantRow> {
    return this.#t.restaurants.insert(row);
  }
  updateRestaurant(id: string, patch: Partial<RestaurantRow>): Promise<RestaurantRow | undefined> {
    return this.#t.restaurants.update(id, patch);
  }
  deleteRestaurant(id: string): Promise<boolean> {
    return this.#t.restaurants.delete(id);
  }
  slugTaken(table: 'categories' | 'restaurants', slug: string, exceptId?: string): Promise<boolean> {
    return this.#t[table].exists({ slug, ...(exceptId ? { id: { $ne: exceptId } } : {}) });
  }
  async maxRestaurantPosition(): Promise<number> {
    const rows = await this.#t.restaurants.find({}, { sort: { position: -1 }, limit: 1 });
    return rows[0]?.position ?? 0;
  }
  /** Restaurants that list a category */
  restaurantsInCategory(categoryId: string): Promise<RestaurantRow[]> {
    return this.#t.restaurants.find({ category_ids: categoryId });
  }

  /* ---------------------------------------------------------------- sections and items */

  listSections(restaurantId: string): Promise<SectionRow[]> {
    return this.#t.sections.find({ restaurant_id: restaurantId }, { sort: { position: 1, name: 1 } });
  }
  getSection(id: string): Promise<SectionRow | undefined> {
    return this.#t.sections.get(id);
  }
  insertSection(row: SectionRow): Promise<SectionRow> {
    return this.#t.sections.insert(row);
  }
  updateSection(id: string, patch: Partial<SectionRow>): Promise<SectionRow | undefined> {
    return this.#t.sections.update(id, patch);
  }
  deleteSection(id: string): Promise<boolean> {
    return this.#t.sections.delete(id);
  }
  deleteSectionsOf(restaurantId: string): Promise<number> {
    return this.#t.sections.deleteMany({ restaurant_id: restaurantId });
  }
  async maxSectionPosition(restaurantId: string): Promise<number> {
    const rows = await this.#t.sections.find({ restaurant_id: restaurantId }, { sort: { position: -1 }, limit: 1 });
    return rows[0]?.position ?? 0;
  }

  listItems(f: { restaurantId?: string; restaurantIds?: string[]; recommended?: boolean; availableOnly?: boolean } = {}): Promise<ItemRow[]> {
    const filter: Record<string, unknown> = {};
    if (f.restaurantId) filter.restaurant_id = f.restaurantId;
    else if (f.restaurantIds) filter.restaurant_id = { $in: f.restaurantIds };
    if (f.recommended) filter.recommended = true;
    if (f.availableOnly) filter.available = true;
    return this.#t.items.find(filter, { sort: { position: 1, name: 1 } });
  }
  getItem(id: string, lock?: Lock): Promise<ItemRow | undefined> {
    return this.#t.items.get(id, lock);
  }
  itemsByIds(ids: string[]): Promise<ItemRow[]> {
    return ids.length ? this.#t.items.getMany(ids) : Promise.resolve([]);
  }
  insertItem(row: ItemRow): Promise<ItemRow> {
    return this.#t.items.insert(row);
  }
  updateItem(id: string, patch: Partial<ItemRow>): Promise<ItemRow | undefined> {
    return this.#t.items.update(id, patch);
  }
  deleteItem(id: string): Promise<boolean> {
    return this.#t.items.delete(id);
  }
  deleteItemsOf(restaurantId: string): Promise<number> {
    return this.#t.items.deleteMany({ restaurant_id: restaurantId });
  }
  countItems(f: { restaurantId?: string; sectionId?: string }): Promise<number> {
    return this.#t.items.count({ ...(f.restaurantId ? { restaurant_id: f.restaurantId } : {}), ...(f.sectionId ? { section_id: f.sectionId } : {}) });
  }
  async maxItemPosition(sectionId: string): Promise<number> {
    const rows = await this.#t.items.find({ section_id: sectionId }, { sort: { position: -1 }, limit: 1 });
    return rows[0]?.position ?? 0;
  }

  /* ---------------------------------------------------------------- baskets */

  basketOf(customerId: string, lock?: Lock): Promise<BasketRow | undefined> {
    return this.#t.baskets.findOne({ customer_id: customerId }, lock);
  }
  saveBasket(row: BasketRow): Promise<BasketRow> {
    return this.#t.baskets.upsert(row, { key: ['customer_id'], update: { restaurant_id: row.restaurant_id, lines: row.lines, updated_at: row.updated_at } });
  }

  /* ---------------------------------------------------------------- orders */

  insertOrder(row: OrderRow): Promise<OrderRow> {
    return this.#t.orders.insert(row);
  }
  getOrder(id: string, lock?: Lock): Promise<OrderRow | undefined> {
    return this.#t.orders.get(id, lock);
  }
  ordersByIds(ids: string[]): Promise<OrderRow[]> {
    return ids.length ? this.#t.orders.getMany(ids) : Promise.resolve([]);
  }
  orderByKey(idempotencyKey: string): Promise<OrderRow | undefined> {
    return this.#t.orders.findOne({ idempotency_key: idempotencyKey });
  }
  refTaken(ref: string): Promise<boolean> {
    return this.#t.orders.exists({ ref });
  }
  updateOrder(id: string, patch: Partial<OrderRow>): Promise<OrderRow | undefined> {
    return this.#t.orders.update(id, patch);
  }
  deleteOrder(id: string): Promise<boolean> {
    return this.#t.orders.delete(id);
  }
  pageCustomerOrders(customerId: string, statuses: string[] | undefined, page: PageRequest): Promise<Page<OrderRow>> {
    return this.#t.orders.page({ customer_id: customerId, ...(statuses ? { status: { $in: statuses } } : {}) }, page, { column: 'created_at', direction: 'desc' });
  }
  customerOrders(customerId: string): Promise<OrderRow[]> {
    return this.#t.orders.find({ customer_id: customerId }, { sort: { created_at: -1 } });
  }
  pageAdminOrders(f: { statuses?: string[]; restaurantId?: string; q?: string; customerIds?: string[] }, page: PageRequest): Promise<Page<OrderRow>> {
    const filter: Record<string, unknown> = {};
    if (f.statuses) filter.status = { $in: f.statuses };
    if (f.restaurantId) filter.restaurant_id = f.restaurantId;
    const q = f.q?.trim();
    if (q) {
      const or: Record<string, unknown>[] = [{ ref: { $regex: escapeRegExp(q), $options: 'i' } }];
      if (f.customerIds?.length) or.push({ customer_id: { $in: f.customerIds } });
      filter.$or = or;
    }
    return this.#t.orders.page(filter, page, { column: 'created_at', direction: 'desc' });
  }
  countOrders(f: { restaurantId: string }): Promise<number> {
    return this.#t.orders.count({ restaurant_id: f.restaurantId });
  }
  /** Orders per restaurant id in some statuses */
  async orderCounts(ids: string[], statuses: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await this.#t.orders.aggregate<{ _id: string; n: number }>([{ $match: { restaurant_id: { $in: ids }, status: { $in: statuses } } }, { $group: { _id: '$restaurant_id', n: { $sum: 1 } } }]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
  }
  /** Orders in a status whose `field` is before `before`, oldest first, after a keyset cursor (job batches) */
  staleOrders(status: string, field: 'placed_at' | 'updated_at', before: Date, after: { at: Date; id: string } | null, limit: number): Promise<OrderRow[]> {
    const filter: Record<string, unknown> = { status, [field]: { $lt: before } };
    if (after) filter.$or = [{ [field]: { $gt: after.at } }, { [field]: after.at, id: { $gt: after.id } }];
    return this.#t.orders.find(filter, { sort: { [field]: 1, id: 1 }, limit });
  }

  /* ---------------------------------------------------------------- reviews */

  insertReview(row: ReviewRow): Promise<ReviewRow> {
    return this.#t.reviews.insert(row);
  }
  getReview(id: string, lock?: Lock): Promise<ReviewRow | undefined> {
    return this.#t.reviews.get(id, lock);
  }
  reviewsOfOrders(orderIds: string[]): Promise<ReviewRow[]> {
    return orderIds.length ? this.#t.reviews.find({ order_id: { $in: orderIds } }) : Promise.resolve([]);
  }
  customerReviews(customerId: string): Promise<ReviewRow[]> {
    return this.#t.reviews.find({ customer_id: customerId }, { sort: { created_at: -1 } });
  }
  updateReview(id: string, patch: Partial<ReviewRow>): Promise<ReviewRow | undefined> {
    return this.#t.reviews.update(id, patch);
  }
  pageAdminReviews(f: { restaurantId?: string; hidden?: boolean; stars?: number }, page: PageRequest): Promise<Page<ReviewRow>> {
    return this.#t.reviews.page({ ...(f.restaurantId ? { restaurant_id: f.restaurantId } : {}), ...(f.hidden != null ? { hidden: f.hidden } : {}), ...(f.stars != null ? { stars: f.stars } : {}) }, page, { column: 'created_at', direction: 'desc' });
  }
}
