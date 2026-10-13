import { AppError, isAppError } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import { isUuid, newId } from '../../kernel/lib/ids.js';
import { money } from '../../kernel/lib/money.js';
import { pageOf, toPageRequest, type PageRequest } from '../../kernel/lib/pagination.js';
import { secretFor } from '../../kernel/lib/secrets.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as catalog from '../../spec/catalog.js';
import type * as common from '../../spec/common.js';
import type * as offers from '../../spec/offers.js';
import type { Alert, AlertInput, AlertToggle, SavedItem, SaveItemInput, SharedList, WishlistList, WishlistPage, WishlistPublicApi } from '../../spec/wishlist.js';
import { AlertEngine, type Change } from './alerts.js';
import { wishlistAlertMachine } from './domain/state-machines.js';
import {
  DELIVERY_NOTE,
  firstName,
  MAX_LIST_NAME,
  MAX_NOTE,
  MAX_SAVED_STATUS_IDS,
  newShareId,
  PAUSED,
  SHARED_LIST_ITEMS,
  SHOWABLE_OFFER_STATUSES,
  UNAVAILABLE_PUBLICATIONS,
  verifyShareToken,
} from './domain/rules.js';
import type { AlertKind, AlertRow, AlertState, ItemRow, ListRow } from './ports.js';
import type { WishlistRepository } from './repository.js';
import { Lookups, Views, type ItemDetail } from './views.js';

export interface WishlistServiceDeps {
  repo: WishlistRepository;
  ctx: ModuleContext<'wishlist'>;
}

export interface By {
  actor: common.Actor;
  requestId?: string;
}

const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });

/** Statuses that end an offer for good: saved offer ids are cleared */
const CLOSED_OFFER = new Set(['removed']);

/**
 * Wishlist use cases. Depends only on its repository, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/wishlist.json.
 */
export class WishlistService implements WishlistPublicApi {
  readonly views: Views;
  readonly engine: AlertEngine;

  constructor(protected readonly deps: WishlistServiceDeps) {
    this.views = new Views(deps.ctx);
    this.engine = new AlertEngine(deps.ctx, deps.repo);
  }

  private get ctx() {
    return this.deps.ctx;
  }
  private get repo() {
    return this.deps.repo;
  }
  private now() {
    return this.ctx.clock.now();
  }

  /** The sellers public API when sellers is on (GraphQL WishlistAlert.seller) */
  sellers() {
    return this.ctx.tryUse('sellers');
  }

  /* ================================================================ public API (in-process) */

  /** How many customers saved a product (aggregate only, for reports and Official Store planning). */
  async savedCount(productId: string): Promise<number> {
    return isUuid(productId) ? this.repo.countSavers(productId) : 0;
  }

  /** Saved state for product cards rendered by other modules. */
  async isSaved(customerId: string, productIds: string[]): Promise<Record<string, boolean>> {
    const valid = productIds.filter(isUuid);
    const saved = new Set(isUuid(customerId) && valid.length ? await this.repo.savedProductIds(customerId, valid) : []);
    return Object.fromEntries(productIds.map((id) => [id, saved.has(id)]));
  }

  /** Saved items of a list (default list when omitted) with price hints and alert toggles (GET /wishlist, GET /lists/{id}/items). */
  async listItems(customerId: string, opts: { listId?: string; paging: common.PageInput }): Promise<common.Page<SavedItem>> {
    const page = await this.listItemDetails(customerId, opts.listId, {}, toPageRequest(opts.paging));
    return { ...page, items: page.items.map((d) => d.item) };
  }

  /** The customer's lists with item counts and share state (GET /lists). */
  async listLists(customerId: string): Promise<WishlistList[]> {
    await this.defaultList(customerId);
    return (await this.repo.listLists(customerId)).map((l) => this.views.list(l));
  }

  /** The customer's price-drop and back-in-stock alerts (GET /alerts). */
  async listAlerts(customerId: string): Promise<Alert[]> {
    if (!isUuid(customerId)) return [];
    return this.views.alerts(await this.repo.allAlerts(customerId, 500));
  }

  /* ================================================================ lists */

  /** The default list, created on first use */
  async defaultList(customerId: string): Promise<ListRow> {
    const now = this.now();
    return this.repo.ensureDefaultList({ id: newId(), customer_id: customerId, name: 'Wishlist', is_default: true, share_token: null, created_at: now, updated_at: now });
  }

  private async ownList(customerId: string, listId: string | null | undefined): Promise<ListRow> {
    if (!listId) return this.defaultList(customerId);
    const l = isUuid(listId) ? await this.repo.getList(customerId, listId) : undefined;
    if (!l) throw notFound('List');
    return l;
  }

  private async listView(customerId: string, l: ListRow): Promise<WishlistList> {
    return this.views.list(l, await this.repo.countItems(l.id));
  }

  private listName(name: string): string {
    const n = name.trim();
    if (!n) throw invalid('name', 'Give the list a name');
    if (n.length > MAX_LIST_NAME) throw invalid('name', `Use at most ${MAX_LIST_NAME} characters`);
    return n;
  }

  async createList(customerId: string, body: { name: string }): Promise<WishlistList> {
    const name = this.listName(body.name);
    await this.defaultList(customerId);
    const max = await this.ctx.settings.get('maxLists');
    const now = this.now();
    const row = await this.repo.transaction(async (tx) => {
      // the default list row serializes concurrent creates of one customer
      const def = await tx.ensureDefaultList({ id: newId(), customer_id: customerId, name: 'Wishlist', is_default: true, share_token: null, created_at: now, updated_at: now });
      await tx.getList(customerId, def.id, { forUpdate: true });
      if ((await tx.countLists(customerId)) >= max) throw this.ctx.error('LIST_LIMIT_REACHED', `You can have up to ${max} lists.`, { max });
      return tx.insertList({ id: newId(), customer_id: customerId, name, is_default: false, share_token: null, created_at: now, updated_at: now });
    });
    return this.views.list(row, 0);
  }

