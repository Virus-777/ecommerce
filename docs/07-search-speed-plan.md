# Plan: faster MongoDB search for tens of thousands of products

Status (2026-10-20): **steps 1–4 built** on branch `perf/search-speed` (see §8 for results and what differed from the
plan); step 5 not started. Scope: the MongoDB search engine (`backend/src/modules/search/mongo-engine.ts`), the
search copy it reads (`search_documents`, `search_offers`) and a few service steps in `service/queries.ts`.
No API changes: the store website and the Android app keep calling the same endpoints and get the same answers.

## 1. What is slow, measured

Generated catalog of 50,000 products with 2 offers each, the real search module on an in-memory MongoDB, one user.
Times are for one request.

| Request | 1,000 products | 20,000 | 50,000 |
|---|---|---|---|
| Specific search ("Brand7tek lamp") | 8 ms | 9 ms | 12 ms |
| Broad word ("wireless", 1 in 34 products) | 29 ms | 141 ms | 404 ms |
| Very common word ("battery") | 110 ms | 785 ms | 2,007 ms |
| Category page: product list | 138 ms | 1,190 ms | 2,881 ms |
| Category page: filter counts | 362 ms | 3,580 ms | **9,472 ms** |
| Suggestions while typing ("wir") | 32 ms | 141 ms | 345 ms |
| Typo ("wirelss") | 32 ms | 156 ms | 367 ms |

Where the time goes (50,000 products, a category with all of them):

| Step | Time |
|---|---|
| Count the category's products from the product documents alone | 20 ms |
| The same count with today's per-product offer lookup | **2,533 ms** |
| A sorted page of 24 from the documents alone | 2 ms |
| Every filter count in one pass, from the documents alone | 209 ms |
| Today's filter counts (about 11 passes, each with the offer lookup, plus 6 "summary" passes) | 8–36 s of database work |

The causes, in order of cost:

1. **Offer lookup for every matching product.** Each request joins every matching product with its offers
   (`$lookup` in `base()`), to find the offer the card shows under the active filters. It runs over all matches, not
   just the 24 shown, so cost grows with the number of matches.
2. **The same work repeated.** One page runs a count and the page separately; a text search runs an extra count
   first to decide on spelling correction; the filter counts run about 11 passes plus one full pass per price range
   (5 more) plus a summary.
3. **Suggestions and typo correction scan titles** with unanchored patterns (`(^| )w`), read thousands of titles into
   the server and compare them in JavaScript.

## 2. The changes

Each step is measured with the benchmark before and after, and keeps today's results exactly (see §4).

### Step 1 — Benchmark tool (keep it)

`npm run bench:search` (a `tools/` script, not part of the normal tests): builds 1,000 / 20,000 / 50,000-product
catalogs in a throwaway in-memory database and prints the table above. Used for every step below and later to
compare with OpenSearch.

### Step 2 — Keep each product's offers inside its search document (the big one)

- The search document gets an `offers` array: the same fields as a `search_offers` row (price, stock, seller,
  condition, free delivery, dispatch days, featured eligibility). Products have a handful of offers, so the
  documents stay small.
- The repository already funnels every offer change through four methods (`upsertDocument`, `upsertOffer`,
  `updateOfferRow`, `deleteOffer`); each also refreshes the document's `offers` in the same transaction. The
  `search_offers` collection stays (the seller counts and OpenSearch feed use it).
- The engine replaces the lookup with a filter over the embedded array: the same rule picks the card offer
  (featured first, then in stock, then cheapest, then id), so results don't change. Indexes on the embedded
  fields used by filters (`offers.in_stock`, `offers.price`, `offers.seller_id`, `offers.condition`).
- A one-time migration fills `offers` on existing documents straight from `search_offers` (one database pass,
  seconds for 50,000 products), so deploying needs no reindex.

Expected: every pass loses the lookup — roughly 10× or better on broad searches, category lists and filter counts.

### Step 3 — Do the work once

- **Count and page in one pass** (`$facet`) instead of two.
- **Spelling correction after the search, not before:** today every text search counts first to see whether results
  are few; instead, search, and only when the total is below the threshold try the correction. Saves one full pass
  on every normal search.
- **Filter counts in one pass** for every group whose own filter isn't active (the usual case); only groups with an
  active filter need their own pass (they must ignore their own filter).
- **Price ranges in one pass** instead of one full pass per range. This adds an optional engine method; the service
  falls back to today's per-range counting for an engine that doesn't have it, so OpenSearch is untouched.
- **GraphQL `search` / `categoryProducts`:** compute the filter counts only when the screen selects them, and
  alongside the product list rather than after it (service change; also helps OpenSearch later).

### Step 4 — Suggestions and typo correction

- A small word list (`search_words`: each distinct title/brand word with its first letter and how many products use
  it), kept up to date by the indexer. Typo correction and "is this a known word" read that list instead of
  scanning every title.
