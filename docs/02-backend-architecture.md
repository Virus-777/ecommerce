# Phase 2: Backend architecture and module plan

Status: **design**. This document defines the backend's structure; the API design for every module (endpoints, request and response types, tables, status flows, events, permissions, jobs) lives in [`docs/api/`](api/README.md) and is published as OpenAPI 3.1 ([`docs/api/openapi.json`](api/openapi.json)). The structure is built in [`backend/`](../backend/README.md): kernel and all 33 modules, generated from and checked against the API design. Module business logic is built: every endpoint has a handler (`npm run modules`), and the phase 3–4 modules are built and off at launch.

## 1. Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js 22+ (tested on 26), TypeScript (strict), ES modules | Types across 30+ modules keep refactors safe |
| HTTP | **Fastify 5** | Lightweight, fast, plugin-per-module fits removable modules, schema-first |
| Validation + API docs | **Zod 4** via `fastify-type-provider-zod`, OpenAPI at `/docs` | One schema drives validation, types and docs |
| Complex screen reads | **GraphQL** via **Mercurius** (Fastify plugin), read-only, three schemas (store, seller, admin) composed from module fragments | One round trip for screens that combine many modules; writes stay on REST |
| Database | **MongoDB 6.0** replica set through **Mongoose 8** (one generated schema per collection; [04-mongodb-migration.md](04-mongodb-migration.md)) | One database for data, jobs, rate limits and idempotency keys; transactions need a replica set |
| Local / test database | An embedded single-node replica set (`mongodb-memory-server`; an installed `mongod` is used when there is one) | Real MongoDB with nothing to configure |
| Product search | **OpenSearch** in production (`@opensearch-project/opensearch`); a MongoDB engine (stemmed words and prefixes) in development and tests (`SEARCH_ENGINE`, §9) | Relevance, typo tolerance and facets at catalogue scale, off the primary database |
| Jobs / schedules | Kernel `JobScheduler` interface: a queue in MongoDB (`kernel.jobs`) in production (each scheduled run happens once across server instances, failed runs retried with backoff); in-process timers in development and tests | Payout runs, ad schedules, SLA timers |
| Events | Kernel in-process typed event bus; outbox table later | Modules talk through events, not each other's tables |
| Tests | Vitest + `app.inject()` + one in-memory MongoDB replica set per run | Each module boots with only its dependencies in a test |

## 2. Shape of the backend

Code layout ([backend/README.md](../backend/README.md) has the details):

```
backend/
  src/
    modules.config.ts      Which modules are on. Add / remove a module here.
    main.ts                Starts the server and the internal health port
    app.ts                 buildApp(): kernel + enabled modules
    spec/                  GENERATED from docs/api/spec by npm run gen
    kernel/                Shared plumbing. Small, stable, no business rules.
      config/  mongo/  events/  jobs/  http/  auth/  errors/  graphql/  spec/
      module-system/       defineModule(), dependency graph, loader, boot
      lib/                 money, ids (UUIDv7), refs, pagination (cursor + page), state machines, clock, secrets
    modules/
      <module>/            One folder per business capability (see section 4)
    integration/           Whole flows across real modules
    testing/               buildTestApp(), dev-token callers, flows, the module contract suite
  tools/
    generate.ts            npm run gen
    new-module.ts          npm run module:new <name>
    modules.ts             npm run modules (list, dependency graph, checks)
    check-boundaries.ts    npm run check:boundaries
    check-api.ts  test-http.ts  migrate.ts  token.ts  bootstrap-owner.ts
```

### API surfaces

| Prefix | Who | Auth |
|---|---|---|
| `/api/store/*` | Customers and guests (website + Android app) | Visitor token (guests) or customer token; the self-service `account` endpoints under `/api/store/identity` take any app's signed-in token |
| `/api/seller/*` | Seller owners and seller staff (Seller Center, website + app) | Seller member session; seller-level permissions |
| `/api/admin/*` | Internal staff (Admin Center + Operations) | Staff session with 2-step; role permissions + approval limits |
| `/api/public/*` | Anyone (sign-in, registration, public settings) | Visitor token of any app. Refresh and sign-out take the refresh token: on the website the cookie of the app named by `audience` in the body, on Android `refreshToken` in the body. The bootstrap endpoint (`POST /api/public/identity/app-sessions`) takes an app proof |
| `/webhooks/*` | Payment and carrier providers | Provider signatures |
| `/files/*` | Anyone holding a link the API issued (`<img src>`, downloads) | The link's own signature (HMAC, expiring for private files, permanent for public renditions), verified by the auth middleware |
| `/graphql/store`, `/graphql/seller`, `/graphql/admin` | Same audiences as the REST areas | Read-only GraphQL for complex screens; persisted queries in production (see [api/graphql/README.md](api/graphql/README.md)) |
| `/docs` | Developers | OpenAPI generated from module schemas; only with `DOCS_ENABLED` (default: development; refused in production), then without a token |
| `/health` | Load balancer | Internal port only (`HEALTH_PORT`, default `PORT`+1); not served on the public port |

