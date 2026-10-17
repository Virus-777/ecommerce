# Marketly Admin Center review, part 1: access, audit, advertising, cart, catalog, checkout, content, customers, finance, fulfillment-service, identity (staff admin), inventory, media, messaging, notifications, offers, orders, payments

## Executive summary
1. The API contract is mostly clean. Typed REST calls match openapi. The admin persisted GraphQL files are identical to the backend's `docs/api/graphql/operations/admin` (ignoring line endings). Every permission key the UI checks exists except one.
2. **Step-up (password re-auth):** the frontend handles it correctly (`step-up.tsx`; body `reauthToken`; no X-Step-Up-Code; no staff TOTP). But the backend skips step-up when the approver is within their own limit, for payout-run approval and for refunds created from the Order page. These are the biggest money-safety findings (High, verified).
3. **Staff offboarding is impossible.** Neither the Admin Center nor any CLI can disable, lock, sign out, or remove roles from a staff member (High, security).
4. **Approvals (maker-checker):** approvers can only reach a request through the notice that opens it. Nobody can list approval requests, send one back, cancel it or resubmit it. The approval dialog hides the before/after details. New custom roles can never be given approval limits.
5. **Content workflow is broken in places.** Request changes always fails for articles and policies, edits to a live help article can't be approved or published, and campaign pages can't be managed at all (High, verified).
6. **Finance and payments:** most remedies can be seen but not acted on: refund retry/cancel, dispute accept/assign, holds, adjustments, amounts owed, payment capture/void/orphan, seller ledger and statements. Payout retries are announced as "in this run" but are not. Saved order filter counts are wrong. Orders "Export CSV" never downloads.
7. **Fulfillment service:** the whole module (19 ops) has no UI. Most inventory operations (transfers, counts, locations, reservations, discrepancies) and offer moderation (hold/remove/reinstate) have none either. The Official Store "New offer" and "Price file" buttons are disabled.
8. **Messaging:** the Admin Center has no screen to read or answer conversations, yet the backend routes Official Store messages to admin/official.
9. **Offline:** email, SMS, payment and payout providers are development adapters. "Test sent", the email preferences and the store preview links do nothing or break on the offline server.
10. **Coverage gap:** the catalog/offers/inventory/media sub-review had not handed back when this report was due. Sections B and C below for those modules come only from the inventory list and spot checks, so they are less complete.

Counts: A 26 · B 24 groups · C 19 · D 13 · E 6

---

## A. MISMATCHES

### Step-up and approvals
- **A1. High: payout-run approval within the approver's limit never asks for the password.**
  - Evidence: `backend:backend/src/modules/finance/service/payouts.ts:367-376`. The `check.decision === 'allowed'` branch calls `finishApproval` without checking `check.stepUpRequired`. Only the second-reviewer path passes `reauthToken` to `access.decide` (`:357`). The spec says the token is required above stepUpAbove (`backend:backend/src/spec/finance.ts:3375`).
  - Impact: one Finance reviewer releases a large run with no password check. The frontend already wraps this call in `stepUp.run` (`web:admin-center/src/pages/admin/Payouts.tsx:185-194`), so the fix is backend-only.
- **A2. High: refunds created from the Order page skip step-up.**
  - Evidence: `backend:backend/src/modules/returns/service/refunds.ts:411-418`. `decideOrQueue` approves and hands over when the check is `allowed`, with no `stepUpRequired` check. Compare the approve path at `:470`, which claims the token. The UI posts `/api/admin/returns/refunds` with no `useStepUp` (`web:admin-center/src/pages/admin/Order.tsx:201`).
  - Impact: refunds above stepUpAbove leave with no password. Fixing the backend also requires the page to add the step-up wrapper.
- **A3. Medium: payout retry announced "added to this run" when it is not, and it skips limits.**
  - Evidence: the UI sends `now:false` with the text "added to this run" (`web:admin-center/src/pages/admin/Payouts.tsx:241-246`). The backend inserts the retry with `run_id: null` (`backend:backend/src/modules/finance/service/payouts.ts:559`); it joins a run only on recalculate, which the UI never calls. `retry` also ignores `approval_required` (`payouts.ts:553`; `core.ts:191-195` throws only on denied).
  - Impact: the seller is paid later than staff were told, and retries above the caller's limit get no second reviewer.
