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

Same sessions and headers as REST (`Authorization`, `X-Guest-Session`). A type or field appears in a schema only if its `@areas` includes that area, so the seller schema cannot even describe admin data.

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
| Limits | Max depth 9; query cost limit from `@cost` weights (lists default 10); max page size 100; timeouts per request |
| Persisted queries | Production apps send the **query id** from `manifest.json`, never free text (the store and seller endpoints only accept known queries in production). Staff tools may send ad-hoc queries in admin |
| Caching | Public store queries (`HomePage`, `ProductPage`, `CategoryPage` without a session) can be sent as `GET` with the persisted id, so a CDN can cache them for a short time |
| Errors | GraphQL `errors[].extensions.code` uses the REST error codes (`NOT_FOUND`, `FORBIDDEN` …); partial data is allowed, e.g. reviews failing doesn't blank the product page |
| Paging | Same as REST: `paging: { cursor | page, limit }` → `{ items, nextCursor, page, totalPages, total }` |
| Clients | Website: GraphQL Code Generator types + TanStack Query. Android: Apollo Kotlin with generated models from the same schema and persisted queries |

## Validation

`node docs/api/tools/graphql.mjs` checks:
- fragment syntax and ownership (no type defined twice);
- `@source` points to the fragment's own module and to a function in its REST `publicApi`;
- every `@auth` permission exists;
- each composed schema is valid;
- every screen query validates against its area's schema and stays within the depth limit.

It also writes the per-area schemas, the persisted query manifests and the viewer data.
