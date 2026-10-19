/**
 * Pure checkout rules: what the jsonb columns hold, sales tax, labels, steps, change choices.
 * No I/O here.
 */
import { format as formatMoney } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import type * as cart from '../../../spec/cart.js';
import type * as offers from '../../../spec/offers.js';
import type * as orders from '../../../spec/orders.js';
import type * as payments from '../../../spec/payments.js';
import type * as promotions from '../../../spec/promotions.js';
import type { Change, CheckoutLine, CheckoutPackage, CouponResult, DiscountLine, QuoteTotals, StepState } from '../../../spec/checkout.js';

/* ================================================================ stored shapes (jsonb columns) */

/** The contact (sessions.account jsonb plus the email and contact_name columns). Customers are pre-filled; a guest has no email until the contact step. */
export interface StoredAccount {
  kind: 'customer' | 'guest';
  customerId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  createAccountAfter: boolean;
  marketingOptIn: boolean;
  /** Preference set with the gift note (no column of its own) */
  hidePricesOnSlip: boolean;
}

/** The chosen method and the latest payment attempt (sessions.payment_selection jsonb plus the payment_intent_id and payment_state columns) */
export interface StoredPayment {
  method: payments.MethodSelection | null;
  view: { kind: 'saved_card' | 'new_card' | 'digital_wallet'; label: string; savedMethodId: string | null; billingSummary: string | null } | null;
  intentId: string | null;
  intentState: payments.AuthorizeResult['state'] | null;
  methodLabel: string | null;
  decline: payments.Decline | null;
  /** Orders created on a pending payment that was finally declined (cancelled by orders) */
  cancelledOrders: { orderId: string; ref: string }[];
}

/** sessions.credit (phase 3, wallet) */
export interface StoredCredit {
  use: boolean;
  /** Requested amount in minor units; null = as much as covers the total */
  amount: number | null;
  /** Balance seen at the last quote (minor units) and where it came from */
  available: number;
  sourceNote: string;
}

/** change_sets.changes: the changes with the totals they lead to */
export interface StoredChangeSet {
  items: StoredChange[];
  deltas: { label: string; amount: number }[];
  partialOrder: boolean;
  currency: string;
}

/** Display and pricing facts of one line, kept with the quote (session_lines has no title or image columns) */
export interface LineInfo {
  title: string;
  /** Product slug for links (absent on quotes stored before it was kept) */
  productSlug?: string | null;
  variantLabel: string;
  condition: string;
  image: common.MediaRef | null;
  seller: cart.SellerLabel;
  categoryId: string | null;
  brandId: string | null;
  purchaseLimit: number | null;
  returnTerms: orders.ReturnTermsSnapshot;
  responseTargetDays: number | null;
  dispatch: { businessDays: number; sameDayCutoff: string | null; shipsFrom: string };
}

export interface Shippability {
  shippable: boolean;
  reason: 'excluded_area' | 'po_box' | 'military' | 'outside_seller_coverage' | 'item_too_large' | null;
  message: string | null;
}

/** sessions.totals: the computed quote */
export interface StoredQuote {
  fingerprint: string;
  lineInfo: Record<string, LineInfo>;
  shippability: Record<string, Shippability>;
  /** Promotion allocations per line (frozen on the order items) */
  lineAllocations: Record<string, promotions.DiscountAllocation[]>;
  /** Shipping discount per package (minor units) */
  shippingDiscounts: Record<string, number>;
  /** Who pays each package's shipping discount (minor units); the Marketly part is credited to the seller as shipping */
  shippingFunding?: Record<string, { platform: number; seller: number }>;
  coupons: CouponResult[];
  discounts: DiscountLine[];
  tax: { jurisdiction: string; label: string; rate: number } | null;
  totals: QuoteTotals;
  /** Cart lines that could not be checked out when the session started */
  excluded: CheckoutLine[];
  evaluation: { id: string; validUntil: string } | null;
  /** Address step messages */
  addressBookNote: string | null;
  /** Cart item ids the session was started from (removed from the cart once the order exists) */
  cartItemIds: string[];
}

