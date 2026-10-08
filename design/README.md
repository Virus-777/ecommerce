# Marketly design system and UI prototype

Phase 1 deliverable. "Marketly" is a placeholder brand name, used everywhere through one constant (`UI.BRAND` in the prototype, an env/config value in the apps).

```
design/
  tokens.json              Source of truth for colour, type, spacing, radius, elevation, breakpoints, motion, icons
  prototype/
    index.html             Clickable prototype viewer (areas, screen list, phone/tablet/desktop frames, light/dark)
    tokens.css             tokens.json as CSS custom properties (light + dark)
    ui.css                 Component and layout classes (mobile-first, container queries)
    js/core.js             Screen catalogue, component helpers, layouts (store, account, checkout, back office)
    js/data.js             Sample data (fictional)
    js/shell.js            Viewer logic (hash router: #/screen-id@State)
    js/screens/*.js        One file per area; every screen in the plan is registered here
  tools/check-screens.js   Checks icon names and renders every screen/state headlessly
```

## Viewing the prototype

Serve `design/prototype/` with any static server and open `index.html`, for example `npx serve design/prototype`. The viewer shows:

- **Areas:** Theme, Customer Store, Seller Center, Admin Center, Operations.
- **Device widths:** Phone 390 px (the Android app layout), Tablet 834 px, Desktop 1280 px, Fit.
- **States:** screens with alternate states (failure, empty, steps of a wizard) have a state switcher.
- **Plan reference:** each screen names the plan chapter it implements.

Screens link to each other, so the main journeys can be clicked through: browse → product → cart → checkout → confirmation → order → return.

## Visual direction

- **Brand green** (`--brand`): primary actions, active navigation, the Official Store label.
- **Deal orange** (`--deal`): only for discounts, sale prices and flash-sale timers. It never marks errors or primary actions.
- **Neutrals** are slightly green-biased so the page feels calm and lets seller names, totals and dates stand out.
- **Status colours** (success, warning, danger, info) always appear with a word or icon, never colour alone.
- **Type:** Figtree for the interface, Bricolage Grotesque for occasional store display headings, IBM Plex Mono for order references, SKUs and tracking numbers.
- **Icons:** Lucide (outline, 1.75 stroke). Use `lucide-react` on the web and the same names as vector drawables on Android.
- **Charts:** two validated series colours (Official Store vs marketplace sellers) that stay distinguishable for colour-blind readers in both themes.

## Responsive rules (shared by web and Android)

| Width | Layout |
|---|---|
| < 768 | Phone / **Android app**: bottom tab bar (Home, Categories, Deals, Cart, Account); sub-pages get an app bar with back + title; sticky action bars for Add to cart and Checkout; **lists load more as you scroll (lazy loading) instead of numbered pages**; **no website footer, promo strip or breadcrumbs**: help, policies, About, selling and app settings live in the Account tab; back-office sidebars become scrollable section chips |
| 768–1023 | Tablet: top navigation, 3 product columns |
| ≥ 1024 | Desktop: sidebars (account, seller, admin), 4 product columns |
| ≥ 1280 | Wide: 5 product columns, content max 1240 px |

The prototype uses **container queries** (`@container app (min-width: …)`) so each device frame reflows on its own. In the React app, replace them with `@media (min-width: …)` using the same breakpoints.

## Using the tokens

**Web (React + Vite):** import `tokens.css` once at the root, then style through the variables (`var(--brand)`, `var(--sp-4)`, `var(--r-lg)`). Dark mode is driven by `prefers-color-scheme` plus an explicit `data-theme="light|dark"` on `<html>`.

**Android (Jetpack Compose):** generate `Color.kt`, `Type.kt` and `Dimens.kt` from `tokens.json`. Suggested Material 3 mapping:

