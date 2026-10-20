# Web apps: components, hooks and API plumbing

Part of the [code audit of 2026-10-20](README.md). Paths are relative to `E:/Work/Ecommerce-frontend`; every location
was read by the reviewer. Severity: **high** = copies already behave or look different, or a bug risk; **medium** =
3+ copies; **low** = 2 trivial copies. Export polling, colour tints, time-zone conversion and actor labels are on the
[formatting page](duplicates-web-formatting.md) (H3, H6, H12, H13).

**What web-shared exports:** ui (Steps, Timeline, StatusLegend, QueueTile, SellerBadge, Img, FileDrop, Field,
EmptyState, SummaryRow, KeyValue, LazyLoad, Pager, Meter, statusTone, DateTimeField, Dialog…), lib/hooks (useView,
useMediaQuery, useIsPhone, useScrollRegion, useBodyLock, useCountdown, useElementWidth), api (useAppConfig, useMarket,
uploadMedia, useUploads, fileSize, errorMessage, ApiError). `installationId()` exists in api/session.ts:63 but isn't
exported. **Missing from web-shared and copied 3+ times:** useDebounced, useInView, LoadError, skeletons, export and
download helpers, time-zone converters, an HTML renderer.

**Summary.** 36 groups: 17 high, 13 medium, 6 low. In 13 groups web-shared already has the right piece and the apps
bypass it, sometimes because of out-of-date comments.

## High

**1. One cache key holds two data shapes (admin category tree).** admin PromotionNew.tsx:343 stores a flattened
`{id, name, offers}[]` under `['catalog', 'categories', 'admin']`; eight other screens read a raw tree under the same
key (AdCampaign.tsx:338, Catalog.tsx:75, Categories.tsx:796, Content.tsx:166, data/setting-value.tsx:152,
Official.tsx:134, ProductReview.tsx:80, Sellers.tsx:122). Whichever screen fills the cache first decides what the others
get. Fix shape: one admin hook returning the raw tree; each screen derives its own view.

**2. LoadError / ListError: 13 components and ~40 inline copies that already look different.** frontend
api/cards.tsx:177, account/data/order-parts.tsx:10, help/data/states.tsx:7, store/data/review-parts.tsx:179,
account/Reports.tsx:69, account/Reviews.tsx:99; admin app/parts.tsx:141; seller data/catalog-parts.tsx:34,
data/home.tsx:85, Customers.tsx:89, Finance.tsx:87, Marketing.tsx:50, Orders.tsx:81. Button style, icon, layout, prop
name (`onRetry`/`retry`) and apostrophes differ; only the admin one turns a 403 into "Not available for your role".
Best: admin parts.tsx, moved to web-shared.

**3. Skeletons: 15+ copies; screen readers hear different things.** Row, line, table-row and page skeletons in all
three apps (e.g. admin parts.tsx:160 = seller home.tsx:97; admin Staff.tsx:49 = ops/data/shared.tsx:53). Some are
aria-hidden, some `role=status` with a label, some `aria-busy`: the same loading state is announced on some screens and
silent on others.

**4. `useInView` (phone infinite lists).** frontend order-parts.tsx:85, seller catalog-parts.tsx:86 and returns.ts:101
use a 200px margin; admin data/seller.ts:130 has none (next page loads later); seller data/orders.ts:113 has none and no
IntersectionObserver guard (throws where it's missing). Inline observers in frontend cards.tsx:189 and help/Cases.tsx:45.

**5. `Steps` re-implemented, and three screens double the screen-reader text.** Line-for-line copies of web-shared
Steps in admin SellerApplication.tsx:108, ops/Receiving.tsx:120, AdCampaign.tsx:222, PromotionNew.tsx:260; seller
AdRequest.tsx:76; frontend purchase.tsx:136. seller BulkUpdate.tsx:239, CatalogMatch.tsx:115 and Offer.tsx:442 add their
own "Step n of m", which Steps already adds, so screen readers hear it twice.

**6. Row edge and deadline tone.** Edge helpers in admin Finance.tsx:46, Orders.tsx:33/34, Returns.tsx:37/38, seller
Returns.tsx:29/30, Orders.tsx:60, Products.tsx:76. In seller returns.ts `deadlineTone` (:75) lower-cases the state but
`rowEdge` (:80) doesn't: with upper-case states the chip turns red and the row edge stays blank.

**7. Images that bypass web-shared `Img`.** seller Store.tsx:113 `Pic`, frontend review-parts.tsx:68 `Photo`, and raw
`<img>` for API media in frontend cards.tsx:27, Brand.tsx:78, Seller.tsx:168, seller Marketing.tsx:419, Store.tsx:332.
`Img` rewrites `/files/` links to the same origin and shows an icon when loading fails; these show a broken image.

**8. Rich-text renderers drifted.** frontend help/data/html.tsx (parse :20, convert :26, htmlToText :68, RichText :78,
InlineHtml :117, DataTable :125) vs seller data/help-html.tsx (:38–:131) vs admin data/news.tsx (convert :215, RichText
:245). The seller copy puts `key` inside spread props (React warning), drops `#` links and doesn't decode `&#39;` /
`&quot;`; the admin news preview uses its own allow-list, so it renders differently from the store's NewsPost.tsx:92.

**9. Store vs staff password pieces.** Emailed-link token: frontend auth/data/parts.tsx:76 `useHashToken` loses it on
remount, admin app/passwords.tsx:14 keeps it. Password rules: frontend parts.tsx:303 tells screen readers met/not met,
admin passwords.tsx:60 doesn't and words them differently. Sign-in error text differs for the same codes (frontend
authError :121, admin SignIn.tsx:55, seller SignIn.tsx:31).