- **A4. Low: payout approval message is wrong for low-limit approvers.**
  - Evidence: above the limit the backend answers 200 with the run, not APPROVAL_REQUIRED (`payouts.ts:378-398`), so the UI's `sentForApproval` branch never runs. The UI says "Your approval is recorded" even when `requesterCountsAsFirst` is false (`web:Payouts.tsx:205-211`).
  - Impact: wrong message shown.
- **A5. Low: Inbox comment still says "step-up code when asked".**
  - Evidence: `web:admin-center/src/pages/admin/Inbox.tsx:20`.
  - Impact: comment only. The code correctly uses password re-auth.
- **A6. Low: Order refund dialog reads data most refund staff can't load.**
  - Evidence: it reads GET `/api/admin/access/approval-actions`, which needs `access.roles.view`; only Platform Administrator and Business Owner have it (`backend:backend/src/modules/access/domain/seed.ts:59`; `web:Order.tsx:99,166`).
  - Impact: 403 for order and finance staff. The "Approval route" text falls back to "Finance approval".

### Access and audit
- **A7. Low: Inbox "Topics and templates" link checks a permission that doesn't exist.**
  - Evidence: the link checks `notifications.topics.manage` (`web:Inbox.tsx:365`). The real keys are `notifications.templates.*` and `notifications.routing.manage` (`backend:backend/src/spec/notifications.ts`; Platform Administrator seed at `access/domain/seed.ts:68-69`).
  - Impact: the link never shows.
- **A8. Low: Action history "Staff" target filter misses most staff records.**
  - Evidence: the filter uses `targetType=staff` only (`web:admin-center/src/pages/admin/data/audit.ts:22`). Identity and access also record `account`, `staff_member`, `staff_invitation`, `role` and `role_assignment`.
  - Impact: lock/disable, invitation and role entries are missed.
- **A9. Low: Staff and Audit pick lists load only the first 100 members** (`web:Staff.tsx:71`, `data/audit.ts:62`; MAX_PAGE_LIMIT=100). Impact: silent truncation for large teams.

### Orders, finance, customers
- **A10. Medium: saved order filters are stored in the UI's shape, but the backend counts them as `AdminListQuery`.**
  - Evidence: `web:admin-center/src/pages/admin/Orders.tsx:198`; `backend:backend/src/modules/orders/service/admin.ts:69`, `reads.ts:276`.
  - Impact: chip counts are wrong, and `savedFilterId` returns the wrong orders.
- **A11. Medium: Orders "Export CSV" starts a job but nothing ever downloads.**
  - Evidence: `web:Orders.tsx:190-193` only announces. GET `/api/admin/orders/exports/{id}` is never polled.
  - Impact: staff get no file.
- **A12. Medium: the "Goodwill" refund reason sends a card refund instead of store credit.**
  - Evidence: `web:admin-center/src/pages/admin/data/order.ts:133`. The backend refuses goodwill only on the case path (`returns/service/refunds.ts:304-305`), not in `createException`.
  - Impact: goes against decision D-RT3.
- **A13. Low: FinanceChecks shows no approver name.**
  - Evidence: it reads `correction.approval.approverLabel`, which `ApprovalInfo` doesn't have (`web:admin-center/src/pages/ops/FinanceChecks.tsx:194`; `backend:backend/src/spec/common.ts:172-177`). Hand-written types and `as never` there (and at `ops/Dispatch.tsx:227`) bypass contract checking.
- **A14. Low (inference): Order "cancel items" sends the full ordered quantity.**
  - Evidence: `quantity: it.quantity` (`web:Order.tsx:228`). Dispatch subtracts `cancelledQuantity`.
  - Impact: QUANTITY_EXCEEDS_REMAINING on partly cancelled lines.
- **A15. Low: reconciliation "Explain" always sends `reasonCode:'other'`** (`web:Finance.tsx:168`). Impact: reason statistics are lost.
- **A16. Low: lists filtered in the browser over one page.**
  - Evidence: reconciliation items (100), disputes (50) and the payout run `?run=` lookup in the first 20 (`FinanceChecks.tsx:140-152`, `Payouts.tsx:138-141`).
  - Impact: older open items drop off.

