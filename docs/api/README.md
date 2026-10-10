# Marketly API design

Generated from `docs/api/spec/` by `node docs/api/tools/build.mjs`. 33 modules, 1292 endpoints.

- **GraphQL read layer:** [graphql/README.md](graphql/README.md), composed schemas `graphql/schema.{store,seller,admin}.graphql`, screen queries in `graphql/operations/`
- **OpenAPI 3.1:** [openapi.json](openapi.json) (open in Swagger UI, Redoc or Postman)
- **Architecture:** [../02-backend-architecture.md](../02-backend-architecture.md)
- **Spec format:** [spec/FORMAT.md](spec/FORMAT.md)

## API areas

| Area | Prefix | Who | Auth |
|---|---|---|---|
| Store API | `/api/store/{module}` | Customers and guests on the website and the Android app | Every request carries a token: a visitor token (guests, issued when the app opens) or a customer access token. |
| Seller API | `/api/seller/{module}` | Seller owners and seller staff in Seller Center (website + Android app) | Seller member session. Every request acts for one seller account; seller member permissions apply. |
| Admin API | `/api/admin/{module}` | Internal staff in the Admin Center and Operations Center | Staff session. Role permissions and approval limits apply. |
| Public API | `/api/public/{module}` | Anyone (sign-in, registration, public settings) | Visitor token of any app. Refresh and sign-out take the refresh token; the bootstrap endpoint takes an app proof. |
| Webhooks | `/webhooks/{module}` | Payment, carrier and email providers | Provider signature header, verified per provider |

## Platform

| Module | Phase | Owns | Depends on | Endpoints |
|---|---|---|---|---|
| [access](modules/access.md) | 1 | What staff may do and how much they may approve: staff roles, the permission registry, role assignments, leads and backups per work area, approval limits per role, approval requests with a second reviewer, and cover while someone is away. Granting access never grants financial authority. | identity | 33 |
| [audit](modules/audit.md) | 1 | The tamper-evident action history: who did what, in which role, to which record, why, what changed (before and after), which approvals applied and the request id. Every module writes to it through record(); staff read it with filters and authorized exports; retention is a governed setting. | - | 11 |
| [identity](modules/identity.md) | 1 | Who someone is and how they prove it: accounts for customers, seller members and staff, credentials, email verification, sessions and refresh tokens for the website and the Android app, password recovery, 2-step verification, signed-in devices, guest sessions and the security activity log. | - | 47 |
| [media](modules/media.md) | 1 | Every uploaded or generated file: images, video and documents. Uploads and signed download links, scanning and processing, renditions, alt text, ownership (seller, staff, customer, platform), image standard checks, where each file is used, and the rules for deleting, removing and retaining files (files in use or kept as evidence cannot be deleted). | - | 29 |
| [notifications](modules/notifications.md) | 1 | Who is told what, on which channel: notification topics for customers, sellers and staff, routing from platform events to recipients (staff by role, with backups), templates with versions and preview, in-app inboxes for the store, Seller Center and Admin Center, email delivery with retries and suppression, seller and staff channel preferences, promotional broadcasts under consent, and Android push devices (phase 3). | identity | 45 |
| [reports](modules/reports.md) | 1 | Business reporting with stated meanings: metric definitions with a named owner and versions, a report catalogue grouped by business area, report queries with an explicit date basis, currency and time zone, the admin and seller dashboards, and authorized export jobs. All figures come from read models fed by other modules' events, never from their tables. | - | 33 |
| [settings](modules/settings.md) | 1 | Market-level platform settings: country and service region, currency, time zone, business hours, support contacts, guest checkout, Android app versions and feature flags, plus the effective-dated change process (impact preview, approval, schedule, apply) for every runtime setting a module declares. It also assembles the Admin Center settings page from sections owned by other modules. | access | 16 |
| [workqueues](modules/workqueues.md) | 1 | The Operations Center's shared to-do system: queue definitions with an owner role, a named lead, a backup and an escalation route, and work items raised from other modules' events (overdue dispatch, low stock, waiting approvals, cases past target, failed payouts, mismatches) with deadlines, assignment and automatic escalation. Also the My work queues view, the dashboard's needs-attention tiles, the day-end review, the daily routine and saved filters. | access | 36 |

## Participants