**10. web-shared `FileDrop` doesn't reset its input** (Forms.tsx:153): after removing a file, picking the same file
again does nothing. The app copies reset it: seller Return.tsx:116, AdRequest.tsx:95, admin ops/ReturnInspection.tsx:541.

**11. `screenHref`: admin vs seller.** admin app/parts.tsx:113 maps any snake_case state to a view and falls back to
the list; seller data/home.tsx:71 needs an exact match, so a state like `information_required` never opens its view.

**12. Meter percentage: three formulas** (admin Seller.tsx:91, seller Dashboard.tsx:87, seller data/reports.ts:98):
the same metric draws a different bar on each screen.

**13. `iconFor`.** frontend help/data/states.tsx:71 uses a hard-coded 27-icon list; web-shared Icon.tsx:40 checks the
full registry. Other icons show as `circle-help` on help pages only.

## Medium

- **14. App config query re-implemented:** frontend checkout-api.ts:93 redefines `useAppConfig` (same name and key);
  inline copies in help/Article.tsx:31, info/About.tsx:22, info/Policy.tsx:43, store/NotFound.tsx:56.
- **15. `useDebounced`: 10 identical copies** (frontend suggestions.tsx:17, account/Orders.tsx:29, help/Center.tsx:22,
  store/questions.ts:104; admin customers.ts:60, data/seller.ts:120; seller catalog-parts.tsx:76, orders.ts:103,
  returns.ts:91, HelpArticle.tsx:27) plus 6 inline debounces.
- **16. `Timeline` re-implemented ×6 + 3 inline** (admin Case.tsx:44, Order.tsx:47, Purchasing.tsx:84, Seller.tsx:100,
  SellerApplication.tsx:128; seller Return.tsx:93). Comments say the shared one lacks the "At risk:" prefix; it has it
  (Structure.tsx:245).
- **17. `StatusLegend` re-implemented:** `OpsLegend`, `UrgencyLegend` (comments wrongly say the shared one lacks
  "Legend:"), 8 `EdgeLegend`, ~14 inline; the legend text is written out 22 times.
- **18. Table helpers:** `SpanRow` ×2, `EmptyRow`, `NoLines`; `RowButton` ×2 re-implements Button's `srLabel`.
- **19. Installation id:** admin and seller `device()` only read it; frontend creates it in two places; the key string
  is repeated 5 times.
- **20. `QueueTile` re-implemented** in seller Dashboard.tsx:96, Returns.tsx:48 and admin Dashboard.tsx:324, 340.
- **21. `SellerBadge` written inline** in frontend Offers.tsx:328, Search.tsx:88, CheckoutReviewChanges.tsx:309, admin
  Order.tsx:398.
- **22. Checklist (`.ab-checks`) markup ×5.**
- **23. Upload lists:** frontend UploadList vs inline seller copies that differ; `fileSize` re-implemented ×3; the same
  accept regex in 4 files.
- **24. Reason-prompt dialogs ×3** (seller-decisions.tsx:124, HelpContent.tsx:169, News.tsx:796); Cancel is disabled
  while saving in two of them only.
- **25. Field error text:** `ErrorText` ×2, `FileError`, and 85 inline error spans in 51 files that web-shared `Field`
  already renders.
- **26. Before/after pair ×3** (ops/data/shared.tsx:28, admin Audit.tsx:31, Settings.tsx:578).

## Low

27 category-tree hook twice in the store (api/catalog.ts:14, store/data/product.ts:95); 28 admin `BodyEditor` twice
(news.tsx:100, HelpContent.tsx:107); 29 report result casts in admin and seller; 30 raw markup instead of `EmptyState`
/ `SummaryRow`, `SumList` ×2; 31 US state list twice (Addresses.tsx:34, checkout-api.ts:192); 32 app names that clash
with web-shared exports with a different meaning (`Count`, `statusTone`, `useAppConfig`), so an auto-import can pick
the wrong one.

Dropped after reading (different jobs): validate, toInput, toForm, NotFound, Frame, useRefresh, noticeHref,
useInvitations, DeliveryList, Diff, AnswerDialog, ReportDialog, SignedIn, flatten helpers, SellerCell (apart from its
badge), domain rowEdge rules, step-up flows.
