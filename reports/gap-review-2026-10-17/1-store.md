# Customer store review: backend /api/store + /api/public vs `frontend/`

## Executive summary
1. The store's REST wiring is mostly correct. Every typed call matches a backend op, all 47 error codes the store checks exist in the backend, Idempotency-Key is sent on all 7 store ops that require it, and the 4 GraphQL screen queries the store runs are byte-identical (except CRLF) to the backend persisted operations.
2. Most of the "unused" store ops in the inventory are not real gaps. Wishlist (18), wallet (5), cart saved-for-later (4), checkout credit and push are phase 3/4: their modules are commented out in `modules.config.ts` or the ops are `x-phase: 3`. Media (8) is called through template-literal paths. Shipping, order documents, refunds and case detail are read through the OrderDetail, ReturnDetail and CaseDetail GraphQL queries.
3. **Biggest flow break (High): the return detail page ignores `Return.actions`.** Customers cannot answer the seller's question (REPLY_INFO), add tracking for a return they ship themselves (ADD_TRACKING), withdraw or escalate. The `returns.info-expiry` job then cancels the unanswered return automatically.
4. **High (online only): links in customer emails and pushes point to paths the store doesn't have.** They are built as `STORE_URL/<screen id>/<uuid>` (e.g. `/account/return/<uuid>`), but the store routes are `/account/returns/:ref` and similar, so the links land on the store's Not Found page. The unsubscribe link has no page either.
5. **High (online): there is no real payment provider on either side.** The backend always wires the development card processor. The store shows a "Test card" picker and "Approve / Fail the security check" buttons in production builds, and ignores `nextAction.url`. The `/api/dev/.../settle` call cannot be reached in production: the frontend gates it on `import.meta.env.DEV` and the backend only registers dev routes with DEV_TOKENS.
6. Medium: a failed refund cannot be sent elsewhere because the order page doesn't render `order.refunds` and nothing calls `refunds/{id}/destination`. Trust and Risk has no customer surface: no reports, no evidence-request answers, no appeals. The "Send what we asked for" action notice therefore points nowhere.
7. Medium: several links resolve to the catalogue's sample slugs that real data doesn't have. "Brands" goes to `/brand/halden`. "How results are ranked", "Why these ads?" and the review-rules links go to `/help/articles/track-a-package`. The header and footer navigation is hardcoded and ignores the published `content/navigation`.
8. Medium: Deals "See all N" clearance and coupons only ever shows the first 12, because the paged `deals/clearance` and `deals/coupons` ops are unused. Product-view signals (`reports/signals`) are never sent, so product-view KPIs stay empty.
9. Low: the uncommitted change removed digital wallet payment even though the backend still offers it. Design showcase routes (`/ads/*`, `/design/*`) ship in production with fixture data. Minor backend-only features are listed in B.
10. Counts: A 6 · B 12 · C 5 · D 4 · E 5. Evidence is from static reading; no servers were run.

---

## A. Mismatches

**A1 · High (online) · Customer email/push links don't match store routes**
- Evidence: `backend:backend/src/modules/notifications/app/core.ts:259-262` builds the link as `` `${appUrl}/${link.screen}/${encodeURIComponent(link.id)}` `` when there's no `link.url`. Customer links are screen ids plus a uuid:
  - `backend:backend/src/modules/notifications/app/consumers.ts:286` (`screen: 'account/return', id: p.returnId`)
  - `backend:backend/src/modules/returns/service/requests.ts:566`
  - `backend:backend/src/modules/shipping/service/exceptions.ts:365` (`account/tracking`, id = shipment id)
  - The email text appends that URL: `backend:backend/src/modules/notifications/app/sender.ts:584-587`
- The store routes are `/account/orders/:ref`, `/account/returns/:ref`, `/account/orders/:ref/tracking` and `/help/cases/:ref` (`web:web-shared/src/routes/catalogue.ts:63-68,84`). The only extra routes are `/reset-password` and `/orders/open` (`web:frontend/src/routes/email-links.tsx:14-17`). Everything else falls to `{ path: '*', element: <NotFound/> }` (`web:web-shared/src/routes/createAppRouter.tsx:126`).
- The in-app inbox is fine: it maps `screen + ref` to the catalogue (`web:frontend/src/pages/account/Notifications.tsx:44-52`).
- Impact: the "View return", "Get label" and "See next steps" buttons in emails open Not Found. The fix belongs to the backend (emit real store paths using the ref) or to the store (add `/:area/:screen/:id` redirect routes). This doesn't apply on the offline server, which sends no customer email.

