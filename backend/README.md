# Marketly backend

The backend structure from [docs/02-backend-architecture.md](../docs/02-backend-architecture.md), generated from the API design in [docs/api/spec](../docs/api/spec). The kernel works end to end: routing, token verification and authorization middleware on every request, validation, paging, idempotency, events, jobs, migrations, OpenAPI and GraphQL. All 33 modules are built on their specs: every one of the 1,294 endpoints has a handler (`npm run modules`). The 30 launch modules are on; wallet, wishlist (phase 3) and fulfillment-service (phase 4) are built and off at launch (`src/modules.config.ts`).

```bash
npm install
npm run dev            # http://localhost:4000 · API reference at /docs · embedded MongoDB (in memory)
npm run token -- staff # a development token (visitor | customer | seller | staff); every request needs one
npm run check          # spec freshness, types, module boundaries, API conformance, tests, every endpoint over HTTP
```

Node 22+ (tested on 26). With no `MONGODB_URI`, the server starts an embedded MongoDB replica set (an installed MongoDB 6.0 is used when there is one; otherwise the first run downloads it). Set `MONGO_DATA_DIR` to keep data between restarts, or `MONGODB_URI` for a MongoDB server (a replica set: transactions need one; [docs/04-mongodb-migration.md](../docs/04-mongodb-migration.md) §5). Configuration is below and in [.env.example](.env.example). How to write module code: [docs/BUILDING-MODULES.md](docs/BUILDING-MODULES.md).

## How the code stays on the API plan

The spec is the source of truth. `npm run gen` turns it into code, and the checks fail when code and spec drift apart.

| Spec (docs/api/spec) | Becomes | Enforced by |
|---|---|---|
| `types` | TypeScript interfaces + Zod schemas in `src/spec/<module>.ts` | Request validation; response validation outside production |
| `endpoints` | Routes at `/api/<area>/<module><path>` with params, query, paging, body, response, status, auth, permission, idempotency, launch phase | Compiler: one typed handler per endpoint. `npm run check:api`: the server's OpenAPI equals `docs/api/openapi.json` |
| `tables` | One MongoDB collection per table (`<module>.<table>`): the Mongoose schema in the module's `schema.ts`, the database validator and indexes in `spec.collections`, and the row types | Applied at startup (`MIGRATE_ON_START`) or by `npm run migrate`; module tests compare the collections, validators and indexes with the spec |
| `events` | Typed event map, payload schemas | A module can publish only its own events and subscribe only to the ones it consumes |
| `publicApi` | `<Module>PublicApi` interface the service implements | `ctx.use()` only for `dependsOn`, `ctx.tryUse()` only for `optionalDeps`, only declared functions |
| `stateMachines` | `domain/state-machines.ts` | Illegal moves throw `ILLEGAL_TRANSITION` (409) |
| `dependsOn` | Load order | The server refuses to start when a dependency is off, and names it |
| `jobs`, `settings`, `permissions`, `errorCodes` | Scheduler entries, typed `ctx.settings.get()`, guard checks, error statuses | Undeclared names are refused at startup |
| GraphQL fragments and screen queries | `/graphql/store`, `/graphql/seller`, `/graphql/admin`, persisted queries | Composed from enabled modules at startup; unusable screen queries are reported |

Run `npm run gen` after changing the spec (and `node docs/api/tools/build.mjs` first). Generated files start with a `GENERATED` header: `src/spec/**`, `src/modules/index.ts`, and each module's `README.md`, `graphql/schema.ts` and `schema.ts`. Everything else belongs to you; the generator creates it once and never overwrites it.

## Layout

```
src/
  main.ts  app.ts          start the server and the internal health port · buildApp(): kernel + enabled modules
  modules.config.ts        which modules run (phase 3–4 modules are off at launch)
  spec/                    GENERATED from docs/api/spec: types, endpoints, events, collections, row types, public APIs
  kernel/                  shared plumbing, no business rules
    auth/                  middleware (docs/03-auth-middleware.md): EdDSA tokens, revocations, caller checks, step-up, scope, masking, rate limits, file links, dev tokens
    http/                  route registration, typed handlers, idempotency, CORS and security headers, webhooks, file serving, health, OpenAPI, error format
    graphql/               per-area schema composition, @source/@auth/@phase, cost limits, Mercurius
    module-system/         defineModule, typed ctx, loader (dependency rules), boot (wiring checks)
    config/ errors/        environment (below) · error codes and statuses
    mongo/                 MongoDB: connection, transactions, tables (row ↔ document), locks, inbox, schema setup and migrations, kernel collections
    events/ jobs/          typed in-process bus · scheduler for the spec's schedule phrases (a MongoDB queue or in process)
    lib/                   money, ids (UUIDv7), refs (MK-YYMMDD-NNNNN), pagination, state machines, clock, secrets
  modules/<module>/        one folder per business capability (below)
  integration/             whole flows across real modules (order lifecycle, Fulfilled by Marketly, aftercare …)
  testing/                 buildTestApp(), dev-token callers, clocks, flows (real end-to-end setup), the module contract suite
tools/                     generate, check-api, check-boundaries, modules, migrate, module:new, token, test-http, bootstrap-owner
```

