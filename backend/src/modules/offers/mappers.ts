/**
 * Row (snake_case) → API type (camelCase) mapping, one place per type.
 */
import { money as checkedMoney } from '../../kernel/lib/money.js';
import { stringList } from '../../kernel/lib/text.js';
import type * as common from '../../spec/common.js';
import { OFFICIAL_STORE_NAME } from '../../spec/common.js';
import type { ServiceTerms } from '../../spec/fulfillment-service.js';
import type * as shipping from '../../spec/shipping.js';
import type {
  BulkRowError,
  BulkUpdateJob,
  BulkUpdateRow,
  BulkUpdateTotals,
  CompareAtPrice,
  DispatchTerms,
  FeaturedEligibility,
  FeaturedRule,
  IneligibilityReason,
  Offer,
  OfferShipping,
  OfferStatusEntry,
  PricePoint,
  ReturnTerms,
  StatusReason,
  WarrantyTerms,
} from '../../spec/offers.js';
import { changePct as changePctOf, compareAtExplanation, dispatchLabel, reason, returnSummary, warrantyTerms } from './domain/rules.js';
import type { BulkJobRec, BulkRowRec, EligibilityRec, OfferRec, PriceHistoryRec, RuleRec, StatusLogRec } from './ports.js';

/** The Official Store's display name wherever a seller name is shown */
export const OFFICIAL_NAME = OFFICIAL_STORE_NAME;

export const iso = (d: Date | string | null | undefined): string | null => (d ? (d instanceof Date ? d.toISOString() : new Date(d).toISOString()) : null);
export const isoReq = (d: Date | string): string => iso(d)!;

/** Money in integer minor units (the kernel refuses anything else) */
export const money = (amount: number, currency: string): common.Money => checkedMoney(Number(amount), currency);

/** Rows by key, in their order (Map.groupBy, which the ES2023 lib does not type yet) */
export function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/** Actors are stored as kind + id (history tables) or as JSON text (job and rule columns) */
export const actorOf = (kind: string | null | undefined, id: string | null | undefined): common.Actor => ({ kind: (kind ?? 'system') as common.Actor['kind'], id: id ?? null });

export function actorText(a: common.Actor): string {
  return JSON.stringify({ kind: a.kind, id: a.id ?? null, ...(a.name ? { name: a.name } : {}) });
}

export function actorFromText(s: string | null | undefined): common.Actor | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as common.Actor;
    if (v && typeof v === 'object' && typeof v.kind === 'string') return { kind: v.kind, id: v.id ?? null, ...(v.name ? { name: v.name } : {}) };
  } catch {
    /* plain text */
  }
  return { kind: 'system', id: null, name: s };
}

/** HH:mm from a time column ('14:00:00') */
export const hhmm = (t: string | null | undefined) => (t ? t.slice(0, 5) : null);

export function dispatchOf(r: OfferRec): DispatchTerms {
  return { businessDays: r.dispatch_business_days, sameDayCutoff: hhmm(r.same_day_cutoff), shipsFrom: r.ships_from, label: dispatchLabel(r.dispatch_business_days) };
}

/* ---------------------------------------------------------------- effective fulfilment (Fulfilled by Marketly) */

/** Customer-facing fulfilment of an offer (Offer.shipping) and whether the fulfilment lets it sell */
export interface Fulfilment {
  shipping: OfferShipping;
  /** False for a Marketly-fulfilled offer the service does not let sell: enrollment suspended or offboarding, service unavailable or off (decision D5) */
  sellable: boolean;
  /** Why it does not sell (status reason text), null when it sells */
  holdText: string | null;
  /** The SKU's parcel for marketly_service quotes; null: the default parcel */
  parcel: shipping.Parcel | null;
}

/** Status reason text of an offer Fulfilled by Marketly does not let sell (it never switches to seller shipping) */
export const SERVICE_HOLD: Record<NonNullable<ServiceTerms['notSellableReason']>, string> = {
  enrollment_suspended: 'The Fulfilled by Marketly enrollment is suspended, so this offer is not on sale until it is reinstated',
  enrollment_offboarding: 'The seller is leaving Fulfilled by Marketly, so this offer is not on sale while the stock is removed',
  service_unavailable: 'Fulfilled by Marketly is not available right now, so this offer is not on sale',
};