Each module registers routes into these scopes. The module name is the next path segment: `/api/store/catalog/products`, `/api/admin/finance/payouts`.

## 3. Module system (how add / update / remove works)

A module is a folder with a manifest (`src/modules/catalog/module.ts`):

```ts
export default defineModule({
  spec,                               // generated from docs/api/spec/modules/catalog.json: name, launch phase,
                                      //   dependsOn, optionalDeps, permissions, events, jobs, settings, endpoints
  version: '1.2.0',                   // bump on every change (npm run modules shows it)
  schemas,                            // Mongoose schemas of its collections catalog.* (generated)
  register(ctx) {
    const service = new CatalogService({ repo: new CatalogRepository(ctx.mongo), ctx });
    ctx.provide(service);                                   // public API for other modules
    ctx.http.routes(storeRoutes(service), sellerRoutes(service), adminRoutes(service));
    ctx.graphql.resolvers(resolvers(service));
    ctx.events.on('sellers.seller.restricted', (e) => service.onSellerRestrictedFromSellers(e.payload));
    ctx.jobs.handle('catalog.refresh-counts', () => service.refreshCounts());
  },
});
```

**Rules that keep modules removable**
1. **Own your data.** Each module owns its collections (`catalog.*`, `orders.*`; `ctx.mongo` reaches only those). Other modules' records are referenced by ID.
2. **Public surface only.** Another module may import only `modules/<x>/contract.ts`: types, the service interface and event payloads. `npm run check:boundaries` fails the build otherwise.
3. **Talk through the kernel.** Synchronous calls use `ctx.use('x')` for a `dependsOn` module (or `ctx.tryUse('x')` for an optional one; undefined when it is off), typed from that module's spec `publicApi`. Reactions use events (`ctx.events.on('orders.order.placed', …)`).
4. **Declare dependencies.** The loader sorts modules by `dependsOn`, refuses to start if one is missing or if there is a cycle, and explains which module needs which.

| Task | Steps |
|---|---|
| **Add** | Write its spec in `docs/api/spec/modules/` → `npm run module:new loyalty` → build it → add `'loyalty'` to `modules.config.ts` → `npm run migrate` |
| **Update** | Change the module (a schema change is a spec change and `npm run gen`; a data change is a `mongoMigrations` entry); bump its `version`. Contract changes are visible to dependents through TypeScript |
| **Disable** | Remove it from `modules.config.ts`. `npm run modules` lists modules that depend on it and blocks the start if a required dependent is still on |
| **Remove** | Disable, then delete the folder. Its collections (`<name>.*`) stay until you drop them, so nothing is lost by accident |
| **Enable a later-phase module** | Uncomment it in `modules.config.ts` (or add it to `MODULES`) and `npm run migrate`. Nothing else blocks the start: e.g. Fulfilled by Marketly (`fulfillment-service`, phase 4) is routed end to end by offers, checkout, orders, warehouse, shipping and returns. Set its settings `serviceLocationId` / `serviceShippingProfileId` first, or rely on the defaults (inventory's default company location, shipping's Official Store default profile); without them no offer sells as Fulfilled by Marketly |

## 4. Module catalog

Generated from the module specs (`docs/api/spec/modules/`, `docs/api/graphql/modules/`) by `node docs/api/tools/sync-architecture.mjs`. Launch phase follows plan ch. 20: phase-1 and phase-2 modules are designed for launch; phase 3–4 modules are designed now and stay off at launch. Optional dependencies are listed on each module page.