| Module | Phase | Owns | Depends on | Endpoints |
|---|---|---|---|---|
| [customers](modules/customers.md) | 1 | The customer side of an account: profile, saved addresses, marketing consent, recently viewed products, the Account tab overview, guest order access, data export and account closure, and the staff view of customer accounts with notes and recorded account actions. Credentials, sessions and verification belong to identity. | identity | 33 |
| [sellers](modules/sellers.md) | 1 | Seller admission and the seller account: the Sell with us programme and multi-step application, verification checks and review decisions, seller statuses with account status, product approval and payout readiness kept separate, setup and launch readiness, storefront profile and public storefront, seller members and permissions, performance against targets, warnings, restrictions, suspensions and appeals. | identity, access, media | 90 |

## Catalog and stock

| Module | Phase | Owns | Depends on | Endpoints |
|---|---|---|---|---|
| [catalog](modules/catalog.md) | 1 | What a product is: categories, attributes, brands, products, variants, and the review workflow that decides whether a product may be sold. How a seller sells it (price, stock, condition) belongs to offers. | media | 44 |
| [inventory](modules/inventory.md) | 1 | How many units exist and in which stock group: stock items per offer/SKU with Available, Reserved, Incoming, Damaged or held and Returned quantities per location, checkout holds and order allocations, an append-only movement ledger, reasoned adjustments with second review, low-stock alerts, receipt confirmation and return stock outcomes. | - | 40 |
| [offers](modules/offers.md) | 1 | How one seller (or the Official Store) sells one variant in one condition: price and authentic was-price, purchase limit, seller SKU, dispatch, shipping profile, return and warranty terms, offer status, and the published featured-offer rule that picks the main offer for a delivery location. | catalog, sellers, inventory | 49 |
| [purchasing](modules/purchasing.md) | 1 | Buying stock for the Official Store: suppliers and their price lists, purchase orders (Draft, Sent, Partly received, Received, Cancelled) with buying costs and expected deliveries, receiving records (expected vs received, shortages, damage) that feed inventory, and supplier claims. | inventory | 31 |
| [search](modules/search.md) | 1 | Finding products: a product index built from catalog, offers, inventory and reviews events; search with misspelling tolerance and corrections, suggestions (queries, categories, brands, stores, products, recent searches), universal and category filters with counts, sorting, sponsored slots from advertising, and guidance for empty or unavailable results. | catalog, offers | 23 |
| [warehouse](modules/warehouse.md) | 1 | Physical work for Official Store stock: bins, put-away of received goods, pick waves and pick lists by order with bin locations and scanning, packing stations (item checklist, box and weight, carrier label through shipping, packing slip), shortage and damage reports, and receipt of return parcels handed over to returns inspection. | inventory, orders | 33 |

## Buying

| Module | Phase | Owns | Depends on | Endpoints |
|---|---|---|---|---|
| [cart](modules/cart.md) | 1 | One cart across the Official Store and marketplace sellers for customers and guests. Every line is bound to the exact offer the customer chose, lines are grouped into seller packages with delivery estimates and shipping, and every read re-checks price, stock and eligibility so changes are explained per item instead of discarding the cart. | offers, inventory | 18 |
| [checkout](modules/checkout.md) | 1 | Turns a cart (or a Buy now offer) into an accepted order: identify the customer or guest, choose an address with a per-item shippability check, pick delivery options per package, apply coupons or credit with reasons and item coverage, choose payment, review sellers, return terms and totals, revalidate into a change set the customer must accept, and place the order idempotently with clear payment results. | cart, orders, payments, shipping, customers, offers, inventory | 20 |
| [orders](modules/orders.md) | 1 | The accepted purchase: one order per checkout, one seller group per seller package, and items with their own state (Confirmed, Preparing, Delayed, Shipped, Delivered, cancellation, return, refund). Keeps frozen purchase snapshots, derives the overall status from the items, tracks payment, delivery and returns progress separately, and runs item-level cancellations, seller fulfillment tasks with dispatch deadlines, timelines and purchase documents. | catalog, offers | 36 |
| [payments](modules/payments.md) | 1 | Charging customers through provider adapters (card, digital wallet): payment intents per checkout attempt, authorization and capture per order and seller group, declines with retry, uncertain results resolved by a status-check job, refund execution (Requested → Processing → Sent / Failed) capped at the remaining refundable amount, chargebacks and payment disputes, saved payment methods and provider webhooks. | orders | 32 |
| [shipping](modules/shipping.md) | 1 | How things get delivered: carriers and services, destinations and excluded areas, shipping profiles with rates (Official Store and sellers), free-shipping rules, dispatch targets and cutoffs, the holiday and service-interruption calendar, delivery estimates for a location, shipments with contents and tracking, labels where supported, partial shipments, and delivery exceptions with their required responses and carrier claims. | orders | 72 |