### Content, notifications, ads, dashboard
- **A17. High: edits to a live help article can never be approved or published.**
  - Evidence: the UI branches on `status` alone (`web:admin-center/src/pages/admin/HelpContent.tsx:562,646,656,683`). For a live article the backend keeps `status='published'` and tracks review in the draft (`backend:backend/src/modules/content/service/help.ts:214-221,378-381`).
  - Impact: after "Send for review" the badge still says Published, Approve never shows, and resending fails with ILLEGAL_TRANSITION.
- **A18. High: Request changes always fails for articles and policies.**
  - Evidence: the UI sends `{action:'requestChanges'}` with no `reason` (`HelpContent.tsx:585`) and `{approve:false}` with no `note` (`:298`). The backend requires both (`help.ts:387`, `policies.ts:336`). Verified.
  - Impact: VALIDATION_FAILED, so reviewers can't send work back.
- **A19. High: "New campaign page" creates drafts nobody can use.**
  - Evidence: it posts `{title:'Untitled campaign page'}` (`web:Content.tsx:173`). The slug comes from the title, so the second click gets SLUG_TAKEN (`backend:content/service/pages.ts:57-61`). There is no UI to edit, submit or remove a page.
- **A20. Medium: Dashboard tile colours never show.**
  - Evidence: GraphQL returns DANGER/WARNING/NEUTRAL in capitals (`backend:backend/src/modules/workqueues/graphql/resolvers.ts:149`). The UI compares against lowercase (`web:Dashboard.tsx:337-343`, `data/dashboard.ts:48`).
  - Impact: no colours, and screen readers hear "(at risk)" on every tile.
- **A21. Medium: policy-owner Approve is shown to anyone with `content.policies.approve`** (`HelpContent.tsx:482`). The backend accepts only the owner or someone with `content.policies.manage` (`policies.ts:328`). Impact: FORBIDDEN.
- **A22. Medium: a hard-coded 14-day notice blocks valid policy changes.**
  - Evidence: `NOTICE_DAYS=14` is applied to every policy (`HelpContent.tsx:27,255-257`). The backend uses the `policyNoticeDays` setting, applies it only to customer-facing changes, and allows shorter notice with Business Owner approval (`policies.ts:403-415`).
  - Impact: urgent and seller-only policy changes can't be sent.
- **A23. Medium: the Message-seller dialog promises replies arrive in the staff inbox.**
  - Evidence: `web:admin-center/src/pages/admin/data/seller-message.tsx:16`. Routing notifies staff only for Official Store conversations (`backend:notifications/domain/routing.ts:840-880`).
  - Impact: staff never hear about seller replies.
- **A24. Low: homepage review has no Request changes, and Approve is shown to the submitter** (`Content.tsx:274-277`). The submitter gets SAME_REVIEWER (`homepage.ts:181`).
- **A25. Low: Help list fetches 100 rows and filters them in the browser** (`HelpContent.tsx:724,761-767`), although `/help/items` supports `q`, `type`, `status` and paging.
- **A26. Low: campaign Approve shows when the caller's roles cover no waiting step** (`AdCampaign.tsx:574,1037`), which gives FORBIDDEN. The Ads search says "or advertiser", but backend `q` doesn't match advertisers (`advertising.ts:1983`). The dashboard shows a raw "In_review" (`Dashboard.tsx:303`).

## B. BACKEND-ONLY (grouped; template-literal callers checked)

The inventory lists some ops as unused that are actually called. These are false positives:
- The 10 ad campaign actions, sent from `data/ad-actions.tsx`.
- Media uploads (`uploads`, `/content`, `/complete`), called through `web-shared/src/api/uploads.ts:55`.
- `payments/orders/{id}/summary` and `orders/{id}/history`, covered by GraphQL AdminOrder.
- `customers/exports`, covered by the reports dataset.

