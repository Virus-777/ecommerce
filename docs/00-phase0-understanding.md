# Phase 0 — Understanding the Plan

Source: `Ecommerce_Marketplace_Plan .docx` (21 chapters).
Purpose of this file: a working digest of the plan that Phase 1 (UX/UI) and Phase 2 (backend structure) are built against.

---

## 1. What the business is

A **hybrid marketplace**: one store where customers buy
- **our own products** (Official Store — we own price, stock, shipping, after-sales), and
- **products from approved outside sellers** (seller owns offer + stock, ships its own orders at launch).

Key concept — **Product vs Offer**
- *Product* = the shared catalog item (name, brand, specs, photos, variations).
- *Offer* = how one seller sells that product (price, condition, stock, dispatch time, return/warranty terms).
- Several sellers can offer the same product; customers compare offers on one product page. A "main offer" is chosen by a published rule (eligibility, availability, delivery, total price). The system never silently swaps sellers.

Fulfillment models: Official store (launch) · Seller shipping (launch) · Platform fulfillment for sellers (later).

Scope boundaries for launch: physical goods only, one service region, one currency. Not in scope: digital goods, subscriptions, auctions, cross-border, memberships.

Core promise: full payable total shown before ordering; every item has a named seller, delivery estimate and return policy; one checkout can become several packages, each manageable per item.

## 2. The four areas (apps)

| Area | Users | Notes |
|---|---|---|
| **Customer Store** | Customers, guests | Responsive; will become the Android app |
| **Seller Center** | Seller owner, seller staff | Official store uses equivalent areas + purchasing tools |
| **Admin Center** | Internal managers | Controls the marketplace |
| **Operations Center** | Internal managers & workers | Work queues (inventory, shipping, support, finance). Lives inside Admin Center at launch |

## 3. Roles

**Participants:** Customer · Seller owner · Seller staff (scoped duties).

**Internal management roles (17):**
- Trading & delivery: Official Store Manager, Purchasing, Inventory, Warehouse, Order, Shipping, Returns.
- Platform & commercial: Platform Administrator, Catalog, Seller Manager, Customer Support, Finance, Marketing, Advertising, Content, Trust & Risk, Reports Analyst.
- Plus: Business Owner (sets approval limits), and agents / warehouse workers / finance staff assigned tasks.

