# Marketly API design

Generated from `docs/api/spec/` by `node docs/api/tools/build.mjs`. 39 modules, 1,545 endpoints.

- **GraphQL read layer:** [graphql/README.md](graphql/README.md), composed schemas `graphql/schema.{store,seller,admin}.graphql`, screen queries in `graphql/operations/`
- **OpenAPI 3.1:** [openapi.json](openapi.json) (open in Swagger UI, Redoc or Postman)
- **Architecture:** [../02-backend-architecture.md](../02-backend-architecture.md)
- **Spec format:** [spec/FORMAT.md](spec/FORMAT.md)

## API areas

| Area | Prefix | Who | Auth | Endpoints |
|---|---|---|---|---|
| Store API | `/api/store/{module}` | Customers and guests on the website and the Android app | Every request carries a token: a visitor token (guests, issued when the app opens) or a customer access token. | 345 |
| Seller API | `/api/seller/{module}` | Seller owners and seller staff in Seller Center (website + Android app) | Seller member session. Every request acts for one seller account; seller member permissions apply. | 277 |
| Admin API | `/api/admin/{module}` | Internal staff in the Admin Center and Operations Center | Staff session. Role permissions and approval limits apply. | 893 |
| Public API | `/api/public/{module}` | Anyone (sign-in, registration, public settings) | Visitor token of any app. Refresh and sign-out take the refresh token; the bootstrap endpoint takes an app proof. | 21 |
| Webhooks | `/webhooks/{module}` | Payment, carrier and email providers | Provider signature header, verified per provider | 9 |

### Endpoints by auth kind

Every endpoint needs a token ([../03-auth-middleware.md](../03-auth-middleware.md) §0). The `account` endpoints live under `/api/store/identity` but take a signed-in token of any app, and every app's origin may call them.

| Area | Auth kind | Who | Endpoints |
|---|---|---|---|
| Store API | `visitor` | Any valid token of the app: a visitor token (before sign-in) or a signed-in access token | 89 |
| Store API | `shopper` | A store token that can hold a cart: visitor (guest) or customer | 103 |
| Store API | `customer` | Signed-in customer | 142 |
| Store API | `account` | Any signed-in account, any realm (self-service security endpoints) | 11 |
| Seller API | `seller` | Seller member acting for the seller in the token; optional `permission` narrows it | 277 |
| Admin API | `staff` | Staff member (email and password sign-in); optional `permission` narrows it | 893 |
| Public API | `visitor` | Any valid token of the app: a visitor token (before sign-in) or a signed-in access token | 18 |
| Public API | `refresh` | Refresh token only (website: the cookie of the app named by audience in the body; Android: refreshToken in the body) | 2 |
| Public API | `bootstrap` | No token: an app proof (Play Integrity or bot challenge). Only POST /api/public/identity/app-sessions | 1 |
| Webhooks | `provider` | Webhook signature, verified per provider | 9 |

## Platform

