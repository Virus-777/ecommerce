/**
 * The products index: one document per purchasable product with its live offers as nested documents (seller,
 * condition, price and delivery filters pick the matching offer), category attributes as nested key/value pairs,
 * and every read-model field in _source (cards are built from hits without a database round trip).
 *
 * Bump MAPPING_VERSION on any change below: the live index reports the version it was built with, and a full
 * reindex (search.full-reindex, nightly) builds a new index with the current mapping and swaps the alias.
 */
export const MAPPING_VERSION = 1;

/** Searchable text fields and their weights (title and brand A, category B, attributes C, description D) */
export const TEXT_FIELDS = ['title^10', 'brand_name^10', 'category_text^4', 'attributes_text^2', 'description^1'] as const;

const keyword = { type: 'keyword' } as const;
const kw = { type: 'keyword', normalizer: 'lc' } as const;
const textEn = { type: 'text', analyzer: 'text_en' } as const;
const stored = { type: 'object', enabled: false } as const;

export const productMappings = {
  dynamic: 'strict',
  _meta: { mappingVersion: MAPPING_VERSION },
  properties: {
    product_id: keyword,
    version: { type: 'long' },
    indexed_at: { type: 'date' },
    slug: { type: 'keyword', index: false },
    title: { ...textEn, fields: { kw } },
    /** brand + title, normalized (search/domain/text.ts titleNorm): words for spelling correction and typing suggestions */
    title_norm: { type: 'text', analyzer: 'words', fields: { kw } },
    brand_id: keyword,
    /** kw: case-insensitive matching and sorting; raw: the name as written (brand facet labels) */
    brand_name: { ...textEn, fields: { kw, raw: keyword } },
    category_id: keyword,
    category_path_ids: keyword,
    category_text: textEn,
    attributes_text: textEn,
    description: textEn,
    /** filterable attributes: k = attribute key, v = value as written, vl = lower case (filters compare case-insensitively) */
    attrs: { type: 'nested', properties: { k: keyword, v: keyword, vl: keyword } },
    attributes: stored,
    variant_count: { type: 'integer', index: false },
    variant_options: stored,
    image: stored,
    seller_ids: keyword,
    has_official: { type: 'boolean' },
    conditions: keyword,
    offer_count: { type: 'integer' },
    featured_offer_id: keyword,
    featured_price: { type: 'long' },
    featured_seller_name: { type: 'keyword', index: false },
    featured_official: { type: 'boolean' },
    min_price: { type: 'long' },
    max_price: { type: 'long' },
    currency: { type: 'keyword', index: false },
    was_price: { type: 'long', index: false },
    deal_ends_at: { type: 'date', index: false },
    on_sale: { type: 'boolean' },
    gtins: keyword,
    variant_gtins: stored,
    badges: stored,
    in_stock: { type: 'boolean' },
    low_stock: { type: 'boolean', index: false },
    free_delivery: { type: 'boolean' },
    fastest_dispatch_days: { type: 'integer' },
    /** HH:mm:ss market time, compared as text */
    same_day_cutoff: keyword,
    rating: { type: 'scaled_float', scaling_factor: 10 },
    rating_count: { type: 'integer' },
    sales_30d: { type: 'integer' },
    popularity: { type: 'double' },
    first_listed_at: { type: 'date' },
    best_seller_rank: { type: 'integer' },
    best_seller_category_id: { type: 'keyword', index: false },
    offers: {
      type: 'nested',
      properties: {
        offer_id: keyword,
        variant_id: keyword,
        seller_id: keyword,
        /** seller id, or 'official' for the Official Store (distinct sellers) */
        seller_key: keyword,
        official: { type: 'boolean' },
        condition: keyword,
        price: { type: 'long' },
        in_stock: { type: 'boolean' },
        free_delivery: { type: 'boolean' },
        dispatch_days: { type: 'integer' },
        featured: { type: 'boolean' },
        featured_eligible: { type: 'boolean' },
        /** position in the product's card order: featured, in stock, cheapest, offer id */
        card_rank: { type: 'integer' },
      },
    },
  },
} as const;

export function productIndexBody(o: { shards: number; replicas: number }) {
  return {
    settings: {
      index: { number_of_shards: o.shards, number_of_replicas: o.replicas, max_result_window: 10_000 },
      analysis: {
        filter: {
          en_possessive: { type: 'stemmer', language: 'possessive_english' },
          en_stop: { type: 'stop', stopwords: '_english_' },
          en_stem: { type: 'stemmer', language: 'english' },
        },
        analyzer: {
          /** like PostgreSQL's english configuration: lower case, accents folded, stop words out, Porter stems */
          text_en: { type: 'custom', tokenizer: 'standard', filter: ['en_possessive', 'lowercase', 'asciifolding', 'en_stop', 'en_stem'] },
          /** whole words, for spelling correction and suggestions while typing */
          words: { type: 'custom', tokenizer: 'whitespace', filter: ['lowercase', 'asciifolding'] },
        },
        normalizer: { lc: { type: 'custom', filter: ['lowercase', 'asciifolding'] } },
      },
    },
    mappings: productMappings,
  };
}