**A2 · Medium · Help links fall back to the catalogue's sample article**
- Evidence: `href()` fills missing params from the screen's `sample` (`web:web-shared/src/routes/href.ts:18`). `help/article` has the sample `track-a-package` (`catalogue.ts:80`). These links pass no slug:
  - `web:frontend/src/pages/store/Category.tsx:189` ("How results are ranked")
  - `Search.tsx:118` ("Why these ads?")
  - `Product.tsx:723` ("How reviews work")
  - `account/Review.tsx:537` and `account/Reviews.tsx:289` (review rules)
- The published help articles (`backend:backend/tools/simulate/content-data.ts:126-233`: return-seller-item, late-package, …) have no `track-a-package`.
- The backend's `GET /api/store/search/ranking-policy` ("How results are ranked") is unused.
- Impact: these links open "article not found", and policy text the backend publishes is never shown.

**A3 · Medium · "Brands" nav and footer link opens a brand that doesn't exist**
- Evidence: `web:frontend/src/layouts/StoreLayout.tsx:22` and `:208` call `href('store/brand')`, which becomes `/brand/halden` (catalogue sample, `catalogue.ts:46`). `halden` appears only in backend tests, not in the real catalog or the simulate data.
- There is no brand index route; the brand list is on `/categories` (`Categories.tsx` calls `GET /api/store/catalog/brands`).
- Impact: a header link visible on every desktop page leads to Not Found.

**A4 · Medium · Bank check ignores `nextAction` and always shows development buttons**
- Evidence: `payments.PaymentStatusView.nextAction {kind: three_ds_challenge|redirect|wallet_sheet, url, clientSecret}` (openapi) is never read; `nextAction` is not referenced in `frontend/src/pages/store`.
- `BankCheck` (`web:frontend/src/pages/store/PaymentResult.tsx:381-440`) always renders "Development: test bank check" with Approve/Fail buttons that send `3ds_ok` / `3ds_fail`. These buttons are not gated by `import.meta.env.DEV`.
- Impact: with any real provider the bank challenge never opens. With today's backend (dev processor in production, see D1) any shopper can approve their own 3-D Secure check.

**A5 · Low · Digital wallet removed in the store but still offered by the backend**
- Evidence: the uncommitted diff of `web:frontend/src/pages/store/Checkout.tsx`, `PaymentResult.tsx` and `data/checkout-api.ts` removes the `digital_wallet` option and `devWalletToken`.
- The backend still defaults `walletsEnabled` to true (`backend:backend/src/modules/payments/service/core.ts:193`) and accepts `kind: digital_wallet` (`backend:backend/src/modules/checkout/service/placement.ts:193`).
- Impact: `options.walletAvailable` is ignored. A session whose method was already set to `digital_wallet` (for example by the Android app) shows "New card" preselected in the web store. It's harmless but the two sides disagree. If wallets are dropped, the `walletsEnabled` setting should be turned off.

**A6 · Low · Stale casts on typed storefront and program schemas**
- Evidence: `web:frontend/src/pages/store/Seller.tsx:34-62` says the storefront fields are "typed `unknown` in the API spec" and casts to local interfaces. `sellers.Storefront` now types `highlights`, `shipping`, `returns`, `contact` and `promotion` (openapi).
- `web:frontend/src/pages/sell/data/program.ts:29` casts `as unknown as SellerProgram`, and `sell/Apply.tsx:635` casts the PATCH body `as never`.
- I checked these PATCH bodies against `sellers.Application*Input`, `PayoutDetailsInput` and `ReturnAddressInput`; they match today.
- Impact: none today, but future schema changes won't be caught by the type checker.

## B. Backend-only (no store surface)

Not gaps (verified):
- **Phase 3/4 by design:** wishlist (18 ops), wallet (5, loyalty is phase 4), cart saved-for-later (4), `PUT checkout/sessions/{id}/credit`, push devices and preferences (3). `wallet` and `wishlist` are commented out in `backend:backend/src/modules.config.ts:47-49`, and the other ops carry `x-phase: 3`.
  - The store shows honest placeholders (`account/Wishlist.tsx:12-47`, `account/Coupons.tsx:12-13`).
  - The checkout credit toggle only renders when `c.credit` is set (`Checkout.tsx:802`).
