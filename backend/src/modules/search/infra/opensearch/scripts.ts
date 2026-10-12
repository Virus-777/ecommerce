/**
 * Painless scripts the OpenSearch engine sends, each with its JavaScript twin. The twins compute the same
 * numbers: the engine uses them to split a hit's score into ranking factors (explain), and the in-memory test
 * fake (test/opensearch-fake) runs them in place of Painless — so a script and its twin must change together.
 */

/** Doc values as a script sees them: a list per field (empty when missing) */
export type DocValues = (field: string) => (number | string | boolean)[];

export interface ScriptTwin {
  /** search scripts: doc values and the score of the wrapped query */
  score?(params: Record<string, any>, doc: DocValues, score: number): number;
  /** update scripts: ctx._source and ctx.op */
  update?(params: Record<string, any>, ctx: { _source: Record<string, any>; op: string }): void;
}

/**
 * The card offer ("eo") of a product under the current offer filters is the matching offer with the lowest
 * card_rank (featured first, then in stock, then cheapest, then offer id: the order the MongoDB engine uses).
 * Scored inside the nested offers query with score_mode max, this key's maximum is the card offer's key, and the
 * key carries what the ranking needs from that offer (in stock, dispatch days). Small integers: exact as floats.
 */
export const EO_MAX_RANK = 10_000;
export const EO_KEY = [
  "int r = (int) doc['offers.card_rank'].value; if (r > params.maxRank) { r = params.maxRank; }",
  "int d = (int) doc['offers.dispatch_days'].value; if (d > 63) { d = 63; } if (d < 0) { d = 0; }",
  "return (params.maxRank - r) * 128 + (doc['offers.in_stock'].value ? 64 : 0) + d;",
].join(' ');

/** Ranking factors that depend on the card offer, from its key: in_stock and delivery_speed */
export const EO_FACTORS = [
  'long k = Math.round(_score); long d = k % 64; double inStock = (k % 128) >= 64 ? 1 : 0;',
  'return params.w_in_stock * inStock + params.w_delivery * (1.0 / (1 + d));',
].join(' ');

/** Ranking factors of the document itself: featured_offer, rating (with enough reviews), conversion */
export const DOC_FACTORS = [
  'double s = 0;',
  "if (doc['featured_offer_id'].size() > 0) { s += params.w_featured; }",
  "if (doc['rating_count'].size() > 0 && doc['rating_count'].value >= params.minRatings && doc['rating'].size() > 0) { s += params.w_rating * doc['rating'].value / 5.0; }",
  "double p = doc['popularity'].size() > 0 ? Math.max(doc['popularity'].value, 0) : 0;",
  's += params.w_conversion * Math.min(1.0, Math.log(1 + p) / Math.log(101));',
  'return s;',
].join(' ');

/** Text relevance 0..1 (BM25 s → s / (s + 1), like ts_rank_cd normalization 32) times its weight */
export const TEXT_RELEVANCE = 'return params.w * _score / (_score + 1);';

/**
 * Ordered writes: a document replaces the indexed one only when its read-model version is not older. A full
 * write (params.full) replaces the whole source, texts included; a partial one keeps the texts.
 */
export const VERSIONED_WRITE = [
  'if (ctx._source.version != null && ctx._source.version > params.doc.version) { ctx.op = "none"; }',
  'else { if (params.full) { ctx._source.clear(); } ctx._source.putAll(params.doc); }',
].join(' ');

const first = (doc: DocValues, f: string) => doc(f)[0];

export const SCRIPT_TWINS: Record<string, ScriptTwin> = {
  [EO_KEY]: {
    score: (params, doc) => {
      const r = Math.min(Number(first(doc, 'offers.card_rank')), params.maxRank);
      const d = Math.max(0, Math.min(63, Number(first(doc, 'offers.dispatch_days'))));
      return (params.maxRank - r) * 128 + (first(doc, 'offers.in_stock') === true ? 64 : 0) + d;
    },
  },
  [EO_FACTORS]: {
    score: (params, _doc, score) => {
      const k = Math.round(score);
      return params.w_in_stock * (k % 128 >= 64 ? 1 : 0) + params.w_delivery * (1 / (1 + (k % 64)));
    },
  },
  [DOC_FACTORS]: {
    score: (params, doc) => docFactors(params as never, { featured: doc('featured_offer_id').length > 0, ratingCount: Number(first(doc, 'rating_count') ?? 0), rating: doc('rating').length ? Number(first(doc, 'rating')) : null, popularity: Number(first(doc, 'popularity') ?? 0) }).total,
  },
  [TEXT_RELEVANCE]: {
    score: (params, _doc, score) => (params.w * score) / (score + 1),
  },
  [VERSIONED_WRITE]: {
    update: (params, ctx) => {
      if (ctx._source.version != null && ctx._source.version > params.doc.version) {
        ctx.op = 'none';
        return;
      }
      if (params.full) for (const k of Object.keys(ctx._source)) delete ctx._source[k];
      Object.assign(ctx._source, structuredClone(params.doc));
    },
  },
};

/** DOC_FACTORS per factor (explain) */
export function docFactors(
  w: { w_featured: number; w_rating: number; w_conversion: number; minRatings: number },
  d: { featured: boolean; ratingCount: number; rating: number | null; popularity: number },
): { featured_offer: number; rating: number; conversion: number; total: number } {
  const featured_offer = d.featured ? w.w_featured : 0;
  const rating = d.ratingCount >= w.minRatings && d.rating !== null ? (w.w_rating * d.rating) / 5 : 0;
  const conversion = w.w_conversion * Math.min(1, Math.log(1 + Math.max(d.popularity, 0)) / Math.log(101));
  return { featured_offer, rating, conversion, total: featured_offer + rating + conversion };
}

/** EO_FACTORS per factor (explain) */
export function eoFactors(w: { w_in_stock: number; w_delivery: number }, eo: { inStock: boolean; dispatchDays: number }): { in_stock: number; delivery_speed: number } {
  const d = Math.max(0, Math.min(63, eo.dispatchDays));
  return { in_stock: eo.inStock ? w.w_in_stock : 0, delivery_speed: w.w_delivery * (1 / (1 + d)) };
}
