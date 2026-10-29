import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import { orThrow } from '../../kernel/lib/or-throw.js';
import type { Store, Where } from '../../kernel/store/index.js';
import { groupBy } from './domain/rules.js';
import type { AdminCartFilter, CartAggregate, CartRow, ItemMatch, ItemRow, Lock, MergeRow, NoticeRow, OwnerKey, QueueRow, SavedRow } from './ports.js';

/** The owner's columns, shared by carts and saved_items (both carry owner_kind, customer_id and guest_session_id) */
const ownerFilter = (owner: OwnerKey): Where<CartRow> & Where<SavedRow> =>
  owner.kind === 'customer' ? { owner_kind: 'customer', customer_id: owner.customerId } : { owner_kind: 'guest', guest_session_id: owner.guestSessionId };

/**
 * cart.carts, cart.cart_items, cart.cart_item_notices, cart.saved_items, cart.cart_merges, cart.recheck_queue,
 * in the one vocabulary both databases understand (BUILDING-MODULES.md §5c): `ctx.store` is MongoDB or MySQL,
 * decided at boot by MYSQL_MODULES, and this file reads the same either way. No read here needs a join, a
 * window, a group with more than a count or a money total, so cart has no per-store queries port (docs/10 §10.5e).
 *
 * **Lock order (§11.2 rule 3): the cart, then its lines, then their notices and queue entries.** Every
 * transaction that writes a cart's lines locks the cart row first, even the ones that only delete a line and
 * stamp the cart afterwards, so two writers of one cart never hold half of each other's rows. The one place
 * that goes the other way is `deleteItems`, where the foreign keys refuse to let a line go while a notice or a
 * queue entry points at it — the cart's lock above it is what keeps that from meeting the order written here.
 */
export class CartRepository {
  readonly #t;

