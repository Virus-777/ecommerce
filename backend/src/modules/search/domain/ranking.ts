/**
 * Recommended sort (published ranking policy v1, spec notes): text relevance, then in-stock and
 * featured-offer eligibility, delivery speed, rating with enough reviews, and recent conversion.
 * Sponsored placement never changes organic rank.
 */
import type { RankingFactor } from '../../../spec/search.js';

export const RANKING_FACTOR_KEYS = ['text_relevance', 'in_stock', 'featured_offer', 'delivery_speed', 'rating', 'conversion'] as const;
export type RankingFactorKey = (typeof RANKING_FACTOR_KEYS)[number];

export const DEFAULT_FACTORS: RankingFactor[] = [
  { key: 'text_relevance', label: 'How well the product matches your words', weight: 0.4 },
  { key: 'in_stock', label: 'In stock now', weight: 0.2 },
  { key: 'featured_offer', label: 'Has an eligible featured offer', weight: 0.1 },
  { key: 'delivery_speed', label: 'How fast it can be delivered', weight: 0.1 },
  { key: 'rating', label: 'Customer rating, once there are enough reviews', weight: 0.1 },
  { key: 'conversion', label: 'How often shoppers buy it after viewing', weight: 0.1 },
];

export const DEFAULT_POLICY_TEXT =
  'Results are ranked by how well a product matches your search, whether it is in stock with an eligible featured offer, ' +
  'how fast it can be delivered to you, its customer rating (once it has enough reviews) and how often shoppers buy it. ' +
  'Sponsored items are paid placements, are always labeled and never change the order of other results.';

/** Ratings count toward rank only with at least this many reviews */
export const MIN_RATINGS_FOR_RANK = 3;

/** Weights by factor key (unknown keys in a published policy are ignored; missing keys weigh 0) */
export function weightsOf(factors: RankingFactor[]): Record<RankingFactorKey, number> {
  const w = Object.fromEntries(RANKING_FACTOR_KEYS.map((k) => [k, 0])) as Record<RankingFactorKey, number>;
  for (const f of factors) if ((RANKING_FACTOR_KEYS as readonly string[]).includes(f.key)) w[f.key as RankingFactorKey] = f.weight;
  return w;
}

export const RANKING_NOTE = 'Sponsored items are paid placements and are labeled. How results are ranked: /help/ranking-policy';
export const FROM_PRICE_NOTE = "'From' prices are the lowest price of one eligible offer, named on the card. Delivery may cost extra.";
export const STORE_NOTE = 'Stores are listed here, not mixed into product results.';
export const OFFICIAL_STORE_NAME = 'Official Store';
