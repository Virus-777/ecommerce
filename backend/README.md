# Marketly backend

The backend structure from [docs/02-backend-architecture.md](../docs/02-backend-architecture.md), generated from the API design in [docs/api/spec](../docs/api/spec). The kernel works end to end: routing, validation, auth guard, paging, idempotency, events, jobs, migrations, OpenAPI and GraphQL. The 33 modules are wired to their specs, but their business logic is not built yet: every endpoint answers `501 NOT_IMPLEMENTED` until its handler is written.

```bash
npm install
npm run dev            # http://localhost:4000 · API reference at /docs · in-memory PostgreSQL (PGlite)
npm run token -- staff # a development token (customer | seller | staff) to call any area before identity is built
npm run check          # spec freshness, types, module boundaries, API conformance, tests
```

Node 22+ (tested on 26). With no `DATABASE_URL`, the server runs PGlite in-process. Set `PGLITE_DIR` to keep data between restarts, or `DATABASE_URL` for a PostgreSQL server. See [.env.example](.env.example).

## How the code stays on the API plan

The spec is the source of truth. `npm run gen` turns it into code, and the checks fail when code and spec drift apart.

| Spec (docs/api/spec) | Becomes | Enforced by |
|---|---|---|
| `types` | TypeScript interfaces + Zod schemas in `src/spec/<module>.ts` | Request validation; response validation outside production |
| `endpoints` | Routes at `/api/<area>/<module><path>` with params, query, paging, body, response, status, auth, permission, idempotency, launch phase | Compiler: one typed handler per endpoint. `npm run check:api`: the server's OpenAPI equals `docs/api/openapi.json` |
| `tables` | `infra/postgres/migrations/0001_init.ts` + Kysely row types | Module tests compare the migrated columns with the spec |
| `events` | Typed event map, payload schemas | A module can publish only its own events and subscribe only to the ones it consumes |
| `publicApi` | `<Module>PublicApi` interface the service implements | `ctx.use()` only for `dependsOn`, `ctx.tryUse()` only for `optionalDeps`, only declared functions |
| `stateMachines` | `domain/state-machines.ts` | Illegal moves throw `ILLEGAL_TRANSITION` (409) |
| `dependsOn` | Load order | The server refuses to start when a dependency is off, and names it |
| `jobs`, `settings`, `permissions`, `errorCodes` | Scheduler entries, typed `ctx.settings.get()`, guard checks, error statuses | Undeclared names are refused at startup |
| GraphQL fragments and screen queries | `/graphql/store`, `/graphql/seller`, `/graphql/admin`, persisted queries | Composed from enabled modules at startup; unusable screen queries are reported |

Run `npm run gen` after changing the spec (and `node docs/api/tools/build.mjs` first). Generated files start with `// GENERATED`: `src/spec/**`, `src/modules/index.ts`, and each module's `README.md` and `graphql/schema.ts`. Everything else belongs to you; the generator creates it once and never overwrites it.

## Layout

```
src/
  main.ts  app.ts          start the server · buildApp(): kernel + enabled modules
  modules.config.ts        which modules run (phase 3–4 modules are off at launch)
  spec/                    GENERATED from docs/api/spec: types, endpoints, events, tables, public APIs
  kernel/                  shared plumbing, no business rules
    auth/                  guard: identity.authenticate, access.hasPermission, sellers.getMemberAccess; dev tokens
    http/                  route registration, typed handlers, idempotency, OpenAPI, error format
    graphql/               per-area schema composition, @source/@auth/@phase, Mercurius
    module-system/         defineModule, typed ctx, loader (dependency rules), boot (wiring checks)
    db/ migrations/        Kysely on PostgreSQL or PGlite · one schema per module
    events/ jobs/          typed in-process bus · scheduler for the spec's schedule phrases
    lib/                   money, ids (UUIDv7), refs (MK-YYMMDD-NNNNN), pagination, state machines, clock
  modules/<module>/        one folder per business capability (below)
  testing/                 buildTestApp(), dev-token callers, the module contract suite
tools/                     generate, check-api, check-boundaries, modules, migrate, module:new, token
```

Inside a module:

```
module.ts            manifest: spec, version, migrations, wiring (routes, consumers, jobs, resolvers)
contract.ts          the only file other modules may import
service.ts           use cases; implements the public API; event consumers and jobs (stubs for now)
ports.ts             repository interface (database-agnostic)
infra/postgres/      repository adapter + migrations
http/<area>.ts       one handler per spec endpoint of that area (placeholders: notImplemented)
graphql/             schema.ts (generated fragment) + resolvers.ts
domain/              state machines and pure rules
<module>.test.ts     the module booted with its dependencies, held to its spec
```

## Building a module

1. Read its `README.md` (the API reference for that module).
2. Write the repository in `ports.ts` and `infra/postgres/repository.ts`, using `ctx.db` (already scoped to the module's schema).
3. Implement the public API, consumers and jobs in `service.ts`. Talk to other modules only through `ctx.use()` / `ctx.tryUse()` and events.
4. Replace `notImplemented` handlers in `http/<area>.ts`. Inputs and outputs are typed from the spec:

   ```ts
   getWishlist: async ({ query, principal }) => service.wishlistPage(principal.accountId!, query),
   ```
5. Add behaviour tests next to the module's contract test. `npm run modules` shows how many endpoints each module has built.

Build in dependency order: identity → access → audit → settings → … (`npm run modules` prints the order). Until identity, access and sellers are built, use `npm run token` to call guarded endpoints.

## Commands

| Command | Does |
|---|---|
| `npm run dev` / `npm start` | Development server with reload / built server (`npm run build` first) |
| `npm test` | Kernel tests + every module's contract test (in-memory PostgreSQL) |
| `npm run gen` | Spec → code (`--check` in CI) |
| `npm run check:api` | Boots all 33 modules and compares the server's OpenAPI with `docs/api/openapi.json`, field by field |
| `npm run check:boundaries` | Modules import only kernel, spec and other modules' `contract.ts` |
| `npm run modules` | Phase, on/off, endpoints built, dependencies; `--graph` (Mermaid), `--without <m>` |
| `npm run module:new <name>` | Scaffold a module from a new spec file |
| `npm run migrate` | Apply migrations to `DATABASE_URL` or `PGLITE_DIR` |
| `npm run token -- <customer\|seller\|staff>` | Development token (`--permissions a,b`, `--seller <id>`) |

## Open points in the design

Found while building; the code follows the spec as written until these are decided.

- **Screen queries that need a module that is off at launch.** HomePage, ProductPage, CategoryPage, SearchResults, SellerStorefront and AccountOverview select `Product.saved` (wishlist), and AccountOverview / AdminCustomer select `Customer.wallet` / `walletAdmin` (wallet). Both modules are phase 3 and off at launch, so these 7 persisted queries don't validate in the launch configuration (the server warns at startup). Either remove those fields from the launch queries, or keep phase 3 fragments in the schema with `@phase` fields resolving to null.
- **Types used but never defined:** `search.SearchQuery`, `SearchMatch`, `SponsoredSlot`, `PageInfo` (search public API) and `identity.AccountSecurity`. They are typed `unknown` until the spec defines them (`npm run gen` lists them).
- **`catalog.brand_stats`** declares `category_id` nullable ("null = all categories") inside its primary key. PostgreSQL forbids that, so the table uses `unique nulls not distinct (brand_id, category_id)` instead.
- **`customers`** lists `orders.order.placed` twice under `consumes`. The two reactions share one handler.
