import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';

import type { CartPublicApi, CartOwner, CartView, CartLineInput, CheckoutCartSnapshot } from '../../spec/cart.js';
import type { CartRepository } from './ports.js';

export interface CartServiceDeps {
  repo: CartRepository;
  ctx: ModuleContext<'cart'>;
}

/**
 * Cart use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/cart.json.
 */
export class CartService implements CartPublicApi {
  readonly #deps: CartServiceDeps;

  constructor(deps: CartServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): CartServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** Eligible lines (offer, seller, variant, quantity, accepted unit price, package key) and coupon codes, after a fresh change check. Unavailable lines are returned separately so checkout can explain them. */
  async getCartForCheckout(owner: CartOwner, itemIds?: string[]): Promise<CheckoutCartSnapshot> {
    throw notImplemented('cart.getCartForCheckout');
  }

  /** Remove lines that became an accepted order; other lines stay. Marks the cart converted when it becomes empty. */
  async removePurchasedItems(cartId: string, itemIds: string[], orderId: string): Promise<void> {
    throw notImplemented('cart.removePurchasedItems');
  }

  /** Put lines back after a declined payment on an order that was pending, so the customer can pay another way without rebuilding the cart. */
  async restoreItems(cartId: string, lines: CartLineInput[]): Promise<void> {
    throw notImplemented('cart.restoreItems');
  }

  /** How many active carts hold an offer (used to warn a seller before ending an offer). */
  async countOfferInCarts(offerId: string): Promise<number> {
    throw notImplemented('cart.countOfferInCarts');
  }

  /** The shopper's cart grouped by package, after a fresh price, stock and eligibility check (same as GET /cart) */
  async getCartView(owner: CartOwner): Promise<CartView | null> {
    throw notImplemented('cart.getCartView');
  }

  /* ---------------- events consumed */

  /** offers.offer.price_changed: Queue lines holding the offer for a notice refresh (price increased or decreased) */
  async onOfferPriceChangedFromOffers(event: EventPayload<"offers.offer.price_changed">): Promise<void> {
    void event;
    throw notImplemented('cart consumer of offers.offer.price_changed');
  }

  /** offers.offer.status_changed: Queue lines; an ended or hidden offer becomes an offer_ended blocking notice */
  async onOfferStatusChangedFromOffers(event: EventPayload<"offers.offer.status_changed">): Promise<void> {
    void event;
    throw notImplemented('cart consumer of offers.offer.status_changed');
  }

  /** inventory.stock.changed: Queue lines whose quantity may exceed availability (out_of_stock or quantity_reduced) */
  async onStockChangedFromInventory(event: EventPayload<"inventory.stock.changed">): Promise<void> {
    void event;
    throw notImplemented('cart consumer of inventory.stock.changed');
  }

  /** sellers.seller.restricted: Lines from offers the restriction hides get seller_unavailable notices; nothing is switched to another seller */
  async onSellerRestrictedFromSellers(event: EventPayload<"sellers.seller.restricted">): Promise<void> {
    void event;
    throw notImplemented('cart consumer of sellers.seller.restricted');
  }

  /** sellers.seller.suspended: Same as restricted */
  async onSellerSuspendedFromSellers(event: EventPayload<"sellers.seller.suspended">): Promise<void> {
    void event;
    throw notImplemented('cart consumer of sellers.seller.suspended');
  }

  /** catalog.product.publication_changed: Hidden or suspended products give their lines a product_unavailable notice */
  async onProductPublicationChangedFromCatalog(event: EventPayload<"catalog.product.publication_changed">): Promise<void> {
    void event;
    throw notImplemented('cart consumer of catalog.product.publication_changed');
  }

  /** identity.guest_session.claimed: Merge the claimed guest session's cart into the account's customer cart (same rules and report as POST /cart/merge; idempotent). This is how sign-in merges carts on every client; identity only publishes the event and calls nothing in cart */
  async onGuestSessionClaimedFromIdentity(event: EventPayload<"identity.guest_session.claimed">): Promise<void> {
    void event;
    throw notImplemented('cart consumer of identity.guest_session.claimed');
  }

  /* ---------------- jobs */

  /** Job cart.recheck-queued (every 2 min): Refresh notices for lines queued by offer, stock and seller events so the next read is fast; GET /cart still re-checks authoritatively */
  async recheckQueued(): Promise<void> {
    throw notImplemented('job cart.recheck-queued');
  }

  /** Job cart.expire-idle (daily 03:00 PT): Expire guest carts idle longer than guestCartRetentionDays and customer carts idle longer than customerCartRetentionDays; publishes cart.cart.expired */
  async expireIdle(): Promise<void> {
    throw notImplemented('job cart.expire-idle');
  }
}
