# Backend: small helpers copied across modules

Part of the [code audit of 2026-10-20](README.md). Paths are relative to `backend/`. Every location was re-read in the
source by the reviewer. Severity: **high** = the copies already behave differently; **medium** = 3 or more copies
of the same logic; **low** = 2 trivial copies.

Intentional and not listed: the per-module `adminRoutes`/`sellerRoutes`/`storeRoutes`/`publicRoutes`/`webhooksRoutes`/
`devRoutes` registrations and `module.ts` wiring.

**Summary.** 50 groups: 26 high, 21 medium, 3 low. In 9 groups modules bypass a kernel helper that already exists
(B3, C2, D1, D2, D3, D4, E2, F3, I4). In 2 groups the kernel code exists but isn't exported (A3, A4). The other 39 have
no kernel helper yet.

## A. Error constructors

**A1. `invalid` (VALIDATION_FAILED): 32 copies, two signatures, five default messages — high.**
- `(path, message)` form: audit/service.ts:74, cart/service.ts:76, catalog/service/base.ts:38, catalog/service.ts:20,
  content/service/base.ts:34, customers/service/core.ts:71, inventory/service/core.ts:70, media/service.ts:139,
  purchasing/domain/rules.ts:32, search/service/base.ts:27, wishlist/service.ts:42, workqueues/app/filters.ts:12,
  workqueues/app/items.ts:26; notifications/http/dev.ts:17 prefixes "Invalid query:".
- `(issues[], message = default)` form, default text varies:
  - "Some details need fixing": advertising, finance, messaging, offers, orders, payments, promotions, returns, sellers,
    shipping, trust (all `service/core.ts`).
  - first issue's message, else "Some details need fixing": fulfillment-service, reviews, warehouse.
  - "Check the highlighted fields": checkout, wallet; first issue, else that text: reports.
  - first issue, else "Check the details and try again": support.
- Wrappers: an identical `invalidField` in fulfillment-service, offers, returns, support, trust, warehouse cores; also
  access/service/core.ts:102 `validation`, purchasing/domain/rules.ts:33 `invalidMany`.

**A2. `notFound` (28 copies) and `unavailable` (3) — medium.** All `${what} not found`; only the default noun differs.
Fixed-text variants: media/service.ts:135, workqueues/app/items.ts:27, payments/http/admin.ts:6. `unavailable` (503):
orders, returns, warehouse cores.

**A3. `illegal` (ILLEGAL_TRANSITION): the error details differ — high.**
- `{machine, from, event}`: fulfillment-service/service/core.ts:69, trust/service/core.ts:60 (trust also builds the
  message); notifications/app/admin.ts:44 prefixes the message with the machine; purchasing/service/core.ts:66 sends
  `{from, event}`; payments, returns, support send free-form details (returns callers pass `{from}` without `event`,
  e.g. returns/service/handling.ts:71).
- Inline: content/service/help.ts:381, content/service/news.ts:474 (adds `allowed`), catalog/service/products.ts:354,
  and about 151 more `new AppError('ILLEGAL_TRANSITION')` sites.
- The spec (`spec/common.ts:249`) documents `details.from`/`details.event`; the canonical shape is in
  `src/kernel/lib/state-machine.ts:57` but isn't exported.

**A4. Step-up `refuse` (STEP_UP_REQUIRED, reauth/approval) — medium.** access/service/approvals.ts:654,
finance/service/core.ts:208, payments/service/core.ts:284, returns/service/refunds.ts:572. The kernel's
`src/kernel/auth/chain.ts:518 stepUpRequired` is private.

## B. Actors

**B1. Actor → stored text: five layouts — high.**
- JSON, id and name always: audit/service.ts:89, fulfillment-service/domain/rules.ts:239, inventory/mappers.ts:27,
  purchasing/domain/rules.ts:39, warehouse/domain/rules.ts:40.
- JSON, name only when set: offers/mappers.ts:52, returns/domain/rules.ts:510, search/service/admin.ts:22,
  sellers/mappers.ts:70, support/service/core.ts:85, trust/service/core.ts:71, wallet/domain/rules.ts:169,
  finance/domain/rules.ts:288, promotions/mappers.ts:32.
