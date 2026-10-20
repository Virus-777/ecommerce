# 09 — Financial statistics and charts

Status: building (2026-10-21). Owner decisions are listed in §1. This document is the contract between the
backend and the web apps; the builders follow it, and a change to it is a change to both sides.

## 1. Decisions

| Question | Decision |
|---|---|
| Chart code | **Recharts 3.10.1** (exact version) in `web-shared`, styled with the Marketly chart tokens, light and dark. The hand-made SVG charts in `web-shared/src/ui/Charts.tsx` are replaced everywhere and the file is deleted, so there is one chart system. |
| Seller profit | Sellers enter a **unit cost per offer**, with history. Statistics show net earnings **and** profit and margin. A seller's costs are private: no admin report, dataset or screen shows them. |
| Admin statistics | Platform income statement (fee income same day, not only after the nightly pull), seller money trends, Official Store profit and loss trend. Not now: tax collected, store-credit liability. |
| Periods | One period control on every statistics page: presets, a custom range, a day/week/month grain, and a comparison (previous period or the same period last year) drawn on the charts. |

## 2. What exists and what is missing (survey 2026-10-21)

- Reports module (`backend/src/modules/reports`) answers `POST …/reports/reports/{key}/query` for a catalogue of
  report keys (`domain/catalogue.ts`), from read models it keeps up to date from events and a nightly pull
  (`service/readmodels.ts`). Result shape: `kpis`, `series`, `split`, `table`, `breakdowns`, `callouts`.
- Seller reports cover sales, orders, returns and service only. Nothing about fees, refunds, ads, service fees,
  net earnings or profit, although `finance.ledger_entries` holds every amount.
- Admin finance endpoints return totals without series. `platform_costs` is recorded and never reported. Fee
  income reaches reports only through the nightly pull (last 3 days), so "today" shows 0.
- `fact_order_items` has `buying_cost_minor` for the Official Store only and no fee column.
- Web charts: two hand-made SVG components (line, bar), two colours, hover-only tooltips, no comparison overlay.
  Seller Finance and Statement pages have no chart and no period control.

## 3. Backend

All money stays in integer minor units, one currency (USD at launch), days in the market time zone. Every new
endpoint is in the spec first (`docs/api/spec/modules/<module>.json`), then regenerated (MAINTAINING.md §3).

### 3.1 Offers: unit cost per offer (module `offers`)

New collection `offers.offer_costs` — one row per cost the seller sets, never edited:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `offer_id`, `seller_id`, `product_id` | uuid | |
| `unit_cost_minor` | bigint | ≥ 0 |
| `currency` | text | the offer's currency |
| `effective_from` | date | market day the cost starts; may be in the past (at most 400 days) so old sales get a cost |
| `note` | text? | e.g. "new supplier" |
| `set_by_id` | uuid | seller member |
| `created_at` | datetime | |

Indexes: `(offer_id, effective_from desc, created_at desc)`, `(seller_id, created_at desc)`.
The cost for a day is the row with the latest `effective_from` ≤ that day (ties: latest `created_at`).

`Offer` gets `unitCost: Money?` and `unitCostFrom: date?` (the cost in effect today), on the seller's views only.

Endpoints (area seller, new permission `offers.costs.manage`, given to the seller roles that already hold
`offers.prices.manage`; reading uses the offer read permission):

| Method and path | Body / query | Response |
|---|---|---|
| `GET /api/seller/offers/offers/{id}/costs` | paging | `OfferCost[]` (history, newest first) |
| `PUT /api/seller/offers/offers/{id}/cost` | `{ unitCost: Money, effectiveFrom?: date (default today), note?: string }` | `OfferCost`; audited |
| `POST /api/seller/offers/costs` | `{ items: { offerId, unitCost, effectiveFrom?, note? }[] }` (1–500) | `{ saved: int, errors: { offerId, code }[] }`; audited |

`OfferCost = { id, offerId, productId, unitCost: Money, effectiveFrom: date, note?, setBy: { id, name }, createdAt }`.
Errors: `NOT_FOUND`, `VALIDATION_FAILED` (negative, wrong currency, more than 400 days back, more than 1 day ahead).