  async renameList(customerId: string, listId: string, body: { name: string }): Promise<WishlistList> {
    const name = this.listName(body.name);
    const l = await this.ownList(customerId, listId);
    const row = await this.repo.updateList(l.id, { name, updated_at: this.now() });
    return this.listView(customerId, row);
  }

  /** Deleting a named list deletes its items (and their alerts); the default list stays */
  async deleteList(customerId: string, listId: string, by: By): Promise<void> {
    const l = await this.ownList(customerId, listId);
    if (l.is_default) throw new AppError('ILLEGAL_TRANSITION', 'The default list cannot be deleted', { listId: l.id, isDefault: true });
    const removed = await this.repo.transaction(async (tx) => {
      const locked = await tx.getList(customerId, l.id, { forUpdate: true });
      if (!locked) throw notFound('List');
      const items = await tx.allItems(l.id, 100_000);
      for (const i of items) {
        await tx.removeAlertsOfItem(i.id);
        await tx.deleteItem(i.id);
      }
      await tx.deleteList(l.id);
      return items;
    });
    for (const i of removed) this.ctx.events.publish('wishlist.item.removed', { customerId, productId: i.product_id }, by);
  }

  /** A share link carries the list's share id with a signature; turning sharing off (or on again) kills old links */
  async shareList(customerId: string, listId: string, body: { enabled: boolean }): Promise<WishlistList> {
    const l = await this.ownList(customerId, listId);
    const want = Boolean(body.enabled);
    if (want === Boolean(l.share_token)) return this.listView(customerId, l);
    const row = await this.repo.updateList(l.id, { share_token: want ? newShareId() : null, updated_at: this.now() });
    return this.listView(customerId, row);
  }

  /** Read-only public view: names, pictures, current price and stock; no notes, price history, alerts or customer data */
  async getSharedList(token: string): Promise<SharedList> {
    const id = verifyShareToken(secretFor(this.ctx.config, 'wishlist.share'), token);
    const l = id ? await this.repo.getListByShareToken(id) : undefined;
    if (!l) throw notFound('Shared list');
    const rows = await this.repo.allItems(l.id, SHARED_LIST_ITEMS);
    const items = await this.views.items(rows, [], { publicView: true });
    const owner = await this.ctx
      .use('customers')
      .getCustomer(l.customer_id)
      .catch(() => null);
    const latest = rows.reduce((t, r) => Math.max(t, new Date(r.added_at).getTime()), new Date(l.updated_at).getTime());
    return { name: l.name, ownerFirstName: firstName(owner?.displayName), items: items.map((d) => d.item), updatedAt: new Date(latest).toISOString() };
  }

  /* ================================================================ wishlist page and items */

  async getWishlist(customerId: string, query: { listId?: string; limit?: number }): Promise<WishlistPage> {
    const list = await this.ownList(customerId, query.listId);
    const limit = query.limit && query.limit > 0 ? query.limit : undefined;
    const [lists, page, consent] = await Promise.all([
      this.listLists(customerId),
      this.listItemDetails(customerId, list.id, {}, toPageRequest(limit ? { limit } : undefined)),
      this.engine.consents([customerId]),
    ]);
    const enabled = consent.get(customerId) ?? false;
    // alerts paused while wishlist alerts were off come back as soon as the customer allows them again
    if (enabled) await this.engine.resumeConsented([customerId]);
    return {
      list: lists.find((l) => l.id === list.id) ?? this.views.list(list, 0),
      lists,
      items: page.items.map((d) => d.item),
      nextCursor: page.nextCursor ?? null,
      alerts: await this.listAlerts(customerId),
      deliveryNote: enabled ? DELIVERY_NOTE.on : DELIVERY_NOTE.off,
      alertsEnabledByPreference: enabled,
    };
  }

  /**
   * Items of a list. Newest first by default (keyset paging in the database); filters on stock and sorting by
   * price or drop use live prices, so the list (at most maxItemsPerList) is built and paged in memory.
   */
  async listItemDetails(
    customerId: string,
    listId: string | undefined,
    q: { availability?: 'in_stock' | 'out_of_stock'; sort?: 'added' | 'price_drop' | 'price' },
    page: PageRequest,
  ): Promise<common.Page<ItemDetail>> {
    if (!isUuid(customerId)) return { items: [], nextCursor: null };
    const list = await this.ownList(customerId, listId);
    if (!q.availability && (!q.sort || q.sort === 'added')) {
      const p = await this.repo.pageItems(list.id, page);
      return { ...p, items: await this.views.items(p.items, await this.repo.alertsOfItems(p.items.map((i) => i.id))) };
    }
    const rows = await this.repo.allItems(list.id, await this.ctx.settings.get('maxItemsPerList'));
    let all = await this.views.items(rows, await this.repo.alertsOfItems(rows.map((i) => i.id)));
    if (q.availability === 'in_stock') all = all.filter((d) => d.item.availability === 'in_stock' || d.item.availability === 'low_stock');
    if (q.availability === 'out_of_stock') all = all.filter((d) => d.item.availability === 'out_of_stock' || d.item.availability === 'unavailable');
    const priced = (d: ItemDetail) => d.item.price?.amount ?? Number.POSITIVE_INFINITY;
    const drop = (d: ItemDetail) => (d.item.price && d.item.priceWhenSaved ? d.item.priceWhenSaved.amount - d.item.price.amount : Number.NEGATIVE_INFINITY);
    if (q.sort === 'price') all = [...all].sort((a, b) => priced(a) - priced(b));
    if (q.sort === 'price_drop') all = [...all].sort((a, b) => drop(b) - drop(a));
    return pageOf(all, page);
  }

