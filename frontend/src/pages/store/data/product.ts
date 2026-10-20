// API access for the product detail page and its sub-pages (offers, reviews, questions):
// catalog product, purchase box, rating summary, category trail, add to cart, Buy now.
// Product routes carry the id (/p/:slug/:id); the slug is cosmetic (BACKEND-REQUESTS G1).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { useSession } from '@/app/session';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { announce } from '@marketly/web-shared/ui';

export type CatalogProduct = components['schemas']['catalog.Product'];
export type Category = components['schemas']['catalog.Category'];
export type PurchaseBox = components['schemas']['offers.PurchaseBox'];
export type OfferView = components['schemas']['offers.OfferView'];
export type SellerCue = components['schemas']['offers.SellerCue'];
export type RatingSummary = components['schemas']['reviews.RatingSummary'];
export type SimilarProduct = components['schemas']['search.ProductCard'];
export type MediaRef = components['schemas']['MediaRef'];
export type CartSource = 'product_page' | 'offers_list';

/** Seller id of first-party offers (docs/api/README.md, Constants). */
export { OFFICIAL_STORE_ID } from '@marketly/web-shared/config';

/** Route params of the product pages: /p/:slug/:id(/offers|/reviews|/questions). */
export function useProductParams() {
  const { slug = '', id = '' } = useParams();
  return { slug, id };
}

export const productHref = (slug: string, id: string, view?: string, query?: Record<string, string>) => href('store/product', view, { slug, id }, query);

/** Sign-in link that comes back to `next` (the current page by default). */
export function useSignInHref() {
  const loc = useLocation();
  return useCallback((next?: string) => href('auth/sign-in', '', undefined, { next: next ?? loc.pathname + loc.search }), [loc.pathname, loc.search]);
}

/** Store page of an offer's seller: the Official Store page, or the seller's storefront. */
export const sellerHref = (s: Pick<SellerCue, 'official' | 'storeSlug'>) =>
  s.official || !s.storeSlug ? href('store/official') : href('store/seller', '', { slug: s.storeSlug });

/* ---------------- Reads ---------------- */

export function useCatalogProduct(id: string) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['catalog', 'product', id],
    queryFn: () => call(api.GET('/api/store/catalog/products/{id}', { params: { path: { id } } })),
    enabled: !!id,
  });
}

/** The buy box for a variant (default: the server's choice) and an offer the shopper picked (default: featured). */
export function usePurchaseBox(id: string, variantId?: string, offerId?: string) {
  const { api } = useApi();
  // Delivery estimates follow the cart's destination (a saved address or a ZIP chosen with "Change"); the buy box
  // doesn't read the cart itself, so its ZIP is passed along (same query as the header's "Deliver to").
  const destination = useQuery({
    queryKey: ['cart', 'destination'],
    queryFn: () => call(api.GET('/api/store/cart/cart')),
    select: (c) => c.destination,
    staleTime: 60_000,
  });
  const postalCode = destination.data?.postalCode ?? undefined;
  return useQuery({
    queryKey: ['offers', 'purchase-box', id, variantId ?? null, offerId ?? null, postalCode ?? null],
    queryFn: () => call(api.GET('/api/store/offers/products/{productId}/purchase-box', { params: { path: { productId: id }, query: { variantId, offerId, postalCode } } })),
    enabled: !!id,
    placeholderData: (prev) => (prev && prev.product.id === id ? prev : undefined),
  });
}

export function useRatingSummary(id: string) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['reviews', 'rating-summary', id],
    queryFn: () => call(api.GET('/api/store/reviews/products/{productId}/rating-summary', { params: { path: { productId: id } } })),
    enabled: !!id,
  });
}

/** Similar in-stock products (the Related products row). */
export function useSimilarProducts(id: string, limit = 5) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['search', 'similar', id, limit],
    queryFn: () => call(api.GET('/api/store/search/products/{productId}/similar', { params: { path: { productId: id }, query: { limit } } })),
    enabled: !!id,
  });
}

export function useCategories() {
  const { api } = useApi();
  return useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: () => call(api.GET('/api/store/catalog/categories')),
    staleTime: 5 * 60_000,
  });
}

/** Root-to-leaf categories of a category id (for breadcrumbs). Empty while the tree loads. */
export function categoryTrail(tree: Category[] | undefined, categoryId: string | null | undefined): Category[] {
  if (!tree || !categoryId) return [];
  const walk = (nodes: Category[], trail: Category[]): Category[] | null => {
    for (const n of nodes) {
      const t = [...trail, n];
      if (n.id === categoryId) return t;
      const hit = walk(n.children ?? [], t);
      if (hit) return hit;
    }
    return null;
  };
  return walk(tree, []) ?? [];
}