| Module | Plan ch. | Owns | Depends on | REST endpoints | GraphQL | Phase |
|---|---|---|---|---|---|---|
| [access](api/modules/access.md) | 2, 18 | What staff may do and how much they may approve: staff roles, the permission registry, role assignments, leads and backups per work area, approval limits per role, approval requests with a second reviewer, and cover while someone is away. Granting access never grants financial authority. | identity | 33 | yes | 1 |
| [audit](api/modules/audit.md) | 2, 18 | The tamper-evident action history: who did what, in which role, to which record, why, what changed (before and after), which approvals applied and the request id. Every module writes to it through record(); staff read it with filters and authorized exports; retention is a governed setting. | - | 11 | yes | 1 |
| [identity](api/modules/identity.md) | 6, 7, 10, 18 | Who someone is and how they prove it: accounts for customers, seller members and staff, credentials, email verification, sessions and refresh tokens for the website and the Android app, password recovery, 2-step verification, signed-in devices, guest sessions and the security activity log. | - | 47 | yes | 1 |
| [media](api/modules/media.md) | 5, 8, 13, 16, 17 | Every uploaded or generated file: images, video and documents. Uploads and signed download links, scanning and processing, renditions, alt text, ownership (seller, staff, customer, platform), image standard checks, where each file is used, and the rules for deleting, removing and retaining files (files in use or kept as evidence cannot be deleted). | - | 29 | - | 1 |
| [notifications](api/modules/notifications.md) | 7, 11, 15, 19 | Who is told what, on which channel: notification topics for customers, sellers and staff, routing from platform events to recipients (staff by role, with backups), templates with versions and preview, in-app inboxes for the store, Seller Center and Admin Center, email delivery with retries and suppression, seller and staff channel preferences, promotional broadcasts under consent, and Android push devices (phase 3). | identity | 45 | yes | 1 |
| [reports](api/modules/reports.md) | 1, 11, 14, 15, 16, 18, 19 | Business reporting with stated meanings: metric definitions with a named owner and versions, a report catalogue grouped by business area, report queries with an explicit date basis, currency and time zone, the admin and seller dashboards, and authorized export jobs. All figures come from read models fed by other modules' events, never from their tables. | - | 33 | yes | 1 |
| [settings](api/modules/settings.md) | 18, 21 | Market-level platform settings: country and service region, currency, time zone, business hours, support contacts, guest checkout, Android app versions and feature flags, plus the effective-dated change process (impact preview, approval, schedule, apply) for every runtime setting a module declares. It also assembles the Admin Center settings page from sections owned by other modules. | access | 16 | yes | 1 |
| [workqueues](api/modules/workqueues.md) | 2, 12, 17, 18, 21 | The Operations Center's shared to-do system: queue definitions with an owner role, a named lead, a backup and an escalation route, and work items raised from other modules' events (overdue dispatch, low stock, waiting approvals, cases past target, failed payouts, mismatches) with deadlines, assignment and automatic escalation. Also the My work queues view, the dashboard's needs-attention tiles, the day-end review, the daily routine and saved filters. | access | 36 | yes | 1 |
| [customers](api/modules/customers.md) | 3, 4, 6, 7, 17, 18, 19 | The customer side of an account: profile, saved addresses, marketing consent, recently viewed products, the Account tab overview, guest order access, data export and account closure, and the staff view of customer accounts with notes and recorded account actions. Credentials, sessions and verification belong to identity. | identity | 33 | yes | 1 |
| [sellers](api/modules/sellers.md) | 2, 10, 11, 17, 18, 21 | Seller admission and the seller account: the Sell with us programme and multi-step application, verification checks and review decisions, seller statuses with account status, product approval and payout readiness kept separate, setup and launch readiness, storefront profile and public storefront, seller members and permissions, performance against targets, warnings, restrictions, suspensions and appeals. | identity, access, media | 90 | yes | 1 |
| [catalog](api/modules/catalog.md) | 5, 8 | What a product is: categories, attributes, brands, products, variants, and the review workflow that decides whether a product may be sold. How a seller sells it (price, stock, condition) belongs to offers. | media | 44 | yes | 1 |
| [inventory](api/modules/inventory.md) | 9, 11, 12, 13 | How many units exist and in which stock group: stock items per offer/SKU with Available, Reserved, Incoming, Damaged or held and Returned quantities per location, checkout holds and order allocations, an append-only movement ledger, reasoned adjustments with second review, low-stock alerts, receipt confirmation and return stock outcomes. | - | 40 | yes | 1 |
| [offers](api/modules/offers.md) | 5, 8, 9, 2 | How one seller (or the Official Store) sells one variant in one condition: price and authentic was-price, purchase limit, seller SKU, dispatch, shipping profile, return and warranty terms, offer status, and the published featured-offer rule that picks the main offer for a delivery location. | catalog, sellers, inventory | 49 | yes | 1 |
| [purchasing](api/modules/purchasing.md) | 9, 2 | Buying stock for the Official Store: suppliers and their price lists, purchase orders (Draft, Sent, Partly received, Received, Cancelled) with buying costs and expected deliveries, receiving records (expected vs received, shortages, damage) that feed inventory, and supplier claims. | inventory | 31 | - | 1 |
| [search](api/modules/search.md) | 4, 3, 19 | Finding products: a product index built from catalog, offers, inventory and reviews events; search with misspelling tolerance and corrections, suggestions (queries, categories, brands, stores, products, recent searches), universal and category filters with counts, sorting, sponsored slots from advertising, and guidance for empty or unavailable results. | catalog, offers | 23 | yes | 1 |
| [warehouse](api/modules/warehouse.md) | 9, 12, 13 | Physical work for Official Store stock: bins, put-away of received goods, pick waves and pick lists by order with bin locations and scanning, packing stations (item checklist, box and weight, carrier label through shipping, packing slip), shortage and damage reports, and receipt of return parcels handed over to returns inspection. | inventory, orders | 33 | yes | 1 |
| [cart](api/modules/cart.md) | 5, 6 | One cart across the Official Store and marketplace sellers for customers and guests. Every line is bound to the exact offer the customer chose, lines are grouped into seller packages with delivery estimates and shipping, and every read re-checks price, stock and eligibility so changes are explained per item instead of discarding the cart. | offers, inventory | 18 | yes | 1 |
| [checkout](api/modules/checkout.md) | 5, 6, 14 | Turns a cart (or a Buy now offer) into an accepted order: identify the customer or guest, choose an address with a per-item shippability check, pick delivery options per package, apply coupons or credit with reasons and item coverage, choose payment, review sellers, return terms and totals, revalidate into a change set the customer must accept, and place the order idempotently with clear payment results. | cart, orders, payments, shipping, customers, offers, inventory | 20 | yes | 1 |
| [orders](api/modules/orders.md) | 7, 8, 11, 12 | The accepted purchase: one order per checkout, one seller group per seller package, and items with their own state (Confirmed, Preparing, Delayed, Shipped, Delivered, cancellation, return, refund). Keeps frozen purchase snapshots, derives the overall status from the items, tracks payment, delivery and returns progress separately, and runs item-level cancellations, seller fulfillment tasks with dispatch deadlines, timelines and purchase documents. | catalog, offers | 36 | yes | 1 |
| [payments](api/modules/payments.md) | 6, 7, 13, 14 | Charging customers through provider adapters (card, digital wallet): payment intents per checkout attempt, authorization and capture per order and seller group, declines with retry, uncertain results resolved by a status-check job, refund execution (Requested → Processing → Sent / Failed) capped at the remaining refundable amount, chargebacks and payment disputes, saved payment methods and provider webhooks. | orders | 32 | yes | 1 |
| [shipping](api/modules/shipping.md) | 5, 6, 11, 12, 18 | How things get delivered: carriers and services, destinations and excluded areas, shipping profiles with rates (Official Store and sellers), free-shipping rules, dispatch targets and cutoffs, the holiday and service-interruption calendar, delivery estimates for a location, shipments with contents and tracking, labels where supported, partial shipments, and delivery exceptions with their required responses and carrier claims. | orders | 72 | yes | 1 |
| [finance](api/modules/finance.md) | 14, 9, 18, 19 | Seller money and company money kept apart: the seller ledger (proceeds, pending, available, held, negative and amounts owed), fee rules, holds, adjustments, payout runs and payouts, statements, payout-destination verification, daily reconciliation checks, and company trading margins separate from marketplace fee income. | orders, payments, sellers, access | 58 | yes | 1 |
| [messaging](api/modules/messaging.md) | 7, 11, 17 | Private service conversations linked to an order, item, return or case: customer with seller (or the Official Store), which Marketly support can join from a case, with attachments, read state, seller reply targets and overdue flags, and staff moderation. No promotional messages. | orders | 29 | yes | 1 |
| [returns](api/modules/returns.md) | 13, 9, 2 | Return policies (platform baseline, seller terms, category exceptions, who pays return shipping), per-item eligibility, return requests and decisions, return shipments, receipt and inspection, remedies (refund, replacement, exchange) and the refund request that Finance approves before payments sends the money. | orders, shipping, payments, inventory | 61 | yes | 1 |
| [reviews](api/modules/reviews.md) | 17, 5 | Product reviews (Verified Purchase), seller feedback kept separate from product reviews, public seller responses under rules, product questions and answers labelled by who answered, reports of inappropriate content, moderation with outcomes visible to reporter and author, appeals, and rating summaries for products and sellers. | orders, catalog, sellers | 48 | yes | 1 |
| [support](api/modules/support.md) | 7, 13, 17 | Help cases and disputes: customer help and order-problem cases opened from the order with items pre-identified, seller support requests to Marketly, disputes between customer and seller with evidence, decision, remedy and appeal, plus categories, priority, owner, SLA deadlines, assignment, escalation and resolve/reopen rules. | orders, access | 39 | yes | 1 |
| [trust](api/modules/trust.md) | 2, 10, 17, 18 | Trust and Risk's case file: reports of counterfeit goods, suspicious orders, fake reviews and abuse from customers, sellers, staff, brand owners and automated signals, with evidence, a risk score, an investigation workflow, enforcement recommendations routed to the team that owns the action, recorded enforcement with reasons, and appeals decided by someone other than the original decider. Trust recommends; Catalog, Seller Manager, Support, Finance and the other owners act. | access | 46 | yes | 1 |
| [advertising](api/modules/advertising.md) | 16, 3, 4, 15 | Ad placements and their rules, ad campaigns through the full lifecycle, creatives and their review, audiences, schedules, frequency caps and dismissal suppression, rotation and priority, the serving decision for each page view, display/click/dismissal tracking with attribution, and seller sponsored campaigns with spending limits and ad charges kept separate from commission. | media, access | 48 | yes | 1 |
| [content](api/modules/content.md) | 19, 15, 4, 3, 17 | Store content managed by the Content Manager: ordered and scheduled homepage sections, campaign pages and curated collections, Help Center articles and categories, policies with versions and effective dates, the About page and footer links. Every item has an owner, a preview, a publication status and schedule, a version history with restore, and a correction or removal action. | media, access | 64 | yes | 1 |
| [promotions](api/modules/promotions.md) | 15, 14, 6, 5 | Discounts and sales campaigns: markdowns, percentage and fixed coupons, minimum-spend and free-shipping offers, flash sales, seller discounts and platform campaigns with seller consent. Owns eligibility, stacking, budgets and caps, the funding owner of every discount, coupon clipping and redemption, the Deals page data and campaign results. | catalog, offers | 55 | yes | 1 |
| [fulfillment-service](api/modules/fulfillment-service.md) | 1, 12, 9, 14 | Platform storage and shipping for sellers: seller enrollment under service terms, SKU enrollment, inbound shipments to our warehouse, receiving into seller-owned stock, picking and shipping by us while the seller stays the seller of record, returns handling, removal of stock, and storage and handling fees with full seller visibility. | inventory, warehouse, finance | 41 | - | 4 (off) |
| [wallet](api/modules/wallet.md) | 15, 7, 13, 6 | Customer store credit with an auditable ledger (refunds to credit, goodwill credit within approval limits, price adjustments, use at checkout, expiry), gift cards, and a placeholder for loyalty rewards. Checkout and payments use the balance through the in-process public API. | customers, payments | 15 | yes | 3 (off) |
| [wishlist](api/modules/wishlist.md) | 3, 7, 19 | Saved shopping for customers: saved items in one or more lists, price-drop and back-in-stock alerts, and shareable lists. Alerts are delivered through notifications under the customer's promotional preferences. | catalog, offers, customers | 19 | yes | 3 (off) |

