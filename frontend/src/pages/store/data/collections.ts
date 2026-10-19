// A seller storefront's featured collections (seller-curated groups of their offers).
// The storefront response (GET /api/store/sellers/stores/{slug}) lists them (title, image, item count);
// one collection is GET /api/store/sellers/stores/{slug}/collections/{collectionId} (title, image and the
// offer ids, 404 when it is hidden). REST has no product cards for offer ids, so the collection's offers
// (price, deal, product title, slug and image) come from the SellerStorefront screen query, the only
// read that resolves them (SellerCollection.offers, active offers only, in the seller's order).
import { useQuery } from '@tanstack/react-query';
import { call, useApi } from '@marketly/web-shared/api';
import SELLER_STOREFRONT from '../../../../../web-shared/src/api/graphql/store/SellerStorefront.graphql?raw';

interface GqlMoney {
  amount: number;
  currency: string;
  formatted?: string | null;
}
interface GqlImage {
  id: string;
  url: string;
  alt?: string | null;
}
/** An offer in a featured collection, as SellerStorefront selects it. */
export interface CollectionOffer {
  id: string;
  price: GqlMoney;
  deal?: { percentOffBps?: number | null; price?: GqlMoney | null; wasPrice?: GqlMoney | null } | null;
  product: { id: string; slug?: string | null; title: string; images: GqlImage[]; reviewSummary?: { hasReviews: boolean; average?: number | null; ratingCount: number } | null };
}
interface StorefrontCollections {
  sellerStorefront: { publicProfile: { collections: Array<{ id: string; offers: CollectionOffer[] }> } } | null;
}

/** Most offers a collection page shows (sellers keep collections short). */
const MAX_OFFERS = 60;

export function useStorefrontCollection(slug: string, collectionId: string | null) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['sellers', 'store', slug, 'collection', collectionId],
    queryFn: () => call(api.GET('/api/store/sellers/stores/{slug}/collections/{collectionId}', { params: { path: { slug, collectionId: collectionId! } } })),
    enabled: !!collectionId,
  });
}

/**
 * The offers of one collection. The screen query also returns the store's first product and feedback
 * item (paging limit 1, the smallest it takes); its wishlist field (`saved`) may come back with an error
 * while wishlist is off, which only nulls that field, so partial data is used.
 */
export function useCollectionOffers(slug: string, collectionId: string | null) {
  const { gql } = useApi();
  return useQuery({
    queryKey: ['sellers', 'store', slug, 'collection-offers', collectionId],
    queryFn: async () => {
      const r = await gql<StorefrontCollections>(SELLER_STOREFRONT, { slug, collectionOfferLimit: MAX_OFFERS, paging: { limit: 1 }, feedbackPaging: { limit: 1 } }, 'SellerStorefront');
      return r.data?.sellerStorefront?.publicProfile.collections.find((c) => c.id === collectionId)?.offers ?? [];
    },
    enabled: !!collectionId,
  });
}
