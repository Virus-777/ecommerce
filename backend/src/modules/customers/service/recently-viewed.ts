/**
 * Recently viewed products, for signed-in customers and visitor sessions (moved to the customer when a visitor
 * signs in).
 */
import type { Scope } from '../../../kernel/auth/scope.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { RecentlyViewedItem } from '../../../spec/customers.js';
import type * as identity from '../../../spec/identity.js';
import * as map from '../mappers.js';
import type { CustomerRow, ViewOwner, ViewRow } from '../ports.js';
import { type Core, DAY, GUEST_SESSION_DAYS, notFound } from './core.js';
import type { Profiles } from './profiles.js';
import type { Marketing } from './marketing.js';

export class RecentlyViewed {
  constructor(
    readonly core: Core,
    readonly profiles: Profiles,
    readonly marketing: Marketing,
  ) {}

  private ownerOf(owner: { customerId?: string; guestSessionId?: string }): ViewOwner | null {
    if (owner?.customerId) return { kind: 'customer', id: owner.customerId };
    if (owner?.guestSessionId) return { kind: 'guest', id: owner.guestSessionId };
    return null;
  }

  /** The list owner of a shopper request: the account for customers, the visitor (guest) session otherwise */
  private async viewerOf(scope: Scope): Promise<{ owner: ViewOwner; customer?: CustomerRow }> {
    if (scope.kind === 'visitor') return { owner: { kind: 'guest', id: scope.visitorSessionId } };
    const c = await this.profiles.ownCustomer(scope);
    return { owner: { kind: 'customer', id: c.id }, customer: c };
  }

  private async viewLimit(limit: number | undefined) {
    const [shown, retained] = await Promise.all([this.core.ctx.settings.get('recentlyViewedShown'), this.core.ctx.settings.get('recentlyViewedRetained')]);
    return Math.min(Math.max(Math.floor(limit ?? shown) || shown, 1), retained);
  }

  /** Product ids, newest first, for recommendations and the phase-3 wishlist */
  async listRecentlyViewed(owner: { customerId?: string; guestSessionId?: string }, limit: number): Promise<string[]> {
    const o = this.ownerOf(owner);
    if (!o) return [];
    return (await this.core.repo.listViews(o, await this.viewLimit(limit))).map((r) => r.product_id);
  }

  /** Recently viewed rows with the title and image snapshot and availability (same rows as GET /recently-viewed) */
  async listRecentlyViewedItems(owner: { customerId?: string; guestSessionId?: string }, limit: number): Promise<RecentlyViewedItem[]> {
    const o = this.ownerOf(owner);
    if (!o) return [];
    return this.viewItems(await this.core.repo.listViews(o, await this.viewLimit(limit)));
  }

  async listRecentlyViewedFor(scope: Scope, limit?: number): Promise<RecentlyViewedItem[]> {
    const { owner } = await this.viewerOf(scope);
    return this.viewItems(await this.core.repo.listViews(owner, await this.viewLimit(limit)));
  }

  /** Price and availability from offers and catalog when they are enabled */
  private async viewItems(rows: ViewRow[]): Promise<RecentlyViewedItem[]> {
    if (!rows.length) return [];
    const catalog = this.core.ctx.tryUse('catalog');
    const offers = this.core.ctx.tryUse('offers');
    const media = this.core.ctx.tryUse('media');
    const imageIds = [...new Set(rows.map((r) => r.image_media_id).filter((x): x is string => !!x))];
    const [products, featured, refs] = await Promise.all([
      this.core.soft('catalog products', catalog && (() => Promise.all(rows.map((r) => catalog.getProduct(r.product_id))))),
      this.core.soft('featured offers', offers && (() => offers.getFeaturedOfferForProduct(rows.map((r) => ({ productId: r.product_id, ...(r.variant_id ? { variantId: r.variant_id } : {}) }))))),
      // cards: the thumbnail size (small answers thumb for product images too)
      this.core.soft('media refs', media && imageIds.length ? () => media.refs(imageIds, 'thumb') : undefined),
    ]);
    const images = new Map((refs ?? []).map((m) => [m.id, m]));
    return rows.map((r, i) => {
      const product = products?.[i];
      const offer = featured ? (featured[r.product_id] ?? null) : undefined;
      const hidden = products !== undefined && product === null;
      const noOffer = offer === null;
      return {
        productId: r.product_id,
        variantId: r.variant_id,
        slug: product?.slug ?? null,
        title: r.title || product?.title || '',
        image: (r.image_media_id ? images.get(r.image_media_id) : undefined) ?? product?.images?.[0] ?? null,
        price: offer?.price ?? null,
        wasPrice: offer?.compareAt?.verified ? offer.compareAt.amount : null,
        available: !hidden && !noOffer,
        viewedAt: map.iso(r.viewed_at),
      };
    });
  }

