/**
 * Read models: saved items and alerts as the store shows them. Wishlist owns what was saved, when, the price
 * when saved and the alert settings; title, image, price, deal and stock are read from catalog, offers and
 * promotions on every read (one lookup per product or offer per call).
 */
import { isAppError } from '../../kernel/errors/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import { money } from '../../kernel/lib/money.js';
import type * as catalog from '../../spec/catalog.js';
import type * as common from '../../spec/common.js';
import type * as offers from '../../spec/offers.js';
import type { Alert, SavedItem, WishlistList } from '../../spec/wishlist.js';
import { alertCondition, priceHint, SHOWABLE_OFFER_STATUSES, shareToken } from './domain/rules.js';
import { secretFor } from '../../kernel/lib/secrets.js';
import type { AlertRow, ItemRow, ListRow, ListWithCount } from './ports.js';

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

/** Not found and validation answers of another module read as "nothing there"; anything else is a real failure */
async function orNull<T>(p: Promise<T> | undefined): Promise<T | null> {
  try {
    return (await p) ?? null;
  } catch (err) {
    if (isAppError(err) && (err.status === 404 || err.code === 'VALIDATION_FAILED')) return null;
    throw err;
  }
}

/** Per-call cache of other modules' answers */
export class Lookups {
  readonly #products = new Map<string, Promise<catalog.Product | null>>();
  readonly #purchasable = new Map<string, Promise<boolean>>();
  readonly #quotes = new Map<string, Promise<offers.OfferView | null>>();
  readonly #featured = new Map<string, Promise<offers.OfferView | null>>();
  readonly #offers = new Map<string, Promise<offers.Offer | null>>();

  constructor(private readonly ctx: ModuleContext<'wishlist'>) {}

  private memo<T>(m: Map<string, Promise<T>>, key: string, f: () => Promise<T>): Promise<T> {
    let p = m.get(key);
    if (!p) m.set(key, (p = f()));
    return p;
  }

