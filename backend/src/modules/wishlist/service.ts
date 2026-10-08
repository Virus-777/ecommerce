import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type { WishlistPublicApi, WishlistList, SavedItem, Alert } from '../../spec/wishlist.js';
import type { WishlistRepository } from './ports.js';

export interface WishlistServiceDeps {
  repo: WishlistRepository;
  ctx: ModuleContext<'wishlist'>;
}

/**
 * Wishlist use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/wishlist.json.
 */
export class WishlistService implements WishlistPublicApi {
  readonly #deps: WishlistServiceDeps;

  constructor(deps: WishlistServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): WishlistServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** How many customers saved a product (aggregate only, for reports and Official Store planning). */
  async savedCount(productId: string): Promise<number> {
    throw notImplemented('wishlist.savedCount');
  }

  /** Saved state for product cards rendered by other modules. */
  async isSaved(customerId: string, productIds: string[]): Promise<Record<string, boolean>> {
    throw notImplemented('wishlist.isSaved');
  }

  /** Saved items of a list (default list when omitted) with price hints and alert toggles (GET /wishlist, GET /lists/{id}/items). */
  async listItems(customerId: string, opts: { listId?: string, paging: common.PageInput }): Promise<common.Page<SavedItem>> {
    throw notImplemented('wishlist.listItems');
  }

  /** The customer's lists with item counts and share state (GET /lists). */
  async listLists(customerId: string): Promise<WishlistList[]> {
    throw notImplemented('wishlist.listLists');
  }

  /** The customer's price-drop and back-in-stock alerts (GET /alerts). */
  async listAlerts(customerId: string): Promise<Alert[]> {
    throw notImplemented('wishlist.listAlerts');
  }

  /* ---------------- events consumed */

  /** offers.offer.price_changed: Evaluate price-drop alerts for saved offers */
  async onOfferPriceChangedFromOffers(event: EventPayload<"offers.offer.price_changed">): Promise<void> {
    void event;
    throw notImplemented('wishlist consumer of offers.offer.price_changed');
  }

  /** inventory.stock.changed: Evaluate back-in-stock alerts when available goes from 0 to positive */
  async onStockChangedFromInventory(event: EventPayload<"inventory.stock.changed">): Promise<void> {
    void event;
    throw notImplemented('wishlist consumer of inventory.stock.changed');
  }

  /** offers.offer.status_changed: Evaluate back-in-stock alerts for reactivated offers; clear saved offer ids of closed offers */
  async onOfferStatusChangedFromOffers(event: EventPayload<"offers.offer.status_changed">): Promise<void> {
    void event;
    throw notImplemented('wishlist consumer of offers.offer.status_changed');
  }

  /** catalog.product.merged: Move saved items and alerts to the kept product */
  async onProductMergedFromCatalog(event: EventPayload<"catalog.product.merged">): Promise<void> {
    void event;
    throw notImplemented('wishlist consumer of catalog.product.merged');
  }

  /** catalog.product.publication_changed: Pause alerts for suspended products; mark items unavailable */
  async onProductPublicationChangedFromCatalog(event: EventPayload<"catalog.product.publication_changed">): Promise<void> {
    void event;
    throw notImplemented('wishlist consumer of catalog.product.publication_changed');
  }

  /* ---------------- jobs */

  /** Job wishlist.evaluate-alerts (every 10 min): Batch-evaluate alert conditions changed by recent events, apply cooldown, publish wishlist.alert.triggered */
  async evaluateAlerts(): Promise<void> {
    throw notImplemented('job wishlist.evaluate-alerts');
  }
}