  /** Items in a list (default list when omitted), for totals */
  async countListItems(customerId: string, listId?: string): Promise<number> {
    return this.repo.countItems((await this.ownList(customerId, listId)).id);
  }

  async savedStatus(customerId: string, productIds: string): Promise<Record<string, boolean>> {
    const list = [...new Set(productIds.split(',').map((s) => s.trim()).filter(Boolean))];
    if (list.length > MAX_SAVED_STATUS_IDS) throw invalid('productIds', `Ask for at most ${MAX_SAVED_STATUS_IDS} products at a time`);
    return this.isSaved(customerId, list);
  }

  private async itemView(customerId: string, row: ItemRow, lk?: Lookups): Promise<SavedItem> {
    const [d] = await this.views.items([row], await this.repo.alertsOfItems([row.id]), { lookups: lk });
    return d!.item;
  }

  private async ownItem(customerId: string, id: string): Promise<ItemRow> {
    const i = isUuid(id) ? await this.repo.getItem(customerId, id) : undefined;
    if (!i) throw notFound('Saved item');
    return i;
  }

  /** Resolves what is being saved or watched: the product, its variant and offer, and the price shown now */
  private async target(lk: Lookups, input: { productId: string; variantId?: string | null; offerId?: string | null; sellerId?: string | null }) {
    const product = await lk.product(input.productId);
    if (!product) throw notFound('Product');
    if (input.variantId && !product.variants.some((v) => v.id === input.variantId)) throw invalid('variantId', 'This option is not part of the product');
    let offer: offers.Offer | null = null;
    if (input.offerId) {
      offer = await lk.offer(input.offerId);
      if (!offer || offer.productId !== product.id || (!SHOWABLE_OFFER_STATUSES.has(offer.status) && offer.status !== 'paused')) throw invalid('offerId', 'This offer is not available');
      if (input.variantId && offer.variantId !== input.variantId) throw invalid('offerId', 'This offer is for another option of the product');
    }
    const variantId = input.variantId ?? offer?.variantId ?? null;
    const shown = await lk.shownOffer(offer?.id ?? null, variantId ?? product.variants[0]?.id ?? null);
    return { product, offer, variantId, shown };
  }

  private async checkAlertRoom(customerId: string, adding: number) {
    if (adding <= 0) return;
    const max = await this.ctx.settings.get('maxActiveAlerts');
    if ((await this.repo.countActiveAlerts(customerId)) + adding > max) throw this.ctx.error('ALERT_LIMIT_REACHED', `You can have up to ${max} active alerts.`, { max });
  }

  /** `armedAt`: back-in-stock alerts, from engine.armedAtFor (read before the transaction); price-drop alerts are armed at once */
  private alertRow(customerId: string, a: { itemId: string | null; productId: string; variantId: string | null; sellerId: string | null; kind: AlertKind; targetPrice: number | null; referencePrice: number | null; armedAt?: Date | null }): AlertRow {
    return {
      id: newId(),
      customer_id: customerId,
      item_id: a.itemId,
      product_id: a.productId,
      variant_id: a.variantId,
      seller_id: a.sellerId,
      kind: a.kind,
      target_price: a.targetPrice,
      reference_price: a.kind === 'price_drop' ? a.referencePrice : null,
      state: wishlistAlertMachine.initial,
      triggered_at: null,
      triggered_price: null,
      paused_reason: null,
      last_notified_at: null,
      armed_at: a.kind === 'back_in_stock' ? (a.armedAt ?? null) : this.now(),
      created_at: this.now(),
    };
  }

  /** Save a product. Saving the same product and variant twice to a list returns the existing item. */
  async saveItem(customerId: string, body: SaveItemInput, by: By): Promise<SavedItem> {
    if (body.note && body.note.length > MAX_NOTE) throw invalid('note', `Use at most ${MAX_NOTE} characters`);
    const list = await this.ownList(customerId, body.listId);
    const lk = new Lookups(this.ctx);
    const { product, offer, variantId, shown } = await this.target(lk, body);
    const kinds: AlertKind[] = [...(body.priceDropAlert ? (['price_drop'] as const) : []), ...(body.backInStockAlert ? (['back_in_stock'] as const) : [])];
    const existing = await this.repo.findItem(list.id, product.id, variantId);
    if (existing) {
      if (kinds.length) await this.setItemAlerts(customerId, existing, { priceDrop: body.priceDropAlert ? true : undefined, backInStock: body.backInStockAlert ? true : undefined });
      return this.itemView(customerId, existing, lk);
    }
    await this.checkAlertRoom(customerId, kinds.length);
    const maxItems = await this.ctx.settings.get('maxItemsPerList');
    const now = this.now();
    const price = shown?.price ?? null;
    const sellerId = offer ? (offer.sellerId ?? null) : null;
    const armedAt = kinds.includes('back_in_stock') ? await this.engine.armedAtFor({ product_id: product.id, variant_id: variantId, seller_id: sellerId, item_offer_id: offer?.id ?? null }) : null;
    const { row, created } = await this.repo.transaction(async (tx) => {
      await tx.getList(customerId, list.id, { forUpdate: true });
      const again = await tx.findItem(list.id, product.id, variantId);
      if (again) return { row: again, created: false };
      if ((await tx.countItems(list.id)) >= maxItems) throw this.ctx.error('LIST_LIMIT_REACHED', `A list holds up to ${maxItems} items.`, { max: maxItems });
      const row = await tx.insertItem({
        id: newId(),
        list_id: list.id,
        customer_id: customerId,
        product_id: product.id,
        variant_id: variantId,
        offer_id: offer?.id ?? null,
        price_when_saved: price?.amount ?? null,
        currency: price?.currency ?? this.views.currency,
        note: body.note?.trim() || null,
        added_at: now,
      });
      for (const kind of kinds) {
        await tx.insertAlert(this.alertRow(customerId, { itemId: row.id, productId: product.id, variantId, sellerId, kind, targetPrice: null, referencePrice: price?.amount ?? null, armedAt }));
      }
      await tx.updateList(list.id, { updated_at: now });
      return { row, created: true };
    });
    if (created) this.ctx.events.publish('wishlist.item.saved', { customerId, productId: product.id, variantId }, by);
    return this.itemView(customerId, row, lk);
  }