- Product suggestions match word starts on the indexed search terms (anchored, index-backed) and rank a capped set of
  candidates; the similarity fallback runs only when prefix matches don't fill the list.

### Step 5 — Only if still needed after steps 2–4

- **Ready-made ranking for category pages:** store the products' ranking factors (stock, featured offer, delivery,
  rating, sales) so a category page with the "Recommended" sort can read the top 24 from an index instead of scoring
  every product. Publishing a new ranking policy would recompute the stored values once.
- **Short cache for category-page filter counts** (about a minute), since they are the same for every shopper.

## 3. Targets at 50,000 products

| Request | Today | Target |
|---|---|---|
| Category page (list + filter counts, in parallel) | ~9.5 s | under 0.5 s |
| Broad search ("wireless") | 0.4 s | under 0.15 s |
| Very common word ("battery") | 2.0 s | under 0.5 s |
| Suggestions while typing | 0.35 s | under 0.1 s |
| Specific searches | ~10 ms | unchanged |

These are targets from the measurements in §1 (documents-only passes take 2–210 ms); the benchmark confirms them
after each step.

## 4. Keeping results identical

- **Engine contract tests** (`test/engine-contract.ts`) run the same scenarios on MongoDB and on the OpenSearch
  adapter: card prices under filters, filter counts and ranges, ranking factors, typo correction, live updates. They
  must pass unchanged.
- **New comparison test:** a randomised catalog with random filters and sorts, answered by today's pipeline (kept in
  the test as the reference) and the new one; results, card offers, totals and every filter count must match.
- **Embedded offers stay in step:** tests for every offer event (created, price, status, stock, featured, merge,
  delete) check the document's `offers` against `search_offers`.
- The full search suite, the integration tests and a browser check of the store's search and category pages.

## 5. Effect on OpenSearch later

None on the OpenSearch engine itself: steps 2 and 4 live in the MongoDB engine; the extra `offers` and word-list data
in the search copy are ignored by the OpenSearch feed. Step 3's service changes (correction order, GraphQL) apply to
both engines and don't change results; the new price-range method is optional, with today's behaviour as the
fallback. The ranking formula doesn't change, so OpenSearch's twin ranking scripts need no change.

## 6. Risks

- **Two copies of offer data** (rows and embedded) could drift; mitigated by writing both in the same transaction in
  the four repository methods and by the per-event tests.
- **Migration on deploy:** the backfill runs once at startup through the module migration system; until it has run,
  the engine falls back to the lookup for documents without embedded offers.
- **Products with very many offers** make documents larger; fine up to thousands of offers per product.

## 7. Size

Steps 1–4: about 3–4 days of work including tests. Step 5 only if the benchmark says so.

## 8. Results (steps 1–4, 2026-10-20)

`npm run bench:search`, same machine. The machine's speed varies by up to about 2× between runs (other work on it),
so compare within a column; step 3 was also checked side by side on one catalog.

| Request (50,000 products) | Before | After steps 1–4 |
|---|---|---|
| Specific search | 7 ms | 14 ms (noise level) |
| Two words | 57 ms | 19 ms |
| Broad word ("wireless") | 700 ms | 61 ms |
| Very common word ("battery") | 4,824 ms | 359 ms |
| Broad word, price low to high | 730 ms | 62 ms |
| Typo ("wirelss") | 826 ms | 154 ms |
| Category page: product list | 6,627 ms | 596 ms |
| Category page: filter counts | 19,230 ms | 1,205 ms |
| Broad word: filter counts | 1,293 ms | 80 ms |
| Category with a price filter, by price | 6,164 ms | 247 ms |
| Suggestions while typing | 638 ms | 14 ms |

The benchmark's category holds all 50,000 products (the worst case); a real category page is proportionally faster.

What differed from the plan:

- **Step 3** went further than planned: since step 2, base()'s first `$match` alone decides which documents pass, so
  every count reads only that stage. Filter counts that read the same documents the same way share a pass; passes
  that read document fields only (category, brand, rating, attributes) skip the offer work, and the passes run at once
  (one big combined pass was slower: it runs on one thread). Spelling correction keeps its count-first order — that
  count is now cheap. GraphQL search reads results and filter counts at once, but still always computes the filter
  counts (computing them only when selected was left out: the saving is small now).
- **Step 4** needed no word-list collection: typo candidates are gathered as distinct words in the database.
  Behaviour change, as planned: with enough prefix matches, a title that is only similar to the typed text no longer
  outranks them.
- **Found, not changed:** the "In stock" filter count counts products whose card offer is in stock. The card prefers
  the featured offer even when it is out of stock, so the count can be below what selecting "In stock" returns.
  Fixing it means changing the facet in both engines.

What is left at 50,000 products in one category: choosing each product's card offer (~0.3 s) and scoring and
sorting every product for the "Recommended" order (~0.3 s). Step 5's stored card offer and stored ranking factors
address both, if needed.
