/**
 * The reads of this module that are not the same question in both databases (docs/10 §10.5e).
 *
 * Everything else lives in repository.ts, written once against `ctx.store`. Three kinds of read are here, and
 * each is here for a reason the neutral vocabulary cannot be given without becoming a query language:
 *
 *   - **a join to `catalog.listing_stats`** — "has this product a live offer" is a condition on another table
 *     while the rows being grouped are products. MongoDB asks with `$lookup`, MySQL with `EXISTS`;
 *     `pausedSubmissionCounts` is the same shape the other way round (submissions grouped by their product's
 *     owner), which is a `GROUP BY` with a join and so not `countBy`;
 *   - **the missing-content condition** — "a content score under 100, **or images still to re-crop**". The
 *     second half asks whether a JSON array is non-empty, which is `recrop_media_ids.0: { $exists: true }` on
 *     MongoDB and `JSON_LENGTH(recrop_media_ids) > 0` on MySQL (Appendix B); `Where` has no shape for it, so
 *     the three reads that take it (the page, the keyset walk and the count) are named here and take the rest
 *     of their filter in the neutral vocabulary, exactly as media's `pageByUsage` does;
 *   - **the model-number match** — a model number compares with everything but letters and digits ignored, so
 *     `ov-500`, `OV 500` and `ov500` are one product. That is a regular expression on both stores and a
 *     literal `contains` on neither.
 *
 * Named queries rather than a combinator: `duplicateCandidates` mixes the model-number pattern with a GTIN
 * list and a title match *inside an OR*, and `brandByName` compares a column with its spaces trimmed. A
 * vocabulary able to say those is a query language (docs/10 §10.5e, from media).
 *
 * Every read here is outside a transaction, so none of them takes one.
 */
import type { BrandRow, ProductRow } from './ports.js';

/**
 * Whether the products wanted are the ones the Admin catalog's missing-content tab shows (a content score
 * under 100, or images to re-crop), the ones it does not, or — `undefined` — both.
 */
export type ContentState = boolean | undefined;

/** One product's brand, category, live state and offer counts, for the counts job */
export interface LiveCountRow {
  id: string;
  brand_id: string | null;
  category_id: string | null;
  live: boolean;
  live_offers: number;
  offers: number;
}

/**
 * The model number with everything but letters and digits removed, compared with `normalised` (already
 * lower-case alphanumerics): the characters in order with anything else around them. `whole`: equal;
 * otherwise a prefix.
 *
 * It is one function and not two because both stores run **the same pattern text** — MongoDB as `$regex`
 * with the `i` option, MySQL as `REGEXP` against `LOWER(model_number)`. Two copies would be right until one
 * of them was edited.
 */
export function modelPattern(normalised: string, whole: boolean): string {
  const gap = '[^a-z0-9]*';
  return `^${gap}${[...normalised].join(gap)}${whole ? `${gap}$` : ''}`;
}

export interface CatalogQueries {

  /** The next `limit` products after `afterId` in primary-key order (index rebuilds and exports) */

  /** Live products with at least one live offer, counted by brand, within the given categories */
  liveBrandCountsIn(categoryIds: readonly string[]): Promise<Map<string, number>>;

  /** Every product that is not a merged duplicate, with its listing stats (the refresh-counts job) */
  liveCountsSource(): Promise<LiveCountRow[]>;

  /** Open paused submissions of each seller's products, counted per seller */
  pausedSubmissionCounts(sellerIds: readonly string[]): Promise<Map<string, number>>;

  /** Live products whose model number starts with one of these normalised prefixes (ignoring punctuation) */
  productsByModelPrefixes(prefixes: readonly string[], limit: number): Promise<ProductRow[]>;

  /**
   * Candidates for the duplicate check: products other than this one, not merged, approved or still in review,
   * whose model number is the same ignoring punctuation, or that own one of these GTINs, or whose title holds
   * every one of these words. At most 20.
   */
  duplicateCandidates(input: { productId: string; modelNormalised: string | null; gtinOwnerIds: readonly string[]; titleWords: readonly string[] }): Promise<ProductRow[]>;

  /** The oldest brand with this name, any case, ignoring leading and trailing spaces on either side */
  brandByName(name: string): Promise<BrandRow | undefined>;
}
