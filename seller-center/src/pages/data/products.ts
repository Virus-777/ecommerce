// Seller "Products and offers" rows (design: pages/seller/seller-products.html), mapped from the API:
// GET /api/seller/offers/offers (SellerOfferRow) and, for own products that have no offer yet,
// GET /api/seller/catalog/products (ProductAdmin). Also the GraphQL text of the product card query
// used by the offer and submission forms.
import type { components } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import type { IconName } from '@marketly/web-shared/ui';
import { conditionLabel, iconFor, optionsLabel, reviewLabel, type Money, type Review, type StockState } from './catalog-parts';

export type SellerOfferRow = components['schemas']['offers.SellerOfferRow'];
export type ProductAdmin = components['schemas']['catalog.ProductAdmin'];
export type { Review };
export type Publication = 'Active' | 'Hidden' | 'Suspended' | 'Removed' | 'Not published';

export interface ProductRow {
  /** Offer id, or the product id for a product without an offer. */
  key: string;
  offerId?: string;
  /** Stock item the offer sells from (bulk stock updates). */
  stockItemId?: string;
  productId: string;
  offerStatus?: string;
  sku: string;
  name: string;
  variant: string;
  image?: string;
  icon: IconName;
  tint: string;
  price: Money | null;
  stock: number | null;
  stockState?: StockState;
  condition: string;
  review: Review;
  publication: Publication;
  /** Grey note under the name (hidden by you, submitted, missing content). */
  note?: string;
  /** Reviewer / restriction message (.sa-reason). danger = red. */
  reason?: { text: string; danger?: boolean };
  /** Where the product name links. */
  link: string;
  missing?: Array<'images' | 'identifiers'>;
  action: { label: string; kind: 'link' | 'show' | 'button'; variant: 'ghost' | 'primary' | 'secondary'; to?: string; help?: boolean };
  /** Product action for one of the seller's own products that was never listed: withdraw the open submission, or delete the draft. */
  manage?: 'withdraw' | 'delete';
}

/** Offer form for an existing offer / a new offer on a product variant. */
export const offerHref = (offerId: string) => href('seller/offer', '', undefined, { offer: offerId });
export const newOfferHref = (productId: string, variantId?: string, view = '') => href('seller/offer', view, undefined, variantId ? { product: productId, variant: variantId } : { product: productId });
/** Submission form for one of the seller's own products. */
export const productHref = (productId: string, changesRequested = false) => href('seller/product-new', changesRequested ? 'changes-requested' : '', undefined, { id: productId });

const gapsNote = (gaps: string[]) => (gaps.length ? `Missing ${gaps.join(' and ')}` : undefined);

function publicationOf(r: SellerOfferRow): Publication {
  const s = r.offer.status;
  if (s === 'removed') return 'Removed';
  if (r.productPublication === 'suspended') return 'Suspended';
  if (r.productPublication === 'hidden') return 'Hidden';
  if (s === 'paused') return 'Hidden';
  if (s === 'ineligible') return 'Suspended';
  if (s === 'draft' || r.productReviewState !== 'approved') return 'Not published';
  return 'Active';
}

