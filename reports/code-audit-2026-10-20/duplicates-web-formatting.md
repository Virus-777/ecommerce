# Web apps: formatting and small data helpers

Part of the [code audit of 2026-10-20](README.md). Paths are relative to `E:/Work/Ecommerce-frontend` (packages
`frontend/` = store, `admin-center/`, `seller-center/`, `web-shared/`); backend paths say `backend`. Every location was
read by the reviewer. Severity: **high** = copies already give users different output, or a bug; **medium** = 3+
copies; **low** = 2 trivial copies.

**What web-shared already offers:** `lib/format.ts` (`money` in dollars, `num`, `percentOff`, `initials`,
`formatMoney`, `dollars`, `isoInText`), `api/uploads.ts` `fileSize`, `ui/Media.tsx` `sameOriginFile`,
`ui/Badge.tsx` `STATUS_TONE`/`statusTone`, `routes/href.ts` `href`. **There is no shared helper for dates, Pacific
time, plurals, labels, phones, addresses, exports or downloads**, so each app wrote its own.

**Summary.** 36 groups: 14 high, 10 medium, 12 low, about 230 definitions and inline sites. Dates and time zones are
the biggest gap, with one confirmed bug (H2).

## High

**H1. Pacific-time date formatting: about 15 drifted sets.**
- Per-file sets: admin-center/src/app/parts.tsx:8-27; seller-center/src/pages/data/home.tsx:9-28 (same set);
  frontend/src/pages/account/data/when.ts:3-28; frontend/src/pages/help/data/format.ts:4-25;
  frontend/src/pages/account/data/orders.ts:415-433; frontend/src/pages/store/data/product.ts:168-173;
  frontend/src/pages/store/data/checkout-api.ts:173-178; seller-center/src/pages/data/customers.ts:37-44,
  orders.ts:39-51, returns.ts:45-62, catalog-parts.tsx:168-176, finance.ts:65-78, marketing.ts:19, 89-101.
- Single helpers in store Collection.tsx:27, Deals.tsx:32, Seller.tsx:40, app/session.tsx:43, api/news-cards.tsx:15,
  store/data/campaign-pages.tsx:13.
- Same name, different output: `fmtDateTime` gives "Tue, Oct 13, 11:21 AM" (account orders.ts:427), "Oct 19, 11:59 PM
  PT" (product.ts:172) and "Oct 4, 7:02 PM" (seller returns.ts:56). The " PT" suffix appears on some screens only.
- Best base: the admin `parts.tsx` set.

**H2. Date-only vs timestamp handling — one confirmed bug.**
- Safe for "YYYY-MM-DD" input: admin parts.tsx:12, seller home.tsx:13, help format.ts:8, account orders.ts:416-418,
  seller orders.ts:54, finance.ts:68, store Seller.tsx:40.
- Unsafe (a date-only value shows the previous day in Pacific time): when.ts:5, seller returns.ts:46,
  catalog-parts.tsx:173, customers.ts:38, marketing.ts:98, product.ts:170, Seller.tsx:41, news-cards.tsx:15.
- **Bug:** seller-center/src/pages/Finance.tsx:571 passes `pendingChange.requestedAt` (a timestamp) to finance.ts:71
  `fmtDay`, a date-only formatter that cuts the first 10 characters (the UTC date). A payout-account change requested
  after about 5 PM Pacific shows as "in review since" the next day. (Verified.)

**H3. Converting a Pacific wall time to an instant: 10 copies, two algorithms.** One pass (an hour off near a
daylight-saving change): admin Content.tsx:92/96/100, data/news.tsx:73/78/83, HelpContent.tsx:86/90/94,
PromotionNew.tsx:167/173/178. Two passes (correct): admin data/ads.ts:95, 103; seller marketing.ts:47, 55. Others:
seller orders.ts:66, 73; admin data/staff.ts:127 and Audit.tsx:45-48 (same hour-only parsing twice); admin
data/cases.ts:75. admin Official.tsx:48 `localNow` uses the browser's time zone while other admin screens use Pacific.
Best: the ads.ts pair, next to web-shared `DateTimeField`.