Rules that affect the system design:
- A role = a set of responsibilities and permitted actions, **not** a person. One person can hold many roles.
- Granting access ≠ financial authority (an admin can't release payouts just because they manage accounts).
- Approval limits per role; high-value adjustments may need a **second reviewer**.
- Every work queue: named lead, backup, escalation route.
- All material changes recorded (audit log with reason).

## 4. Status models the document defines

| Entity | States |
|---|---|
| Product review | Draft → Submitted → Changes Requested → Approved / Rejected |
| Product publication | Active · Hidden · Suspended |
| Seller account | Applied · Information Required · Under Review · Approved · Restricted · Suspended · Closed |
| Stock groups | Available · Reserved · Incoming · Damaged/Held · Returned |
| Payment (customer view) | Accepted · Pending · Failed · Refunded |
| Item preparation | Confirmed · Preparing · Delayed |
| Refund | Requested · Under Review · Approved · Processing · Sent · Failed |
| Payout | Pending · Processing · Paid · Failed |
| Seller balances | Sales proceeds · Pending · Available · Held · (Negative/owed) |
| Ad campaign | Draft → Submitted → Approved → Scheduled → Active ⇄ Paused → Finished → Archived |

Orders are **item-level**: an order can be partly delivered, partly cancelled, partly refunded. Order → Seller groups → Items → Shipments (packages). Payment, delivery and return progress are tracked separately.

## 5. Feature inventory by chapter (condensed)

| Ch | Topic | Must-haves for launch |
|---|---|---|
| 3–4 | Store structure, home, search | Home sections, category tree, search w/ suggestions & typo tolerance, universal + category filters, sort, empty/unavailable states, sponsored labels |
| 5 | Product page | Variations update photos/offers/price, purchase box (seller, condition, price, stock, shipping, delivery estimate, returns/warranty), other-offers comparison, reviews, Q&A, related |
| 6 | Cart & checkout | One cart grouped by seller/package; 6-step checkout (identify/guest → address → delivery per package → coupons → payment & review → place); change/failure handling; idempotent ordering; confirmation page |
| 7 | Account & tracking | Orders (search/filter), order detail by seller group, tracking, cancel eligible items, report problem, returns, refunds, messages, notifications, addresses, profile, security |
| 8 | Catalog | Category hierarchy, brands, attributes, variations, SKUs, catalog matching, product submission & review, shared-content change suggestions, duplicate merge, bulk price/stock updates, purchase snapshots |
| 9 | Official store & inventory | Company offers, suppliers, purchase records, receiving, stock groups, adjustments w/ reason, low-stock, picking/packing, return outcomes, margin tracking |
| 10 | Seller onboarding | "Sell with us" page, 6-step application, seller statuses, storefront, verification labels, performance summary, restrictions & appeals |
| 11 | Seller Center | 11 menus (Dashboard, Products & offers, Inventory, Orders, Shipping, Returns & cases, Finance, Marketing & ads, Customers, Store & settings, Reports); seller staff permissions |
| 12 | Orders & shipping | Fulfillment tasks per seller group with dispatch deadlines, shipment records, arrival estimates, partial shipments, exception handling (cannot fulfill, late, missing tracking, lost/damaged, failed delivery) |
| 13 | Returns & disputes | 5-step return journey, policy baseline + seller overrides, partial refunds, refund-without-return exception, dispute → decision → appeal |
| 14 | Payments & payouts | Payment retry/uncertain status, chargebacks queue, seller ledger (proceeds/pending/available/held), commission rules, statements, payout controls, post-payout refunds, negative balances |
| 15 | Marketing | Launch: markdowns, % / fixed coupons, min-spend, free shipping. Campaign setup (period, products, eligibility, caps, funding owner, stacking). Deals page, flash sales |
| 16 | Advertising | 8 ad types; launch = opening full-screen, banners, optional pop-ups. Campaign lifecycle, placements, creatives (desktop+mobile), audience & frequency rules, rotation/priority, reports |
| 17 | Trust & support | Product reviews vs seller feedback (separate), Verified Purchase, Q&A, private order messages, Help Center, support cases with SLA, trust/risk queue |
| 18 | Admin Center | 12 menus (Dashboard, Commerce, Catalog, Official store, Sellers, Inventory & warehouse, Shipping, Finance, Customers & service, Marketing & content, Advertisements, Reports & settings) |
| 19 | Content, notifications, reports | CMS with versions & scheduling; notification matrix (customer/seller/staff) in-app + email; reports with clear definitions |
| 20–21 | Launch & decisions | 4 launch phases, readiness checklist, 8 acceptance scenarios |

## 6. Launch phases (from the document)

1. **Controlled launch** — own products + selected sellers; shopping, stock, shipping, returns, support, seller finance & payouts; full-screen ads, banners, optional pop-ups.
2. **Seller expansion** — broader onboarding, bulk tools, seller reports, staff access, moderation.
3. **Customer growth** — wishlist, advanced campaigns, recommendations, paid seller ads, more ad formats, loyalty.
4. **Operational expansion** — multi-warehouse, seller fulfillment service, advanced returns.

Our MVP = document's Phase 1, with Phase 2–4 items designed as pluggable modules (off by default). *Since then:* the launch configuration runs phases 1–2 (`LAUNCH_PHASE=2`); the phase 3–4 modules (wallet, wishlist, fulfillment-service) are built and stay off until their phase.

## 7. Acceptance scenarios (use as MVP test cases)

1. Mixed purchase: company + two sellers in one checkout; order shows each seller group, package and amount.
2. Changed offer: price/stock changes before purchase → customer reviews and chooses; no silent seller swap.
3. Payment uncertainty: retry checks outcome; no duplicate order/charge.
4. Partial service: cancel/return affects only selected items, refunds and seller earnings.
5. Late shipment: overdue task visible to Shipping Manager + seller; customer notified with escalation route.
6. Refund after payout: customer refunded; seller statement shows deduction / amount owed.
7. Seller restriction: new sales stop; existing orders, returns, cases remain accessible.
8. Opening ad: eligible visitor sees it, closes it, continues; frequency, pause, expiry work.

## 8. Open business decisions (doc ch. 21) — defaults we'll assume until told otherwise

| Decision | Placeholder default |
|---|---|
| Company / brand name | Placeholder brand name in designs |
| Market, currency | Single region, USD |
| Categories | Electronics, Fashion, Home, Beauty, Sports (sample data) |
| Seller entry | Application + manual review (invite-friendly) |
| Guest checkout | Enabled (configurable) |
| Commission | % of item price after seller-funded discounts, excluding shipping (configurable per category) |
| Payout schedule | Weekly, after delivery + hold window (configurable) |
| Return window | 30 days baseline (configurable per category / seller) |
| Notifications | In-app + email at launch; SMS/push later (push will matter for Android) |