  async removeItem(customerId: string, id: string, by: By): Promise<void> {
    const item = await this.ownItem(customerId, id);
    const gone = await this.repo.transaction(async (tx) => {
      const locked = await tx.getItem(customerId, item.id, { forUpdate: true });
      if (!locked) return null;
      await tx.removeAlertsOfItem(locked.id);
      await tx.deleteItem(locked.id);
      await tx.updateList(locked.list_id, { updated_at: this.now() });
      return locked;
    });
    if (gone) this.ctx.events.publish('wishlist.item.removed', { customerId, productId: gone.product_id }, by);
  }

  /** Move to another list; when that list already holds the product and variant, the two become one item */
  async moveItem(customerId: string, id: string, body: { listId: string }): Promise<SavedItem> {
    const item = await this.ownItem(customerId, id);
    const target = await this.ownList(customerId, body.listId);
    if (target.id === item.list_id) return this.itemView(customerId, item);
    const maxItems = await this.ctx.settings.get('maxItemsPerList');
    const now = this.now();
    const row = await this.repo.transaction(async (tx) => {
      await tx.getList(customerId, target.id, { forUpdate: true });
      const locked = await tx.getItem(customerId, item.id, { forUpdate: true });
      if (!locked) throw notFound('Saved item');
      const twin = await tx.findItem(target.id, locked.product_id, locked.variant_id);
      if (twin) {
        // keep the item already in the target list; carry over alerts it doesn't have yet
        const kept = new Set((await tx.alertsOfItems([twin.id])).map((a) => a.kind));
        for (const a of await tx.alertsOfItems([locked.id])) {
          if (kept.has(a.kind)) await tx.updateAlert(a.id, { state: wishlistAlertMachine.next(a.state as AlertState, 'remove') as string, item_id: null });
          else await tx.updateAlert(a.id, { item_id: twin.id });
        }
        await tx.deleteItem(locked.id);
        await tx.updateList(target.id, { updated_at: now });
        return twin;
      }
      if ((await tx.countItems(target.id)) >= maxItems) throw this.ctx.error('LIST_LIMIT_REACHED', `A list holds up to ${maxItems} items.`, { max: maxItems });
      const moved = await tx.updateItem(locked.id, { list_id: target.id });
      await tx.updateList(target.id, { updated_at: now });
      await tx.updateList(locked.list_id, { updated_at: now });
      return moved;
    });
    return this.itemView(customerId, row);
  }

  /** Turns an item's alerts on (armed at the price shown now) or off (removed) */
  private async setItemAlerts(customerId: string, item: ItemRow, want: { priceDrop?: boolean; backInStock?: boolean }) {
    const current = await this.repo.alertsOfItems([item.id]);
    const has = (k: AlertKind) => current.some((a) => a.kind === k);
    const adding = (['price_drop', 'back_in_stock'] as const).filter((k) => (k === 'price_drop' ? want.priceDrop : want.backInStock) === true && !has(k));
    const dropping = current.filter((a) => (a.kind === 'price_drop' ? want.priceDrop : want.backInStock) === false);
    if (!adding.length && !dropping.length) return;
    await this.checkAlertRoom(customerId, adding.length);
    let reference: number | null = null;
    let sellerId: string | null = null;
    let armedAt: Date | null = null;
    if (adding.length) {
      const lk = new Lookups(this.ctx);
      const product = await lk.product(item.product_id);
      const shown = await lk.shownOffer(item.offer_id, item.variant_id ?? product?.variants[0]?.id ?? null);
      reference = shown?.price.amount ?? item.price_when_saved;
      sellerId = item.offer_id ? ((await lk.offer(item.offer_id))?.sellerId ?? null) : null;
      if (adding.includes('back_in_stock')) armedAt = await this.engine.armedAtFor({ product_id: item.product_id, variant_id: item.variant_id, seller_id: sellerId, item_offer_id: item.offer_id });
    }
    await this.repo.transaction(async (tx) => {
      const locked = await tx.getItem(customerId, item.id, { forUpdate: true });
      if (!locked) throw notFound('Saved item');
      for (const a of dropping) {
        const row = await tx.getAlertById(a.id, { forUpdate: true });
        if (row && row.state !== 'removed') await tx.updateAlert(a.id, { state: wishlistAlertMachine.next(row.state as AlertState, 'remove') as string });
      }
      const live = await tx.alertsOfItems([item.id]);
      for (const kind of adding) {
        if (live.some((a) => a.kind === kind)) continue;
        await tx.insertAlert(this.alertRow(customerId, { itemId: item.id, productId: item.product_id, variantId: item.variant_id, sellerId, kind, targetPrice: null, referencePrice: reference, armedAt }));
      }
    });
  }

  async updateItemAlerts(customerId: string, id: string, body: AlertToggle): Promise<SavedItem> {
    const item = await this.ownItem(customerId, id);
    await this.setItemAlerts(customerId, item, { priceDrop: body.priceDrop, backInStock: body.backInStock });
    return this.itemView(customerId, item);
  }