The bulk update template (`/bulk-updates/template`) gets an optional `unit_cost` column (decimal, offer
currency) that saves a cost effective today.

Event `offers.offer.cost_changed { offerId, sellerId, productId, unitCost: Money, effectiveFrom: date }`,
published after commit, once per saved row.

Public API (contract.ts): `unitCostsAt(items: { offerId, at: datetime }[]) => (Money | null)[]` (same order;
batched, one query per call).

### 3.2 Finance: daily totals for reports (module `finance`)

Public API additions (no new endpoints). Days are market days; amounts signed like the ledger.

- `ledgerDailyTotals({ from: date, to: date, sellerId?: uuid }) => { sellerId, day, type, amount: Money, count }[]`
  — `ledger_entries` grouped by seller, day of `at`, `type`. Uses the `(type, at)` / `(seller_id, at)` indexes.
- `companyDailyTotals({ from: date, to: date }) => { day, source: 'trading' | 'platform_cost' | 'discount_funding', kind, amount: Money }[]`
  — `trading_entries` by kind, `platform_costs` by kind, `discount_funding` by funder.
- `itemFeesChangedSince({ since: datetime, after?: string, limit: int }) => { orderItemId, sellerId, fee: Money, refundedFee: Money, changedAt, cursor }[]`
  — from `fee_charges`, keyset-paged by change time.
- `sellerBalancesByDay({ from: date, to: date }) => { day, sellerId, pending: Money, available: Money, held: Money, owed: Money }[]`
  — end-of-day balances. Built from the ledger's running balances (`balance_after` per bucket) where the ledger
  allows it; if a bucket cannot be rebuilt from the ledger, document the limit in the finance README and return
  the snapshots reports took (§3.3) instead.

### 3.3 Reports (module `reports`)

**Query options** (`ReportQuery`):
- `preset` adds `quarter_to_date`, `year_to_date`, `last_12_months` (the 400-day cap stays).
- `compare` adds `same_period_last_year` (same calendar dates one year earlier; 29 Feb → 28 Feb).
- Every new report honours `granularity` (`day|week|month`, auto as today), `compare`, `range`.
- When `compare` is set, every series in the result also has a twin with key `<key>:compare` whose points use
  the **current** period's x values (so the web draws it on the same axis), and `meta.compareRange` says which
  dates it holds. Existing reports get the same twins.

**Read model changes:**
- `fact_order_items` + `fee_minor` (bigint?, net of fee refunds, null until finance has booked the fee).
  Seller rows also get `buying_cost_minor` = unit cost × quantity from `offers.unitCostsAt` at `placed_at`
  (null when the seller has no cost). Consumer of `offers.offer.cost_changed`: re-cost the offer's rows with
  `placed_at` from `effectiveFrom` up to the next later cost of that offer.
- `fact_marketplace_finance_daily` + columns `fee_gross_minor`, `fee_refunds_minor`, `refunds_minor`,
  `shipping_charged_minor`, `label_charges_minor`, `adjustments_minor`, `chargebacks_minor`, all filled from
  `finance.ledgerDailyTotals` (map ledger types to columns in one table in code, commented).
- New `fact_company_daily { day, source, kind, amount_minor }` unique `(day, source, kind)`, from
  `finance.companyDailyTotals`.
- New `fact_seller_balances_daily { seller_id, day, pending_minor, available_minor, held_minor, owed_minor }`
  unique `(seller_id, day)`, from `finance.sellerBalancesByDay`.
