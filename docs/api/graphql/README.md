# GraphQL read layer

Marketly uses **REST for everything** and adds **GraphQL for reading screens whose data is complex**: the product page, order detail, dashboards and the 360° admin views. One GraphQL query replaces the 5–12 REST calls those screens would otherwise need, which matters most on the Android app over mobile networks.

## When to use which

| Use | Choose | Why |
|---|---|---|
| A screen that combines data from several modules (product + offers + delivery + reviews; order + packages + shipments + returns + refunds) | **GraphQL** query | One round trip; the client asks for exactly the fields the screen shows |
| Anything that changes data (place order, request return, approve payout, edit product) | **REST** | Idempotency keys, approvals, audit and status machines are designed there; one way to write |
| Simple lists and single records (addresses, notifications list, settings forms) | REST (GraphQL also available where a module exposes it) | No benefit from composition |
| Provider callbacks, file uploads, ad serving (records impressions), exports | **REST** | Side effects or binary transfer |

**No mutations and no subscriptions.** Push updates reach the apps through notifications.

## Three schemas

| Endpoint | Schema | Who |
|---|---|---|
| `POST /graphql/store` | `schema.store.graphql` | Customers and guests (website + Android app) |
| `POST /graphql/seller` | `schema.seller.graphql` | Seller members (Seller Center); every field is limited to the caller's own seller account |
| `POST /graphql/admin` | `schema.admin.graphql` | Staff (Admin Center + Operations); permissioned fields check role permissions |

Each endpoint also answers `GET` with the request in the query string (`query` or `persisted`/`extensions`, `variables` and `extensions` as JSON), for clients that send hashed queries by GET (Apollo Kotlin does by default). Only queries run; there is nothing else.

Same tokens and headers as REST: every request carries `Authorization: Bearer` (a visitor token before sign-in), and the same middleware runs first (token, audience, caller kind, seller context, staff 2-step). A type or field appears in a schema only if its `@areas` includes that area, so the seller schema cannot even describe admin data.

