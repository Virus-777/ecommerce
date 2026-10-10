# Phase 2: Backend architecture and module plan

Status: **design**. This document defines the backend's structure; the API design for every module (endpoints, request and response types, tables, status flows, events, permissions, jobs) lives in [`docs/api/`](api/README.md) and is published as OpenAPI 3.1 ([`docs/api/openapi.json`](api/openapi.json)). The structure is built in [`backend/`](../backend/README.md): kernel and all 33 modules, generated from and checked against the API design. Module business logic is not built yet (endpoints answer 501 NOT_IMPLEMENTED).

## 1. Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js 22+ (tested on 26), TypeScript (strict), ES modules | Types across 30+ modules keep refactors safe |
| HTTP | **Fastify 5** | Lightweight, fast, plugin-per-module fits removable modules, schema-first |
| Validation + API docs | **Zod 4** via `fastify-type-provider-zod`, OpenAPI at `/docs` | One schema drives validation, types and docs |
| Complex screen reads | **GraphQL** via **Mercurius** (Fastify plugin), read-only, three schemas (store, seller, admin) composed from module fragments | One round trip for screens that combine many modules; writes stay on REST |
| Database | **PostgreSQL** through **Kysely** (typed SQL query builder) | No ORM magic; SQL stays portable; easy to replace per module |
| Local / test database | **PGlite** (PostgreSQL compiled to WASM, in-process) | Real Postgres semantics with nothing to install |
| Jobs / schedules | Kernel `JobScheduler` interface: **pg-boss** queue in PostgreSQL in production (each scheduled run happens once across server instances, failed runs retried with backoff); in-process timers on PGlite (development, tests) | Payout runs, ad schedules, SLA timers |
| Events | Kernel in-process typed event bus; outbox table later | Modules talk through events, not each other's tables |
| Tests | Vitest + `app.inject()` + PGlite | Each module boots alone in a test |

## 2. Shape of the backend

Planned code layout:

```
backend/
  src/
    modules.config.ts      Which modules are on. Add / remove a module here.
    main.ts                Starts the server
    app.ts                 buildApp(): kernel + enabled modules
    kernel/                Shared plumbing. Small, stable, no business rules.
      config/  logger/  db/  migrations/  events/  jobs/  http/  auth/  errors/
      module-system/       defineModule(), dependency graph, loader, registry
      lib/                 money, ids (UUIDv7), refs, pagination (cursor + page), state machines, clock
    modules/
      <module>/            One folder per business capability (see section 4)
  tools/
    new-module.ts          npm run module:new <name>
    modules.ts             npm run modules (list, dependency graph, checks)
    check-boundaries.ts    npm run check:boundaries
```

### API surfaces

| Prefix | Who | Auth |
|---|---|---|
| `/api/store/*` | Customers and guests (website + Android app) | Guest session or customer session |
| `/api/seller/*` | Seller owners and seller staff (Seller Center, website + app) | Seller member session; seller-level permissions |
| `/api/admin/*` | Internal staff (Admin Center + Operations) | Staff session; role permissions + approval limits |
| `/webhooks/*` | Payment and carrier providers | Provider signatures |
| `/graphql/store`, `/graphql/seller`, `/graphql/admin` | Same audiences as the REST areas | Read-only GraphQL for complex screens; persisted queries in production (see [api/graphql/README.md](api/graphql/README.md)) |
| `/docs` | Developers | OpenAPI generated from module schemas |

Each module registers routes into these scopes. The module name is the next path segment: `/api/store/catalog/products`, `/api/admin/finance/payouts`.

## 3. Module system (how add / update / remove works)

A module is a folder with a manifest:

```ts
export default defineModule({
  name: 'catalog',
  version: '0.1.0',
  launchPhase: 1,                     // plan ch. 20: 1 controlled launch … 4 operational expansion
  dependsOn: ['media'],               // must be enabled, loaded first
  optionalDeps: ['search'],           // used when present
  permissions: catalogPermissions,    // registered with the access module
  migrations: catalogMigrations,      // owned tables, schema "catalog"
  async register(ctx) {
    const repo = createCatalogRepository(ctx.data);   // picks the Postgres (or later Mongo) adapter
    const service = new CatalogService(repo, ctx.events, ctx.clock);
    ctx.provide<CatalogApi>(service);                 // public API for other modules
    ctx.http.store(storeRoutes(service));
    ctx.http.seller(sellerRoutes(service));
    ctx.http.admin(adminRoutes(service));
    ctx.events.on('sellers.seller.restricted', (e) => service.hideOffersOfSeller(e.sellerId));
  },
});
```