- JSON, id and name only when set: notifications/app/core.ts:44, workqueues/app/core.ts:55.
- raw `JSON.stringify`: support/repository.ts:18.
- `kind:id` text (loses the name): advertising/service/core.ts:80, access/service/core.ts:92.

**B2. Stored text → Actor: what a non-JSON value becomes — high.** `{staff, id}` in 8 modules (fulfillment-service,
trust, finance, promotions, audit, purchasing, warehouse, reports); `{staff, name}` in notifications; `{system, id}` in
search, sellers, wallet; `{system, name}` in inventory, returns, offers; `null` in support/repository; split on
`kind:id` in support core, access, advertising. Empty input gives `null` in 13 copies and `{kind:'system'}` in 5. Some
return the parsed object unchecked (notifications, reports, support/repository).

**B3. Principal → Actor differs from the kernel's `src/kernel/auth/index.ts:118 actorOf` — high.**
media/service.ts:1698 (visitor id is `guestSessionId ?? sessionId`, never a name), reports/service.ts:19 (no visitor
case), finance/graphql/resolvers.ts:53 `byOf` (a customer becomes kind `visitor`).

## C. Dates and time zones

**C1. `iso`: one name, two contracts — high.** 29 copies: 8 return `string` and throw on null (cart/checker.ts:88,
cart/service.ts:73, identity/mappers.ts:17, inventory/mappers.ts:52, access/service/core.ts:79, customers/mappers.ts:18,
promotions/mappers.ts:29, wishlist/views.ts:17); 21 return `string | null`. Plus 5 `isoOrNull` and 3 `isoReq`.

**C2. "Today" in the market — high.** Canonical: `src/kernel/lib/clock.ts:41 dateInZone`. Thin wrappers in finance,
reports, search and a `today` member in 11 cores; re-implemented in support/service/cases.ts:555. **Uses the UTC day
instead of the market day:** sellers/domain/rules.ts:193 and trust/domain/rules.ts:331 `isoDate`. Effects:
trust/domain/rules.ts:355 checks a review date against the UTC day (offers uses the market day,
offers/service/manage.ts:756); sellers/service/enforcement.ts:742 builds a range whose `from` is a UTC day and whose
`to` is a market day; sellers/service/applications.ts:1332 shows the UTC date; also reviews/service/feedback.ts:329,
checkout/service/placement.ts:550.

**C3. `addDays`: one name, two meanings — medium.** Calendar-string arithmetic in 12 modules; a Date plus n×24 h
(shifts an hour across daylight saving) in cart:302, returns:132, reviews:285, sellers:194, trust:332.

**C4. `addBusinessDays` — high.** catalog/domain/rules.ts:216 and sellers/domain/rules.ts:197 count weekdays by the
UTC day; returns/domain/rules.ts:121 by the market day. None skips closures; the closure-aware calendar in
settings/domain/calendar.ts is used only by catalog. (See also structures B1.)

**C5. `businessDaysBetween` / `daysBetween` — high.** offers/domain/rules.ts:266 is signed, search/service/queries.ts:81
returns 0 when b ≤ a; finance/domain/rules.ts:220 is exclusive, reports/domain/rules.ts:30 inclusive (+1).

**C6. `addMonths` — high.** notifications/domain/rules.ts:76 overflows (Jan 31 + 1 month = Mar 3);
wallet/domain/rules.ts:42 clamps to the month end.

**C7. Identical pairs — low.** `daysInMonth` (finance:224, fulfillment-service:231), `dayStart` (finance:219,
orders:403), `weekdayOf` (settings/domain/calendar:24, shipping/domain/calendar:15).

**C8. YYYY-MM-DD validation — high.** Regex + `Date.parse` in finance:222, reports:32, trust:328; regex only (month
13 passes) in shipping/domain/calendar:17 and inline in inventory, offers, messaging, reports, search, settings,
support. Both groups accept 2026-02-30 (checked on Node 26.7).

