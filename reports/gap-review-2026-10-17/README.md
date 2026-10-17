# Marketly gap review: backend vs Customer Store, Seller Center and Admin Center

Review date 2026-10-17. Backend `E:/Work/Ecommerce` main @ d8dc4981. Frontend `E:/Work/Ecommerce-frontend` build/frontend @ 8a0a245a **plus its uncommitted working tree**. Read-only static review: no servers were started, nothing was changed in either repo. `backend:` paths are relative to the backend repo, `web:` paths to the frontend repo.

Detailed reports with full evidence sit next to this file:
[1-store.md](1-store.md) · [2-seller-center.md](2-seller-center.md) · [3-admin-center-part1.md](3-admin-center-part1.md) · [4-admin-center-part2.md](4-admin-center-part2.md) · [5-cross-cutting.md](5-cross-cutting.md) · [6-internet.md](6-internet.md) · [endpoint-inventory.md](endpoint-inventory.md) (every backend op, and every typed call per app). IDs in brackets below (e.g. [S-B1]) point into those files: S = store, SC = seller center, A1 / A2 = admin parts 1 and 2, X = cross-cutting, I = internet.

Severity: **High** = a flow can't finish, data is wrong, or security. **Medium** = a feature is missing or degraded. **Low** = cosmetic or nice-to-have. **Offline?** says whether it matters on the offline staff-only server (Admin Center + Ops only).

---

## 1. The short version

**The contract layer is clean.**
- The frontend's generated `openapi.d.ts` lists exactly the paths in backend `docs/api/openapi.json`, so there is no drift.
- All ~690 distinct typed REST calls match a backend operation.
- All 29 persisted GraphQL operations have the same ids and text on both sides, and all are valid against the schemas.
- Error codes, `Idempotency-Key` (all 50 required ops the web calls send it), `X-Client`, pagination and the upload flow agree.
- The staff changes are adopted: invitation page with pass code, `/reset-password`, no staff 2-step, password re-auth step-up, and no `X-Step-Up-Code` left.

**The gaps are in the other half of each flow.** Pages show the state but can't make the decision, finish the task or change the configuration.
- **Coverage:** of 1,319 backend operations, 624 are never called by any app:
  - store 91 / 264
  - seller 93 / 273
  - admin 434 / 752
  - all 9 webhooks
- **Not gaps:** about 150 of those are false positives (template-literal callers, or reads covered by GraphQL) or deliberately phase 3/4 (wishlist, wallet, Fulfilled by Marketly, transfers and stock counts, seller ads, push).
- **Real gaps:** the rest are real, and many sit on the critical path. The [endpoint inventory](endpoint-inventory.md) lists them all.

**Internet:** the offline server needs no internet to start or to run staff work.
- **Fake providers in production:** every provider (payments, payouts, carriers, email/SMS/push, KYC, malware scan, video transcode) is an in-process dev stub, in production too.
  - That is safe offline, but the online product has no real providers.
- **Offline issues:** six fixes for the offline server (§6). The worst are no time sync, emails recorded as "delivered" though they never leave the server, and video assets stuck in "processing".

## 2. Fix first

### 2a. Matters on the offline staff server (Admin Center + Ops)

