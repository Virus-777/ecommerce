# Admin Center review, part 2: promotions, purchasing, reports, returns, reviews, search, sellers, settings, shipping, support, trust, wallet, warehouse, wishlist, workqueues

Read-only review. Backend `E:/Work/Ecommerce` (main d8dc4981); frontend `E:/Work/Ecommerce-frontend` (build/frontend working tree). `web:` paths are relative to the frontend repo and `backend:` paths to `backend/src/modules/` unless they say otherwise.

Detailed notes for four slices are in the scratchpad: `sub-ops.md`, `sub-ret-pur-ship.md`, `sub-promo-misc.md` and `sub-sellers-trust.md`. Their High findings were re-checked in the code before being included here. I reviewed the Ops screens, the work queues and the open-gap checks myself.

## Executive summary
1. **The calls the pages make are mostly correct, with one crash.** The Dispatch tab goes blank when a seller has responded (A23). Bodies, enums, money in minor units, Idempotency-Key and reauth-token step-up all check out. No X-Step-Up-Code or staff TOTP is left in the code (one stale comment). AdminCase, AdminDashboard and AdminSeller match the backend's persisted operations and the schema. The problem is the other half of each flow: decide, finish and configure actions have no UI.
2. **High: refunds that staff start are never paid.** Return-inspection remedies, refund-without-return and exception refunds all wait for Finance approval in `under_review`. Nothing calls `POST /api/admin/returns/refunds/{id}/approve`, and no approval request is created that would surface them in Inbox.
3. **High: the Official Store warehouse can't work from a fresh install.**
   - Received units are never put away (no put-away UI).
   - Bins and box types can't be created.
   - Picking requires a bin scan by default.
   - A fulfillment on hold can't be resumed.
   - Return parcels can't be checked in, so Official Store returns never reach the "received" tab of Return inspection.
4. **High: Purchasing can't reach Receiving.**
   - Sending a PO creates no delivery, and adding a delivery has no UI.
   - Suppliers added in the app have no email and no price list, yet "Send" always asks to email the supplier, which the backend refuses without an email.
5. **High: no seller lifecycle decisions after approval.** There is no reinstate, no restrict or lift, no appeal decision and no launch-review decision. Offers wait for the launch review, so no new seller can go live. Checks that fail or need attention block application approval, and nothing can clear them.
6. **High: Trust can't finish anything.**
   - "Clear" always dismisses, even where the next step is "resolve".
   - Owner teams can't accept recommendations, so enforcement never happens.
   - Trust appeals can't be decided.
7. **High: promotions and appeals gaps.**
   - Flash sales and minimum-spend campaigns can't be submitted.
   - Seller-funded campaigns never invite sellers.
   - Campaigns can't be ended or cancelled.
   - Support appeals and review appeals can't be decided.
8. **Work queues:** Ops staff never see, claim, start, wait on or resolve work items (27 ops unused). The daily routine checks can't be marked done. Queue leads and backups are "Not set" and can't be set. Queue links lose their filter, and the Seller applications queue links back to the queues page itself.
9. **Unused features that would be backend-only even with a UI:** wallet and wishlist insights are phase 3 (module off, so no UI is fine). Search admin, feature flags, read-model rebuild and reindex have no UI and no CLI, which is a real gap for the single offline maintainer. The top-bar search is a dead input.
10. **Internet:** shipping always uses the dev carrier adapter, which invents scans, and seller KYC uses dev providers. Things that need email or webhooks fail offline: supplier PO emails, report schedules, seller invitation codes and carrier "delivered" events. With no carrier webhooks, `POST /shipping/shipments/{id}/events` (no UI) is the only way to mark a parcel delivered.

**Counts:** A 25 · B 24 capability groups · C 12 · D 8 · E 7

---

## A. Mismatches (the frontend uses the backend differently from how it behaves)

### Returns, refunds and inspection
- **A1 · High · Staff refunds are stuck in `under_review`.**
  - Evidence: backend `returns/service/decisions.ts:319` and `handling.ts:195-200`. Admin approve-without-return and admin remedy insert the refund as `under_review` with no `decideOrQueue` call, so no access approval request is created. `decideOrQueue` is only reached from `createException` (`refunds.ts:285,411`).
  - Frontend: web has no call to `/api/admin/returns/refunds/{id}/approve|decline|revise`. `Finance.tsx:158` only lists failing *payments* refunds. The UI tells staff "sent to Finance for approval" (`admin-center/src/pages/admin/Returns.tsx:190`, `ops/ReturnInspection.tsx:368`).
  - Impact: customers on Official Store or platform-handled returns are never refunded.
