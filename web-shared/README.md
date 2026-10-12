# Marketly web apps

Three React 19 + Vite + TypeScript + react-router apps, one per audience of the backend (each has its own token audience, refresh cookie and CORS origin), plus the code they share. They are npm workspaces of the repository root; the backend in `backend/` is a separate project.

| Project | App | Dev URL | Backend audience |
|---|---|---|---|
| [`frontend/`](../frontend) (`@marketly/store`) | Customer Store: shopping, checkout, account, help, policies, selling sign-up. Its phone layout is the Android app layout | http://127.0.0.1:3000 | `store` (`STORE_URL`) |
| [`seller-center/`](../seller-center) (`@marketly/seller-center`) | Seller Center for seller owners and seller staff | http://127.0.0.1:3001 | `seller` (`SELLER_URL`) |
| [`admin-center/`](../admin-center) (`@marketly/admin-center`) | Admin Center and the Operations Center (`/ops`) for internal staff | http://127.0.0.1:3002 | `admin` (`ADMIN_URL`) |
| `web-shared/` (`@marketly/web-shared`) | Design stylesheet, UI components, icons, back-office layout, screen catalogue and links between apps, sample data, Vite config, design tooling | | |

The API is not wired yet: pages run on sample data and local state.

```
npm install                 # at the repository root (installs all four workspaces)
npm run dev:store           # :3000
npm run dev:seller          # :3001
npm run dev:admin           # :3002
npm run typecheck           # every workspace
npm run build               # the three apps → <app>/dist
npm run gen:icons           # regenerate web-shared/src/ui/icons.generated.ts (names in web-shared/tools/icons.*.txt)
npm run design:extract -- design/marketly-ui-final-complete.zip   # unpack the design for /design/check
```

The dev servers bind 127.0.0.1 (Chrome on this machine can't reach Vite's default `[::1]` bind). Ports match the backend's default `STORE_URL`, `SELLER_URL` and `ADMIN_URL`.

## Shared package

```
web-shared/
  src/styles/marketly.css   the design export's stylesheet, verbatim; app.css: small React-only additions
  src/ui/                   components mirroring the design helpers (Button, Badge, Card, Field, Dialog, charts…)
  src/layouts/              BackOfficeLayout (Seller Center, Admin Center, Operations) and Logo
  src/routes/               catalogue (all 122 screens: id, app, route, design file, views), href(), app router factory,
                            /design index, /design/check, back-office 404
  src/lib/                  formatting, class names, hooks (useView, useIsPhone, useCountdown, useScrollRegion…)
  src/data/                 sample data (fixtures, mock staff identities) until the API is wired
  vite.ts                   marketlyApp({ app, port, root }): the Vite config every app uses
  tools/                    icon generator, design stripper, design extractor
  docs/PORTING.md           how a design screen is ported (rules every page follows)
```

Apps import it by subpath: `@marketly/web-shared/ui`, `/layouts`, `/routes`, `/lib/<name>`, `/data/<name>`, `/config`, `/styles/<file>`. Inside the package, imports are relative. Store-only layouts (`StoreLayout`, `CheckoutLayout`, `AccountLayout`) and the mock store session live in `frontend/`.

## Links between apps

Every screen in the catalogue names its app. `href(id)` returns a relative path for a screen of the current app and an absolute URL for another app's screen (the store's "Seller Center" footer link, the back-office logo that goes to the store home, admin links to product pages). Base URLs come from `VITE_STORE_URL`, `VITE_SELLER_URL` and `VITE_ADMIN_URL` (defaults: the dev URLs above). Each app's identity is the build-time constant `__APP__`, set by `marketlyApp()`.

## Views and review

Each design state is a **view** of its screen, addressed by `?view=<slug>`: the design file `seller-orders--shipped.html` is `http://127.0.0.1:3001/orders?view=shipped`. In each app, `/design` lists its screens and views, and `/design/check` (dev server only, after `design:extract`) loads every route and view in an iframe and compares it with the matching design file: class-structure similarity, missing/extra classes, `<h1>` count, horizontal overflow and console errors.

## Next: API integration

Pages read sample data from typed arrays shaped like API rows. Wiring the backend (`backend/`, OpenAPI in `docs/api/openapi.json`) means one API client per app audience (visitor token → signed-in session, refresh cookie per app), replacing those arrays with queries per module, and replacing the mock sessions.