  product = (id: string) => this.memo(this.#products, id, () => orNull(this.ctx.use('catalog').getProduct(id)));
  purchasable = (id: string) => this.memo(this.#purchasable, id, async () => (await orNull(this.ctx.use('catalog').isPurchasable(id))) ?? false);

  /**
   * Products and whether they can be bought, for many ids in batched catalog reads (getProducts, 200 a call)
   * instead of a getProduct and an isPurchasable per product; product() and purchasable() then answer from them.
   */
  prefetchProducts(ids: readonly string[]): void {
    const missing = [...new Set(ids)].filter((id) => !this.#products.has(id) && !this.#purchasable.has(id));
    for (let i = 0; i < missing.length; i += 200) {
      const chunk = missing.slice(i, i + 200);
      const read = orNull(this.ctx.use('catalog').getProducts(chunk)).then((list) => new Map((list ?? []).map((r) => [r.product.id, r])));
      for (const id of chunk) {
        const product = read.then((records) => records.get(id)?.product ?? null);
        const purchasable = read.then((records) => records.get(id)?.purchasable ?? false);
        // a failed read is reported to whoever awaits these; never as an unhandled rejection
        product.catch(() => undefined);
        purchasable.catch(() => undefined);
        this.#products.set(id, product);
        this.#purchasable.set(id, purchasable);
      }
    }
  }
  offer = (id: string) => this.memo(this.#offers, id, () => orNull(this.ctx.use('offers').getOffer(id)));
  quote = (offerId: string) => this.memo(this.#quotes, offerId, () => orNull(this.ctx.use('offers').quoteOffer(offerId, 1)));
  featured = (variantId: string) => this.memo(this.#featured, variantId, () => orNull(this.ctx.use('offers').getFeaturedOffer(variantId)));

  /** The offer a card shows: the saved offer while it can be shown (out of stock keeps its seller), else the featured offer */
  async shownOffer(savedOfferId: string | null, variantId: string | null): Promise<offers.OfferView | null> {
    if (savedOfferId) {
      const q = await this.quote(savedOfferId);
      if (q && SHOWABLE_OFFER_STATUSES.has(q.status)) return q;
    }
    return variantId ? this.featured(variantId) : null;
  }

  /** Current price of an offer as the customer pays it (campaign price when promotions applies one) */
  async effectivePrice(offerId: string, regular: common.Money): Promise<common.Money> {
    const promotions = this.ctx.tryUse('promotions');
    if (!promotions) return regular;
    const [p] = await promotions.priceOffers([offerId], {});
    return p && p.price.currency === regular.currency && p.price.amount < regular.amount ? p.price : regular;
  }

  /** effectivePrice of several offers with one promotions call, in their order */
  async effectivePrices(list: readonly { offerId: string; regular: common.Money }[]): Promise<common.Money[]> {
    const promotions = this.ctx.tryUse('promotions');
    if (!promotions || !list.length) return list.map((o) => o.regular);
    const priced = new Map((await promotions.priceOffers(list.map((o) => o.offerId), {})).map((p) => [p.offerId, p]));
    return list.map(({ offerId, regular }) => {
      const p = priced.get(offerId);
      return p && p.price.currency === regular.currency && p.price.amount < regular.amount ? p.price : regular;
    });
  }
}

export type Availability = SavedItem['availability'];

export interface ItemDetail {
  item: SavedItem;
  /** The offer the customer saved (null when they saved the product, or the offer was closed) */
  savedOfferId: string | null;
  /** The offer the card shows (saved or featured) */
  shown: offers.OfferView | null;
  product: catalog.Product | null;
  variant: catalog.Variant | null;
}

export class Views {
  constructor(private readonly ctx: ModuleContext<'wishlist'>) {}

  lookups() {
    return new Lookups(this.ctx);
  }

  get currency() {
    return this.ctx.config.market.currency;
  }

  shareUrl(list: ListRow): string | null {
    if (!list.share_token) return null;
    return `${this.ctx.config.publicUrls.store.replace(/\/$/, '')}/wishlist/shared/${shareToken(secretFor(this.ctx.config, 'wishlist.share'), list.share_token)}`;
  }

  list(l: ListRow | ListWithCount, itemCount?: number): WishlistList {
    return {
      id: l.id,
      name: l.name,
      isDefault: l.is_default,
      itemCount: itemCount ?? ('item_count' in l ? l.item_count : 0),
      shared: Boolean(l.share_token),
      shareUrl: this.shareUrl(l),
      createdAt: iso(l.created_at),
      updatedAt: iso(l.updated_at),
    };
  }

  /** Saved items with live price, hint, stock and alert toggles. `publicView` (shared lists) leaves out notes, price history and alerts. */
  async items(rows: ItemRow[], alerts: AlertRow[], o: { publicView?: boolean; lookups?: Lookups } = {}): Promise<ItemDetail[]> {
    const lk = o.lookups ?? this.lookups();
    lk.prefetchProducts(rows.map((r) => r.product_id));
    const days = await this.ctx.settings.get('priceHintDays');
    const cart = Boolean(this.ctx.tryUse('cart'));
    const promotions = this.ctx.tryUse('promotions');
    // each item's alerts (not removed), looked up by item instead of scanning per row
    const alertsBy = new Map<string, AlertRow[]>();
    for (const a of alerts) {
      if (!a.item_id || a.state === 'removed') continue;
      const list = alertsBy.get(a.item_id);
      if (list) list.push(a);
      else alertsBy.set(a.item_id, [a]);
    }
    return Promise.all(
      rows.map(async (r): Promise<ItemDetail> => {
        const [product, purchasable] = await Promise.all([lk.product(r.product_id), lk.purchasable(r.product_id)]);
        const variant = (r.variant_id ? product?.variants.find((v) => v.id === r.variant_id) : null) ?? null;
        const variantId = r.variant_id ?? product?.variants[0]?.id ?? null;
        const shown = product ? await lk.shownOffer(r.offer_id, variantId) : null;

        let availability: Availability;
        if (!product || !purchasable) availability = 'unavailable';
        else if (!shown) availability = 'out_of_stock';
        else if (shown.status === 'out_of_stock' || shown.availability.state === 'out_of_stock') availability = 'out_of_stock';
        else if (shown.availability.state === 'low_stock') availability = 'low_stock';
        else availability = 'in_stock';

        const price = availability === 'unavailable' ? null : (shown?.price ?? null);
        let wasPrice: common.Money | null = null;
        if (shown && price) {
          const campaign = shown.regularPrice && shown.regularPrice.amount > price.amount;
          const ref = campaign && promotions ? await orNull(promotions.referencePrice(shown.offerId)) : null;
          const verified = shown.compareAt?.verified ? shown.compareAt.amount : null;
          const candidate = ref ?? verified ?? null;
          wasPrice = candidate && candidate.currency === price.currency && candidate.amount > price.amount ? candidate : null;
        }
        const hint =
          o.publicView || !shown || !price
            ? priceHint(null, null, days)
            : priceHint(await orNull(this.ctx.use('offers').priceRange(shown.offerId, days)), price, days);
        if (o.publicView) hint.label = '';

        const own = o.publicView ? [] : (alertsBy.get(r.id) ?? []);
        const live = availability === 'in_stock' || availability === 'low_stock';
        const item: SavedItem = {
          id: r.id,
          listId: r.list_id,
          productId: r.product_id,
          variantId: r.variant_id,
          offerId: shown?.offerId ?? r.offer_id,
          title: product?.title ?? 'This product is no longer available',
          image: variant?.images[0] ?? product?.images[0] ?? null,
          options: variant?.options ?? {},
          sellerName: shown?.seller.name ?? null,
          officialStore: shown?.seller.official ?? false,
          price,
          wasPrice,
          priceWhenSaved: o.publicView || r.price_when_saved === null ? null : money(r.price_when_saved, r.currency),
          priceHint: hint,
          availability,
          availableQty: live ? (shown?.availability.quantity ?? null) : availability === 'out_of_stock' ? 0 : null,
          stockLabel: availability === 'low_stock' ? (shown?.availability.label ?? null) : availability === 'out_of_stock' ? 'Out of stock' : null,
          alerts: { priceDrop: own.some((a) => a.kind === 'price_drop'), backInStock: own.some((a) => a.kind === 'back_in_stock') },
          canMoveToCart: !o.publicView && cart && live,
          note: o.publicView ? null : r.note,
          addedAt: iso(r.added_at),
        };
        return { item, savedOfferId: r.offer_id, shown, product, variant };
      }),
    );
  }

  /** Alerts with title, image and the condition in words */
  async alerts(rows: AlertRow[], lookups?: Lookups): Promise<Alert[]> {
    const lk = lookups ?? this.lookups();
    lk.prefetchProducts(rows.map((a) => a.product_id));
    const sellerNames = new Map<string, Promise<string | null>>();
    const sellerName = (a: AlertRow): Promise<string | null> => {
      if (!a.seller_id) return Promise.resolve(null);
      const key = `${a.product_id}:${a.seller_id}`;
      let p = sellerNames.get(key);
      if (!p) {
        p = (async () => {
          const c = await orNull(this.ctx.use('offers').compareOffers(a.product_id, a.variant_id ? { variantId: a.variant_id } : {}));
          return c?.offers.find((o) => o.seller.sellerId === a.seller_id)?.seller.name ?? 'the chosen seller';
        })();
        sellerNames.set(key, p);
      }
      return p;
    };
    const cur = this.currency;
    const m = (v: number | null) => (v === null ? null : money(v, cur));
    return Promise.all(
      rows.map(async (a): Promise<Alert> => {
        const product = await lk.product(a.product_id);
        const variant = a.variant_id ? (product?.variants.find((v) => v.id === a.variant_id) ?? null) : null;
        const kind = a.kind as Alert['kind'];
        return {
          id: a.id,
          itemId: a.item_id,
          productId: a.product_id,
          variantId: a.variant_id,
          sellerId: a.seller_id,
          title: product?.title ?? 'This product is no longer available',
          image: variant?.images[0] ?? product?.images[0] ?? null,
          kind,
          condition: alertCondition({ kind, targetPrice: m(a.target_price), referencePrice: m(a.reference_price), options: variant?.options ?? {}, sellerName: await sellerName(a) }),
          targetPrice: m(a.target_price),
          referencePrice: m(a.reference_price),
          state: a.state as Alert['state'],
          triggeredAt: a.triggered_at ? iso(a.triggered_at) : null,
          triggeredPrice: m(a.triggered_price),
          pausedReason: a.state === 'paused' ? a.paused_reason : null,
          armedAt: a.armed_at ? a.armed_at.toISOString() : null,
          createdAt: iso(a.created_at),
        };
      }),
    );
  }
}