**Rules that keep modules removable**
1. **Own your data.** Each module owns a PostgreSQL schema (`catalog.*`, `orders.*`). No foreign keys across schemas. Other modules' records are referenced by ID.
2. **Public surface only.** Another module may import only `modules/<x>/contract.ts`: types, the service interface and event payloads. `npm run check:boundaries` fails the build otherwise.
3. **Talk through the kernel.** Synchronous calls use `ctx.use<Api>('x')` (or `ctx.tryUse` for optional dependencies). Reactions use events (`ctx.events.on('orders.order.placed', …)`).
4. **Declare dependencies.** The loader sorts modules by `dependsOn`, refuses to start if one is missing or if there is a cycle, and explains which module needs which.

| Task | Steps |
|---|---|
| **Add** | Write its spec in `docs/api/spec/modules/` → `npm run module:new loyalty` → build it → add `'loyalty'` to `modules.config.ts` → `npm run migrate` |
| **Update** | Change the module; add a new migration file; bump its `version`. Contract changes are visible to dependents through TypeScript |
| **Disable** | Remove it from `modules.config.ts`. `npm run modules` lists modules that depend on it and blocks the start if a required dependent is still on |
| **Remove** | Disable, then delete the folder. Its tables stay until you drop the schema (`DROP SCHEMA <name> CASCADE`), so nothing is lost by accident |

## 4. Module catalog

Generated from the module specs (`docs/api/spec/modules/`, `docs/api/graphql/modules/`) by `node docs/api/tools/sync-architecture.mjs`. Launch phase follows plan ch. 20: phase-1 and phase-2 modules are designed for launch; phase 3–4 modules are designed now and stay off at launch. Optional dependencies are listed on each module page.