**Not cacheable by a CDN.** Every `/graphql/*` response, `GET` included, is `Cache-Control: private, no-store`: it is token-gated and may differ per caller (prices for the shopper's location, masked fields, permissions). Public reads are cached inside the server instead.

## Modular schema (fits add / remove modules)

```
docs/api/graphql/
  base.graphql                 scalars, Money/Address/…, PageInput, Paged, directives
  modules/<module>.graphql     one fragment per module
  schema.<area>.graphql        generated, composed per area
  operations/<area>/*.graphql  one persisted query per complex screen
  operations/<area>/manifest.json   persisted query ids (sha256)
```

- **Each module defines only its own types** (`Order` belongs to orders, `Product` to catalog).
- **The module that owns the data resolves the field**, even when the field hangs on another module's type. For example, `returns` adds `Order.returns`; `offers` adds `Product.offers`.
- Every such field names its resolver: `@source(module: "returns", fn: "listByOrder")`. `fn` is a function in that module's public API (`publicApi` in its REST spec).
- **Removing a module removes its fragment.** Its fields disappear from the composed schemas. Queries that used them fail validation at build time, never silently at runtime.

## Implementation notes (for the build phase)

| Concern | Design |
|---|---|
| Server | **Mercurius** (Fastify's GraphQL plugin), one instance per area, composed at startup from enabled modules' fragments and resolvers |
| N+1 queries | Every `@source` resolver is batched per request (DataLoader / Mercurius loaders), e.g. one call for all `OrderGroup.shipments` in an order |
| Limits | See [Limits](#limits): depth 9, cost 1,500, page size 100, 10 s per request |
| Persisted queries | Production apps send the **query id** from `manifest.json`, never free text (the store and seller endpoints only accept known queries in production). Staff tools may send ad-hoc queries in admin. Both request formats below are accepted |
| Caching | None outside the server: responses are private, no-store and token-gated (see above) |
| Errors | See [Errors](#errors): `errors[].extensions.code` uses the REST error codes; partial data is allowed, e.g. reviews failing doesn't blank the product page |
| Field access | `@auth(requires, permission)` on a field or type, checked per field: a refusal nulls that field and adds a `FORBIDDEN` error (see [Errors](#errors)); the rest of the query still answers. Every admin root field must carry `@auth` or the server does not start |
| Actors | REST `Actor.kind` → GraphQL `ActorKind`, one mapping for every module: `customer` → CUSTOMER, `visitor` and `anonymous` → GUEST, `seller` → SELLER, `staff` → STAFF, `provider` and `system` → SYSTEM |
| Sensitive fields | `@sensitive(permission, mask)` mirrors a REST spec type field with `permission` and `mask`; in the seller and admin areas the server masks it unless the caller holds the permission (same masks as REST), in one central step |
| Paging | Same as REST: `paging: { cursor | page, limit }` → `{ items, nextCursor, page, totalPages, total }` |
| Clients | Website: GraphQL Code Generator types + TanStack Query. Android: Apollo Kotlin with generated models from the same schema and persisted queries (the manifest id as the hash) |

## Persisted query formats

The id is the sha256 in `operations/<area>/manifest.json` (of the normalized query text). Either format works, by `POST` or `GET`:

| Format | Request |
|---|---|
| Mercurius | `{ "persisted": true, "query": "<id>", "variables": {…} }` |
| Apollo (automatic persisted queries, Apollo Kotlin) | `{ "extensions": { "persistedQuery": { "version": 1, "sha256Hash": "<id>" } }, "variables": {…} }` |

- An unknown id answers HTTP 400, message `PersistedQueryNotFound`, code `PERSISTED_QUERY_NOT_FOUND` (the message Apollo clients look for).
- Where only persisted queries are accepted (store and seller in production, `GRAPHQL_PERSISTED_ONLY`), free query text answers 400 `PersistedQueryNotSupported`, code `PERSISTED_QUERY_NOT_SUPPORTED`. An Apollo retry that adds the query text to a known id runs the manifest's text, never the client's.
- Elsewhere (development, tests, the admin endpoint) plain `{ "query": "…" }` also runs.

## Limits

| Limit | Value | When exceeded |
|---|---|---|
| Depth | 9 levels of selection (fragment spreads don't add a level) | Refused before anything runs: HTTP 400, `QUERY_TOO_COMPLEX` |
| Cost | 1,500. Each selected field costs its `@cost(weight)`, else 10 for a field returning a list and 1 for any other (`__typename` is free); the cost is the sum over every selected field, counting each alias and each fragment spread. The biggest screen query costs about 700 | Refused before anything runs: HTTP 400, `QUERY_TOO_COMPLEX`, `details: { cost, limit }` |
| Page size | `paging.limit` (PageInput) and every `limit` / `…Limit` Int argument are clamped to 1–100 (absent = the field's default, usually 24) | Clamped, not refused |
| Time | 10 s per request | Fields still running answer `QUERY_TIMEOUT` (`details: { timeoutMs }`) with null data; fields already resolved stay. HTTP 200 with partial data, 503 when no data is left |

`node docs/api/tools/graphql.mjs` checks the depth and cost of every screen query against these limits.

## Errors

GraphQL answers `{ data, errors }`; every error carries `extensions.code` (and `extensions.details` where REST would put `error.details`).

| Code | HTTP status | When |
|---|---|---|
| `UNAUTHORIZED` | 401 | Before GraphQL runs: token missing, invalid or expired (`details.reason: token_*`, the only case where a client refreshes), a session of the wrong kind for the endpoint (`sign_in_required`, `seller_context_required`), or an idle staff session (`session_idle`: sign in again) |
| `WRONG_AUDIENCE`, `NO_SELLER_ACCESS`, `STEP_UP_REQUIRED` … | 403 | Before GraphQL runs: the same caller checks and codes as REST for the area (another app's token, no longer a member of the seller, staff without 2-step …) |
| `UPGRADE_REQUIRED`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE` | 426, 429, 503 | Before GraphQL runs, as in REST: an outdated Android app, too many requests (`Retry-After`), staff sessions or revocations that can't be checked |
| `VALIDATION_FAILED` | 400 | Syntax error, unknown field, wrong variable type, a mutation |
| `QUERY_TOO_COMPLEX` | 400 | Above the depth or cost limit |
| `PERSISTED_QUERY_NOT_FOUND`, `PERSISTED_QUERY_NOT_SUPPORTED` | 400 | See above |
| `FORBIDDEN` (field) | 200, partial | A field the caller may not read: `details: { permission }` for a missing permission, `details: { reason: 'sign_in_required', requires }` when a guest asks for a signed-in customer's field, `{ reason: 'wrong_caller', requires }` for any other caller kind. Never `UNAUTHORIZED`: the token is fine, so clients must not refresh it |
| `QUERY_TIMEOUT` | 200, partial (503 if no data) | Over the time budget |
| `NOT_IMPLEMENTED` | 200, partial | Field designed but not built yet |
| module codes (`NOT_FOUND` …) | 200, partial | A resolver's own error, as in REST |
| `INTERNAL_ERROR` | 200 | Anything unexpected (message hidden in production) |

The HTTP status is 200 whenever some data came back; when nothing did and there is a single error, it is that error's REST status.

## Validation

`node docs/api/tools/graphql.mjs` checks:
- fragment syntax and ownership (no type defined twice);
- `@source` points to the fragment's own module and to a function in its REST `publicApi`;
- every `@auth` permission exists;
- every `@sensitive(permission, mask)` mirrors a sensitive field of the module's REST spec types (same field name, permission and mask), and every such spec field is marked `@sensitive` on at least one GraphQL field;
- each composed schema is valid;
- every screen query validates against its area's schema and stays within the depth and cost limits.

It also writes the per-area schemas, the persisted query manifests and the viewer data.

At startup the server also refuses an admin root field without `@auth`. There is no `@scope` directive: record scope comes from the area (the seller schema's resolvers read the caller's own seller account, the store's the caller's own customer or guest session) and from the scoped loaders the resolvers share with REST.