| # | Sev | Problem | Where it breaks | Evidence |
|---|---|---|---|---|
| 1 | High (security) | **Staff can't be offboarded.** The backend has disable, enable, lock, unlock, sign-out-all and force-password-reset (`POST /api/admin/identity/accounts/{id}/…`), plus role-assignment revoke and invitation list, resend and revoke. None has UI. `staff-link` can only revoke an *unaccepted* invitation. A leaver keeps access. | Admin › Staff | [A1-D1, X-B1]; `web:admin-center/src/pages/admin/Staff.tsx:70-212` calls none of them |
| 2 | High | **Refunds started by staff are never paid.** Return-inspection remedies, refund-without-return and order exception refunds wait in `under_review`. Nothing calls `POST /api/admin/returns/refunds/{id}/approve` (also decline and revise), and the backend creates no approval request that would show them in Inbox. The UI tells staff "sent to Finance for approval". There is also no design screen for this. | Returns, Ops › Return inspection, Order | [A2-A1, A2-B1, A2-D1]; `backend:backend/src/modules/returns/service/decisions.ts:319`, `handling.ts:195-200` |
| 3 | High | **Ops photo uploads fail.** Admin uploads are created as `ownerKind:'platform'` (`web:web-shared/src/api/uploads.ts:60`), but return inspection and warehouse damage reports require a staff-owned asset (`backend:…/returns/service/handling.ts:107`, `warehouse/service/fulfillments.ts:395`). On top of that, most Ops roles lack `media.assets.manage`. Inspection and damage reports, which need photos, fail with ASSET_NOT_OWNED or 403. There is also a backend conflict: `inventory.reportDiscrepancy` expects a platform owner for the same photos. | Ops › Return inspection, Pick & pack, Receiving | [A1-A27, A1-A28] |
| 4 | High | **The warehouse can't run from a fresh install:** | Ops › Receiving, Pick & pack, Return inspection, Dispatch | [A2-B3, B4, B5, A23, A24, D2] |
|   |   | • No put-away UI. Put-away tasks are created on every receipt and never completed. |   |   |
|   |   | • No bins or box-type setup, and picking requires a bin scan by default (`requireBinScan`). |   |   |
|   |   | • Held fulfilments can't be resumed. |   |   |
|   |   | • Return parcels can't be checked in, so Return inspection never receives anything offline. |   |   |
|   |   | • The 2nd package of an order fails "Buy label" with 422 because the same idempotency key is reused. |   |   |
|   |   | • The Dispatch tab **crashes** once a seller has responded: `sellerResponse` is an object rendered as text (`web:admin-center/src/pages/ops/Dispatch.tsx:44,314,431`). |   |   |
| 5 | High | **Purchasing can't reach Receiving.** Sending a PO creates no delivery, and `POST /purchase-orders/{id}/deliveries` has no UI. "Send" always posts `emailSupplier:true`, but the Add-supplier form has no email field, so the backend refuses. Suppliers have no price-list UI either. | Admin › Purchasing → Ops › Receiving | [A2-A6, B8, B9] |
| 6 | High | **Work items are never worked:** | Ops › Queues | [A2-B6, B7, A10] |
|   |   | • No screen lists, claims, starts, waits on, resolves or dismisses items (the backend has 13 ops for this). |   |   |
|   |   | • The daily routine checks can't be marked done, so they go late every day. |   |   |
|   |   | • Queue leads and backups can't be set. |   |   |
|   |   | • Queue links drop the filter. The Seller-applications queue links back to the queues page itself. |   |   |
| 7 | High | **Decisions with no UI:** | Admin › Sellers, Seller, Seller application, Trust, Promotions, Reviews, Case, Returns | [A2-B2, B12–B16, B18, B21, A11, A16–A20] |
|   |   | • **Return decisions:** approve, reject, take over, overturn, receive. |   |   |
|   |   | • **Sellers:** reinstating a suspended seller, adding or lifting restrictions, deciding appeals, deciding launch reviews (no new seller can go live), recording verification check results (failed checks block approval). |   |   |
|   |   | • **Trust:** accepting recommendations, so no enforcement ever happens. Trust "Clear" always *dismisses*, even when the next step is *resolve*. |   |   |
|   |   | • **Promotions:** flash-sale items, a minimum-spend field (always rejected), seller invitations for seller-funded campaigns, end and cancel. |   |   |
|   |   | • **Appeals:** review appeals (Keep/Remove is refused) and support-case appeals (cases stay open forever). |   |   |
| 8 | High | **Content approval is broken:** | Admin › Help content, Content | [A1-A17, A18, A19, D7] |
|   |   | • "Request changes" always fails for articles and policies: the required `reason`/`note` is never sent. |   |   |
|   |   | • Edits to a live help article can never be approved or published. |   |   |
|   |   | • "New campaign page" leaves drafts that can't be edited and makes SLUG_TAKEN on the 2nd click. |   |   |
| 9 | High (backend) | **Money moves without a password or limits:** | Payouts, Order refund, Finance | [A1-A1, A2, D5] |
|   |   | • Payout-run approval within the approver's own limit skips the step-up (`backend:…/finance/service/payouts.ts:367-376`). |   |   |
|   |   | • Refunds from the Order page skip step-up (`returns/service/refunds.ts:411-418`), and the page has no step-up wrapper. |   |   |
|   |   | • Payment capture, void, resolve-orphan and refund retry/cancel have no limits, approval or step-up at all. |   |   |
| 10 | High | **The Official Store can't run end to end.** There's no UI to create a product or offer, upload images, submit, publish, pause, or cancel a scheduled price change (which locks the price). Hidden products can't be shown again. Catalog "Add product" is a dead end. | Admin › Official, Catalog | [A1-D14, D15, A29, C7, C20] |
| 11 | Medium | **Staff sessions misbehave:** | All Admin pages | [X-A5, A6, A10, D2] |
|   |   | • A refresh refused with 403 `origin_not_allowed` is fatal. Staff who open the server **by IP** or by any name other than `API_URL` are signed out on every reload and after 15 min. |   |   |
|   |   | • `session_idle` isn't handled, so panels show errors instead of the sign-in page. |   |   |
|   |   | • Token expiry uses the PC clock. With no time sync (§6), a fast clock means a refresh before every call, ending in RATE_LIMITED. |   |   |
| 12 | Medium | **No way to operate it without UI or CLI.** Feature flags, search reindex, read-model rebuild, bins and queue leads have neither a screen nor an `npm run` script. As sole maintainer you'd have to hand-craft API calls. | backend `package.json`, MAINTAINING.md | [A2-D6, B22-B24] |
| 13 | Medium | **No approval queue.** Approvals open only from a notice. Nobody can list, return, cancel or resubmit an approval request. The dialog hides the before/after `details`. A new custom role can never get approval limits. | Admin › Inbox, Staff | [A1-D2, C8, C9] |
| 14 | Medium | **Inventory exceptions can't be closed.** Return outcomes and stock discrepancies can't be recorded or resolved, so returned units stay "Returned" and orders with a pick shortage stay held. | Ops › Inventory, Return inspection | [A1-B25] |