| Module | Phase | Owns | Depends on | Endpoints |
|---|---|---|---|---|
| [access](modules/access.md) | 1 | What staff may do and how much they may approve: staff roles, the permission registry, role assignments, leads and backups per work area, approval limits per role, approval requests with a second reviewer, and cover while someone is away. Granting access never grants financial authority. | identity | 33 |
| [audit](modules/audit.md) | 1 | The tamper-evident action history: who did what, in which role, to which record, why, what changed (before and after), which approvals applied and the request id. Every module writes to it through record(); staff read it with filters and authorized exports; retention is a governed setting. | - | 11 |
| [backups](modules/backups.md) | 1 | Backups of the whole system (database, uploaded files, settings and keys) from the Admin Center: the list of backups on the server, a backup now, downloads, uploads and restores with two-person approval. The server's root backup service (deploy/linux ops.sh) does the work; this module asks it through request files and reports what it did. | access, identity | 10 |
| [identity](modules/identity.md) | 1 | Who someone is and how they prove it: accounts for customers, seller members and staff, credentials, email verification, sessions and refresh tokens for the website and the Android app, password recovery, 2-step verification, signed-in devices, guest sessions and the security activity log. | - | 46 |
| [media](modules/media.md) | 1 | Every uploaded or generated file: images, video and documents. Uploads and signed download links, scanning and processing, renditions, alt text, ownership (seller, staff, customer, platform), image standard checks, where each file is used, and the rules for deleting, removing and retaining files (files in use or kept as evidence cannot be deleted). | - | 32 |
| [notifications](modules/notifications.md) | 1 | Who is told what, on which channel: notification topics for customers, sellers and staff, routing from platform events to recipients (staff by role, with backups), templates with versions and preview, in-app inboxes for the store, Seller Center and Admin Center, email delivery with retries and suppression, seller and staff channel preferences, promotional broadcasts under consent, and Android push devices (phase 3). | identity | 56 |
| [reports](modules/reports.md) | 1 | Business reporting with stated meanings: metric definitions with a named owner and versions, a report catalogue grouped by business area, report queries with an explicit date basis, currency and time zone, the admin and seller dashboards, and authorized export jobs. All figures come from read models fed by other modules' events, never from their tables. | - | 33 |
| [settings](modules/settings.md) | 1 | Market-level platform settings: country and service region, currency, time zone, business hours, support contacts, guest checkout, Android app versions and feature flags, plus the effective-dated change process (impact preview, approval, schedule, apply) for every runtime setting a module declares. It also assembles the Admin Center settings page from sections owned by other modules. | access | 17 |
| [workqueues](modules/workqueues.md) | 1 | The Operations Center's shared to-do system: queue definitions with an owner role, a named lead, a backup and an escalation route, and work items raised from other modules' events (overdue dispatch, low stock, waiting approvals, cases past target, failed payouts, mismatches) with deadlines, assignment and automatic escalation. Also the My work queues view, the dashboard's needs-attention tiles, the day-end review, the daily routine and saved filters. | access | 36 |

## Participants

| Module | Phase | Owns | Depends on | Endpoints |
|---|---|---|---|---|
| [customers](modules/customers.md) | 1 | The customer side of an account: profile, saved addresses, marketing consent, recently viewed products, the Account tab overview, guest order access, data export and account closure, and the staff view of customer accounts with notes and recorded account actions. Credentials, sessions and verification belong to identity. | identity | 33 |
| [sellers](modules/sellers.md) | 1 | Seller admission and the seller account: the Sell with us programme and multi-step application, verification checks and review decisions, seller statuses with account status, product approval and payout readiness kept separate, setup and launch readiness, storefront profile and public storefront, seller members and permissions, performance against targets, warnings, restrictions, suspensions and appeals. | identity, access, media | 91 |

## Catalog and stock

| Module | Phase | Owns | Depends on | Endpoints |
|---|---|---|---|---|
| [catalog](modules/catalog.md) | 1 | What a product is: categories, attributes, brands, products, variants, and the review workflow that decides whether a product may be sold. How a seller sells it (price, stock, condition) belongs to offers. | media | 47 |
| [inventory](modules/inventory.md) | 1 | How many units exist and in which stock group: stock items per offer/SKU with Available, Reserved, Incoming, Damaged or held and Returned quantities per location, checkout holds and order allocations, an append-only movement ledger, reasoned adjustments with second review, low-stock alerts, receipt confirmation and return stock outcomes. | - | 40 |
| [offers](modules/offers.md) | 1 | How one seller (or the Official Store) sells one variant in one condition: price and authentic was-price, purchase limit, seller SKU, dispatch, shipping profile, return and warranty terms, offer status, and the published featured-offer rule that picks the main offer for a delivery location. | catalog, sellers, inventory | 52 |
| [purchasing](modules/purchasing.md) | 1 | Buying stock for the Official Store: suppliers and their price lists, purchase orders (Draft, Sent, Partly received, Received, Cancelled) with buying costs and expected deliveries, receiving records (expected vs received, shortages, damage) that feed inventory, and supplier claims. | inventory | 31 |
| [search](modules/search.md) | 1 | Finding products: a product index built from catalog, offers, inventory and reviews events; search with misspelling tolerance and corrections, suggestions (queries, categories, brands, stores, products, recent searches), universal and category filters with counts, sorting, sponsored slots from advertising, and guidance for empty or unavailable results. | catalog, offers | 24 |
| [warehouse](modules/warehouse.md) | 1 | Physical work for Official Store stock: bins, put-away of received goods, pick waves and pick lists by order with bin locations and scanning, packing stations (item checklist, box and weight, carrier label through shipping, packing slip), shortage and damage reports, and receipt of return parcels handed over to returns inspection. | inventory, orders | 34 |

