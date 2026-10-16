# Backend requests and API gaps (from the web apps)

The web apps don't change `backend/`. This file lists what they need from it: **requests** (changes we ask for, with a proposed spec) and **gaps** (things the API doesn't provide; the apps work around them until they are decided). Keep it current as screens are wired.

## Requests

### R1. Development outbox endpoint (needed for the seed script and for testing sign-up by hand) — requested 2026-10-13

**Why.** Verification codes, password-reset links, staff invitation links and guest order links are random and are only "sent" to the in-memory dev outbox (`backend/src/modules/notifications/providers/dev-outbox.ts`). No HTTP route exposes them and nothing logs them, so in development nobody can finish registration, accept a staff invitation, reset a password or open an emailed order link, and a seed script can't create real customer or staff accounts (staff accounts are needed because approval limits check the approver's real roles).

**Proposal.** Development-only routes, registered only while `DEV_TOKENS` is on (startup already refuses `DEV_TOKENS` in production), outside the API spec like `/docs` (so `check:api` is unaffected):

```
GET    /api/dev/outbox?to=<address>&channel=email|sms|push&since=<ISO>&limit=<1-200>
DELETE /api/dev/outbox
```

- Auth: a token, per the "every endpoint needs a token" rule. Any valid token of any app is enough (the data is development-only); a dev staff token is fine too.
- Response, newest first:

```json
{
  "items": [
    {
      "providerMessageId": "em-…",
      "at": "2026-10-13T10:15:00.000Z",
      "channel": "email",
      "to": "ana@example.com",
      "subject": "Your Marketly code",
      "text": "…",
      "html": "…",
      "topic": "identity.verification.code_issued",
      "data": { "code": "482913", "verificationId": "…" },
      "links": ["http://127.0.0.1:3000/reset-password#token=…"]
    }
  ]
}
```

- `data` = the template variables the email was rendered from (code, token, links), so clients don't parse HTML. `links` = every URL in the message.
- `DELETE` clears the outbox (204).
- Optional, same rules: a small HTML viewer at `/dev/mail` for people testing in a browser.

**Used by.** `tools/seed` (staff invitations, customer registration with a password, password reset), and developers completing sign-up, invitations and resets in the three apps.

### R2. Embedded MongoDB with `MONGO_DATA_DIR` doesn't survive a restart — reported 2026-10-13

**What happens.** `connectMongo` (`backend/src/kernel/mongo/index.ts`) starts `MongoMemoryReplSet` with `dbPath = MONGO_DATA_DIR` but no fixed port. The replica-set config stored in the data folder records the first run's `host:port`; on the next start the instance gets a new random port, never finds itself in the config, and startup fails with `GenericMMSError: Instance failed to start within 10000ms`. So the documented way to keep data between restarts works only once. (Killing the dev server can also leave the `mongod` child running.)

**Proposal.** Pin the embedded instance's port when `MONGO_DATA_DIR` is set (e.g. `instanceOpts: [{ dbPath, port: Number(process.env.MONGO_PORT ?? 27018) }]`), or reconfigure the replica set to the current port on start. Until then the web team runs an external single-node replica set (`mongod --replSet rs0 --port 27018 --dbpath backend/.data/mongo-rs`, `replSetInitiate`) and sets `MONGODB_URI=mongodb://127.0.0.1:27018/marketly?replicaSet=rs0`.

### R3. Product image crop and sizes (setting, read endpoint, detail/thumb renditions, checks) — requested 2026-10-16

Staff set the product image aspect ratio and the product-page and thumbnail sizes in the Admin Center; sellers crop to that ratio before upload; the backend keeps exactly two sizes. Full guide: [BACKEND-PRODUCT-IMAGES.md](BACKEND-PRODUCT-IMAGES.md). The web apps are built against it and fall back to 1:1 / 800 × 800 / 320 × 320 until it ships. Note: the only image processor today is the development one, which does not resize at all.

## Gaps (worked around in the web apps)