/** Seller and Official Store offers: their own profile and dispatch terms */
export function ownFulfilment(r: OfferRec): Fulfilment {
  return { shipping: { fulfilledBy: r.fulfilled_by, profileId: r.shipping_profile_id, dispatch: dispatchOf(r) }, sellable: true, holdText: null, parcel: null };
}

/**
 * Marketly-fulfilled offers: Marketly's profile, dispatch and ships-from (fulfillment-service.getServiceTerms). Without
 * terms (the service is off or no longer fulfils it) the offer does not sell and is never treated as seller-shipped; its
 * saved profile and dispatch only fill the shape.
 */
export function serviceFulfilment(r: OfferRec, t: ServiceTerms | null | undefined): Fulfilment {
  if (!t) return { shipping: { fulfilledBy: 'marketly_service', profileId: r.shipping_profile_id, dispatch: dispatchOf(r) }, sellable: false, holdText: SERVICE_HOLD.service_unavailable, parcel: null };
  const days = t.dispatch.businessDays;
  const d = t.parcel?.dimensionsCm;
  return {
    shipping: { fulfilledBy: 'marketly_service', profileId: t.shippingProfileId, dispatch: { businessDays: days, sameDayCutoff: t.dispatch.sameDayCutoff ?? null, shipsFrom: t.shipsFrom, label: dispatchLabel(days) } },
    sellable: t.sellable,
    holdText: t.sellable ? null : SERVICE_HOLD[t.notSellableReason ?? 'service_unavailable'],
    parcel: t.parcel ? { weightGrams: t.parcel.weightGrams, ...(d ? { lengthCm: d.length, widthCm: d.width, heightCm: d.height } : {}) } : null,
  };
}

/** Statuses a service hold shows as Ineligible (a paused offer stays paused) */
const HOLDABLE = ['active', 'out_of_stock'];

/** True when the offer is held by its fulfilment: shown Ineligible although its stored status sells */
export const serviceHeld = (r: OfferRec, f: Fulfilment | undefined) => Boolean(f && !f.sellable && HOLDABLE.includes(r.status));

/** The status customers and other modules see */
export const shownStatus = (r: OfferRec, f: Fulfilment | undefined): Offer['status'] => (serviceHeld(r, f) ? 'ineligible' : (r.status as Offer['status']));

export function serviceHoldReason(f: Fulfilment, at: Date | string): StatusReason {
  return { code: 'fulfillment_service_suspended', text: f.holdText ?? SERVICE_HOLD.service_unavailable, affectedActivity: 'Sales of this offer', appealRoute: null, reviewDate: null, actor: { kind: 'system', id: null }, at: isoReq(at) };
}

/** Featured-offer reason of an offer Fulfilled by Marketly is not selling (IneligibilityReason has no service code) */
export const SERVICE_INELIGIBLE: IneligibilityReason = {
  code: 'offer_not_active',
  message: 'Not eligible for featured offer: Fulfilled by Marketly is not selling this offer right now',
  howToFix: 'The offer sells again when your Fulfilled by Marketly enrollment is reinstated or the SKU leaves the service.',
};

export const FULFILLED_BY_MARKETLY_LABEL = 'Ships from Marketly';

export const FULFILLMENT_NOTE = "Fulfilled by Marketly: customers see Marketly's delivery terms. Your dispatch time and shipping profile are saved but apply only if you leave the service.";

export function returnTermsOf(r: OfferRec): ReturnTerms {
  return {
    kind: r.return_kind as ReturnTerms['kind'],
    windowDays: r.return_window_days,
    freeReturnShipping: r.free_return_shipping,
    categoryException: r.return_category_exception,
    summary: returnSummary(r.return_window_days, r.free_return_shipping),
    policyVersion: r.return_policy_version,
  };
}

export function warrantyOf(r: OfferRec): WarrantyTerms {
  const w = warrantyTerms({ kind: r.warranty_kind as WarrantyTerms['kind'], months: r.warranty_months }, r.owner_type);
  return { ...w, handledBy: (r.warranty_handled_by as WarrantyTerms['handledBy']) ?? w.handledBy ?? null };
}