  /**
   * Adds the item to the cart with an explicit offer: the one sent, else the saved offer, else the offer the card
   * shows. A saved offer that is gone is never swapped for another seller silently: OFFER_CHANGED carries the
   * current offer to confirm. The item stays saved unless removeFromList is true.
   */
  async moveToCart(customerId: string, id: string, body: { offerId?: string | null; quantity: number; removeFromList?: boolean | null; expectedPrice?: common.Money | null }, by: By) {
    const item = await this.ownItem(customerId, id);
    if (!Number.isInteger(body.quantity) || body.quantity < 1) throw invalid('quantity', 'Choose at least 1');
    const lk = new Lookups(this.ctx);
    const product = await lk.product(item.product_id);
    const purchasable = await lk.purchasable(item.product_id);
    const variantId = item.variant_id ?? product?.variants[0]?.id ?? null;
    const shown = product && purchasable ? await lk.shownOffer(item.offer_id, variantId) : null;
    const current = (v: offers.OfferView | null) =>
      v ? { offerId: v.offerId, sellerName: v.seller.name, officialStore: v.seller.official, price: v.price, availability: v.availability.state, status: v.status } : null;

    if (!product || !purchasable) throw this.ctx.error('OFFER_CHANGED', 'This product is not available right now.', { savedOfferId: item.offer_id, current: null });
    if (!body.offerId && item.offer_id && shown?.offerId !== item.offer_id) {
      throw this.ctx.error('OFFER_CHANGED', 'The seller you saved no longer offers this item. Check the current offer before adding it.', { savedOfferId: item.offer_id, current: current(shown) });
    }
    const offerId = body.offerId ?? shown?.offerId;
    if (!offerId) throw this.ctx.error('OUT_OF_STOCK', 'This item is out of stock.', { productId: item.product_id, variantId: item.variant_id });
    const offer = await lk.offer(offerId);
    if (!offer || offer.productId !== item.product_id || (item.variant_id && offer.variantId !== item.variant_id)) throw invalid('offerId', 'This offer is not for the saved item');
    const quote = await lk.quote(offerId);
    if (!quote || !SHOWABLE_OFFER_STATUSES.has(quote.status)) {
      const featured = variantId ? await lk.featured(variantId) : null;
      throw this.ctx.error('OFFER_CHANGED', 'This offer is no longer available. Check the current offer before adding it.', { savedOfferId: item.offer_id, current: current(featured) });
    }
    if (quote.status === 'out_of_stock' || quote.availability.state === 'out_of_stock') throw this.ctx.error('OUT_OF_STOCK', 'This item is out of stock.', { offerId });
    // the price the card showed: a different price now is confirmed by the customer before anything is added
    const expected = body.expectedPrice;
    if (expected && (expected.amount !== quote.price.amount || expected.currency !== quote.price.currency)) {
      throw this.ctx.error('OFFER_CHANGED', 'The price changed since you last saw it. Check the new price before adding it.', {
        offerId,
        price: quote.price,
        previousPrice: expected,
        availability: quote.availability.state,
      });
    }
    if (body.quantity > quote.availability.maxPerOrder) throw invalid('quantity', `You can add up to ${quote.availability.maxPerOrder}`);

    const cart = this.ctx.tryUse('cart');
    if (!cart) throw new AppError('CONFLICT', 'The cart is not available right now. Try again later.', { reason: 'cart_unavailable' });
    // the cart's own add rules (created when missing, same offer increases, capped at the limit); publishes cart.item.added
    const line = await cart.addLine({ customerId }, { offerId, quantity: body.quantity });
    const after = await cart.getCartView({ kind: 'customer', customerId });
    let saved: SavedItem | null = null;
    if (body.removeFromList) await this.removeItem(customerId, item.id, by);
    else saved = await this.itemView(customerId, item, lk);
    return { cartLineId: line.id, cartItemCount: after?.itemCount ?? line.quantity, item: saved };
  }

  /* ================================================================ alerts */

  async listAlertsPage(customerId: string, state: 'active' | 'triggered' | 'paused' | undefined, page: PageRequest): Promise<common.Page<Alert>> {
    if (!isUuid(customerId)) return { items: [], nextCursor: null };
    const p = await this.repo.pageAlerts(customerId, state, page);
    return { ...p, items: await this.views.alerts(p.items) };
  }

  /** The price an alert is armed at: the saved offer, else the seller's or the featured offer, else the lowest offer */
  private async referencePrice(lk: Lookups, a: { productId: string; variantId: string | null; sellerId: string | null; itemOfferId: string | null; firstVariantId: string | null }): Promise<common.Money | null> {
    const offersApi = this.ctx.use('offers');
    if (a.itemOfferId) {
      const q = await lk.quote(a.itemOfferId);
      if (q) return q.price;
    }
    if (a.sellerId) {
      const c = await offersApi.compareOffers(a.productId, a.variantId ? { variantId: a.variantId } : {}).catch((err) => (isAppError(err) ? null : Promise.reject(err)));
      const mine = c?.offers.filter((o) => o.seller.sellerId === a.sellerId).sort((x, y) => x.price.amount - y.price.amount)[0];
      return mine?.price ?? null;
    }
    if (a.variantId) return (await lk.featured(a.variantId))?.price ?? null;
    const stats = (await offersApi.getOfferStats([a.productId]))[a.productId];
    if (stats) return lk.effectivePrice(stats.lowestOfferId, stats.lowest);
    return a.firstVariantId ? ((await lk.featured(a.firstVariantId))?.price ?? null) : null;
  }