## 5. Cross-cutting rules

| Topic | Rule |
|---|---|
| **IDs** | UUIDv7 strings generated in the app (sortable, database-independent). Human references are separate fields: `MK-YYMMDD-NNNNN` orders, `RT-` returns, `CS-` cases, `PO-` payouts, `PUR-` purchase orders |
| **Money** | Integer minor units + currency (`{ amount: 18900, currency: 'USD' }`). Never floats |
| **Time** | Stored in UTC; market time zone (America/Los_Angeles) applied at the edges; deadlines are absolute timestamps |
| **Pagination** | Every list supports **cursor** paging (`?cursor=&limit=`, for the Android app's infinite scroll) and **page** paging (`?page=&limit=`, for the website's numbered pages). Responses: `{ items, nextCursor, page?, totalPages?, total? }` |
| **State machines** | Statuses from the plan (product review, seller account, order item, refund, payout, return, case, ad campaign) are explicit transition tables in each module's `domain/`; illegal moves return `409` |
| **Idempotency** | Writes that move money or create orders require an `Idempotency-Key` header (plan scenario 3: no duplicate orders or charges). The kernel stores the first response per operation, caller and key for 24 hours (`kernel.idempotency_keys`) and replays it; a failed request, or a refused step-up proof, frees the key for the retry |
| **Audit** | Material changes write an audit entry through the audit module's `record()` (an optional dependency, called after the commit): actor, role, action, target, reason, before/after, approvals (plan ch. 2, 18). Entries are append-only and hash-chained (below) |
| **Approvals** | Limits per role (refunds, payouts, holds, restrictions, price changes). Above the limit the action becomes an approval request; some actions always need a second reviewer. Granting access never grants financial authority |
| **Purchase snapshots** | Orders copy the product description, variation, condition, price, seller and terms accepted at purchase (plan ch. 8) |
| **Errors** | `{ error: { code, message, details } }` with stable codes (`OFFER_CHANGED`, `ILLEGAL_TRANSITION`, `APPROVAL_REQUIRED` …) |
| **Database portability** | Every database read and write of a module is in its `repository.ts` (one class); services call its methods and never the database. No cross-module joins or references exist to untangle, so another database means rewriting repositories, not services |
| **File storage** | Owner decision: files live on the server's **local file system** (no S3). media's storage port has two adapters, chosen by `MEDIA_STORAGE` (below); both stream bytes through the API: uploads to `PUT /api/{area}/media/uploads/{id}/content` (the caller's token), downloads from `GET /files/{bucket}/{key}` by signed links the auth middleware verifies ([03-auth-middleware.md](03-auth-middleware.md) §0 "File links") |

### File storage configuration (media)

| Variable | Default | Meaning |
|---|---|---|
| `MEDIA_STORAGE` | `local`; `memory` when `NODE_ENV=test` | `local`: files on disk under `MEDIA_STORAGE_DIR` (`providers/storage/local.ts`). `memory`: kept in the process and lost on restart (`providers/storage/memory.ts`; refused in production). Both pass the same contract tests (`providers/storage/storage.test.ts`) |
| `MEDIA_STORAGE_DIR` | `.data/media` (relative to the working directory) | `<dir>/<bucket>/<key>` holds the bytes (buckets `marketly-public`, `marketly-private` are folders), `<dir>/.meta/` content type, ETag and checksum per file, `<dir>/.tmp/` writes in progress (temp file, flushed, then renamed: atomic). Back it up with the database; with more than one API server it must be a shared volume |
| `API_URL` | `http://localhost:<PORT>` | The API's public address: file links (`<API_URL>/files/…`) point here. Required in production |
| `APP_SECRET` | dev value while `DEV_TOKENS` is on; required in production | File links are signed with `secretFor(config, 'media.files')`, derived from it; rotating it invalidates links already handed out, including stored public image URLs |

Limits: an upload is refused above the ticket's `maxBytes` while it streams (nothing is kept); public renditions are served `Cache-Control: public, max-age=3600`, private files `private` (attachments `no-store`); file requests have their own IP rate limit (3,000/min). Processing still reads each upload into memory once (scan, probe, renditions), as before.

### Several server instances: jobs and rate limits

Shared state lives in MongoDB only (no Redis), so any number of server instances can run on one replica set.

**Jobs** (`kernel/jobs/mongo.ts`). Every job in a module spec is queued in `kernel.jobs` under its name:

| Schedule phrase | Runs as |
|---|---|
| `every N s`, `every N min`, `hourly`, `every N hours` | one run per slot (slots aligned to the clock), whatever the number of instances |
| `daily` / `nightly HH:MM`, `weekly`, `monthly` (the 1st) | one run per occurrence in `MARKET_TIME_ZONE` |
| `on boot` | once per deploy: keyed by `DEPLOY_ID` plus the enabled modules and their versions (`kernel.job_boots`) |

The next tick of each schedule is kept in `kernel.job_schedules`; the instance that advances it enqueues the run. A job holds at most one waiting and one running run (unique indexes), so it never overlaps itself and missed ticks don't pile up. A failed run is retried 3 times with exponential backoff (30 s, doubling, at most 15 min); a run whose instance stopped is taken again when its one-hour lease ends. `runNow` enqueues a run (not retried) and waits until whichever instance worked it is done; when a run is already waiting, it waits for that one. Finished runs are kept 7 days.

| Variable | Default | Meaning |
|---|---|---|
| `JOBS_BACKEND` | `mongo` with `MONGODB_URI`, else `inprocess` | `inprocess` runs timers in each process (development and tests; every instance runs every job) |
| `JOBS_ENABLED` | `false` | This instance works the queues and keeps the schedules. Instances without it only enqueue (`runNow`), so web and worker instances can be split |
| `DEPLOY_ID` | - | The deployment (image tag, commit); `on boot` jobs run once per value and module set |

**Rate limits** (`kernel/auth/rate-limit.ts`). The middleware's limits ([03-auth-middleware.md §11](03-auth-middleware.md#11-rate-limits)) and modules' business limits (`ctx.rateLimit(key, { limit, windowMs, peek? })` → `{ allowed, retryAfterMs }`, e.g. coupon attempts in cart, gift card attempts in wallet) count in fixed windows aligned to the clock (an hour window runs :00 to :00), one document per scope (`http` or the module), key and window start in `kernel.rate_limits` (one conditional upsert per attempt; a TTL index removes ended windows). A refused attempt is not counted. The kernel job `kernel.purge-rate-limits` deletes ended windows every 10 minutes.

| Variable | Default | Meaning |
|---|---|---|
| `RATE_LIMIT_STORE` | `mongo` with `MONGODB_URI`, else `memory` | `memory` counts per process (development and tests) |
| `RATE_LIMITS` | `true` | Off only for contract and load tests (refused in production); modules' business limits apply either way |

### Audit history

`audit.entries` is one collection (with `audit.entry_targets` for lookups by related record); the hash chain and signed checkpoints make any change detectable. The repository only inserts entries; in production the database user's role should also allow no update or delete on `audit.*` except for the purge.

| Job | Schedule | Does |
|---|---|---|
| `audit.verify-chain` | daily 03:00 market time | Recomputes the chain from the newest signed checkpoint and writes a new checkpoint; a mismatch publishes `audit.integrity.failed` |
| `audit.purge-expired` | monthly | Writes a signed checkpoint, then deletes the entries older than the retention cut-off (by the indexed `at`) with their targets. The purge is recorded as an entry, so the chain still verifies |

## 6. Plan scenarios → modules (plan ch. 21)

| Scenario | Modules involved |
|---|---|
| 1 Mixed purchase across sellers | cart → checkout → orders (seller groups) → payments → shipping, warehouse, finance |
| 2 Offer changed before purchase | cart / checkout revalidation (`OFFER_CHANGED`), offers |
| 3 Payment uncertainty | payments (pending + check job), checkout idempotency |
| 4 Partial cancellation / return | orders (item-level), returns, payments (partial refund), finance (earnings) |
| 5 Late shipment | shipping (dispatch deadlines) → workqueues + notifications → support |
| 6 Refund after payout | returns / payments → finance (deduction or negative balance), statements |
| 7 Seller restriction | sellers → offers (hide new sales) while orders, returns, support stay open |
| 8 Opening advertisement | advertising (serve, frequency cap, pause, expiry) → content / store UI |

## 7. Inside a module

Every module has the same shape, so any developer can find their way around any module. How to build one: [backend/docs/BUILDING-MODULES.md](../backend/docs/BUILDING-MODULES.md).

```
src/modules/<module>/
  module.ts              Manifest: the generated spec, version, Mongoose schemas, GraphQL fragment, wiring (routes, consumers, jobs, resolvers)
  contract.ts            The ONLY file other modules may import: public API interface, shared types, event payloads
  README.md              Generated from the module's API spec (docs/api/modules/<module>.md)
  domain/                State machines and pure business rules (no framework, no database)
  service.ts             Use cases; implements the public API, event consumers and jobs, through the repository and ctx
                         (large modules: service/core.ts + service/<feature>.ts, composed by a short service.ts)
  repository.ts          Every read and write on ctx.mongo (the module's own collections), one class that is its own type
  ports.ts               Row types and provider ports (interfaces of outside services), when the module has any
  schema.ts              The generated Mongoose schemas, one per spec table
  providers/             Provider adapters behind ports (storage, scanning, search engine …), with a dev adapter
  http/<area>.ts         One typed handler per spec endpoint of that area (store, seller, admin, public, webhooks); request and response schemas are generated in src/spec
  graphql/               This module's schema fragment + resolvers (read-only; fields it owns, incl. fields on other modules' types)
  permissions.ts         Permission keys this module declares
  <module>.test.ts       The contract suite: boots the module with its dependencies on the in-memory MongoDB
  test/                  Behaviour tests (helpers.ts boots the module for them)
```

## 8. API documentation

| What | Where |
|---|---|
| Module specs (source of truth) | `docs/api/spec/modules/<module>.json`, format in `docs/api/spec/FORMAT.md` |
| Shared types, areas, errors, headers | `docs/api/spec/common.json` |
| OpenAPI 3.1 (Swagger UI, Redoc, Postman, client generation for the web app and Android) | `docs/api/openapi.json` |
| Readable reference per module | `docs/api/modules/<module>.md` |
| GraphQL read layer: design, module fragments, composed schemas, screen queries | `docs/api/graphql/` (validate with `node docs/api/tools/graphql.mjs`) |
| Visual API reference (artifact) | `docs/api/viewer/` |
| Regenerate + validate | `node docs/api/tools/build.mjs` |

The build validates that every type resolves, path parameters match, permissions and consumed events exist, each endpoint's prototype screens exist, and no two modules claim the same route.

## 9. Search engine (OpenSearch)

Search's public API and endpoints are the same with either engine; only the adapter behind the `SearchEngine` port changes (`backend/src/modules/search/`: `mongo-engine.ts`, `providers/opensearch/`).

| `SEARCH_ENGINE` | Where | What answers queries |
|---|---|---|
| `mongo` (default) | development, tests | Stemmed words and prefixes over the read-model collections `search.search_documents` / `search.search_offers`, with aggregation pipelines (`mongo-engine.ts`). Misspellings are corrected only when the first letter is right |
| `opensearch` | production | An OpenSearch index fed from the same read model (`providers/opensearch/`) |

**Read model and feed.** MongoDB stays the source of truth for the index: event consumers and jobs write `search_documents` and `search_offers` exactly as before. With OpenSearch the repository is wrapped (`index-feed.ts`): after each commit the changed products are read back and sent as one `_bulk` request. A rebuilt document carries its searchable texts and replaces the indexed one; other changes replace every field but the texts. Each write is a Painless update that applies only if the read-model `version` is not older, so concurrent servers cannot put an older state back. Rejected (429) and failed (5xx) items are retried with backoff (`OPENSEARCH_BULK_ATTEMPTS`); whatever still fails — the cluster is down, or a change arrives for a document the index lacks — is marked dirty and rebuilt in full by `search.process-dirty`. Suggestion terms (popular queries, category, brand and store names), synonyms, recent searches, logs and jobs stay in MongoDB.

**Index.** Queries and writes use the alias `<prefix>-products`, which points at one versioned index `<prefix>-products-<UTC timestamp>` (the first one is `…-00000000000000000`). Documents hold every read-model field (cards are built from hits), the texts (title and brand weighted highest, then category, attributes, description; English analysis with Porter stems, as the MongoDB engine stems), live offers as `nested` documents (seller, condition, price, stock, delivery, featured flag and `card_rank`: featured first, then in stock, then cheapest), category attributes as nested key/value pairs, keyword facets, numeric prices, rating, popularity and `sales_30d`, dispatch days and same-day cutoffs for "ships today" and "arrives by". `MAPPING_VERSION` (`providers/opensearch/mapping.ts`) is stored in the index; bump it on any mapping change.

**Queries** (`providers/opensearch/query.ts`, exact bodies unit-tested):
- Text: every word (group) must match across the text fields (`cross_fields`, operator and), any synonym alternative of a group; phrases match as phrases; a full GTIN matches the `gtins` keyword. Synonyms come from search's synonym table and are expanded by the service before the engine sees the query, so a synonym change applies on the next query with no reindex.
- The card offer is the matching offer with the lowest `card_rank` (inner hit `eo`, with the number of matching offers for "from" prices). Filters on sellers, condition, price, stock and delivery apply to offers.
- Recommended ranking = text relevance (BM25 `s/(s+1)` × weight) + the published ranking policy's factors as scripts (in stock and delivery speed of the card offer, featured offer, rating with ≥ 3 reviews, conversion) + 1 for a GTIN match. Explain splits a hit's score into the same factors.
- Price sorts use the card offer's price exactly: products are split into streams by where their card offer comes from (featured / in stock / any), each sorted by a nested minimum over that tier, and merged.
- Facets: one aggregation per facet, counted against the other active filters (categories, active brands, sellers and the Official Store, conditions, ratings, availability by card offer, delivery, category attributes); the price range is the lowest and highest card-offer price.
- Typo tolerance: a misspelled word is corrected ("Showing results for …") from candidates the term suggester finds within two edits in the index's title words plus the suggestion terms' words, ranked by trigram similarity; suggestions while typing match title words as prefixes and with `fuzziness: AUTO`.
- Paging keeps the API's cursors (an offset); pages beyond `max_result_window` (10,000) are empty.

**Full reindex (blue/green).** `search.full-reindex` (nightly, or `POST /api/admin/search/reindex-jobs` with scope `all`) creates a new versioned index and points `<prefix>-products-building` at it; every server writes each change to both indices (servers re-check the building alias every `OPENSEARCH_ALIAS_CACHE_MS`, and the job waits that long before rebuilding). Every product is rebuilt from the source modules; products that cannot be rebuilt keep their current document (copied from the live index). Then one `_aliases` call moves `<prefix>-products` to the new index atomically. The previous index is kept for a manual rollback; older ones are deleted. A failed reindex drops the new index and the live one keeps serving. At startup a new (empty) index over a populated read model, or one built with an older `MAPPING_VERSION`, queues a full reindex automatically.

**Health.** `GET /api/admin/search/index` reports the engine in `engine`, e.g. `opensearch (green, index marketly-products-20261010031500123)`, with `mapping vN < vM: full reindex needed`, `rebuilding into …` or `unreachable: …` when they apply (`mongo-text` for the MongoDB engine).

**Configuration** (`backend/.env.example`):

| Variable | Default | |
|---|---|---|
| `SEARCH_ENGINE` | `mongo` | `mongo` or `opensearch` |
| `OPENSEARCH_URL` | — | Required for `opensearch`; one node or a comma-separated list |
| `OPENSEARCH_USERNAME`, `OPENSEARCH_PASSWORD` | — | Basic authentication (together) |
| `OPENSEARCH_API_KEY` | — | Instead of a username: sent as `Authorization: ApiKey <key>` |
| `OPENSEARCH_INDEX_PREFIX` | `marketly` | Index and alias names |
| `OPENSEARCH_SHARDS`, `OPENSEARCH_REPLICAS` | `1`, `1` | For new indices (a reindex applies a change) |
| `OPENSEARCH_REFRESH` | `false` | `false` (near real time), `wait_for` or `true` after writes |
| `OPENSEARCH_REQUEST_TIMEOUT_MS` | `10000` | Per request; the client retries connection errors and 502/503/504 twice |
| `OPENSEARCH_BULK_ATTEMPTS` | `3` | Then products are queued for `search.process-dirty` |
| `OPENSEARCH_ALIAS_CACHE_MS` | `5000` | How long a server trusts what it knows about a running reindex |

**Tests.** No cluster is needed:
- `test/opensearch-query.test.ts` checks the translation (exact request bodies), documents, the scripts' JavaScript twins and the configuration.
- `test/opensearch-fake/` is an in-memory OpenSearch behind the real client (a `Connection` class, so request building, NDJSON, response parsing and errors are the client's own). `test/engine-contract.test.ts` runs the same scenarios on the MongoDB engine and on the adapter with the fake; `SEARCH_TEST_ENGINE=opensearch npx vitest run src/modules/search` runs the whole search suite on the fake. `test/opensearch-index.test.ts` covers the index lifecycle, retries, the blue/green swap and the feed.
- What the fake does not prove: Painless is not executed (each script is matched by its source to a JavaScript twin in `scripts.ts`, which must change with it); writes are visible at once (no refresh interval); one shard, so BM25 statistics and `cardinality` are exact; the standard tokenizer, fuzzy scoring and the term suggester's ranking are approximations; cluster behaviour (replicas, timeouts, partial failures) only as far as a test injects faults. Relevance order between products whose only difference is text relevance may differ between the MongoDB engine and OpenSearch.
- `test/opensearch.integration.test.ts` runs the contract and the index lifecycle on a real cluster, only when `OPENSEARCH_URL` is set, with throwaway indices (`it-<time>-<random>`, deleted afterwards): `OPENSEARCH_URL=http://localhost:9200 npx vitest run src/modules/search/test/opensearch.integration.test.ts` (e.g. `docker run -p 9200:9200 -e discovery.type=single-node -e DISABLE_SECURITY_PLUGIN=true opensearchproject/opensearch:2`). `SEARCH_TEST_ENGINE=opensearch-live` runs the whole search suite there.
