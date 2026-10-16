# Backend answers to BACKEND-REQUESTS.md and BACKEND-PRODUCT-IMAGES.md

Answered 2026-10-16 on backend main `665d7cab` (not pushed). `npm run check` is green (7,978 tests, 6,582 HTTP
checks over 1,319 endpoints) and `npm run simulate` passes all 18 flows and 20 database checks on a real MongoDB.

Status per item, then the decisions the owner took, then what is still open. Field and endpoint names are exact.

## Before you pick this up

1. **Regenerate the API types:** `npm run gen:api -w @marketly/web-shared -- <backend>/docs/api`. Many responses
   gained fields, and a few inputs changed (see G67, G68).
2. **Persisted queries changed ids.** These operations were edited: AdminCase, AdminOrder, CartPage,
   CheckoutReview, OrderList (new variable `$countsQuery`), AccountOverview. Take the new manifests from
   `docs/api/graphql/operations/*/manifest.json`.
3. **Backend developers:** run `npm install` in `backend/` (adds `sharp`). A `MONGO_DATA_DIR` folder created
   before R2 must be deleted once; the embedded MongoDB now listens on `MONGO_PORT` (default 27018).
4. **Staff sign-in changed on 2026-10-14** (separate doc "Admin Center changes for the offline server"): no
   authenticator for staff, invitation pass codes, password re-auth for sensitive actions.

## Requests

| # | Status | What to use |
|---|---|---|
| R1 Dev outbox | Done | `GET /api/dev/notifications/outbox?to&channel&since&limit` (1–200, default 50) and `DELETE /api/dev/notifications/outbox` (204). Only while `DEV_TOKENS` is on; any valid token; browsers may call it. Items: `providerMessageId, at, channel, to, subject, text, html, topic, data, links`. `data` is the template context, nested: `data.code.value`, `data.reset.url`, `data.invite.url`, `data.guest.url`. Staff pass codes are never emailed: use `npm run staff-link`. No `/dev/mail` viewer (it would need an anonymous route). |
| R2 Embedded MongoDB restart | Done | With `MONGO_DATA_DIR`, the embedded server uses `MONGO_PORT` (default 27018) and replica set `rs0`; a busy port stops startup with a clear message. |
| R3 Product images | Done | See "Product images" below. |

## Product images (BACKEND-PRODUCT-IMAGES.md)

Built as specified, with these differences:

- **HEIC is refused** for product images (415 at upload). The prebuilt image library can't decode it.
- **Where the checks run:** a seller-area `product_image` upload that fails the ratio (1%) or the minimum size is
  rejected with `rejectionReason`. Staff uploads are not rejected, because staff also use that purpose for
  category and content images; attaching a failing one to a product, variant or offer photo answers
  `VALIDATION_FAILED` on `imageIds`.
- **Category `aspectRatios`** are ignored for product photos; the global ratio wins.
- **Sizes:** product images have `detail` and `thumb`; old sizes are aliases (small and thumb → thumb; medium,
  large, zoom and detail → detail). Other images keep their sizes, and `detail` answers medium for them.
- **`MediaRef`** gains `thumbUrl` and `detailUrl` (product images only) and `fileName` (every asset, G31d).
- **Read endpoint:** `GET /api/{store|seller|admin}/media/image-specs`, any token of the area, no permission. Not
  in GraphQL `AppConfig`.
- **Setting:** `media.productImage` as specified, plus `media.rebuildBatchLimit` (default 500).
- **Rebuild:** job `media.rebuild-product-renditions` runs hourly and right after the setting changes; it never
  enlarges and overwrites the same keys, then search re-indexes. Images already stored are rebuilt on the first
  run after deploy.
- **Ratio change:** images with the old ratio get a non-blocking `wrong_aspect`; read `ProductAdmin.imagesToRecrop`
  (GraphQL `Product.imagesToRecrop`); such products count as missing content and stay live; sellers get the
  notice topic `seller.product.recrop_needed` (event `catalog.images.recrop_needed`).
- **Every product response** now has `url` = detail plus `thumbUrl` and `detailUrl`, which `renditionUrl()` reads.

## Gaps

### G1–G12