### 2b. Blocks the online product (store and seller go-live), not the offline server

| # | Sev | Problem | Evidence |
|---|---|---|---|
| 15 | High | **No real providers.** Payments, payouts, carriers, email/SMS/push and seller KYC are dev stubs in production. The store shows a "Test card" picker and self-approve 3-D Secure buttons in production builds, and ignores `nextAction.url`. | [I-B4–B13, S-A4, S-C1, S-D1] |
| 16 | High | **The Store and Seller Center can't start a session online.** `session.ts` always sends `X-App-Proof: dev`, which production refuses outside the LAN. There is no Turnstile widget. | [X-A3, I-F5]; `web:web-shared/src/api/session.ts:90` |
| 17 | High | **Seller GraphQL (R4 still open).** `SellerCategories` and `SellerProductCard` aren't persisted, and production refuses query text. New product, Create/edit offer and the category filters fail. `SellerOrderDetail` adds `onLabelQuantity`/`label` in dev only, so in production labelled units look shippable again and labels can't be reprinted. | [SC-A2, A3, X-A1, A2] |
| 18 | High | **Links in emails point to routes that don't exist (all three apps).** The backend builds `${appUrl}/${screen}/${id}` (`backend:backend/src/modules/notifications/app/core.ts:259-262`), e.g. `/account/return/<uuid>`, but the store route is `/account/returns/:ref`. Every screen id the backend uses misses its app's routes, including `/admin/...` against the Admin Center at `/`. In-app inbox links are fine: the apps map screen ids through the catalogue. Unsubscribe: the customer link is `/unsubscribe/unsubscribe?token=` (no page, and `POST /api/public/customers/unsubscribe` is never called), and the seller link is `/seller/notifications/preferences?token=` (the Seller Center page is `/notifications`, with no token handling). | [S-A1, S-D2]; verified in this review |
| 19 | High | **Seller staff invitations are dead.** Links go to `SELLER_URL/invitation#token=…` (`backend:…/identity/service/invitations.ts:42`), but only the Admin Center has an `/invitation` page. | [SC-D1, X-B3] |
| 20 | High | **No seller can go live.** On Setup, the backend's CTA for the `launch_review` step ("Ask for the review" → `seller/setup`) is rendered *instead of* the "Request review" button (`web:seller-center/src/pages/Setup.tsx:218` vs `backend:…/sellers/service/accounts.ts:232`). Even if requested, admins can't decide launch reviews (#7). | [SC-A1] |
| 21 | High | **Customer returns get stuck.** The store's return page ignores `Return.actions`: no reply to the seller's question, no tracking for self-shipped returns, no withdraw or escalate. `returns.info-expiry` then auto-cancels the return. | [S-B1] |
| 22 | High | **Seller flows that can't finish:** voiding a label (cancelling labelled items needs it), responding to delivery exceptions, customer cases on orders (never listed), and Trust evidence requests and appeals (an action-required notice with nowhere to answer). | [SC-B1–B4] |
| 23 | Medium | **Google/Apple sign-in buttons were removed** (uncommitted change), but the backend still offers them, and accounts without a password have no set-password flow. Seller sign-in ignores SMS 2-step and drops the forced-reset token. | [X-B4, A4, D4] |

---

## 3. Backend vs Customer Store

**Mismatches**
- High (online): email links go to routes that don't exist (#18) [S-A1].
- Medium: links fall back to the catalogue's *sample* slugs:
  - "Brands" → `/brand/halden`, which doesn't exist.
  - "How results are ranked", "Why these ads?" and the review rules → `/help/articles/track-a-package`, which isn't published.
  - `GET /api/store/search/ranking-policy` is unused.
  
  [S-A2, A3]
- Medium: the bank check ignores `nextAction` and always shows the dev Approve/Fail buttons [S-A4].
- Low: the uncommitted change drops digital-wallet payment, while the backend still enables `walletsEnabled` [S-A5]. There are also stale `as unknown` casts on now-typed storefront schemas [S-A6].

**Backend features with no store UI (real gaps)**
- High: return actions — reply-info, add tracking, withdraw, escalate (#21) [S-B1].
- Medium:
  - failed-refund redirection (`order.refunds` is never shown) [S-B2]
  - the whole customer Trust & Risk surface (reports, evidence answers, appeals) [S-B3]
  - `POST reports/signals` is never sent, so web product views and conversion stay 0 [S-B4]
  - Deals "See all N" is capped at 12 [S-B5]
- Low:
  - withdraw cancellation
  - cart switch-offer and remove-unavailable
  - gift note and hide-prices
  - address validate
  - code check
  - answering other shoppers' questions
  - "what we send" preferences
  - seller collections
  - application withdraw
  
  [S-B6–B10]
- Not gaps:
  - wishlist (18), wallet (5), saved-for-later (4), checkout credit, push — phase 3/4, modules off
  - media — template paths
  - shipping, refunds, documents and case detail — read through GraphQL

**Frontend with no backend behind it**
- Medium:
  - dev payment UI in production builds: the test-card picker, including `tok_pending`, which can never settle [S-C1]
  - header and footer nav are hard-coded, so `content/navigation` edits made in Admin never reach the store [S-C2]
- Low:
  - `/ads/*` and `/design/*` showcase pages with fixture data ship in production [S-C3]
  - static marketing copy and a client-side fee calculator [S-C4]
  - "Create a new seller login" is permanently disabled [S-C5]

**Missing on both sides:** a real payment processor, an unsubscribe landing page, privacy/cookie choices, and "what we send" settings [S-D1–D4].

## 4. Backend vs Seller Center

All 25 designed screens are built. `tsc` passes. All 7 persisted operations and the 3 inline query texts validate.

**Mismatches**
- High:
  - the launch review can't be requested (#20) [SC-A1]
  - non-persisted GraphQL (#17) [SC-A2]
- Medium:
  - label fields dropped in production (#17) [SC-A3]
  - the "Overdue dispatch" tile opens the Preparing tab, missing overdue orders still in New, and the sidebar double-counts them [SC-A4]
  - "Suggest a correction" goes to generic support instead of `POST catalog/products/{id}/corrections` [SC-A5]
- Low:
  - rejected product "See options" opens the Store page [SC-A6]
  - stale "G13" comments [SC-A7]
  - Dashboard announcements are always empty (the backend returns `[]`) [SC-A8]
- Not a mismatch: `GET /api/store/identity/security` from the seller app is allowed (`x-auth: account`). It's heavy just to read a name [SC-A9].

**Backend features with no Seller Center UI**
- High:
  - Trust & Risk: evidence requests, enforcements, appeals, reports — all 7 ops [SC-B1]
  - respond to delivery exceptions [SC-B2]
  - void label [SC-B3]
  - customer cases on orders, and support request detail and reply [SC-B4]
- Medium:
  - dispute-decision appeal [SC-B5]
  - report delay [SC-B6]
  - accept agreements [SC-B7]
  - business details, change requests, account close [SC-B8]
  - product-review responses and review appeals [SC-B9]
  - create or archive shipping profiles, preview, claims [SC-B10]
  - replacement, exchange and store-credit remedies [SC-B11]
  - end, delete or pause a single offer [SC-B12]
  - quick search [SC-B13]
- Low: action history, work-queue tasks, appeals list, collection order, discount edit, reports catalogue, media library, etc. [SC-B14]
- Later phase: Fulfilled by Marketly (22 ops, phase 4), seller ads (phase 3, the UI already explains it), push [SC-B15].

**Frontend with no backend behind it**
- Medium: the top-bar search is inert [SC-C1].
- Low:
  - hard-coded help slugs [SC-C2]
  - marketing lists capped at 100 [SC-C3]
  - two Store tabs point to Staff [SC-C4]
  - status flashes "Approved" while loading [SC-C5]

**Missing on both sides**
- High: an `/invitation` page [SC-D1].
- Medium:
  - backend screen ids with no screen: `seller/business`, `seller/agreements`, `seller/messages`, `seller/returns-settings`, `seller/shipping-settings` [SC-D2]
  - seller announcements [SC-D3]
  - no design for delay, exceptions or cases [SC-D4]
- Low: no security entry point [SC-D5]; 2 of 4 help articles seeded [SC-D6].

## 5. Backend vs Admin Center (Admin + Ops)

Every catalogue screen in scope is built (no PageStub). Step-up via `reauthToken` is correct everywhere it's used. Persisted admin GraphQL matches the backend. One permission key doesn't exist: `notifications.topics.manage`, so the "Topics and templates" link never shows.

**Mismatches (most important)**
- Crash: Dispatch `sellerResponse` [A2-A23].
- 422 on the 2nd package label [A2-A24].
- TrustReport Clear = dismiss [A2-A11].
- Minimum-spend campaigns are always rejected [A2-A17]; flash sales can't be submitted [A2-A16].
- Review and support appeals can't be decided [A2-A19, A20].
- Purchasing always emails the supplier but collects no email [A2-A6].
- Content "Request changes" is missing required fields [A1-A18]; live-article review [A1-A17]; campaign-page SLUG_TAKEN [A1-A19].
- A payout retry is announced as "added to this run" but has `run_id: null` and skips limits [A1-A3].
- Saved order filters are stored in the wrong shape, so counts are wrong [A1-A10]; Orders "Export CSV" never downloads [A1-A11].
- The "Goodwill" reason sends a card refund instead of store credit [A1-A12].
- Dashboard tile colours never show (enum case: `DANGER` vs `danger`) [A1-A20].
- A policy owner's Approve is shown to people the backend refuses [A1-A21]; a hard-coded 14-day policy notice [A1-A22].
- Inspection records only "as described" or "missing parts", and the remedy is refund-only [A2-A3, A4].
- "Full report" links use report keys that don't exist (`campaign-results`, `product-sales-and-margin`) [A2-A21].
- "Schedule email" duplicates schedules that can't be listed [A2-A22].
- Seller note not shown until reload; field-name slips (`setBy` vs `placedBy`) [A2-A13, A14].
- Approving an application on a radio change, with no confirmation [A2-A15].
- Many lists fetch 100 rows and filter in the browser, so open items drop off (Trust, Help, Receiving, reconciliation, disputes, payout runs) [A1-A16, A25, A33; A2-A8, A12, A25].

**Backend features with no Admin UI (core ones; full tables in the part reports)**
- Staff lifecycle (#1), approval queue (#13), coverage, away periods, role edits [A1-B1–B7].
- Finance remedies:
  - refund retry/cancel
  - disputes accept/assign
  - holds, adjustments, amounts owed
  - seller ledger and statements
  - fee rule propose/calculate
  - payout recalculate
  
  [A1-B9–B12]
- Refund approval (#2), return decisions, return-parcel check-in, put-away and bins, pick-pack resume, void label and packing slip [A2-B1–B5].
- Work items, routines, queue setup [A2-B6, B7]; purchasing deliveries, suppliers and claims [A2-B8, B9].
- Shipping configuration (notices can't be withdrawn), and a shipment desk (`POST shipments/{id}/events` is the only way to mark "delivered" offline) [A2-B10, B11].
- Seller enforcement, appeals, launch review, application check results [A2-B12–B14]; Trust decisions and the assessment [A2-B16, B17].
- Promotion lifecycle and codes [A2-B18]; Official Store review responses [A2-B20]; support case actions [A2-B21].
- Content pages lifecycle and navigation editor [A1-B16, B17]; staff messaging (the Official Store can't answer customers) [A1-B18, D3].
- Offers moderation (hold, remove, reinstate), Official product and offer create [A1-B23, B24].
- Inventory exceptions [A1-B25]; media take-down and restore [X-B6].
- Reports saved views and schedules, read-model rebuild [A2-B22]; feature flags and cancelling a scheduled setting change [A2-B23]; search lookup and reindex [A2-B24].
- Phase-gated, so no UI is correct for now: fulfillment service (19 ops, phase 4), transfers and stock counts (phase 4), wallet and wishlist insights (phase 3).

**Frontend with no backend behind it**
- Medium:
  - approval limits worked out in the browser instead of `POST access/authority-checks` [A1-C1]
  - fee-rule links go in a circle [A1-C2]
  - disabled "Statements", "New offer", "Upload price file", "Create case" and "Attach file" buttons, although the backend supports them [A1-C3, C7; A2-C5]
  - dispute evidence is text-only [A1-C5]
  - "Add section" is always `featured_products` [A1-C6]
  - the routine card is display-only [A2-C2]
  - the "Put away" step is only a text field [A2-C3]
  - "Save view" works, but saved views can't be opened [A2-C6]
  - sellers are linked to their application by matching the name in the browser [A2-C7]
  - "can't price at a loss" is enforced only in the UI [A1-C21]
  - the top-bar search is inert [A2-C1]
- Low:
  - hard-coded policy text, time zones (PT/ET), "Reno, NV", "Packing station 2" and printer PS-2 [A1-C11, C23; A2-C8]
  - `/design` ships in the production Admin build [X-C2]
  - fixture staff names on unauthenticated layouts [X-C1]

**Missing on both sides (no design either)**
- Refund approval, warehouse setup and put-away, and decision surfaces (return decisions, seller appeals and launch reviews, Trust recommendations, work-item detail) [A2-D1–D3].
- Payment, seller finance, campaign page, navigation and About editors [A1-D4]; return policy admin [A2-D5].
- Orders can't be filtered by customer (the spec lacks `customerId`) [A1-D8]; no admin override of customer cancellations [A1-D9].
- Backend-side checks:
  - pages lack the same-reviewer check [A1-D6]
  - `HelpArticleAdmin` has no draft-review state [A1-D7]
- Backend screen ids with no Admin screen, so their notice and audit links go nowhere: `admin/appeals`, `admin/applications`, `admin/customer`, `admin/offer`, `admin/refunds`, `admin/return`, `admin/returns-policy`, `admin/seller-changes`, `admin/seller-invitations`, `admin/seller-targets` (verified in this review).
- "View on store" and preview links are dead offline, because the store isn't deployed [X-D1].
- Open web-team requests still open in the code: G85, G89, G90, G91, G92, R4. G75 is half-adopted [A2-D8].

## 6. Everything that needs internet access

**Backend runtime**

| Dependency | Where | Offline behaviour |
|---|---|---|
| Cloudflare Turnstile siteverify (the **only** real outbound `fetch` in `backend/src`) | `backend:backend/src/kernel/auth/app-proof.ts:52-60` | Not reached offline (`APP_PROOF_LOCAL_NETWORK=true`, `TURNSTILE_SECRET` unset). If enabled, it has no timeout and a failure becomes a 500. |
| Google Play Integrity (Android app proof) | `app-proof.ts:39-63` | Not wired; LAN callers are exempt. |
| Google/Apple ID-token verification | `identity/module.ts:27-28` | Dev verifier only; production answers 501. |
| Payment processor (cards, 3-DS, disputes) | `payments/module.ts:26` | Dev stub **in production**: money is simulated. |
| Payout provider (ACH, micro-deposits) | `finance/module.ts:26-27` | Dev stub in production: payouts are simulated. |
| Carrier rates, labels, tracking polls | `shipping/module.ts:25-26` | Dev stub: invented labels and scans, and nothing ever produces "delivered". |
| Carrier tracking web pages (ups.com, usps.com, fedex.com, ontrac.com) | `shipping/domain/tracking.ts:34-65` | Dead links offline (Admin Order, Seller Order/Return, store Tracking). |
| Email / SMS / push (FCM) providers | `notifications/module.ts:28-34` | Dev stubs: nothing leaves the server, yet deliveries are recorded as **`delivered`**. |
| KYC/KYB, sanctions, tax-id, payout tokeniser | `sellers/module.ts:25-26` | Dev stub: every check passes unless the name contains "fail" or "attention". |
| Address validation | `customers/module.ts:23-24` | Dev only; production uses format rules. |
| Malware scanner | `media/module.ts:34` | Dev stub (detects only the EICAR test string). |
| Video transcoding + result webhook | `media/service.ts:1139-1141` | **Never completes**: video ad assets stay "processing" forever. |
| 9 inbound webhooks (payments, carriers, email/SMS events, inbound email, payouts, verification, media) | `/webhooks/*` | Idle offline; refused while `WEBHOOK_SECRETS` is unset. |
| Links in settings: `apps.android.updateUrl` = play.google.com | `settings/domain/catalogue.ts:154` | Data only. |
| Breached-password check | `identity/domain/policy.ts` | Already offline (built-in list). |
| Tax, image processing (sharp), storage, search (Mongo) | — | Local; no internet. |

**Tooling, deploy and OS:**
- `npm run package` needs the npm registry on the **build PC** only. The release tarball carries `node_modules`.
- The Node and MongoDB `.deb` files are downloaded elsewhere and carried over on USB.
- No apt, NodeSource, certbot or curl runs on the server. The certificate comes from a local CA.
- **Time sync isn't set up**: Ubuntu tries `ntp.ubuntu.com` and fails silently.
- `mongosh` telemetry fails quietly in `marketly check`.
- `mongodb-memory-server` downloads its binary in dev/test only.
- The real-product import (DummyJSON / Open Food Facts) has been removed; its images are now local files.

**Frontend:**
- **Google Fonts** in `web:frontend/index.html:8-10` and `web:seller-center/index.html:8-10`. The Admin Center already bundles its fonts, and its CSP is `default-src 'self'`.
- **Turnstile** widget needed online (#16).
- **Payment provider** hosted card fields and the 3-DS redirect.
- **Google/Apple** sign-in SDKs, if they are re-added.
- **Carrier tracking** buttons.
- **External links** in CMS help content and seller notices.
- **`mailto:` links.**
- **Admin text promising email**:
  - "emailed to you every Monday" and "Schedule email" (`Reports.tsx:59,98`)
  - "The applicant gets your explanation by email" (`SellerApplication.tsx:251`)
  - "sent by email" (`Inbox.tsx:269`)
- **Design-check previews** load Google Fonts (dev only).

**Data:**
- Local MongoDB 27017 and 27018 hold no internet image hosts; images are served from the API's `/files`.
- The internet URLs stored are carrier tracking links, the Play Store link, and `example.com` placeholders.
- Order-item, return and conversation snapshots keep the image host they were saved with, so renaming the server breaks those images.

**Must fix for the offline deployment (none blocks startup):**
1. **Time sync** from a LAN source (chrony or timesyncd), plus a clock check in `marketly check`. This also fixes the token-skew risk in #11.
2. **Email** recorded as `not_sent`/`offline` instead of `delivered`, a flag so the Admin Center hides "Schedule email", and reworded "by email" text.
3. **Video ad assets:** refuse them offline, or serve the original, plus a timeout that fails stuck transcodes.
4. **Carrier tracking buttons:** hide them in the Admin Center, or show the number with "needs internet".
5. **Simulated providers:** label them in the Admin Center (payouts, refunds, labels and KYC don't move real money or parcels).
6. **Turnstile:** leave it unset. If it's ever enabled, add a timeout to the fetch.

**Online go-live needs internet for:**
- real payment, payout, carrier, email/SMS/push and KYC adapters
- Turnstile in the Store and Seller Center
- Play Integrity
- Google/Apple sign-in
- `WEBHOOK_SECRETS` and inbound webhook reachability
- bundled fonts for the Store and Seller Center, recommended for privacy and CSP

## 7. Checked and consistent (no action)
- **Contract:** openapi paths match one-to-one. Every typed call has a backend op, and request bodies type-check (`tsc` passes in the Seller Center).
- **GraphQL:** 29/29 persisted operations are identical by AST and id, and schema-valid. 16 of them are unused by the web and kept for Android.
- **Conventions:** the error envelope and codes, `X-Client: web`, pagination (all 199 list ops take page and cursor), and `Idempotency-Key` (50/50 of the required ops the web calls).
- **Uploads and files:** the upload flow (uploads → content → complete → poll) and signed `/files` links.
- **Staff security:** the staff invitation (link + pass code), `/reset-password`, password re-auth with 4 purposes, and no staff TOTP or `X-Step-Up-Code`.
- **Dev paths:** `/api/dev/payments/.../settle` is reachable only in dev builds against dev backends.
- **Serving the Admin Center:** it works served by the API over HTTPS on one origin (`/ops`, `/invitation` and `/reset-password` fall through to the app; no inline script; CSP satisfied).
- **Realtime:** the backend has no SSE or websocket, and the apps poll every 60 s; neither side expects push.
