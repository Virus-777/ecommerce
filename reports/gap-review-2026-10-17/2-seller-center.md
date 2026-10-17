# Seller Center ↔ backend review (scope: /api/seller/*, schema.seller.graphql, seller-center + web-shared parts)

## Executive summary
1. All 25 designed seller screens are built (no PageStub). `tsc -p seller-center` passes, so every typed REST request body matches openapi. All 7 seller persisted operations, plus the app's 3 inline GraphQL texts, validate against schema.seller.graphql.
2. **Blocker for going live:** the "Request launch readiness review" button can never show. The backend sends a CTA on the `launch_review` step, and the Setup page renders that CTA as a link back to itself. So no seller can request the review, and offers never go live (A1).
3. **Production GraphQL (R4 still open):** the Offer page, product submission (load + category picker) and the Products/Inventory category filters send non-persisted query text. With `GRAPHQL_PERSISTED_ONLY=true` they get 400 PERSISTED_QUERY_NOT_SUPPORTED, so sellers can't create or edit offers in production (A2). On the order page, label reprint silently breaks (A3).
4. **Flows that cannot finish because the backend action has no UI:** voiding a shipping label (cancelling labelled items needs it, A/B3); responding to delivery exceptions (B2); customer cases on orders, which are never listed (`scope=customer_cases` unused, and notices say "Respond", B4); Trust and Risk evidence requests and appeals (an action-required notice links back to Notifications, B1).
5. **Staff invitations are broken:** invite emails link to `SELLER_URL/invitation#token=…`, but Seller Center has no `/invitation` route. Only admin-center has one. Invited staff can't join (D1).
6. Medium gaps: dispute decision appeal, report-delay, agreements acceptance, business details/change requests/account close, product-review responses, replacement/exchange remedies, shipping profile create, end/delete offer, inert top-bar search, overdue tile opening the wrong tab, and "Suggest a correction" routed to generic support.
7. Cross-audience `GET /api/store/identity/security` from the seller app is **not a mismatch**. The op is `x-auth: account`, `checkAudience` skips the audience check for `account`, and the op's description explicitly allows seller members.
8. Fulfilled-by-Marketly (22 ops) is phase 4 with no design. Seller ads are phase 3 (501), and the UI explains this. Both are rated later-phase, not gaps.
9. Media "unused" ops are mostly false positives: uploads/complete/assets/{id}/image-specs are called through template literals in web-shared. Several "unused" reads are covered by the GraphQL screen queries.
10. Internet: Google Fonts in seller-center/index.html, carrier labels and tracking links, payout provider deposits, and email reply channels.

Counts: A 9 · B 15 groups · C 5 · D 6 · E 6

Severity: High = flow broken / data wrong / security; Medium = feature missing or degraded; Low = cosmetic / nice-to-have.

---

## A. Mismatches

**A1 · High · Launch readiness review can never be requested**
- Evidence: backend `backend/src/modules/sellers/service/accounts.ts:232` sets `cta: lr.state === 'passed' ? null : { label: 'Ask for the review', screen: 'seller/setup' }`. In web `seller-center/src/pages/Setup.tsx:69` `ctaOf` returns any CTA that has a label and screen. Line 218 renders `cta && to ? <Button to={to}>` before the `isLaunch` branch (lines 222–226), and that branch holds the only `POST /api/seller/sellers/setup/launch-review` button. `screenHref('seller/setup')` resolves to `/setup`.
- Impact: the step shows "Ask for the review", which links to the same page. The request button is unreachable in every state (locked, not_started, changes_needed). The launch review never happens and approved offers never go live. Fix on either side: the UI should ignore the CTA for `launch_review`, or the backend should send `cta: null` for that step.