/** One entry of change_sets.changes: the customer-facing change and what applying it means */
export interface StoredChange {
  change: Change;
  apply: {
    unitPrice?: number;
    available?: number;
    maxQuantity?: number;
    options?: unknown[];
    optionId?: string | null;
    couponCode?: string;
    /** terms_changed: the offer's current termsVersion, set on the line when the customer accepts */
    termsVersion?: number;
    /**
     * terms_changed: who ships the offer now (Offer.shipping.fulfilledBy) when it differs from the line; accepting
     * moves the line to the offer's current fulfilment, profile, dispatch and package
     */
    fulfilledBy?: FulfilledBy;
  };
}

/* ================================================================ money */

export const m = (amount: number, currency: string): common.Money => ({ amount, currency });
export const fmt = (amount: number, currency: string) => formatMoney(m(amount, currency));

/* ================================================================ labels */

export const CONDITION_LABEL: Record<string, string> = {
  new: 'New',
  used_like_new: 'Used – Like new',
  used_good: 'Used – Good',
  used_acceptable: 'Used – Acceptable',
  refurbished: 'Refurbished',
};

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export type FulfilledBy = CheckoutPackage['fulfilledBy'];

/** Who ships a line when nothing else says so: the Official Store's warehouse, or the seller */
export const defaultFulfilledBy = (ownerType: string): FulfilledBy => (ownerType === 'official' ? 'official_warehouse' : 'seller');

/**
 * The offer's effective customer-facing fulfilment (Offer.shipping: who ships it, the profile it is quoted with, its
 * dispatch and ships-from). Checkout never reads shippingProfileId and dispatch directly; the fallback only covers an
 * offer read without shipping resolved (offers always resolves it).
 */
export function shippingOf(offer: offers.Offer): offers.OfferShipping {
  return offer.shipping ?? { fulfilledBy: offer.fulfilledBy ?? defaultFulfilledBy(offer.ownerType), profileId: offer.shippingProfileId, dispatch: offer.dispatch };
}

/** Owner + seller + fulfilledBy + ship-from, the same key as the cart: a seller's Marketly-fulfilled and self-shipped items are two packages */
export const packageKey = (ownerType: string, sellerId: string | null | undefined, fulfilledBy: string, shipsFrom: string) => `${ownerType}:${sellerId ?? 'official'}:${fulfilledBy}:${shipsFrom}`;

/** 'Sold and shipped by Northwind Audio', or 'Sold by Northwind Audio · Shipped by Marketly' when Marketly fulfils the package */
export const soldAndShippedBy = (sellerName: string, fulfilledBy: string) => (fulfilledBy === 'marketly_service' ? `Sold by ${sellerName} · Shipped by Marketly` : `Sold and shipped by ${sellerName}`);

export const FULFILMENT_LABEL: Record<FulfilledBy, string> = {
  official_warehouse: 'Shipped by Marketly',
  seller: 'Shipped by the seller',
  marketly_service: 'Shipped by Marketly',
};

export const OFFICIAL_SELLER: cart.SellerLabel = { ownerType: 'official', id: null, name: OFFICIAL_STORE_NAME, slug: 'official-store', official: true, verified: true, logo: null };

export const DOUBLE_SUBMIT_NOTE = "Tapping twice or refreshing won't create two orders or charge you twice.";
export const LEGAL_TEXT = 'By placing your order you agree to the Purchase terms and the return terms shown for each package.';
export const TERMS_NOTE = "Your order keeps the purchase terms and each seller's return terms as they were when you ordered.";
export const GUEST_NOTE = "We'll email a link to view and manage this order.";
export const CHANGES_INTRO = 'We checked your order again before charging you. Nothing has been charged yet.';
export const PARTIAL_NOTE = "If you remove an item, the rest of your order can still go through. You'll only be charged for the items you keep.";

export function packagesNote(count: number): string {
  if (count === 0) return 'Nothing to ship yet.';
  if (count === 1) return 'Your items ship in 1 package.';
  return `Your items ship in ${count} packages from different places, so each has its own options and arrival date.`;
}

export function sellerSupportLine(seller: cart.SellerLabel, days: number | null): string {
  const d = days && days > 0 ? days : 1;
  const who = seller.official ? 'Marketly support' : 'Seller support';
  return `${who} replies within ${plural(d, 'business day')}`;
}

/** 'Visa •••• 4417' */
export const cardLabel = (brand: string, last4: string) => `${brand.charAt(0).toUpperCase()}${brand.slice(1)} •••• ${last4}`;