export function compareAtOf(r: OfferRec, sellerName: string, lookbackDays: number): CompareAtPrice | null {
  if (r.compare_at_amount === null || !r.compare_at_verified || !r.compare_at_basis) return null;
  const basis = r.compare_at_basis as CompareAtPrice['basis'];
  return { amount: money(r.compare_at_amount, r.currency), basis, verified: true, explanation: compareAtExplanation(basis, r.owner_type === 'official' ? `the ${OFFICIAL_NAME}` : sellerName, lookbackDays) };
}

export function eligibilityOf(r: OfferRec, e: EligibilityRec | undefined): FeaturedEligibility {
  if (e) return { eligible: e.eligible, reasons: (Array.isArray(e.reasons) ? e.reasons : []) as unknown as IneligibilityReason[], evaluatedAt: isoReq(e.evaluated_at) };
  const reasons = r.status === 'active' ? [] : [reason(r.status === 'out_of_stock' ? 'out_of_stock' : 'offer_not_active')];
  return { eligible: reasons.length === 0, reasons, evaluatedAt: isoReq(r.updated_at) };
}

/** Status reason as the API shows it (the stored JSON may also carry internal keys such as enforcementId) */
export function statusReasonOf(r: OfferRec): StatusReason | null {
  const s = r.status_reason as (StatusReason & { enforcementId?: string }) | null;
  if (!s || typeof s !== 'object' || !s.code) return null;
  const { enforcementId: _e, ...reason } = s;
  return reason;
}

/** Trust enforcement that removed or held the offer (kept in status_reason / ineligible_source) */
export function enforcementIdOf(r: OfferRec): string | null {
  const s = r.status_reason as { code?: string; enforcementId?: string } | null;
  if (s?.code === 'enforcement' && s.enforcementId) return s.enforcementId;
  const src = r.ineligible_source as { kind?: string; id?: string | null } | null;
  return src?.kind === 'enforcement' && src.id ? src.id : null;
}

/** 'Aurora Headphones – Black': product title with the variant label (title alone when the variant has no options) */
export function offerTitle(productTitle: string, options: Record<string, string> | null | undefined): string {
  return Object.keys(options ?? {}).length ? `${productTitle} – ${variantLabel(options)}` : productTitle;
}

export function toOffer(r: OfferRec, x: { sellerName: string; eligibility?: EligibilityRec; lookbackDays: number; fulfilment?: Fulfilment; now?: Date }): Offer {
  const missing = stringList(r.missing_items);
  const f = x.fulfilment ?? ownFulfilment(r);
  const held = serviceHeld(r, f);
  const eligibility = eligibilityOf(r, x.eligibility);
  return {
    id: r.id,
    ownerType: r.owner_type,
    sellerId: r.seller_id,
    sellerName: r.owner_type === 'official' ? OFFICIAL_NAME : x.sellerName,
    productId: r.product_id,
    variantId: r.variant_id,
    title: r.title,
    condition: r.condition as Offer['condition'],
    conditionNotes: r.condition_notes,
    includedItems: stringList(r.included_items),
    missingItems: missing,
    complete: missing.length === 0,
    missingItemsStale: Boolean(r.missing_items_stale),
    sellerSku: r.seller_sku,
    stockItemId: r.stock_item_id,
    price: money(r.price_amount, r.currency),
    compareAt: compareAtOf(r, x.sellerName, x.lookbackDays),
    saleEndsAt: iso(r.sale_ends_at),
    purchaseLimit: r.purchase_limit,
    dispatch: dispatchOf(r),
    shippingProfileId: r.shipping_profile_id,
    fulfilledBy: r.fulfilled_by,
    shipping: f.shipping,
    returnTerms: returnTermsOf(r),
    warranty: warrantyOf(r),
    status: shownStatus(r, f),
    statusReason: held ? serviceHoldReason(f, x.now ?? r.updated_at) : statusReasonOf(r),
    featuredEligibility: held ? { ...eligibility, eligible: false, reasons: [SERVICE_INELIGIBLE, ...eligibility.reasons.filter((e) => e.message !== SERVICE_INELIGIBLE.message)] } : eligibility,
    publishOnApproval: r.publish_on_approval,
    termsVersion: r.terms_version,
    publishedAt: iso(r.published_at),
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
  };
}