| # | Gap | Effect in the apps | Workaround |
|---|---|---|---|
| G1 | Products resolve by id only (REST and GraphQL `product(id)`); no lookup by slug | `/p/:slug` can't load a product | Store product routes carry the id: `/p/:slug/:id` (slug is cosmetic) |
| G2 | Persisted queries HomePage, CategoryPage, SearchResults, ProductPage, SellerStorefront select `Product.saved` (wishlist, off at launch); AccountOverview selects `Customer.wallet` (wallet, off) — they fail validation in the launch configuration | Those screens can't use their persisted query | Development: send the query text without those fields; production needs the persisted queries fixed (or REST) |
| G3 | Emailed links point to `/reset-password#token=…` and `/orders/open#token=…` | — (store app routes) | Store app adds both routes (web-side change) |
| G4 | No endpoint to contact a seller without an order | Storefront "Message the seller" | Hidden/disabled with an explanation |
| G5 | No guest back-in-stock email | Product unavailable view | Signed-in customers only, or hidden |
| G6 | Reviews: no keyword search, no AI review summary | Reviews page search and "Customers say" | Search filters the loaded page client-side; summary hidden until provided |
| G7 | No live chat | Help center "Start chat" | Hidden |
| G8 | No Official Store profile endpoint (it is not a seller record) | Official Store page header | Static copy from the web app |
| G9 | Card form collects raw card numbers; the API takes a provider token only | Checkout new-card form | Development: dev tokens (`tok_visa`, `tok_declined`, `tok_3ds`); production needs the provider's card element |
| G10 | Was-price check with basis `list_price` reads a "List price" (or MSRP/RRP) entry in the product **specs** (`offers/domain/rules.ts` `listPriceOnFile`); the variant `listPrice` that admin product drafts accept is ignored, so an Official Store offer with `compareAt: { basis: "list_price" }` fails `WAS_PRICE_NOT_VERIFIED` even though the list price was entered | Official Store and seller was-prices | Seed adds `specs["List price"] = "$229.00"` to products with a was-price; the product page shows that row in the spec table. Ask: read the variant list price (per variant) in the check |
| G11 | Seller invitation codes and payout test-deposit amounts are only "sent" by email / bank (no dev route) | Seed, testing seller sign-up by hand | Seed computes both from the dev secrets (HKDF of APP_SECRET; sha256 of the dev provider destination id). R1 (dev outbox) would cover the invitation code |
| G12 | Customers created with the dev Google sign-in have no password | Password sign-in with seeded customers | Dev Google sign-in or dev customer tokens; see R1 |

### Found while wiring the Customer Store (2026-10-13)

Bugs first, then missing data. Each is worked around in the store app (hidden, derived on the client, or an extra request).