**C9. Time-zone validation — high.** reports/domain/rules.ts:34, advertising/service/campaigns.ts:45,
content/domain/rules.ts:190, inventory/service/locations.ts:32 accept anything `Intl` accepts;
settings/domain/values.ts:51 also requires `/` or `UTC`. "EST", "GMT" and "+05:00" pass the first four, fail settings.

**C10. Deadline state at exactly "now" — high.** Overdue (`left <= 0`) in messaging/domain/rules:113 and
workqueues/domain/rules:10; "due soon" (`left < 0`) in returns, sellers, support, trust, notifications, payments,
warehouse, catalog, shipping/calendar, orders.

**C11. Duration text — high.** 90 minutes reads "2 h" in orders/domain/rules.ts:311, "1 h 30 min" in
shipping/domain/calendar.ts:124, "90 min" in workqueues/domain/rules.ts:34; deadline labels likewise ("Overdue 2 h" vs
"Overdue by 1 h 30 min").

**C12. `shortDate` and friends — medium.** "Oct 8" in cart:184 and advertising:332 but "Fri, Oct 16" in orders:318
and returns:141; 10 more date-label helpers; none caches its formatter.

**C13. DAY/HOUR/MINUTE constants — medium.** Defined 33 times in 20 files.

## D. Money

**D1. Money display text: five styles for the same amount — high.** Canonical `src/kernel/lib/money.ts:62 format`
("$184.00").
- Own copy with the same output: access/domain/limits:120, advertising:334, fulfillment-service/service/fees:26,
  promotions:71, settings/domain/values:265, checkout/service/views:305, checkout/service:406, offers:82, payments:111,
  finance:22.
- "$50" (drops .00; non-USD shows "EUR 50"): search/domain/text:140, cart/checker:724, promotions:65,
  search/service/queries:470.
- "184.00 USD": fulfillment-service/service/differences:25 and inbound:27, returns/service/refunds:287/486/584/647,
  support/service/automation:158, support/service/decisions:403, workqueues/domain/intake:467.
- "$" hard-coded whatever the currency: support/service/views:295 and :395, warehouse/service/packing:381,
  support/service/decisions:149 and :315, workqueues/app/dayend:77.
- Bare "184.00" in user-facing text: offers/service/manage:119, offers/service/views:301, trust/domain/detection:227.

**D2. Money built without the kernel's integer check — high.** `m` in checkout, finance, promotions, wallet; `money`
in payments, search/service/queries, offers/mappers; `moneyOf` in access, returns. `usd` takes **dollars** in
access/domain/seed.ts:26 but **cents** in fulfillment-service:13 and tools/simulate.

**D3. Money sum ignores currency — high.** Kernel `sum` (money.ts:34) rejects mixed currencies;
cart/domain/rules.ts:304 and orders/domain/rules.ts:296 `sumMoney` add them anyway.

**D4. GraphQL `money` mapper — medium.** A `{...m, formatted}` mapper in 16 resolver files; redundant, because the
kernel's `wireResolvers` already resolves every `Money.formatted`.

**D5. Percent helpers — medium.** Part/whole percent with different precision and zero handling in advertising:670,
purchasing:229, reports:103, sellers:293, reviews:265; bps label twice (finance:32, promotions:74); `round2` twice.

## E. Ids

**E1. Deterministic UUID from a key: three layouts — medium.** sha256/v8 (shipping/domain/seed:8, finance:13,
wallet:163), sha256/v5 (payments/service/credit:39, promotions/service/checkout:31, checkout/service/placement:39),
sha1/v5 (trust:543, workqueues/app/core:50). The same key gives different ids in different modules.

**E2. `isUuid` looser than the kernel's — high.** notifications/domain/routing.ts:167 and search/domain/text.ts:128
accept any hex in UUID form; kernel `ids.ts:27` requires a version and the RFC variant.

## F. Paging, sorting, querying