## Buying

| Module | Phase | Owns | Depends on | Endpoints |
|---|---|---|---|---|
| [cart](modules/cart.md) | 1 | One cart across the Official Store and marketplace sellers for customers and guests. Every line is bound to the exact offer the customer chose, lines are grouped into seller packages with delivery estimates and shipping, and every read re-checks price, stock and eligibility so changes are explained per item instead of discarding the cart. | offers, inventory | 18 |
| [checkout](modules/checkout.md) | 1 | Turns a cart (or a Buy now offer) into an accepted order: identify the customer or guest, choose an address with a per-item shippability check, pick delivery options per package, apply coupons or credit with reasons and item coverage, choose payment, review sellers, return terms and totals, revalidate into a change set the customer must accept, and place the order idempotently with clear payment results. | cart, orders, payments, shipping, customers, offers, inventory | 20 |
| [orders](modules/orders.md) | 1 | The accepted purchase: one order per checkout, one seller group per seller package, and items with their own state (Confirmed, Preparing, Delayed, Shipped, Delivered, cancellation, return, refund). Keeps frozen purchase snapshots, derives the overall status from the items, tracks payment, delivery and returns progress separately, and runs item-level cancellations, seller fulfillment tasks with dispatch deadlines, timelines and purchase documents. | catalog, offers | 37 |
| [payments](modules/payments.md) | 1 | Charging customers through provider adapters (card, digital wallet): payment intents per checkout attempt, authorization and capture per order and seller group, declines with retry, uncertain results resolved by a status-check job, refund execution (Requested → Processing → Sent / Failed) capped at the remaining refundable amount, chargebacks and payment disputes, saved payment methods and provider webhooks. | orders | 32 |
| [shipping](modules/shipping.md) | 1 | How things get delivered: carriers and services, destinations and excluded areas, shipping profiles with rates (Official Store and sellers), free-shipping rules, dispatch targets and cutoffs, the holiday and service-interruption calendar, delivery estimates for a location, shipments with contents and tracking, labels where supported, partial shipments, and delivery exceptions with their required responses and carrier claims. | orders | 73 |

## After-sales and money

| Module | Phase | Owns | Depends on | Endpoints |
|---|---|---|---|---|
| [finance](modules/finance.md) | 1 | Seller money and company money kept apart: the seller ledger (proceeds, pending, available, held, negative and amounts owed), fee rules, holds, adjustments, payout runs and payouts, statements, payout-destination verification, daily reconciliation checks, and company trading margins separate from marketplace fee income. | orders, payments, sellers, access | 58 |
| [messaging](modules/messaging.md) | 1 | Private service conversations linked to an order, item, return or case: customer with seller (or the Official Store), which Marketly support can join from a case, with attachments, read state, seller reply targets and overdue flags, and staff moderation. No promotional messages. | orders | 30 |
| [returns](modules/returns.md) | 1 | Return policies (platform baseline, seller terms, category exceptions, who pays return shipping), per-item eligibility, return requests and decisions, return shipments, receipt and inspection, remedies (refund, replacement, exchange) and the refund request that Finance approves before payments sends the money. | orders, shipping, payments, inventory | 62 |
| [reviews](modules/reviews.md) | 1 | Product reviews (Verified Purchase), seller feedback kept separate from product reviews, public seller responses under rules, product questions and answers labelled by who answered, reports of inappropriate content, moderation with outcomes visible to reporter and author, appeals, and rating summaries for products and sellers. | orders, catalog, sellers | 51 |
| [support](modules/support.md) | 1 | Help cases and disputes: customer help and order-problem cases opened from the order with items pre-identified, seller support requests to Marketly, disputes between customer and seller with evidence, decision, remedy and appeal, plus categories, priority, owner, SLA deadlines, assignment, escalation and resolve/reopen rules. | orders, access | 39 |
| [trust](modules/trust.md) | 1 | Trust and Risk's case file: reports of counterfeit goods, suspicious orders, fake reviews and abuse from customers, sellers, staff, brand owners and automated signals, with evidence, a risk score, an investigation workflow, enforcement recommendations routed to the team that owns the action, recorded enforcement with reasons, and appeals decided by someone other than the original decider. Trust recommends; Catalog, Seller Manager, Support, Finance and the other owners act. | access | 47 |