- **Media (8 ops):** used through `/api/${audience}/media` (`web:web-shared/src/api/uploads.ts:53-87`), for return photos, review photos, message attachments, case evidence and seller documents.
- **Read through GraphQL persisted queries:** shipping shipments, tracking and notices; order cancellations and documents; payments refunds; support case detail; customers overview; offers/{id}. See the `# replaces:` headers in `web-shared/src/api/graphql/store/{OrderDetail,ReturnDetail,CaseDetail,AccountOverview}.graphql`.

Real gaps:

| # | Sev | Capability (ops) | Where it belongs | Evidence and impact |
|---|---|---|---|---|
| B1 | **High** | Return actions: `POST returns/requests/{id}/info` (REPLY_INFO), `/shipment` (ADD_TRACKING), `/withdraw`, `/escalate` | account/return, account/returns | The schema exposes `Return.actions: [ReturnCustomerAction]` with WITHDRAW, REPLY_INFO, GET_LABEL, ADD_TRACKING, ESCALATE and REPORT_PROBLEM (`backend:docs/api/graphql/schema.store.graphql:3694,3728-3735`). ReturnDetail selects `actions` and `infoRequest`. `web:frontend/src/pages/account/Return.tsx` only offers "email the code" and links. The `ReturnDetail` type (`account/data/orders.ts:240-256`) doesn't even declare `infoRequest`. `returns.info-expiry` cancels returns with no reply (`backend:backend/src/modules/returns/service/automation.ts:299-308`). A customer-arranged return ("you add the tracking number", `ReturnNew.tsx:459`) can never get tracking, and a seller rejection can't be challenged. |
| B2 | Medium | Failed refund: `POST payments/refunds/{id}/destination`; refund list | account/order | OrderDetail selects `refunds { status failure { reason action } … }`, but `Order.tsx` renders only `totals.expectedRefunds` (`:213-214`) and never `order.refunds`. A refund that failed with a closed card (`chooseDestination`, `backend:backend/src/modules/payments/service/refunds.ts:755-785`) can't be redirected by the customer. |
| B3 | Medium | Trust & Risk for customers: `POST trust/reports`, `POST messaging/messages/{id}/report`, `GET/POST trust/evidence-requests…/answer`, `GET trust/enforcements`, `GET/POST trust/appeals`, `POST trust/reports/{id}/evidence`, `GET trust/reports/{id}` | product, offers, seller storefront and messages ("Report"); help/case or a new account screen (evidence, appeals) | The only "Report" in the store is for reviews. Topic `trust.evidence_requested` is an action notice ("Send what we asked for", `backend:backend/src/modules/notifications/domain/catalog.ts:516-518`) that can't be archived while open, and no screen can answer it. |
| B4 | Medium | Discovery signals: `POST reports/signals` | store/product | Product views are counted only from this op (`backend:backend/src/modules/reports/service/readmodels.ts:444-445`) and feed `discovery.product_views` (`queries.ts:659`). The web store only posts `customers/recently-viewed`, so views and conversion KPIs are zero for web traffic. |
| B5 | Medium | Deals paging: `GET promotions/deals/clearance`, `GET promotions/deals/coupons` | store/deals | `getDealsPage` caps clearance and coupons at 12 even with `tab` (`backend:backend/src/modules/promotions/service/storefront.ts:455,468`). "See all {N}" (`Deals.tsx:266-275`) only switches the tab, so items 13 and up are never reachable. |
| B6 | Low | Withdraw a pending cancellation: `POST orders/orders/{id}/cancellations/{cid}/withdraw` | account/cancel | Not offered. |
| B7 | Low | Cart fixes: `POST cart/items/{id}/switch-offer`, `POST cart/remove-unavailable` | store/cart | "See other offers" goes to the offers page, which adds a second line; the unavailable line stays (`Cart.tsx:406-470`). |
| B8 | Low | Checkout extras: `PUT checkout/sessions/{id}/preferences` (gift note, hide prices), `/revalidate`; `POST customers/addresses/validate`; `POST promotions/codes/check` | store/checkout, account/addresses | Nice-to-have. |
| B9 | Low | Community answers: `POST reviews/questions/{id}/answers`, `PATCH reviews/me/answers/{id}`; `GET reviews/rating-summaries` | store/questions, account/reviews | Shoppers can ask but not answer. |
| B10 | Low | `GET notifications/preferences` ("What we send"), `DELETE customers/recently-viewed/{productId}`, `GET shipping/estimates`, `GET shipping/notices`, `GET sellers/stores/{slug}/collections/{id}` (Seller.tsx:24 "Not shown: featured collections"), `POST sellers/applications/{id}/withdraw`, `GET search/barcodes/{code}` (Android), `GET identity/devices`, `POST identity/two-step/recovery-codes` (cross-cutting) | various | Nice-to-have. |
| B11 | Low | Persisted GraphQL screen queries not used by the web: HomePage, CategoryPage, SearchResults, ProductPage, SellerStorefront, OffersPage, CartPage, CheckoutReview, OrderConfirmation | — | The web stays on REST by choice (R4, `web-shared/docs/BACKEND-REQUESTS.md:60-76`). These queries are for Android. |
| B12 | Internal | Webhooks (9), `POST public/trust/reports` (rights owners), `POST public/identity/external-sign-ins` (flag `externalSignIn`), `POST public/customers/unsubscribe` (see D2) | integration | The session ops (`app-sessions`, `refresh`, `sign-out`) are used through `web-shared/src/api/session.ts` (template paths). |

