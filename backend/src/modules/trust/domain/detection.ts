/**
 * Automated detection rules (trust.detection_rules) and their pure evaluators over risk_signals windows.
 * The service feeds signals from consumed events; trust.run-detection evaluates every active rule and raises or
 * extends a report per hit (de-duplicated by the hit's key).
 */
import type { ReportType, SubjectType } from './rules.js';

export interface SignalRec {
  id: string;
  kind: string;
  subject_type: string;
  subject_id: string;
  features: Record<string, unknown>;
  at: Date;
}

export interface RuleSeed {
  key: string;
  description: string;
  type: ReportType;
  /** Signal kind the rule reads */
  signal: string;
  active: boolean;
  thresholds: Record<string, unknown>;
  baseScore: number;
}

export interface HitSubject {
  type: SubjectType;
  id: string;
  label: string;
  ref?: string | null;
}

export interface Hit {
  dedupeKey: string;
  title: string;
  subjects: HitSubject[];
  evidence: string;
  /** Signals behind the hit (a hit is raised again only when one of them is new) */
  signalIds: string[];
}

export const RULES: RuleSeed[] = [
  {
    key: 'reviews.burst',
    description: 'Many reviews of one product published in a short window (possible paid or fake reviews)',
    type: 'fake_reviews',
    signal: 'review_published',
    active: true,
    thresholds: { windowHours: 24, minReviews: 8 },
    baseScore: 50,
  },
  {
    key: 'orders.linked_new_accounts',
    description: 'Several different accounts ordering to the same delivery address in a short window',
    type: 'suspicious_orders',
    signal: 'order_placed',
    active: true,
    thresholds: { windowHours: 72, minAccounts: 3 },
    baseScore: 55,
  },
  {
    key: 'payments.card_testing',
    description: 'Repeated declined payments in one checkout session (card testing)',
    type: 'suspicious_orders',
    signal: 'payment_failed',
    active: true,
    thresholds: { windowMinutes: 60, minFailures: 5 },
    baseScore: 60,
  },
  {
    key: 'payments.repeated_chargebacks',
    description: 'Repeated chargebacks on one seller’s orders',
    type: 'suspicious_orders',
    signal: 'chargeback',
    active: true,
    thresholds: { windowDays: 90, minChargebacks: 3 },
    baseScore: 55,
  },
  {
    key: 'offers.price_far_below_authorized',
    description: 'A new offer priced far below the product’s other offers (possible counterfeit)',
    type: 'counterfeit',
    signal: 'offer_created',
    active: true,
    thresholds: { maxPctOfReference: 50, windowHours: 24 },
    baseScore: 45,
  },
  {
    key: 'offers.restricted_brand',
    description: 'A seller lists a brand that needs brand authorisation',
    type: 'counterfeit',
    signal: 'offer_created',
    active: true,
    thresholds: { brandIds: [], allowedSellerIds: [], windowHours: 24 },
    baseScore: 40,
  },
  {
    key: 'sellers.application_duplicates',
    description: 'A seller application shares a tax id, bank token or address with another seller account',
    type: 'seller_application',
    signal: 'application_submitted',
    active: true,
    thresholds: { fields: ['taxIdHash', 'bankTokenHash', 'addressKey'], windowDays: 365 },
    baseScore: 50,
  },
];

export const ruleSeed = (key: string) => RULES.find((r) => r.key === key);

const num = (t: Record<string, unknown>, k: string, d: number) => (Number.isFinite(Number(t[k])) && Number(t[k]) > 0 ? Number(t[k]) : d);
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** How far back a rule reads signals */
export function windowMs(seed: RuleSeed, t: Record<string, unknown>): number {
  if (t.windowMinutes !== undefined) return num(t, 'windowMinutes', 60) * 60_000;
  if (t.windowHours !== undefined) return num(t, 'windowHours', 24) * 3_600_000;
  if (t.windowDays !== undefined) return num(t, 'windowDays', 30) * 86_400_000;
  return seed.signal === 'chargeback' ? 90 * 86_400_000 : 24 * 3_600_000;
}

