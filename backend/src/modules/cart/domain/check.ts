/**
 * Change detection for one cart line (pure): from the current offer, stock, promotion price and
 * product facts, what the line costs now, how many may be bought, and which changes to explain.
 * Baseline = the price the customer added or last accepted and the quantity they chose.
 */
import { money, type Money } from '../../../kernel/lib/money.js';
import type * as catalog from '../../../spec/catalog.js';
import type { SellerLabel } from '../../../spec/cart.js';
import type * as offers from '../../../spec/offers.js';
import type * as promotions from '../../../spec/promotions.js';
import type { ItemRow } from '../ports.js';
import { desired, lineMaximum, minLimit, offerBlock, packageKey, type DesiredNotice, type JsonObject, type LimitKind } from './rules.js';

/** What other modules say about one offer right now */
export interface OfferFacts {
  offer: offers.Offer | null;
  quote: offers.OfferView | null;
  promo: promotions.OfferPromotion | null;
  available: number | null;
  stockState: string | null;
  lowStockThreshold: number | null;
  changes: offers.OfferChange[];
}

export interface ProductFacts {
  product: catalog.Product | null;
  /** null when catalog is off */
  purchasable: boolean | null;
}

export interface CheckSettings {
  maxQuantityPerLine: number;
  showPriceDecreaseNotices: boolean;
}

export interface AlternativesHint {
  count: number;
  lowestPrice: Money | null;
}

/** One line after the change check, before shipping */
export interface LineEval {
  item: ItemRow;
  offer: offers.Offer | null;
  facts: OfferFacts;
  product: ProductFacts;
  /** Current price the customer pays (campaign price when one applies) */
  unitPrice: Money;
  /** Offer price before promotions */
  regularPrice: Money;
  compareAt: Money | null;
  acceptedPrice: Money;
  purchaseLimit: number | null;
  available: number | null;
  maxQuantity: number;
  limitKind: LimitKind;
  shownAvailable: number | null;
  shipsFrom: string;
  packageKey: string;
  seller: SellerLabel;
  returnTerms: string;
  condition: offers.Offer['condition'];
  conditionNote: string | null;
  /** Detected changes (shipping coverage is added per package afterwards) */
  notices: DesiredNotice[];
  /** A blocking change other than coverage: the line is not quoted for shipping */
  blocked: boolean;
  /** Price decrease accepted automatically: the new baseline */
  newAcceptedPrice: number | null;
  alternatives: AlternativesHint | null;
  deliveryChange: string | null;
}

export const OFFICIAL_NAME = 'Marketly Official Store';

export function sellerLabelOf(item: Pick<ItemRow, 'owner_type' | 'seller_id'>, offer: offers.Offer | null, quote: offers.OfferView | null): SellerLabel {
  const official = item.owner_type === 'official';
  const name = quote?.seller.name ?? offer?.sellerName ?? (official ? OFFICIAL_NAME : 'Seller');
  return {
    ownerType: item.owner_type,
    id: item.seller_id,
    name,
    slug: quote?.seller.storeSlug ?? (official ? 'official-store' : (item.seller_id ?? 'seller')),
    official,
    verified: quote?.seller.verified ?? official,
    logo: null,
  };
}

/** Other offers for the same variant the customer may choose explicitly (never applied) */
export function alternativesOf(offerId: string, changes: offers.OfferChange[]): AlternativesHint | null {
  const seen = new Map<string, Money>();
  for (const c of changes) for (const a of c.alternatives ?? []) if (a.offerId !== offerId && a.status === 'active') seen.set(a.offerId, a.price);
  if (!seen.size) return null;
  const prices = [...seen.values()];
  const lowest = prices.reduce((m, p) => (p.amount < m.amount ? p : m));
  return { count: seen.size, lowestPrice: lowest };
}

/** The price the customer pays now: the campaign price from promotions when one applies, else the offer price */
export function currentPrice(offer: offers.Offer, promo: promotions.OfferPromotion | null): Money {
  return promo && promo.price.currency === offer.price.currency ? promo.price : offer.price;
}