## C. Frontend-only

**C1 · Medium (online) · Development payment UI in production builds (answers the `/api/dev/.../settle` question)**
- The settle call is not reachable in production:
  - `useDevSettle` (`web:frontend/src/pages/store/data/checkout-api.ts:139-150`) is only rendered under `{import.meta.env.DEV && …}` (`PaymentResult.tsx:337`).
  - The backend registers `/api/dev/*` only while DEV_TOKENS is on, and its config refuses DEV_TOKENS in production (`backend:backend/src/kernel/http/dev-routes.ts:4`, `module-system/index.ts:115`).
- What a production build still shows:
  - **Checkout and payment retry:** the "Test card" select (`Checkout.tsx:856-866`, `PaymentResult.tsx:218`). It offers `tok_declined`, `tok_insufficient`, `tok_expired`, `tok_3ds`, `tok_timeout` and `tok_pending`. A `tok_pending` payment stays "being checked" until Finance flags it after `uncertainMaxHours`, because nothing can settle it.
  - **Bank check:** the 3-D Secure self-approve buttons (A4).
  - **Payment methods:** builds `seti_<brand>_<last4>_<MMYY>` setup tokens from the typed card number (`account/PaymentMethods.tsx:15,98`).
- Impact: this is consistent with the backend's dev processor (D1), but it isn't shippable to real customers.

**C2 · Medium · Header and footer navigation is hardcoded**
- Evidence: `STORE_NAV` (`web:frontend/src/layouts/StoreLayout.tsx:16-23`) and the footer lists (`:181-250`) are static. `useNavigation()` is used only for the service strip (`:304-310`).
- The backend publishes the header (category links, Deals, Official Store) and four footer groups (`backend:backend/tools/simulate/flows/content.ts:182-201`), and admins edit them through `PUT /api/admin/content/navigation`.
- Impact: navigation changes made in the Admin Center never reach the store.

**C3 · Low · Design showcase routes are live in production with fixture data**
- Evidence: `createAppRouter` registers every catalogue screen plus `/design` with no DEV guard (`web:web-shared/src/routes/createAppRouter.tsx:110-125`). That includes `/ads/opening`, `/ads/popup` and `/ads/formats`, which use `@marketly/web-shared/data/fixtures` sellers and `pages/ads/data/headphones.ts`, and the `/design/*` theme pages.
- Impact: customers can reach pages full of sample products and sellers.

**C4 · Low · Static marketing copy and client-side calculations**
- Evidence:
  - The sell landing hero, steps and payout wording, and the fee calculator computed on the client from example rates (`sell/Landing.tsx:13-19`).
  - The About page's "Official Store / Verified seller" cards (`info/About.tsx:16`).
  - The Official Store promise strip, which is design text (G94).
  - The collection intro fallback "Ranked by units sold…" (`Collection.tsx:247,274`).
