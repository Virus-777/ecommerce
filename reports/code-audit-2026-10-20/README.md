# Code audit: unused code and duplicates (2026-10-20)

Scope: the backend (`E:/Work/Ecommerce/backend`, branch
`fix/critical-c1-c2` with its uncommitted work) and the three web apps plus their shared library
(`E:/Work/Ecommerce-frontend`: store `frontend/`, `admin-center/`, `seller-center/`, `web-shared/`, branch
`build/frontend`). Read-only: nothing in the code was changed.

The question was: what is unused, and what is written more than once in different ways for the same job?

## At a glance

| | Backend | Web apps |
|---|---|---|
| Settings that do nothing (editable, never read) | 10 | – |
| Unused imports / variables / parameters | 28 / 4 / 21 | 0 (already enforced) |
| Exports nothing uses | 65 + 3 unused state machines | 64 (incl. ~600 lines of old sample data) |
| Unused files | 33 `permissions.ts` (+30 empty `contract.ts`) | 0 |
| Unused CSS classes | – | 27 |
| Duplicate groups (same job, several implementations)¹ | about 76 | about 72 |
| … of which the copies already behave differently | about 40 | about 31 |

¹ Totals of the review pages; a few groups appear on two pages (they cross-reference each other).

Details: **[unused code](unused.md)** · duplicates: **[backend helpers](duplicates-backend-helpers.md)** ·
**[backend structures](duplicates-backend-structures.md)** · **[web formatting](duplicates-web-formatting.md)** ·
**[web components and hooks](duplicates-web-ui.md)** · smaller lists: [exports used only in their own
file](exports-own-file-only.md), [backend exports used only by tests](exports-test-only.md).

## Fix first

These are the findings with a real effect on users, money or security. ✔ = I re-checked it in the code myself; the
rest come from the reviewers, who read every location.

1. ✔ **10 settings do nothing.** They are editable in Admin Center → Settings, but no code reads them (e.g.
   `sellers.infoRequestDefaultDays`, `returns.maxMediaMb`, `support.lateItemRefundAfterDays`). → [unused §1](unused.md)
2. ✔ **Seller Finance shows the wrong day.** "In review since" for a payout-account change cuts the timestamp to its
   UTC date, so a change requested after about 5 PM Pacific shows the next day
   (`seller-center/src/pages/Finance.tsx:571` → `data/finance.ts:71`). → [web formatting H2](duplicates-web-formatting.md)
3. ✔ **CSV formula injection.** Only the reports module guards cells starting with `=`, `+`, `@` or `-`. The offers
   bulk-update correction report writes seller-supplied SKUs unguarded (`offers/domain/rules.ts:376`); finance
   statements and gift-card exports likewise (gift cards don't even quote). A seller could plant a formula that runs
   when staff open the file in Excel. → [structures C2](duplicates-backend-structures.md)
4. ✔ **Two sources for the market time zone and currency.** Staff can change both in Admin Center → Settings, but 37
   backend files read the time zone (and 26 the currency) from the server's environment instead. Changing it in the
   Admin Center moves the business calendar but not order, finance or shipping dates. → [structures B2](duplicates-backend-structures.md)
5. **Audit-log failures break requests after the change is saved** in 18 modules, while 9 others swallow the error
   (access's comment says that is the rule). The user sees an error for something that actually happened.
   → [structures A1](duplicates-backend-structures.md)
6. **Return and seller deadlines ignore market closures**, and the seller ones count days in UTC; the real business
   calendar exists in settings and says it is meant for them. Several seller/trust dates also use the UTC day instead
   of the market day. → [structures B1](duplicates-backend-structures.md), [helpers C2/C4](duplicates-backend-helpers.md)
7. **Money shown five ways**, including a hard-coded "$" whatever the currency and "184.00 USD" in customer-facing
   text; two `sumMoney` copies add different currencies together. → [helpers D1/D3](duplicates-backend-helpers.md)
8. **Broken media links:** sellers and support build fallback image URLs that no route serves.
   → [structures A4](duplicates-backend-structures.md)
9. **Three PDF writers draw past the bottom of the page** on long documents (fulfillment-service, warehouse,
   shipping), and the shipping label drops "×". → [structures C1](duplicates-backend-structures.md)
10. **Admin category cache holds two shapes:** the new-promotion screen stores a flattened list under the same key
    eight other screens read as a tree. → [web UI 1](duplicates-web-ui.md)
11. ✔ **A job schedule option that does nothing:** `window: 'business-hours'` is parsed but never applied, so
    warehouse auto-waves run all day. → [unused §6](unused.md)
12. ✔ **Wasted database reads:** the seller account view and seller setup steps load the application and never use
    it (`sellers/service/accounts.ts:141, 176`). → [unused §2](unused.md)

Also worth knowing: date checks accept 2026-02-30 in every module; `addMonths` turns Jan 31 + 1 into Mar 3 in
notifications; 8 GraphQL enum mappers can produce invalid enums from hyphenated values; three different PO-box rules
accept or reject the same address depending on the module; the same seller gets different colours and initials across
screens; the same status reads "Partly delivered", "PARTLY DELIVERED" or "partly delivered".

## The pattern behind most duplicates

- **Backend:** 28 per-module "core" classes each re-implement the same plumbing (validation errors, not-found, audit,
  events, optional calls, actor encoding, dates, money). The kernel has no shared home for most of it, and where it
  does (money formatting, masking, paging, rate limiting, `actorOf`, `dateInZone`) modules often don't use it.
- **Web:** `web-shared` has no date/time, plural, label, phone, address, export/download, debounce, in-view,
  load-error or skeleton helpers, so each app (and often each screen) wrote its own. The admin `app/parts.tsx` and
  seller `data/home.tsx` are already identical copies and would make a good shared `lib/dates.ts`. In 13 groups the
  shared piece exists and apps bypass it, sometimes because comments wrongly say it lacks a feature.

A sensible order, if you want to act on this: the "fix first" list; then one shared home per family (backend kernel
helpers for errors, actors, dates, money, paging; web-shared dates, money parsing, LoadError/skeleton, useDebounced/
useInView, export/download); then sweep the copies family by family, running the tests after each.

## How this was checked

- **Unused locals (backend):** `tsc --noUnusedLocals --noUnusedParameters` (the web apps already enforce these).
- **Unused exports and files:** TypeScript 7 has no compiler API, so a small graph checker built on the oxc parser and
  resolver that ship with Vite 8 (rolldown) followed every import, re-export, `export *` barrel, namespace import and
  lazy page import across all five packages. A plain-text search on samples found no false positives.
- **Duplicates:** a structural fingerprint of every top-level function (identifiers, literals and whitespace ignored)
  and a same-name scan produced the candidates (99 clone groups, 455 same-name groups). Four reviewers then read the
  code by area — web formatting, web components/hooks, backend helpers, backend structures — kept only real overlaps,
  noted how the copies differ, and dropped false candidates.
- **Settings, CSS, npm packages:** scripts compared spec settings with code that reads them, stylesheet classes with
  component code, and package.json dependencies with imports (no unused packages).

Not covered: tests (excluded from the duplicate scan), generated code (`backend/src/spec`, OpenAPI types), the
`android-customer-app` kit, the stale `backend/` copy inside the frontend worktree, and duplicate CSS rules. The
checker scripts are in the session scratchpad, not in the repository.