Inside a module:

```
module.ts            manifest: spec, version, Mongoose schemas, wiring (routes, consumers, jobs, resolvers)
contract.ts          the only file other modules may import
service.ts           use cases; implements the public API, event consumers and jobs
ports.ts             repository interface (database-agnostic) and provider ports
repository.ts        the MongoDB repository on ctx.mongo
schema.ts            GENERATED Mongoose schemas, one per spec table
providers/           provider adapters behind ports, with a deterministic dev adapter
http/<area>.ts       one handler per spec endpoint of that area
graphql/             schema.ts (generated fragment) + resolvers.ts
domain/              state machines and pure rules
permissions.ts       the module's permission keys
README.md            GENERATED: the module's API reference
<module>.test.ts     the module booted with its dependencies, held to its spec (contract suite)
test/                behaviour tests; helpers.ts boots the module for them
```

## Building a module

Every module is built. A new module starts from its spec (`npm run module:new <name>` scaffolds handlers that answer `501 NOT_IMPLEMENTED`); the full conventions are in [docs/BUILDING-MODULES.md](docs/BUILDING-MODULES.md).

1. Read its `README.md` (the API reference for that module).
2. Write the repository in `ports.ts` and `repository.ts`, using `ctx.mongo` (the module's own collections, `ctx.mongo.table(name)`).
3. Implement the public API, consumers and jobs in `service.ts`. Talk to other modules only through `ctx.use()` / `ctx.tryUse()` and events.
4. Replace the `notImplemented` handlers in `http/<area>.ts`. Inputs and outputs are typed from the spec:

   ```ts
   getWishlist: async ({ query, principal }) => service.wishlistPage(principal.accountId!, query),
   ```
5. Add behaviour tests next to the module's contract test. `npm run modules` shows how many endpoints each module has built.

`npm run modules` prints the load order (dependencies first). Identity issues real sessions (`src/testing/flows.ts` shows the whole sign-in path). For quick manual calls, `npm run token` gives a development token: every endpoint needs one (`curl -H "Authorization: Bearer $(npm run -s token -- visitor)" …`).

## Commands

| Command | Does |
|---|---|
| `npm run dev` / `npm start` | Development server with reload / built server (`npm run build` first: `tsc -p tsconfig.build.json` into `dist/`). Both read `.env` when it exists |
| `npm run check` | Everything CI runs, in order: `gen:check`, `typecheck`, `check:boundaries`, `check:api`, `test`, `test:http` |
| `npm test` / `npm run test:watch` | Kernel tests, every module's contract and behaviour tests, and the flows in `src/integration` (Vitest, one in-memory MongoDB replica set) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run gen` / `npm run gen:check` | Spec → code / fail when the generated code is not up to date (CI) |
| `npm run check:api` | Boots all 33 modules and compares the server's OpenAPI with `docs/api/openapi.json`, field by field (`--verbose`) |
| `npm run check:boundaries` | Modules import only kernel, spec and other modules' `contract.ts` |
| `npm run bootstrap-owner -- --email … --name "…" [--deputy-email … --deputy-name "…"]` | Invites the first Business Owner (also Platform Administrator) and, recommended, a deputy with the same roles, on a persistent database (`MONGODB_URI` or `MONGO_DATA_DIR`), and prints the accept links. Refuses once a Business Owner exists or is invited |
| `npm run test:http` | Boots all 33 modules on a real port and calls every endpoint over HTTP with input generated from the spec: no token, invalid token, another app's token, wrong caller, missing permission, missing step-up, right token. `-- --only a,b` limits it to modules; `-- --url http://localhost:4000` tests a running dev server (`RATE_LIMITS=false`); report in `.data/test-http-report.json` |
| `npm run modules` | Phase, on/off, version, endpoints built, dependencies, load order; `--graph` (Mermaid), `--without <m>` |
| `npm run module:new <name>` | Scaffold a module from a new spec file |
| `npm run migrate` | Apply the MongoDB schema to `MONGODB_URI` (read from `.env` when it exists): kernel and module collections, validators and indexes, then pending data migrations. In the URI, percent-encode special characters in the password (`@` → `%40`, `#` → `%23`, `!` → `%21`) and don't quote it |
| `npm run token -- <visitor\|customer\|seller\|staff>` | Development token, valid 12 h (`--permissions a,b`, `--seller <id>`, `--account <id>`, `--audience store\|seller\|admin`) |

## Configuration

Environment variables, read and checked at startup by `src/kernel/config/index.ts` (an invalid value stops the server). Every one has a working default for local development; [.env.example](.env.example) lists them with comments. The search engine's own variables (`SEARCH_ENGINE`, `OPENSEARCH_*`) are read by the search module (`src/modules/search/engine-config.ts`; [docs/02 §9](../docs/02-backend-architecture.md#9-search-engine-opensearch)).

| Variable | Default | Production |
|---|---|---|
| `NODE_ENV` | `development` (`development`, `test`, `production`) | `production` |
| `HOST` / `PORT` / `HEALTH_PORT` | `127.0.0.1` (`0.0.0.0` in production) / `4000` / `PORT`+1 (internal `GET /health`) | |
| `LOG_LEVEL` | `info` (always `silent` in tests) | |
| `MONGODB_URI` / `MONGO_DATA_DIR` | none: an embedded MongoDB replica set (mongodb-memory-server; an installed MongoDB is used when there is one), in memory or in `MONGO_DATA_DIR` | **required**: a MongoDB 6.0+ replica set. Every module keeps its data here, and so do the kernel's job queue, rate limits, idempotency keys, references and webhook records ([docs/04-mongodb-migration.md](../docs/04-mongodb-migration.md)) |
| `MIGRATE_ON_START` | on outside production: apply the MongoDB schema at startup | off: run `npm run migrate` |
| `LAUNCH_PHASE` | `2` (1–4): endpoints of a later phase answer 501 | |
| `MARKET_TIME_ZONE`, `MARKET_CURRENCY` | `America/Los_Angeles`, `USD` | |
| `MARKET_DEFAULT_POSTAL_CODE`, `MARKET_DEFAULT_LOCATION_LABEL` | `97205`, `Portland`: the delivery location before the shopper gives one | |
| `RESPONSE_VALIDATION` | on outside production | off by default |
| `JOBS_ENABLED` | `false`: this process only enqueues | on for the worker instances |
| `JOBS_BACKEND` | `mongo` with `MONGODB_URI`, else `inprocess` | `mongo` (the queue in `kernel.jobs`) |
| `DEPLOY_ID` | none | the image tag or commit: `on boot` jobs run once per deploy |
| `GRAPHQL_PERSISTED_ONLY` | on in production: store and seller GraphQL take persisted query ids only | |
| `AUTH_JWKS` | none (development trusts the dev key) | **required** |
| `AUTH_ISSUER` | `marketly-identity` | |
| `AUTH_SIGNING_JWK` | none: development signs with the dev key | needed to issue tokens whenever `DEV_TOKENS` is off |
| `APP_SECRET` | a fixed dev value while `DEV_TOKENS` is on | **required**, at least 32 characters (also required on a non-loopback `HOST` without `DEV_TOKENS`) |
| `STORE_URL`, `SELLER_URL`, `ADMIN_URL` | `http://localhost:3000`, `:3001`, `:3002` | **required** |
| `API_URL` | `http://localhost:PORT` | **required** |
| `MEDIA_STORAGE` / `MEDIA_STORAGE_DIR` | `local` (`memory` in tests) / `.data/media` | `memory` refused |
| `WEBHOOK_SECRETS` | `dev-webhook-secret` for every provider while `DEV_TOKENS` is on | one secret per provider |
| `REVOCATION_POLL_MS` | `3000` (at least 500) | |
| `DEV_TOKENS` / `DEV_SIGNING_KEY_FILE` | on outside production / `.data/dev-signing-key.json` | refused. With it on, startup also refuses a non-loopback `HOST` and a non-local `MONGODB_URI` |
| `RATE_LIMITS` | `true` | `false` refused |
| `RATE_LIMIT_STORE` | `mongo` with `MONGODB_URI`, else `memory` | `mongo` |
| `TRUST_PROXY` | none: a hop count, `true`, or addresses/CIDRs | set behind a load balancer |
| `CORS_STORE_ORIGINS`, `CORS_SELLER_ORIGINS`, `CORS_ADMIN_ORIGINS` | none: no browser origin is allowed | the apps' origins |
| `DOCS_ENABLED` | on with `NODE_ENV=development` only | refused (`/docs` is served without a token) |
| `TURNSTILE_SECRET` | none | the website's app proof |
| `MODULES` | none: `src/modules.config.ts` | |

## Open points in the design

Found while building; the code follows the spec as written until these are decided.

- **Screen queries that need a module that is off at launch.** HomePage, ProductPage, CategoryPage, SearchResults, SellerStorefront and AccountOverview select `Product.saved` (wishlist), and AccountOverview / AdminCustomer select `Customer.wallet` / `walletAdmin` (wallet). Both modules are phase 3 and off at launch, so these 7 persisted queries don't validate in the launch configuration (the server warns at startup). Either remove those fields from the launch queries, or keep phase 3 fragments in the schema with `@phase` fields resolving to null.
- **Type used but never defined:** `identity.AccountSecurity` (identity public API `accountSecurityOf`). It is typed `unknown` until the spec defines it (`npm run gen` lists it).
- **`catalog.brand_stats`** declares `category_id` nullable ("null = all categories") inside its primary key. The key is a unique index on (brand_id, category_id) in which null counts as a value, so there is one "all categories" row per brand.
- **`customers`** lists `orders.order.placed` twice under `consumes`. The two reactions share one handler.