- **A2 · Medium · Exception refunds from the order page are silently lost when the proposer has no refund-approval authority.**
  - Evidence: backend `returns/service/refunds.ts:411-429` does nothing on `denied`. web `admin/Order.tsx:201-215`.
  - Impact: the refund stays in review with no approval request and no screen.
- **A3 · Medium · Inspection can only record "as described" or "missing parts".**
  - Evidence: web `ops/ReturnInspection.tsx:350-353` derives `conditionOutcome` from missing parts only. The backend enum also has `damaged_by_customer | not_matching_request | wrong_item_returned | empty_package` (openapi `returns.InspectionInput`).
  - Impact: wrong-item and empty-box returns can't be recorded as such, and the refund basis is wrong.
- **A4 · Medium · The inspection remedy is only a full or partial refund.**
  - Evidence: web `ReturnInspection.tsx:357-362`. The backend `RemedyInput.kind` also has `replacement | exchange | store_credit`.
  - Impact: replacements and exchanges for Official Store returns can't be chosen.
- **A5 · Medium · "Send to Finance" (refund without return) ignores `allowedActions`.**
  - Evidence: web `admin/Returns.tsx:172`. backend `returns/service/views.ts:451` and `decisions.ts:295`.
  - Impact: the button is active on received, decided or closed returns and then fails with ILLEGAL_TRANSITION.

### Purchasing and receiving
- **A6 · High · "Send to supplier" always posts `emailSupplier: true`, but the Add-supplier form collects no email.**
  - Evidence: web `admin/Purchasing.tsx:327` (send) and `:391` (supplier body: name, contactName, leadTimeDays, notes). backend `purchasing/service/purchase-orders.ts:179` refuses when the supplier has no email. `SupplierInput.email` exists.
  - Impact: a PO for any supplier created in the app can never be sent, and offline the email can't go out anyway.
- **A7 · Low · The supplier city goes into `notes`, but the table reads `location`.**
  - Evidence: web `Purchasing.tsx:391` vs `:159`. backend `purchasing/service/suppliers.ts:69` sets `location` from `address`.
  - Impact: suppliers created in the app show no location.
- **A8 · Low · Receiving finds the inventory inbound by listing 100 inbounds and matching `receiptId`, instead of using `Receipt.inboundId`** (added for G75).
  - Evidence: web `ops/Receiving.tsx:507-509`; openapi `purchasing.Receipt.inboundId`.
  - Impact: once there are more than 100 inbounds, "make available" is silently skipped, and the user is told Inventory will confirm.

### Warehouse (Pick and pack)
- **A9 · Low · The "Picked" button sends the expected bin and SKU as if they had been scanned.**
  - Evidence: web `ops/PickPack.tsx:464` (`binCode: next.line.binCode, itemCode: next.line.sku`). The backend's `requireBinScan` and `requireItemScan` (`warehouse/service/fulfillments.ts:308-316`) are then satisfied without a real scan.
  - Impact: the scan check can be bypassed. This may be intended for keyboard use; worth a decision.

- **A23 · High · The Dispatch page crashes once a seller has responded to an exception.**
  - Evidence: web `ops/Dispatch.tsx:44` types `sellerResponse` as a string, and `:314` returns it from `response(r)`, which is rendered as a React child at `:431` and `:475`. The backend sends an object (`shipping.SellerResponse {action, note, shipBy, at, by}`, openapi `shipping.DeliveryException.sellerResponse`).
  - Impact: React throws "Objects are not valid as a React child", and that Dispatch tab goes blank.
- **A24 · Medium · The second package of an order fails at "Buy label" (422).**
  - Evidence: web `ops/PickPack.tsx:495` creates one `labelKey` per packing-station mount (keyed by order, `:832`), and `:549` reuses it for every package. backend `kernel/http/idempotency.ts:4,51` and `register.ts:183`: keys are scoped to the operation and the caller, and the request hash includes the path params, so another package id → `IDEMPOTENCY_KEY_REUSED`.
  - Impact: multi-package orders can't be labelled without reloading the page. Found by the Ops sub-review; I checked the hash logic.
