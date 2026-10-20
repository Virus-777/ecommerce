/**
 * The card offer: the offer a product card shows (docs/07-search-speed-plan.md). One rule for the MongoDB engine,
 * which picks it among the offers that pass the query's offer filters, and for the copies stored on each search
 * document for the two usual cases (no offer filter; in stock only), which the repository refreshes whenever the
 * offers or the featured offer change.
 */

type Expr = Record<string, unknown>;

/** The card offer of a list of offers (an aggregation expression): featured first, then in stock, cheapest, offer id; with its featured flag */
export const cardOf = (offers: unknown): Expr => ({
  $first: {
    $sortArray: {
      input: { $map: { input: offers, as: 'o', in: { $mergeObjects: ['$$o', { featured: { $eq: ['$$o._id', '$featured_offer_id'] } }] } } },
      sortBy: { featured: -1, in_stock: -1, price: 1, _id: 1 },
    },
  },
});

const all = { $ifNull: ['$offers', []] };
const inStock = { $filter: { input: all, as: 'o', cond: { $eq: ['$$o.in_stock', true] } } };

/**
 * Stage that stores both card offers and their offer counts from the document's offers and featured offer, and marks
 * the stored ranks stale (they depend on the card offer). For update pipelines and $merge.
 */
export const STORE_CARDS: Expr = {
  $set: {
    card_all: { $ifNull: [cardOf(all), null] },
    card_all_n: { $size: all },
    card_in_stock: { $ifNull: [cardOf(inStock), null] },
    card_in_stock_n: { $size: inStock },
    rank_key: null,
  },
};

/** Derived fields the repository and the engine maintain; never taken from a document being written */
export const DERIVED_FIELDS = ['offers', 'card_all', 'card_all_n', 'card_in_stock', 'card_in_stock_n', 'rank_all', 'rank_in_stock', 'rank_key'] as const;