**A2 · High · Non-persisted seller GraphQL queries fail in production (BACKEND-REQUESTS R4, still open)**
- Evidence:
  - The queries are `SELLER_PRODUCT` (`query SellerProductCard`) at `seller-center/src/pages/data/products.ts:168` and `CATEGORIES` (`query SellerCategories`) at `:264`.
  - They are used in `Offer.tsx:117`, `ProductNew.tsx:170,175`, `Products.tsx:138` and `Inventory.tsx:68`.
  - Neither exists in `docs/api/graphql/operations/seller/manifest.json`, which holds only the 7 ops (backend and web copies are identical).
  - `web-shared/src/api/graphql.ts` sends text when an operation isn't in the manifest.
  - In production the backend refuses that text: `backend/src/kernel/config/index.ts:201` (`graphqlPersistedOnly … ?? prod`), `backend/.env.production.example:82`, and `docs/api/graphql/README.md:73` (400 `PERSISTED_QUERY_NOT_SUPPORTED`).
  - `BACKEND-ANSWERS.md` has no R4 row.
- Impact in production:
  - The Offer page shows LoadError (`Offer.tsx:137–138`), so sellers can't create or edit offers.
  - Product submission can't load a draft or choose a category.
  - The category filters on Products and Inventory are empty.
- I validated both texts against `schema.seller.graphql`; they are valid. Persisting them is the only change needed.

**A3 · Medium · SellerOrderDetail extra fields are silently dropped in production**
- Evidence: `seller-center/src/pages/data/orders.ts:33` patches `onLabelQuantity` and `label { id labelUrl }` into the persisted text. In production, `graphql.ts` sends the manifest id and the server runs the manifest text, which lacks both fields (the schema has them: `schema.seller.graphql:1942, 4266`). `Order.tsx:343` `printLabel` then shows "No label file".
- Impact: in production a bought label can only be printed from the purchase dialog. Once the dialog closes, "Print label" says there is no label. `onLabelQuantity` falls back to 0; this is partly covered by the `label_created` shipment status at `Order.tsx:161`.

**A4 · Medium · "Overdue dispatch" opens the Preparing tab, but overdue orders can still be New**
- Evidence:
  - The backend tile is `screenState: 'overdue'` (`backend/src/modules/reports/service/queries.ts:1427`). The overdue count includes status `new` (`orders/repository.ts:256` uses `open` = new/preparing/delayed/partly_shipped; `domain/rules.ts:161`).
  - In web, `data/home.tsx:68` maps `overdue → 'preparing'`. `Orders.tsx:166` computes the overdue alert only on the preparing tab, and `overdueOnly` (an API filter, `repository.ts:216`) is never used.
  - Separately, `due_today` has no mapping and opens New.
- Impact: the tile shows "2 overdue", but the list it opens can miss orders that were never started, which are the most urgent ones. The sidebar count `o.new + o.overdue` (`app/session.tsx:143`) also double-counts overdue New orders.

**A5 · Medium · "Suggest a correction" bypasses the corrections endpoint**
- Evidence: `Offer.tsx:483–486` links to `seller/help?view=contact-seller-support`. The backend has `POST /api/seller/catalog/products/{id}/corrections` (x-screens `seller/offer`, phase 1), which is unused.
- Impact: corrections arrive as free-text support requests and never reach the Catalog team's correction queue. The design label "Suggest a correction" implies the structured flow.

**A6 · Low · Rejected product "See options" opens the Store profile page**
- Evidence: `data/products.ts:108,156` gives the action no `help` flag. `Products.tsx:349` falls back to `navigate(href('seller/store'))`.
- Impact: the button leads somewhere unrelated to the rejection.

**A7 · Low · Stale comments: screen queries "fail on the running server (G13)"**
- Evidence: comments at `Dashboard.tsx:17–18`, `Finance.tsx:19–21`, `Statement.tsx:16–17` and `Performance.tsx:16–17`. `BACKEND-ANSWERS.md` G37 and G63 say `Money.formatted` was fixed everywhere.
- Impact: none functionally, because REST is used. The persisted SellerDashboard, SellerFinanceOverview, SellerStatement and SellerPerformance stay unused on the web, so they are only exercised by Android. Worth re-testing and either using them or updating the comments.

