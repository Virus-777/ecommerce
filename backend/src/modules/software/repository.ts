import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import { contains, type ModuleStore } from '../../kernel/mongo/index.js';
import type { AppRow, CategoryRow, EntitlementRow, PackRow, PurchaseRow, RailRow, ReviewRow } from './ports.js';

export type Lock = { forUpdate?: boolean };

/**
 * The software module's collections (software.<table>): categories, apps, packs, rails, purchases, entitlements and
 * reviews. The catalog is small (a market's apps and packs), so app lists are read whole, filtered and sorted in the
 * service and paged with pageOf; purchases, entitlements and reviews grow with customers and are paged here.
 */
export class SoftwareRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
      categories: store.table<CategoryRow>('categories'),
      apps: store.table<AppRow>('apps'),
      packs: store.table<PackRow>('packs'),
      rails: store.table<RailRow>('rails'),
      purchases: store.table<PurchaseRow>('purchases'),
      entitlements: store.table<EntitlementRow>('entitlements'),
      reviews: store.table<ReviewRow>('reviews'),
    };
  }

  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: SoftwareRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new SoftwareRepository(tx)));
  }

  /** Inbox key: true the first time (inside a transaction it commits with the effects) */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /* ---------------------------------------------------------------- categories */

  listCategories(visibleOnly = false): Promise<CategoryRow[]> {
    return this.#t.categories.find(visibleOnly ? { visible: true } : {}, { sort: { position: 1, name: 1 } });
  }
  getCategory(id: string): Promise<CategoryRow | undefined> {
    return this.#t.categories.get(id);
  }
  categoryBySlug(slug: string): Promise<CategoryRow | undefined> {
    return this.#t.categories.findOne({ slug });
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
  countCategories(): Promise<number> {
    return this.#t.categories.count();
  }

  /* ---------------------------------------------------------------- apps */

  listApps(f: { statuses?: readonly string[]; categoryId?: string; platform?: string; inDepartment?: boolean } = {}): Promise<AppRow[]> {
    const filter: Record<string, unknown> = {};
    if (f.statuses) filter.status = { $in: [...f.statuses] };
    if (f.categoryId) filter.category_id = f.categoryId;
    if (f.platform) filter.platforms = f.platform;
    if (f.inDepartment) filter.show_in_department = true;
    return this.#t.apps.find(filter, { sort: { position: 1, title: 1 } });
  }
  getApp(id: string, lock?: Lock): Promise<AppRow | undefined> {
    return this.#t.apps.get(id, lock);
  }
  appBySlug(slug: string): Promise<AppRow | undefined> {
    return this.#t.apps.findOne({ slug });
  }
  appsByIds(ids: readonly string[]): Promise<AppRow[]> {
    return ids.length ? this.#t.apps.getMany(ids) : Promise.resolve([]);
  }
  insertApp(row: AppRow): Promise<AppRow> {
    return this.#t.apps.insert(row);
  }
  updateApp(id: string, patch: Partial<AppRow>): Promise<AppRow | undefined> {
    return this.#t.apps.update(id, patch);
  }
  deleteApp(id: string): Promise<boolean> {
    return this.#t.apps.delete(id);
  }
  appSlugTaken(slug: string, exceptId?: string): Promise<boolean> {
    return this.#t.apps.exists({ slug, ...(exceptId ? { id: { $ne: exceptId } } : {}) });
  }
  countAppsInCategory(categoryId: string): Promise<number> {
    return this.#t.apps.count({ category_id: categoryId });
  }
  async maxAppPosition(): Promise<number> {
    const rows = await this.#t.apps.find({}, { sort: { position: -1 }, limit: 1 });
    return rows[0]?.position ?? 0;
  }
  /** Moves counters (views, downloads, owners) without reading the app */
  async bump(id: string, inc: Partial<Record<'views' | 'downloads' | 'owners', number>>): Promise<void> {
    await this.#t.apps.update(id, { $inc: inc });
  }

  /* ---------------------------------------------------------------- packs */

  listPacks(visibleOnly = false): Promise<PackRow[]> {
    return this.#t.packs.find(visibleOnly ? { visible: true } : {}, { sort: { position: 1, name: 1 } });
  }
  getPack(id: string, lock?: Lock): Promise<PackRow | undefined> {
    return this.#t.packs.get(id, lock);
  }
  insertPack(row: PackRow): Promise<PackRow> {
    return this.#t.packs.insert(row);
  }
  updatePack(id: string, patch: Partial<PackRow>): Promise<PackRow | undefined> {
    return this.#t.packs.update(id, patch);
  }
  deletePack(id: string): Promise<boolean> {
    return this.#t.packs.delete(id);
  }
  packSlugTaken(slug: string, exceptId?: string): Promise<boolean> {
    return this.#t.packs.exists({ slug, ...(exceptId ? { id: { $ne: exceptId } } : {}) });
  }
  countPacks(): Promise<number> {
    return this.#t.packs.count();
  }
  /** Packs that include an app */
  packsWithApp(appId: string): Promise<PackRow[]> {
    return this.#t.packs.find({ app_ids: appId });
  }
  async bumpPackSold(id: string, n = 1): Promise<void> {
    await this.#t.packs.update(id, { $inc: { sold: n } });
  }

  /* ---------------------------------------------------------------- rails */

  listRails(): Promise<RailRow[]> {
    return this.#t.rails.find({}, { sort: { position: 1 } });
  }
  /** Replaces every rail (inside the caller's transaction) */
  async replaceRails(rows: RailRow[]): Promise<void> {
    await this.#t.rails.deleteMany({});
    if (rows.length) await this.#t.rails.insertMany(rows);
  }

  /* ---------------------------------------------------------------- purchases */

  /** The purchase, unless its key or reference is taken (undefined then) */
  insertPurchase(row: PurchaseRow): Promise<PurchaseRow | undefined> {
    return this.#t.purchases.insertIfAbsent(row);
  }
  getPurchase(id: string, lock?: Lock): Promise<PurchaseRow | undefined> {
    return this.#t.purchases.get(id, lock);
  }
  purchaseByKey(key: string): Promise<PurchaseRow | undefined> {
    return this.#t.purchases.findOne({ idempotency_key: key });
  }
  purchaseRefTaken(ref: string): Promise<boolean> {
    return this.#t.purchases.exists({ ref });
  }
  updatePurchase(id: string, patch: Partial<PurchaseRow>): Promise<PurchaseRow | undefined> {
    return this.#t.purchases.update(id, patch);
  }
  pageCustomerPurchases(customerId: string, page: PageRequest): Promise<Page<PurchaseRow>> {
    return this.#t.purchases.page({ customer_id: customerId }, page, { column: 'created_at', direction: 'desc' });
  }
  customerPurchases(customerId: string): Promise<PurchaseRow[]> {
    return this.#t.purchases.find({ customer_id: customerId }, { sort: { created_at: 1 } });
  }
  /** Admin list: status, an app among the items, and the search box (a reference, or the customers whose email matched) */
  pageAdminPurchases(f: { status?: string; appId?: string; q?: string; customerIds?: string[] }, page: PageRequest): Promise<Page<PurchaseRow>> {
    const filter: Record<string, unknown> = {};
    if (f.status) filter.status = f.status;
    if (f.appId) filter['items.appId'] = f.appId;
    if (f.q) filter.$or = [{ ref: contains(f.q) }, ...(f.customerIds?.length ? [{ customer_id: { $in: f.customerIds } }] : [])];
    return this.#t.purchases.page(filter, page, { column: 'created_at', direction: 'desc' });
  }
  /** requires_action purchases last changed before `before`, oldest first */
  staleChallenges(before: Date, limit: number): Promise<PurchaseRow[]> {
    return this.#t.purchases.find({ status: 'requires_action', updated_at: { $lt: before } }, { sort: { updated_at: 1 }, limit });
  }
  countPackPurchases(packId: string): Promise<number> {
    return this.#t.purchases.count({ pack_id: packId });
  }
  countAppPurchases(appId: string): Promise<number> {
    return this.#t.purchases.count({ 'items.appId': appId });
  }

  /* ---------------------------------------------------------------- entitlements */

  /** The entitlement, unless the customer owns the app already (undefined then) */
  insertEntitlement(row: EntitlementRow): Promise<EntitlementRow | undefined> {
    return this.#t.entitlements.insertIfAbsent(row);
  }
  entitlement(customerId: string, appId: string): Promise<EntitlementRow | undefined> {
    return this.#t.entitlements.findOne({ customer_id: customerId, app_id: appId });
  }
  async ownedAppIds(customerId: string, appIds?: readonly string[]): Promise<Set<string>> {
    const rows = await this.#t.entitlements.find({ customer_id: customerId, ...(appIds ? { app_id: { $in: [...appIds] } } : {}) });
    return new Set(rows.map((r) => r.app_id));
  }
  pageCustomerEntitlements(customerId: string, page: PageRequest): Promise<Page<EntitlementRow>> {
    return this.#t.entitlements.page({ customer_id: customerId }, page, { column: 'created_at', direction: 'desc' });
  }
  customerEntitlements(customerId: string): Promise<EntitlementRow[]> {
    return this.#t.entitlements.find({ customer_id: customerId }, { sort: { created_at: 1 } });
  }
  countOwners(appId: string): Promise<number> {
    return this.#t.entitlements.count({ app_id: appId });
  }

  /* ---------------------------------------------------------------- reviews */

  insertReview(row: ReviewRow): Promise<ReviewRow | undefined> {
    return this.#t.reviews.insertIfAbsent(row);
  }
  getReview(id: string, lock?: Lock): Promise<ReviewRow | undefined> {
    return this.#t.reviews.get(id, lock);
  }
  reviewOf(appId: string, customerId: string, lock: Lock = {}): Promise<ReviewRow | undefined> {
    return this.#t.reviews.findOne({ app_id: appId, customer_id: customerId }, lock);
  }
  updateReview(id: string, patch: Partial<ReviewRow>): Promise<ReviewRow | undefined> {
    return this.#t.reviews.update(id, patch);
  }
  pageVisibleReviews(appId: string, stars: number | undefined, page: PageRequest): Promise<Page<ReviewRow>> {
    return this.#t.reviews.page({ app_id: appId, hidden: false, ...(stars ? { stars } : {}) }, page, { column: 'created_at', direction: 'desc' });
  }
  newestReviews(appId: string, limit: number): Promise<ReviewRow[]> {
    return this.#t.reviews.find({ app_id: appId, hidden: false }, { sort: { created_at: -1 }, limit });
  }
  pageAdminReviews(f: { appId?: string; hidden?: boolean; stars?: number }, page: PageRequest): Promise<Page<ReviewRow>> {
    return this.#t.reviews.page({ ...(f.appId ? { app_id: f.appId } : {}), ...(f.hidden !== undefined ? { hidden: f.hidden } : {}), ...(f.stars ? { stars: f.stars } : {}) }, page, { column: 'created_at', direction: 'desc' });
  }
  customerReviews(customerId: string): Promise<ReviewRow[]> {
    return this.#t.reviews.find({ customer_id: customerId }, { sort: { created_at: 1 } });
  }
  deleteAppReviews(appId: string): Promise<number> {
    return this.#t.reviews.deleteMany({ app_id: appId });
  }
}