/** 'Delivery dates below are for Portland, OR 97205.' */
export const locationNote = (a: common.Address) => `Delivery dates below are for ${a.city}, ${a.region} ${a.postalCode}.`;

/* ================================================================ sales tax (launch rate table) */

/**
 * State base sales-tax rates applied to items after discounts (shipping is not taxed at launch).
 * Spec integration "Sales tax rates": a rate table at launch (providers/tax.ts behind the TaxProvider port), a tax service adapter later.
 */
export const STATE_TAX_RATES: Readonly<Record<string, number>> = {
  AL: 0.04, AK: 0, AZ: 0.056, AR: 0.065, CA: 0.0725, CO: 0.029, CT: 0.0635, DE: 0, DC: 0.06, FL: 0.06, GA: 0.04, HI: 0.04,
  ID: 0.06, IL: 0.0625, IN: 0.07, IA: 0.06, KS: 0.065, KY: 0.06, LA: 0.0445, ME: 0.055, MD: 0.06, MA: 0.0625, MI: 0.06,
  MN: 0.06875, MS: 0.07, MO: 0.04225, MT: 0, NE: 0.055, NV: 0.0685, NH: 0, NJ: 0.06625, NM: 0.04875, NY: 0.04, NC: 0.0475,
  ND: 0.05, OH: 0.0575, OK: 0.045, OR: 0, PA: 0.06, RI: 0.07, SC: 0.06, SD: 0.042, TN: 0.07, TX: 0.0625, UT: 0.061,
  VT: 0.06, VA: 0.053, WA: 0.065, WV: 0.06, WI: 0.05, WY: 0.04,
};

const STATE_NAMES: Readonly<Record<string, string>> = {
  AK: 'Alaska', DE: 'Delaware', MT: 'Montana', NH: 'New Hampshire', OR: 'Oregon',
};

export function taxFor(address: common.Address | null): { jurisdiction: string; label: string; rate: number } | null {
  if (!address) return null;
  const region = address.region.trim().toUpperCase();
  const rate = STATE_TAX_RATES[region] ?? 0;
  const pct = `${Number((rate * 100).toFixed(3))}%`;
  const label = rate === 0 ? `Tax (${STATE_NAMES[region] ?? region} has no sales tax)` : `Sales tax (${region} ${pct})`;
  return { jurisdiction: region, label, rate };
}

/** Tax of a line amount, rounded half away from zero to a cent */
export const taxOf = (amount: number, rate: number) => (amount <= 0 || rate <= 0 ? 0 : Math.round(amount * rate));

/* ================================================================ changes */

type Choice = Change['choices'][number];

export function choicesFor(kind: Change['kind'], o: { alternatives: boolean; otherOptions: boolean }): { choices: Choice[]; defaultChoice: Choice } {
  const alt: Choice[] = o.alternatives ? ['choose_offer'] : [];
  switch (kind) {
    case 'price_increased':
      return { choices: ['accept', 'remove', ...alt], defaultChoice: 'accept' };
    case 'price_decreased':
      return { choices: ['accept'], defaultChoice: 'accept' };
    case 'quantity_reduced':
      return { choices: ['reduce_quantity', 'remove', ...alt], defaultChoice: 'reduce_quantity' };
    case 'purchase_limit':
      return { choices: ['reduce_quantity', 'remove'], defaultChoice: 'reduce_quantity' };
    case 'out_of_stock':
    case 'offer_ended':
    case 'not_shippable':
      return { choices: ['remove', ...alt], defaultChoice: 'remove' };
    case 'delivery_date_changed':
    case 'shipping_cost_changed':
      return { choices: o.otherOptions ? ['accept', 'choose_other_option'] : ['accept'], defaultChoice: 'accept' };
    case 'delivery_option_unavailable':
      return { choices: ['choose_other_option', 'remove'], defaultChoice: 'choose_other_option' };
    case 'coupon_no_longer_applies':
      return { choices: ['keep_without_discount'], defaultChoice: 'keep_without_discount' };
    case 'coupon_amount_changed':
      return { choices: ['accept', 'keep_without_discount'], defaultChoice: 'accept' };
    case 'terms_changed':
      return { choices: ['accept', 'remove', ...alt], defaultChoice: 'accept' };
  }
}