function groupBy(signals: SignalRec[], key: (s: SignalRec) => string | null): Map<string, SignalRec[]> {
  const out = new Map<string, SignalRec[]>();
  for (const s of signals) {
    const k = key(s);
    if (!k) continue;
    const list = out.get(k) ?? [];
    list.push(s);
    out.set(k, list);
  }
  return out;
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** Evaluates one rule over the signals of its kind inside its window */
export function evaluate(key: string, t: Record<string, unknown>, signals: SignalRec[]): Hit[] {
  const hits: Hit[] = [];
  switch (key) {
    case 'reviews.burst': {
      const min = num(t, 'minReviews', 8);
      for (const [productId, list] of groupBy(signals, (s) => s.subject_id)) {
        if (list.length < min) continue;
        const sellers = uniq(list.map((s) => str(s.features.sellerId)).filter((x): x is string => !!x));
        const verified = list.filter((s) => s.features.verified === true).length;
        const avg = list.reduce((n, s) => n + Number(s.features.rating ?? 0), 0) / list.length;
        hits.push({
          dedupeKey: `reviews.burst:${productId}`,
          title: `Review burst: ${list.length} reviews of one product`,
          subjects: [
            { type: 'product', id: productId, label: 'Reviewed product' },
            ...sellers.map((id) => ({ type: 'seller' as const, id, label: 'Seller' })),
            ...list.slice(0, 20).flatMap((s) => (str(s.features.reviewId) ? [{ type: 'review' as const, id: s.features.reviewId as string, label: `Review (${s.features.rating ?? '?'}★)` }] : [])),
          ],
          evidence: `${list.length} reviews published inside the window (${verified} verified purchases, average ${avg.toFixed(1)}★)`,
          signalIds: list.map((s) => s.id),
        });
      }
      break;
    }
    case 'orders.linked_new_accounts': {
      const min = num(t, 'minAccounts', 3);
      for (const [addr, list] of groupBy(signals, (s) => str(s.features.addressKey))) {
        const accounts = uniq(list.map((s) => str(s.features.customerId) ?? str(s.features.guestEmail)).filter((x): x is string => !!x));
        if (accounts.length < min) continue;
        const customers = uniq(list.map((s) => str(s.features.customerId)).filter((x): x is string => !!x));
        hits.push({
          dedupeKey: `orders.linked_new_accounts:${addr}`,
          title: `${accounts.length} accounts ordering to one address`,
          subjects: [
            ...customers.slice(0, 10).map((id) => ({ type: 'customer' as const, id, label: 'Customer' })),
            ...list.slice(0, 10).map((s) => ({ type: 'order' as const, id: s.subject_id, label: `Order ${str(s.features.orderRef) ?? ''}`.trim(), ref: str(s.features.orderRef) })),
          ],
          evidence: `${accounts.length} different accounts placed ${list.length} orders to the same delivery address inside the window`,
          signalIds: list.map((s) => s.id),
        });
      }
      break;
    }
    case 'payments.card_testing': {
      const min = num(t, 'minFailures', 5);
      for (const [session, list] of groupBy(signals, (s) => str(s.features.checkoutSessionId))) {
        if (list.length < min) continue;
        const categories = uniq(list.map((s) => str(s.features.declineCategory)).filter(Boolean));
        hits.push({
          dedupeKey: `payments.card_testing:${session}`,
          title: `Card testing: ${list.length} declined payments in one checkout`,
          subjects: uniq(list.map((s) => s.subject_id))
            .slice(0, 10)
            .map((id) => ({ type: 'payment' as const, id, label: 'Declined payment' })),
          evidence: `${list.length} declined payments inside the window (${categories.join(', ') || 'declined'})`,
          signalIds: list.map((s) => s.id),
        });
      }
      break;
    }
    case 'payments.repeated_chargebacks': {
      const min = num(t, 'minChargebacks', 3);
      for (const [sellerId, list] of groupBy(signals, (s) => (s.subject_type === 'seller' ? s.subject_id : null))) {
        if (list.length < min) continue;
        hits.push({
          dedupeKey: `payments.repeated_chargebacks:${sellerId}`,
          title: `${list.length} chargebacks on one seller’s orders`,
          subjects: [
            { type: 'seller', id: sellerId, label: 'Seller' },
            ...uniq(list.map((s) => str(s.features.orderId)).filter((x): x is string => !!x))
              .slice(0, 10)
              .map((id) => ({ type: 'order' as const, id, label: 'Order with a chargeback' })),
          ],
          evidence: `${list.length} chargebacks or disputes opened inside the window`,
          signalIds: list.map((s) => s.id),
        });
      }
      break;
    }
    case 'offers.price_far_below_authorized': {
      const pct = num(t, 'maxPctOfReference', 50);
      for (const s of signals) {
        const price = Number(s.features.price);
        const ref = Number(s.features.reference);
        if (!(price > 0) || !(ref > 0) || price * 100 >= ref * pct) continue;
        hits.push({
          dedupeKey: `offers.price_far_below_authorized:${s.subject_id}`,
          title: 'Offer priced far below other offers',
          subjects: offerSubjects(s),
          evidence: `Offer price ${(price / 100).toFixed(2)} is ${Math.round((price / ref) * 100)}% of the reference price ${(ref / 100).toFixed(2)} (rule: below ${pct}%)`,
          signalIds: [s.id],
        });
      }
      break;
    }
    case 'offers.restricted_brand': {
      const brands = Array.isArray(t.brandIds) ? (t.brandIds as unknown[]).map(String) : [];
      const allowed = Array.isArray(t.allowedSellerIds) ? (t.allowedSellerIds as unknown[]).map(String) : [];
      if (!brands.length) break;
      for (const s of signals) {
        const brand = str(s.features.brandId);
        const seller = str(s.features.sellerId);
        if (!brand || !brands.includes(brand) || !seller || allowed.includes(seller)) continue;
        hits.push({
          dedupeKey: `offers.restricted_brand:${s.subject_id}`,
          title: 'Offer of a restricted brand by an unauthorised seller',
          subjects: offerSubjects(s),
          evidence: `Brand ${str(s.features.brandName) ?? brand} needs brand authorisation; the seller is not on the allowed list`,
          signalIds: [s.id],
        });
      }
      break;
    }
    case 'sellers.application_duplicates': {
      // 'bankToken' (rules seeded before pass 3) reads bankTokenHash
      const fields = [...new Set((Array.isArray(t.fields) ? (t.fields as unknown[]).map(String) : ['taxIdHash', 'bankTokenHash', 'addressKey']).map((f) => (f === 'bankToken' ? 'bankTokenHash' : f)))];
      for (const field of fields) {
        for (const [value, list] of groupBy(signals, (s) => str(s.features[field]))) {
          const sellers = uniq(list.map((s) => str(s.features.sellerId)).filter((x): x is string => !!x));
          if (sellers.length < 2) continue;
          hits.push({
            dedupeKey: `sellers.application_duplicates:${field}:${value}`,
            title: `Seller applications share a ${field === 'taxIdHash' ? 'tax id' : field === 'bankTokenHash' ? 'bank account' : 'business address'}`,
            subjects: [
              ...list.flatMap((s) => (str(s.features.applicationId) ? [{ type: 'application' as const, id: s.features.applicationId as string, label: 'Seller application' }] : [])),
              ...sellers.map((id) => ({ type: 'seller' as const, id, label: 'Seller' })),
            ],
            evidence: `${sellers.length} seller accounts share the same ${field}`,
            signalIds: list.map((s) => s.id),
          });
        }
      }
      break;
    }
    default:
      break;
  }
  return hits;
}

function offerSubjects(s: SignalRec): HitSubject[] {
  return [
    { type: 'offer', id: s.subject_id, label: 'New offer' },
    ...(str(s.features.productId) ? [{ type: 'product' as const, id: s.features.productId as string, label: str(s.features.productTitle) ?? 'Product' }] : []),
    ...(str(s.features.sellerId) ? [{ type: 'seller' as const, id: s.features.sellerId as string, label: str(s.features.sellerName) ?? 'Seller' }] : []),
  ];
}