export function evaluateLine(item: ItemRow, facts: OfferFacts, product: ProductFacts, s: CheckSettings): LineEval {
  const offer = facts.offer;
  const currency = item.currency;
  const acceptedPrice = money(item.accepted_price, currency);
  const regularPrice = offer?.price ?? acceptedPrice;
  const unitPrice = offer ? currentPrice(offer, facts.promo) : acceptedPrice;
  const wasPrice = facts.promo?.wasPrice ?? (offer?.compareAt?.verified ? offer.compareAt.amount : null);
  const compareAt = wasPrice && wasPrice.amount > unitPrice.amount ? wasPrice : null;
  const purchaseLimit = minLimit(offer?.purchaseLimit, facts.promo?.purchaseLimit);
  const available = facts.available ?? (offer?.status === 'out_of_stock' ? 0 : null);
  const { max, limitKind } = lineMaximum(purchaseLimit, available, s.maxQuantityPerLine);
  const low = facts.stockState === 'low_stock' || (facts.lowStockThreshold !== null && available !== null && available <= facts.lowStockThreshold);
  const shownAvailable = available !== null && (available < item.quantity || low) ? Math.max(available, 0) : null;
  const shipsFrom = offer?.dispatch.shipsFrom ?? item.ships_from;
  const alternatives = alternativesOf(item.offer_id, facts.changes);
  const altJson: JsonObject = alternatives ? { alternatives: { count: alternatives.count, lowestPrice: alternatives.lowestPrice ? { ...alternatives.lowestPrice } : null } } : {};

  const notices: DesiredNotice[] = [];
  let blocked = false;
  let newAcceptedPrice: number | null = null;
  let deliveryChange: string | null = null;

  // the offer itself: ended, hidden, seller or product unavailable
  const offerKind = !offer ? 'offer_ended' : offerBlock(offer.status, offer.statusReason?.code);
  const changeKinds = new Set(facts.changes.map((c) => c.kind));
  const reason = (k: string) => ({ reason: offer?.statusReason?.text ?? k, ...altJson });
  if (offerKind && offerKind !== 'out_of_stock') notices.push(desired(offerKind, {}, reason(offerKind)));
  else if (changeKinds.has('removed')) notices.push(desired('offer_ended', {}, reason('offer_ended')));
  if (changeKinds.has('seller_restricted') && !notices.some((n) => n.kind === 'seller_unavailable')) notices.push(desired('seller_unavailable', {}, reason('seller_restricted')));
  if (product.purchasable === false && !notices.some((n) => n.kind === 'product_unavailable')) notices.push(desired('product_unavailable', {}, reason('product_unavailable')));
  blocked = notices.length > 0;

  if (!blocked && offer) {
    // stock
    if (offerKind === 'out_of_stock' || (available !== null && available <= 0)) {
      notices.push(desired('out_of_stock', { quantity: item.quantity }, { available: 0, ...altJson }));
      blocked = true;
    } else if (available !== null && item.quantity > available) {
      notices.push(desired('quantity_reduced', { quantity: item.quantity }, { available, ...altJson }));
    }
    // purchase limit (offer, deal) and the platform line maximum
    const limit = minLimit(purchaseLimit, s.maxQuantityPerLine)!;
    if (item.quantity > limit && !(available !== null && available < limit && item.quantity > available)) {
      notices.push(desired('purchase_limit_reduced', { quantity: item.quantity }, { limit }));
    }
    // price against the accepted baseline
    if (!blocked) {
      if (unitPrice.amount > acceptedPrice.amount) {
        notices.push(
          desired('price_increased', { price: acceptedPrice.amount, currency }, {
            price: unitPrice.amount,
            currency,
            changedBy: item.owner_type === 'seller' ? offer.sellerName : null,
            changedAt: item.owner_type === 'seller' ? offer.updatedAt : null,
            ...altJson,
          }),
        );
      } else if (unitPrice.amount < acceptedPrice.amount) {
        newAcceptedPrice = unitPrice.amount;
        if (s.showPriceDecreaseNotices) notices.push(desired('price_decreased', { price: acceptedPrice.amount, currency }, { price: unitPrice.amount, currency }));
      }
    }
    const delivery = facts.changes.find((c) => c.kind === 'delivery');
    if (delivery) deliveryChange = delivery.message;
  }

  return {
    item,
    offer,
    facts,
    product,
    unitPrice,
    regularPrice,
    compareAt,
    acceptedPrice,
    purchaseLimit,
    available,
    maxQuantity: max,
    limitKind,
    shownAvailable,
    shipsFrom,
    packageKey: packageKey(item.owner_type, item.seller_id, shipsFrom),
    seller: sellerLabelOf(item, offer, facts.quote),
    returnTerms: offer?.returnTerms.summary ?? facts.quote?.returns.summary ?? '',
    condition: offer?.condition ?? facts.quote?.condition ?? 'new',
    conditionNote: offer?.conditionNotes ?? null,
    notices,
    blocked,
    newAcceptedPrice,
    alternatives,
    deliveryChange,
  };
}

/** Why an offer can't be added now (null = it can), for OFFER_UNAVAILABLE */
export function addBlock(offer: offers.Offer, available: number | null, purchasable: boolean | null): string | null {
  const k = offerBlock(offer.status, offer.statusReason?.code);
  if (k) return k;
  if (purchasable === false) return 'product_unavailable';
  if (available !== null && available <= 0) return 'out_of_stock';
  return null;
}