| Module | Plan ch. | Owns | Depends on | REST endpoints | GraphQL | Phase |
|---|---|---|---|---|---|---|
| [access](api/modules/access.md) | 2, 18 | What staff may do and how much they may approve: staff roles, the permission registry, role assignments, leads and backups per work area, approval limits per role, approval requests with a second reviewer, and cover while someone is away. Granting access never grants financial authority. | identity | 33 | yes | 1 |
| [audit](api/modules/audit.md) | 2, 18 | The tamper-evident action history: who did what, in which role, to which record, why, what changed (before and after), which approvals applied and the request id. Every module writes to it through record(); staff read it with filters and authorized exports; retention is a governed setting. | - | 11 | yes | 1 |
| [identity](api/modules/identity.md) | 6, 7, 10, 18 | Who someone is and how they prove it: accounts for customers, seller members and staff, credentials, email verification, sessions and refresh tokens for the website and the Android app, password recovery, 2-step verification, signed-in devices, guest sessions and the security activity log. | - | 46 | yes | 1 |
| [media](api/modules/media.md) | 5, 8, 13, 16, 17 | Every uploaded or generated file: images, video and documents. Signed direct uploads, scanning and processing, renditions, alt text, ownership (seller, staff, customer, platform), image standard checks, where each file is used, and the rules for deleting, removing and retaining files (files in use or kept as evidence cannot be deleted). | - | 26 | - | 1 |
| [notifications](api/modules/notifications.md) | 7, 11, 15, 19 | Who is told what, on which channel: notification topics for customers, sellers and staff, routing from platform events to recipients (staff by role, with backups), templates with versions and preview, in-app inboxes for the store, Seller Center and Admin Center, email delivery with retries and suppression, seller and staff channel preferences, promotional broadcasts under consent, and Android push devices (phase 3). | identity | 45 | yes | 1 |
| [reports](api/modules/reports.md) | 1, 11, 14, 15, 16, 18, 19 | Business reporting with stated meanings: metric definitions with a named owner and versions, a report catalogue grouped by business area, report queries with an explicit date basis, currency and time zone, the admin and seller dashboards, and authorized export jobs. All figures come from read models fed by other modules' events, never from their tables. | - | 31 | yes | 1 |
| [settings](api/modules/settings.md) | 18, 21 | Market-level platform settings: country and service region, currency, time zone, business hours, support contacts, guest checkout, Android app versions and feature flags, plus the effective-dated change process (impact preview, approval, schedule, apply) for every runtime setting a module declares. It also assembles the Admin Center settings page from sections owned by other modules. | access | 16 | yes | 1 |
| [workqueues](api/modules/workqueues.md) | 2, 12, 17, 18, 21 | The Operations Center's shared to-do system: queue definitions with an owner role, a named lead, a backup and an escalation route, and work items raised from other modules' events (overdue dispatch, low stock, waiting approvals, cases past target, failed payouts, mismatches) with deadlines, assignment and automatic escalation. Also the My work queues view, the dashboard's needs-attention tiles, the day-end review, the daily routine and saved filters. | access | 36 | yes | 1 |
| [customers](api/modules/customers.md) | 3, 4, 6, 7, 17, 18, 19 | The customer side of an account: profile, saved addresses, marketing consent, recently viewed products, the Account tab overview, guest order access, data export and account closure, and the staff view of customer accounts with notes and recorded account actions. Credentials, sessions and verification belong to identity. | identity | 33 | yes | 1 |
| [sellers](api/modules/sellers.md) | 2, 10, 11, 17, 18, 21 | Seller admission and the seller account: the Sell with us programme and multi-step application, verification checks and review decisions, seller statuses with account status, product approval and payout readiness kept separate, setup and launch readiness, storefront profile and public storefront, seller members and permissions, performance against targets, warnings, restrictions, suspensions and appeals. | identity, access, media | 89 | yes | 1 |
| [catalog](api/modules/catalog.md) | 5, 8 | What a product is: categories, attributes, brands, products, variants, and the review workflow that decides whether a product may be sold. How a seller sells it (price, stock, condition) belongs to offers. | media | 43 | yes | 1 |
| [inventory](api/modules/inventory.md) | 9, 11, 12, 13 | How many units exist and in which stock group: stock items per offer/SKU with Available, Reserved, Incoming, Damaged or held and Returned quantities per location, checkout holds and order allocations, an append-only movement ledger, reasoned adjustments with second review, low-stock alerts, receipt confirmation and return stock outcomes. | - | 39 | yes | 1 |
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
| [returns](api/modules/returns.md) | 13, 9, 2 | Return policies (platform baseline, seller terms, category exceptions, who pays return shipping), per-item eligibility, return requests and decisions, return shipments, receipt and inspection, remedies (refund, replacement, exchange) and the refund request that Finance approves before payments sends the money. | orders, shipping, payments, inventory | 59 | yes | 1 |
| [reviews](api/modules/reviews.md) | 17, 5 | Product reviews (Verified Purchase), seller feedback kept separate from product reviews, public seller responses under rules, product questions and answers labelled by who answered, reports of inappropriate content, moderation with outcomes visible to reporter and author, appeals, and rating summaries for products and sellers. | orders, catalog, sellers | 43 | yes | 1 |
| [support](api/modules/support.md) | 7, 13, 17 | Help cases and disputes: customer help and order-problem cases opened from the order with items pre-identified, seller support requests to Marketly, disputes between customer and seller with evidence, decision, remedy and appeal, plus categories, priority, owner, SLA deadlines, assignment, escalation and resolve/reopen rules. | orders, access | 38 | yes | 1 |
| [trust](api/modules/trust.md) | 2, 10, 17, 18 | Trust and Risk's case file: reports of counterfeit goods, suspicious orders, fake reviews and abuse from customers, sellers, staff, brand owners and automated signals, with evidence, a risk score, an investigation workflow, enforcement recommendations routed to the team that owns the action, recorded enforcement with reasons, and appeals decided by someone other than the original decider. Trust recommends; Catalog, Seller Manager, Support, Finance and the other owners act. | access | 44 | yes | 1 |
| [advertising](api/modules/advertising.md) | 16, 3, 4, 15 | Ad placements and their rules, ad campaigns through the full lifecycle, creatives and their review, audiences, schedules, frequency caps and dismissal suppression, rotation and priority, the serving decision for each page view, display/click/dismissal tracking with attribution, and seller sponsored campaigns with spending limits and ad charges kept separate from commission. | media, access | 48 | yes | 1 |
| [content](api/modules/content.md) | 19, 15, 4, 3, 17 | Store content managed by the Content Manager: ordered and scheduled homepage sections, campaign pages and curated collections, Help Center articles and categories, policies with versions and effective dates, the About page and footer links. Every item has an owner, a preview, a publication status and schedule, a version history with restore, and a correction or removal action. | media, access | 61 | yes | 1 |
| [promotions](api/modules/promotions.md) | 15, 14, 6, 5 | Discounts and sales campaigns: markdowns, percentage and fixed coupons, minimum-spend and free-shipping offers, flash sales, seller discounts and platform campaigns with seller consent. Owns eligibility, stacking, budgets and caps, the funding owner of every discount, coupon clipping and redemption, the Deals page data and campaign results. | catalog, offers | 55 | yes | 1 |
| [fulfillment-service](api/modules/fulfillment-service.md) | 1, 12, 9, 14 | Platform storage and shipping for sellers: seller enrollment under service terms, SKU enrollment, inbound shipments to our warehouse, receiving into seller-owned stock, picking and shipping by us while the seller stays the seller of record, returns handling, removal of stock, and storage and handling fees with full seller visibility. | inventory, warehouse, finance | 39 | - | 4 (off) |
| [wallet](api/modules/wallet.md) | 15, 7, 13, 6 | Customer store credit with an auditable ledger (refunds to credit, goodwill credit within approval limits, price adjustments, use at checkout, expiry), gift cards, and a placeholder for loyalty rewards. Checkout and payments use the balance through the in-process public API. | customers, payments | 14 | yes | 3 (off) |
| [wishlist](api/modules/wishlist.md) | 3, 7, 19 | Saved shopping for customers: saved items in one or more lists, price-drop and back-in-stock alerts, and shareable lists. Alerts are delivered through notifications under the customer's promotional preferences. | catalog, offers, customers | 19 | yes | 3 (off) |