- New job `reports.pull-finance-recent`, every 15 min: pulls today and yesterday into the three finance facts
  and the item fees changed since the last run (cursor kept in the module's job state). The nightly
  `pull-daily` keeps its 3-day window. All pulls upsert with `$set` (safe to run twice). Rebuild covers all of
  them (400 days).

**New report keys** (`domain/catalogue.ts` + metric definitions in `service/definitions.ts`). Breakdown rows use
the existing shape `{ key, label, amount?: Money, sharePct?, ... }`. A waterfall breakdown has key
`waterfall` and rows `{ key, label, amount: Money, step: 'start' | 'minus' | 'plus' | 'total' }`.

1. `seller.earnings` — "Earnings and profit", audience seller, permission `finance.balances.view`.
   KPIs and series (keys): `seller.item_sales`, `seller.shipping_charged`, `seller.refunds`, `seller.fees`,
   `seller.ad_spend`, `seller.service_fees`, `seller.label_charges`, `seller.adjustments`, `seller.net_earnings`,
   `seller.product_cost`, `seller.profit`, `seller.margin_pct`, `seller.paid_out`; KPI only:
   `seller.cost_coverage_pct` (share of item sales that has a cost).
   Bases: item sales, shipping charged, refunds, fees and product cost **by order date** (fact_order_items: the
   orders of the period, refunds on them so far); ad spend, service fees, labels, adjustments and paid out **by
   charge date** (fact_marketplace_finance_daily). A callout says so. Net earnings = item sales + shipping
   charged − refunds − fees − ad spend − service fees − labels ± adjustments. Profit = net earnings − product
   cost of the sales that have a cost; margin = profit ÷ item sales of costed sales.
   Test: for a closed period where every order is delivered, net earnings equal the seller's ledger entries for
   those orders and charges (payouts excluded).
   Breakdowns: `waterfall` (item sales → … → net earnings → product cost → profit), `fees_by_type`.
   Table: one row per period with every series column plus totals.
2. `seller.profit_by_product` — "Profit by product", seller, `finance.balances.view`, filters range, product,
   category. Table per product: product, offerId, units, item sales, refunds, fees, product cost, profit,
   margin %, `costSet` (bool), current unit cost. Breakdowns: `top_profit` (10), `lowest_profit` (10).
   KPIs: profit, margin %, products without a cost (count), item sales without a cost.
3. `finance.platform_income` — "Platform income", staff, `reports.marketplace-finance.view`. Booking date.
   Series/KPIs: `platform.fee_income_gross`, `platform.fee_refunds`, `platform.fee_income_net`,
   `platform.ad_income`, `platform.service_fees`, `platform.label_income`, `platform.discount_funding`
   (platform-funded discounts, negative), `platform.costs` (sum of platform_costs), `platform.net_income`,
   `platform.official_net_margin` (from trading facts), `platform.company_result` (net income + Official Store
   net margin). Breakdowns: `waterfall`, `costs_by_kind`, `fee_income_by_category` (order date, from
   fact_order_items.fee_minor; callout explains the date basis), `fee_income_by_seller` (top 10).
   Table per period. Freshness: `meta.freshAsOf` = last `pull-finance-recent` run.
4. `finance.seller_money` — "Seller balances and payouts", staff, `reports.marketplace-finance.view`.
   Series: `sellers.owed` (pending + available, end of day), `sellers.held`, `sellers.negative` (sum owed by
   sellers), `sellers.negative_count`, `sellers.payouts_paid`, `sellers.payouts_failed`. KPIs: the values on the
   last day of the range plus period totals for payouts. Table: top 20 sellers by fee income in the range with
   item sales, fee income, payouts paid, balance today, held today. Filter: seller.
5. `trading.pnl` — "Official Store profit and loss", staff, `reports.trading.view`. Series/KPIs:
   `trading.official_sales`, `trading.buying_cost`, `trading.gross_margin`, `trading.discounts`,
   `trading.shipping_expense`, `trading.returns_cost`, `trading.write_offs`, `trading.chargeback_losses`,
   `trading.net_margin`, `trading.net_margin_pct`, `trading.stock_bought`. Breakdown `waterfall`. Table per period.
   Changed 2026-10-21: sales, `trading.buying_cost` (now labelled "Cost of goods sold") and gross margin come from
   the order facts exactly as `trading.margin` (test); finance's trading `buying_cost` entries are booked when stock
   is received from a supplier, so they show as `trading.stock_bought` and are not taken off the margin. The other
   lines are finance's trading lines by booking day, the same as `GET /api/admin/finance/trading` (test); discounts
   are shown but not taken off again (sales are after discounts). `platform.official_net_margin` is this net margin.

`seller.order_trend` and `seller.product_sales` are unchanged apart from the comparison twins.

## 4. Web

### 4.1 Shared (`web-shared`)

- `recharts@3.10.1` (exact) in `web-shared/package.json`.
- Chart tokens in `marketly.css` and `design/tokens.json`: `--chart-1` … `--chart-6` (keep 1–2 as today),
  `--chart-compare` (muted, used dashed), `--chart-positive`, `--chart-negative`, light and dark, checked for
  contrast and colour-blind safety. One `chartColor(i)` helper reads them.
- `web-shared/src/ui/charts/` (one component per file, exported from `ui/index.ts`):
  - `TrendChart` — lines or areas, many series, optional comparison twins (dashed, `--chart-compare`), y axis
    formatted with `fmt`, optional second y axis for a percentage series.
  - `BarsChart` — grouped or stacked bars, vertical or horizontal (for rankings), negative values.
  - `ComboChart` — bars plus a line on a second axis (e.g. profit bars + margin % line).
  - `WaterfallChart` — from a `waterfall` breakdown.
  - `DonutChart` — shares with a centre total, at most 6 slices plus "Other".
  - Every chart: one shared tooltip (all series of the point, money formatted, compare value and change),
    touch and keyboard friendly, clickable legend that hides a series, `ChartFrame` with title, "Show as table"
    toggle (an accessible table of the same data) and an empty state. Works at phone width (360 px).
  - `seriesFromReport(result, keys)` turns `ReportResult.series` (+ `:compare` twins) into Recharts rows.
- `PeriodControl` + `usePeriod()` (`web-shared/src/ui/PeriodControl.tsx`, state in the URL: `?preset=&from=&to=&grain=&compare=`):
  presets Today, 7 days, 30 days, 90 days, Month to date, Quarter to date, Year to date, 12 months, Custom
  (date range with react-day-picker); grain Day/Week/Month (disabled when too many points: >92 days → no day);
  compare None / Previous period / Same period last year. Returns the `ReportQuery` fields.
- Every existing use of `LineChart`, `BarChart`, `Legend`, `SplitBar` moves to the new charts (seller
  Dashboard, period-dashboard, Reports; admin Dashboard, Reports, Report, Official, Promotions, Ads) and
  `Charts.tsx` is deleted.

### 4.2 Seller Center

- Sidebar: "Reports" becomes **"Statistics"** (same route `/reports`), with tabs:
  **Sales** (today's Reports content, on PeriodControl), **Earnings and profit** (`seller.earnings`: KPI row with
  deltas, net earnings vs profit TrendChart with comparison, WaterfallChart, fees DonutChart, costs-vs-sales
  ComboChart, period table, CSV export), **Products** (`seller.profit_by_product`: ranking bars, table with
  inline unit-cost editing, a "Products without a cost" callout linking to bulk cost entry), **Service**
  (today's meters + on-time dispatch trend).
- Offer page: "Unit cost" field next to price, with "From" date and history list (`/costs`).
- Products list: "Unit cost" column; Bulk update: `unit_cost` column documented on the page.
- Finance page: PeriodControl and a "Money in and out" chart (net earnings and paid out by period), linking to
  Statistics → Earnings. Dashboard: net earnings and profit tiles for the selected period.
- Performance page: chart the 12-month history the API already returns.

### 4.3 Admin Center

- Sidebar Finance group gets **"Financial statistics"** (`/finance/statistics`), permission-gated per tab:
  **Platform income** (`finance.platform_income`), **Seller money** (`finance.seller_money`),
  **Official Store P&L** (`trading.pnl`). Each: PeriodControl, KPI row with deltas, main TrendChart with
  comparison, WaterfallChart, breakdown charts (costs by kind donut, fee income by category bars, top sellers
  bars), period table, export through the existing report export.
- Admin Finance overview gets PeriodControl (more than Today/7 days/MTD) and links to Financial statistics.
- Admin Dashboard: fee income shows the same-day figure.

## 5. Build plan

Branches from main 52cae0ce, one git worktree per builder, merged by the coordinator, then regenerate and
`npm run check`, web typecheck/build/tests, simulator, real-browser check of both apps.

1. **be-offers** — §3.1 (offers spec + code + tests). **be-finance-reports** — §3.2 + §3.3 (finance contract +
   reports), merges be-offers when it lands to wire product cost. **web-charts** — §4.1. In parallel.
2. **web-seller** — §4.2 and **web-admin** — §4.3, after web-charts, against this contract; verified after the
   backend merge.