| Material 3 role | Token |
|---|---|
| primary / onPrimary | `brand` / `on-brand` |
| primaryContainer / onPrimaryContainer | `brand-soft` / `brand-text` |
| tertiary / onTertiary | `deal` / `on-deal` (deals only) |
| background | `bg` |
| surface / surfaceVariant / surfaceContainerHigh | `surface` / `surface-2` / `surface-3` |
| onSurface / onSurfaceVariant | `text` / `text-2` |
| outline / outlineVariant | `border-strong` / `border` |
| error / errorContainer | `danger` / `danger-soft` |

Custom semantic colours (`success`, `warning`, `info`, `star`, `chart-1`, `chart-2`) go into an `ExtendedColors` CompositionLocal.

## Component inventory

Each helper in `js/core.js` becomes one React component (and later one Compose component):

| Prototype helper | React component | Notes |
|---|---|---|
| `btn`, `iconBtn` | `Button`, `IconButton` | variants: primary, secondary, soft, ghost, danger, danger-soft, deal, link; sizes sm/md/lg |
| `badge`, `status`, `sponsored` | `Badge`, `StatusBadge`, `SponsoredLabel` | `StatusBadge` owns the status → tone map for every status model in the plan |
| `field`, `input`, `select`, `textarea`, `check`, `radio`, `toggle`, `optCard`, `qty`, `dropzone` | `Field`, `TextInput`, `Select`, `Textarea`, `Checkbox`, `Radio`, `Switch`, `OptionCard`, `QuantityStepper`, `FileDrop` | |
| `price`, `stars`, `stars5`, `sellerBadge`, `sellerLine`, `shipLine`, `productCard`, `countdown`, `meter` | `Price`, `Rating`, `SellerBadge`, `SoldBy`, `DeliveryLine`, `ProductCard`, `Countdown`, `Meter` | commerce primitives |
| `card`, `pageHead`, `sectionHead`, `crumbs`, `kv`, `sumRow`, `stat`, `queueTile` | `Card`, `PageHeader`, `SectionHeader`, `Breadcrumbs`, `KeyValueList`, `SummaryRow`, `Stat`, `QueueTile` | |
| `tabs`, `seg`, `chips`, `steps`, `track`, `timeline`, `pager`, `lazyLoad` | `Tabs`, `SegmentedControl`, `FilterChips`, `Stepper`, `ProgressTrack`, `Timeline`, `Pagination`, `InfiniteList` | Website lists use `Pagination`; the Android app uses infinite scroll (`LazyColumn`/`LazyVerticalGrid` + Paging 3) with skeleton placeholders. The API supports both (cursor-based) |
| `table`, `searchIn`, `deadline` | `DataTable`, `SearchField`, `Deadline` | |
| `alert`, `empty`, `modal`, `drawer` | `Alert`, `EmptyState`, `Dialog` (bottom sheet on phone), `Drawer` | |
| `lineChart`, `barChart`, `sparkline`, `legend`, `splitBar` | `LineChart`, `BarChart`, `Sparkline`, `Legend`, `SplitBar` | |
| `storeLayout`, `checkoutLayout`, `accountLayout`, `boLayout` | `StoreLayout`, `CheckoutLayout`, `AccountLayout`, `BackOfficeLayout` | `BackOfficeLayout` serves Seller Center, Admin Center and Operations |

## Screen inventory

The full list lives in `UI.CATALOGUE` (`js/core.js`). The viewer marks any screen without a design in red, so you can see at a glance that the plan is fully covered.

| Area | Groups |
|---|---|
| Theme | Foundations, Components, Patterns and layouts |
| Customer Store | Shopping (13), Purchase (5), Sign in (4), My account (18), Help and policies (8), Seller entry (3), Advertising (3) |
| Seller Center | Setup guide + 23 screens covering the 11 plan menus, notifications and seller help |
| Admin Center | Dashboard + 33 screens covering the 12 plan menus, staff notifications and the ad creative library |
| Operations | 7 work-queue screens (inventory, receiving, pick & pack, dispatch, return inspection, finance checks) |

## Placeholders to confirm (plan ch. 21)

Brand name, logo, fees, return windows, payout schedule, service targets and campaign examples are placeholders, and every example value is labelled as one in the UI. Changing them needs no design changes.