## 5. Cross-cutting rules

| Topic | Rule |
|---|---|
| **IDs** | UUIDv7 strings generated in the app (sortable, database-independent). Human references are separate fields: `MK-YYMMDD-NNNNN` orders, `RT-` returns, `CS-` cases, `PO-` payouts, `PUR-` purchase orders |
| **Money** | Integer minor units + currency (`{ amount: 18900, currency: 'USD' }`). Never floats |
| **Time** | Stored in UTC; market time zone (America/Los_Angeles) applied at the edges; deadlines are absolute timestamps |
| **Pagination** | Every list supports **cursor** paging (`?cursor=&limit=`, for the Android app's infinite scroll) and **page** paging (`?page=&limit=`, for the website's numbered pages). Responses: `{ items, nextCursor, page?, totalPages? }` |
| **State machines** | Statuses from the plan (product review, seller account, order item, refund, payout, return, case, ad campaign) are explicit transition tables in each module's `domain/`; illegal moves return `409` |
| **Idempotency** | Writes that move money or create orders require an `Idempotency-Key` header (plan scenario 3: no duplicate orders or charges) |
| **Audit** | Material changes publish an audit record: actor, role, action, target, reason, before/after, approvals (plan ch. 2, 18) |
| **Approvals** | Limits per role (refunds, payouts, holds, restrictions, price changes). Above the limit the action becomes an approval request; some actions always need a second reviewer. Granting access never grants financial authority |
| **Purchase snapshots** | Orders copy the product description, variation, condition, price, seller and terms accepted at purchase (plan ch. 8) |
| **Errors** | `{ error: { code, message, details } }` with stable codes (`OFFER_CHANGED`, `ILLEGAL_TRANSITION`, `APPROVAL_REQUIRED` …) |
| **Database portability** | Services depend on repository interfaces (`ports.ts`). Postgres adapters live in `infra/postgres/`. A MongoDB switch adds `infra/mongo/` per module; no cross-module joins or foreign keys exist to untangle |

