# Back-office UX: seller tools and commerce admin/operations consoles (2025–2026)

Scope: what makes merchant/seller dashboards and internal admin tools simple and smart, turned into concrete patterns for Marketly's Seller Center (third-party sellers) and Admin/Operations Center (internal staff). Covers the detail pages not designed yet: seller help article, trust & risk report detail, audit log entry detail, analytics report detail, create/edit forms (new case, add product, add role), and export flows.

Research date: 2026-10-12. Source dates are given where known. Undated or older items are marked.

---

## 1. Which seller/merchant tools are rated best for UX, and what do sellers praise or complain about?

### Takeaway
Stripe Dashboard and Shopify Admin are the usual positive references. Praise centres on calm, dense, searchable data and consistency (Shopify enforces this through Polaris). Amazon Seller Central, Etsy Shop Manager and eBay Seller Hub draw complaints about extra clicks, cosmetic redesigns that add no function, forced automation the seller can't control, and support/case handling that goes nowhere. I found little recent, reliable UX evidence for Walmart Seller Center, Zalando zDirect, Mercado Libre or Square.

### Cited Findings
**Stripe Dashboard (praised; mostly design-commentary sources, secondary)**
- Commentators say Stripe handles "high information density without chaos": compact, sortable, filterable transaction tables, search everywhere, and no three-level-deep menus — [AdminLTE, "25 best dashboard design examples for 2026"](https://adminlte.io/blog/25-best-dashboard-design-examples-for-2026-real-products-principles/)
- In this account, Stripe's challenge is "making complex, high-stakes financial data feel calm": hierarchy comes from typography and whitespace rather than colour, and navigation "maps to jobs-to-be-done rather than Stripe's internal data model" — [925 Studios, Stripe Dashboard Design Breakdown](https://www.925studios.co/blog/stripe-dashboard-design-breakdown) (design-agency blog, secondary)
- Stripe's in-dashboard developer tool Workbench shows the "power-user drawer" idea: open it from anywhere with the `~` key, resize it, minimise it to a taskbar with a notification tray, and use **Copy link** to share the current view — [Stripe Docs, Workbench](https://docs.stripe.com/workbench/overview)
- In the Radar review queue, `J`/`K` and Previous/Next buttons move between items, so reviewers work through cases one after another without going back to the list — [Stripe Docs, Review payments](https://docs.stripe.com/radar/reviews)

**Shopify Admin / Polaris (praised for consistency)**
- Shopify's app design guidelines say apps should "Match the rest of the Shopify admin and put merchant needs ahead of being different for its own sake", design mobile first, and use Polaris components so everything looks and behaves the same — [Shopify.dev, App design guidelines](https://shopify.dev/docs/apps/design)

**Amazon Seller Central (often criticised)**
- In a seller forum thread, a seller says setting an item's quantity to zero now takes extra clicks, where it used to take two: click the field, type, save — [Amazon Seller Forums](https://sellercentral.amazon.com/seller-forums/discussions/t/307e6c16-395a-4061-843c-ca3d7e75b940) (forum post; summarised by search, exact date not checked)
- A seller says the buyer-seller messaging box is so full of placeholder text it doesn't look typeable, and two large CTA buttons above it draw the eye instead — [Amazon Seller Forums (EU), "Buyer-Seller Messaging Has Too Much Friction"](https://sellercentral-europe.amazon.com/seller-forums/discussions/t/4a61efa1-deab-497e-b60e-e7f9ff052ad8)
- About an earlier Seller Central redesign, sellers complained the fonts were too big, the blue text hard to read, the contrast low, and that light shaded boxes replacing gridlines made tables harder to read. Some said the changes were "only cosmetic with no added functionality" — [EcommerceBytes, "Amazon Redesigns Seller Central – Unnecessarily?"](https://www.ecommercebytes.com/?p=3433) (**older, undated in my results; probably pre-2020**)
- One 2025 thread says seller support cases dragged on unresolved and were passed between "internal teams" — [Amazon Seller Forums, "Anyone else having issue with seller support cases in 2025?"](https://sellercentral.amazon.com/seller-forums/discussions/t/851515e5-12a6-42e0-896c-4d7fdb79dedf). A seller-tools vendor makes the same complaint: slow, generic, automated replies — [SmartScout](https://smartscout.com/amazon-selling-guides/why-is-amazon-seller-support-so-bad)

**Etsy Shop Manager**
- In April 2025 Etsy announced on-site photo editing, a search dashboard showing which listings need refreshing, real-time quality alerts before publishing (beta), faster pages and simpler navigation. Sellers worried about AI review summaries and auto-generated alt text applied by default with "questionable results" — [Value Added Resource, Apr 2025](https://www.valueaddedresource.net/etsy-shop-manager-updates-spring-2025/)
- Over the years, sellers have pushed back on Etsy's many layout "experiments", which they say make shops harder to navigate — [EcommerceBytes](https://www.ecommercebytes.com/?p=6220) (**older, undated**)

**eBay Seller Hub**
- In one survey, 72% of respondents used Seller Hub and only 53% of those were satisfied. Sellers liked the customisable, all-in-one layout but called the traffic reports inadequate — [EcommerceBytes, "Survey Reveals eBay Seller Hub Portal Needs Some Work"](https://www.ecommercebytes.com/?p=11045) (**older, undated; probably ~2018–2019**)

**Marketplace context**
- Marketplace Pulse surveyed 181 marketplace sellers with more than $2B combined revenue (2025/2026). Walmart Marketplace has about 200k active sellers (mid-2025, up 25% year on year), and more than 50% of Walmart sellers also sell on Amazon — [Red Stag Fulfillment citing Marketplace Pulse](https://redstagfulfillment.com/how-many-walmart-marketplace-sellers/); [Marketplace Pulse](https://www.marketplacepulse.com/)
- Sellers are active on 6 marketplaces on average, and 34% manage 7 or more — [ChannelEngine, Marketplace Seller Trends Report 2025](https://www.channelengine.com/en/blog/marketplace-seller-trends-report-2025?hsLang=en)

### Inferences
- Multi-marketplace sellers bring habits from Amazon and Shopify with them. Marketly's Seller Center should follow familiar conventions (index → detail → contextual save; filters above tables) rather than invent its own.
- The most common complaints are about lost efficiency (more clicks for frequent tasks), not looks. Keep quick inline edits for stock and price on index rows, and treat any change that adds clicks to a frequent task as a regression.
- Turning on AI by default without control is a trust risk. Marketly should label any auto-generated content (alt text, summaries) as editable and opt-in.
- Case handling that doesn't move ("tossed between teams") is a top frustration. Seller support cases need a visible owner, status, SLA and timeline (see §4/§6).

### Gaps
- I found no reliable 2025–2026 UX evidence (surveys, forums, design writeups) for **Walmart Seller Center, Zalando zDirect, Mercado Libre seller tools or Square Dashboard**. Treat any claims about them as unverified.
- I found no quantitative 2025–2026 cross-platform survey of seller-tool UX satisfaction. The eBay figure is older.
- The Stripe praise comes from design blogs, not merchant surveys.

---

## 2. Design system guidance: index tables, filters, bulk actions, detail/resource pages, empty states, forms, save bar, toasts, help links

### Takeaway
The major systems agree. Index tables put search and filters above the table, and a bulk-action bar replaces the filters while rows are selected. Detail rows are links. Forms are single-column with top-aligned labels, mark only the minority of fields as required or optional, use specific verb buttons, and save explicitly. An empty state replaces the whole table, with one positive title, one action and a docs link. Systems differ on toasts (Shopify uses them; GitHub Primer avoids them) and on disabling submit buttons.

### Cited Findings
**Index tables (Shopify Polaris / App Home compositions)**
- Polaris index tables have select-all and per-row checkboxes with an indeterminate state, a visible selection count, and a toolbar that **replaces the filters only while resources are selected**. The highest-value bulk action is a visible button and the rest go in a menu — [Shopify.dev, Index table composition](https://shopify.dev/docs/api/app-home/patterns/compositions/index-table); [Shopify.dev unstable bulk actions](https://shopify.dev/docs/apps/build/app-home/migrate-from-polaris-react/unstable-bulk-actions.md)
- Search and filters sit in a filters slot above the table, and the search field's placeholder says what is searched. Sorting uses a popover with "Sort by" (field) and "Order by" (direction). Numeric columns are right-aligned. Primary/secondary column slots let rows stack on mobile. Pagination has previous/next and a label — [Shopify.dev, Index table composition](https://shopify.dev/docs/api/app-home/patterns/compositions/index-table)
- Rows link to the detail page (image, title or whole row). Bulk success is confirmed with a Toast, and destructive bulk actions are confirmed in a Modal first — [same](https://shopify.dev/docs/api/app-home/patterns/compositions/index-table)

**Contextual save bar (Shopify)**
- The save bar "should become visible when a form on the page has unsaved changes". It offers Save and Discard, gives a short message about what changed, "save[s] all changes on the page", and avoids pages where several forms can be edited at once — [Polaris, Contextual save bar](https://polaris.shopify.com/components/deprecated/contextual-save-bar). Note: the polaris-react component is now listed as **deprecated** as Polaris moves to web components and App Bridge, but the pattern is still the Shopify admin standard — [polaris-react deprecated listing](https://polaris-react.shopify.com/components/deprecated/contextual-save-bar)

**Saving (GitHub Primer)**
- Default to explicit saving, and "never mix save patterns in a single form". Auto-save only for immediate controls (toggles, segmented controls, single-selects outside forms) — [Primer, Saving](https://primer.style/product/ui-patterns/saving/)
- Use one save button per form. Put it bottom-left on pages and bottom-right in dialogs. **Don't disable or hide save buttons** because they can't receive focus and are low contrast. Use specific verbs ("Create", "Save", "Update"), not "Done" — [Primer, Saving](https://primer.style/product/ui-patterns/saving/)
- Warn before leaving with unsaved changes (`beforeunload`). On a failed save, keep what the user entered and show an inline message or banner. Confirm destructive actions and offer undo. Primer **avoids toasts on github.com for accessibility reasons** and uses an inline message (no redirect) or a banner (after a redirect) instead — [Primer, Saving](https://primer.style/product/ui-patterns/saving/). This conflicts with Shopify's use of toasts for bulk-action confirmations ([Shopify.dev](https://shopify.dev/docs/api/app-home/patterns/compositions/index-table)).

**Forms (IBM Carbon)**
- Use single-column layouts, top-aligned sentence-case labels of 1–3 words with no colons, 32px between fields on full pages and 48px before the button group — [Carbon, Forms pattern](https://carbondesignsystem.com/patterns/forms-pattern/)
- Mark only the minority: if most fields are required, label the optional ones "(optional)", and the other way round. Keep this consistent across the product — [Carbon](https://carbondesignsystem.com/patterns/forms-pattern/)
- Helper text stays visible below the label. Placeholders are only for format hints. Tooltips are "not catchalls" and should be used "very sparingly". Validate on blur with specific errors ("Password must be at least 16 characters", not "Invalid format") — [Carbon](https://carbondesignsystem.com/patterns/forms-pattern/)
- Disable the primary button until valid only on short forms. On long forms, don't. Always disable it after submit to prevent duplicates. (This partly conflicts with Primer's "never disable".) — [Carbon](https://carbondesignsystem.com/patterns/forms-pattern/)
- Button alignment: primary on the left for in-page forms; primary on the right for dialogs, side panels and wizards. Use task-specific labels ("Create account"), not "Submit" — [Carbon](https://carbondesignsystem.com/patterns/forms-pattern/)
- Which container to use: **dedicated page** for complex or multi-step forms (no input limit), **dialog** for critical, infrequent edits with fewer than 5 inputs, **side panel** for repeated input that needs reference context (more than 5 inputs). Don't hide fields in accordions or tabs inside dialogs or panels. Multi-step forms get a progress indicator and let users go back and review — [Carbon](https://carbondesignsystem.com/patterns/forms-pattern/)

**Empty states (IBM Carbon)**
- Three types: no data / first use; user action (for example, filters with no results: explain why and what to do next); and error/permission (data exists but can't be shown; be specific and plain) — [Carbon, Empty states](https://carbondesignsystem.com/patterns/empty-states-pattern/)
- Parts: a positive title ("Start by adding data assets", not "You don't have any"), a body explaining why it's empty and the benefit of acting, a primary action, an optional docs link, and an optional decorative image. The empty state **replaces** the table, so column headers and footer are hidden — [Carbon](https://carbondesignsystem.com/patterns/empty-states-pattern/)

### Inferences
- Marketly should pick one rule for toasts versus inline confirmations and write it down. Suggestion: toasts only for short, non-critical confirmations of bulk or background actions ("Export started"), plus a durable record (notification centre or job list). Use inline messages or banners for form save results and errors, which addresses Primer's accessibility concern.
- Disabled buttons: follow Primer (never disable Save; validate on submit and focus the first error) for long forms like Add product and Add role. Allow Carbon's "disable until valid" only in short dialogs, and always disable after submit for idempotency.
- Choosing a container for Marketly's create forms: **Add product** → dedicated page (long, sectioned, save bar). **Add role** → dedicated page (permission matrix). **New case** (seller support or staff T&S) → side panel when opened from a related order or listing (context stays visible), dedicated page when opened from the cases index.

### Gaps
- I couldn't fetch the current Polaris "resource index layout" and "resource details layout" pattern pages. The old polaris.shopify.com URLs now redirect to shopify.dev/docs/api/polaris. The two-column detail layout guidance (primary column on the left, summary/metadata card on the right) is from training knowledge, not verified this session.
- I didn't fetch Atlassian or Salesforce Lightning pages in this pass, so there is no direct citation from them.

---

## 3. Audit log / activity history UI patterns (entry detail: actor, action, target, before/after, request id)

### Takeaway
Good audit logs are structured event streams. Every entry is actor + action (namespaced verb) + target resource + time + origin (IP/country/device). They support qualifier search (`actor:`, `action:`, `created:` ranges), retention limits, and async JSON/CSV export. The entry detail should look like Stripe's event/log inspector: list on the left, detail on the right, with the raw payload, related objects and a shareable link.

### Cited Findings
- **GitHub org audit log** entries show organisation, actor, affected user, repository, action, location (country) and timestamp — [GitHub Docs, Reviewing the audit log](https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/reviewing-the-audit-log-for-your-organization)
- GitHub search qualifiers include `operation:create|modify|remove`, `repo:org/repo`, `actor:username`, `action:team.create`, `created:2014-07-01..2014-07-31` (ISO 8601 ranges), and `country:de`, with `-`, `>`, `<` operators — [GitHub Docs](https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/reviewing-the-audit-log-for-your-organization)
- GitHub exports to JSON or CSV from a dropdown, with a hard limit of a 100 MB compressed file or 10 minutes of processing. Retention is 180 days — [GitHub Docs](https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/reviewing-the-audit-log-for-your-organization)
- **Google Workspace** Audit and investigation tool: Reporting > Audit and investigation > Admin log events. It shows the last 7 days by default, with Before/After date filters you can remove — [Google Workspace Admin Help, Run a search](https://knowledge.workspace.google.com/admin/reports/run-a-search-in-the-audit-and-investigation-tool?hl=en)
- From April 29, 2026, Workspace audit events carry richer entity attributes: "Owner details" on Resources (Owner Type: User / Customer / Group, plus Owner Identity) across 14+ sources, wider "Actor application info", and a new **User device info** attribute (device ID, OS version, device type such as DESKTOP_MAC) — [Google Workspace Updates blog, Apr 2026](https://workspaceupdates.googleblog.com/2026/04/workspace-audit-logs-new-functionality-and-expanded-event-fields-in-the-admin-console.html)
- **Stripe Workbench** request logs can be filtered by date, HTTP status, method, endpoint, IP, source (API or Dashboard), account, API version, error code, error type and error parameter. Logs don't auto-refresh; there is an explicit **Refresh logs** button — [Stripe Docs, Workbench](https://docs.stripe.com/workbench/overview)
- Workbench Events is a master-detail view: click an event in the left list to see its details, payload and delivery attempts on the right (Succeeded/Failed tabs, **Resend**). Events can be filtered by type with wildcards (`customer.*`) and by resource ID — [Stripe Docs, Workbench](https://docs.stripe.com/workbench/overview)
- The Workbench Inspector shows any object as JSON with a **Data map** of related objects and tabs for related **Logs** and **Events**. It opens from any dashboard object page via an Inspect icon, and **Copy link** shares the current view — [Stripe Docs, Workbench](https://docs.stripe.com/workbench/overview)
- Shopify order pages have a **timeline** that records system decisions, for example "Blocked due to high risk of fraud" — [Shopify Help, Fraud analysis](https://help.shopify.com/en/manual/fulfillment/managing-orders/protecting-orders/fraud-analysis)

### Inferences
Suggested **Audit log entry detail** for Marketly Admin Center (assembled from the patterns above):
- Header: a human-readable sentence ("Jane Doe (Support Agent) changed payout hold on Seller ACME"), with the machine action (`seller.payout_hold.update`) and outcome badge (success/denied/failed) beside it.
- Fact panel: actor (user, role at the time, or service/API client), target resource with owner (as Workspace now does), timestamp in the viewer's time zone plus UTC, origin (IP, country, device/user agent, Seller Center vs Admin vs API), **request ID / correlation ID** with copy button, and the session or token ID (fits Marketly's "every endpoint needs a token" rule).
- **Before/after diff** of changed fields only (old struck through, new highlighted), with a "show raw JSON" disclosure (the Stripe Inspector idea).
- Related: other events with the same request ID or session, and on the same target (the "related payments" idea from Radar applied to audit). Links to the target's page.
- Actions: Copy link, "Filter log by this actor/target/action" chips that apply qualifiers, export this entry. No edit or delete: the log is append-only.
- Index: qualifier search (`actor:` `action:` `target:` `created:`), default last 7 days (Workspace) with an explicit retention notice (GitHub's 180 days), manual refresh, and async export with size and time limits.

### Gaps
- I didn't find official before/after diff UI documentation from GitHub, Stripe or Google. The diff recommendation is inferred; GitHub/Google docs list fields, not diffs.
- I didn't fetch Shopify's admin "activity log" for staff actions in detail.

---

## 4. Trust & safety / risk case detail patterns (Stripe Radar review, Shopify fraud analysis, Amazon Account Health)

### Takeaway
The best risk case pages pair a simple banded verdict (risk level or score band) with a *few* explained factors that are clearly marked as raising or lowering risk. They add a "related entities" network view, a recommended next action in plain language, a fixed set of decisive actions with their consequences stated, assignment to avoid duplicate work, and a timeline of every action and assignment. Amazon's Account Health shows how the same idea works for the *seller* side: one score with clear bands, broken into categories and severities.

### Cited Findings
**Stripe Radar (staff/merchant reviewer)**
- The review queue is a prioritised list of payments needing investigation. The list view shows risk level, customer, payment method, amount, date and client. The detail view adds custom metadata. `J`/`K` and Previous/Next move through reviews — [Stripe Docs, Review payments](https://docs.stripe.com/radar/reviews)
- **Risk insights** on the payment page show "some of the most relevant risk factors" with **Show all insights** to see more: name/email match, authorisation success rate of the email across the Stripe network, and billing, shipping and IP geography. Insights are stored for 6 months — [Stripe Docs, Risk insights](https://docs.stripe.com/radar/reviews/risk-insights)
- **Related payments** shows other payments sharing a customer ID, IP or card number, which exposes card testing (many cards, one IP) or trial abuse (many customers, one card) — [Stripe Docs, Risk insights](https://docs.stripe.com/radar/reviews/risk-insights)
- Actions with stated consequences: **Approve** (closes the review, no change), **Refund** ("permanent, you can't undo it"), **Refund and report fraud** (also adds the card fingerprint and email to block lists). A dispute closes the review automatically — [Stripe Docs, Review payments](https://docs.stripe.com/radar/reviews)
- Assignment: "Assign to me" from hover/overflow or the detail page. Filters for mine and unassigned. You can only assign yourself. "The review timeline shows a complete history of assignment changes and other actions" — [Stripe Docs](https://docs.stripe.com/radar/reviews)
- **Smart Refunds** filter: recommendations bucketed by confidence, with each level's stated probability of an early fraud warning or dispute (Very high 72%, High 60%, Medium 40%, Low 30%, Very low 15%) — [Stripe Docs](https://docs.stripe.com/radar/reviews)
- Best-practice guidance: focus human review where judgement adds value, use insights to decide when to "trust or ignore the score", turn reviewer intuition into rules, and pass business metadata (for example Maps/Street View links for shipping addresses) so all context is on the page — [Stripe Docs](https://docs.stripe.com/radar/reviews)

**Shopify fraud analysis (merchant)**
- Three risk levels (low, medium, high). Medium and high show a warning symbol beside the order number in the index — [Shopify Help, Fraud analysis](https://help.shopify.com/en/manual/fulfillment/managing-orders/protecting-orders/fraud-analysis)
- The **Order risk evaluation** separates details linked to fraudulent behaviour, legitimate behaviour, and neutral details (for example AVS pass, customer location matching the payment method). It explicitly says that "individual indicators and group headings don't represent the order's overall risk level" — [Shopify Help](https://help.shopify.com/en/manual/fulfillment/managing-orders/protecting-orders/fraud-analysis)
- Plain-language recommendations: "You can fulfill this order" / "Confirm with the customer before fulfilling" / "Consider canceling this order", with a **Contact customer** action — [Shopify Help](https://help.shopify.com/en/manual/fulfillment/managing-orders/protecting-orders/fraud-analysis)

**Amazon Account Health (seller-facing)**
- The Account Health Rating runs 0–1,000 with bands: 0–99 unhealthy (deactivated or eligible), 100–199 at risk, 200+ healthy. Accounts start at 200 — [SPS Commerce](https://www.spscommerce.com/community/articles/everything-you-need-to-know-about-the-new-amazon-account-health-rating-ahr); [Seller Assistant, Jun 2025](https://www.sellerassistant.app/blog/what-is-amazon-seller-account-health-rating/)
- The dashboard has three sections: Customer Service Performance, Policy Compliance and Shipping Performance. Violations are graded critical/high/medium/low, and the rating updates 24–48 h after Amazon confirms a fix — [JumpFly](https://www.jumpfly.com/blog/the-ins-and-outs-of-amazon-account-health-ratings/); [Emplicit](https://emplicit.co/ultimate-amazon-policy-violations-guide/) (third-party explainers; Amazon's own help pages require login)
- Amazon first combined policy violations into one dashboard in 2020 — [EcommerceBytes, Sep 2020](https://www.ecommercebytes.com/2020/09/18/amazon-aggregates-seller-policy-violations-in-new-dashboard/) (older)

### Inferences
Suggested **Trust & risk report detail** (Admin/Ops Center):
- Header: subject (seller, listing, order or buyer), case ID, status, SLA timer, assignee with "Assign to me", and Previous/Next/`J`/`K` through the queue.
- Verdict card: risk band (Low/Medium/High/Critical) as the main signal and numeric score second. One sentence on "why this is in review" (the rule or model trigger).
- Factors: top 3–5 signals grouped **raises risk / lowers risk / neutral** (Shopify), "Show all factors" (Stripe), and the Shopify caveat that no single factor equals the verdict.
- Evidence tabs: related entities graph/list (shared payout account, device, IP, address, documents; the related-payments idea), attachments (documents, screenshots), and the seller's own history (prior cases, health metrics).
- Recommendation in plain words ("Confirm identity before releasing payouts"), with confidence where a model supports it (the Smart Refunds idea of showing the probability per level).
- Action bar: a fixed set of decisions (Clear / Request info / Restrict listing / Hold payouts / Suspend), each with its consequence and reversibility stated before confirmation, and a required reason code plus note that is written to the audit log.
- Timeline: every assignment, action, message and system event (Stripe review timeline, Shopify order timeline).

Suggested seller-facing **Account health** in Seller Center: one banded score (an AHR-like idea), three category cards, a violation list with severity, each item linking to "what happened, what to do, appeal/submit fix", and the expected update time stated ("updates within 24–48 h after review").

### Gaps
- I couldn't get Amazon's official Account Health help pages (login required). The figures come from third-party explainers that agree with each other.
- I found no public documentation of how marketplace operators (as opposed to merchants) build internal T&S case consoles; that is mostly proprietary.

---

## 5. Analytics report detail patterns (date range, comparison, metric definitions, export: CSV, async, email)

### Takeaway
Report detail pages default to a sensible period (Stripe: prior month) with inclusive dates and an explicit time zone. They offer comparison to the previous period or the same period last year (Shopify). They state data freshness/SLA, and handle big exports asynchronously with email notification and scheduled delivery. Shopify chooses download versus email automatically based on export size.

### Cited Findings
- Stripe financial reports **default to the prior month**. Options are previous months, month to date, or custom dates. Selected dates are **inclusive** (00:00 to 23:59 in the chosen time zone) — [Stripe Docs, Report options](https://docs.stripe.com/reports/options)
- The time zone choice is the account's time zone or UTC, and it affects both filtering and how timestamps are displayed — [Stripe Docs](https://docs.stripe.com/reports/options)
- Stripe publishes a **data availability SLA** on the page: balance and payout reconciliation available within 12 hours, with a day's data normally ready by 12:00 the next day, and exceptions listed — [Stripe Docs](https://docs.stripe.com/reports/options)
- Scope filters: currency selector (per settlement currency), and for Connect platforms, platform only, all connected accounts, a chosen set (via a searchable "Select connected accounts" drawer), or a single account — [Stripe Docs](https://docs.stripe.com/reports/options). Relevant for Marketly as a marketplace: admins see all sellers or chosen sellers; sellers see only their own.
- **Scheduled reports**: Schedule… → daily, weekly or monthly, plus columns and currency → "Download the report after you receive an email notification that it's ready". Set the schedule to None to stop — [Stripe Docs](https://docs.stripe.com/reports/options)
- Shopify reports compare a selected period with the **previous period or the same period last year**, and export to CSV — [ReportPundit (third-party app vendor) describing native Shopify](https://www.reportpundit.com/post/analyze-your-shopify-store-growth-with-date-comparison) (secondary)
- Shopify product export: scope choice of **current page / all / selected / current search & filter results**, and format choice of CSV for Excel/Numbers or plain CSV. **Delivery is chosen automatically**: browser download when all products have under 100 variants, otherwise (or when exporting all products) the file is **emailed**, also to the store owner when a staff member exports — [Shopify Help, Export products](https://help.shopify.com/en/manual/products/import-export/export-products)
- Export values often differ from on-screen analytics because of differing definitions, a common merchant confusion — [Highview Apps KB](https://www.highviewapps.com/kb/why-are-the-values-from-the-export-dont-match-shopify-analytics-reports/) (third-party)
- In the same eBay survey, sellers said "traffic reports were inadequate", so weak analytics hurts satisfaction — [EcommerceBytes](https://www.ecommercebytes.com/?p=11045) (older)

### Inferences
Suggested **Report detail** (Seller Center Analytics and Admin Reports):
- Toolbar: date range preset (default last 30 days or prior month), Compare to (previous period / same period last year / none), time zone shown (seller's time zone with a UTC toggle for admins), and scope (admin: all/chosen sellers via a searchable drawer).
- KPI header with delta vs comparison (sign plus %), then chart, then a table of the same data (same numbers, so the export matches the screen).
- Metric definitions: an ⓘ or "Definitions" drawer per metric (formula; refunds/taxes in or out; when an order counts), placed next to the metric and in the export header. This targets the Highview-style "export doesn't match" confusion.
- Freshness line: "Data updated 2 h ago · Orders finalise within 12 h" (Stripe-style SLA).
- Export flow: an Export button opens a dialog with scope (current view / all rows / selected), format (CSV for Excel / plain CSV, plus XLSX if offered) and columns (use the view's columns). Small exports download immediately. Large ones run **async**: show a toast like "Export started — we'll notify you", add it to an **Exports** list (status: queued → ready → expired, with a download link and expiry) and send an email or in-app notification. Also offer **Schedule** (daily/weekly/monthly, recipients). This follows Shopify's size threshold and Stripe's email-when-ready and scheduling.
- Admin exports of seller data should record an audit entry (actor, scope, row count) and notify the data owner where policy requires (Shopify emails the store owner when staff export).

### Gaps
- I didn't fetch Shopify's own Analytics help pages; the comparison feature is cited through a third-party vendor. I found no Google Analytics report-detail source this session.
- I found no documented guidance on export link expiry or row limits for Shopify or Stripe; the "expiry" suggestion is inferred (GitHub's export has 100 MB / 10 min limits).

---

## 6. In-product help: seller help articles, contextual help, onboarding checklists

### Takeaway
Help works best when it is tied to the exact control and delivered at first meaningful use. Setup should be split into named steps with visible progress and nothing optional up front. Empty states and "Learn more" links are the main entry points into help articles. Error and permission states need plain, specific language.

### Cited Findings
- Each onboarding step should support "one main action, one main decision, or one coherent group" of inputs. Required setup goes in clearly named steps showing where you are, what remains and what's done. Optional settings come later, in context, when relevant — [Trevor Calabro, "Onboarding & In-App Help Strategy" (Substack)](https://trevorcalabro.substack.com/p/onboarding-and-in-app-help-strategy) (practitioner blog, secondary)
- Guidance should point to the exact control and say what to do *now*. Introduce features at first meaningful use — [same](https://trevorcalabro.substack.com/p/onboarding-and-in-app-help-strategy)
- Checklists put onboarding tasks in a structured sequence where users track progress and launch guidance per task — [Whatfix](https://whatfix.com/blog/user-assistance/) (vendor, secondary)
- Empty states should include an optional **link to documentation** as a secondary action and stay focused on one feature — [Carbon, Empty states](https://carbondesignsystem.com/patterns/empty-states-pattern/)
- Tooltips are for non-essential information only and should be used very sparingly. Essential guidance belongs in visible helper text — [Carbon, Forms](https://carbondesignsystem.com/patterns/forms-pattern/)
- Stripe puts help and diagnosis inside the work. The Errors tab groups errors by type with occurrence counts and "learn more about how to resolve each type", linking to the matching logs. A Health tab gives a 30-day alert history with "actionable insights" — [Stripe Docs, Workbench](https://docs.stripe.com/workbench/overview)
- Stripe's reports docs say in place why data might be missing ("If your integration doesn't provide… Radar can't compute…") and link to a checklist, a pattern of help that explains a gap — [Stripe Docs, Risk insights](https://docs.stripe.com/radar/reviews/risk-insights)
- Etsy's 2025 search dashboard shows which listings "need refreshing", an example of contextual, actionable guidance in a seller tool — [Value Added Resource, Apr 2025](https://www.valueaddedresource.net/etsy-shop-manager-updates-spring-2025/)

### Inferences
Suggested **Seller help article** page (Seller Center):
- Breadcrumb within Help (desktop only, per project rule that phone layout has no breadcrumbs) → title → "Applies to" chips (for example, marketplace, seller tier) → updated date → short answer summary at the top → numbered steps with **deep links that open the real Seller Center page** ("Go to Payouts settings →") → policy excerpts in a callout → "Related articles" → "Was this helpful? Yes/No (+ reason)" → "Still need help? Open a case" which **prefills the New case form** with the article and category (stops the "case goes nowhere" loop from §1).
- The same article content can open in a **side help panel** from "Learn more" links on forms, empty states and errors, so the seller doesn't lose form state (consistent with the unsaved-changes rules in §2).
- Onboarding: a dismissible Seller Center home **setup checklist** (verify identity → add payout account → add first product → set shipping profile → publish). Each item shows status and opens the exact form, and optional settings are left out.
- Staff side: Ops Center playbook links on case and risk pages ("How to handle counterfeit reports"), in the same side-panel pattern.

### Gaps
- My NN/g-specific searches returned practitioner and vendor blogs instead. I have no verified NN/g citation for contextual help or checklists from this session.
- I didn't verify the current anatomy of Shopify's admin "Setup guide" or help-centre article pages, nor Amazon's Seller University or help pages (login needed).
- No sources found on seller satisfaction with in-product help articles specifically.
