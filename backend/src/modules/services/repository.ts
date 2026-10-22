import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import { OPEN_STATUSES } from './domain/rules.js';
import type { CategoryRow, DeviceRow, ProviderRow, RequestRow, ReviewRow, SavedProviderRow, ServiceRow } from './ports.js';

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
      saved_providers: store.table<SavedProviderRow>('saved_providers'),
      devices: store.table<DeviceRow>('devices'),
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

  /* ---------------------------------------------------------------- personal data export */

  /** All of a customer's requests (account id), oldest first */
  allCustomerRequests(customerId: string): Promise<RequestRow[]> {
    return this.#t.requests.find({ customer_id: customerId }, { sort: { created_at: 1 } });
  }
  /** All of a customer's reviews (account id), visible or hidden, oldest first */
  allCustomerReviews(customerId: string): Promise<ReviewRow[]> {
    return this.#t.reviews.find({ customer_id: customerId }, { sort: { created_at: 1 } });
  }

  /* ---------------------------------------------------------------- saved providers */

  /** The customer's saves, newest first */
  savedProviders(customerId: string): Promise<SavedProviderRow[]> {
    return this.#t.saved_providers.find({ customer_id: customerId }, { sort: { created_at: -1 } });
  }
  async savedProviderIds(customerId: string, providerIds?: string[]): Promise<Set<string>> {
    const rows = await this.#t.saved_providers.find({ customer_id: customerId, ...(providerIds ? { provider_id: { $in: providerIds } } : {}) });
    return new Set(rows.map((r) => r.provider_id));
  }
  isProviderSaved(customerId: string, providerId: string): Promise<boolean> {
    return this.#t.saved_providers.exists({ customer_id: customerId, provider_id: providerId });
  }
  countSavedProviders(customerId: string): Promise<number> {
    return this.#t.saved_providers.count({ customer_id: customerId });
  }
  insertSavedProvider(row: SavedProviderRow): Promise<SavedProviderRow> {
    return this.#t.saved_providers.insert(row);
  }
  async deleteSavedProvider(customerId: string, providerId: string): Promise<void> {
    const row = await this.#t.saved_providers.findOne({ customer_id: customerId, provider_id: providerId });
    if (row) await this.#t.saved_providers.delete(row.id);
  }

  /* ---------------------------------------------------------------- devices */

  customerDevices(customerId: string): Promise<DeviceRow[]> {
    return this.#t.devices.find({ customer_id: customerId }, { sort: { created_at: -1 } });
  }
  countCustomerDevices(customerId: string): Promise<number> {
    return this.#t.devices.count({ customer_id: customerId });
  }
  getDevice(id: string, lock?: Lock): Promise<DeviceRow | undefined> {
    return this.#t.devices.get(id, lock);
  }
  /** Whether another pending or verified registration has this IMEI */
  imeiTaken(imei: string, exceptId?: string): Promise<boolean> {
    return this.#t.devices.exists({ imei, status: { $in: ['pending', 'verified'] }, ...(exceptId ? { id: { $ne: exceptId } } : {}) });
  }
  insertDevice(row: DeviceRow): Promise<DeviceRow> {
    return this.#t.devices.insert(row);
  }
  updateDevice(id: string, patch: Partial<DeviceRow>): Promise<DeviceRow | undefined> {
    return this.#t.devices.update(id, patch);
  }
  deleteDevice(id: string): Promise<boolean> {
    return this.#t.devices.delete(id);
  }
  pageAdminDevices(f: { status?: string; customerId?: string; q?: string }, page: PageRequest): Promise<Page<DeviceRow>> {
    const filter: Record<string, unknown> = {};
    if (f.status) filter.status = f.status;
    if (f.customerId) filter.customer_id = f.customerId;
    const q = f.q?.trim();
    if (q) {
      const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      const digits = q.replace(/[\s.-]/g, '');
      filter.$or = [{ brand: rx }, { model: rx }, { order_ref: rx }, ...(/^\d{2,15}$/.test(digits) ? [{ imei: { $regex: digits } }] : [])];
    }
    return this.#t.devices.page(filter, page, { column: 'created_at', direction: 'desc' });
  }
  /** Requests per device id */
  async deviceRequestCounts(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await this.#t.requests.aggregate<{ _id: string; n: number }>([{ $match: { device_id: { $in: ids } } }, { $group: { _id: '$device_id', n: { $sum: 1 } } }]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
  }
}