### Several server instances: jobs and rate limits

Shared state lives in PostgreSQL only (no Redis), so any number of server instances can run on one database.

**Jobs** (`kernel/jobs/`). Every job in a module spec is a [pg-boss](https://github.com/timgit/pg-boss) queue of the same name (pg-boss keeps its tables in the `pgboss` schema and migrates them itself when it starts):

| Schedule phrase | Runs as |
|---|---|
| `every N min`, `hourly`, `every N hours` | pg-boss cron schedule (`*/N * * * *` …): one job per occurrence, whatever the number of instances |
| `daily` / `nightly HH:MM`, `weekly` (Monday), `monthly` (the 1st) | pg-boss cron schedule in `MARKET_TIME_ZONE` |
| `every N s` (and intervals cron can't express) | each working instance sends throttled: one job per N-second slot across instances |
| `on boot` | sent once per deploy: the job id comes from `DEPLOY_ID` plus the enabled modules and their versions |

A queue holds at most one waiting and one running job (policy `stately`), so a job never overlaps itself and missed ticks don't pile up. A failed run is retried 3 times with exponential backoff (30 s, doubling, at most 15 min); a run that takes over an hour counts as failed. `runNow` enqueues a run (not retried) and waits until whichever instance worked it is done; when a run is already waiting, it waits for that one.

| Variable | Default | Meaning |
|---|---|---|
| `JOBS_BACKEND` | `pgboss` with `DATABASE_URL`, else `inprocess` | `inprocess` runs timers in each process (development and tests on PGlite; every instance runs every job) |
| `JOBS_ENABLED` | `false` | This instance works the queues and keeps the schedules. Instances without it only enqueue (`runNow`), so web and worker instances can be split |
| `DEPLOY_ID` | - | The deployment (image tag, commit); `on boot` jobs run once per value and module set |

**Rate limits** (`kernel/auth/rate-limit.ts`). The middleware's limits ([03-auth-middleware.md §11](03-auth-middleware.md#11-rate-limits)) and modules' business limits (`ctx.rateLimit(key, { limit, windowMs, peek? })` → `{ allowed, retryAfterMs }`, e.g. coupon attempts in cart, gift card attempts in wallet) count in fixed windows aligned to the clock (an hour window runs :00 to :00), one row per scope (`http` or the module), key and window start in `kernel.rate_limits` (an unlogged table; one upsert per attempt). A refused attempt is not counted. The kernel job `kernel.purge-rate-limits` deletes ended windows every 10 minutes.

| Variable | Default | Meaning |
|---|---|---|
| `RATE_LIMIT_STORE` | `postgres` with `DATABASE_URL`, else `memory` | `memory` counts per process (development and tests) |
| `RATE_LIMITS` | `true` | Off only for contract and load tests (refused in production); modules' business limits apply either way |

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

## 7. Inside a module (planned layout)

Every module has the same shape, so any developer can find their way around any module.

```
src/modules/<module>/
  module.ts              Manifest: name, version, launch phase, dependencies, permissions, migrations, wiring
  contract.ts            The ONLY file other modules may import: public API interface, shared types, event payloads
  README.md              Generated from the module's API spec (docs/api/modules/<module>.md)
  domain/                Entities, status machines and pure business rules (no framework, no database)
  service.ts             Use cases; depends only on ports.ts, the event bus and the clock
  ports.ts               Repository interfaces (database-agnostic) and what this module needs from others
  infra/postgres/        Postgres repository + migrations (infra/mongo/ added only if the database changes)
  http/                  Routes per API area (store, seller, admin, public, webhooks) + request/response schemas
  graphql/               This module's schema fragment + resolvers (read-only; fields it owns, incl. fields on other modules' types)
  permissions.ts         Permission keys this module declares
  <module>.test.ts       Boots this module alone against an in-memory PostgreSQL
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