| # | Gap | Effect in the apps | Workaround |
|---|---|---|---|
| G13 | **Bug:** GraphQL resolvers return null for non-null fields on the running server (`Money.formatted` on flash-sale prices, `Offer.official`) | HomePage and CategoryPage screen queries fail even without `saved` | Browse screens use REST |
| G14 | **Bug:** REST `GET /api/store/customers/overview` `recentOrders.itemStates` returns the order status label (e.g. `{"Partly cancelled":1}`), not item states | — | Account overview uses the GraphQL query |
| G15 | **Bug/consistency:** cart and checkout disagree on shipping (cart quotes $5.99 Standard for a $189 Official Store package with no `freeShippingNote`; checkout quotes it free; before an address, `shippingByPackage` shows 0 with `free:false`) and on coupon "not covered" reasons | Cart and checkout show different totals/reasons | Shown as the API says per screen |
| G16 | Upload ticket returns `Content-Type: image/png` but the API's own upload route accepts only `application/octet-stream` (415) | Uploads fail with the ticket's headers | Client sends `application/octet-stream` to the API's route |
| G17 | Featured-offer rule picks Northwind's $184 offer over the Official Store's $189 for the Halden Aurora; the design expects the Official Store in the buy box | Buy box differs from the design | Shown as the API decides — confirm the rule |
| G18 | No store slug on `search.ProductCard`, `content.SellerTile`, `promotions.FlashItem`/`DealProduct`, similar-product cards, review context; storefronts resolve by slug only | Seller names on cards and featured sellers can't link to `/shop/:slug` | Not linked (review context guesses the slug from the name) |
| G19 | No product slug/id where screens link to products: `CartItem`, `CheckoutLine`, `content.ProductTile`/`BrandTile`/`CategoryTile` (ids, no slugs), `ReturnDetail.items`, `AccountOverview.openReturns.items`, `OrderList.thumbnails` (no productId), order list has no offerId | Extra lookups; some items not linkable; Buy again reads the order first | Placeholder slug or extra lookups |
| G20 | OpenAPI types several fields as `unknown`/`json[]`: `content.HomeSection.deals`; `sellers.Storefront` highlights/shipping/returns/contact/categories/collections/promotion; seller programme lists; application sections; policy `tables` | No type safety for those parts | Local types in the web app |
| G21 | Default delivery location (Portland 97205) isn't exposed (app-config has none; a visitor's cart destination is null) | "Deliver to" label | Web default |
| G22 | Search: facet values for brand/seller are ids (slugs accepted); price presets have no counts; `best_selling` sort returns `SORT_NOT_AVAILABLE`; order search doesn't match seller names; `me.orderCounts(range)` ignores the search | URLs carry ids; Best sellers collection empty; tab counts don't follow a search | As described |
| G23 | Ads: serving decisions need a shared visitor id plus display/click events; nothing available to the web apps | Category banner, home ad positions, sponsored brand block | Hidden (sponsored search hits still labelled) |
| G24 | No category images in the catalog API | Category tiles | Placeholder art by slug |
| G25 | Reviews/Q&A: no per-viewer "already reported" flag on reviews; no per-viewer helpful flag on answers; no answered/awaiting filter or awaiting count for questions; no notify-me on asking and no notification to the asker; no "new listing" flag; best-seller rank is GraphQL-only; Official Store seller info in offers has no ratings | Report button reappears; vote state per page; derived counts; "No seller ratings yet" on the Official Store buy box | Derived on the client or hidden |
| G26 | Order and return data: return `shipment.qrCodeUrl` is a drop-off link, not a QR image; `ReturnDetail.refund` is null until decided (no estimate before inspection); AccountOverview query has only delay alerts (REST has payment_being_checked, return_action_needed, case_waiting_on_you, payment_failed); shipment `packageLabel` counts shipments ("1 of 2") vs the group label ("1 of 3"); `PaymentStatusView` has no order placed time | QR shown as text; "After inspection"; fewer alerts; extra reads | As described |
| G27 | Notifications: shipment notices lack the order ref; refund notices put the refund ref (RF-…) in the order link; some refund-approved/label-ready notices have no ref; icon names outside the apps' Lucide set (`alert-triangle`, `x-circle`) | Some notice links can't be built | Fall back to the Orders/Returns list; unknown icons → bell |
| G28 | Accounts without a password (dev Google sign-in, G12) can't change password, enable 2-step, change email or close the account (all check a password); the API doesn't say the account has no password, and attempts count as failures | Security/Profile actions fail for seeded customers | — (needs R1 for password accounts, or a "no password" flag) |
| G29 | Sign-in and links: order link redeemed while signed in attaches the order to a new guest session the customer can't use; redemption returns only `orderId` (screens need the ref); no lockout duration before a lock; reset-link lookup returns only the masked email; guest lookup also grants access to registered customers' orders by ref + email (confirm intended); Google outside development needs a real client/config, Apple has no verifier | Extra calls; generic lock copy | As described |
| G30 | Checkout/payment dev tooling: no dev trigger for a checkout change set (review-changes untestable by hand); dev processor labels `tok_3ds`/`tok_timeout` as "Visa •••• 0002" and its 3DS `nextAction.url` points to `processor.example`; `tok_declined` has `decline.retryable:false` but `retryAllowed:true` | Dev approve/fail buttons for 3DS | UI follows `retryAllowed` |
| G31 | Support and help: order-problem cases need both `category` and `problemType` (not derived); help breadcrumbs link to `/help/topics/<slug>` (no route/design); contact channels defined twice with different data (content `HelpHome.contact` vs support `ContactOptions.channels`); media references have no file name | Client maps category; topic links → `/help?topic=`; file names read from the signed link | As described |
| G32 | Content and settings: seller agreement links point to `/policies/seller-agreement` etc., which are not published policies; settings `companyLine` says San Francisco while the About copy says Portland; no help/sellers/press emails, postal address, founding year, HQ or approved-seller count settings | "Not published" for agreements; About facts hidden | As described |
| G33 | Seller application: tax id and bank details must be re-entered on every save of their step (only the last 4 come back); no draft for an information-request response; a rejection appeal can't be read back beyond `appealId`; a cancelled data export can't be removed from history | Re-entry required | As described |
| G34 | Coupons: label is generic ("Coupon WELCOME20") instead of the campaign copy | Coupon line in cart/checkout | Shown as sent |
| G35 | 2-step setup returns an `otpauth` link but no QR image | Setup shows the key only | — (or a QR library in the web apps) |

