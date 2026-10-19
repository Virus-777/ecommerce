# Porting a design screen to React

The design is `design/marketly-ui-final-complete.zip`: 122 screens exported as 229 static pages that share one stylesheet. `npm run design:extract -- <zip>` (from the repository root) unpacks it into `web-shared/.design/marketly-ui-final/` (git-ignored). Each screen becomes one React page in the app that serves it: the Customer Store (`frontend/`), the Seller Center (`seller-center/`) or the Admin Center with Operations (`admin-center/`). The stylesheet is used verbatim (`web-shared/src/styles/marketly.css`), so **a port is correct when it renders the same markup and classes as the design file** and its interactions work.

## Where things are

Shared code is the `@marketly/web-shared` package; app code imports it by subpath and uses `@/` for its own files.

| Import / path | What |
|---|---|
| `@marketly/web-shared/routes` | The screen catalogue (`SCREENS`: `id`, `app`, route `path`, design `file`, `views`), `href(id, view?, params?, query?)`, the app router factory. Do not edit routes casually. |
| `@marketly/web-shared/ui` | Components mirroring the design helpers (see `web-shared/src/ui/index.ts`). |
| `@marketly/web-shared/layouts` | `BackOfficeLayout` (`SellerLayout`, `AdminLayout`, `OpsLayout`) and `Logo`. |
| `@marketly/web-shared/lib/*` | `format` (`money`, `num`…), `cx`, `hooks` (`useView`, `useIsPhone`, `useCountdown`, `useScrollRegion`, `useBodyLock`). |
| `@marketly/web-shared/data/*` | `fixtures` (shared sample sellers, products, customer, orders) and `staff` (mock back-office identities). |
| `frontend/src/layouts/` | Store-only layouts: `StoreLayout`, `CheckoutLayout`, `AccountLayout`. |
| `<app>/src/pages/…` | One page per screen id. Store: `pages/<dir>/<Name>.tsx` (`store/checkout-review-changes` → `pages/store/CheckoutReviewChanges.tsx`). Seller Center: `pages/<Name>.tsx`. Admin Center: `pages/admin/<Name>.tsx`, `pages/ops/<Name>.tsx`. Default export, listed in `<app>/src/routes/pages.ts`. |
| `web-shared/tools/strip-design.mjs` | `node web-shared/tools/strip-design.mjs <file.html> --body` prints a design page's `<main>` with inline SVG icons collapsed to `<Icon name="…"/>`. Drop `--body` to see the chrome and any overlay (dialogs sit after `</main>`). |

## Rules

1. **Read every view of the screen first.** `pages/<area>/<file>.html` is the default view; `<file>--<slug>.html` are the other views. A view is a state of one page, not a different page.
2. **Views are `?view=<slug>`.** `const [view, setView] = useView<'shipped' | 'completed'>()`. Opening `<path>?view=<slug>` must render what `<file>--<slug>.html` shows (same open dialog, same tab, same wizard step, same error). Then make the same state reachable by interaction: the tab click, the "Issue refund" button, the "Continue" button.
   - Tabs, segments and chips that linked to view files → `Tabs` with `active={view}` and `onChange={setView}` (or `to: href(id, slug)`).
   - Modal/drawer views → `<Dialog open={view === 'x'} onClose={() => setView('')}>`.
   - Data-driven views (empty cart, no results, wrong password, payment failed) → page state initialised from the view, changed by the real interaction (removing the last cart item shows the empty state).
3. **Markup and classes match the design.** Keep element types, class names, headings levels, `aria-*` and copy text. Use `ui` components where they produce the same markup (Button, Badge, StatusBadge, Card, Alert, Field…); write plain JSX with the design's classes for screen-specific blocks. Layout chrome comes from the layout component, never copied into the page.
   - `class` → `className`, `for` → `htmlFor`, `tabindex` → `tabIndex`, `style="a:b"` → `style={{ a: 'b' }}` (CSS variables: `{ '--r': '92%' } as CSSProperties`).
   - Icons: `<Icon name="truck" className="ic-sm" />` with the design's `data-lucide` name. Every name in the design is in `web-shared/src/ui/icons.generated.ts`; add others to `web-shared/tools/icons.extra.txt` and run `npm run gen:icons`.
   - Image tiles: `<Img icon="headphones" tint="2" />` → `<div class="imgph tint-2">`.
   - `data-scroll-region` tables → `<TableWrap label="…">`; `data-qty` → `QuantityStepper`; `data-copy` → `CopyButton`; `data-switch` → `Switch`; `data-phone-collapse` → `PhoneCollapse`; countdowns → `Countdown` (live).
4. **Links.** Always `href(id)`, never a literal path: design `href="store-product.html"` → `<Link to={href('store/product')}>` (find the id by the `file` field in the catalogue). `x--slug.html` → `href(id, 'slug')`. A screen of another app gets an absolute URL to that app automatically (`VITE_STORE_URL`, `VITE_SELLER_URL`, `VITE_ADMIN_URL`). `href="#"` placeholders: keep `<a href="#">` for inline text links (a global handler stops the jump) or use a `<button type="button">` for actions. Buttons with `href` → `<Button to={…}>`.
5. **Make it work, with local state.** Forms are controlled and validate (show the design's error copy); qty steppers change line totals; select-all checkboxes select rows and show the bulk bar the design has; filters/tabs filter the list; remove/archive/approve actions update the list and show the design's success alert or status; dialogs submit and close. Flow buttons navigate where the design links (Place order → confirmation). Store cart quantity changes call `useSession().setCartCount`.
6. **Data shape is API-ready.** Put sample rows in typed arrays at the top of the page (or `pages/…/data/<screen>.ts` when long) and render with `.map`; don't repeat near-identical JSX blocks. Reuse `@marketly/web-shared/data/fixtures` for products, sellers, the customer and orders where the design uses them. Money via `money()` when computing totals.
7. **Phone layout is the Android app.** It is handled by CSS classes (`no-phone`, `only-phone`, `only-desktop`, `no-desktop`) and the layouts; keep those classes. Long lists use `<Pager>` (website page numbers + phone lazy-load row). No footer/breadcrumbs on phone (CSS already hides them; don't add more).
8. **Accessibility.** Exactly one `<h1>` per page. Icon-only buttons get `label`. Keep `role`, `aria-label`, `sr-only` text from the design.
9. **Shared code is shared by three apps.** Change `web-shared` only on purpose and run `npm run typecheck` (all apps) afterwards.
10. **Check.** `npm run typecheck` at the root, then `/design/check` in the app's dev server.

## Example

`frontend/src/pages/account/Addresses.tsx`: account layout, alert, card grid from a typed array, add/edit dialog driven by `?view=edit-address`, controlled form with validation that reproduces the design's ZIP error state, set-default/remove actions.
