import { isDuplicateKey, type ModuleStore } from '../../kernel/mongo/index.js';
import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import type { AlertCandidate, AlertKind, AlertRow, AlertState, InsightRow, ItemRow, ListRow, ListWithCount, Lock } from './ports.js';

/** wishlist.lists, wishlist.items, wishlist.alerts (MongoDB, docs/04-mongodb-migration.md) */
export class WishlistRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
      lists: this.store.table<ListRow>('lists'),
      items: this.store.table<ItemRow>('items'),
      alerts: this.store.table<AlertRow>('alerts'),
    };
  }

  /** Runs fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: WishlistRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new WishlistRepository(tx)));
  }

  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /* ---------------------------------------------------------------- lists */
  /** The customer's default list, created when missing (safe under concurrency) */
  async ensureDefaultList(row: ListRow): Promise<ListRow> {
    // one default list per customer (unique customer_id where is_default): on conflict do nothing
    // (outside a transaction two concurrent upserts can still race to a duplicate key: the other one won)
    await this.#t.lists.insertIfAbsent(row, ['customer_id', 'is_default']).catch((err: unknown) => {
      if (this.store.inTransaction || !isDuplicateKey(err)) throw err;
    });
    return (await this.#t.lists.findOne({ customer_id: row.customer_id, is_default: true }))!;
  }

  getList(customerId: string, id: string, lock?: Lock): Promise<ListRow | undefined> {
    return this.#t.lists.findOne({ id, customer_id: customerId }, { forUpdate: lock?.forUpdate });
  }

  getListByShareToken(token: string): Promise<ListRow | undefined> {
    return this.#t.lists.findOne({ share_token: token });
  }

  async listLists(customerId: string): Promise<ListWithCount[]> {
    const lists = await this.#t.lists.find({ customer_id: customerId }, { sort: { is_default: -1, created_at: 1, id: 1 } });
    const counts = new Map(
      (await this.#t.items.aggregate<{ _id: string; n: number }>([{ $match: { list_id: { $in: lists.map((l) => l.id) } } }, { $group: { _id: '$list_id', n: { $sum: 1 } } }])).map((r) => [r._id, r.n]),
    );
    return lists.map((l): ListWithCount => ({ ...l, item_count: counts.get(l.id) ?? 0 }));
  }

  countLists(customerId: string): Promise<number> {
    return this.#t.lists.count({ customer_id: customerId });
  }

  insertList(row: ListRow): Promise<ListRow> {
    return this.#t.lists.insert(row);
  }

  async updateList(id: string, patch: Partial<ListRow>): Promise<ListRow> {
    return (await this.#t.lists.update(id, patch))!;
  }

  async deleteList(id: string): Promise<void> {
    await this.#t.lists.delete(id);
  }

  /* ---------------------------------------------------------------- items */
  getItem(customerId: string, id: string, lock?: Lock): Promise<ItemRow | undefined> {
    return this.#t.items.findOne({ id, customer_id: customerId }, { forUpdate: lock?.forUpdate });
  }

  findItem(listId: string, productId: string, variantId: string | null): Promise<ItemRow | undefined> {
    return this.#t.items.findOne({ list_id: listId, product_id: productId, variant_id: variantId });
  }

  /** A saved item of the customer for a product (and variant when given), default list first */
  async findCustomerItem(customerId: string, productId: string, variantId: string | null): Promise<ItemRow | undefined> {
    // default list first, then the oldest (two reads: the items, then which of their lists is the default)
    const items = await this.#t.items.find({ customer_id: customerId, product_id: productId, variant_id: variantId }, { sort: { added_at: 1 } });
    if (items.length <= 1) return items[0];
    const defaults = new Set((await this.#t.lists.find({ id: { $in: [...new Set(items.map((i) => i.list_id))] }, is_default: true })).map((l) => l.id));
    return items.find((i) => defaults.has(i.list_id)) ?? items[0];
  }

  countItems(listId: string): Promise<number> {
    return this.#t.items.count({ list_id: listId });
  }

  insertItem(row: ItemRow): Promise<ItemRow> {
    return this.#t.items.insert(row);
  }

  async updateItem(id: string, patch: Partial<ItemRow>): Promise<ItemRow> {
    return (await this.#t.items.update(id, patch))!;
  }

  async deleteItem(id: string): Promise<void> {
    await this.#t.items.delete(id);
  }

  /** Items of a list, newest first */
  pageItems(listId: string, page: PageRequest): Promise<Page<ItemRow>> {
    return this.#t.items.page({ list_id: listId }, page, { column: 'added_at', direction: 'desc' });
  }

  allItems(listId: string, limit: number): Promise<ItemRow[]> {
    return this.#t.items.find({ list_id: listId }, { sort: { added_at: -1, id: -1 }, limit });
  }

  savedProductIds(customerId: string, productIds: string[]): Promise<string[]> {
    return this.#t.items.distinct<string>('product_id', { customer_id: customerId, product_id: { $in: productIds } });
  }

  async countSavers(productId: string): Promise<number> {
    return (await this.#t.items.distinct('customer_id', { product_id: productId })).length;
  }

  itemsOfProduct(productId: string): Promise<ItemRow[]> {
    return this.#t.items.find({ product_id: productId });
  }

  /** Clears the saved offer of every item that saved it; returns how many */
  clearOffer(offerId: string): Promise<number> {
    return this.#t.items.updateMany({ offer_id: offerId }, { offer_id: null });
  }

  /** Product ids saved or watched with a variant (stock events name the variant only) */
  async productIdsForVariant(variantId: string): Promise<string[]> {
    const [fromAlerts, fromItems] = await Promise.all([this.#t.alerts.distinct<string>('product_id', { variant_id: variantId }), this.#t.items.distinct<string>('product_id', { variant_id: variantId })]);
    return [...new Set([...fromAlerts, ...fromItems])];
  }

  /* ---------------------------------------------------------------- alerts */
  getAlert(customerId: string, id: string, lock?: Lock): Promise<AlertRow | undefined> {
    return this.#t.alerts.findOne({ id, customer_id: customerId }, { forUpdate: lock?.forUpdate });
  }

  getAlertById(id: string, lock?: Lock): Promise<AlertRow | undefined> {
    return this.#t.alerts.get(id, { forUpdate: lock?.forUpdate });
  }

  /** Alerts (not removed) of the given items */
  alertsOfItems(itemIds: string[]): Promise<AlertRow[]> {
    return this.#t.alerts.find({ item_id: { $in: itemIds }, state: { $ne: 'removed' } });
  }

  /** The customer's alerts that are not removed, newest first */
  pageAlerts(customerId: string, state: AlertState | undefined, page: PageRequest): Promise<Page<AlertRow>> {
    return this.#t.alerts.page({ customer_id: customerId, state: state ?? { $ne: 'removed' } }, page, { column: 'created_at', direction: 'desc' });
  }

  allAlerts(customerId: string, limit: number): Promise<AlertRow[]> {
    return this.#t.alerts.find({ customer_id: customerId, state: { $ne: 'removed' } }, { sort: { created_at: -1, id: -1 }, limit });
  }

  countActiveAlerts(customerId: string): Promise<number> {
    return this.#t.alerts.count({ customer_id: customerId, state: 'active' });
  }

  /** An equivalent alert that is not removed (same product, variant, seller and kind) */
  findEquivalentAlert(customerId: string, a: { productId: string; variantId: string | null; sellerId: string | null; kind: AlertKind }): Promise<AlertRow | undefined> {
    return this.#t.alerts.findOne(
      { customer_id: customerId, product_id: a.productId, kind: a.kind, state: { $ne: 'removed' }, variant_id: a.variantId, seller_id: a.sellerId },
      { sort: { created_at: 1 } },
    );
  }

  insertAlert(row: AlertRow): Promise<AlertRow> {
    return this.#t.alerts.insert(row);
  }

  async updateAlert(id: string, patch: Partial<AlertRow>): Promise<AlertRow> {
    return (await this.#t.alerts.update(id, patch))!;
  }

  /** Every alert of an item becomes removed and lets go of the item */
  removeAlertsOfItem(itemId: string): Promise<number> {
    return this.#t.alerts.updateMany({ item_id: itemId }, { state: 'removed', item_id: null });
  }

  /** Alerts of a product in the given states, with the saved offer of their item */
  async candidates(productId: string, kind: AlertKind | null, states: AlertState[]): Promise<AlertCandidate[]> {
    return this.#withItemOffer(await this.#t.alerts.find({ product_id: productId, state: { $in: states }, ...(kind ? { kind } : {}) }, { sort: { id: 1 } }));
  }

  /** Triggered price-drop alerts whose last notice is older than `before` */
  dueForRearm(before: Date, limit: number): Promise<AlertRow[]> {
    return this.#t.alerts.find({ kind: 'price_drop', state: 'triggered', $or: [{ last_notified_at: null }, { last_notified_at: { $lte: before } }] }, { sort: { id: 1 }, limit });
  }

  /** Customers with alerts paused for a reason */
  async customersPausedFor(reason: string, limit: number): Promise<string[]> {
    const rows = await this.#t.alerts.aggregate<{ _id: string }>([
      { $match: { state: 'paused', paused_reason: reason } },
      { $group: { _id: '$customer_id' } },
      { $sort: { _id: 1 } },
      { $limit: limit },
    ]);
    return rows.map((r) => r._id);
  }

  pausedFor(customerId: string, reason: string): Promise<AlertRow[]> {
    return this.#t.alerts.find({ customer_id: customerId, state: 'paused', paused_reason: reason });
  }

  /** Active alerts of a kind after an id, in id order (job batches) */
  async activeAlertsAfter(kind: AlertKind, afterId: string | null, limit: number): Promise<AlertCandidate[]> {
    return this.#withItemOffer(await this.#t.alerts.find({ kind, state: 'active', ...(afterId ? { id: { $gt: afterId } } : {}) }, { sort: { id: 1 }, limit }));
  }

  /* ---------------------------------------------------------------- customer data */
  /** Every list, item and alert (not removed) of the customer ids */
  async customerData(customerIds: string[]): Promise<{ lists: ListRow[]; items: ItemRow[]; alerts: AlertRow[] }> {
    // read outside transactions (the customer data export): the three at once
    const [lists, items, alerts] = await Promise.all([
      this.#t.lists.find({ customer_id: { $in: customerIds } }, { sort: { created_at: 1, id: 1 } }),
      this.#t.items.find({ customer_id: { $in: customerIds } }, { sort: { added_at: 1, id: 1 } }),
      this.#t.alerts.find({ customer_id: { $in: customerIds }, state: { $ne: 'removed' } }, { sort: { created_at: 1, id: 1 } }),
    ]);
    return { lists, items, alerts };
  }

  /** Deletes every alert, item and list of the customer ids */
  async deleteCustomerData(customerIds: string[]): Promise<{ lists: number; items: number; alerts: number }> {
    const alerts = await this.#t.alerts.deleteMany({ customer_id: { $in: customerIds } });
    const items = await this.#t.items.deleteMany({ customer_id: { $in: customerIds } });
    const lists = await this.#t.lists.deleteMany({ customer_id: { $in: customerIds } });
    return { alerts, items, lists };
  }

  /* ---------------------------------------------------------------- insights */
  async insights({ from, to, limit }: { from?: Date; to?: Date; limit: number }): Promise<InsightRow[]> {
    const added = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
    const [savedRows, alertRows] = await Promise.all([
      this.#t.items.aggregate<{ _id: string; saves: number }>([
        ...(from || to ? [{ $match: { added_at: added } }] : []),
        { $group: { _id: { p: '$product_id', c: '$customer_id' } } },
        { $group: { _id: '$_id.p', saves: { $sum: 1 } } },
      ]),
      this.#t.alerts.aggregate<{ _id: string; price: number; stock: number }>([
        { $match: { state: 'active' } },
        {
          $group: {
            _id: '$product_id',
            price: { $sum: { $cond: [{ $eq: ['$kind', 'price_drop'] }, 1, 0] } },
            stock: { $sum: { $cond: [{ $eq: ['$kind', 'back_in_stock'] }, 1, 0] } },
          },
        },
      ]),
    ]);
    const out = new Map<string, { product_id: string; saves: number; active_price_alerts: number; active_stock_alerts: number }>();
    const row = (id: string) => {
      let r = out.get(id);
      if (!r) out.set(id, (r = { product_id: id, saves: 0, active_price_alerts: 0, active_stock_alerts: 0 }));
      return r;
    };
    for (const s of savedRows) row(s._id).saves = s.saves;
    for (const a of alertRows) {
      const r = row(a._id);
      r.active_price_alerts = a.price;
      r.active_stock_alerts = a.stock;
    }
    return [...out.values()]
      .sort((a, b) => b.saves - a.saves || b.active_price_alerts + b.active_stock_alerts - (a.active_price_alerts + a.active_stock_alerts) || a.product_id.localeCompare(b.product_id))
      .slice(0, limit);
  }

  /** Alerts with the saved offer of their item (a left join: two reads) */
  async #withItemOffer(alerts: AlertRow[]): Promise<AlertCandidate[]> {
    const itemIds = [...new Set(alerts.map((a) => a.item_id).filter((id): id is string => id !== null))];
    const offers = new Map((await this.#t.items.getMany(itemIds)).map((i) => [i.id, i.offer_id]));
    return alerts.map((a) => ({ ...a, item_offer_id: a.item_id ? (offers.get(a.item_id) ?? null) : null }));
  }
}