### Found while wiring the Seller Center (2026-10-14)

Bugs and contract questions first, then missing data. Each is worked around in the Seller Center (hidden, derived on the client, or an extra request).

| # | Gap | Effect in the apps | Workaround |
|---|---|---|---|
| G36 | **Bug:** seller/admin `GET …/media/assets/{id}` and `POST …/uploads/{id}/complete` answer `{ asset, usages, … }` while the store area answers the asset | Upload polling saw no status and reported "rejected" | Shared upload helper unwraps `asset` |
| G37 | **Bug:** null for non-null fields again (G13): `SellerFinanceOverview`, `SellerStatement`, `Offer.earningsPreview` (`Money.formatted`); `CatalogMatch.lowestPrice` and `ProductAdmin.bestPrice` are null although live offers exist | Finance/Statement can't use their screen queries; no "from" price in catalog match | REST; earnings computed from `finance/fee-schedule`; price hidden |
| G38 | **Contract:** large-price-change confirmation never triggers (draft $12.50 → $99 PATCH, bulk row $184 → $999 previews "ready") — confirm the rule | Confirmation step untested | Client handles the confirm response if it comes |
| G39 | **Contract:** return fee refund — the estimate before deciding says `feeReturned` $27.90 (10%); the booked partial refund and the seeded full refund show $0.00 | Earnings impact card disagrees with the ledger | Shown as sent per stage |
| G40 | **Contract:** shipments refuse `carrierCode: "other"` although shipping.md says tracking is optional for other carriers; setup lists FedEx/UPS/USPS only. "Same business day" handling is in the design but `sellerHandlingRange` is 1–3 and not readable by the seller | No OnTrac/Other; handling option refused | Listed carriers only; server message shown |
| G41 | **Bug:** a bought label that isn't handed over leaves its items at `shippedQuantity` 0, and the group still allows `record_shipment`/`cancel_items` for them | Items could be shipped or cancelled twice | Client subtracts items on unhanded labels |
| G42 | `LABEL_FAILED` is a 502, so generic 5xx handling hides the carrier's message | — | Order page reads the message directly |
| G43 | Seller help is store-area only (`GET /api/store/content/help…`); a seller token gets `WRONG_AUDIENCE` | Seller Center help can't use its own session | Separate store visitor session with `X-App-Proof: dev`, which **fails in production**; needs seller-area help routes |
| G44 | Actor names are null on the seller side: order timeline/shipment `recordedBy`, corrections, label `purchasedBy`, inventory `Movement.actor`, `BulkUpdateJob.uploadedBy/appliedBy`, return activity/inspection/decisions, seller history events | "· Avery Stone" can't be shown | "You" / "Your team" |
| G45 | Buyer identity: conversation counterparty is "Buyer" (design: "Quinn T."); order conversation `subject.title` has no item summary | Generic labels | As sent |
| G46 | Statements resolve by id only (routes and links use the ref); `statement(ref)` GraphQL fails (G37) | Extra list scan | Page scans the statements/payouts list |
| G47 | Missing columns: no SKU on statement lines or `seller.product_sales` rows (no image or live-discount flag either); `SellerOfferRow`/`OfferSummary` have no `stockItemId`; setup "What goes live" titles are SKUs, one row per variant | SKU columns and images dropped; bulk stock update pages through stock items | As described |
| G48 | Reports: no return rate or its comparison; seller export covers one report at a time; service metrics use a fixed 30-day window regardless of the period switch | Return rate derived (units returned ÷ sold), no change figure | As described |
| G49 | Staff: invited members have no notification-preference row (PUT 404); revoked invitations and removed members stay in `GET members` (no filter/delete); with dev tokens `GET notifications/preferences` adds a row for the token's member id (= account id); the permission catalogue marks `finance.destinations.confirm` delegable and not owner-only while its label says owner only | Notification settings only after acceptance; client hides revoked rows | As described |
| G50 | Owner re-auth for payout account changes needs a password or 2-step; seeded owners (dev Google, G12/G28) have neither | Payout account change untestable in development | — (R1) |
| G51 | Store profile: brand claims require `brandId` + evidence (design: one text field); a seller token can't read its own storefront ratings (store route `WRONG_AUDIENCE`); the design has no offer picker or image for collections | Brand select + evidence upload added; preview ratings hidden; new collections start empty | As described |
| G52 | Catalog: no seller endpoint to delete a draft product or withdraw a submission; product submissions carry no offer terms (variation offers get defaults); seller-visible settings unreadable (minimum description length, default low-stock threshold, large-change %); no seeded category has attributes or image standards | Test drafts can't be removed; values hard-coded (40, 3) | As described |
| G53 | Offers/inventory: no product-draft count and no publication filter in offer counts/list; seller stock reason codes have no "bulk update"; `OfferPreview.delivery` has no location label | Publication mapped to offer status; bulk stock records "count correction" | As described |
| G54 | Order data: seller timeline text embeds raw ISO dates ("Dispatch by 2026-10-15T00:00:00.000Z") and mixes customer-facing entries; GraphQL order has no label link on shipments and no reasonCode/refund on cancellations; export filters can't name specific orders | Extra REST reads; client rewrites dates; selected-rows export built in the browser | As described |
| G55 | Returns: seller evidence before a case is impossible (`return_evidence` purpose refused in the seller area, `case_evidence` assets rejected); `sellerReturn.conversation` is null unless started with a `returnId`, which the seller start input lacks; no return-label quote before approving (`labelCharge` null); no partial-refund earnings preview; list says "Return requested" while GraphQL says "Requested"; inspection requires `grade` + 6 outcomes + checklist (design: 3 conditions) | Evidence dropzone hidden until a case; messages go to the order conversation; label price hidden; inspection form extended | As described |
| G56 | Customers: no per-viewer "already reported" flag on messages; no skip/dismiss for product questions; text limits not documented (answers 2–1000, responses 1–2000, template names 80); feedback summary has no target; `replyLabel` is pre-formatted Pacific time while other fields are ISO | Skip and "Below target" hidden | As described |
| G57 | Promotions/ads: `consentTextVersion` not exposed (hard-coded `2026-10`); `withdraw` requires a reason the design doesn't collect; no campaign invitations seeded; every seller advertising endpoint answers 501 (launch phase 3); `SellerAdCampaign` has no offerIds/pages; promotable offers have no price | Invitations untested; Sponsored ads and Ad request show "not available yet"; edit can't prefill | As described |
| G58 | Seller account: `accountManager` null for every seeded seller; seller help has 2 articles where the design links 4; history events have no state; REST restriction scope has category ids only (GraphQL has names); evidence has no document-type field; OpenAPI `unknown` for `goLivePreview`, `accountManager`, step `cta`, feedback (G20) | Seller Manager block hidden; history colouring derived; document type sent in `note` | Local types |