  /** Create an alert, also for a product that is not saved. An equivalent alert is returned (with a new target price) instead of a second one. */
  async createAlert(customerId: string, body: AlertInput): Promise<Alert> {
    const lk = new Lookups(this.ctx);
    const product = await lk.product(body.productId);
    if (!product) throw notFound('Product');
    if (body.variantId && !product.variants.some((v) => v.id === body.variantId)) throw invalid('variantId', 'This option is not part of the product');
    const target = body.kind === 'price_drop' ? (body.targetPrice ?? null) : null;
    if (body.targetPrice && body.kind !== 'price_drop') throw invalid('targetPrice', 'A target price only applies to price-drop alerts');
    if (target && (target.amount <= 0 || target.currency !== this.views.currency)) throw invalid('targetPrice', `Enter a price above zero in ${this.views.currency}`);
    const variantId = body.variantId ?? null;
    const sellerId = body.sellerId ?? null;
    const same = await this.repo.findEquivalentAlert(customerId, { productId: product.id, variantId, sellerId, kind: body.kind });
    if (same) {
      const row = target && same.target_price !== target.amount ? await this.repo.updateAlert(same.id, { target_price: target.amount }) : same;
      return (await this.views.alerts([row], lk))[0]!;
    }
    await this.checkAlertRoom(customerId, 1);
    const item = await this.repo.findCustomerItem(customerId, product.id, variantId);
    const reference =
      body.kind === 'price_drop'
        ? await this.referencePrice(lk, { productId: product.id, variantId, sellerId, itemOfferId: item?.offer_id ?? null, firstVariantId: product.variants[0]?.id ?? null })
        : null;
    const armedAt = body.kind === 'back_in_stock' ? await this.engine.armedAtFor({ product_id: product.id, variant_id: variantId, seller_id: sellerId, item_offer_id: item?.offer_id ?? null }) : null;
    const row = await this.repo.insertAlert(
      this.alertRow(customerId, { itemId: item?.id ?? null, productId: product.id, variantId, sellerId, kind: body.kind, targetPrice: target?.amount ?? null, referencePrice: reference?.amount ?? null, armedAt }),
    );
    return (await this.views.alerts([row], lk))[0]!;
  }

  private async ownAlert(customerId: string, id: string): Promise<AlertRow> {
    const a = isUuid(id) ? await this.repo.getAlert(customerId, id) : undefined;
    if (!a || a.state === 'removed') throw notFound('Alert');
    return a;
  }

  /** pause, resume or rearm. Rearming a price-drop alert takes the notified price as the new reference. */
  async changeAlert(customerId: string, id: string, action: 'pause' | 'resume' | 'rearm'): Promise<Alert> {
    const a = await this.ownAlert(customerId, id);
    if (action === 'resume' && a.state === 'active') return (await this.views.alerts([a]))[0]!;
    if (action === 'resume' || (action === 'rearm' && a.state === 'triggered')) await this.checkAlertRoom(customerId, 1);
    // a rearmed back-in-stock alert waits for a stock-out first when the item can be bought now
    const item = action === 'rearm' && a.kind === 'back_in_stock' && a.item_id ? await this.repo.getItem(customerId, a.item_id) : undefined;
    const armedAt = action === 'rearm' && a.kind === 'back_in_stock' ? await this.engine.armedAtFor({ product_id: a.product_id, variant_id: a.variant_id, seller_id: a.seller_id, item_offer_id: item?.offer_id ?? null }) : undefined;
    const row = await this.repo.transaction(async (tx) => {
      const locked = await tx.getAlert(customerId, a.id, { forUpdate: true });
      if (!locked || locked.state === 'removed') throw notFound('Alert');
      const state = wishlistAlertMachine.next(locked.state as AlertState, action);
      const patch: Partial<AlertRow> = { state, paused_reason: action === 'pause' ? PAUSED.byCustomer : null };
      if (action === 'rearm' && locked.kind === 'price_drop') patch.reference_price = locked.triggered_price ?? locked.reference_price;
      if (armedAt !== undefined && locked.state === 'triggered') patch.armed_at = armedAt;
      return tx.updateAlert(locked.id, patch);
    });
    return (await this.views.alerts([row]))[0]!;
  }

  async removeAlert(customerId: string, id: string): Promise<void> {
    const a = await this.ownAlert(customerId, id);
    await this.repo.transaction(async (tx) => {
      const locked = await tx.getAlert(customerId, a.id, { forUpdate: true });
      if (!locked || locked.state === 'removed') return;
      await tx.updateAlert(locked.id, { state: wishlistAlertMachine.next(locked.state as AlertState, 'remove') });
    });
  }

  /* ================================================================ admin */