**F1. `pageInput`/`pagingIn` — medium.** Identical in 14 GraphQL resolver files.
**F2. orderBy → Mongo sort — medium.** 15 copies (5 named `sortOf`, 10 inline).
**F3. `toPageRequest` — high.** orders/service/reads.ts:32 hard-codes 24/100 and accepts cursor and page together;
the kernel's (`pagination.ts:15`) rejects that.
**F4. Repository helpers — medium.** `oneOf` ($in) in 9 repositories (5 don't de-duplicate) though the kernel's
`whereFilter` already turns arrays into `$in`; `defined` ×5, `jsonColumns` ×3, `countIf` ×2.

## G. Collections and coercion

**G1. `groupBy` — medium.** 18 copies (two quadratic: media/service:1738, identity/repository:39; trust skips null
keys); `uniq` ×3.
**G2. `strings` (read a JSON string array) — high.** Keeps strings only in 6 copies; returns undefined for a
non-array in returns/domain/rules.ts:470; `String()`s every item in catalog/mappers.ts:32; sellers/mappers.ts:87 turns
null into "null".
**G3. `num`/`str`/`bool` — medium.** Same names, four contracts for `num` (null→null, null→0, with default, digits only).
**G4. `median` — medium.** support:191, trust/service/detection:19, workqueues:218; empty-list handling differs.
**G5. Text helpers — medium.** `plural` ×13 (three forms); snake_case→words ×7; `firstName` returns null in
messaging/wishlist but '' in notifications; `normalizeEmail` ×3 identical.

## H. GraphQL boilerplate

**H1. `load` batcher — medium.** Byte-identical in 12 resolver files (access, finance, messaging, offers, orders,
promotions, reviews, sellers, shipping, trust, warehouse, wishlist) plus 3 variants.
**H2. `upper` enum mapper — high.** Turns `-` into `_` in access, orders, returns, sellers (2), shipping, support,
trust; doesn't in cart, checkout, customers, messaging, payments, promotions, reviews, warehouse — a hyphenated value
there becomes an invalid GraphQL enum. `lower` ×6, `down` ×2.
**H3. GraphQL `deadline` mapper — medium.** Identical in 8 files; warehouse:10 isn't null-safe.
**H4. `nullOnNotFound` — high.** catalog:14 and content:18 return null only for NOT_FOUND; offers:75 and wishlist:75
also swallow any 404 and VALIDATION_FAILED.
**H5. Small identical helpers — medium.** `lazy` ×4, `pairs` ×5, coupon mapper ×2.

## I. Validation and rendering

**I1. PDF text escaping — high.** shipping/domain/pdf.ts:3 drops `×` and `·`; fulfillment-service and warehouse map
them to `x`/`-`; finance also maps `•`/`−`; orders also straightens quotes. "4 × 6" prints as "4  6" on a shipping
label and "4 x 6" elsewhere. (See structures C1 for the five PDF writers.)
**I2. `slugify` — high.** catalog (80 chars, trims, empty → `item`), content (80, trims, empty → ''), sellers (60,
doesn't trim after the cut so can end in `-`, empty → `store`).
**I3. `escapeHtml` — high, low impact.** content/domain/rules:16 doesn't escape `'`; notifications/domain/templates:25 does.
**I4. Masking — high.** Kernel `src/kernel/auth/masking.ts:7 maskValue`; orders re-implements it (same output);
notifications keeps two characters; identity uses bullets; audit/domain/redaction:16 has a different `maskValue` under
the same name.
**I5. GTIN check digit — low.** catalog/domain/rules:63 = search/domain/text:104.
**I6. Settings-section builders — medium.** `register*` wrappers ×6, `value()` builders ×4, `plural` ×5 in those files.

## J. Other

**J1. Event batch classes — medium.** `Batch` ×7 (two without `by`), `Outbox` ×2. (See structures A3.)
**J2. `by`/`byOf` caller adapters — medium.** 9 copies in http folders.
**J3. Identical pairs — low.** `shippingOf` (cart, checkout), `conditionGroup` (offers, search), `customerIdOf`
(orders, reviews), coupon `normalizeCode` (cart, promotions), `mb` (media ×2), `hostOf` (messaging ×2).

Dropped after reading (different jobs): `titleSimilarity` vs `similarity`, `allocate`, `amountOf`, `tokenHash`, `b64`,
`words`, `escapeRegExp`.