  constructor(private readonly store: Store) {
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
    const items = await this.#t.items.find({ cart_id: carts.map((c) => c.id) });
    const open = items.length ? await this.#t.notices.find({ item_id: items.map((i) => i.id), resolved_at: null }) : [];
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
    const owner = { owner_kind: 'guest' as const, guest_session_id: guestSessionId };
    return (
      (await this.#t.carts.findOne({ ...owner, status: 'active' }, { sort: { updated_at: -1 }, forUpdate: lock?.forUpdate })) ??
      this.#t.carts.findOne(owner, { sort: { updated_at: -1 }, forUpdate: lock?.forUpdate })
    );
  }

  /**
   * undefined when the owner already has an active cart: one active cart per owner (unique partial indexes), so
   * two first adds racing for the same owner create one cart.
   *
   * No key is named, which is the portable spelling (§5c): both indexes are partial — `unique (customer_id)
   * where status = 'active'` — which the two databases spell differently (a functional unique index in MySQL,
   * a partial one in MongoDB), so naming `['customer_id']` would be no key of the MySQL table and would make
   * MongoDB match a cart that is no longer active. With none named, both stores check every unique index the
   * spec gives the table.
   */
  insertCart(row: CartRow): Promise<CartRow | undefined> {
    return this.#t.carts.insertIfAbsent(row);
  }

  async updateCart(id: string, patch: Partial<CartRow>): Promise<CartRow> {
    return orThrow(await this.#t.carts.update(id, patch), `cart: cart ${id}`);
  }

  /**
   * Active carts idle past their expiry. `expires_at` is NOT NULL, so "has no expiry" is not a case here; and a
   * date comparison matches no null on either store anyway (MongoDB's query operators are type-bracketed), so
   * this needs no `is not null` beside it.
   *
   * It is a pre-filter: `expireIdle` reads each cart again under its own lock and checks `expires_at > now`
   * there, so a comparison too generous here expires nothing it should not, and no test can tell it from this
   * one. A comparison the wrong way round is caught, because then a due cart is never listed at all.
   */
  listExpiredCarts(now: Date, limit: number): Promise<CartRow[]> {
    return this.#t.carts.find({ status: 'active', expires_at: { op: '<=', value: now } }, { sort: { expires_at: 1 }, limit });
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

  listItems(cartId: string, lock?: Lock): Promise<ItemRow[]> {
    return this.#t.items.find({ cart_id: cartId }, { sort: { added_at: 1, id: 1 }, forUpdate: lock?.forUpdate });
  }

  getItem(cartId: string, itemId: string, lock?: Lock): Promise<ItemRow | undefined> {
    return this.#t.items.findOne({ cart_id: cartId, id: itemId }, { forUpdate: lock?.forUpdate });
  }

  getItemByOffer(cartId: string, offerId: string, lock?: Lock): Promise<ItemRow | undefined> {
    return this.#t.items.findOne({ cart_id: cartId, offer_id: offerId }, { forUpdate: lock?.forUpdate });
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
    await this.#t.items.updateMany({ id: itemIds }, { last_checked_at: at });
  }

  /** Moves lines to another cart (merge) */
  async moveItems(itemIds: string[], toCartId: string, at: Date): Promise<void> {
    if (!itemIds.length) return;
    await this.#t.items.updateMany({ id: itemIds }, { cart_id: toCartId, updated_at: at });
  }

  /** Deletes lines with their notices and queue entries (children first: both carry a foreign key to the line) */
  async deleteItems(itemIds: string[]): Promise<void> {
    if (!itemIds.length) return;
    await this.#t.queue.deleteMany({ item_id: itemIds });
    await this.#t.notices.deleteMany({ item_id: itemIds });
    await this.#t.items.deleteMany({ id: itemIds });
  }

  /** Lines by id (any cart) */
  getItemsByIds(itemIds: string[]): Promise<ItemRow[]> {
    return this.#t.items.getMany(itemIds);
  }

  /**
   * Lines of active carts matching any of the given ids. Every caller today asks about one kind of id (an
   * offer, a stock item, a seller or a product), so the `or` has one branch in every test there is; it is
   * written as an `or` because the event handlers' shape invites a second one.
   */
  async findActiveItems(match: ItemMatch): Promise<ItemRow[]> {
    const or: Where<ItemRow>[] = [];
    if (match.offerIds?.length) or.push({ offer_id: match.offerIds });
    if (match.stockItemIds?.length) or.push({ stock_item_id: match.stockItemIds });
    if (match.sellerIds?.length) or.push({ seller_id: match.sellerIds });
    if (match.productIds?.length) or.push({ product_id: match.productIds });
    if (!or.length) return [];
    const items = await this.#t.items.find({ or });
    if (!items.length) return [];
    const active = new Set(await this.#t.carts.distinct<string>('id', { id: [...new Set(items.map((i) => i.cart_id))], status: 'active' }));
    return items.filter((i) => active.has(i.cart_id));
  }

  async countActiveCartsWithOffer(offerId: string): Promise<number> {
    const cartIds = await this.#t.items.distinct<string>('cart_id', { offer_id: offerId });
    return cartIds.length ? this.#t.carts.count({ id: cartIds, status: 'active' }) : 0;
  }

  /* ---------------------------------------------------------------- notices */

  listNotices(itemIds: string[], lock?: Lock): Promise<NoticeRow[]> {
    return this.#t.notices.find({ item_id: itemIds }, { sort: { detected_at: 1, id: 1 }, forUpdate: lock?.forUpdate });
  }

  insertNotices(rows: NoticeRow[]): Promise<void> {
    return this.#t.notices.insertMany(rows);
  }

  async resolveNotices(ids: string[], at: Date): Promise<void> {
    if (!ids.length) return;
    await this.#t.notices.updateMany({ id: ids, resolved_at: null }, { resolved_at: at });
  }

  async acceptNotices(ids: string[], at: Date): Promise<void> {
    if (!ids.length) return;
    await this.#t.notices.updateMany({ id: ids, resolved_at: null }, { accepted_at: at, resolved_at: at });
  }

  /** The badge: units in the cart and lines with an open warning or blocking notice (two reads) */
  async badgeCounts(cartId: string): Promise<{ itemCount: number; attentionCount: number }> {
    const items = await this.#t.items.find({ cart_id: cartId });
    if (!items.length) return { itemCount: 0, attentionCount: 0 };
    const attention = await this.#t.notices.distinct<string>('item_id', { item_id: items.map((i) => i.id), resolved_at: null, severity: ['warning', 'blocking'] });
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
    return this.#t.merges.find({ or: [{ from_cart_id: cartId }, { into_cart_id: cartId }] }, { sort: { at: -1 } });
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
    await this.#t.queue.deleteMany({ item_id: itemIds });
  }

  /* ---------------------------------------------------------------- saved for later */

  listSaved(owner: OwnerKey, page: PageRequest): Promise<Page<SavedRow>> {
    return this.#t.saved.page(ownerFilter(owner), page, { column: 'saved_at', direction: 'desc' });
  }

  getSaved(owner: OwnerKey, id: string): Promise<SavedRow | undefined> {
    return this.#t.saved.findOne({ id, ...ownerFilter(owner) });
  }

  findSavedByOffer(owner: OwnerKey, offerId: string, lock?: Lock): Promise<SavedRow | undefined> {
    return this.#t.saved.findOne({ offer_id: offerId, ...ownerFilter(owner) }, { forUpdate: lock?.forUpdate });
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
    if (customerOffers.length) await this.#t.saved.deleteMany({ ...guest, offer_id: customerOffers });
    return this.#t.saved.updateMany(guest, { owner_kind: 'customer', customer_id: customerId, guest_session_id: null });
  }
}