  /** Most saved products and alert counts. Aggregates only: no customer ids leave this method. */
  async insights(q: { categoryId?: string; from?: string; to?: string }, page: PageRequest) {
    const from = q.from ? new Date(`${q.from}T00:00:00Z`) : undefined;
    const to = q.to ? new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 86_400_000) : undefined;
    if (from && to && from >= to) throw invalid('to', 'The end date is before the start date');
    let rows = await this.repo.insights({ from, to, limit: 1000 });
    const lk = new Lookups(this.ctx);
    if (q.categoryId) {
      // the category and its subcategories
      const inTree = new Set<string>();
      const walk = (list: catalog.Category[], inside: boolean) => {
        for (const c of list) {
          const hit = inside || c.id === q.categoryId;
          if (hit) inTree.add(c.id);
          walk(c.children, hit);
        }
      };
      walk(await this.ctx.use('catalog').listCategories({ includeHidden: true }), false);
      const withCat = await Promise.all(rows.map(async (r) => ({ r, p: await lk.product(r.product_id) })));
      rows = withCat.filter((x) => x.p?.categoryId && inTree.has(x.p.categoryId)).map((x) => x.r);
    }
    const p = pageOf(rows, page);
    const stats = p.items.length ? await this.ctx.use('offers').getOfferStats(p.items.map((r) => r.product_id)) : {};
    const items = await Promise.all(
      p.items.map(async (r) => ({
        productId: r.product_id,
        title: (await lk.product(r.product_id))?.title ?? 'Unknown product',
        saves: r.saves,
        activePriceAlerts: r.active_price_alerts,
        activeStockAlerts: r.active_stock_alerts,
        outOfStock: !stats[r.product_id],
      })),
    );
    return { ...p, items };
  }

  /* ================================================================ events consumed */

  /** offers.offer.price_changed: Evaluate price-drop alerts for saved offers */
  async onOfferPriceChangedFromOffers(event: EventPayload<'offers.offer.price_changed'>): Promise<void> {
    if (event.to.amount >= event.from.amount) return; // only drops can meet a price-drop condition
    const offer = await this.ctx.use('offers').getOffer(event.offerId).catch(() => null);
    if (!offer || offer.status !== 'active') return; // a paused or ended offer can't be bought at the new price
    const lk = new Lookups(this.ctx);
    const price = await lk.effectivePrice(offer.id, event.to);
    await this.engine.priceChanged({ productId: event.productId, variantId: event.variantId, offerId: event.offerId, sellerId: event.sellerId ?? null }, price);
  }

  /**
   * inventory.stock.changed: Evaluate back-in-stock alerts when available goes from 0 to positive: alerts for the
   * offer, for the variant and whole-product alerts (productId on the payload), narrowed by the alert's seller.
   */
  async onStockChangedFromInventory(event: EventPayload<'inventory.stock.changed'>): Promise<void> {
    if ((event.available <= 0 && event.previousAvailable > 0) || (event.archived && event.previousAvailable > 0)) {
      // out of stock: back-in-stock alerts switched on while it was in stock are armed (once nothing they follow is buyable)
      const productIds = event.productId ? [event.productId] : await this.repo.productIdsForVariant(event.variantId);
      for (const productId of productIds) await this.engine.armUnavailable({ productId, variantId: event.variantId, offerId: event.offerId ?? '', sellerId: event.sellerId ?? null });
      return;
    }
    if (!(event.previousAvailable <= 0 && event.available > 0) || event.archived) return;
    if (event.offerId) {
      const offer = await this.ctx.use('offers').getOffer(event.offerId).catch(() => null);
      if (!offer) {
        this.ctx.log.debug({ offerId: event.offerId }, 'wishlist: stock change for an unknown offer');
        return;
      }
      if (offer.status !== 'active' && offer.status !== 'out_of_stock') return; // paused or ended: not buyable even with stock
      await this.engine.backInStock({ productId: offer.productId, variantId: offer.variantId, offerId: offer.id, sellerId: offer.sellerId ?? null }, offer.price);
      return;
    }
    // stock without an offer (company stock): the payload names the product, so whole-product alerts (no variant)
    // are found too; events from before productId was on the payload fall back to what customers saved or watch
    const productIds = event.productId ? [event.productId] : await this.repo.productIdsForVariant(event.variantId);
    for (const productId of productIds) {
      await this.engine.backInStock({ productId, variantId: event.variantId, offerId: '', sellerId: event.sellerId ?? null }, null);
    }
  }

  /** offers.offer.status_changed: Evaluate back-in-stock alerts for reactivated offers; clear saved offer ids of closed offers */
  async onOfferStatusChangedFromOffers(event: EventPayload<'offers.offer.status_changed'>): Promise<void> {
    if (event.from === 'active' && event.to !== 'active') {
      await this.engine.armUnavailable({ productId: event.productId, variantId: event.variantId, offerId: event.offerId, sellerId: event.sellerId ?? null });
    }
    if (CLOSED_OFFER.has(event.to)) {
      const n = await this.repo.clearOffer(event.offerId);
      if (n) this.ctx.log.info({ offerId: event.offerId, items: n }, 'wishlist: saved offer closed; items show the featured offer');
      return;
    }
    if (event.to !== 'active' || event.from === 'active') return;
    const offer = await this.ctx.use('offers').getOffer(event.offerId).catch(() => null);
    const change: Change = { productId: event.productId, variantId: event.variantId, offerId: event.offerId, sellerId: event.sellerId ?? null };
    await this.engine.backInStock(change, offer?.price ?? null);
  }

  /** catalog.product.merged: Move saved items and alerts to the kept product */
  async onProductMergedFromCatalog(event: EventPayload<'catalog.product.merged'>): Promise<void> {
    const from = event.duplicateProductId;
    const to = event.keptProductId;
    if (from === to) return;
    const variantTo = event.intoVariantId ?? event.newVariantId ?? null;
    const mapVariant = (v: string | null) => (v === null ? null : variantTo);
    const items = await this.repo.itemsOfProduct(from);
    const alerts = await this.repo.candidates(from, null, ['active', 'triggered', 'paused']);
    if (!items.length && !alerts.length) return;
    await this.repo.transaction(async (tx) => {
      for (const i of items) {
        const variantId = mapVariant(i.variant_id);
        const twin = await tx.findItem(i.list_id, to, variantId);
        if (twin) {
          const kept = new Set((await tx.alertsOfItems([twin.id])).map((a) => a.kind));
          for (const a of await tx.alertsOfItems([i.id])) {
            if (kept.has(a.kind)) await tx.updateAlert(a.id, { state: 'removed', item_id: null });
            else await tx.updateAlert(a.id, { item_id: twin.id });
          }
          await tx.deleteItem(i.id);
        } else {
          await tx.updateItem(i.id, { product_id: to, variant_id: variantId });
        }
      }
      for (const a of alerts) {
        const row = await tx.getAlertById(a.id, { forUpdate: true });
        if (!row || row.state === 'removed') continue;
        const variantId = mapVariant(row.variant_id);
        const twin = await tx.findEquivalentAlert(row.customer_id, { productId: to, variantId, sellerId: row.seller_id, kind: row.kind as AlertKind });
        if (twin && twin.id !== row.id) await tx.updateAlert(row.id, { state: wishlistAlertMachine.next(row.state as AlertState, 'remove') });
        else await tx.updateAlert(row.id, { product_id: to, variant_id: variantId });
      }
    });
  }

  /** catalog.product.publication_changed: Pause alerts for suspended products; mark items unavailable */
  async onProductPublicationChangedFromCatalog(event: EventPayload<'catalog.product.publication_changed'>): Promise<void> {
    // items need no write: they read the product's publication on every view and show as unavailable
    if (UNAVAILABLE_PUBLICATIONS.has(event.to)) {
      for (const a of await this.repo.candidates(event.productId, null, ['active'])) {
        await this.repo.transaction(async (tx) => {
          const row = await tx.getAlertById(a.id, { forUpdate: true });
          if (row?.state !== 'active') return;
          await tx.updateAlert(row.id, { state: wishlistAlertMachine.next('active', 'pause'), paused_reason: PAUSED.productUnavailable });
        });
      }
      return;
    }
    if (event.to === 'active') {
      for (const a of await this.repo.candidates(event.productId, null, ['paused'])) {
        if (a.paused_reason !== PAUSED.productUnavailable) continue; // the customer's own pause stays
        await this.repo.transaction(async (tx) => {
          const row = await tx.getAlertById(a.id, { forUpdate: true });
          if (row?.state !== 'paused' || row.paused_reason !== PAUSED.productUnavailable) return;
          await tx.updateAlert(row.id, { state: wishlistAlertMachine.next('paused', 'resume'), paused_reason: null });
        });
      }
    }
  }

  /**
   * customers.account.closed: Delete the customer's lists, saved items and alerts (closure erases wishlist data;
   * share links stop working with the list). Wishlist rows are keyed by the customer id, which is the account id
   * (decision P4); both ids of the payload are covered. Idempotent: the claim commits with the deletes.
   */
  async onAccountClosedFromCustomers(event: EventPayload<'customers.account.closed'>): Promise<void> {
    const ids = [...new Set([event.customerId, event.userId].filter((v): v is string => typeof v === 'string' && isUuid(v)))];
    if (!ids.length) return;
    const removed = await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`account-closed:${event.customerId}`))) return null;
      return tx.deleteCustomerData(ids);
    });
    if (removed && (removed.lists || removed.items || removed.alerts)) this.ctx.log.info({ customerId: event.customerId, ...removed }, 'wishlist: data of a closed account deleted');
  }

  /* ================================================================ customer data export */

  /**
   * Customer data export hook (FORMAT.md): lists, saved items with notes and alerts as plain records. No other
   * person's data is kept here; product titles are read from catalog at export time (null when gone).
   */
  async exportCustomerData(input: { customerId: string; accountId: string }): Promise<common.CustomerDataSection[]> {
    const ids = [...new Set([input.customerId, input.accountId].filter((v) => typeof v === 'string' && isUuid(v)))];
    const data = ids.length ? await this.repo.customerData(ids) : { lists: [], items: [], alerts: [] };
    const lk = new Lookups(this.ctx);
    const title = async (productId: string) => (await lk.product(productId))?.title ?? null;
    const iso = (d: Date | string | null) => (d === null ? null : (d instanceof Date ? d : new Date(d)).toISOString());
    const listName = new Map(data.lists.map((l) => [l.id, l.name]));
    const cur = this.views.currency;
    const m = (v: number | null, currency = cur) => (v === null ? null : money(v, currency));
    return [
      {
        key: 'wishlist_lists',
        title: 'Wishlist lists',
        module: 'wishlist',
        records: data.lists.map((l) => ({ name: l.name, isDefault: l.is_default, shared: Boolean(l.share_token), createdAt: iso(l.created_at), updatedAt: iso(l.updated_at) })),
      },
      {
        key: 'wishlist_items',
        title: 'Saved items',
        module: 'wishlist',
        records: await Promise.all(
          data.items.map(async (i) => ({
            list: listName.get(i.list_id) ?? null,
            productId: i.product_id,
            title: await title(i.product_id),
            variantId: i.variant_id,
            offerId: i.offer_id,
            priceWhenSaved: m(i.price_when_saved, i.currency),
            note: i.note,
            addedAt: iso(i.added_at),
          })),
        ),
      },
      {
        key: 'wishlist_alerts',
        title: 'Wishlist alerts',
        module: 'wishlist',
        records: await Promise.all(
          data.alerts.map(async (a) => ({
            kind: a.kind,
            productId: a.product_id,
            title: await title(a.product_id),
            variantId: a.variant_id,
            sellerId: a.seller_id,
            targetPrice: m(a.target_price),
            referencePrice: m(a.reference_price),
            state: a.state,
            triggeredAt: iso(a.triggered_at),
            triggeredPrice: m(a.triggered_price),
            createdAt: iso(a.created_at),
          })),
        ),
      },
    ];
  }

  /* ================================================================ jobs */

  /**
   * Job wishlist.evaluate-alerts (every 10 min): Batch-evaluate alert conditions changed by recent events, apply
   * cooldown, publish wishlist.alert.triggered. Also re-checks every active back-in-stock alert against current
   * availability, so a restock missed by events or skipped inside the cooldown still triggers.
   */
  async evaluateAlerts(): Promise<{ rearmed: number; resumed: number; fired: number; restocked: number }> {
    const rearmed = await this.engine.rearmDue();
    const resumed = await this.engine.resumeConsented();
    const fired = await this.engine.evaluatePrices();
    const restocked = await this.engine.evaluateRestocks();
    if (rearmed || resumed || fired || restocked) this.ctx.log.info({ rearmed, resumed, fired, restocked }, 'wishlist: alerts evaluated');
    return { rearmed, resumed, fired, restocked };
  }
}