**H4. Same helper name, different units.**
- `usd`: cents in admin data/order.ts:119, PromotionNew.tsx:135, ops ReturnInspection.tsx:91; dollars in admin
  Purchasing.tsx:30, seller marketing.ts:32.
- `money`: web-shared format.ts:2 takes dollars; CheckoutReviewChanges.tsx:30 and period-dashboard.tsx:116 take cents;
  admin Order.tsx:44 and seller returns.ts:82 take a MoneyValue.
- `pct`: basis points in seller marketing.ts:35 ("15%") and admin data/finance.ts:72 ("15", no %); a percent in admin
  data/ads.ts:89, Official.tsx:44, seller Reports.tsx:20 ("15.0%"), store Seller.tsx:42 ("15%").
- `signedMoney`: MoneyValue in admin data/seller.ts:51, dollars with "+" in seller finance.ts:60.

**H5. Parsing typed money into cents: about 10 copies accepting different input.** toCents (frontend
api/listing.tsx:73, admin PromotionFlashItems.tsx:19, seller Shipping.tsx:62), toMinor (admin data/cases.ts:84,
seller catalog-parts.tsx:157, seller returns.ts:86 — doesn't strip "$"), parseMinor (admin data/order.ts:122), cents
(admin PromotionNew.tsx:134), parseMoneyField (admin data/staff.ts:56). "$12.50" is accepted on the seller product
form but rejected on the seller refund form; invalid input gives null in some copies and NaN in others. Best: seller
catalog-parts `toMinor`.

**H6. Logo tile initials and colours: 8 initials helpers, 7 colour rules.** Initials: web-shared format.ts:13, frontend
api/catalog.ts:104 (= account orders.ts:493), account data/messages.ts:21, store data/purchase.tsx:32, admin
data/seller.ts:41, data/categories.ts:102, data/product-review.ts:132, help OrderProblem.tsx:413. Colours: catalog.ts:114
(hash seed 7), messages.ts:31 (seed 0), purchase.tsx:31 (char sum), account Order.tsx:291 and GuestOrders.tsx:372 (list
index), admin Order.tsx:43 and Orders.tsx:35 (first letter), admin data/seller.ts:49, data/categories.ts:106. The same
seller gets a different colour (and sometimes initials: "MO" vs "OS" for Marketly Official Store) on Search, Cart,
Messages, the order page and admin screens.

**H7. Turning keys into labels.** account orders.ts:438, help format.ts:31 (gives "PARTLY DELIVERED"), admin
trust-reports.ts:70, ops data/shared.tsx:47, seller returns.ts:87, admin data/seller.ts:34, account Reviews.tsx:58,
admin setting-shape.ts:102 `words` (identical to backend settings/domain/values.ts:319); backend returns and support
`human` don't lowercase. About 20 inline `.replace(/_/g, ' ')` don't capitalise. The same status reads "Partly
delivered", "PARTLY DELIVERED" or "partly delivered" depending on the screen.

**H8. Status colours contradicting web-shared `STATUS_TONE`.** account Messages.tsx:50 shadows `statusTone`
(Cancelled red vs neutral, Refunded green vs neutral, Delivery failed amber vs red); seller Help.tsx:33 CASE_TONE
differs for reopened/waiting/decided; seller Order.tsx:54 makes partly_shipped amber while account orders.ts:449-456
makes it blue; inside account orders.ts, `groupTone` and `stateTone` disagree.

**H9. Condition labels differ between cart and checkout.** store purchase.tsx:19-27 "Used – like new" (cart) vs
seller catalog-parts.tsx:104-111 and the backend "Used – Like new" (checkout); ops returns.ts:21 and
ReturnInspection.tsx:429 hard-code their own.

**H10. `productHref` / `sellerHref` builders.** productHref: api/search.ts:51 ({id, slug}), store data/product.ts:33
(slug, id — reversed), purchase.tsx:50 (fallback "item"), account orders.ts:482, plus 6 inline. sellerHref:
cards.tsx:33 (null without slug), product.ts:42 (a seller with no slug goes to the Official Store), purchase.tsx:47 (no
check), plus 4 inline. Best: cards.tsx sellerHref and search.ts productHref.

**H11. `slugify` differs from the backend.** admin Categories.tsx:28 drops "&" for the new-category preview; the
backend (catalog/domain/rules.ts:10) turns it into "and". "Home & Garden" previews as `home-garden` but is saved as
`home-and-garden`. The two store copies (when.ts:57, account orders.ts:478) also differ from each other.

**H12. Export polling and downloads.** Seller `waitForExport` ×3 with swapped arguments and different failure
handling (catalog-parts.tsx:203: 60 s, throws; finance.ts:113: 5 min, throws; orders.ts:220: returns an unfinished job
silently); admin has two `useDatasetExport` with the same name (data/dataset-export.ts:15 sends empty filters,
data/report-export.ts:135 drops them). Download helpers ×5 (report-export.ts:11, seller finance.ts:126,
catalog-parts.tsx:191, orders.ts:207, store Confirmation.tsx:33 inline); account orders.ts:402 opens the same order
document with `location.assign`. `sleep` ×8. seller catalog-parts.tsx:180 `downloadCsv` has no callers.

**H13. System actor shown four ways in admin.** "System" (Content.tsx:130, data/order.ts:172), "Marketly"
(Notifications.tsx:73), "Marketly (system)" (data/audit.ts:67), "Trust and Risk enforcement" (Reviews.tsx:746);
data/news.tsx:66 and HelpContent.tsx:103 show nothing. Best: audit.ts `actorLabel`.

**H14. Masked email differs from the backend.** frontend auth/data/parts.tsx:24 "jo•••@example.com" vs backend
identity/domain/text.ts:4 "j••••••••@…" (sent as `emailMasked`).

## Medium

- **M1. admin `app/parts.tsx` and seller `data/home.tsx` are copies** (date set, dayKey, deadlineTone, deadlineLabel;
  lines 8-41 / 9-42). The natural seed for a web-shared `lib/dates.ts`.
- **M2. YYYY-MM-DD day keys in Pacific time: 11 copies** (parts.tsx:30, home.tsx:31, when.ts:8, seller orders.ts:43,
  marketing.ts:104, finance.ts:101 — uses the browser's zone, admin staff.ts:124, settings.ts:97, seller.ts:147,
  official.ts:33, Audit.tsx:45).
- **M3. Day arithmetic.** seller orders.ts:59 = period-dashboard.tsx:52 `addDays`; admin purchasing-deliveries.tsx:37
  uses local time; `daysAgo` means different things in admin orders.ts:130 and when.ts:11.
- **M4. Deadline colour and text.** Tone ×7 (seller returns.ts:80 `rowEdge` is case-sensitive while :75 isn't);
  edge class ×4, screen-reader prefix ×3; "Overdue 30 h" (parts/home) vs "Overdue 1 day 6 h" (seller returns.ts:65).
- **M5. US phone display ×6**; account Security.tsx:174 re-implements the backend's `maskPhone`.
- **M6. One-line address ×4 helpers + 6 inline templates.**
- **M7. `plural` ×14** in three forms, plus ~114 inline plurals.
- **M8. Compact money ("$36.7k") ×5** with different units, plus 4 inline.
- **M9. Time-zone option lists differ:** AdCampaign.tsx:61 and Content.tsx:54 (PT, ET) vs PromotionNew.tsx:44 (PT,
  MT, CT, ET).
- **M10. Summing money ×3** without the backend's currency check.

## Low

L1 `num` re-implemented (admin data/ads.ts:88, period-dashboard.tsx:118); L2 `fileSize` re-implemented (admin
SellerApplication.tsx:98 + 3 inline); L3 admin data/reports.ts:84 `localLink` = web-shared `sameOriginFile`; L4 "x
ago" ×2 (differ after 48 h); L5 `timePT` ×2; L6 12-hour clock ×3; L7 grams→pounds ×2; L8 card brand/expiry ×2 each;
L9 `orderWithin` ×2 (different inputs); L10 `attachmentName` ×2; L11 short ids inline ×3; L12 `lc` ×3.

Dropped after reading (different jobs): toInput, domain rowEdge copies, dayRange, statusLabel, reasonLabel, seller
productHref, parcel conditionLabel, device, isUuid.
