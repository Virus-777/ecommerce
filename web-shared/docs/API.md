# Wiring screens to the API

The web apps talk to the backend (`backend/`, API docs in `docs/api/`) through `@marketly/web-shared/api`. Read this before wiring a screen, together with `PORTING.md` (markup and design rules still apply) and `API-INTEGRATION-BRIEF.md` (the per-screen map: which endpoint or screen query feeds which part of each store screen, auth kinds, gaps).

## Running it

```
# backend (separate checkout, e.g. E:/Work/Ecommerce-api/backend): MONGO_DATA_DIR, JOBS_ENABLED=true, RATE_LIMITS=false
npm run dev                                   # http://127.0.0.1:4000 (sample data: npm run simulate in the backend)
# web (this repo)
npm run dev:store | dev:seller | dev:admin    # the dev servers proxy /api, /graphql, /files to :4000 (MARKETLY_API_URL)
npm run gen:api -- <backend docs/api dir>     # after the API changes: regenerates src/api/openapi.d.ts + GraphQL operations
```

## The client

```tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { call, useApi, errorMessage, newIdempotencyKey, ApiError } from '@marketly/web-shared/api';

const { api, gql } = useApi();
const cart = useQuery({ queryKey: ['cart'], queryFn: () => call(api.GET('/api/store/cart/cart')) });
```

- `api` is a typed `openapi-fetch` client: paths, params, bodies and responses are checked against `docs/api/openapi.json` (generated `openapi.d.ts`). `call()` returns the data or throws an `ApiError` (`status`, `code`, `message`, `details`, `requestId`, `fieldErrors`).
- Every request carries the app session's bearer token; a 401 with a `token_*` reason refreshes once and retries. Don't add `Authorization` yourself.
- `gql(query, variables)` runs a GraphQL screen query on the app's endpoint and returns `{ data, errors }` (partial data allowed).
- The store's `useSession()` (`frontend/src/app/session.tsx`) gives `signedIn`, `customer`, `cartCount`, `unreadNotifications`, `adopt(tokens)` (after sign-in/registration), `signOut()`, `refreshCart()`.

## Rules

1. **Reads are `useQuery`, writes are `useMutation`.** Query keys start with the module: `['catalog', 'product', id]`, `['cart']`, `['orders', 'list', params]`. After a write, invalidate what changed (`qc.invalidateQueries({ queryKey: ['cart'] })`) or set the returned data. Cart changes also call `refreshCart()` (header badge).
2. **Remove the sample data** when a screen is wired: the screen shows only API data (no mock fallback). Shared fixtures in `web-shared/src/data/` stay until no screen uses them.
3. **Keep the design.** Same markup and classes as before (`PORTING.md`); map API fields onto the existing components. Where the API has no data for a design element, follow the gap rule (rule 10).
4. **Loading, empty and error states.** While loading, render the page frame with skeletons (`sk`, `sk-line`, `sk-card`, `sk-row` classes from the design) instead of a blank page. Empty lists use the design's empty states. A failed read shows an `Alert tone="danger"` with `errorMessage(e)` and a Try again button (`refetch`). 404 on a detail page shows the not-found state.
5. **Errors on writes.** Show `errorMessage(e)` next to the action. For `VALIDATION_FAILED`, map `e.fieldErrors` onto `Field error`. Known codes from the module docs get specific copy (e.g. `INVALID_CREDENTIALS`, `COUPON_NOT_ELIGIBLE`).
6. **Idempotency.** Endpoints marked idempotent (place order, payments, refunds, returns, cancellations) need `Idempotency-Key`: create it once per user action with `newIdempotencyKey()` (e.g. in a ref when the form opens) and reuse it on retries: `api.POST(path, { body, params: { header: { 'Idempotency-Key': key } } })`.
7. **Money** is integer minor units: `{ amount: 18900, currency: 'USD' }`. Format with `formatMoney()` / compute with `dollars()` from `@marketly/web-shared/lib/format`.
8. **Ids and routes.** Links use `href(id, view, params)`. Product routes carry the id (`/p/:slug/:id`); order, return and case routes carry the human ref (`MK-…`, `RT-…`, `CS-…`): resolve it with the GraphQL `order(ref)` / `return(ref)` / `case(ref)` screen queries, which return the id for REST calls.
9. **Paging.** Website lists use `page` with the `Pager` component (`total`, `totalPages` from the response); the phone layout uses `cursor` with "Load more" (`useInfiniteQuery`, `nextCursor`). Never send both. `limit` 1–100.
10. **Gaps.** When the API doesn't provide something the design shows, degrade gracefully (hide it, or show it disabled with a short explanation) and add a row to `docs/BACKEND-REQUESTS.md`. Never edit `backend/`.
11. **Views still apply.** `?view=` keeps opening dialogs, tabs and steps. Views that showed a server state (e.g. payment failed, delivery failed) now follow the real data; keep the URL view only where it is UI state.
12. **GraphQL screen queries** live in `web-shared/src/api/graphql/<area>/*.graphql` (copied from the backend docs). Import the text with `?raw`. The persisted queries that select `Product.saved` (wishlist) or `Customer.wallet` (wallet) fail while those modules are off: send the query text without those fields (gap G2). Type the result with a local interface for the fields you use.

## Checking a wired screen

- `npx tsc -p <app>` clean for your files.
- With the backend running and seeded, open the screen in the dev server and check the data, the empty state (e.g. a new customer) and an error path. Without a browser, call the same endpoints with a token from the app's flow to confirm the response shape.
