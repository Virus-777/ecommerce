# Backend: larger structures doing the same job in different ways

Part of the [code audit of 2026-10-20](README.md). Paths are relative to `backend/`; every location was read by the
reviewer. Severity: **high** = the variants behave differently, or dead code that misleads; **medium** = 3 or more
parallel copies that behave the same; **low** = the rest.

Left out as intentional: per-module route registration and `module.ts`, per-module `exportRows` and settings-section
contributors (the spec asks for them), and one-line helpers ([backend helpers](duplicates-backend-helpers.md)).

**Summary.** 26 groups: 14 high, 8 medium, 4 low. Highest risk: audit writes with six different failure behaviours
(A1), returns and seller deadlines that ignore market closures (B1), two sources for the market time zone and currency
(B2), CSV formula injection outside reports (C2), and a job schedule option that does nothing (E3).

## A. Plumbing copied into every module's "core" class

There are 28 such classes under three file names: `service/core.ts` (23 modules), `service/base.ts` (catalog,
content, search) and `app/core.ts` (notifications, workqueues). docs/MAINTAINING.md §4 names only `service/core.ts`,
and the kernel has no base class. `principalOf` alone is copied into 6 of them.

**A1. Writing audit entries: 30 wrappers, six failure behaviours — high.**
Wrappers: the `audit()` method in the core class of access, advertising, customers, finance, fulfillment-service,
identity, inventory, messaging, offers, orders, payments, promotions, purchasing, reports, returns, reviews, sellers,
shipping, support, trust, wallet, warehouse, catalog, content, search, notifications, workqueues; plus
media/service.ts:1589, settings/service.ts:1474 and audit/service.ts:804.
When the audit write fails:
- **the request fails after its change has already been saved** (18 modules: customers, identity, inventory,
  messaging, orders, purchasing, returns, reviews, sellers, shipping, trust, warehouse, catalog, search, notifications,
  workqueues, media, settings);
