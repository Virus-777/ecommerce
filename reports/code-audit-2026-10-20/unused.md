# Unused code

Part of the [code audit of 2026-10-20](README.md). Everything here was found by a tool and sample-checked by hand; see
"How this was checked" in the README.

## 1. Settings that nothing reads (10)

These show up as editable fields in Admin Center → Settings, but no backend code reads them, so changing them does
nothing (the same problem as the seller invitation lifetimes removed on 2026-10-19). Each was checked with a plain
text search as well.

| Setting | What the field says it does |
|---|---|
| `advertising.eventRetentionMonths` | Raw ad event retention |
| `finance.statementPeriod` | Statement period, aligned with the payout schedule |
| `inventory.costingMethod` | Company stock valuation |
| `inventory.allowSellerNegativeAvailable` | Never sell beyond available quantity |
| `promotions.sellerLeaveCutoff` | Until when a seller can leave a promotion without approval |
| `returns.maxMediaMb` | Upload size per file |
| `sellers.infoRequestDefaultDays` | Default reply window for information requests |
| `sellers.claimReviewBusinessDays` | Target to review store name changes and public claims |
| `sellers.launchReviewBusinessDays` | Target for the launch readiness review |
| `support.lateItemRefundAfterDays` | Items not shipped this long after the estimate qualify for a full refund (only a test mentions it) |

For each, decide: wire it up (the behaviour is hard-coded somewhere today) or remove it from the spec.

## 2. Backend: unused imports, variables and parameters (53)

The web apps already refuse these (`noUnusedLocals`/`noUnusedParameters` in tsconfig.base.json); the backend
doesn't, so they piled up. Found with `tsc --noUnusedLocals --noUnusedParameters`.

### Unused variables (4)

Two of them cost a database read on every call: the seller account view and the seller setup steps load the
seller's application and never use it.

