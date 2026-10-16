import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import { orThrow } from '../../kernel/lib/or-throw.js';
import type { Filter, ModuleStore } from '../../kernel/mongo/index.js';
import { groupBy } from './domain/rules.js';
import type { AdminCartFilter, CartAggregate, CartRow, ItemMatch, ItemRow, Lock, MergeRow, NoticeRow, OwnerKey, QueueRow, SavedRow } from './ports.js';

const ownerFilter = (owner: OwnerKey): Filter =>
  owner.kind === 'customer' ? { owner_kind: 'customer', customer_id: owner.customerId } : { owner_kind: 'guest', guest_session_id: owner.guestSessionId };

/** cart.carts, cart.cart_items, cart.cart_item_notices, cart.saved_items, cart.cart_merges, cart.recheck_queue (MongoDB, docs/04-mongodb-migration.md) */
export class CartRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
      carts: store.table<CartRow>('carts'),
      items: store.table<ItemRow>('cart_items'),
      notices: store.table<NoticeRow>('cart_item_notices'),
      saved: store.table<SavedRow>('saved_items'),
      merges: store.table<MergeRow>('cart_merges'),
      queue: store.table<QueueRow>('recheck_queue'),
    };
  }

  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: CartRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new CartRepository(tx)));
  }

  /** Line count, subtotal of lines without an open blocking notice and open notice count per cart (two reads instead of the subqueries) */
  async #aggregates(carts: CartRow[]): Promise<CartAggregate[]> {
    if (!carts.length) return [];
    const items = await this.#t.items.find({ cart_id: { $in: carts.map((c) => c.id) } });
    const open = items.length ? await this.#t.notices.find({ item_id: { $in: items.map((i) => i.id) }, resolved_at: null }) : [];
    const blocked = new Set(open.filter((n) => n.severity === 'blocking').map((n) => n.item_id));
    const openPerItem = new Map<string, number>();
    for (const n of open) openPerItem.set(n.item_id, (openPerItem.get(n.item_id) ?? 0) + 1);
    const linesOf = groupBy(items, (i) => i.cart_id);
    return carts.map((cart) => {
      const lines = linesOf.get(cart.id) ?? [];
      return {
        cart,
        itemCount: lines.reduce((s, i) => s + i.quantity, 0),
        itemsSubtotal: lines.filter((i) => !blocked.has(i.id)).reduce((s, i) => s + i.quantity * i.accepted_price, 0),
        openNotices: lines.reduce((s, i) => s + (openPerItem.get(i.id) ?? 0), 0),
      };
    });
  }

  /* ---------------------------------------------------------------- carts */

  getActiveCart(owner: OwnerKey, lock?: Lock): Promise<CartRow | undefined> {
    return this.#t.carts.findOne({ status: 'active', ...ownerFilter(owner) }, { forUpdate: lock?.forUpdate });
  }

  getCart(id: string, lock?: Lock): Promise<CartRow | undefined> {
    return this.#t.carts.get(id, { forUpdate: lock?.forUpdate });
  }

  getCarts(ids: string[]): Promise<CartRow[]> {
    return this.#t.carts.getMany(ids);
  }

  /** The most recent cart of a guest session in any status (active first) */
  async getGuestCart(guestSessionId: string, lock?: Lock): Promise<CartRow | undefined> {
    const owner = { owner_kind: 'guest', guest_session_id: guestSessionId };
    return (
      (await this.#t.carts.findOne({ ...owner, status: 'active' }, { sort: { updated_at: -1 }, forUpdate: lock?.forUpdate })) ??
      this.#t.carts.findOne(owner, { sort: { updated_at: -1 }, forUpdate: lock?.forUpdate })
    );
  }

  /**
   * undefined when the owner already has an active cart: one active cart per owner (unique partial indexes), so
   * two first adds racing for the same owner create one cart.
   */
  insertCart(row: CartRow): Promise<CartRow | undefined> {
    return this.#t.carts.insertIfAbsent(row);
  }

  async updateCart(id: string, patch: Partial<CartRow>): Promise<CartRow> {
    return orThrow(await this.#t.carts.update(id, patch), `cart: cart ${id}`);
  }

  /** Active carts idle past their expiry */
  listExpiredCarts(now: Date, limit: number): Promise<CartRow[]> {
    return this.#t.carts.find({ status: 'active', expires_at: { $lte: now } }, { sort: { expires_at: 1 }, limit });
  }

  async listCartsAdmin(filter: AdminCartFilter, page: PageRequest): Promise<Page<CartAggregate>> {
    const res = await this.#t.carts.page(
      {
        ...(filter.customerId ? { customer_id: filter.customerId } : {}),
        ...(filter.guestSessionId ? { guest_session_id: filter.guestSessionId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      page,
      { column: 'updated_at', direction: 'desc' },
    );
    return { ...res, items: await this.#aggregates(res.items) };
  }

  async aggregateCart(cartId: string): Promise<CartAggregate | undefined> {
    const cart = await this.#t.carts.get(cartId);
    return cart ? (await this.#aggregates([cart]))[0] : undefined;
  }

  /* ---------------------------------------------------------------- lines */

  listItems(cartId: string): Promise<ItemRow[]> {
    return this.#t.items.find({ cart_id: cartId }, { sort: { added_at: 1, id: 1 } });
  }

  getItem(cartId: string, itemId: string, lock?: Lock): Promise<ItemRow | undefined> {
    return this.#t.items.findOne({ cart_id: cartId, id: itemId }, { forUpdate: lock?.forUpdate });
  }

  getItemByOffer(cartId: string, offerId: string): Promise<ItemRow | undefined> {
    return this.#t.items.findOne({ cart_id: cartId, offer_id: offerId });
  }

  countItems(cartId: string): Promise<number> {
    return this.#t.items.count({ cart_id: cartId });
  }

  insertItem(row: ItemRow): Promise<ItemRow> {
    return this.#t.items.insert(row);
  }

  async updateItem(id: string, patch: Partial<ItemRow>): Promise<ItemRow> {
    return orThrow(await this.#t.items.update(id, patch), `cart: cart item ${id}`);
  }

  /** Stamps the check time on lines that need no other change (one write for all of them) */
  async markChecked(itemIds: string[], at: Date): Promise<void> {
    if (!itemIds.length) return;
    await this.#t.items.updateMany({ id: { $in: itemIds } }, { last_checked_at: at });
  }

  /** Moves lines to another cart (merge) */
  async moveItems(itemIds: string[], toCartId: string, at: Date): Promise<void> {
    if (!itemIds.length) return;
    await this.#t.items.updateMany({ id: { $in: itemIds } }, { cart_id: toCartId, updated_at: at });
  }

  /** Deletes lines with their notices and queue entries */
  async deleteItems(itemIds: string[]): Promise<void> {
    if (!itemIds.length) return;
    await this.#t.queue.deleteMany({ item_id: { $in: itemIds } });
    await this.#t.notices.deleteMany({ item_id: { $in: itemIds } });
    await this.#t.items.deleteMany({ id: { $in: itemIds } });
  }

  /** Lines by id (any cart) */
  getItemsByIds(itemIds: string[]): Promise<ItemRow[]> {
    return this.#t.items.getMany(itemIds);
  }

  /** Lines of active carts matching any of the given ids */
  async findActiveItems(match: ItemMatch): Promise<ItemRow[]> {
    const or: Filter[] = [];
    if (match.offerIds?.length) or.push({ offer_id: { $in: match.offerIds } });
    if (match.stockItemIds?.length) or.push({ stock_item_id: { $in: match.stockItemIds } });
    if (match.sellerIds?.length) or.push({ seller_id: { $in: match.sellerIds } });
    if (match.productIds?.length) or.push({ product_id: { $in: match.productIds } });
    if (!or.length) return [];
    const items = await this.#t.items.find({ $or: or });
    if (!items.length) return [];
    const active = new Set(await this.#t.carts.distinct<string>('id', { id: { $in: [...new Set(items.map((i) => i.cart_id))] }, status: 'active' }));
    return items.filter((i) => active.has(i.cart_id));
  }

  async countActiveCartsWithOffer(offerId: string): Promise<number> {
    const cartIds = await this.#t.items.distinct<string>('cart_id', { offer_id: offerId });
    return cartIds.length ? this.#t.carts.count({ id: { $in: cartIds }, status: 'active' }) : 0;
  }

  /* ---------------------------------------------------------------- notices */

  listNotices(itemIds: string[]): Promise<NoticeRow[]> {
    return this.#t.notices.find({ item_id: { $in: itemIds } }, { sort: { detected_at: 1, id: 1 } });
  }

  insertNotices(rows: NoticeRow[]): Promise<void> {
    return this.#t.notices.insertMany(rows);
  }

  async resolveNotices(ids: string[], at: Date): Promise<void> {
    if (!ids.length) return;
    await this.#t.notices.updateMany({ id: { $in: ids }, resolved_at: null }, { resolved_at: at });
  }

  async acceptNotices(ids: string[], at: Date): Promise<void> {
    if (!ids.length) return;
    await this.#t.notices.updateMany({ id: { $in: ids }, resolved_at: null }, { accepted_at: at, resolved_at: at });
  }

  /** The badge: units in the cart and lines with an open warning or blocking notice (two reads) */
  async badgeCounts(cartId: string): Promise<{ itemCount: number; attentionCount: number }> {
    const items = await this.#t.items.find({ cart_id: cartId });
    if (!items.length) return { itemCount: 0, attentionCount: 0 };
    const attention = await this.#t.notices.distinct<string>('item_id', { item_id: { $in: items.map((i) => i.id) }, resolved_at: null, severity: { $in: ['warning', 'blocking'] } });
    return { itemCount: items.reduce((s, i) => s + i.quantity, 0), attentionCount: attention.length };
  }

  /* ---------------------------------------------------------------- merges */

  async insertMerge(row: MergeRow): Promise<void> {
    await this.#t.merges.insert(row);
  }

  getMergeFrom(fromCartId: string): Promise<MergeRow | undefined> {
    return this.#t.merges.findOne({ from_cart_id: fromCartId }, { sort: { at: -1 } });
  }

  listMerges(cartId: string): Promise<MergeRow[]> {
    return this.#t.merges.find({ $or: [{ from_cart_id: cartId }, { into_cart_id: cartId }] }, { sort: { at: -1 } });
  }

  /* ---------------------------------------------------------------- recheck queue */

  async enqueue(itemIds: string[], reason: string, at: Date): Promise<void> {
    if (!itemIds.length) return;
    await this.#t.queue.upsertMany([...new Set(itemIds)].map((item_id) => ({ item_id, reason, queued_at: at })));
  }

  takeQueue(limit: number): Promise<QueueRow[]> {
    return this.#t.queue.find({}, { sort: { queued_at: 1 }, limit });
  }

  async dequeue(itemIds: string[]): Promise<void> {
    if (!itemIds.length) return;
    await this.#t.queue.deleteMany({ item_id: { $in: itemIds } });
  }

  /* ---------------------------------------------------------------- saved for later */

  listSaved(owner: OwnerKey, page: PageRequest): Promise<Page<SavedRow>> {
    return this.#t.saved.page(ownerFilter(owner), page, { column: 'saved_at', direction: 'desc' });
  }

  getSaved(owner: OwnerKey, id: string): Promise<SavedRow | undefined> {
    return this.#t.saved.findOne({ id, ...ownerFilter(owner) });
  }

  findSavedByOffer(owner: OwnerKey, offerId: string): Promise<SavedRow | undefined> {
    return this.#t.saved.findOne({ offer_id: offerId, ...ownerFilter(owner) });
  }

  countSaved(owner: OwnerKey): Promise<number> {
    return this.#t.saved.count(ownerFilter(owner));
  }

  async insertSaved(row: SavedRow): Promise<void> {
    await this.#t.saved.insert(row);
  }

  async updateSaved(id: string, patch: Partial<SavedRow>): Promise<void> {
    await this.#t.saved.update(id, patch);
  }

  async deleteSaved(id: string): Promise<void> {
    await this.#t.saved.delete(id);
  }

  /**
   * Moves a guest session's saved items to a customer (sign-in merge): an offer the customer already
   * saved keeps the customer's row and drops the guest's (unique customer_id, offer_id). Returns how many rows moved.
   */
  async moveGuestSaved(guestSessionId: string, customerId: string): Promise<number> {
    const guest = { owner_kind: 'guest', guest_session_id: guestSessionId };
    const customerOffers = await this.#t.saved.distinct<string>('offer_id', { owner_kind: 'customer', customer_id: customerId });
    if (customerOffers.length) await this.#t.saved.deleteMany({ ...guest, offer_id: { $in: customerOffers } });
    return this.#t.saved.updateMany(guest, { owner_kind: 'customer', customer_id: customerId, guest_session_id: null });
  }
}