- **A25 · Low · Receiving loads 100 deliveries with no status filter and picks the delivery by PO ref** (`ops/Receiving.tsx:141`).
  - Impact: older deliveries drop off the list, and a PO with several deliveries may open the wrong one. This comes from the Ops sub-review; the "wrong delivery" part is not re-verified.

### Work queues
- **A10 · Medium · Queue links drop the backend's screen filter, and some queues link to the queues page itself.**
  - Evidence: backend `workqueues/domain/catalog.ts:107-140` sends `screen`/`screenFilter` values such as `missing_tracking`, `appeals`, `launch_reviews`, `escalated` and `parcels`. web `admin-center/src/app/parts.tsx:57-68` (`screenHref`) keeps a filter only if it equals a catalogue view slug (hyphenated, e.g. `missing-tracking`). It returns `undefined` for screens that need a `:ref` (`admin/seller-application`), and `ops/Queues.tsx:95` then falls back to `ops/queues`.
  - Impact: "Open" on a queue lands on an unfiltered screen, or loops back to My work queues for Seller applications.

### Trust and sellers
- **A11 · High · TrustReport "Clear" always calls `dismiss`, even when the backend's next step is `resolve`.**
  - Evidence: web `admin/data/trust-reports.ts:145` (`'resolve' → 'clear'`) and `admin/TrustReport.tsx:222-225`. backend `trust/service/reports.ts:960-1009`: resolve records the outcome and checks for open recommendations; dismiss records `dismissed` and skips that check.
  - Impact: reports where action was taken are stored as dismissed, the reporter is told "no action", and reports can close while recommendations are still open.
- **A12 · Medium · The Trust queue fetches every status (100 max) and filters in the browser; it also loads each card's detail separately (N+1).**
  - Evidence: web `admin/Trust.tsx:228-235` and `TrustReport.tsx:174`. The spec offers `status=active`.
  - Impact: open reports can be missing from the queue and from J/K navigation.
- **A13 · Medium · A seller note saves but doesn't appear until reload.**
  - Evidence: web `admin/Seller.tsx:139` caches the detail by slug; `:209` invalidates by the UUID.
  - Impact: staff are likely to add duplicate notes.
- **A14 · Low · Small field mismatches on the Seller page.**
  - Hold "Set by" reads `setBy`, but the backend sends `placedBy` (web `admin/data/seller.ts:75`, `Seller.tsx:611`).
  - The REST fallback for obligations reads `itemTitle`, `statusLabel` and `deadline`, which are not in `OverdueOrderRef` (`data/seller.ts:88`).
  - `CLOSED_GROUP` lists `IN_TRANSIT`, which is not an OrderGroupStatus (`data/seller.ts:114`).
- **A15 · Low · Approving an application happens on a radio `onChange`, with no confirmation.**
  - Evidence: web `admin/SellerApplication.tsx:403`. The backend's approve options (`note`, `conditions`, `recommendedHoldDays`) are not offered, and "pending" checks are counted as "need attention".
  - Impact: one mis-click approves a seller, and conditional approval is not available.

### Promotions, reviews, support and reports
- **A16 · High · Flash-sale campaigns can't be submitted or scheduled.**
  - Evidence: no frontend call to `PUT …/campaigns/{id}/flash-items`. backend `promotions/service/campaigns.ts:573,713` refuses with "Add flash items first".
  - Impact: the "Flash sale" type in `admin/PromotionNew.tsx` always fails.
- **A17 · High · Minimum-spend campaigns are always rejected.**
  - Evidence: web `PromotionNew.tsx:222` sends the value as `amountOff` and never sends `discount.minSpend`. backend `promotions/domain/rules.ts:369-371` returns "Set the minimum spend".
  - Impact: this campaign type can't be saved, and the form has no threshold field.
- **A18 · High · Seller- or shared-funded campaigns never invite sellers.**
  - Evidence: backend `promotions/domain/rules.ts:418` and `service/participation.ts:102-110`: invitations go out only through `POST …/invitations`, which nothing calls. web `PromotionNew.tsx:770` says invitations "go out once Finance confirms".
  - Impact: these campaigns run without any seller offers.
- **A19 · High · Review appeal items appear in the Reported tab, but deciding them is refused.**
  - Evidence: web `admin/data/reviews.ts:25` (`queue === 'appeal'` counts as reported) and `admin/Reviews.tsx:200`. backend `reviews/service/moderation.ts:676` refuses: "decide the appeal instead".
  - Impact: every Keep or Remove on these items errors, and the appeal stays open.