export function rowFromOffer(r: SellerOfferRow): ProductRow {
  const o = r.offer;
  const review = reviewLabel(r.productReviewState);
  const publication = publicationOf(r);
  const own = review !== 'Approved';
  const row: ProductRow = {
    key: o.id,
    offerId: o.id,
    stockItemId: o.stockItemId,
    productId: o.productId,
    offerStatus: o.status,
    sku: o.sellerSku,
    name: o.productTitle,
    variant: o.variantLabel,
    image: o.image?.url ?? undefined,
    icon: iconFor(o.productTitle),
    tint: '2',
    price: o.price,
    stock: r.stock.available,
    stockState: r.stock.state,
    condition: conditionLabel(o.condition),
    review,
    publication,
    missing: r.contentGaps.length ? r.contentGaps : undefined,
    link: own ? productHref(o.productId, review === 'Changes requested') : offerHref(o.id),
    action: { label: 'Edit offer', kind: 'link', variant: 'ghost', to: offerHref(o.id) },
  };
  const gaps = gapsNote(r.contentGaps);
  if (review === 'Changes requested') {
    row.reason = r.reviewNote ? { text: `Catalog team: ${r.reviewNote}` } : undefined;
    row.action = { label: 'Fix and resubmit', kind: 'link', variant: 'primary', to: productHref(o.productId, true) };
    row.manage = 'delete';
  } else if (review === 'Submitted') {
    row.note = 'Submitted for review · your offer goes live when the product is approved';
    row.action = { label: 'View submission', kind: 'link', variant: 'ghost', to: productHref(o.productId) };
    row.manage = 'withdraw';
  } else if (review === 'Draft') {
    row.note = gaps ?? 'Product draft · not submitted yet';
    row.action = { label: 'Continue draft', kind: 'link', variant: 'secondary', to: productHref(o.productId) };
    row.manage = 'delete';
  } else if (review === 'Rejected') {
    row.reason = { text: r.reviewNote || 'The Catalog team rejected this product.', danger: true };
    row.action = { label: 'See options', kind: 'button', variant: 'ghost' };
  } else if (publication === 'Hidden' && o.status === 'paused') {
    row.note = 'Hidden by you';
    row.action = { label: 'Show offer', kind: 'show', variant: 'ghost' };
  } else if (publication === 'Suspended' || publication === 'Hidden' || publication === 'Removed') {
    const sr = o.statusReason;
    const text = [sr?.text, sr?.affectedActivity && `Affects: ${sr.affectedActivity}.`, sr?.appealRoute].filter(Boolean).join(' ');
    row.reason = { text: text || (r.productPublication === 'hidden' ? 'The product is hidden in the catalog.' : 'This offer is not shown to customers.'), danger: true };
    if (publication !== 'Removed') row.action = { label: 'Send documents', kind: 'button', variant: 'secondary', help: true };
  } else if (o.status === 'draft') {
    row.note = 'Draft offer · customers don’t see it yet';
  } else if (gaps) {
    row.note = gaps;
  }
  return row;
}

/** One of the seller's own products that has no offer yet (e.g. a draft saved before any variation had a price). */
export function rowFromProduct(p: ProductAdmin): ProductRow {
  const review = reviewLabel(p.reviewState);
  const pr = p.product;
  const cr = review === 'Changes requested';
  const lastLog = [...p.reviewLog].reverse().find((l) => l.action === 'changes_requested' || l.action === 'rejected');
  return {
    key: pr.id,
    productId: pr.id,
    sku: '',
    name: pr.title,
    variant: pr.variants.length > 1 ? `${pr.variants.length} variations · ${pr.variants.map((v) => optionsLabel(v.options)).join(', ')}` : optionsLabel(pr.variants[0]?.options),
    image: pr.images[0]?.url ?? undefined,
    icon: iconFor(pr.title, ...(pr.categoryPath ?? [])),
    tint: '3',
    price: null,
    stock: null,
    condition: 'New',
    review,
    publication: 'Not published',
    note: review === 'Draft' ? (p.missing.length ? `Missing ${p.missing.slice(0, 2).join(' and ').toLowerCase()}` : 'Product draft · no offer yet') : review === 'Approved' ? 'No offer yet' : undefined,
    reason: cr && lastLog?.reason ? { text: `Catalog team, ${new Date(lastLog.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: ${lastLog.reason}` } : review === 'Rejected' && lastLog?.reason ? { text: lastLog.reason, danger: true } : undefined,
    link: review === 'Approved' ? newOfferHref(pr.id) : productHref(pr.id, cr),
    action:
      review === 'Approved'
        ? { label: 'Create offer', kind: 'link', variant: 'secondary', to: newOfferHref(pr.id) }
        : cr
          ? { label: 'Fix and resubmit', kind: 'link', variant: 'primary', to: productHref(pr.id, true) }
          : review === 'Submitted'
            ? { label: 'View submission', kind: 'link', variant: 'ghost', to: productHref(pr.id) }
            : review === 'Rejected'
              ? { label: 'See options', kind: 'button', variant: 'ghost' }
              : { label: 'Continue draft', kind: 'link', variant: 'secondary', to: productHref(pr.id) },
    manage: review === 'Submitted' ? 'withdraw' : review === 'Draft' || cr ? 'delete' : undefined,
  };
}

/* ---------------- GraphQL: product card + own offers (seller/offer, seller/product-new) ---------------- */

/**
 * The product card fields these screens use (slug, variant list prices and images are not in the persisted
 * SellerProductDetail operation). Development sends the query text.
 */