export const HEADLINES: Record<Change['kind'], string> = {
  price_increased: 'Price went up',
  price_decreased: 'Price went down',
  quantity_reduced: 'Less stock available',
  out_of_stock: 'Out of stock',
  offer_ended: 'Offer no longer available',
  delivery_date_changed: 'Delivery date moved',
  delivery_option_unavailable: 'Delivery option no longer available',
  shipping_cost_changed: 'Shipping cost changed',
  coupon_no_longer_applies: 'Coupon no longer applies',
  coupon_amount_changed: 'Coupon amount changed',
  not_shippable: "Can't ship to this address",
  purchase_limit: 'Purchase limit reached',
  terms_changed: 'Return or delivery terms changed',
};

/* ================================================================ steps */

export interface StepFacts {
  hasEmail: boolean;
  hasAddress: boolean;
  notShippable: number;
  included: number;
  packagesWithoutOption: string[];
  rejectedCoupons: number;
  hasPayment: boolean;
  changesPending: boolean;
}

export function stepsOf(f: StepFacts): { steps: StepState[]; blockers: string[] } {
  const blockers: string[] = [];
  const steps: StepState[] = [];
  steps.push(f.hasEmail ? { key: 'account', status: 'done' } : { key: 'account', status: 'todo', message: 'Add your email so we can send your order confirmation.' });
  if (!f.hasEmail) blockers.push('Add your email address');

  if (!f.hasAddress) {
    steps.push({ key: 'address', status: 'todo', message: 'Choose where to deliver your order.' });
    blockers.push('Choose a delivery address');
  } else if (f.included === 0 && f.notShippable > 0) {
    steps.push({ key: 'address', status: 'needs_attention', message: "None of your items can ship to this address." });
    blockers.push('None of your items can ship to this address');
  } else if (f.notShippable > 0) {
    steps.push({ key: 'address', status: 'needs_attention', message: `${plural(f.notShippable, 'item')} can't ship to this address and will stay in your cart.` });
  } else steps.push({ key: 'address', status: 'done' });

  if (!f.hasAddress) steps.push({ key: 'delivery', status: 'todo' });
  else if (f.packagesWithoutOption.length) {
    steps.push({ key: 'delivery', status: 'needs_attention', message: 'Choose a delivery option for every package.' });
    for (const label of f.packagesWithoutOption) blockers.push(`Choose a delivery option for ${label}`);
  } else steps.push({ key: 'delivery', status: 'done' });

  steps.push(f.rejectedCoupons ? { key: 'coupons', status: 'needs_attention', message: `${plural(f.rejectedCoupons, 'code')} could not be applied.` } : { key: 'coupons', status: 'done' });

  steps.push(f.hasPayment ? { key: 'payment', status: 'done' } : { key: 'payment', status: 'todo', message: 'Choose how to pay.' });
  if (!f.hasPayment) blockers.push('Choose a payment method');

  if (f.included === 0 && !(f.hasAddress && f.notShippable > 0)) blockers.push('There is nothing left to order');
  if (f.changesPending) blockers.push('Review the changes we found before placing your order');
  steps.push(blockers.length ? { key: 'review', status: f.changesPending ? 'needs_attention' : 'todo' } : { key: 'review', status: 'done' });
  return { steps, blockers };
}

/** Steps missing for Place order (CHECKOUT_INCOMPLETE details.missingSteps) */
export function missingSteps(f: StepFacts): string[] {
  const out: string[] = [];
  if (!f.hasEmail) out.push('account');
  if (!f.hasAddress || f.included === 0) out.push('address');
  if (f.hasAddress && f.packagesWithoutOption.length) out.push('delivery');
  if (!f.hasPayment) out.push('payment');
  return out;
}

/* ================================================================ misc */

export function stableHash(value: unknown): string {
  // FNV-1a over the JSON text: a cheap fingerprint of the quote (not security relevant)
  const s = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + s.length.toString(16);
}

export function emptyTotals(currency: string): QuoteTotals {
  const z = m(0, currency);
  return { itemCount: 0, items: z, discounts: [], discountTotal: z, shippingByPackage: [], shippingTotal: z, tax: [], taxTotal: z, taxNote: null, creditApplied: z, total: z, perPackage: [] };
}

export const isoDay = (d: string) => d.slice(0, 10);
