import type { ModuleStore } from '../../kernel/mongo/index.js';
import { escapeRegExp } from '../../kernel/lib/text.js';
import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import type { DealerRow, OrderRow } from './ports.js';

export type Lock = { forUpdate?: boolean };

/**
 * The farm module's collections: farm.dealers and farm.orders. A market has a handful of dealers, so they are read
 * whole; orders are paged here.
 */
export class FarmRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
      dealers: store.table<DealerRow>('dealers'),
      orders: store.table<OrderRow>('orders'),
    };
  }

  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: FarmRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new FarmRepository(tx)));
  }

  /** Inbox for event consumers: true the first time the key is claimed (inside the transaction of the effects) */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /* ---------------------------------------------------------------- dealers */

  listDealers(f: { activeOnly?: boolean } = {}): Promise<DealerRow[]> {
    return this.#t.dealers.find(f.activeOnly ? { active: true } : {}, { sort: { position: 1, name: 1 } });
  }
  getDealer(id: string): Promise<DealerRow | undefined> {
    return this.#t.dealers.get(id);
  }
  dealersByIds(ids: string[]): Promise<DealerRow[]> {
    return ids.length ? this.#t.dealers.getMany(ids) : Promise.resolve([]);
  }
  insertDealer(row: DealerRow): Promise<DealerRow> {
    return this.#t.dealers.insert(row);
  }
  updateDealer(id: string, patch: Partial<DealerRow>): Promise<DealerRow | undefined> {
    return this.#t.dealers.update(id, patch);
  }
  deleteDealer(id: string): Promise<boolean> {
    return this.#t.dealers.delete(id);
  }
  async maxDealerPosition(): Promise<number> {
    const rows = await this.#t.dealers.find({}, { sort: { position: -1 }, limit: 1 });
    return rows[0]?.position ?? 0;
  }

  /* ---------------------------------------------------------------- orders */

  insertOrder(row: OrderRow): Promise<OrderRow> {
    return this.#t.orders.insert(row);
  }
  getOrder(id: string, lock?: Lock): Promise<OrderRow | undefined> {
    return this.#t.orders.get(id, lock);
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
  pageAdminOrders(f: { statuses?: string[]; dealerId?: string; paymentOption?: string; q?: string; customerIds?: string[] }, page: PageRequest): Promise<Page<OrderRow>> {
    const filter: Record<string, unknown> = {};
    if (f.statuses) filter.status = { $in: f.statuses };
    if (f.dealerId) filter.dealer_id = f.dealerId;
    if (f.paymentOption) filter.payment_option = f.paymentOption;
    const q = f.q?.trim();
    if (q) {
      const or: Record<string, unknown>[] = [{ ref: { $regex: escapeRegExp(q), $options: 'i' } }, { contact_name: { $regex: escapeRegExp(q), $options: 'i' } }];
      if (f.customerIds?.length) or.push({ customer_id: { $in: f.customerIds } });
      filter.$or = or;
    }
    return this.#t.orders.page(filter, page, { column: 'created_at', direction: 'desc' });
  }
  countOrders(dealerId: string): Promise<number> {
    return this.#t.orders.count({ dealer_id: dealerId });
  }
  /** Orders per dealer id: all of them and the open ones */
  async orderCounts(ids: string[], open: string[]): Promise<Map<string, { all: number; open: number }>> {
    if (!ids.length) return new Map();
    const rows = await this.#t.orders.aggregate<{ _id: string; all: number; open: number }>([
      { $match: { dealer_id: { $in: ids } } },
      { $group: { _id: '$dealer_id', all: { $sum: 1 }, open: { $sum: { $cond: [{ $in: ['$status', open] }, 1, 0] } } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), { all: r.all, open: r.open }]));
  }
  /** Orders in a status whose `field` is before `before`, oldest first, after a keyset cursor (job batches) */
  staleOrders(status: string, field: 'placed_at' | 'updated_at', before: Date, after: { at: Date; id: string } | null, limit: number): Promise<OrderRow[]> {
    const filter: Record<string, unknown> = { status, [field]: { $lt: before } };
    if (after) filter.$or = [{ [field]: { $gt: after.at } }, { [field]: after.at, id: { $gt: after.id } }];
    return this.#t.orders.find(filter, { sort: { [field]: 1, id: 1 }, limit });
  }
}
