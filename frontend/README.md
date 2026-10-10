# Marketly web frontend

React 19 + Vite + TypeScript + react-router. One app serves the four areas of the plan: **Customer Store**, **Seller Center**, **Admin Center** and **Operations**, plus the design-system reference pages. The phone layout (< 768 px) is the Android app layout (tab bar, app bars, lazy-loading lists, no website footer); tablet and desktop are the website.

The API is not wired yet: pages run on sample data (`src/data/fixtures.ts` and per-page data) and local state.

```
npm install
npm run dev          # http://localhost:5173  (/design lists every screen and view)
npm run build        # typecheck + production build
npm run typecheck
npm run gen:icons    # regenerate src/ui/icons.generated.ts after adding names to tools/icons.extra.txt
npm run design:extract -- ../design/marketly-ui-final-complete.zip   # unpack the design for review/porting
```

## Structure

```
src/
  main.tsx                 entry; #root is the design's .app container (its container queries drive the layout)
  styles/marketly.css      the design export's stylesheet, verbatim (tokens, components, per-screen styles)
  styles/app.css           small React-only additions
  ui/                      components mirroring the design helpers (Button, Badge, Card, Field, Dialog, charts…)
  layouts/                 StoreLayout, CheckoutLayout, AccountLayout, BackOfficeLayout (Seller/Admin/Ops)
  routes/catalogue.ts      all 122 screens: id, route, design file, views
  routes/href.ts           href(id, view?, params?) link builder
  routes/router.tsx        routes from the catalogue (lazy page chunks), /design index, 404
  pages/<area>/<Screen>.tsx  one page per screen
  data/fixtures.ts         shared sample entities
  app/session.tsx          mock session (signed-in shopper, cart count, staff identities)
  lib/                     formatting, hooks (useView, useIsPhone, useCountdown, useScrollRegion…)
docs/PORTING.md            how a design screen is ported (rules every page follows)
tools/                     icon generator, design stripper, design extractor
```

## Views

Each design state is a **view** of its screen, addressed by `?view=<slug>`: the design file `seller-orders--shipped.html` is `/seller/orders?view=shipped`. Tabs, wizard steps and dialogs set the view, so every state is linkable and the back button works.

## Reviewing against the design

- `/design` lists every screen and view.
- `/design/check` (dev server only, after `npm run design:extract`) loads every route and view in an iframe and compares it with the matching design file: class-structure similarity, missing/extra classes, `<h1>` count, horizontal overflow and console errors.

## Next: API wiring

Pages read sample data from typed arrays shaped like API rows. Wiring the backend (`backend/`, OpenAPI in `docs/api/openapi.json`) means replacing those arrays with queries per module and the mock session with the identity module (visitor token → shopper session; every endpoint requires a token).
