/**
 * Shared GraphQL mappers for the seller's public card, exported through contract.ts so other modules'
 * resolvers (wishlist: WishlistAlert.seller) build the same Seller and SellerPublicProfile shapes from
 * the sellers public API (getStorefrontCard, getSellers, getStorefrontBySlug) as the sellers resolvers do.
 * Pure functions on spec types: no service, no database.
 */
import { gqlEnum, lazy } from '../../../kernel/graphql/index.js';
import type { SellerSnapshot, SellerSummary, Storefront, VerificationLabel } from '../../../spec/sellers.js';

const NOT_CERTIFIED = 'Product authenticity is not certified';

/** What the public profile is built from: the storefront (null when the store is not public) and the store profile fields */
export interface PublicProfileSource {
  sellerId: string;
  storefront: Storefront | null;
  verification?: VerificationLabel | null;
  tagline?: string | null;
  introduction?: string | null;
  warranty?: string | null;
}

/** GraphQL SellerPublicProfile (enums in capitals); profile fields fall back to the storefront's */
export function sellerPublicProfileOut(src: PublicProfileSource) {
  const sf = src.storefront;
  const v = src.verification ?? sf?.verification ?? { state: 'not_verified', checked: [], notChecked: [NOT_CERTIFIED], lastCheckedAt: null, expiresAt: null, reason: null };
  return {
    sellerId: src.sellerId,
    banner: sf?.banner ?? null,
    tagline: src.tagline !== undefined ? src.tagline : (sf?.tagline ?? null),
    introduction: src.introduction !== undefined ? src.introduction : (sf?.introduction ?? null),
    verification: { ...v, state: gqlEnum(v.state) },
    onTimeDispatchPct: (sf?.highlights as { onTimeDispatchPct?: number | null } | undefined)?.onTimeDispatchPct ?? null,
    approvedClaims: ((sf?.approvedClaims ?? []) as { kind: string; text: string }[]).map((c) => ({ kind: gqlEnum(c.kind), text: c.text })),
    contact: (sf?.contact as { canMessage: boolean; productQuestions: boolean; replyTarget: string; phone?: string | null } | undefined) ?? { canMessage: true, productQuestions: true, replyTarget: 'within_24h', phone: null },
    warranty: src.warranty !== undefined ? src.warranty : (sf?.warranty ?? null),
    collections: sf?.collections ?? [],
  };
}

/**
 * GraphQL Seller with the public card fields (every schema), from the storefront card (getStorefrontCard) and the
 * snapshot (getSellers). publicProfile and sellingSince load the storefront (getStorefrontBySlug) only when asked.
 */
export function sellerCardOut(card: SellerSummary, snapshot: SellerSnapshot, loadStorefront: (slug: string) => Promise<Storefront | null>) {
  const sf = lazy(() => loadStorefront(card.slug));
  return {
    id: card.id,
    ref: snapshot.ref,
    slug: card.slug,
    storeName: card.storeName,
    logo: card.logo ?? null,
    location: card.location ?? null,
    verified: card.verified,
    dispatchLabel: card.dispatchLabel ?? null,
    sellingSince: async () => (await sf())?.sellingSince ?? null,
    sellingNow: snapshot.canSellNew,
    publicProfile: async () => sellerPublicProfileOut({ sellerId: card.id, storefront: await sf() }),
  };
}