### Found while seeding the design states (2026-10-14)

| # | Gap | Effect in the apps | Workaround |
|---|---|---|---|
| G59 | Purchase box sets `unavailable` only when no seller has the variant; there is no "Official Store out of stock, other sellers have it" signal | The product-unavailable design state can't be shown | — |
| G60 | No dev card token keeps a payment pending: `payments.check-uncertain` (every 30 s) settles it within about a minute, and each attempt leaves a cancelled order | "Checking payment" can't be held for testing or the design check | — (ask: a `tok_pending` dev token that stays pending) |
| G61 | Payment-failed notification body has no order ref ("The payment for order  was declined") | Notice text has a gap | As sent |
| G62 | Notifications can't be archived or deleted | An inbox can't be brought back to a small state (Jordan has 76 notices) | — |

### Found while wiring the Admin and Operations Center (2026-10-14)

Bugs and contract questions first, then missing data. Each is worked around in the Admin Center (REST instead of the screen query, derived on the client, hidden, or an extra request).

| # | Gap | Effect in the apps | Workaround |
|---|---|---|---|
| G63 | **Bug:** null for non-null fields again (G13/G37): `Money.formatted` on `AdminDashboard.nextPayoutRun.total`, `orderAdmin…discountFunding.platformFunded`, `AdminSeller`, `AdminPayoutRun`, `AdminCase.refundImpactPreview` | Those screen queries fail or lose a part | REST, or the query without `formatted` |
| G64 | **Bug:** screen queries that don't run or return nothing: `AdminCustomer` asks for `Customer.walletAdmin` (not in the schema, like G2); `AdminCase` requires `orderRef` (cases without an order can't use it); GraphQL `workSummary` returns empty lists while REST `workqueues/summary` has six tiles; `orderAdmin.auditTrail` is empty (`total: null`) while REST history has entries; `workqueues/me` ignores `scope` and returns empty `routine.checks` and null `dayEnd` while `routines/today` and `day-end-reviews/current` have data | Dashboard, Customers, Case, Order history, Queues | REST for each |
| G65 | **Contract:** separation of duties — the creator of a promotion campaign can confirm its own funding (Olivia created, submitted and confirmed); help article approval returns `SAME_REVIEWER` but `HelpArticleAdmin` doesn't say who wrote it, so the button can't be hidden from the author | Self-approval possible on promotions | — (confirm the rule) |
| G66 | **Contract:** an escalated support case can't be resolved (`ILLEGAL_TRANSITION`) — intended?; returns stats `exceptions` is 0 while `tabCounts.exceptions` is 1; customer actions say password reset/sign-out need `customers.accounts.security` but declare `customers.accounts.act` | — | As sent |
| G67 | **Contract:** inputs that reuse output types or need server-generated values: ad campaign create requires `budget.spent`; `stopWithPromotion` required but refused when true without a promotion; placement edit requires full frequency-cap/dismissal objects including the generated `label`; category attributes need a client-made `id`; `X-Step-Up-Code` typed as required in OpenAPI | Client sends placeholders (0, false, echoed objects) | As described |
| G68 | Reasons the designs don't collect: settings drafts need a reason before the impact preview; notification channel toggles, promotion pause, bulk case priority, catalog hide, ad pause/finish all require a reason | Generated or fixed reasons, or an added field | As described |
| G69 | Lookup by ref/slug missing: sellers by slug (`SellerRow` has no slug; `/sellers/:slug` resolved in the browser), support cases by CS- ref, ad campaigns by AD- ref (route has no param), trust seller subjects have `ref: null` and no slug, admin returns by RT- ref, orders' seller groups have no seller slug | Extra list searches; some links go to list searches | As described |
| G70 | Actor names null on the admin side too (G44): audit entries (`audit/summary.byActor` mixes names and ids), settings change `createdBy`, trust timeline, homepage `Version.author`, ad creative `createdBy`, catalog `reviewLog.actor`, moderation deciders | Names looked up from `access/members` where possible, else "Staff" | As described |
| G71 | Pickers/assignees: no endpoint lists who may approve a given action (second reviewer pickers need `access.roles.view`); `GET support/assignees` returns an empty list although Olivia handles cases; work queue leads/backups are all "Not set" in the seed | `secondReviewerId` never sent; pickers fall back to the signed-in staff member | As described |
| G72 | Missing exports: finance overview, case queue, payout run, campaign list, inventory, receiving, shipping exceptions, return inspection, finance checks; audit export is a background job (no wait/download in the page yet) | Export buttons disabled with a note | — |
| G73 | Missing actions: staff notice mark-unread; per-check finance sign-off; cancel a trust evidence request; delete a service notice; undo a dismissed catalog check; bulk price and stock for the catalog; remind a seller about an overdue order (only via a shipping exception id); a case can't be created from an order | Buttons removed or disabled | As described |
| G74 | Missing data: `SellerStats.balances` null; carrier and Official Store on-time rates null; Official offers `unitCost`/`marginPct` null and trading `buyingCost` $0 (100% margin); `stockState=low_stock` returns nothing (thresholds null); free-shipping rules empty despite a $35 threshold; trading summary has no fee income; decided moderation list has no outcome/reason/decider; trust has no recommended next step or subject history; campaign check reach estimate always null; promotion `officialMargin`, `storeReturnsPct` null; reports catalogue has 10 reports (design 23), previous-period comparison only, Sales KPI changes null, metric owners empty | KPIs show "—"; derived values; hidden sections | As described |
| G75 | Shapes: return reason filter takes codes but rows carry labels; `AdminOrderRow`/shipping exceptions don't link to each other (no exception ids on rows, no item quantities on exceptions); purchasing receipt has no inventory inbound id; inspection drafts store photo ids without URLs; settings overview is display text only (one request per field to edit); help policy status `current` vs article `published`; OpenAPI `unknown` for `NoticePreview.estimates`, `AdminSeller` JSON fields, `HelpSummary.tabs`, customer `signIn` (G20) | Extra requests and client mapping | As described |
| G76 | Seed/content: no overdue orders, failed payouts, disputes, failing refunds, unexplained amounts, open applications, active pick wave, purchase orders or received returns, so those flows were only typechecked; inventory unit costs null; seeded "Package dispatched" email preview cut mid-variable ("…Estimated arrival: {{de…"); 7 settings sections owned by other modules say "Not reported by its module yet" | Empty states only | Seed more states (see the design seed step) |
| G77 | **Contract:** the Business Owner + Platform Administrator roles (Olivia) have mostly view permissions but not `catalog.*`, `offers.official.*` (Official Store offers answer 403), `sellers.applications.review`, return inspection or `content.*` — confirm the role design; dev staff tokens carry every permission, so the gap only shows in a real session | Those screens show "Not available for your role" for the seeded owner | Shared `LoadError` shows a role note for 403 instead of an error to retry |

### Found in the three-app walkthrough (2026-10-16)

| # | Gap | Effect in the apps | Workaround |
|---|---|---|---|
| G78 | **Bug:** seller return notices have an empty product name and a raw instant: "Return request … items from (). Respond by 2026-10-15T16:58:28.953Z." (notification template variables not filled; dates not formatted). Raw ISO instants also appear in other server text: the admin order timeline ("New dispatch estimate 2026-10-19T11:21:10.115Z") and the Operations routine summary ("next pickup 2026-10-15T23:00:00.000Z") | Sellers and staff read broken sentences | The apps rewrite ISO instants in server text to Pacific time (`isoInText`); the empty "()" needs the template fixed. Ask: format dates in the template with the market time zone, and fill the product name |
| G79 | **Content:** a delivery-exception alert shown to the seller on the order page reads "Shipped, no carrier scan 24 h. Request valid tracking details; never imply delivery." — staff guidance ("never imply delivery") leaking into seller-facing text | Sellers see internal instructions | Shown as sent. Ask: separate seller-facing copy from staff guidance for delivery exceptions |