export const SELLER_PRODUCT = /* GraphQL */ `
  query SellerProductCard($id: UUID!) {
    myProduct(id: $id) {
      id
      ref
      title
      slug
      brand { id name }
      category { id name attributes { id name kind unit options required variantDefining } }
      categoryPath
      modelNumber
      manufacturerPartNumber
      noGtin
      requestedBrandName
      description
      keyFeatures
      specs { name value }
      includedItems
      images { id url alt }
      variants { id gtin options { name value } listPrice { amount currency } images { id url } }
      updatedAt
      submittedByMe
      submission { id ref kind state submittedAt submittedBy { kind name } lastSavedAt lastSavedBy { kind name } expectedReviewBy note }
      reviewState
      publication
      missing
      reviewLog { action reason at fields { name value } actor { kind name } }
      offerCount
      myOffers {
        id
        status
        variant { id }
        condition
        sellerSku
        price { amount currency }
        stock { id quantities { available } }
      }
    }
  }
`;

export interface GqlMoney {
  amount: number;
  currency: string;
}
export interface SellerProduct {
  id: string;
  ref: string;
  title: string;
  slug: string;
  brand: { id: string; name: string } | null;
  category: { id: string; name: string; attributes: CategoryAttribute[] } | null;
  categoryPath: string[];
  modelNumber: string | null;
  manufacturerPartNumber: string | null;
  noGtin: boolean | null;
  requestedBrandName: string | null;
  description: string;
  keyFeatures: string[];
  specs: Array<{ name: string; value: string }>;
  includedItems: string[];
  images: Array<{ id: string; url: string; alt: string | null }>;
  variants: Array<{ id: string; gtin: string | null; options: Array<{ name: string; value: string }>; listPrice: GqlMoney | null; images: Array<{ id: string; url: string }> }>;
  updatedAt: string;
  submittedByMe: boolean | null;
  submission: {
    id: string;
    ref: string;
    kind: string;
    state: string;
    submittedAt: string;
    submittedBy: { kind: string; name: string | null };
    lastSavedAt: string | null;
    lastSavedBy: { kind: string; name: string | null } | null;
    expectedReviewBy: string | null;
    note: string | null;
  } | null;
  reviewState: 'DRAFT' | 'SUBMITTED' | 'CHANGES_REQUESTED' | 'APPROVED' | 'REJECTED' | null;
  publication: 'ACTIVE' | 'HIDDEN' | 'SUSPENDED' | null;
  missing: string[] | null;
  reviewLog: Array<{ action: string; reason: string | null; at: string; fields: Array<{ name: string; value: string }>; actor: { kind: string; name: string | null } }> | null;
  offerCount: number;
  myOffers: Array<{ id: string; status: string; variant: { id: string }; condition: string; sellerSku: string | null; price: GqlMoney; stock: { id: string; quantities: { available: number } } | null }>;
}
export interface CategoryAttribute {
  id: string;
  name: string;
  kind: 'TEXT' | 'NUMBER' | 'ENUM' | 'BOOL';
  unit: string | null;
  options: string[];
  required: boolean;
  variantDefining: boolean;
}

/* ---------------- GraphQL: category tree (filters, submission category picker) ---------------- */

export const CATEGORIES = /* GraphQL */ `
  query SellerCategories {
    categories { id name children { id name children { id name } } }
  }
`;
export interface CategoryNode {
  id: string;
  name: string;
  children?: CategoryNode[];
}
/** Every category below the top level, with its path (Electronics › Headphones). Duplicate names get the parent in brackets. */
export function flattenCategories(tree: CategoryNode[]): Array<{ id: string; name: string; label: string; path: string[] }> {
  const out: Array<{ id: string; name: string; label: string; path: string[] }> = [];
  const walk = (nodes: CategoryNode[], path: string[]) =>
    nodes.forEach((n) => {
      const p = [...path, n.name];
      if (path.length) out.push({ id: n.id, name: n.name, label: n.name, path: p });
      if (n.children?.length) walk(n.children, p);
    });
  walk(tree, []);
  const seen = new Map<string, number>();
  out.forEach((c) => seen.set(c.name, (seen.get(c.name) ?? 0) + 1));
  out.forEach((c) => {
    if ((seen.get(c.name) ?? 0) > 1) c.label = `${c.name} (${c.path[c.path.length - 2]})`;
  });
  return out;
}