## After-sales and money

| Module | Phase | Owns | Depends on | Endpoints |
|---|---|---|---|---|
| [finance](modules/finance.md) | 1 | Seller money and company money kept apart: the seller ledger (proceeds, pending, available, held, negative and amounts owed), fee rules, holds, adjustments, payout runs and payouts, statements, payout-destination verification, daily reconciliation checks, and company trading margins separate from marketplace fee income. | orders, payments, sellers, access | 58 |
| [messaging](modules/messaging.md) | 1 | Private service conversations linked to an order, item, return or case: customer with seller (or the Official Store), which Marketly support can join from a case, with attachments, read state, seller reply targets and overdue flags, and staff moderation. No promotional messages. | orders | 29 |
| [returns](modules/returns.md) | 1 | Return policies (platform baseline, seller terms, category exceptions, who pays return shipping), per-item eligibility, return requests and decisions, return shipments, receipt and inspection, remedies (refund, replacement, exchange) and the refund request that Finance approves before payments sends the money. | orders, shipping, payments, inventory | 61 |
| [reviews](modules/reviews.md) | 1 | Product reviews (Verified Purchase), seller feedback kept separate from product reviews, public seller responses under rules, product questions and answers labelled by who answered, reports of inappropriate content, moderation with outcomes visible to reporter and author, appeals, and rating summaries for products and sellers. | orders, catalog, sellers | 48 |
| [support](modules/support.md) | 1 | Help cases and disputes: customer help and order-problem cases opened from the order with items pre-identified, seller support requests to Marketly, disputes between customer and seller with evidence, decision, remedy and appeal, plus categories, priority, owner, SLA deadlines, assignment, escalation and resolve/reopen rules. | orders, access | 39 |
| [trust](modules/trust.md) | 1 | Trust and Risk's case file: reports of counterfeit goods, suspicious orders, fake reviews and abuse from customers, sellers, staff, brand owners and automated signals, with evidence, a risk score, an investigation workflow, enforcement recommendations routed to the team that owns the action, recorded enforcement with reasons, and appeals decided by someone other than the original decider. Trust recommends; Catalog, Seller Manager, Support, Finance and the other owners act. | access | 46 |

## Growth

| Module | Phase | Owns | Depends on | Endpoints |
|---|---|---|---|---|
| [advertising](modules/advertising.md) | 1 | Ad placements and their rules, ad campaigns through the full lifecycle, creatives and their review, audiences, schedules, frequency caps and dismissal suppression, rotation and priority, the serving decision for each page view, display/click/dismissal tracking with attribution, and seller sponsored campaigns with spending limits and ad charges kept separate from commission. | media, access | 48 |
| [content](modules/content.md) | 1 | Store content managed by the Content Manager: ordered and scheduled homepage sections, campaign pages and curated collections, Help Center articles and categories, policies with versions and effective dates, the About page and footer links. Every item has an owner, a preview, a publication status and schedule, a version history with restore, and a correction or removal action. | media, access | 64 |
| [promotions](modules/promotions.md) | 1 | Discounts and sales campaigns: markdowns, percentage and fixed coupons, minimum-spend and free-shipping offers, flash sales, seller discounts and platform campaigns with seller consent. Owns eligibility, stacking, budgets and caps, the funding owner of every discount, coupon clipping and redemption, the Deals page data and campaign results. | catalog, offers | 55 |

## Later phases

| Module | Phase | Owns | Depends on | Endpoints |
|---|---|---|---|---|
| [fulfillment-service](modules/fulfillment-service.md) | 4 | Platform storage and shipping for sellers: seller enrollment under service terms, SKU enrollment, inbound shipments to our warehouse, receiving into seller-owned stock, picking and shipping by us while the seller stays the seller of record, returns handling, removal of stock, and storage and handling fees with full seller visibility. | inventory, warehouse, finance | 39 |
| [wallet](modules/wallet.md) | 3 | Customer store credit with an auditable ledger (refunds to credit, goodwill credit within approval limits, price adjustments, use at checkout, expiry), gift cards, and a placeholder for loyalty rewards. Checkout and payments use the balance through the in-process public API. | customers, payments | 15 |
| [wishlist](modules/wishlist.md) | 3 | Saved shopping for customers: saved items in one or more lists, price-drop and back-in-stock alerts, and shareable lists. Alerts are delivered through notifications under the customer's promotional preferences. | catalog, offers, customers | 19 |

## Dependency layers

Each module needs only modules in earlier layers (required dependencies; optional ones are listed on each module page).