- Impact: low; the copy can drift from the backend's published rules.

**C5 · Low · "Create a new seller login" is permanently disabled**
- Evidence: `sell/Apply.tsx:167`. The API supports `accountMode: new_seller_login`, where the app registers through identity first (openapi `sellers.ApplicationAccountInput`).
- Impact: applicants must sign out and register separately.

## D. Missing on both sides

**D1 · High (online) · No real payment processor**
- Evidence: `backend:backend/src/modules/payments/module.ts:26` always uses `createDevCardProcessor()`. Its header says "a real processor adapter replaces it later" (`providers/card-processor.ts:1-4`). The store has no hosted card fields (G9).
- Impact: the online product can't take money. This is out of scope offline, but it blocks launching online.

**D2 · Medium (online) · One-click unsubscribe has no landing page**
- Evidence: promotional emails carry `${STORE_URL}/unsubscribe/unsubscribe?token=…` (`backend:backend/src/modules/notifications/app/sender.ts:233`; it's a required variable for promotional emails, `domain/catalog.ts:807`). The store has no route for it, and `POST /api/public/customers/unsubscribe` is never called.
- Impact: unsubscribing fails (a compliance problem for marketing email).

**D3 · Low · No privacy or cookie choice in the store**
- Evidence: ad decisions always send `personalizationAllowed: false` ("There are no privacy choices in the store yet", `web:frontend/src/api/ads.tsx:17-19`).
- Impact: the backend's personalisation and signal opt-out has no UI.

**D4 · Low · Notification "what we send" settings screen**
- Evidence: only marketing switches exist (Profile). Order-update channel settings are phase 3 (push) and have no web page.

## E. Internet (notes only)
- `web:frontend/index.html:8-10` loads Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`), which won't load on the offline server.
- `Tracking.tsx:165-167` links to the carrier's `trackingUrl`, and `Return.tsx:180-187` uses the backend's `labelUrl` and `qrCodeUrl`. These are external if a real carrier is used.
- A payment provider is needed online: hosted card fields, 3DS `nextAction.url` (A4, D1).
- Email and SMS providers deliver the links in A1 and D2. Google/Apple sign-in (`externalSignIn`) isn't built in the store.
- Content links can be absolute (`contentLinkTo` passes `isExternal` URLs through, `api/content.ts:14-21`), so banners or ads may point to external sites.

## Specific checks requested
- **Cart → checkout → payment:**
  - Wiring: Place, retry and complete-action send `quoteVersion`, `expectedTotal`, Idempotency-Key and `returnUrl`. All `next` and `outcome` values and all checkout statuses are routed (`checkout-api.ts:43-60`). Payment states accepted, pending, failed and requires_action are handled (`PaymentResult.tsx:91-93`).
  - Problems: C1, A4, A5 and D1.
- **Promotions and coupons:** cart and checkout coupons work (applied, needs_sign_in and rejected are handled). Product promotions come through `OfferView.promotion` in the purchase box. Deals paging is broken (B5). G81 (coupon label) is still open on the backend.
- **Wishlist, wallet, saved for later:** off by design (B, not gaps).
- **Returns:** B1 (High).
- **Trust and risk:** B3.
- **Wallet:** phase 3.
- **Shipping:** read through OrderDetail; only estimates and notices are unused (Low).
- **Media:** used through templates (false positive).
- **Offers:** `offers/{id}` and `featured-offer-rule` are covered by the offers list and GraphQL; switch-offer is unused (B7).
- **Seller storefront:** works; collections are not shown, and the casts are stale (A6).
- **Search:** the ranking-policy link is wrong (A2); barcodes are app-only.
- **Reviews and Q&A:** asking works, answering is missing (B9).
- **Content:**
  - Homepage: all 13 section kinds are handled (`Home.tsx:135-388`).
  - Policies: `/policies/{key}` links are mapped (`api/content.ts:8-19`).
  - Help: the sample-slug links are wrong (A2).
  - Navigation: hardcoded (C2).
- **Advertising:** decisions and events are typed and match the spec. Events are sent one per request because of G82.
- **Sell pages:** the request bodies match the spec. Withdrawing an application and creating a new seller login are missing.
- **Notifications inbox:** groups, archive and read handling match the spec. Email deep links are broken (A1).