- **A20 · High · Appealed support cases can't be decided.**
  - Evidence: the store sends appeals (`frontend/src/pages/help/Case.tsx:183`). backend `spec/support.ts:2543-2546`: `appealed` only leaves through `decideAppeal`. web `admin/Case.tsx` never calls `POST …/cases/{id}/appeal/decide`.
  - Impact: appealed cases stay open forever.
- **A21 · Medium · "Full report" links use report keys that don't exist.**
  - Evidence: web `admin/Promotions.tsx:250` (`campaign-results`); outside this scope, `Official.tsx:248` (`product-sales-and-margin`). backend `reports/domain/catalogue.ts` uses `marketing.campaigns` and `trading.margin`.
  - Impact: both links open "Report not found".
- **A22 · Medium · Report "Suggest a change" says the owner was notified, but nothing notifies anyone; "Schedule email" adds a duplicate weekly schedule on every click.**
  - Evidence: web `admin/Report.tsx:148,155` and `admin/Reports.tsx:57-58`. backend `reports/service/definitions.ts:261-270` (no event published) and `:456-497` (no de-duplication).
  - Impact: suggestions go nowhere, and schedules pile up that can't be listed or stopped.

What I checked and found consistent:
- Dispatch exception actions (escalate `to` and `reason`, request-tracking `dueAt`, resolve kinds).
- Carrier claim money in cents.
- Warehouse bodies: damage, shortage, wave, package PATCH, and label with Idempotency-Key.
- Receipt PATCH and submit.
- Queues `all=true` (G64e).
- Suspend and PATCH restriction (typed).
- Settings changes with the reauth token through Inbox.
- Support decide with Idempotency-Key.
- Signed `/files/` links: an HMAC link checked by `kernel/auth/file-links.ts` counts as the token, and `admin/data/reports.ts:83-92` keeps the path on the app's own address.

---

## B. Backend-only capabilities (grouped; host screen; rating)

Phase check: every in-scope admin endpoint is phase 1 or 2 (live at `LAUNCH_PHASE=2`), except wallet (10 ops) and wishlist insights, which are phase 3 and off (`docs/api/spec/modules/*.json`). Template-literal use was grepped; the "unused" lists hold.