  /** Product for GraphQL RecentlyViewedItem.product (null when hidden, suspended or catalog is off) */
  async productOf(productId: string): Promise<unknown> {
    const catalog = this.core.ctx.tryUse('catalog');
    return (await this.core.soft('catalog product', catalog && (() => catalog.getProduct(productId)))) ?? null;
  }

  async recordView(scope: Scope, body: { productId: string; variantId?: string | null }): Promise<void> {
    const { owner, customer } = await this.viewerOf(scope);
    if (customer && !(await this.marketing.prefsOf(customer)).personalized_recommendations) return; // switched off: nothing is recorded
    let title = '';
    let image: string | null = null;
    const catalog = this.core.ctx.tryUse('catalog');
    if (catalog) {
      const p = await catalog.getProduct(body.productId);
      if (!p) throw notFound('Product');
      title = p.title;
      image = p.images?.[0]?.id ?? null;
    }
    await this.core.repo.upsertView({
      id: newId(),
      owner_kind: owner.kind,
      owner_id: owner.id,
      product_id: body.productId,
      variant_id: body.variantId ?? null,
      title,
      image_media_id: image,
      viewed_at: this.core.now(),
    });
    await this.core.repo.trimViews(owner, await this.core.ctx.settings.get('recentlyViewedRetained'));
  }

  async clearViews(scope: Scope): Promise<void> {
    await this.core.repo.deleteViews((await this.viewerOf(scope)).owner);
  }

  async removeView(scope: Scope, productId: string): Promise<void> {
    await this.core.repo.deleteViews((await this.viewerOf(scope)).owner, productId);
  }

  /** identity.guest_session.claimed: merge the guest list into the account (newest view wins) and delete the guest rows */
  async onGuestSessionClaimedFromIdentity(event: EventPayload<'identity.guest_session.claimed'>): Promise<void> {
    const guest: ViewOwner = { kind: 'guest', id: event.guestSessionId };
    const c = (await this.core.repo.getCustomerByUserId(event.accountId)) ?? (await this.profiles.ensureCustomer(event.accountId));
    if (!c) return;
    const retained = await this.core.ctx.settings.get('recentlyViewedRetained');
    const keep = (await this.marketing.prefsOf(c)).personalized_recommendations;
    await this.core.repo.transaction(async (repo) => {
      const owner: ViewOwner = { kind: 'customer', id: c.id };
      if (keep) {
        for (const v of await repo.listViews(guest, retained)) await repo.upsertView({ ...v, id: newId(), owner_kind: 'customer', owner_id: c.id });
        await repo.trimViews(owner, retained);
      }
      await repo.deleteViews(guest);
    });
  }

  /** catalog.product.merged: recently viewed rows follow the kept product */
  async onProductMergedFromCatalog(event: EventPayload<'catalog.product.merged'>): Promise<void> {
    if (event.duplicateProductId === event.keptProductId) return;
    await this.core.repo.transaction((repo) => repo.repointProduct(event.duplicateProductId, event.keptProductId, event.intoVariantId ?? event.newVariantId ?? null));
  }

  /** customers.prune-recently-viewed: views older than recentlyViewedRetentionDays, and guest views whose session has expired */
  async pruneRecentlyViewed(): Promise<{ deleted: number }> {
    const now = this.core.now().getTime();
    const days = await this.core.ctx.settings.get('recentlyViewedRetentionDays');
    const deleted = await this.core.repo.pruneViews(new Date(now - days * DAY), new Date(now - GUEST_SESSION_DAYS * DAY));
    return { deleted };
  }
}