| Layer | Modules |
|---|---|
| 0 | [audit](modules/audit.md), [identity](modules/identity.md), [inventory](modules/inventory.md), [media](modules/media.md), [reports](modules/reports.md) |
| 1 | [access](modules/access.md), [catalog](modules/catalog.md), [customers](modules/customers.md), [notifications](modules/notifications.md), [purchasing](modules/purchasing.md) |
| 2 | [advertising](modules/advertising.md), [content](modules/content.md), [sellers](modules/sellers.md), [settings](modules/settings.md), [trust](modules/trust.md), [workqueues](modules/workqueues.md) |
| 3 | [offers](modules/offers.md) |
| 4 | [cart](modules/cart.md), [orders](modules/orders.md), [promotions](modules/promotions.md), [search](modules/search.md), [wishlist](modules/wishlist.md) |
| 5 | [messaging](modules/messaging.md), [payments](modules/payments.md), [reviews](modules/reviews.md), [shipping](modules/shipping.md), [support](modules/support.md), [warehouse](modules/warehouse.md) |
| 6 | [checkout](modules/checkout.md), [finance](modules/finance.md), [returns](modules/returns.md), [wallet](modules/wallet.md) |
| 7 | [fulfillment-service](modules/fulfillment-service.md) |

## Errors

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Fields are missing or invalid. details.issues lists each field. |
| `UNAUTHORIZED` | 401 | No token, or the token is invalid, expired or revoked. Only this error should trigger a token refresh (WWW-Authenticate: Bearer error="invalid_token"). |
| `FORBIDDEN` | 403 | Signed in, but the role or seller permission does not allow this. details.permission names it. |
| `NOT_FOUND` | 404 | The record does not exist or is not visible to this caller. |
| `ILLEGAL_TRANSITION` | 409 | The status does not allow this action (e.g. approving a rejected product). details.from, details.event. |
| `APPROVAL_REQUIRED` | 409 | Above the caller's limit or needs a second reviewer, and nothing was saved (the action cannot be recorded until it is approved). details.approvalRequestId tracks it. When the module saves the record pending approval it answers its normal success status instead, with `approval` (ApprovalInfo) in the body (FORMAT.md, Approval responses). |
| `CONFLICT` | 409 | Concurrent change; reload and retry. |
| `IDEMPOTENCY_KEY_REUSED` | 422 | The Idempotency-Key was used with a different request body. |
| `RATE_LIMITED` | 429 | Too many requests; retry after the Retry-After header. |
| `NOT_IMPLEMENTED` | 501 | Planned for a later launch phase. |
| `WRONG_AUDIENCE` | 403 | The token is for another app (store, Seller Center or Admin Center). |
| `STEP_UP_REQUIRED` | 403 | A fresh proof is needed: a re-auth token in the body or a 2-step code in X-Step-Up-Code. details.kind, details.purpose. |
| `OWNER_ONLY` | 403 | Only the seller owner can do this. |
| `NO_SELLER_ACCESS` | 403 | This account cannot act for that seller (or for any seller). |
| `UPGRADE_REQUIRED` | 426 | This app version is no longer supported; update the app. |
| `SERVICE_UNAVAILABLE` | 503 | A service needed to authorize the request is unavailable; retry later. |

## Headers

| Header | Use |
|---|---|
| `Authorization` | Bearer <token> on every request: visitor token before sign-in, access token after (customer, seller member or staff) |
| `Idempotency-Key` | Required on endpoints marked idempotent (orders, payments, refunds, payouts). Same key + same body returns the first result. |
| `Accept-Language` | en-US (only locale at launch) |
| `X-Request-Id` | Echoed back; include it when reporting problems |
| `X-App-Proof` | Bootstrap only: Play Integrity token (Android) or bot-challenge token (website) |
| `X-Step-Up-Code` | Current 2-step code for endpoints with stepUp kind "code" |
| `X-Client` | web|android/<version>: analytics and minimum-version checks only, never trusted for authorization |

## Constants

Reserved values every module may use (exported from `backend/src/spec/common.ts`).

| Name | Value | Meaning |
|---|---|---|
| `OFFICIAL_STORE_ID` | `"00000000-0000-7000-8000-000000000001"` | Seller id of the Official Store, used wherever a seller id is required (feedback, reviews, returns terms, conversations, report facts, promotion lines). The sellers module never issues it. |
| `OFFICIAL_STORE_NAME` | `"Marketly Official Store"` | Display name of the Official Store wherever a seller name is shown (cart, checkout, orders, conversations, reviews, returns, notices). Use this constant instead of writing the label. |