| # | Status | Answer |
|---|---|---|
| G1 | Decision: keep | Keep `/p/:slug/:id`. Product slugs are not unique. |
| G2 | Fixed | Every module's GraphQL fragment is always in the schema; fields of a module that is off answer null. Use the persisted queries as they are. |
| G3 | Web | Store routes. Staff reset links go to the Admin Center `/reset-password`. |
| G4 | Done | `POST /api/store/messaging/product-conversations` `{ offerId, body, mediaIds?, clientMessageId? }`, signed-in customers. One conversation per customer, seller and product; new ones capped by setting `presaleConversationsPerDay` (10, then 429). Subject `kind: product`, `productId`. |
| G5 | Not built | Guest back-in-stock needs email and wishlist (phase 3, off). |
| G6 | Done | `q` on product review lists (headline, text, reviewer name). No AI summary: the server is offline. |
| G7 | Decision | No live chat. `chat` is gone from contact channels. |
| G8 | Done | `GET /api/store/content/official-store` → `OfficialStoreProfile` (name, logo and banner URLs, introduction, policy links, feedback). Settings `officialStoreLogoUrl`, `officialStoreBannerUrl`, `officialStoreIntroduction`, `officialStorePolicyKinds`. |
| G9 | Not built | No real card processor offline; the development processor stays. |
| G10 | Fixed | The was-price check reads the variant's `listPrice` first, specs as fallback. Drop the seed's `specs["List price"]` workaround. |
| G11 | Done | Invitation codes: dev outbox (R1). Test deposits: `GET /api/dev/finance/test-deposits?sellerId=` (dev only). |
| G12 | Not built | The owner doesn't use Google sign-in; no set-password flow for passwordless accounts. |

### Customer Store (G13–G35)

| # | Status | Answer |
|---|---|---|
| G13 | Fixed | `Money.formatted` is computed for every Money; `Offer.official` works from any module. HomePage and CategoryPage can use GraphQL again. |
| G14 | Fixed | `itemStates` counts real item states (new `OrderSummary.itemStates`). |
| G15a | Fixed | Free-shipping thresholds apply to cart estimates and product cards (`DeliveryQuote.freeOver`, `DeliveryEstimate.freeOver`), also per package without a destination. |
| G15b | Done | `PackageShipping.pending: true` while no option is chosen (amount stays 0): show "Calculated at the next step". |
| G15c | Fixed | Cart and checkout give the same coupon reasons: "Already on sale" / "Not included in this coupon". |
| G16 | Can't reproduce | The upload route accepts any content type (tests send `image/png`). Send us the exact request if it recurs. |
| G17 | Fixed + decision | Ranking counts free shipping; featured rule v2: lowest delivered total, and the Official Store wins an exact tie. |
| G18 | Done | `sellerSlug` on `ProductCard`, `SellerTile`, `FlashItem`, `DealProduct`; `ReviewContext.seller.slug`. Null for the Official Store. |
| G19 | Done | `productSlug` on `CartItem`, `SavedItem`, `CheckoutLine`, GraphQL `OrderItem`; `OrderSummary.items[]` (itemId, productId, productSlug, variantId, offerId, title, variantLabel, image, quantity); `OverviewReturn.productId/productSlug`; `ProductTile.slug`, `CategoryTile.slug`, `BrandTile.slug` + `pageSlug`. Not on REST `OverviewOrder` items (GraphQL has them). |
| G20 | Done | `content.json` and `sellers.json` fields are typed (`HomeSection.deals` = `FlashSaleBlock[]`, `ContentTable`, `HelpSummaryTabs`, storefront blocks …). `PendingStaffChange.proposed` and `ChangeRequest.current/proposed` stay JSON (shape per kind). |
| G21 | Done | `PublicMarket.defaultDeliveryLocation { postalCode, label }` in app-config and `storeInfo.market` (setting `market.defaultDeliveryLocation`). |
| G22 | Done / decision | (a) facet values are slugs; (b) price presets with counts (setting `search.pricePresets`); (c) unchanged: `best_selling` appears once sales reach `bestSellingMinOrders`; (d) order search matches seller names; (e) `orderCounts` takes `q` (REST `GET /orders/counts?q=`, GraphQL `orderCounts(q:)`). |
| G23 | Web | Use `POST /api/store/advertising/decisions` and `/events`; `visitorId` = the visitor session id or your first-party id. |
| G24 | Web / seed | `Category.image` exists; set it with admin category `imageId`. |
| G25 | Done | `ProductReview.viewerReported`; `Answer.viewerVotedHelpful`; questions `state=answered\|awaiting` and `RatingSummary.awaitingQuestions`; `ProductCard.isNewListing` and store `Product.isNewListing`; `bestSellerRank` on the store product detail; Official Store seller ratings filled. Not built: notifying the asker when answered (no topic yet). |
| G26 | Done / decision | (a) `ReturnShipment.dropOffCode` next to `qrCodeUrl`; the app draws the QR. (b) `ReturnDetail.refundEstimate` (`isEstimate: true`) until decided. (c) overview alerts `payment_failed` and `return_action_needed` (actions `view_order`, `view_return`); GraphQL `Customer.overviewAlerts`. (d) a shipping label now says "Shipment x of y"; "Package x of y" is the seller group. (e) `PaymentStatusView.placedAt` and `failedAt`. |
| G27 | Fixed | Notice links carry the id and ref of the screen they open (refund notices link to the order with its MK- ref). Icons use current Lucide names (`triangle-alert`, `circle-x`, …); notices stored earlier keep old names. |
| G28 | Partly | `SecurityOverview.hasPassword`; actions needing a password answer 409 `PASSWORD_NOT_SET` without counting a failure. No set-password flow (see G12). |
| G29 | Fixed / decision | (a) a signed-in customer redeeming an order link gets `guestSession: null`; (b) redemption returns `orderRef`; (c) `INVALID_CREDENTIALS` has `lockoutMinutes`; (d) tell us what else the reset lookup needs; (e) ref + email opens guest orders only: a registered customer's order answers 403 `GUEST_ORDER_SIGN_IN_REQUIRED` (never confirms the email); (f) no Google/Apple. |
| G30 | Done | (a) `POST /api/dev/checkout/sessions/{id}/changes` `{ lineId?, unitPrice?, stock? }`; (b) cosmetic, unchanged; (c) `retryAllowed` = pay again with any method, `retryable` = same card. Plus G60. |
| G31 | Done | (a) `category` optional when `problemType` is given; (b) breadcrumbs link to `/help?topic=<slug>`; (c) contact channels come from support only (`ContactChannel.detail`, `action {label, url, kind}`), no chat, GraphQL `HelpContactKind` = PHONE \| MESSAGE \| EMAIL; (d) `MediaRef.fileName`. |
| G32 | Done | (a) agreement URLs use the policy key (`/policies/seller_agreement`), `url` null when unpublished; (b) `companyLine` default "Marketly, Inc. · Portland, OR"; (c) `PublicMarket.company` (help, sellers and press emails, postal address, founded year, headquarters) and `StorePage.about.approvedSellerCount`. |
| G33 | Done | (a) `taxId` optional on save; (b) web: don't send an unchanged payout section; (c) `PUT /api/store/sellers/applications/{id}/response-draft`; (d) `SellerApplication.appeal`; (e) cancelled exports hidden unless `?includeCancelled=true` (GraphQL `dataRequests(includeCancelled:)`). |
| G34 | Decision | Coupon label "<campaign name> (<CODE>)". |
| G35 | Decision | Draw the QR from `otpauthUri` in the app (customers and sellers only; staff have no 2-step). |