## Growth

| Module | Phase | Owns | Depends on | Endpoints |
|---|---|---|---|---|
| [advertising](modules/advertising.md) | 1 | Ad placements and their rules, ad campaigns through the full lifecycle, creatives and their review, audiences, schedules, frequency caps and dismissal suppression, rotation and priority, the serving decision for each page view, display/click/dismissal tracking with attribution, and seller sponsored campaigns with spending limits and ad charges kept separate from commission. | media, access | 49 |
| [content](modules/content.md) | 1 | Store content managed by the Content Manager: ordered and scheduled homepage sections, campaign pages and curated collections, Help Center articles and categories, news posts and their categories, policies with versions and effective dates, the About page and footer links. Every item has an owner, a preview, a publication status and schedule, a version history with restore, and a correction or removal action. | media, access | 90 |
| [departments](modules/departments.md) | 2 | The app's department pages opened from the home Departments rail: the Phones picks, Blogs (topics, staff authors, posts, reactions, replies and reports), the Companies directory (industries, company pages, inquiries) and the Play center (games and ranking tables). Staff manage all of it in Admin › Departments. | media | 58 |
| [food](modules/food.md) | 2 | The app's Food delivery department: restaurants staff keep in Admin › Departments › Food delivery, their menus with sizes and extras, a basket that holds one restaurant's food, and food orders paid by card in their own payment flow (payments purchase intents, not cart and checkout). Staff move each order through accepted, preparing, on the way and delivered on the restaurant's behalf; the card is charged on delivery. | media, payments, customers | 38 |
| [promotions](modules/promotions.md) | 1 | Discounts and sales campaigns: markdowns, percentage and fixed coupons, minimum-spend and free-shipping offers, flash sales, seller discounts and platform campaigns with seller consent. Owns eligibility, stacking, budgets and caps, the funding owner of every discount, coupon clipping and redemption, the Deals page data and campaign results. | catalog, offers | 55 |
| [rewards](modules/rewards.md) | 2 | The app's Daily rewards department: customers check in every day for points (a 7-day streak with a bonus on day 7), earn points for daily tasks, and swap points for coupons. Staff set the check-in schedule, the tasks and the reward catalogue in Admin › Departments › Daily rewards, and can adjust a customer's points. Each coupon is a single-use code of a promotions coupon campaign given to the customer. | promotions | 21 |
| [services](modules/services.md) | 2 | Services customers request or book in the app's department pages: OS installs and post-sale repairs (Phones), welfare services and time-slot bookings. Staff keep the providers, their services and opening hours, and handle every request in Admin › Departments. No online payment at this phase: customers pay the provider. | media | 31 |
| [software](modules/software.md) | 2 | The app's Softwares department: apps for phones and PCs that customers download. Staff keep the categories, apps, files, packs and the home rails in Admin › Departments › Softwares. Free apps are owned on Get; paid apps and packs are bought with a card in their own payment flow (payments purchase intents, not cart and checkout), and owners download the files through signed links. | media, payments | 35 |

## Later phases

| Module | Phase | Owns | Depends on | Endpoints |
|---|---|---|---|---|
| [fulfillment-service](modules/fulfillment-service.md) | 4 | Platform storage and shipping for sellers: seller enrollment under service terms, SKU enrollment, inbound shipments to our warehouse, receiving into seller-owned stock, picking and shipping by us while the seller stays the seller of record, returns handling, removal of stock, and storage and handling fees with full seller visibility. | inventory, warehouse, finance | 41 |
| [wallet](modules/wallet.md) | 3 | Customer store credit with an auditable ledger (refunds to credit, goodwill credit within approval limits, price adjustments, use at checkout, expiry), gift cards, and a placeholder for loyalty rewards. Checkout and payments use the balance through the in-process public API. | customers, payments | 15 |
| [wishlist](modules/wishlist.md) | 3 | Saved shopping for customers: saved items in one or more lists, price-drop and back-in-stock alerts, and shareable lists. Alerts are delivered through notifications under the customer's promotional preferences. | catalog, offers, customers | 19 |

## Dependency layers

Each module needs only modules in earlier layers (required dependencies; optional ones are listed on each module page).

