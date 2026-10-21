import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import { OPEN_STATUSES } from './domain/rules.js';
import type { CategoryRow, ProviderRow, RequestRow, ReviewRow, ServiceRow } from './ports.js';

export type Lock = { forUpdate?: boolean };

/**
 * The services module's collections (services.<table>): categories, providers, services, requests and reviews.
 * Catalog reads are small (a market's providers and services), so lists are filtered here and paged in the service.
 */
export class ServicesRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
      categories: store.table<CategoryRow>('categories'),
      providers: store.table<ProviderRow>('providers'),
      services: store.table<ServiceRow>('services'),
      requests: store.table<RequestRow>('requests'),
      reviews: store.table<ReviewRow>('reviews'),
    };
  }

  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: ServicesRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new ServicesRepository(tx)));
  }

  /* ---------------------------------------------------------------- categories */

  listCategories(f: { area?: string; visibleOnly?: boolean } = {}): Promise<CategoryRow[]> {
    return this.#t.categories.find({ ...(f.area ? { area: f.area } : {}), ...(f.visibleOnly ? { visible: true } : {}) }, { sort: { area: 1, position: 1, name: 1 } });
  }
  getCategory(id: string): Promise<CategoryRow | undefined> {
    return this.#t.categories.get(id);
  }
  categoryBySlug(area: string, slug: string): Promise<CategoryRow | undefined> {
    return this.#t.categories.findOne({ area, slug });
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
  countCategories(area: string): Promise<number> {
    return this.#t.categories.count({ area });
  }

  /* ---------------------------------------------------------------- providers */

  listProviders(f: { publishedOnly?: boolean } = {}): Promise<ProviderRow[]> {
    return this.#t.providers.find(f.publishedOnly ? { status: 'published' } : {}, { sort: { name: 1 } });
  }
  getProvider(id: string, lock?: Lock): Promise<ProviderRow | undefined> {
    return this.#t.providers.get(id, lock);
  }
  providerBySlug(slug: string): Promise<ProviderRow | undefined> {
    return this.#t.providers.findOne({ slug });
  }
  providersByIds(ids: string[]): Promise<ProviderRow[]> {
    return this.#t.providers.getMany(ids);
  }
  insertProvider(row: ProviderRow): Promise<ProviderRow> {
    return this.#t.providers.insert(row);
  }
  updateProvider(id: string, patch: Partial<ProviderRow>): Promise<ProviderRow | undefined> {
    return this.#t.providers.update(id, patch);
  }
  deleteProvider(id: string): Promise<boolean> {
    return this.#t.providers.delete(id);
  }
  countProvidersInCategory(categoryId: string): Promise<number> {
    return this.#t.providers.count({ category_id: categoryId });
  }

  /* ---------------------------------------------------------------- services */

  listServices(f: { area?: string; providerId?: string; providerIds?: string[]; categoryId?: string; publishedOnly?: boolean } = {}): Promise<ServiceRow[]> {
    const filter: Record<string, unknown> = {};
    if (f.area) filter.area = f.area;
    if (f.providerId) filter.provider_id = f.providerId;
    else if (f.providerIds) filter.provider_id = { $in: f.providerIds };
    if (f.categoryId) filter.category_id = f.categoryId;
    if (f.publishedOnly) filter.status = 'published';
    return this.#t.services.find(filter, { sort: { position: 1, title: 1 } });
  }
  getService(id: string, lock?: Lock): Promise<ServiceRow | undefined> {
    return this.#t.services.get(id, lock);
  }
  serviceBySlug(slug: string): Promise<ServiceRow | undefined> {
    return this.#t.services.findOne({ slug });
  }
  servicesByIds(ids: string[]): Promise<ServiceRow[]> {
    return this.#t.services.getMany(ids);
  }
  insertService(row: ServiceRow): Promise<ServiceRow> {
    return this.#t.services.insert(row);
  }
  updateService(id: string, patch: Partial<ServiceRow>): Promise<ServiceRow | undefined> {
    return this.#t.services.update(id, patch);
  }
  deleteService(id: string): Promise<boolean> {
    return this.#t.services.delete(id);
  }
  countServices(f: { providerId?: string; categoryId?: string }): Promise<number> {
    return this.#t.services.count({ ...(f.providerId ? { provider_id: f.providerId } : {}), ...(f.categoryId ? { category_id: f.categoryId } : {}) });
  }
  async maxServicePosition(area: string): Promise<number> {
    const rows = await this.#t.services.find({ area }, { sort: { position: -1 }, limit: 1 });
    return rows[0]?.position ?? 0;
  }

  slugTaken(table: 'providers' | 'services', slug: string, exceptId?: string): Promise<boolean> {
    return this.#t[table].exists({ slug, ...(exceptId ? { id: { $ne: exceptId } } : {}) });
  }

  /* ---------------------------------------------------------------- requests */

  insertRequest(row: RequestRow): Promise<RequestRow> {
    return this.#t.requests.insert(row);
  }
  getRequest(id: string, lock?: Lock): Promise<RequestRow | undefined> {
    return this.#t.requests.get(id, lock);
  }
  refTaken(ref: string): Promise<boolean> {
    return this.#t.requests.exists({ ref });
  }
  updateRequest(id: string, patch: Partial<RequestRow>): Promise<RequestRow | undefined> {
    return this.#t.requests.update(id, patch);
  }
  /** Bookings that hold time between `start` and `end` at a provider: open requests with a slot */
  heldSlots(providerId: string, start: Date, end: Date, exceptId?: string): Promise<RequestRow[]> {
    return this.#t.requests.find({ provider_id: providerId, status: { $in: [...OPEN_STATUSES] }, slot_start: { $lt: end }, slot_end: { $gt: start }, ...(exceptId ? { id: { $ne: exceptId } } : {}) });
  }
  pageCustomerRequests(customerId: string, f: { area?: string; statuses?: string[] }, page: PageRequest): Promise<Page<RequestRow>> {
    return this.#t.requests.page({ customer_id: customerId, ...(f.area ? { area: f.area } : {}), ...(f.statuses ? { status: { $in: f.statuses } } : {}) }, page, { column: 'created_at', direction: 'desc' });
  }
  pageAdminRequests(f: { area?: string; status?: string; providerId?: string; q?: string }, page: PageRequest): Promise<Page<RequestRow>> {
    const filter: Record<string, unknown> = {};
    if (f.area) filter.area = f.area;
    if (f.status) filter.status = f.status;
    if (f.providerId) filter.provider_id = f.providerId;
    const q = f.q?.trim();
    if (q) {
      const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      filter.$or = [{ ref: rx }, { 'contact.name': rx }, { 'contact.phone': rx }];
    }
    return this.#t.requests.page(filter, page, { column: 'created_at', direction: 'desc' });
  }
  /** Open requests per service or provider id */
  async openRequestCounts(field: 'service_id' | 'provider_id', ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await this.#t.requests.aggregate<{ _id: string; n: number }>([{ $match: { [field]: { $in: ids }, status: { $in: [...OPEN_STATUSES] } } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
  }
  countRequests(f: { serviceId?: string; providerId?: string; open?: boolean }): Promise<number> {
    return this.#t.requests.count({ ...(f.serviceId ? { service_id: f.serviceId } : {}), ...(f.providerId ? { provider_id: f.providerId } : {}), ...(f.open ? { status: { $in: [...OPEN_STATUSES] } } : {}) });
  }

  /* ---------------------------------------------------------------- reviews */

  insertReview(row: ReviewRow): Promise<ReviewRow> {
    return this.#t.reviews.insert(row);
  }
  getReview(id: string, lock?: Lock): Promise<ReviewRow | undefined> {
    return this.#t.reviews.get(id, lock);
  }
  updateReview(id: string, patch: Partial<ReviewRow>): Promise<ReviewRow | undefined> {
    return this.#t.reviews.update(id, patch);
  }
  pageVisibleReviews(serviceId: string, page: PageRequest): Promise<Page<ReviewRow>> {
    return this.#t.reviews.page({ service_id: serviceId, status: 'visible' }, page, { column: 'created_at', direction: 'desc' });
  }
  newestReviews(serviceId: string, limit: number): Promise<ReviewRow[]> {
    return this.#t.reviews.find({ service_id: serviceId, status: 'visible' }, { sort: { created_at: -1 }, limit });
  }
  pageAdminReviews(f: { status?: string; serviceId?: string }, page: PageRequest): Promise<Page<ReviewRow>> {
    return this.#t.reviews.page({ ...(f.status ? { status: f.status } : {}), ...(f.serviceId ? { service_id: f.serviceId } : {}) }, page, { column: 'created_at', direction: 'desc' });
  }
}