- swallowed and logged as an error: access, whose comment states the intended rule ("never turned into a failed
  request");
- swallowed, warning unless NOT_IMPLEMENTED: advertising, finance, offers, promotions;
- swallowed, always a warning: payments, wallet, content;
- through the module's own `soft()`: fulfillment-service, support;
- re-thrown unless NOT_IMPLEMENTED: reports.
Also: the default category differs (some set one, others make callers pass it), `requestId` is `null`, `undefined` or
left out, and only identity records the IP address.

**A2. Optional calls to other modules: 25 helpers, different logging — high.**
`optional` in advertising, checkout, finance, offers, promotions, reviews, sellers, search; `soft` in customers,
fulfillment-service, messaging, offers, orders, payments, reports, returns, reviews, shipping, support, trust, wallet,
warehouse, content. The same failure from the same module is a warning in one caller and silent in another
(warning unless NOT_IMPLEMENTED in 10; silent for every AppError in orders, payments, returns, shipping, support,
trust; info in fulfillment-service and warehouse; three levels in checkout; silent for 4xx in offers.soft and wallet;
debug for everything in content).

**A3. Publishing events after commit: 17 publish wrappers, 11 batch classes — medium.**
`Outbox` (finance, wallet), `Batch` (fulfillment-service, orders, payments, returns, shipping, support, trust,
warehouse), `Effects` (reviews), each with its own flush. Most publish with the SYSTEM actor; identity, and wallet
without `by`, publish with none. finance and wallet empty the batch on flush; payments and fulfillment-service don't,
so flushing the same batch twice would publish its events twice (a risk, not an observed bug). shipping and reviews
add data during the flush. The kernel event bus has no outbox.

**A4. Names and links from other modules: 18 lookups, different fallbacks — high.**
Seller names (advertising, finance, fulfillment-service, offers, promotions, reviews, shipping), staff names
(advertising, reports, support, trust, workqueues, access), media links (messaging, reviews, sellers, support, trust).
- Unknown seller: finance invents `{name: 'Seller', code: 'SL-<id prefix>'}`, the others leave it out; only reviews
  maps the Official Store id.
- Unknown staff: "Staff member" in reports, trust, access; left out in support, advertising.
- Unknown media: sellers builds `<store>/media/unavailable/<id>` (sellers/service/core.ts:133) and support builds
  `<store>/media/<id>` (support/service/core.ts:476). **No route serves either URL**; media itself serves a
  placeholder (media/service.ts:202).

## B. One rule, different results

**B1. Business days: one real calendar and seven weekday-only copies — high.**
The real calendar (business hours, closures, time zone) is `settings/domain/calendar.ts:44`, exposed as
`settings/service.ts:332 businessCalendar()`; its header says it is used for support, workqueues, returns and seller
deadlines. But:
- returns/domain/rules.ts:121 — weekdays in market time, **no closures**; used for response, inspection and refund
  deadlines (returns/service/requests.ts:418, returns/service/views.ts:159, 168, 318);
- sellers/domain/rules.ts:197 — weekdays in **UTC**, no closures (sellers/service/applications.ts:506, 728;
  sellers/service/enforcement.ts:545);
- catalog/domain/rules.ts:216 (fallback), offers/domain/rules.ts:266, search/service/queries.ts:70 and 81 — weekdays
  in UTC; shipping/domain/calendar.ts:47 `addWorkDays`.
When the real calendar fails, callers fall back four ways: weekdays (catalog), wall-clock minutes then re-throw
(workqueues), every day open (notifications), null (support).

**B2. Market time zone and currency come from two places — high.**
Staff can edit `market.timeZone` and `market.currency` in Admin Center → Settings (time zone needs Business Owner
approval and 30 days' notice), and the business calendar uses them. But 37 module files read the time zone from the
server environment (`ctx.config.market.timeZone`, env `MARKET_TIME_ZONE`) and 26 read the currency from it — e.g.
orders/service/core.ts:117, finance, shipping, returns. reports has a third, its own `reportingTimeZone` setting.
Changing the time zone in the Admin Center moves the business calendar but not order, finance or shipping dates.

**B3. Rate limiting: three mechanisms, coupons limited three times — high.**
Kernel `ctx.rateLimit` (MongoDB, shared): cart, messaging, wallet gift cards. An in-memory Map in one process:
promotions/service/storefront.ts:373 (resets on restart, cleared after 10k keys). Counting rows: checkout, customers
guest orders, customers data requests. Coupon codes are limited by cart (30/hour/owner), checkout (20/hour/session) and
promotions (10/minute/session), each with its own setting.

**B4. Masking emails and phones — high.** Kernel `src/kernel/auth/masking.ts:7`, driven by the spec ("handlers never
decide"); orders re-implements it and decides in the handler; identity gives `j••••••••@…`; notifications gives
`jo***@…`. The same email change is masked one way in the security event (identity/service/registration.ts:168) and
another in the notification (notifications/domain/routing.ts:266).

**B5. PO box detection: three patterns — high.** customers/domain/address.ts:19 (p o box, post office box, POB N,
trailing "box N"), shipping/domain/geo.ts:57 (adds PMB), sellers/domain/rules.ts:165 (only p.o. box and post office
box). "PMB 12" and "POB 12" are accepted or rejected depending on the module.

**B6. Actors stored as text: three formats — high.** See [backend helpers B1/B2](duplicates-backend-helpers.md).

**B7. Reference numbers — medium.** The kernel's `src/kernel/lib/refs.ts:20` has 32 callers; payments keeps its own
`payments.ref_sequences` (MAINTAINING.md §6 records the same thing was removed from orders); finance statements count
then probe for a free number.

## C. Parallel generators and writers

**C1. PDF writers: five copies — high.** finance/domain/pdf.ts:22, orders/domain/pdf.ts:23,
fulfillment-service/domain/pdf.ts:19, warehouse/domain/pdf.ts:20, shipping/domain/pdf.ts:10. finance and orders start
a new page for long documents; **fulfillment-service, warehouse and shipping draw past the bottom of the page**.
Special characters are cleaned differently (see helpers I1). Two ZPL label writers: warehouse/domain/pdf.ts:55 and an
inline string in shipping/providers/carriers.ts:78.

**C2. CSV writers: only one of four guards against formula injection — high.** reports/domain/files.ts:58 prefixes
cells starting with `= + @ -` and writes a BOM. Not guarded: offers/domain/rules.ts:376 (writes seller-supplied SKUs and
error text into the bulk-update correction report — offers/service/bulk.ts:50, 336), finance/service/statements.ts:303,
and wallet/service/gift-cards.ts:200 (no quoting at all). A cell like `=HYPERLINK(...)` from a seller's upload would run
as a formula when staff open the file in Excel.

**C3. ZIP writers — low.** customers/domain/zip.ts:20 and reports/domain/files.ts:100 (writes date 0, not a valid DOS
date).

**C4. Text search pieces — medium.** Three stemmers (search/text.ts:27 Porter, content/repository.ts:22,
search/service/admin.ts:229), two stop-word lists (33 vs ~120 words), seven word splitters, three similarity measures.
The always-on MongoDB engine imports from the optional OpenSearch folder (search/mongo-engine.ts:21, search/terms.ts:11).

**C5. Paging written again beside the kernel's — high.** Kernel `pagination.ts:36` and `mongo/table.ts:277, 315`.
Keyset copies in catalog, media, workqueues (the latter does what `pageAggregate` does); offset copies in reviews,
support, trust, search. A bad cursor gets VALIDATION_FAILED from search, silently restarts at 0 in trust, reviews and
support, and returns an empty page from the kernel.

**C6. GraphQL batch loaders — medium.** 12 byte-identical `load` functions plus 3 variants; no kernel loader.

## D. State machines

**D1. Moving a record between states — medium.** Kernel `createStateMachine` gives `{machine, from, event, allowed}`;
three identical `step()` wrappers (finance, promotions, sellers); ten `illegal()` helpers with different details
(fulfillment-service's is exported and never called); 151 hand-written ILLEGAL_TRANSITION sites in 69 files; reviews
has its own state path search. Clients get at least four shapes of error details.

**D2. Generated state machines nothing uses — high (misleading).** identity's `sessionMachine` and
`verificationChallengeMachine`, notifications' `actionNoticeMachine`: zero references; those statuses are written
directly (identity/repository.ts:206, notifications/service.ts:825-833).

## E. Registration, settings, scheduling

**E1. Registering export datasets — medium.** 14 modules register at boot (inventory, offers and catalog catch errors;
for the rest an error stops boot); audit and sellers register only on first export, so until then their datasets show
the key as the title and no columns.

**E2. Settings readers repeat spec defaults — medium.** `cfg()` in messaging, orders, payments, reports, shipping,
fulfillment-service contain fallbacks like `?? 24`; `ctx.settings.get` already returns the spec default, so `??`
fallbacks are dead, and reports' `||` fallbacks override a staff-set 0. advertising reads `apps.serveWebsite` straight
from the settings module's API.

**E3. Job "business hours" window does nothing — high (misleading).** src/kernel/jobs/index.ts:21, 34 parses it; no
scheduler reads it (only a test). warehouse's auto-wave job, described as "during business hours", runs all day
(warehouse/service/summary.ts:216 has no hour check).

**E4. Scaffolded files left unused — low.** See [unused code §4](unused.md).

**E5. OpenSearch engine never switched on — medium.** See [unused code §6](unused.md).

## F. Layout and tools

**F1. Mapper/view layer under three file names — low.** `mappers.ts` (9 modules), `views.ts` (purchasing, wishlist),
`service/views.ts` (11); catalog and offers have two. MAINTAINING.md lists none.

**F2. API journeys written twice — low.** src/testing/flows.ts and tools/simulate (people.ts, http.ts) both implement
visitor sessions, re-auth, invitation accept, registration and sign-in. The other tools reuse services and kernel code.