| Layer | Modules |
|---|---|
| 0 | [audit](modules/audit.md), [identity](modules/identity.md), [inventory](modules/inventory.md), [media](modules/media.md), [reports](modules/reports.md) |
| 1 | [access](modules/access.md), [catalog](modules/catalog.md), [customers](modules/customers.md), [departments](modules/departments.md), [notifications](modules/notifications.md), [purchasing](modules/purchasing.md), [services](modules/services.md) |
| 2 | [advertising](modules/advertising.md), [backups](modules/backups.md), [content](modules/content.md), [sellers](modules/sellers.md), [settings](modules/settings.md), [trust](modules/trust.md), [workqueues](modules/workqueues.md) |
| 3 | [offers](modules/offers.md) |
| 4 | [cart](modules/cart.md), [orders](modules/orders.md), [promotions](modules/promotions.md), [search](modules/search.md), [wishlist](modules/wishlist.md) |
| 5 | [messaging](modules/messaging.md), [payments](modules/payments.md), [reviews](modules/reviews.md), [rewards](modules/rewards.md), [shipping](modules/shipping.md), [support](modules/support.md), [warehouse](modules/warehouse.md) |
| 6 | [checkout](modules/checkout.md), [finance](modules/finance.md), [food](modules/food.md), [returns](modules/returns.md), [software](modules/software.md), [wallet](modules/wallet.md) |
| 7 | [fulfillment-service](modules/fulfillment-service.md) |

## Errors