**A8 · Low · Dashboard announcements are always empty**
- Evidence: `reports/service/queries.ts:1501–1502` always returns `announcements: []` and pushes `'announcements'` into `unavailable` ("content has no seller announcements function"). The UI renders them (`Dashboard.tsx:197`), and the design shows an "Announcements" block.
- Impact: only upcoming settings changes appear. See D3.

**A9 · Info · Cross-audience `GET /api/store/identity/security` (asked by coordinator) is not a mismatch**
- Evidence: used at `app/session.tsx:78` (member display name) and `pages/Help.tsx:140` (reply email). The openapi op has `x-auth: account` and the description "Also used by seller members from Seller Center … accept a member session of either audience". `backend/src/kernel/auth/index.ts:79–86` `checkAudience` returns early for `auth === 'account'`.
- Impact: works by design. Two minor costs:
  - Every Seller Center load fetches the full security page (devices, methods) just to read the display name.
  - Seller Center depends on a store-area route. A seller-area `GET /api/seller/identity/me` would be cleaner but is optional.

---

## B. Backend-only (no Seller Center surface)

Verified against template-literal usage. Media uploads, complete, `assets/{id}` and image-specs ARE used via `web-shared/src/api/uploads.ts:55–86` and `imageSpec.ts:88`. `catalog/products/{id}`, offer detail, `shipping/exceptions`, `shipments`, `shipping-setup` and return-case reads are covered by the SellerProductDetail, SellerOrderDetail and SellerReturnDetail screen queries (see their `# replaces:` headers).

**B1 · High · Trust & risk seller surface (all 7 ops, phase 1)**
- Ops: `GET trust/evidence-requests`, `POST …/{id}/answer`, `GET trust/enforcements`, `GET|POST trust/appeals`, `GET|POST trust/reports`.
- Evidence: notice `seller.trust.evidence_requested` is ownerOnly and action-required with a deadline. It links to `seller/notifications` ("Send proof") (`backend/src/modules/notifications/domain/routing.ts:1456–1463`), and Notifications.tsx has nowhere to answer. Trust appeal results link to `seller/performance` (`routing.ts:1477`), but Performance only shows seller restrictions and restriction appeals. Suspended or removed offers show the `appealRoute` text as plain text (`data/products.ts:112–114`).
- Impact: a seller asked for proof of supply can't send it, so the enforcement proceeds by default. Enforcements on offers can't be appealed.
- Hosts: Account health (enforcements, evidence requests, appeals), plus a row action on Products ("Appeal"). Reporting a counterfeit competitor or an abusive customer would sit in Customers and Offer.