/** Home › top category › leaf category (› product) as Breadcrumbs items. Falls back to the product's category names. */
export function productCrumbs(product: Pick<CatalogProduct, 'categoryId' | 'categoryPath'> | undefined, tree: Category[] | undefined) {
  const trail = categoryTrail(tree, product?.categoryId);
  const items: Array<{ label: string; to?: string }> = [{ label: 'Home', to: href('store/home') }];
  if (trail.length) {
    trail.forEach((c, i) => items.push({ label: c.name, to: i === 0 && trail.length > 1 ? href('store/categories') : href('store/category', '', { slug: c.slug }) }));
  } else {
    (product?.categoryPath ?? []).forEach((name) => items.push({ label: name }));
  }
  return items;
}

/* ---------------- Variants and offers ---------------- */

/** "Color: Midnight black" → the option values, e.g. "Midnight black". */
export const variantName = (v: { options?: Record<string, string> } | undefined) => Object.values(v?.options ?? {}).join(' · ');
/** The option names, e.g. "Color". */
export const variantAxis = (v: { options?: Record<string, string> } | undefined) => Object.keys(v?.options ?? {}).join(' / ');

/** Photos of a variant, or the product's photos when the variant has none. */
export const variantImages = (p: CatalogProduct | undefined, variantId: string | undefined): MediaRef[] => {
  const v = p?.variants.find((x) => x.id === variantId);
  return v?.images?.length ? v.images : (p?.images ?? []);
};

export const STOCK_TONE: Record<OfferView['availability']['state'], 'success' | 'warning' | 'danger'> = {
  in_stock: 'success',
  low_stock: 'warning',
  out_of_stock: 'danger',
};
export const STOCK_LABEL: Record<OfferView['availability']['state'], string> = {
  in_stock: 'In stock',
  low_stock: 'Low stock',
  out_of_stock: 'Out of stock',
};

/** Who ships the order: the seller, or Marketly for Official Store and Marketly-fulfilled offers. */
export const shipperName = (o: OfferView) => (o.fulfilledBy === 'seller' && !o.seller.official ? o.seller.name : 'Marketly');

/** "Order within 7 h 27 min for this date". */
export const orderWithin = (minutes?: number | null) => {
  if (!minutes || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `Order within ${h ? `${h} h ` : ''}${m} min for this date`;
};

/* ---------------- Dates ---------------- */

const TZ = 'America/Los_Angeles';
/** "Oct 2, 2026" in the market time zone. */
export const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: TZ }) : '');
/** "Oct 19, 11:59 PM PT". */
export const fmtDateTime = (iso?: string | null) =>
  iso ? `${new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ })} PT` : '';

/* ---------------- Writes ---------------- */

/** POST /cart/cart/items with the chosen offer; refreshes the header badge. */
export function useAddToCart() {
  const { api } = useApi();
  const { refreshCart } = useSession();
  return useMutation({
    mutationFn: (v: { offerId: string; quantity: number; source: CartSource }) => call(api.POST('/api/store/cart/cart/items', { body: v })),
    onSuccess: () => refreshCart(),
  });
}

/**
 * Add-to-cart button state: which offer was just added ("Added to cart" for a moment), which one is
 * being added, and the error of the last attempt (shown next to that offer's button).
 */
export function useCartButton(source: CartSource) {
  const add = useAddToCart();
  const [added, setAdded] = useState<string | null>(null);
  const [error, setError] = useState<{ offerId: string; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const run = (offerId: string, quantity: number, what: string) => {
    setError(null);
    add.mutate(
      { offerId, quantity, source },
      {
        onSuccess: (r) => {
          setAdded(offerId);
          announce(r.message || `Added ${what} to your cart`);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setAdded(null), 2500);
        },
        onError: (e) => {
          const text = errorMessage(e);
          setError({ offerId, text });
          announce(text);
        },
      },
    );
  };
  return { run, added, error, pending: add.isPending ? (add.variables?.offerId ?? null) : null };
}

/** Buy now: a checkout session from one offer (the cart is not changed), then the checkout page. */
export function useBuyNow() {
  const { api } = useApi();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (v: { offerId: string; quantity: number }) => call(api.POST('/api/store/checkout/sessions', { body: { source: 'buy_now', offerId: v.offerId, quantity: v.quantity } })),
    onSuccess: (checkout) => navigate(href('store/checkout', '', undefined, { session: checkout.id })),
  });
}

/** Records a product view for the recently viewed row (customers and guest sessions). Best effort. */
export function useRecordView() {
  const { api } = useApi();
  return useMutation({
    mutationFn: (v: { productId: string; variantId?: string }) => call(api.POST('/api/store/customers/recently-viewed', { body: v })),
  });
}
