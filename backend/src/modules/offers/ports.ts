/**
 * Row types of the offers collections and the shapes the repository takes (repository.ts), and the bulk file
 * reader (media download) that providers/files.ts implements.
 */
import type * as identity from '../../spec/identity.js';
import type { OffersDb } from '../../spec/offers.js';

export type Db = OffersDb;
export type Table = keyof Db & string;
/** Tables keyed by `id` */
export type IdTable = 'offers' | 'offer_price_history' | 'price_changes' | 'offer_status_log' | 'bulk_update_jobs' | 'offer_costs';

export type OfferRec = Db['offers'];
export type PriceHistoryRec = Db['offer_price_history'];
export type PriceChangeRec = Db['price_changes'];
export type StatusLogRec = Db['offer_status_log'];
export type EligibilityRec = Db['offer_eligibility'];
export type FeaturedRec = Db['featured_offers'];
export type RuleRec = Db['featured_rules'];
export type BulkJobRec = Db['bulk_update_jobs'];
export type BulkRowRec = Db['bulk_update_rows'];
export type CostRec = Db['offer_costs'];

export interface OfferListFilter {
  ownerType?: 'official' | 'seller';
  sellerId?: string;
  productId?: string;
  productIds?: string[];
  variantIds?: string[];
  ids?: string[];
  statuses?: string[];
  excludeStatuses?: string[];
  conditions?: string[];
  /** offer title (substring, any case), seller SKU or offer id */
  q?: string;
  contentGap?: string;
  shippingProfileId?: string;
  featuredEligible?: boolean;
  ineligibilityCode?: string;
}

/** Reads an uploaded bulk file (media) as text */
export interface BulkFileReader {
  read(fileId: string, principal: identity.Principal): Promise<{ fileName: string; text: string; owner: { kind: string; id?: string | null } } | null>;
}