**B2 · High · Respond to delivery exceptions (`POST /api/seller/shipping/exceptions/{id}/respond`)**
- Evidence: `Order.tsx:518–520` shows each open exception's `requiredResponse` and deadline as an Alert, with no action. The respond op is unused.
- Impact: the seller is told a response is required (provide tracking, promise a ship-by date, can't fulfil, confirm replacement) but can't give it. The exception escalates or times out. Host: Order detail, with an action on the alert.

**B3 · High · Void a shipping label (`POST /api/seller/shipping/labels/{id}/void`)**
- Evidence: `orders/service/cancellations.ts:430–439` refuses to cancel items on an unhanded label ("Void the label first"), including when a buyer's cancellation request is accepted. `Order.tsx` has no void action; the only label actions are buy and print.
- Impact: a wrong or unneeded label can't be voided (or refunded to earnings), and those items can't be cancelled or the cancellation accepted. Host: Order detail, on the package card.

**B4 · High · Customer cases on orders, and support request detail/reply**
- Evidence:
  - The only `GET /api/seller/support/cases` call uses `scope: 'support_requests'` (`Help.tsx:85`). `customer_cases` is never queried, and `GET support/cases/{id}` is unused.
  - The backend notifies `seller.case.opened` with "Respond", action-required when `handler === 'seller'`, and `seller.case.reply` with "View reply". Both link to `seller/help` (`routing.ts:756–783`).
  - Help's request list rows are not clickable (`Help.tsx:112–123`).
  - Case messages and evidence are only possible for return-linked cases (`Return.tsx:397,426`).
- Impact: a customer case about an order (e.g. not received) that waits on the seller is invisible in Seller Center. A support request's replies can't be read or answered in the app, and offline the email channel doesn't work either.
- Hosts: Help → request detail; Order detail and Returns → "Customer cases" list.

**B5 · Medium · Appeal a dispute decision (`POST /api/seller/support/cases/{id}/appeal`)**
- Evidence: Returns copy says "Each decision has an appeal deadline" (`Returns.tsx:130`). `Return.tsx:506–508` shows the decision with no appeal action.
- Impact: the seller can't appeal before the deadline. Host: Return case, on the decision card.

**B6 · Medium · Report a dispatch delay (`POST /api/seller/orders/orders/{id}/report-delay`)**
- Evidence: `REPORT_DELAY` is in `OrderSellerAction` (`schema.seller.graphql:2240`). `Order.tsx:169–172` reads only `record_shipment`, `cancel_items` and `print_packing_slip`.
- Impact: there is no way to give the buyer a new dispatch date, so a late order just goes overdue. The design has no control for it either (D-candidate). Host: Order detail.

**B7 · Medium · Agreements (`GET sellers/agreements`, `POST …/{key}/accept`)**
- Evidence: `SellerAccount.pendingAgreements` (accounts.ts:157) is not read anywhere in seller-center. The timeline says "New … waiting for the owner's acceptance" (accounts.ts:576), and audit targets use screen `seller/agreements`, which has no catalogue entry.
- Impact: new agreement or fee-schedule versions can't be accepted. Host: Store and settings (new tab) or a Setup/Dashboard alert.

**B8 · Medium · Business details and account lifecycle**
- Ops: `GET sellers/business`, `PATCH …/business/contact`, `POST …/business/change-requests`, `GET sellers/change-requests`, `POST …/change-requests/{id}/withdraw`, `POST sellers/account/close`.
- Evidence: Store TABS (`Store.tsx:50–55`) have no Business tab. Backend audit and notice targets use `seller/business`.
- Impact: contact person and support hours can't be updated; legal name or address changes and closing the account are impossible in-app. Host: Store and settings → "Business" tab (owner).

**B9 · Medium · Product review responses (`GET reviews/product-reviews`), review appeals, report outcomes**
- Evidence: Customers has tabs for messages, questions and feedback only. `POST reviews/responses` is used for feedback, but product reviews that need a response are never listed. `POST reviews/appeals` and `GET reviews/reports` are unused.
- Impact: sellers can't answer product reviews, and moderated answers or responses can't be appealed. Host: Customers (a "Product reviews" tab, plus appeal on held responses).

**B10 · Medium · Shipping: profiles, preview, claims, shipments list**
- Ops: `POST shipping/profiles`, `POST …/profiles/{id}/archive`, `GET shipping/preview`, `GET|POST shipping/claims`, `GET shipping/shipments`.
- Evidence: Shipping.tsx edits existing profiles only (`PUT profiles/{id}`), while Offer and ProductNew let the seller pick a profile.
- Impact: there is no "Large items" profile and no claim recording. The preview of what customers see is missing. Host: the Shipping page.

**B11 · Medium · Return remedies other than refund, and replacement cancel**
- Evidence: `returns.RemedyInput.kind` allows replacement, exchange and store_credit. `Return.tsx:338–341,364` only sends full_refund or partial_refund. `POST returns/replacements/{id}/cancel` is unused. `data/returns.ts:261,265` already labels replacement and exchange.
- Impact: when a customer asked for a replacement or exchange, the seller can only refund. Host: Return case → remedy.

**B12 · Medium · Single-offer lifecycle (`POST offers/{id}/end`, `DELETE offers/{id}`, `POST offers/{id}/pause`)**
- Evidence: Products uses `bulk-pause` and `resume` only. There is no "End offer" or "Delete draft offer".
- Impact: offers can only be hidden, never removed permanently, and draft offers pile up. Host: Products row menu and the Offer page.

**B13 · Medium · Top-bar quick search (`GET /api/seller/search/quick`)**
- Also listed in C1. The search input exists but does nothing.

**B14 · Low · Nice-to-have reads and actions**
- Action history: `GET /api/seller/audit/entries` (Staff/Store).
- Work queue tasks: `GET workqueues/tasks`. It only feeds dashboard tile counts when orders are unavailable (`queries.ts:1470–1477`).
- Seller appeals list and withdraw, and restriction detail (Performance).
- Claim withdraw, collection reordering (`PUT …/collections/order`) and brand requests (Store).
- Discount edit (`GET|PATCH promotions/discounts/{id}`) and invitation detail (Marketing).
- Messaging template edit (`PATCH templates/{id}`).
- Reports: `GET reports/catalogue` (keys are hard-coded in `data/reports.ts:22–26`; the backend has exactly these 3 plus service_performance, so they match today) and `GET reports/exports`.
- Finance: `GET payouts/{id}` and `GET payout-destination`.
- `GET inventory/stock-items/{id}`.
- Media library: list, patch, delete, download, image checks.
- Per-notice archive (a deliberate design choice, `Notifications.tsx:19`).

**B15 · Later phase / integration only**
- Fulfilled by Marketly: 22 ops, `x-phase 4`, no design screens. Inbound shipments, labels, receiving discrepancies, removals, fees, SKU ledger. Dashboard `sales.serviceFees` is also not shown.
- `GET advertising/charges` (phase 3; every seller ads op answers 501, and `Marketing.tsx:43`/`AdRequest.tsx:18` explain it).
- Seller push devices (phase 3, Android).

---

## C. Frontend-only

**C1 · Medium · Seller top-bar search is inert**
- Evidence: `web-shared/src/layouts/BackOfficeLayout.tsx:303–311`. The `<input id="bo-q">` has no handler, and the phone search IconButton has no action. The "/" shortcut only focuses it.
- Impact: "Search orders, products, SKUs", which appears on every design page, does nothing. Wire it to `GET /api/seller/search/quick`.

**C2 · Low · Setup "Help while you set up" uses 2 hard-coded article slugs**
- Evidence: `Setup.tsx:64–67` lists `seller-payout-schedule` and `seller-launch-review`. The design has 4, and G58 says the content isn't seeded.
- Impact: those links break if content renames the slugs. Could read from `GET /api/seller/content/help`.

**C3 · Low · Marketing lists are capped at 100 with no paging**
- Evidence: `Marketing.tsx:90,91,839` use `limit: 100, page: 1` for discounts and for the discount offer picker (active offers).
- Impact: a seller with more than 100 active offers can't pick the rest for a discount.

**C4 · Low · Store tabs "Notifications" and "Staff" both go to the Staff page**
- Evidence: `Store.tsx:50–55`, `Staff.tsx:22–24`.
- Impact: there's no Business or Agreements tab where B7/B8 would live.

**C5 · Low · The session defaults status to `approved` while the account loads**
- Evidence: `app/session.tsx:117` sets `status = acc?.status ?? 'approved'`.
- Impact: the top bar briefly shows "Approved · selling" for suspended or closed sellers. Cosmetic.

Not findings:
- The dev re-auth shortcut `dev-reauth.payout-account` (`Finance.tsx:51`) is gated by `import.meta.env.DEV` and a dev claim, so it is fine.
- There are no `/api/dev` calls in seller-center.
- The `href="#"` anchors all have onClick handlers.

---

## D. Missing (neither side, or the flow breaks between them)

**D1 · High · No invitation-accept page in Seller Center**
- Evidence: backend `backend/src/modules/identity/service/invitations.ts:41–42` builds `${appUrl('seller')}/invitation#token=…` for `seller_member` invitations, and accept supports seller members (`:113–175`). The only `/invitation` route is in `admin-center/src/main.tsx:25`. `seller-center/src/main.tsx` wraps every route in `SellerSessionProvider`, which shows SignIn.
- Impact: people invited from Staff (`POST sellers/invitations`) land on the seller sign-in page with no way to set a password or join, so the staff invite flow is dead. Offline there is also no CLI equivalent of `staff-link` for seller-member links, though seller flows are out of scope offline. Add a Seller Center `/invitation` page using `POST /api/public/identity/invitations/lookups|accept`; existing members confirm with `currentPassword`.

**D2 · Medium · Backend screen ids with no seller screen**
- Evidence: `seller/business`, `seller/agreements` and `seller/appeals` are used in backend notices and audit targets (grep of `backend/src/modules`). `data/home.tsx:58–65` SCREEN_ALIAS doesn't map them, and the catalogue has no such screens.
- Impact: those notices render as non-links (`Notifications.tsx:67–86`).

**D3 · Medium · Seller announcements**
- Evidence: the design dashboard has an "Announcements" block. The content module has no seller announcement source (`queries.ts:1501`).
- Impact: Marketly can't post seller-facing news; only settings changes show.

**D4 · Medium · Dispatch delay and order case handling are not in the design**
- Evidence: the design has no "report delay", exception response or customer case UI on seller-order (grep of `seller-order*.html`).
- Impact: B2, B4 and B6 need design work, not only wiring.

**D5 · Low · Seller sign-in security has no entry point**
- Evidence: there is no link from Seller Center to manage a member's 2-step or password (that lives in the store account security page; the account is shared, realm `member`). The SignIn challenge handles `totp` and `recovery_code` only, although `methods` can include `sms` (`app/SignIn.tsx:7`).
- Impact: this is cross-cutting; flagged for that reviewer.

**D6 · Low · Seeded seller help has 2 of the design's 4 articles (G58)**
- Impact: content and seed only.

---

## E. Internet dependencies (notes)
- Google Fonts are loaded at `seller-center/index.html:8–10` (fonts.googleapis.com, fonts.gstatic.com). The UI falls back to system fonts offline.
- Carrier label quotes and purchase (`POST shipping/labels/quotes`, `POST shipping/labels`, called from `Order.tsx`) and carrier tracking links (`Order.tsx:634`, `Return.tsx:679`).
- Payout account tokenisation and test deposits (`POST sellers/payout-account/change`, `confirm-deposits`), which go through the payout provider and bank.
- Email channels: staff invitations, support `replyChannel: 'seller_center_and_email'` (`Help.tsx:149–152`), and notification emails.
- Help article links may be external (`data/help-articles.ts:77` allows `https:`).
- Store product links leave the app through `APP_URLS` (`web-shared/src/routes/href.ts:23`). Same network, not internet.

## Method / verification notes
- `tsc -p seller-center --noEmit` passes (no request-body type errors). The few `as never` and `as Promise<>` casts were reviewed: SignIn verify, and the period-dashboard spread.
- GraphQL: I validated `gq/SellerProductCard.graphql`, `gq/SellerCategories.graphql`, the patched SellerOrderDetail and all 7 persisted ops against `schema.seller.graphql` with graphql-js (empty `extend type X` lines stripped). All are valid. The web manifest and op texts equal the backend's (ignoring CRLF).
- Every error code compared in seller-center exists in the backend source. Every `can('…')` permission key exists on a seller op.