### Seller Center (G36–G62)

| # | Status | Answer |
|---|---|---|
| G36 | Decision | Seller/admin `GET /assets/{id}` keeps `{ asset, usages, … }` (documented). |
| G37 | Fixed | `Money.formatted` everywhere; catalog `lowestPrice`/`bestPrice` filled (`offers.offer.created` carries the price). |
| G38 | Done | Drafts stay exempt; bulk preview rows carry `changePct` and `largeChange`: ask for `confirmLargeChanges`. |
| G39 | Fixed | After booking, the earnings card shows the booked refund and fee refund. |
| G40 | Done | Other and OnTrac carriers by default; handling range 0–3 days; `SellerShippingSettings.allowedHandlingDays {min, max}`. |
| G41 | Fixed | `onLabelQuantity` on order items; items on a bought, not handed-over label can't be cancelled (409 `CANCELLATION_NOT_ALLOWED`, "void the label first") on any path. |
| G42 | Done | `LABEL_FAILED` 422 = the carrier refused (change parcel or service), 502 = unreachable (retry); `details.carrierReached`. |
| G43 | Done | `GET /api/seller/content/help`, `/help/articles`, `/help/articles/{slug}`, `POST /help/articles/{id}/feedback` with the seller session. |
| G44 | Fixed | Actor names are recorded for real sessions (name claim in the access token). Older records keep no name. |
| G45 | Fixed / done | (a) guest buyers are named; (b) `Subject.itemSummary` ("Linen duvet cover + 2 more items"). |
| G46 | Done | Statement routes and downloads accept an `ST-` ref. |
| G47 | Done | (a) `StatementLine.sku` (and CSV); (b) `seller.product_sales` rows: `sku`, `skus[]`, `image`, `liveDiscount`, `averagePrice`, `returnedUnits`, `returnRate`; (c) `OfferSummary.stockItemId`; (d) "What goes live" shows titles, one row per product. |
| G48 | Done / decision | (a) metric `service.return_rate` (with comparison); (b) one report per export; (c) dashboard health keeps the policy window. |
| G49 | Done / fixed | (a) invited members' preferences answer 409 `MEMBER_NOT_JOINED` until they accept; (b) `GET /members?status=` (revoked/removed hidden by default, `all` shows them); (c) dev tokens use the real member id; (d) `finance.destinations.confirm` is owner-only (`OWNER_ONLY`). |
| G50 | Decision | Re-auth needs a password; dev-key seller tokens may send `reauthToken: "dev-reauth.payout-account"`. |
| G51 | Decision / exists | (a) brand claims keep `brandId` + evidence; (b) `GET /api/seller/reviews/feedback-summary`; (c) `CollectionInput` has `imageId` and `offerIds` (design gap). |
| G52 | Done | (a) `POST /api/seller/catalog/products/{id}/withdraw`, `DELETE /api/seller/catalog/products/{id}` (never-listed drafts); (b) unchanged; (c) `GET /api/seller/settings/current`; (d) seed. |
| G53 | Done | (a) offer counts `productDraft` and `productPublication`, list filter `productPublication`; (b) reason `bulk_update` allowed; (c) `DeliveryEstimate.locationLabel`. |
| G54 | Fixed / done | (a) readable dates in the market time zone; (b) seller timeline shows seller entries only; (c) GraphQL `ShipmentLabel.labelUrl`; (d) seller export filters accept `groupIds` / `refs` (≤ 500). |
| G55 | Fixed / done | (a) sellers may upload `return_evidence`; (b) `SellerStartInput.returnId`; (c) label charge estimate before approving (`labelChargeEstimated`); (d) `POST /api/seller/returns/requests/{id}/remedy/preview` `{kind, deductions?, amount?}`; (e) seller wording in the seller area; (f) inspection form unchanged. |
| G56 | Done | (a) `Message.viewerReported`; (b) `POST`/`DELETE /api/seller/reviews/questions/{id}/skip`, `state=skipped`; (c) not done yet: answers 2–1000, responses 1–2000, template names 80 characters; (d) `SellerFeedbackSummary.target { positivePct, label, meets }` (setting `reviews.sellerFeedbackTargetPct`, 95 is an example value); (e) `replyDue` is ISO. |
| G57 | Done / decision | (a) `Invitation.consentText` and `consentTextVersion` (send that version when accepting); (b) withdraw reason optional; (d) seller ads stay phase 3 (501); (e) not built. |
| G58 | Done / seed | (c) `TimelineEvent.state` (`info\|success\|warning\|danger`); (d) restriction scope categories with names; (e) evidence `documentType`, `Restriction.evidence[]`; (f) typed fields (G20). |
| G59 | Done | `PurchaseBox.officialStore` (`out_of_stock` / `not_shippable` / `unavailable`, restock date, price) when another seller holds the buy box. |
| G60 | Done | Card token `tok_pending` stays "being checked"; settle it with `POST /api/dev/payments/intents/{id}/settle { outcome }`. |
| G61 | Fixed | `payments.payment.failed` carries `orderRef`; the notice names the order. |
| G62 | Done | `POST /inbox/{id}/archive`, `POST /inbox/archive-all`, `?archived=true`, `Notice.archivedAt`. Archiving doesn't mark read; no unarchive; open action notices can't be archived (409 `NOTICE_ACTION_OPEN`). |