- [src/modules/sellers/service/accounts.ts:141](../../backend/src/modules/sellers/service/accounts.ts#L141) `app` — `account()` loads the application for nothing
- [src/modules/sellers/service/accounts.ts:176](../../backend/src/modules/sellers/service/accounts.ts#L176) `app` — `setupSteps()` loads the application for nothing
- [src/modules/reports/service/queries.ts:994](../../backend/src/modules/reports/service/queries.ts#L994) `f`
- [src/modules/returns/service/views.ts:625](../../backend/src/modules/returns/service/views.ts#L625) `x`

### Unused imports (28)

- [src/modules/access/service.ts:4](../../backend/src/modules/access/service.ts#L4) `audit`
- [src/modules/access/service/approvals.ts:42](../../backend/src/modules/access/service/approvals.ts#L42) `defaultEligibleRoleKeys`
- [src/modules/access/service/away.ts:11](../../backend/src/modules/access/service/away.ts#L11) `identity`
- [src/modules/access/service/away.ts:24](../../backend/src/modules/access/service/away.ts#L24) `by`
- [src/modules/access/service/members.ts:11](../../backend/src/modules/access/service/members.ts#L11) `identity`
- [src/modules/access/service/members.ts:9](../../backend/src/modules/access/service/members.ts#L9) `audit`
- [src/modules/access/service/roles.ts:21](../../backend/src/modules/access/service/roles.ts#L21) `defaultEligibleRoleKeys`
- [src/modules/customers/service.ts:12](../../backend/src/modules/customers/service.ts#L12) `reports`
- [src/modules/customers/service/guest-orders.ts:13](../../backend/src/modules/customers/service/guest-orders.ts#L13) `identity`
- [src/modules/customers/service/marketing.ts:10](../../backend/src/modules/customers/service/marketing.ts#L10) `invalid`
- [src/modules/customers/service/profiles.ts:19](../../backend/src/modules/customers/service/profiles.ts#L19) `identity`
- [src/modules/customers/service/recently-viewed.ts:10](../../backend/src/modules/customers/service/recently-viewed.ts#L10) `identity`
- [src/modules/identity/domain/crypto.ts:5](../../backend/src/modules/identity/domain/crypto.ts#L5) `KeyObject`
- [src/modules/identity/service.ts:16](../../backend/src/modules/identity/service.ts#L16) `seconds`
- [src/modules/identity/service/sessions.ts:13](../../backend/src/modules/identity/service/sessions.ts#L13) `seconds`
- [src/modules/reviews/graphql/resolvers.ts:5](../../backend/src/modules/reviews/graphql/resolvers.ts#L5) `isOfficial`
- [src/modules/reviews/schema.ts:9](../../backend/src/modules/reviews/schema.ts#L9) `positive`
- [src/modules/sellers/service/accounts.ts:38](../../backend/src/modules/sellers/service/accounts.ts#L38) `ApplicationRec`
- [src/modules/sellers/service/accounts.ts:40](../../backend/src/modules/sellers/service/accounts.ts#L40) `SYSTEM`
- [src/modules/sellers/service/accounts.ts:6](../../backend/src/modules/sellers/service/accounts.ts#L6) `isAppError`
- [src/testing/module-suite.ts:12](../../backend/src/testing/module-suite.ts#L12) `routeUrlOf`
- [src/modules/access/service.ts:10](../../backend/src/modules/access/service.ts#L10) `ApprovalTarget`
- [src/modules/access/service.ts:32](../../backend/src/modules/access/service.ts#L32) `by`
- [src/modules/access/service/limits.ts:20](../../backend/src/modules/access/service/limits.ts#L20) `Role`
- [src/modules/access/service/limits.ts:44](../../backend/src/modules/access/service/limits.ts#L44) `by`
- [src/modules/access/service/members.ts:14](../../backend/src/modules/access/service/members.ts#L14) `Role`
- [src/modules/media/service.ts:43](../../backend/src/modules/media/service.ts#L43) `sameSpec`
- [src/modules/sellers/service/applications.ts:43](../../backend/src/modules/sellers/service/applications.ts#L43) `DATA_STEPS`

### Unused parameters (21)

Some are kept on purpose so a method matches its siblings (for example `caller` on the access read methods). The
`by` parameters on the seller application methods mean those changes are not attributed to anyone.

- [src/modules/access/service/members.ts:134](../../backend/src/modules/access/service/members.ts#L134) `caller`
- [src/modules/access/service/members.ts:153](../../backend/src/modules/access/service/members.ts#L153) `caller`
- [src/modules/access/service/roles.ts:43](../../backend/src/modules/access/service/roles.ts#L43) `caller`
- [src/modules/access/service/roles.ts:51](../../backend/src/modules/access/service/roles.ts#L51) `caller`
- [src/modules/promotions/service/seller-discounts.ts:37](../../backend/src/modules/promotions/service/seller-discounts.ts#L37) `sellerId`
- [src/modules/promotions/test/domain.test.ts:127](../../backend/src/modules/promotions/test/domain.test.ts#L127) `l`
- [src/modules/purchasing/service/receipts.ts:72](../../backend/src/modules/purchasing/service/receipts.ts#L72) `by`
- [src/modules/reports/service/queries.ts:509](../../backend/src/modules/reports/service/queries.ts#L509) `cfg`
- [src/modules/reports/service/queries.ts:889](../../backend/src/modules/reports/service/queries.ts#L889) `cfg`
- [src/modules/returns/service/handling.ts:144](../../backend/src/modules/returns/service/handling.ts#L144) `id`
- [src/modules/sellers/service/accounts.ts:687](../../backend/src/modules/sellers/service/accounts.ts#L687) `by`
- [src/modules/sellers/service/applications.ts:247](../../backend/src/modules/sellers/service/applications.ts#L247) `by`
- [src/modules/sellers/service/applications.ts:325](../../backend/src/modules/sellers/service/applications.ts#L325) `by`
- [src/modules/sellers/service/applications.ts:394](../../backend/src/modules/sellers/service/applications.ts#L394) `by`
- [src/modules/sellers/service/applications.ts:448](../../backend/src/modules/sellers/service/applications.ts#L448) `by`
- [src/modules/sellers/service/applications.ts:990](../../backend/src/modules/sellers/service/applications.ts#L990) `by`
- [src/modules/shipping/service/estimates.ts:295](../../backend/src/modules/shipping/service/estimates.ts#L295) `w`
- [src/modules/wishlist/service.ts:122](../../backend/src/modules/wishlist/service.ts#L122) `customerId`
- [src/modules/wishlist/service.ts:259](../../backend/src/modules/wishlist/service.ts#L259) `customerId`
- [src/modules/workqueues/app/dayend.ts:221](../../backend/src/modules/workqueues/app/dayend.ts#L221) `by`
- [src/testing/flows.ts:104](../../backend/src/testing/flows.ts#L104) `clock`

## 3. Exports nothing uses

Found with an import/export graph of every file (re-exports, `export *` barrels, namespace imports and lazy page
imports are followed). Spot-checked by plain text search: no false positives found.

### Backend (65)

- [src/kernel/lib/money.ts:24](../../backend/src/kernel/lib/money.ts#L24): `subtract`, `compare`, `isZero`
- [src/modules/advertising/domain/rules.ts:17](../../backend/src/modules/advertising/domain/rules.ts#L17): `BASE_BLOCKED`, `LIVE_LIKE`
- [src/modules/advertising/ports.ts:13](../../backend/src/modules/advertising/ports.ts#L13): `CampaignCreativeRec` (type), `ReviewRec` (type), `AttributionRec` (type)
- [src/modules/audit/domain/chain.ts:124](../../backend/src/modules/audit/domain/chain.ts#L124): `fromHex`, `Checkpoint` (type)
- [src/modules/cart/domain/rules.ts:267](../../backend/src/modules/cart/domain/rules.ts#L267): `unavailableReason`, `sumMoney`
- [src/modules/checkout/graphql/resolvers.ts:91](../../backend/src/modules/checkout/graphql/resolvers.ts#L91): `gqlSession`
- [src/modules/customers/domain/rules.ts:34](../../backend/src/modules/customers/domain/rules.ts#L34): `blocksOrdering`, `blocksMessaging`, `STILL_WORKS`
- [src/modules/fulfillment-service/domain/rules.ts:60](../../backend/src/modules/fulfillment-service/domain/rules.ts#L60): `REIMBURSEMENT`
- [src/modules/fulfillment-service/service/core.ts:67](../../backend/src/modules/fulfillment-service/service/core.ts#L67): `invalidField`, `illegal`
- [src/modules/identity/domain/state-machines.ts:9](../../backend/src/modules/identity/domain/state-machines.ts#L9): `sessionMachine`, `verificationChallengeMachine`
- [src/modules/inventory/domain/rules.ts:41](../../backend/src/modules/inventory/domain/rules.ts#L41): `isGroup`, `SELLER_REASONS`, `STAFF_REASONS`
- [src/modules/media/domain/rules.ts:11](../../backend/src/modules/media/domain/rules.ts#L11): `OwnerKind` (type)
- [src/modules/messaging/domain/rules.ts:10](../../backend/src/modules/messaging/domain/rules.ts#L10): `isOfficialStore`, `ReplyState` (type)
- [src/modules/notifications/domain/state-machines.ts:15](../../backend/src/modules/notifications/domain/state-machines.ts#L15): `actionNoticeMachine`
- [src/modules/offers/domain/rules.ts:35](../../backend/src/modules/offers/domain/rules.ts#L35): `SELLING`, `LISTED`
- [src/modules/orders/domain/rules.ts:154](../../backend/src/modules/orders/domain/rules.ts#L154): `SELLER_TAB_STATUSES`, `amountOf`
- [src/modules/payments/domain/rules.ts:23](../../backend/src/modules/payments/domain/rules.ts#L23): `RESERVING`
- [src/modules/payments/service/views.ts:371](../../backend/src/modules/payments/service/views.ts#L371): `customerStateLabel`
- [src/modules/promotions/domain/rules.ts:16](../../backend/src/modules/promotions/domain/rules.ts#L16): `SELLER_KINDS`
- [src/modules/promotions/ports.ts:14](../../backend/src/modules/promotions/ports.ts#L14): `ParticipationOfferRec` (type), `ClipRec` (type), `EvaluationRec` (type), `UsageRec` (type), `ReminderRec` (type)
- [src/modules/purchasing/domain/rules.ts:21](../../backend/src/modules/purchasing/domain/rules.ts#L21): `PENDING_DELIVERY_STATUSES`, `lineTotal`
- [src/modules/purchasing/views.ts:452](../../backend/src/modules/purchasing/views.ts#L452): `asMoney`
- [src/modules/reports/domain/catalogue.ts:681](../../backend/src/modules/reports/domain/catalogue.ts#L681): `reportSeed`
- [src/modules/returns/domain/rules.ts:54](../../backend/src/modules/returns/domain/rules.ts#L54): `CustomerReason` (type)
- [src/modules/reviews/domain/rules.ts:142](../../backend/src/modules/reviews/domain/rules.ts#L142): `ANONYMOUS_ASKER`, `removesContent`
- [src/modules/reviews/ports.ts:17](../../backend/src/modules/reviews/ports.ts#L17): `QuestionSkipRec` (type)
- [src/modules/reviews/service/content.ts:45](../../backend/src/modules/reviews/service/content.ts#L45): `statusOf`
- [src/modules/search/domain/document.ts:67](../../backend/src/modules/search/domain/document.ts#L67): `attributeNames`
- [src/modules/search/domain/text.ts:27](../../backend/src/modules/search/domain/text.ts#L27): `attrValue`
- [src/modules/sellers/domain/rules.ts:167](../../backend/src/modules/sellers/domain/rules.ts#L167): `addressKey`, `actorLabel`
- [src/modules/settings/domain/catalogue.ts:16](../../backend/src/modules/settings/domain/catalogue.ts#L16): `ApplyScope` (type)
- [src/modules/shipping/domain/exceptions.ts:5](../../backend/src/modules/shipping/domain/exceptions.ts#L5): `EXCEPTION_KINDS`
- [src/modules/shipping/domain/tracking.ts:228](../../backend/src/modules/shipping/domain/tracking.ts#L228): `FINAL`
- [src/modules/support/domain/rules.ts:13](../../backend/src/modules/support/domain/rules.ts#L13): `Party` (type), `MONEY_KINDS`, `priorityRank`
- [src/modules/trust/domain/rules.ts:12](../../backend/src/modules/trust/domain/rules.ts#L12): `Source` (type), `ACTION_KEYS`
- [src/modules/warehouse/domain/rules.ts:9](../../backend/src/modules/warehouse/domain/rules.ts#L9): `ACTIVE_STATUSES`, `binMatches`
- [src/modules/workqueues/domain/catalog.ts:214](../../backend/src/modules/workqueues/domain/catalog.ts#L214): `DEFAULT_DEADLINE_MINUTES`
- [src/modules/workqueues/domain/rules.ts:205](../../backend/src/modules/workqueues/domain/rules.ts#L205): `dateText`

Also: the generated state machines `sessionMachine`, `verificationChallengeMachine` (identity) and
`actionNoticeMachine` (notifications) are unused; those statuses are written directly instead.

### Web apps (64)

- [frontend/src/api/catalog.ts:9](../../../Ecommerce-frontend/frontend/src/api/catalog.ts#L9): `Brand` (type)
- [frontend/src/api/news.ts:13](../../../Ecommerce-frontend/frontend/src/api/news.ts#L13): `NewsCategory` (type)
- [frontend/src/pages/account/data/messages.ts:8](../../../Ecommerce-frontend/frontend/src/pages/account/data/messages.ts#L8): `Conversation` (type)
- [frontend/src/pages/store/data/checkout-api.ts:12](../../../Ecommerce-frontend/frontend/src/pages/store/data/checkout-api.ts#L12): `CartPackage` (type), `CouponPreview` (type), `CheckoutPackage` (type), `QuoteTotals` (type), `ConfirmationView` (type)
- [frontend/src/pages/store/data/offers.ts:7](../../../Ecommerce-frontend/frontend/src/pages/store/data/offers.ts#L7): `OfferComparison` (type)
- [frontend/src/pages/store/data/product.ts:13](../../../Ecommerce-frontend/frontend/src/pages/store/data/product.ts#L13): `CatalogVariant` (type), `AddItemResult` (type)
- [frontend/src/pages/store/data/purchase.tsx:47](../../../Ecommerce-frontend/frontend/src/pages/store/data/purchase.tsx#L47): `sellerHref`
- [frontend/src/pages/store/data/review-parts.tsx:34](../../../Ecommerce-frontend/frontend/src/pages/store/data/review-parts.tsx#L34): `matchesAll`
- [frontend/src/pages/store/data/reviews.ts:9](../../../Ecommerce-frontend/frontend/src/pages/store/data/reviews.ts#L9): `ReviewMedia` (type)
- [admin-center/src/app/parts.tsx:176](../../../Ecommerce-frontend/admin-center/src/app/parts.tsx#L176): `iconOf`
- [admin-center/src/pages/admin/data/ads.ts:20](../../../Ecommerce-frontend/admin-center/src/pages/admin/data/ads.ts#L20): `PerformanceReport` (type), `pct`
- [admin-center/src/pages/admin/data/cases.ts:35](../../../Ecommerce-frontend/admin-center/src/pages/admin/data/cases.ts#L35): `Remedy` (type)
- [admin-center/src/pages/admin/data/customers.ts:12](../../../Ecommerce-frontend/admin-center/src/pages/admin/data/customers.ts#L12): `DataRequest` (type)
- [admin-center/src/pages/admin/data/news.tsx:13](../../../Ecommerce-frontend/admin-center/src/pages/admin/data/news.tsx#L13): `NewsPost` (type), `NewsVersion` (type), `DraftReview` (type)
- [admin-center/src/pages/admin/data/official.ts:8](../../../Ecommerce-frontend/admin-center/src/pages/admin/data/official.ts#L8): `Trading` (type)
- [admin-center/src/pages/admin/data/payouts.ts:12](../../../Ecommerce-frontend/admin-center/src/pages/admin/data/payouts.ts#L12): `RunApproval` (type)
- [admin-center/src/pages/admin/data/promotions.ts:12](../../../Ecommerce-frontend/admin-center/src/pages/admin/data/promotions.ts#L12): `PromoFunding` (type)
- [admin-center/src/pages/admin/data/seller.ts:10](../../../Ecommerce-frontend/admin-center/src/pages/admin/data/seller.ts#L10): `SellerStats` (type), `SuspensionImpact` (type), `DeadlineTone` (type)
- [admin-center/src/pages/admin/data/shipping.ts:7](../../../Ecommerce-frontend/admin-center/src/pages/admin/data/shipping.ts#L7): `ShippingMethod` (type)
- [admin-center/src/pages/admin/data/trust-decisions.ts:11](../../../Ecommerce-frontend/admin-center/src/pages/admin/data/trust-decisions.ts#L11): `RecAction` (type), `canDismissStatus`
- [admin-center/src/pages/admin/data/trust.ts:12](../../../Ecommerce-frontend/admin-center/src/pages/admin/data/trust.ts#L12): `TrustOverview` (type)
- [admin-center/src/pages/ops/data/work-items.ts:106](../../../Ecommerce-frontend/admin-center/src/pages/ops/data/work-items.ts#L106): `ActionKey` (type)
- [seller-center/src/pages/data/catalog-parts.tsx:180](../../../Ecommerce-frontend/seller-center/src/pages/data/catalog-parts.tsx#L180): `downloadCsv`
- [seller-center/src/pages/data/customers.ts:9](../../../Ecommerce-frontend/seller-center/src/pages/data/customers.ts#L9): `ReplyTemplate` (type), `FeedbackSummary` (type)
- [seller-center/src/pages/data/marketing.ts:13](../../../Ecommerce-frontend/seller-center/src/pages/data/marketing.ts#L13): `EarningsImpact` (type), `SellerAdsSummary` (type), `SellerOfferRow` (type), `moneyOr`, `formatPT`, `dayPT`, `isoDayPT`
- [seller-center/src/pages/data/orders.ts:11](../../../Ecommerce-frontend/seller-center/src/pages/data/orders.ts#L11): `OrderCounts` (type), `DocumentLink` (type), `Shipment` (type), `ShippingProfile` (type)
- [seller-center/src/pages/data/returns.ts:14](../../../Ecommerce-frontend/seller-center/src/pages/data/returns.ts#L14): `SellerReturnTerms` (type)
- [seller-center/src/pages/data/staff.ts:9](../../../Ecommerce-frontend/seller-center/src/pages/data/staff.ts#L9): `RoleTemplate` (type)
- [web-shared/src/api/appConfig.ts:11](../../../Ecommerce-frontend/web-shared/src/api/appConfig.ts#L11): `AppConfig` (type)
- [web-shared/src/config.ts:7](../../../Ecommerce-frontend/web-shared/src/config.ts#L7): `OFFICIAL_STORE_NAME`
- [web-shared/src/data/fixtures.ts:105](../../../Ecommerce-frontend/web-shared/src/data/fixtures.ts#L105): `categories`, `brands`, `auroraOffers`, `customer`, `order`, `orders`, `sellerOrders`, `staffRoles`, `sales14`
- [web-shared/src/lib/crop.ts:40](../../../Ecommerce-frontend/web-shared/src/lib/crop.ts#L40): `centredCrop`
- [web-shared/src/routes/PageStub.tsx:5](../../../Ecommerce-frontend/web-shared/src/routes/PageStub.tsx#L5): `PageStub`
- [web-shared/src/ui/Charts.tsx:135](../../../Ecommerce-frontend/web-shared/src/ui/Charts.tsx#L135): `Sparkline`
- [web-shared/src/ui/Structure.tsx:307](../../../Ecommerce-frontend/web-shared/src/ui/Structure.tsx#L307): `QueueTile`

About 600 of the 1,029 lines of `web-shared/src/data/fixtures.ts` are sample data nothing uses any more
(`categories`, `brands`, `auroraOffers`, `customer`, `order`, `orders`, `sellerOrders`, `staffRoles`,
`sales14`); the rest still feeds the design/theme demo pages.

## 4. Unused files

- **All 33 `src/modules/*/permissions.ts`** — created by the module scaffold (`tools/lib/scaffold.ts`) and never imported;
  the module system reads permissions from the spec. Dead.
- **30 of 33 `src/modules/*/contract.ts`** are never imported (only cart, sellers, and customers from a test are).
  These are the boundary-approved public surface of each module, so they are scaffolding rather than a mistake; they
  only need removing if you want no empty files.
- No unused files in the web apps.

## 5. Unused CSS classes (27)

Defined in the stylesheets, never used in any component.

- `web-shared/src/styles/marketly.css`: `gap-9`, `lg5`, `lg6`, `wide-aside`, `vr`, `swatch`, `row-card`, `end1`,
  `end2`, `shop-row`, `buy-or`, `acct-seg-info`, `acct-wish`, `sa-mid`, `sa-ro`, `c4`, `aa-mark`, `aa-lines`,
  `gap-0-5`, `help-body`, `u-flex-none`, `u-w-96px`
- `frontend/src/pages/store/Reviews.css`: `rv-topic`, `rv-n`
- `admin-center/src/pages/admin/Report.css`: `rpd-cols`
- `seller-center/src/pages/HelpArticle.css`: `ha-answer`, `ha-steps`

## 6. Code kept for things that are never switched on

- **OpenSearch engine** — `search/providers/opensearch/*` (about 1,450 lines) and `search/index-feed.ts` (187 lines).
  Both env examples set `SEARCH_ENGINE=mongo` and the production server is one offline machine; only tests use it.
  Its ranking scripts are "twins" of the MongoDB ranking that must be changed together.
- **Job "business hours" window** — `src/kernel/jobs/index.ts:21,34` parses `window: 'business-hours'` from a job
  schedule but no scheduler reads it, so jobs described as "during business hours" (warehouse auto-waves) run all day.

## 7. Smaller lists

- [Exports used only inside their own file](exports-own-file-only.md) — 613 backend, 258 web. Only the `export` keyword is unneeded.
- [Backend exports used only by tests](exports-test-only.md) — 87. Some are deliberate test hooks, some are leftovers.
- npm packages: none unused.