| # | Capability (ops) | Host screen | Rating |
|---|---|---|---|
| B1 | Staff account security: identity accounts disable/enable/lock/unlock/sign-out-all/force-password-reset, account detail and security activity. Disable/enable need step-up `staff-account`. | Staff › member detail (new) | **Core (security)**, see D1 |
| B2 | Role assignment: POST role-assignments (step-up role-grant), revoke | Staff › member | **Core**. The invite form says "You can add more roles after they accept" (`web:Staff.tsx:695`), but there is no way to do it. |
| B3 | Staff invitations: list, resend (step-up), revoke | Staff › Invited filter | Nice-to-have (the CLI `staff-link --revoke` covers it offline) |
| B4 | Coverage: PUT roles/{id}/coverage (lead, backups, escalation) | Staff | **Core**. Coverage gaps are shown with no fix, and Inbox "Edit backups" links to Staff, which can't edit them (`Inbox.tsx:281`). |
| B5 | Away periods: create, end, cancel (delegation goes through Business Owner approval) | Staff / Inbox | Medium. The list is read-only (`Staff.tsx:734-758`). |
| B6 | Roles: PATCH (rename / escalation), archive; GET permissions registry; GET members/{id}; GET limits; limit-changes/{id}/cancel | Staff | Medium |
| B7 | Approval requests: GET list (to_decide / requested_by_me / all), return, resubmit, cancel | Inbox › Approvals tab | **Core**, see D2 |
| B8 | Audit: summary (chip counts), integrity (hash-chain result), PUT retention (Business Owner approval), exports list | Action history | Integrity: Medium. Others: nice-to-have. |
| B9 | Payment remedies: refunds/{id}, retry, cancel; disputes/{id}, accept (approval), assign; payments list/detail/check/capture/void/resolve-orphan | Finance tabs; Order payment card | **Core** |
| B10 | Seller money: holds (list, create, release, extend, apply), adjustments, amounts owed (+ settle), sellers' balances/ledger/statements, statements/{id}, payout-runs/{id}/statements | Payouts; Seller › Finance | **Core** |
| B11 | Fee rules: propose, withdraw, calculate | Finance / Settings › Fees | **Core** (fees can't be changed), see C2 |
| B12 | Payout runs: recalculate (core, see A3); create and release (scheduled jobs exist) | Payouts | Core / internal |
| B13 | Orders: cancellation-requests decide, dispatch-deadline, resend-confirmation, DELETE saved-filters | Order / Orders | Decide: core. Others: nice-to-have. GraphQL already offers EXTEND_DEADLINE and RESEND_CONFIRMATION in allowedActions. |
| B14 | Customers: notes, account actions history, data-requests privacy queue; identity reset-two-step (members) | Customer drawer | Notes and reset-two-step: core online. Others: nice-to-have. |
| B15 | Support views: cart/carts (+{id}), checkout/sessions (+{id}); finance marketplace-income, trading-targets, reconciliation assign | Customer / Order / Official | Nice-to-have |
| B16 | Content pages lifecycle: GET/PATCH, submit, approve, schedule, cancel-schedule, unpublish, remove, versions, restore, preview | Content › page editor | **Core**. Today the About page and store content come only from `simulate` (commit eeddf074). |
| B17 | PUT navigation (header and footer links); help category create/edit; policy create, withdraw, version detail, diff; article versions and restore; homepage preview | Content / Help content | Medium |
| B18 | Messaging (8 ops): find, read with logged reason, lock, hide, reports and decide, response stats | admin/official, order, case, customer | **Core online**, see D3 |
| B19 | Notifications: template discard and preview (discard: Low/Medium, a leftover draft hides "Restore" at `Notifications.tsx:497`); deliveries, retry, suppressions, stats (internal); broadcasts (needs internet); inbox archive | Notifications / Inbox | Mixed |
| B20 | Advertising: seller ad charges and void; PUT rules (Business Owner approval; the Placements page says changes need approval but has no edit control, `AdPlacements.tsx:152`); campaign and performance reports; creative detail and re-check | Ads | Charges: core for paid ads. Others: nice-to-have. |
| B21 | Fulfillment service: all 19 admin ops (enrollments decide/status, SKU review, inbound arrive/receive/discrepancy, removals, fee schedules, fees reverse, stock differences, returns outcome). No caller anywhere (grep). | New Ops/Admin "Fulfillment service" screen; not in the design catalogue | **Core if the service is offered**, otherwise internal |
| B22 | Inventory: stock-item detail, movements, reservations (+release), transfers (plan/ship/receive/cancel), counts (start/lines/submit), locations create/edit, discrepancies resolve, return-outcomes record, stock-item create/edit/merge, adjustment cancel, inbound/{id} | ops/Inventory, ops/Receiving | Counts, transfers, discrepancies, return outcomes, stock-item create: **core** for running a warehouse. Others: nice-to-have. (Spot-checked against the inventory; not reviewed in depth.) |
| B23 | Offers: Official Store offer create/publish/pause/resume/edit; bulk price files (upload/rows/apply); price-change list/cancel; offer hold/release/remove/reinstate; featured-offer rule and decision | admin/official; Catalog | Official create/publish: **core**. Offer moderation: core online. Others: nice-to-have. |
| B24 | Catalog: Official Store product create/edit/submit, variant edit, corrections decide, bulk edit, publication-impact, product detail. Media: asset library, detail, remove/restore (moderation), checks, delete, private download. | Catalog; new media library | Official product create: **core**. Media moderation: Medium. |

## C. FRONTEND-ONLY
- **C1. Medium: approval limits are worked out in the browser.**
  - Evidence: from access/me limits in `web:Order.tsx:165-167`, `Official.tsx:133`, `Purchasing.tsx:220`, `ops/FinanceChecks.tsx:144`, `ops/Inventory.tsx:204`. POST `/api/admin/access/authority-checks` exists for exactly this (`backend:backend/src/spec/access.ts:1735`).
  - Impact: the UI can say "within your limit" when the server routes the action to approval, or the reverse.
- **C2. Medium: fee rules link in a circle.** Finance "Edit in settings" goes to Settings (`Finance.tsx:613-616`), and Settings maps `fees` back to Finance and `payouts_holds` to Payouts, which can't manage holds (`data/settings.ts:39-40`).
- **C3. Medium: Payouts "Statements" button is permanently disabled.**
  - Evidence: `Payouts.tsx:334`. The seller page it points to has no statements (`Seller.tsx:593-628`), although the backend has `payout-runs/{id}/statements`.
- **C4. Medium: the Refunds-failing footer promises a retry that has no button** (`Finance.tsx:335` vs `:501-509`).
- **C5. Medium: dispute evidence is text only and always submitted at once.**
  - Evidence: `{text, submit:true}` (`Finance.tsx:178`). The hint mentions photos (`:725`), but there is no file upload and no draft, although the backend supports both (`backend:spec/payments.ts:2069-2073`).
- **C6. Medium: "Add section" always makes `featured_products`.**
  - Evidence: no kind picker (`Content.tsx:186`). The drawer says "Adding products from the catalog isn't available in this drawer yet" (`:614`).
- **C7. Medium: Official Store "New offer" and "Upload price file" are disabled** (`Official.tsx:329,332`), although the backend supports both (B23).
- **C8. Medium: Staff role editor edits only limits already in force.**
  - Evidence: `Staff.tsx:390-412`; the backend `roleDetail` returns `limitsInForce` only (`backend:backend/src/modules/access/service/roles.ts:334-340`).
  - Impact: a new custom role can never get approval limits.
- **C9. Medium: Approval dialog shows only summary, reason and amount.**
  - Evidence: `Inbox.tsx:493-501`. It omits `details` (before/after), `target` (with a link to the screen), `deadline` and `nominatedReviewer`, all in `ApprovalRequest` (`backend:spec/access.ts:478-525`).
  - Impact: approvers decide permission, limit and setting changes blind.
- **C10. Low: the refund dialog computes each seller's fee and earnings effect in the browser** (`Order.tsx:146-163`). Its destination Select has one option and an onChange that does nothing (`:812`).
- **C11. Low: hard-coded policy text.** "weekly … 7-day hold" (`Payouts.tsx:380`), "Friday payout run" (`Finance.tsx:325`), "3–5 business days" (`Order.tsx:214`), PT/ET-only time zones (`Content.tsx:50`, `AdCampaign.tsx:61`), US regions, and the ad role-to-review-step map (`ads.ts:117-127`).
- **C12. Low: work the backend already does is redone in the browser:** policy diff (`HelpContent.tsx:55`), template preview and variable check (`Notifications.tsx:30-71`), fee illustration (`Finance.tsx:654`; POST fee-rules/calculate exists).
- **C13. Low: section preview does nothing useful.** The eye button only announces text, and the preview is a wireframe drawn in the browser (`Content.tsx:265,375`).
- **C14. Low: "Let it finish" lives only in page state** (`Ads.tsx:382`).
- **C15. Low: owners and reconciliation items show "Unassigned" with no assign action** (`Finance.tsx:549`).
- **C16. Low: "Lift restriction" takes its reason from the account-action Details box** (`Customers.tsx:583`).
- **C17. Low: previous policy versions open the generic store page** (`HelpContent.tsx:401`).
- **C18. Low: video ads are disabled** (`AdCampaign.tsx:870`, `AdPlacements.tsx:274`). This matches the backend.
- **C19. Low: staff pages flash "You don't have access" while access/me loads**, because `can()` sees `[]` until then (`app/session.tsx:116`; e.g. `Staff.tsx:265`).

## D. MISSING
- **D1. High (security): staff offboarding.**
  - A departed or compromised staff account can't be disabled, locked, signed out everywhere or stripped of roles from the Admin Center.
  - The only CLI is `staff-link` (link/reset/revoke-invite; `backend:backend/tools/staff-link.ts:7-8`; `docs/MAINTAINING.md:239-243`). Neither the design (admin-staff.html has no member actions) nor the build has it; the backend has every op (B1/B2).
  - The step-up dialog even tells locked users to "Ask a Platform Administrator to unlock it" (`web:data/step-up.tsx:116`), but no unlock UI exists. Automatic lockouts do expire after `lockoutMinutes`.
- **D2. Medium: no approval queue.**
  - Approval requests are reachable only from a notice whose link kind is `approval` (`Inbox.tsx:208,240`).
  - Requesters can't see "requested by me", cancel, or resubmit. A request returned through the API sends the requester an "Update request" notice (`backend:notifications/domain/routing.ts:1173-1181`) that opens a dialog with only Close.
  - Approvers can't send a request back.
- **D3. High online / N/A offline: no staff messaging screen.**
  - The backend creates staff notices and work items for Official Store conversations that link to admin/official (`routing.ts:847-853`, `messaging/service/core.ts:735`).
  - admin/official has no conversation UI and is not in the catalogue (`catalogue.ts:127`). The Official Store can't answer customers.
- **D4. Medium: no screens in the catalogue for the payment, seller-finance, fulfillment-service, inventory-operations (transfers/counts), campaign-page, About-page or navigation editors.** The core B rows have nowhere to live (`catalogue.ts:127,133-134,156`).
- **D5. Medium (backend): payment money actions have no limits, approval or step-up.** Capture, void, resolve-orphan (which can refund) and refund retry/cancel check only the permission. `access.check` appears only in `payments/service/disputes.ts:242`.
- **D6. Medium (backend): no different-person check when approving pages.** `approvePage` lacks SAME_REVIEWER (`content/service/pages.ts:503-517`), while the homepage (`homepage.ts:181`) and articles (`help.ts:388`) have it.
- **D7. Medium (backend): `HelpArticleAdmin` has no draft-review state.** This is the root cause of A17.
- **D8. Medium: the orders list can't be filtered by customer.** The spec has no `customerId` (`backend:spec/orders.ts:2930-2942`), although the service supports it. The customer drawer's "All orders" link is unfiltered (`Customers.tsx:498`).
- **D9. Low: no admin decline or override of a customer cancellation request.** Staff can only cancel items.
- **D10. Low: no cross-customer privacy (data request) queue.**
- **D11. Low: no audit integrity indicator.** Tampering is reported only by a notice to Platform Administrator and Business Owner (`audit/service.ts:490`).
- **D12. Low: there is no screen for the staff member's own sessions or password change.** This belongs to the cross-cutting reviewer.
- **D13. Context: failed payouts, disputes, failing refunds and unexplained amounts were never seeded** (BACKEND-REQUESTS G76). Those flows are only typechecked.

## E. INTERNET
- **E1.** Email, SMS and push providers are development adapters (`backend:notifications/module.ts:28-29`).
  - "Test sent to <me>" reports success, but nothing leaves the server (`Notifications.tsx:261`).
  - Staff "Email for <area>" and digest settings do nothing offline (`Inbox.tsx:393-398`).
  - The Inbox note says "sent by email" (`Inbox.tsx:269`).
  - Deliveries, suppressions, broadcasts, webhooks and unsubscribe all need a provider.
- **E2.** The payments provider is an in-memory development processor (`backend:payments/providers/card-processor.ts`). Capture, void, check, refunds and dispute evidence need a real one.
- **E3.** The payout bank provider is development-only (`finance/providers/payouts.ts`). Released runs "pay" through it on the offline server.
- **E4.** Customer email is needed for refund request-destination, resend-confirmation, send_password_reset and notifyCustomer on cancel-items. These silently go to the outbox offline.
- **E5. Inferred:** store preview links (Content "Preview homepage", policy View) go to `APP_URLS.store` (`web-shared/src/routes/apps.ts:12`). The offline server serves only the Admin Center, so they break there.
- **E6. Cosmetic:** `https://` link template (`HelpContent.tsx:51`); ad destination field prefixed "marketly.com" (`AdCampaign.tsx:666`).

## Verified OK (for the coordinator)
- **Step-up client:** `useStepUp` retries on 403 STEP_UP_REQUIRED with `details.purpose`. It sends body `reauthToken` and keeps a returned unused token. This matches `backend:kernel/auth/chain.ts:388-420`, which gives the token back on 4xx.
- **Step-up coverage:** used on staff-invitations, roles permissions, approval-requests approve, payout-run approve and destination reviews approve/reject. No X-Step-Up-Code. No staff TOTP.
- **Permissions:** permission keys come back fully expanded from access/me (`access/service/members.ts:390`). Every `can()` key used in the admin UI exists, except A7.
- **Persisted GraphQL:** admin persisted operations and manifest are identical to the backend's.
- **Screens:** every catalogue screen in scope is built (no PageStub).

---

## Addendum: catalog, offers, inventory, fulfillment-service, media

This sub-review handed back after the main report was written. The two High findings below were checked against the code by the coordinator.

**Correction to item 10 of the executive summary:** these modules are now fully reviewed. The coverage gap no longer applies.

**Updated counts:** A 33 · B 26 groups · C 24 · D 16 · E 6.

### A. MISMATCHES (additional)

- **A27. High: staff photo uploads can't be attached to inspections or damage reports.**
  - Evidence:
    - Every admin upload is created as platform-owned (`web:web-shared/src/api/uploads.ts:60`, `ownerKind:'platform'`).
    - Returns inspection attaches the photos expecting `{kind:'staff'}` (`backend:backend/src/modules/returns/service/handling.ts:107`).
    - Warehouse report-damage and return parcels also expect a staff owner (`warehouse/service/fulfillments.ts:395`, `parcels.ts:120`).
    - The owner check is a strict match (`media/domain/rules.ts:257`).
  - Backend conflict: warehouse report-damage then passes the same photos to `inventory.reportDiscrepancy`, which expects `{kind:'platform'}` (`backend:backend/src/modules/inventory/service/discrepancies.ts:94`). That step fails whichever owner the photo has. The tests stub media, so they don't catch this.
  - Impact: return inspection and pick-pack damage reports, which both require photos (`ReturnInspection.tsx:318`, `PickPack.tsx:145`), fail with ASSET_NOT_OWNED.
- **A28. High: most operations roles can't upload at all.**
  - Evidence:
    - Staff uploads need `media.assets.manage` (`backend:backend/src/spec/media.ts:1007,1028`).
    - Only Catalog Manager and Content Manager have it (`access/domain/seed.ts:163,254`).
    - Roles without it: warehouse worker and manager, returns manager, purchasing manager, Official Store manager, advertising manager, Business Owner.
    - The photo buttons in the UI are not gated (`Receiving.tsx:389`, `PickPack.tsx:140`, `ReturnInspection.tsx:278`).
  - Impact: required photos fail with 403 for the people who do this work.
- **A29. Medium: a scheduled price change locks the offer.**
  - Evidence: the "Change price" button is disabled only for `pending_approval` (`web:Official.tsx:450`). The backend refuses any open change with PRICE_CHANGE_PENDING, "Cancel it first" (`offers/service/pricing.ts:146-147,276`). Neither the cancel endpoint nor `GET /price-changes` is called.
  - Impact: staff can't change or cancel the price until the scheduled change starts.
- **A30. Low–Medium: the was-price is always resent with basis `list_price`** (`Official.tsx:178,202,523`). The list price on file may have been verified as the 30-day low, and there is no UI to set a list price.
  - Impact: unexpected WAS_PRICE_NOT_VERIFIED.
- **A31. Low: the UI guesses the price-limit and adjustment-limit outcome differently from the backend** (`data/official.ts:38-43`, `Inventory.tsx:204-208` vs `access/service/approvals.ts:108-135`).
  - Impact: wrong button labels. The real outcome is read from the response. See C1.
- **A32. Low: Inventory reads fields the schema doesn't have.** It reads `incoming.reference`, but the schema has `purchaseOrderRef`; and it reads `approval.approverLabel`, which doesn't exist (`Inventory.tsx:57,68,307`; `spec/inventory.ts:35-39`).
  - Impact: the PO reference and approver name never show.
- **A33. Low: Receiving finds the inbound receipt by scanning the first 100 unfiltered rows** (`Receiving.tsx:507-508`).
  - Impact: once there are more than 100 receipts, confirmation is silently skipped.

### B. BACKEND-ONLY (refines B22–B24)

- **B25. Core: inventory exception handling.**
  - Return outcomes list and record (`spec/inventory.ts:2101-2139`): returned units stay in "Returned" until an outcome is recorded (`inventory/service/returns.ts:149-153`), yet the UI already says "Recorded by Inventory Manager" (`ReturnInspection.tsx:566-570`).
  - Discrepancies list and resolve: a pick shortage or damage report holds the fulfillment until it is resolved (`warehouse/domain/state-machines.ts:5`).
  - Also unused: reservations release and adjustment cancel.
- **B26. Medium: Official Store bulk price file.** It is a phase 2 feature, served at the default `LAUNCH_PHASE=2` (`backend/.env.example:40`). The UI disables the button with "arrive with launch phase 2" (`Official.tsx:329`).

Corrections to the earlier B rows:
- Transfers and stock counts (B22) are phase 4, so the UI's "Later" card is consistent.
- Fulfillment service (B21) is entirely phase 4, so having no UI is expected at the default `LAUNCH_PHASE=2`.
- Offer hold/remove/reinstate (B23) is still unused. *Inference:* a Trust `suspend_offer` enforcement can't complete from the UI (`trust/service/actions.ts:692`).
- `POST /catalog/products/bulk` is unused; the UI sends one request per product instead.
- `publication-impact` is not called before changing a product's publication (`Catalog.tsx:142`).

### C. FRONTEND-ONLY (additional)

- **C20. Medium: Catalog "Add product" is a dead end.** It goes to admin/official, which has no add-product flow (`Catalog.tsx:209-213`).
- **C21. Medium: "Can't be priced at a loss" is enforced only in the UI** (`Official.tsx:69`). `requestOfficial` has no cost check (`pricing.ts:271-299`), so the API or the bulk path can price below cost.
- **C22. Low: Catalog "Bulk price and stock update" is permanently disabled**, and its tooltip points to a Price file screen that doesn't exist (`Catalog.tsx:289-298`).
- **C23. Low: hard-coded locations and partial zones.** The location is fixed to "Reno, NV" (`Inventory.tsx:272,571`) although `/locations` exists. Zones come from only the first 100 SKUs.
- **C24. Low: time zone and history links are off.** Price notices say "PT", but the `datetime-local` input uses the browser's time zone (`Official.tsx:48-51,203,217`). "Full history" opens Action history, not the movements ledger (`Inventory.tsx:464`).

### D. MISSING (additional)

- **D14. High: the Official Store can't be operated end to end.**
  - No UI: create product, upload images, submit product, create stock item and offer, publish, pause, cancel a price change. There is also no design screen for these (`catalogue.ts:127`).
  - Works: review, purchasing → receiving for existing stock items, price changes. Above the limit, price changes route correctly to approval (`pricing.ts:325-337`).
- **D15. Medium–High: hidden or suspended products can't be shown again.** No UI sends `publication:'active'` (`Catalog.tsx:142`).
- **D16. Medium: approved products have no admin detail page.** They link to the customer store, `APP_URLS.store` (`Catalog.tsx:40`), which isn't served offline.

### E. INTERNET

Nothing in this slice needs internet:
- Media storage and image processing (sharp) are local, and the malware scanner is a dev stub.
- Store links are local but unreachable on the offline server (see E5).