### Admin Center (G63–G77)

| # | Status | Answer |
|---|---|---|
| G63 | Fixed | `Money.formatted` everywhere. |
| G64 | Fixed / contract | (a) `walletAdmin` is in the schema (null while wallet is off); (b) AdminCase `$orderRef` optional; (c) GraphQL work summaries honour the caller's permissions; (d) AdminOrder selects `history` (the order timeline; `auditTrail` is audited staff actions only); (e) REST uses `all=true`, not `scope`. |
| G65 | Done | (a) the creator or submitter of a campaign can't confirm its funding (`SAME_REVIEWER`); (b) `HelpArticleAdmin.draftAuthor` and `canApprove`. |
| G66 | Decision / fixed | (a) an escalated case needs a recorded decision before resolve; (b) returns `exceptions` stat = the Exceptions tab; (c) customer security actions need both `act` and `security`. |
| G67 | Fixed | Inputs: `AdBudgetInput`, `FrequencyCapInput`, `DismissalRuleInput`, `RotationRuleInput` (labels server-made), `stopWithPromotion` optional, `AttributeInput` (optional id, no categoryId). `X-Step-Up-Code` is gone. |
| G68 | Done | Settings: reason optional at create/preview, required at submit (`submitChange` takes `{ reason }`). Optional reasons with an audited default for notification channel toggles, promotion pause, ad pause/finish, support bulk priority, catalog hide. |
| G69 | Done | (a) `SellerRow.slug`, admin seller detail accepts a slug; (b) REST cases/returns accept `CS-`/`RT-` refs; (c) ad campaigns accept `AD-` refs; (d) `TrustSubject.slug` and ref; (e) AdminOrder selects the seller `slug`. |
| G70 | Fixed | Actor names recorded (see G44); audit `byActor` groups by person. |
| G71 | Exists / seed | `POST /api/admin/access/authority-checks` returns `eligibleApprovers`; empty assignees and queue leads are seed data. |
| G72 | Done | Export datasets exist for the case queue, payout run, campaigns, inventory, receiving, shipping exceptions, inspections, finance checks, plus new `finance.admin.overview` and `advertising.admin.campaigns`. Audit export: poll `GET audit/exports/{id}`. |
| G73 | Done / decision | Staff notice `POST /api/admin/notifications/inbox/{id}/unread`; `POST /api/admin/trust/evidence-requests/{id}/cancel`; `DELETE /api/admin/shipping/notices/{id}` (drafts); `POST /admin/catalog/products/{id}/checks/{kind}/restore`; `AdminOrderRow.openExceptionIds` (remind via shipping `notify-seller`); a case from an order already exists. Finance sign-off stays per day; catalog bulk price/stock stays in offers/inventory. |
| G74 | Done / data | `SellerStats.balances`; low stock falls back to `defaultLowStockThreshold`; decided moderation items carry `decision`; `TrustReport.nextStep` and `subjectHistory`; promotions `officialMargin` (before/after/changePts) and `storeReturnsPct`; reports catalogue now 24 staff reports (incl. `trading.purchasing`, `trading.discounts_shipping`, `trading.returns_cost`, `service.complaints`, "Response time and case backlog"). On-time rates, unit costs and reach need data. |
| G75 | Done / decision | `AdminReturnRow.reasonCode`; `DeliveryException.items [{orderItemId, quantity}]`; `Receipt.inboundId`; typed `InspectionDraft` (unknown keys are dropped) with resolved photos; settings overview values carry `value` and `valueType`; help status names unchanged. |
| G76 | Fixed / seed | Email preheaders and push previews are cut after rendering; all 7 settings sections are reported. Seed states: the simulator covers most flows. |
| G77 | Done | New view permissions: `catalog.view`, `content.view`, `offers.official.view`, `sellers.applications.view`, `returns.inspections.view`. The Business Owner and every role holding a page's manage key get its view key, on new and existing databases. Admin catalog reads that were open to all staff now need `catalog.view`. |

## Decisions the owner took (2026-10-16)

Everything requested is built except what needs the internet (AI summary, real card payments, Google/Apple sign-in)
and phase-3 seller ads. Product images use `sharp` without HEIC. The buy box goes to the lowest delivered total,
with the Official Store winning ties. Guest lookup opens guest orders only. Pre-sale messages about a product are
allowed. The smaller rules use the recommended defaults listed in the tables above (G1, G7, G22c, G26a/d, G31b/c,
G32b, G33e, G34, G35, G36, G38, G40, G42, G48, G49a, G51a, G52b, G53b, G55f, G57b, G59, G65a, G66, G68, G73, G74,
G75). Tell us if any should change.

## Still open

- G5 guest back-in-stock, G7 live chat, G9 real card payments, G12/G28 passwordless set-password, G29f Google/Apple
  sign-in: not built by decision.
- G25d: notifying the asker when their question is answered (needs a notification topic).
- G56c: text limits are enforced but not yet written into the spec descriptions.
- G57e: seller ad campaign offerIds/pages and promotable offer prices (phase 3).
- Promotions flash-deal images keep the size promotions stores.
- Old records without actor names are not backfilled.