| # | Capability (unused ops) | Host screen | Rating |
|---|---|---|---|
| B1 | **Finance refund approval**: `GET /returns/refunds[/{id}]`, `POST …/approve` (reauthToken above the limit), `/decline`, `/revise` | New `admin/finance` view "Refunds to approve" (none in the design; backend points to `admin/refunds`, which is not a catalogue id) | **Core (High)**: see A1 |
| B2 | **Return decisions**: `POST /returns/requests/{id}/approve`, `/reject`, `/take-over`, `/overturn`, `/assign`, `/receive`; `POST /returns/replacements/{id}/cancel` | `admin/returns` drawer; today it is always the refund-without-return form, `Returns.tsx:474` | **Core (High)**: Official Store returns outside the auto-approve window and seller returns needing the platform get stuck |
| B3 | **Return parcels at the warehouse**: `GET`/`POST /warehouse/return-parcels`, `POST …/{id}/hand-over` | `ops/return-inspection`. Its "arriving" rows have no action (`ReturnInspection.tsx:117-118`); the backend routes queue `warehouse.return_parcels` there with filter `parcels` | **Core (High)**: per `docs/api/modules/returns.md:1545`, Official Store parcels are scanned in by the warehouse. Offline (no carrier "delivered" events) nothing else moves a return to `received`, so nothing can be inspected |
| B4 | **Put-away and bins**: `GET /warehouse/putaway-tasks`, `/labels`, `POST …/{id}/complete`; `GET`/`POST`/`PATCH /warehouse/bins`; `PUT /warehouse/stock-items/{id}/bins`; `PUT /warehouse/box-types`; `GET /warehouse/scan` | `ops/receiving` step 4 "Put away" (shown in the stepper, `Receiving.tsx:109`, but never done); `ops/inventory`; warehouse setup (no design) | **Core (High)**: put-away tasks are created on every receipt (`warehouse/service/putaway.ts:40-75`) and never completed. Bin assignments come only from put-away or the bins PUT (`putaway.ts:102-109`). `requireBinScan` defaults to true (`warehouse/service/core.ts:100`), and picking refuses without an active bin (`fulfillments.ts:309-312`). Bins exist today only because the simulator makes them over the API (`backend/tools/simulate/flows/catalog.ts:128-134`) |
| B5 | **Pick and pack follow-ups**: `POST /warehouse/fulfillments/{id}/resume`, `POST /packages/{id}/void-label`, `GET /packages/{id}/packing-slip`, `GET /waves/{id}` | `ops/pick-pack`. On-hold orders show only an alert (`PickPack.tsx:631,643`) | **Core**: held orders stay held unless inventory reallocates; a label for the wrong service can't be voided; no packing slip is printed |
| B6 | **Work item lifecycle**: `GET /workqueues/items[/{id}]`, `POST items` (manual task), `/claim`, `/start`, `/wait`, `/resume`, `/resolve`, `/dismiss`, `/reopen`, `/escalate`, `/assign`, `/notes`, `items/bulk-assign` | `ops/queues` (design shows queues only; "Assigned to me" has no drill-down) | **Core**: most items close themselves from source events (`docs/api/modules/workqueues.md:425`), but manual tasks, waiting on someone and dismissing false alarms need these. Today no Ops screen claims or completes a task |
| B7 | **Routine and queue setup**: `POST /workqueues/routine-checks/{id}/complete`, `GET`/`PUT routine-templates`, `POST`/`PATCH queues`, `GET queues/{key}`, `intake-rules`, `coverage-gaps`, `summary`, `day-end-reviews` (history), `DELETE`/`PATCH saved-filters` | `ops/queues` "Today's routine" card is read-only (`Queues.tsx:446-488`); queue editor (no design) | **Core**: routine checks can only be done through `complete` (`workqueues/app/routines.ts:145-163`), so the routine stays "0 of N" and turns late every day. Leads and backups are unset in the seed (G71) and can't be set |
| B8 | **Purchasing after send**: `POST /purchase-orders/{id}/deliveries`, `PATCH /deliveries/{id}`, `POST …/close`, `POST /purchase-orders/from-suggestions`, `GET /receipts`, `POST /receipts/{id}/cancel` | `admin/purchasing` PO drawer; `ops/receiving` | **Core (High)**: deliveries are only created by `addDelivery` (`purchasing/service/deliveries.ts:28-41`), so sent POs never appear in Receiving (`Receiving.tsx:141` lists deliveries only) |
| B9 | **Supplier maintenance and claims**: `PATCH /suppliers/{id}`, `PUT /suppliers/{id}/items` (price list), `GET /claims`, `POST /claims/{id}/submit`, `/settle`, `/close` | `admin/purchasing` Suppliers tab; a Claims tab | **Core**: a new supplier has no lines to order (`Purchasing.tsx:393,809`); claims never resolve |
| B10 | **Shipping configuration**: carriers `POST`/`PATCH`; zones; methods `PUT`; Official Store profiles `POST`/`PUT` (rates); free-shipping rules `POST`/`PUT`; `PUT dispatch-targets`; notices `PATCH` and `/withdraw` | `admin/shipping` (read-only apart from the service on/off switch and deleting draft notices, `Shipping.tsx:506`) | Core for notice withdraw/edit and Official Store rates (a live notice can't be taken down); nice for zones and carriers (carriers are out of scope offline) |
| B11 | **Shipment desk**: `GET /shipping/shipments[/{id}]`, `POST …/correct-tracking`, `POST …/events`, `POST /exceptions` (open manually), `/exceptions/{id}`, `/assign`, `POST /claims/{id}/status` | `ops/dispatch`, `admin/order` | **Core offline**: `events` is the only way to record "delivered" without carrier webhooks; carrier claims opened in Dispatch (`Dispatch.tsx:258`) never move on |
| B12 | **Seller enforcement**: `POST /sellers/sellers/{id}/reinstate`, `/restrictions`, `restrictions/{id}/lift`, `/warnings`, `warnings/{id}/resolve`, `/close`, `/verification`, `/account-manager` | `admin/seller` header and restriction cards (`Seller.tsx:365-402`: only Message, Edit restriction, Suspend; Suspend is hidden once suspended) | **Core (High)**: a suspended seller can never be reinstated; restrictions can't be created or lifted |
| B13 | **Seller appeals and launch review**: `GET /sellers/appeals`, `/appeals/{id}/assign`, `/decide`; `POST /sellers/sellers/{id}/launch-review/decide` | `admin/sellers` (`views: []`; backend links filters `appeals` / `launch_reviews`) | **Core (High)**: offers wait for `launchReady` (`offers/service/manage.ts:476-478`), which only `launch-review/decide` sets (`sellers/service/accounts.ts:61,305`), so new sellers can't go live |
| B14 | **Application checks and risk**: `POST /sellers/applications/{id}/checks/{checkId}/result`, `/rerun`, `/trust-review` | `admin/seller-application` "Verification checks" card (read-only, `SellerApplication.tsx:581-602`) | **Core (High)**: approval is blocked by failed checks or unaccepted "needs attention" checks (`sellers/service/applications.ts:759-763,1083`); only these ops clear them |
| B15 | **Seller admin extras**: `GET`/`revoke` seller-invitations, `PUT performance-targets`, `claims/{id}/revoke` | `admin/sellers`, `admin/settings` | Nice |
| B16 | **Trust decisions**: `GET /trust/recommendations` + `/decide` + `/withdraw`; `appeals/{id}/assign` + `/decide`; `reports/{id}/resolve` + `/reopen`; `GET /enforcements` + `/reverse` | `admin/trust-report`, `admin/trust` (appeals card read-only) | **Core (High)**: routed recommendations (suspend, hold payouts, restrict listing; `trust/service/actions.ts:124-137`) are never accepted, so no enforcement happens |
| B17 | **Trust investigation tools**: `POST /trust/reports` (staff-opened), `/notes`, `/evidence`, `/links`, `/escalate`, `/assessment`, `/risk-score`, `/merge`; detection rules `GET`/`PATCH` | `admin/trust-report`, `admin/trust` | Core for `assessment`: seller-application risk reviews wait on it. Nice for the rest |
| B18 | **Promotion lifecycle**: `POST /campaigns/{id}/end`, `/cancel`; `GET`/`PUT flash-items`; `/invitations`; `participations/{id}/remove`, `/decide-withdrawal`; codes `GET`/`POST`/`deactivate` | `admin/promotions`, `admin/promotion-new` | **Core**: a wrong campaign can only be paused; leaked codes can't be deactivated; seller withdrawal requests (sent from Seller Center) stay pending |
| B19 | **Campaign insight**: `history`, `redemptions`, `results`, `eligible-offers` | `admin/promotion-new` side panel | Nice |
| B20 | **Reviews**: `appeals` + `decide` (core, A19); `official-store/reviews` + responses `POST`/`PATCH`; `questions`; `reviews` (search); `moderation-items/summary` | `admin/reviews` new tabs | Core for appeals and Official Store responses (the Official Store can't answer its own reviews or unanswered questions); nice for search and summary |
| B21 | **Support case actions**: `POST /support/cases` (open on behalf), `PATCH cases/{id}`, `/appeal/decide`, `/evidence`, `/remedies/{id}/settle`, `/reopen`, `/request-info`, `DELETE decision-draft`, `PUT categories/{key}` | `admin/case`, `admin/cases` | **Core**: Resolve stays disabled until every remedy is settled (`Case.tsx:414,650`), so remedies completed outside the system block resolution. Phone and email complaints can't be logged |
| B22 | **Reports administration**: saved views `GET`/`DELETE`, schedules `GET`/`DELETE`, metric registry (create, revise, publish, retire, owners, suggestion decide), `export-datasets`, `read-models` + `rebuild` | `admin/reports`, `admin/report` "definitions" view | Saved views and schedules lists are core (they are already being created). Read-model rebuild is internal but needed offline (no CLI). Metric registry is nice |
| B23 | **Settings**: `GET`/`PUT feature-flags` (wishlist, paidSellerAds, externalSignIn, bundleDeals), `values/{key}/history`, `changes/{id}` and `/preview`, `business-calendar` | `admin/settings` | Flags are **core for operations**: no UI and no CLI (D6). Cancelling a *scheduled* change (backend allows it; the UI only cancels drafts, `Settings.tsx:210,353-358`) is core. The rest is nice |
| B24 | **Search admin**: `lookup` (top bar), synonyms CRUD, `index`, `reindex-jobs`, `zero-result-queries`, `explain`, `ranking-policies` | Top-bar search (`web-shared/src/layouts/BackOfficeLayout.tsx:303`); new Catalog › Search screen (not in the design) | Lookup is core (C1). Reindex and index health are internal but needed offline. The rest is nice |
| — | **Wallet** (10 ops) and **wishlist insights**: phase 3, module off | `admin/customers` customer-detail, `admin/cases` goodwill, Finance; Reports | Later phase. No UI is correct for now |

---

## C. Frontend-only (UI with no backend behind it, dead or local-only)

- **C1 · Medium · The top-bar search is a dead input on every Admin and Ops page.**
  - Evidence: web `web-shared/src/layouts/BackOfficeLayout.tsx:303-310` has no handler; "/" focuses it; the phone search icon does nothing. `GET /api/admin/search/lookup` is unused.
- **C2 · Medium · Ops "Today's routine" is display-only.**
  - Evidence: web `ops/Queues.tsx:446-488`; no done button. The checks go late every day (B7).
- **C3 · Medium · Receiving shows a 5-step flow, but the "Put away" step is only a bin text field on the receipt line.**
  - Evidence: web `ops/Receiving.tsx:109,595,670`. The bin is stored on the receipt only as a suggestion. The warehouse put-away task stays open (B4).
- **C4 · Medium · Purchasing "Record receipt" sends the user to Receiving, where the PO never appears.**
  - Evidence: web `admin/Purchasing.tsx:708`; B8.
- **C5 · Medium · "Create case" is disabled with a tooltip pointing at flows that don't exist; "Attach file" on a case is disabled "not available yet" although the backend supports evidence.**
  - Evidence: web `admin/Cases.tsx:212`, `admin/Case.tsx:623`.
- **C6 · Medium · Reports "Save view" reports success, but saved views can't be listed or opened.**
  - Evidence: web `admin/Reports.tsx:54-55`.
- **C7 · Medium · Sellers link to their application by matching the store name in the browser.**
  - Evidence: web `admin/Sellers.tsx:106-120`. `SellerRow` has no application id.
  - Impact: renamed or duplicate names, or more than 100 applications, give wrong links.
- **C8 · Low · Hard-coded station and printer.**
  - Evidence: web `ops/PickPack.tsx:530` (`station: '2'`), `:549` (`printer: 'PS-2'`), `:569` ("Packing station 2").
  - Impact: every packer is recorded as station 2.
- **C9 · Low · Client-built rows and counts.**
  - Shipping's free-shipping card makes up a rule row from the profile threshold (`admin/Shipping.tsx:234-241`).
  - Promotions and Reviews count tabs from the first 100 items (`Promotions.tsx:55`, `Reviews.tsx:152`) instead of `moderation-items/summary`.
  - Trust and TrustReport use fixed deadlines (5 or 14 days) with no picker (`TrustReport.tsx:229`, `data/trust-reports.ts:162-178`).
- **C10 · Low · Disabled campaign options the backend supports.**
  - Evidence: web `PromotionNew.tsx:606,660,666`. "Selected products or offers" scope and "regions" audience are disabled.
- **C11 · Low · Purchasing allows one damage claim per PO, always `kind: 'damage'`.**
  - Evidence: web `Purchasing.tsx:377-379`. The backend also accepts `shortage | wrong_item | other`.
- **C12 · Low · Unused or duplicated code.**
  - The persisted `OpsQueues` GraphQL operation is shipped but Queues stays on REST (`ops/Queues.tsx:111-116`).
  - AdminSeller fetches about 15 sections and the page uses 4 (`Seller.tsx:175,277-323`).
  - `useDatasetExport` is defined twice (`data/report-export.ts:237`, `data/dataset-export.ts:262`).
  - Stale "step-up code" comment at `admin/Inbox.tsx:20`.

No PageStub, `/api/dev`, fixtures or TODO markers in the in-scope pages. Every catalogue view for these screens is built.

---

## D. Missing in both (the product needs it; neither the design nor the frontend has it)

- **D1 · High · No refund-approval screen in the design.**
  - Evidence: `web-shared/src/routes/catalogue.ts:133`; the Finance views are unexplained amounts, disputes and refunds failing.
  - Impact: the returns-to-money flow can't finish (A1/B1).
- **D2 · High · No warehouse setup or put-away design.**
  - Missing: bins, box types, put-away scanning, and return-parcel check-in.
  - Impact: a fresh offline install can't pick (B3/B4). Today only the simulator creates bins.
- **D3 · High · No design for decision surfaces.**
  - Missing: return decisions (approve, reject, take over, overturn); seller appeals and launch reviews (`admin/sellers` has `views: []`); Trust recommendation accept/decline and resolve-with-outcome (TrustReport has no design file, `catalogue.ts:139`); work item detail and claiming.
- **D4 · Medium · Supplier onboarding can't reach a sendable PO.**
  - Missing: email field, price list, and a delivery after send (A6, B8, B9).
- **D5 · Medium · Return policy administration has no screen.**
  - Evidence: Returns links to Settings, and Settings' `returns_baseline` section links back to `admin/settings` (backend `returns/service/settings-section.ts:97,102`). Shipping defaults and `PUT dispatch-targets` follow the same pattern.
- **D6 · Medium · No CLI fallback for operational switches on the offline server.**
  - Evidence: `backend/package.json` has no script for feature flags, search reindex, read-model rebuild, warehouse bins or queue leads, and `docs/MAINTAINING.md` doesn't mention them.
  - Impact: with no UI either, the sole maintainer has to hand-craft authenticated API calls.
- **D7 · Low · No design for search admin or wishlist insights** (no `admin/search*` in the catalogue).
- **D8 · Low · Open web-team gaps still open in the current code:**
  - **G85:** `promotions.FundingReview` has `reviewer` and `sentAt` but no `sentBy`. G65 (same-reviewer refusal) is enforced on the server.
  - **G89:** admin seller detail resolves id or slug only (`sellers/service/accounts.ts:357-362`); the `SL-` ref is still not accepted. The `SA-` application ref still needs a list search.
  - **G90:** there is still no endpoint for return reason codes. `AdminReturnRow.reasonCode` exists (G75), so the filter keeps a client list.
  - **G91:** `purchasing.ReceiptSummary` still has no `inboundId` (only `Receipt` has it).
  - **G92:** `support.CaseSeller` still has no `slug`.
  - **Done or confirmed:**
    - G64 (REST `all=true`; GraphQL summaries fixed).
    - G71 (`authority-checks` is used by Seller suspend; empty leads are seed data, and with no queue editor they can't be filled, B7).
    - G72 (export datasets are used by Receiving, Dispatch and Inspection).
    - G73 (evidence-request cancel and draft-notice delete are used).
    - G74 and G76 (data and seed).
    - G75: `Receipt.inboundId` exists but the UI doesn't use it (A8).

---

## E. Internet (noted for the dedicated reviewer)

- **E1 · Medium · Fake carrier data in production.** Shipping always uses `devCarrierAdapter()` (`backend:shipping/module.ts:25-26`; `providers/carriers.ts:1-8`).
  - Labels and tracking numbers are invented.
  - The tracking poll invents an "accepted" scan one hour after ship time, which marks Official Store packages dispatched.
  - Nothing ever produces "delivered". Real carriers need internet and inbound webhooks (`POST /webhooks/shipping/carriers/{carrier}/events`).
- **E2 · Medium · Seller KYC, payout tokenization and address checks use deterministic dev providers** (`backend:sellers/module.ts:25-26`, `providers/dev.ts`). A real provider needs internet; manual check results (B14) are the offline route.
- **E3 · Medium · Email-dependent flows fail offline.**
  - Supplier PO emails (`purchase-orders.ts:179,461-468`).
  - Report email schedules (`Reports.tsx:58`).
  - Seller invitations: the code is only in the notification; `POST /seller-invitations` returns no code or link (`Sellers.tsx:142-149`).
  - Application information requests and rejections reaching applicants.
- **E4 · Low · Public carrier tracking links** to ups.com, usps.com, fedex.com and ontrac.com are returned on shipments (`backend:shipping/domain/tracking.ts:34-65`).
- **E5 · Low · The `externalSignIn` feature flag** (Google/Apple) needs outside OAuth. It must stay off, and there is no UI to check it (B23).
- **E6 · Low · Default `apps.android.updateUrl`** is play.google.com (`backend:settings/domain/catalogue.ts:154`).
- **E7 · Info · Local only.** Report and label files are built locally (`reports/domain/files.ts`; the http strings there are only OpenXML namespaces). The search engine can be an internal node (`search/engine-config.ts:13`).