Every REST error is `{ "error": { "code", "message", "details"? } }` with the status below. Module codes are listed on each module page.

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Fields are missing or invalid. details.issues lists each field. |
| `UNAUTHORIZED` | 401 | No token, or the token is invalid, expired or revoked (details.reason token_*), or this session can't use the endpoint (details.reason, e.g. sign_in_required, session_idle). Refresh only when details.reason starts with token_. |
| `FORBIDDEN` | 403 | Signed in, but the role or seller permission does not allow this. details.permission names it; other refusals give details.reason. |
| `NOT_FOUND` | 404 | The record does not exist or is not visible to this caller. |
| `ILLEGAL_TRANSITION` | 409 | The status does not allow this action (e.g. approving a rejected product). details.from, details.event. |
| `APPROVAL_REQUIRED` | 409 | Above the caller's limit or needs a second reviewer, and nothing was saved (the action cannot be recorded until it is approved). details.approvalRequestId tracks it. When the module saves the record pending approval it answers its normal success status instead, with `approval` (ApprovalInfo) in the body (FORMAT.md, Approval responses). |
| `CONFLICT` | 409 | Concurrent change; reload and retry. |
| `IDEMPOTENCY_KEY_REUSED` | 422 | The Idempotency-Key was used with a different request (path, query or body). |
| `RATE_LIMITED` | 429 | Too many requests; retry after the Retry-After header (seconds, also in details.retryAfterSeconds). |
| `NOT_IMPLEMENTED` | 501 | Designed but not built yet, or planned for a later launch phase (details.reason not_built or later_phase). |
| `INTERNAL_ERROR` | 500 | Something went wrong on the server, or a response did not match the spec. Include the X-Request-Id when reporting it. |
| `RANGE_NOT_SATISFIABLE` | 416 | File downloads (GET /files/…): the requested Range is outside the file. details.sizeBytes. |
| `WRONG_AUDIENCE` | 403 | The token is for another app (store, Seller Center or Admin Center). |
| `STEP_UP_REQUIRED` | 403 | A fresh proof is needed: a re-auth token for this purpose in the body (reauthToken, from the app's re-auth endpoint). details.kind (reauth), details.purpose. |
| `OWNER_ONLY` | 403 | Only the seller owner can do this. |
| `NO_SELLER_ACCESS` | 403 | This account cannot act for that seller (or for any seller). |
| `UPGRADE_REQUIRED` | 426 | This Android app version is no longer supported; update the app. details.minVersionCode, details.updateUrl. |
| `SERVICE_UNAVAILABLE` | 503 | A service needed to authorize the request is unavailable; retry later. |

Sign-in and session codes from [identity](modules/identity.md) that every app meets:

| Code | Status | Meaning |
|---|---|---|
| `APP_PROOF_INVALID` | 401 | The app proof (Play Integrity or bot challenge) is missing or failed. |
| `REFRESH_TOKEN_INVALID` | 401 | Refresh token unknown, expired, revoked or reused; sign in again. |
| `ACCOUNT_LOCKED` | 423 | Sign-in is paused. details.lockedUntil (null = until staff unlock) and details.cause. |
| `ACCOUNT_DISABLED` | 403 | The account is disabled or closed. |

Requests the server can't read keep their HTTP status with code `VALIDATION_FAILED` and no `details`: 400 (unreadable JSON), 413 (a JSON body over 2 MB) and 415 (an unsupported content type).

GraphQL answers `{ data, errors }` with `errors[].extensions.code` instead of the `{ error }` envelope, and has four codes of its own: `QUERY_TOO_COMPLEX`, `QUERY_TIMEOUT`, `PERSISTED_QUERY_NOT_FOUND` and `PERSISTED_QUERY_NOT_SUPPORTED`. See [graphql/README.md](graphql/README.md#errors).

### Refusal details

| Code | `details` |
|---|---|
| `VALIDATION_FAILED` | `issues: [{ path, message }]`, the path naming the part and field (`body.email`, `querystring.limit`) |
| `UNAUTHORIZED` | `reason`: `token_missing`, `token_expired`, `token_revoked`, `token_malformed`, `token_bad_signature`, `token_unknown_key`, `token_wrong_type`, `token_wrong_issuer`, `token_not_yet_valid`, `token_invalid` (refresh token); `sign_in_required`, `seller_context_required`, `session_idle`; `signature_invalid`, `signature_expired` (webhooks); `link_missing`, `link_invalid` (file links) |
| `FORBIDDEN` | `permission` for a missing permission; otherwise `reason`: `origin_not_allowed`, `x_requested_with_required` (cookie refresh and sign-out), `link_expired` (file links) |
| `WRONG_AUDIENCE` | `tokenAudience`, `area` |
| `STEP_UP_REQUIRED` | `kind` (`reauth`), `purpose` |
| `ILLEGAL_TRANSITION` | `machine`, `from`, `event`, `allowed` |
| `APPROVAL_REQUIRED` | `approvalRequestId` |
| `RATE_LIMITED` | `retryAfterSeconds` (also the `Retry-After` header) |
| `UPGRADE_REQUIRED` | `minVersionCode`, `updateUrl` |
| `NOT_IMPLEMENTED` | `operation`, `reason` (`not_built`, `later_phase`), `phase` |
| `SERVICE_UNAVAILABLE` | `reason`: `sessions_unavailable`, `revocations_stale`, `revocations_unavailable` (admin requests); none when an app proof can't be checked |
| `ACCOUNT_LOCKED` | `lockedUntil` (null = until staff unlock), `cause` |

## Headers

| Header | Use |
|---|---|
| `Authorization` | Bearer <token> on every request: visitor token before sign-in, access token after (customer, seller member or staff) |
| `Idempotency-Key` | Required on endpoints marked idempotent (orders, payments, refunds, payouts). Same key + same request returns the first result (with Idempotent-Replayed: true). |
| `Accept-Language` | Ignored: every response is en-US (the only locale at launch) |
| `X-Request-Id` | Optional. A value of 1–100 letters, digits, _ or - becomes the request id; otherwise the server makes one. Every response carries it; include it when reporting problems |
| `X-App-Proof` | Bootstrap only: turnstile:<token> (website bot challenge) or play:<token> (Android Play Integrity); dev in development and tests |
| `X-Client` | web, android/<versionCode> or android/<versionName>+<versionCode> (e.g. android/1.4.2+142): analytics and the minimum-version check (426) only, never trusted for authorization |
| `X-Requested-With` | Any value. Required with the website's refresh cookie on refresh and sign-out, together with an allowed Origin (else 403) |

Response headers: `X-Request-Id` (always), `Retry-After` (429), `Idempotent-Replayed: true` (a replayed idempotent request), `WWW-Authenticate` (401 `UNAUTHORIZED`: `Bearer error="invalid_token"` for a bad token, plain `Bearer` otherwise). Browsers can read all four across origins.

## Client rules

The full design is [../03-auth-middleware.md](../03-auth-middleware.md); these are the rules an app needs.

### Responses and URLs

- Success uses the status the endpoint declares (200, 201, 202). An endpoint without a response body answers 204, or 202 where it says so, with an empty body.
- Trailing slashes are ignored: `/api/store/cart/` is `/api/store/cart`.
- `Accept-Language` is ignored; texts are en-US.
- Every `/api`, `/graphql` and `/webhooks` response is `Cache-Control: private, no-store`.

### Paging

List endpoints take `cursor` (the Android app's infinite scroll) or `page` (the website's numbered pages), never both, and `limit` (1–100, default 24). The answer is `{ items, nextCursor, page?, totalPages?, total? }`; `nextCursor` is null at the end. Both `cursor` and `page`, a `limit` out of range, or a cursor the server can't read → 400 `VALIDATION_FAILED`. (GraphQL clamps the limit instead.)

### Idempotency

Endpoints marked idempotent need `Idempotency-Key` (1–255 characters; missing → 400 `VALIDATION_FAILED`). Keys are kept 24 hours per operation and caller. The same key with the same request (path parameters, query and body) answers the first response again, same status and body, with `Idempotent-Replayed: true`; with a different request → 422 `IDEMPOTENCY_KEY_REUSED`; while the first request still runs → 409 `CONFLICT`. When the handler fails, the key is freed and a retry runs again. A refused step-up proof frees the key too, so the retry with a fresh proof reuses it. Use one key per user action and reuse it on retries.

### Step-up

Endpoints with a step-up need a fresh proof: `reauthToken` in the body, from identity's re-auth endpoint of the app (the password; members may use a 2-step code instead). Staff confirm with their password (`POST /api/admin/identity/reauth`); they have no 2-step. A missing or refused proof → 403 `STEP_UP_REQUIRED` with `details.kind` and `details.purpose`, never 400. A re-auth token works once: it is claimed before the request runs and given back if the request fails, so the person can retry without confirming again. A replayed idempotent request does not spend it.

### Sessions

- **Start:** `POST /api/public/identity/app-sessions` with `X-App-Proof` returns a visitor access token (15 minutes) and a refresh token. Signing in claims the visitor session.
- **Where the refresh token lives:** the website gets it in its own app's cookie, `__Secure-mk_refresh_store`, `__Secure-mk_refresh_seller` or `__Secure-mk_refresh_admin` (HttpOnly; Secure; SameSite=Strict; Path=/api/public/identity/sessions), and `refreshToken` is `""` in the body; Android gets it in the body. With one cookie per app, signing into Seller Center or Admin Center doesn't end the store session in the same browser.
- **Refresh** `POST /api/public/identity/sessions/refresh`, **sign out** `POST /api/public/identity/sessions/sign-out` (204). The website names its app in the body, `{ "audience": "store" }` (or `seller`, `admin`); the server reads that app's cookie first, then `refreshToken` in the body. Without `audience` no cookie is read (401 `token_missing`). Sign-out clears only that app's cookie. With the cookie, the request needs an allowed `Origin` and `X-Requested-With`, else 403. At most 30 refreshes an hour per session. Each refresh returns a new pair; the previous token sent again within 20 s returns the same new pair (two tabs refreshing at once), and later it ends the session.
- **Refused:** no refresh token → 401 `token_missing`; an unknown, expired, revoked or reused one → 401 `token_invalid` (sign-out with such a token too), as is an app's cookie holding another app's session. Refresh can also answer `REFRESH_TOKEN_INVALID`, `ACCOUNT_DISABLED` or `ACCOUNT_LOCKED`. In every case, sign in again.
- **When to refresh:** only on 401 `UNAUTHORIZED` whose `details.reason` starts with `token_`. Never on `session_idle` (sign in again), other 401 reasons, `FORBIDDEN`, `WRONG_AUDIENCE` or a GraphQL field refusal.

### Browsers (CORS)

Each area allows its own app's origins (`CORS_STORE_ORIGINS`, `CORS_SELLER_ORIGINS`, `CORS_ADMIN_ORIGINS`); public endpoints, file links and the `account` endpoints allow every app's. Credentials (`Access-Control-Allow-Credentials: true`) are allowed only on the routes that set, clear or read the refresh cookie: refresh and sign-out, `POST /api/public/identity/app-sessions`, `/sessions`, `/sign-in-challenges/{id}/verify`, `/external-sign-ins`, `/verifications/{id}/confirm`, `/invitations/accept`, and `POST /api/seller/identity/session/seller-context`.

### For frontend developers

1. Start an app session once, keep the access token in memory, and send `Authorization: Bearer` on every request, GraphQL included. Send `X-Client` (`web`, or `android/<versionName>+<versionCode>`).
2. Website: call the cookie routes above with `credentials: 'include'`, and on refresh and sign-out add `X-Requested-With` (any value) and a JSON body naming the app, `{ "audience": "store" }` (`seller`, `admin`).
3. Refresh one request at a time, only on 401 with `details.reason` `token_*`, then retry the request once. If the refresh itself is refused, sign in again (visitors: start a new app session).
4. 426 `UPGRADE_REQUIRED`: show the update screen (`details.updateUrl`). 429: wait `Retry-After` seconds. 503: retry with backoff.
5. Send one `Idempotency-Key` per user action on idempotent endpoints, the same on every retry.
6. Show or log the `X-Request-Id` of a failed response when reporting a problem.

## Live notifications (Server-Sent Events)

Seller Center and Admin Center receive new inbox notices as they happen: `GET /api/seller/notifications/stream` and `GET /api/admin/notifications/stream`. Each answers `text/event-stream` (UTF-8) and stays open. Customers have no stream (the Android app polls the inbox).

**Request.** `Authorization: Bearer <access token>` like every call: read the stream with `fetch` and a reader (not `EventSource`, which cannot send the header; never put a token in the URL). Optional `Last-Event-ID: <notice id>`, the id of the last notice received. Refusals (401, 403, 503) come before the stream opens, as normal JSON errors.

**Wire format.**

```
retry: 5000

id: <noticeId>          catch-up notices first, then live ones
event: notice
data: <Notice JSON>     exactly one item of GET …/notifications/inbox for this caller

event: ready
data: {"at":"<ISO time>","caughtUp":<int>}

: ping                  a comment every 25 s (keeps proxies and firewalls from closing the line)

event: end
data: {"reason":"signed_out" | "session_idle" | "restart" | "max_age"}
```

- **Catch-up:** with `Last-Event-ID`, the inbox notices created after that notice, only from the last 15 minutes, at most 20, oldest first, then `ready`. An unknown id, or no header: just `ready`.
- **Who gets a notice:** exactly who sees it in GET /inbox. Staff: the notices routed to them (role, backup, direct), with their own `routedTo`. Sellers: workspace notices whose topic the member receives, and notices addressed to the member. A notice is sent only after it is saved.
- **`end`**, after which the server closes the response: `signed_out` (session or account revoked, or the staff session expired: stop; the next normal request leads to sign-in), `session_idle` (the staff session went idle: stop), `restart` (the server is shutting down: reconnect after `retry`), `max_age` (seller streams end after 60 minutes so permissions are read again: reconnect at once). Staff streams have no maximum age.
- **Staff activity:** an open stream is not activity. The connect request counts once, like any request; after that the server re-checks the session at every heartbeat without touching it, so the idle sign-out (identity setting `staffIdleMinutes`) still applies.

**Client rules.**

1. One stream per browser per app: the tab holding the Web Lock `marketly-live:<audience>` (`navigator.locks.request`) opens the stream and relays every event to the other tabs over `BroadcastChannel('marketly-live:<audience>')`; when it closes, another tab takes the lock. Without Web Locks every tab opens its own stream.
2. When the connection drops (without `end`), reconnect with backoff 1 s, 2 s, 5 s, 10 s, then every 30 s, plus up to 1 s of jitter, sending `Last-Event-ID` = the last notice id.
3. Tokens: Seller Center may refresh the session as usual before connecting. Admin Center must never refresh just for the stream (a refresh is staff activity and would defeat the idle sign-out): it uses the current access token while it is valid; once it has expired, it waits (checking every 30 s) until normal app activity has refreshed it, then reconnects.
4. On `ready` and on every `notice`, refetch the inbox and its counts (the bell).

## Constants

Reserved values every module may use (exported from `backend/src/spec/common.ts`).

| Name | Value | Meaning |
|---|---|---|
| `OFFICIAL_STORE_ID` | `"00000000-0000-7000-8000-000000000001"` | Seller id of the Official Store, used wherever a seller id is required (feedback, reviews, returns terms, conversations, report facts, promotion lines). The sellers module never issues it. |
| `OFFICIAL_STORE_NAME` | `"Marketly Official Store"` | Display name of the Official Store wherever a seller name is shown (cart, checkout, orders, conversations, reviews, returns, notices). Use this constant instead of writing the label. |