export function pricePoint(h: PriceHistoryRec, currency: string): PricePoint {
  return {
    price: money(h.price_amount, currency),
    compareAt: h.compare_at_amount !== null ? money(h.compare_at_amount, currency) : null,
    from: isoReq(h.valid_from),
    to: iso(h.valid_to),
    changedBy: actorOf(h.actor_kind, h.actor_id),
    changeId: h.price_change_id,
  };
}

export function statusEntry(l: StatusLogRec): OfferStatusEntry {
  return { from: l.from_status, to: l.to_status, event: l.event, reasonCode: l.reason_code, reason: l.reason, actor: actorOf(l.actor_kind, l.actor_id), at: isoReq(l.at) };
}

export const EMPTY_TOTALS: BulkUpdateTotals = { rows: 0, ready: 0, errors: 0, unchanged: 0, priceChanges: 0, stockChanges: 0, pendingApproval: 0, applied: 0, skipped: 0 };

/** totals jsonb also keeps the Official Store file's reason (`reason`), which is not part of the API totals */
export function totalsOf(j: BulkJobRec): BulkUpdateTotals {
  const t = (j.totals ?? {}) as Record<string, unknown>;
  const out = { ...EMPTY_TOTALS };
  for (const k of Object.keys(EMPTY_TOTALS) as (keyof BulkUpdateTotals)[]) if (typeof t[k] === 'number') out[k] = t[k] as number;
  return out;
}

export const bulkReasonOf = (j: BulkJobRec): string | null => {
  const r = ((j.totals ?? {}) as Record<string, unknown>).reason;
  return typeof r === 'string' ? r : null;
};

export function bulkJob(j: BulkJobRec): BulkUpdateJob {
  return {
    id: j.id,
    ownerType: j.owner_type as BulkUpdateJob['ownerType'],
    fileName: j.file_name,
    uploadedBy: actorFromText(j.uploaded_by) ?? { kind: 'system', id: null },
    uploadedAt: isoReq(j.uploaded_at),
    state: j.state as BulkUpdateJob['state'],
    totals: totalsOf(j),
    appliedBy: actorFromText(j.applied_by),
    appliedAt: iso(j.applied_at),
    expiresAt: isoReq(j.expires_at),
    failure: j.failure,
  };
}

/** largeChange: the row would need confirmLargeChanges at apply (worked out by the caller, BulkPart.rows) */
export function bulkRow(r: BulkRowRec, currency: string, productLabel: string | null, largeChange = false): BulkUpdateRow {
  const changePct = r.price_from !== null && r.price_to !== null ? changePctOf(r.price_from, r.price_to) : null;
  return {
    row: r.row_no,
    sellerSku: r.seller_sku,
    offerId: r.offer_id,
    productLabel,
    priceFrom: r.price_from !== null ? money(r.price_from, currency) : null,
    priceTo: r.price_to !== null ? money(r.price_to, currency) : null,
    quantityFrom: r.qty_from,
    quantityTo: r.qty_to,
    result: r.result as BulkUpdateRow['result'],
    error: r.error_code ? ({ code: r.error_code as BulkRowError['code'], message: r.error_message ?? '' } satisfies BulkRowError) : null,
    changePct,
    largeChange,
  };
}

export function featuredRule(r: RuleRec): FeaturedRule {
  return {
    version: r.version,
    effectiveFrom: isoReq(r.effective_from),
    text: r.text,
    steps: stringList(r.steps),
    parameters: r.parameters as unknown as FeaturedRule['parameters'],
    publishedBy: actorFromText(r.published_by) ?? { kind: 'system', id: null },
    publishedAt: isoReq(r.published_at),
  };
}

export const variantLabel = (options: Record<string, string> | null | undefined) => {
  const vals = Object.values(options ?? {});
  return vals.length ? vals.join(' / ') : 'Standard';
};
