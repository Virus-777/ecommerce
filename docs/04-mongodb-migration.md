# Phase: MongoDB migration plan

Status: **M1 built** (kernel on MongoDB, settings and access moved); M2 next. Phases in §6.

The database requirement changed: the backend must run on MongoDB. Decisions taken (2026-10-12):

| Decision | Choice |
|---|---|
| Scope | **MongoDB only.** PostgreSQL, PGlite and pg-boss are removed. Data, the job queue, rate limits, the event inbox, idempotency keys, reference counters and the audit history all move to MongoDB |
| Data model | **Table → collection.** Each spec table becomes a collection with the same fields, UUID string ids, the same indexes and a JSON Schema validator. Business logic stays as it is |
| Deployment | **Self-hosted replica set**, **MongoDB 6.0** (6.0.29, the version run elsewhere; a single-node replica set in development). Transactions need a replica set. Product search stays on OpenSearch in production. 6.0 left MongoDB's support in July 2025: nothing here needs a newer server, so an upgrade to 7.0 or 8.0 is a deployment change only |
| Driver | **Mongoose** (8.x): one generated Mongoose schema per collection; the native driver is not a direct dependency |

Nothing has been deployed, so no data has to be moved: MongoDB starts from the schema the spec describes today. The 146 SQL migrations (many of them backfills) are not ported.

## 1. What changes and what stays

The layering was built for this: services talk only to their module's repository interface (`ports.ts`), and `module.ts` builds the repository from `ctx.db` (docs/02 §7: "infra/mongo/ added only if the database changes").

| Stays | Changes |
|---|---|
| API spec endpoints, types, events, permissions, settings, jobs | The spec's **tables** section is read as collections (same notation, §3) |
| HTTP layer, auth middleware, GraphQL, event bus, module system | Kernel database layer: MongoDB client, transactions, locking, schema setup (§2) |
| Every service's business logic (`service.ts`, `domain/`) | Each module's repository: `infra/postgres/` → `infra/mongo/` (33 modules, about 11,600 lines) |
| Tests' behaviour (7,661 tests) | Test database: PGlite → an in-memory MongoDB replica set (§5) |
| | Kernel collections: idempotency keys, inbox, refs, rate limits, webhook events, migrations, **job queue** (replaces pg-boss) |
| | Generator: document types, validators and indexes instead of SQL and Kysely row types |

## 2. Kernel database layer

**Connection and naming.** One database (`MONGODB_URI`, e.g. `mongodb://localhost:27017/marketly?replicaSet=rs0`, replacing `DATABASE_URL`). Each module's collections are named `<module>.<table>` (`catalog.products`, `orders.order_items`); `ctx.db` only reaches the module's own collections, as the PostgreSQL schema did. Kernel collections are `kernel.*`.

**Documents.** A row becomes a document with the same field names. The `id` column is stored as `_id` (UUIDv7 string) and mapped back to `id` by a shared helper, so repositories and services keep `row.id`.

| Spec type | BSON | Note |
|---|---|---|
| `uuid`, `text`, `char(n)` | string | |
| `int`, `smallint` | int32 | money in minor units stays integer |
| `bigint`, `bigserial` | int64 read as JS number | as today |
| `numeric` | Decimal128, read as string | exact, as today |
| `bool` | bool | |
| `date` | string `YYYY-MM-DD` | as today |
| `timestamptz` | date | |
| `jsonb` | embedded document or array | |
| `text[]`, `uuid[]` | array | |
| `tsvector` | dropped | search text is indexed by the search engine (§4) |
| identity columns | counter document per sequence (`kernel.counters`, `$inc`) | |

**Constraints.** MongoDB has no foreign keys, triggers or CHECK constraints, so each becomes something else:

| PostgreSQL (count in the spec) | MongoDB |
|---|---|
| NOT NULL, types, enum values (110 columns), `check >= 0` | `$jsonSchema` validator per collection (`validationAction: error`) |
| primary key, composite `pk (a, b)` | `_id`, or a unique index on (a, b) |
| unique column; unique nullable column (9) | unique index; nullable ones get a partial filter `{col: {$type: …}}` so several nulls are allowed, as in PostgreSQL |
| `unique nulls not distinct` (6) | plain unique index (MongoDB already treats nulls as equal) |
| partial index `where …` (60) | `partialFilterExpression` (`$in`, `$or` need MongoDB 6.0+; anything it cannot express becomes a stored flag field the repository maintains) |
| expression or gin index (22: `lower(email)`, text search…) | a stored normalised field with a normal index, a collation index, or the search engine |
| foreign key inside a module (289) | checked by the repository where an insert could break it; deletes that cascaded are explicit |

**Transactions.** `ctx.db.transaction(fn)` runs `fn` in a MongoDB session transaction and retries it on `TransientTransactionError` and `UnknownTransactionCommitResult`. Rule: a transaction function only reads and writes this module's collections; events are published after the commit (already the case) and providers are never called inside one, because a retry runs `fn` again.

**Row locks (`forUpdate`, 130 calls in repositories).** MongoDB has no `SELECT … FOR UPDATE`. Inside a transaction, "lock" means *write first*: the repository reads the document with `findOneAndUpdate({_id}, {$inc: {_lock: 1}})`. A second transaction that writes the same document gets a write conflict and is retried by the transaction wrapper, so the read-decide-write sequences of today (stock levels, balances, states) stay serialised. The lock order found on PostgreSQL stays the rule: reservations, then their lines, then stock levels (inventory, fixed on 2026-10-12).

**Kernel collections.**

| Today (PostgreSQL) | MongoDB |
|---|---|
| `kernel.schema_migrations` | `kernel.migrations`: applied migration ids and checksums |
| `kernel.idempotency_keys` | same fields, unique (scope, key), TTL index 24 h |
| `kernel.processed_events` (inbox) | unique key, inserted in the handler's transaction |
| `kernel.ref_counters` | `findOneAndUpdate` with `$inc`, upsert |
| `kernel.webhook_events` | unique (provider, event id), TTL |
| `kernel.rate_limits` (unlogged table) | `$inc` with upsert per window, TTL index on the window end |
| pg-boss (schema `pgboss`) | `kernel.jobs` queue (§4) |

## 3. Schema from the spec

The spec keeps its table notation (`docs/api/spec/FORMAT.md`), read as collections. `npm run gen` generates (`tools/lib/mongo.ts`, `tools/lib/mongoose.ts`):

- `src/modules/<module>/infra/mongo/schema.ts`: a **Mongoose schema per collection** (409 in 33 modules): field types, NOT NULL, enum values, `check >= 0`, and the indexes (724). The module manifest passes them (`schemas`), and repositories reach the models through `ctx.mongo.table(name)`;
- `spec.collections` in `src/spec/<module>.ts`: per collection the `_id` field, the database validator (`$jsonSchema`) and the same indexes. The validator stays in the database as the backstop for writes that bypass Mongoose validation (bulk writes, update pipelines);
- the row types (`src/spec/<module>.ts`) stay: they describe documents as well as rows.

PostgreSQL meaning kept on purpose: NOT NULL is "not null" (an empty string is a value), so `required` only refuses null; a unique index ignores rows with a null in its key (several are allowed), unless the spec says `nulls not distinct` or uses `coalesce`; a NOT NULL json column may hold JSON null. Six unique indexes whose condition needs a column's value list (`status <> 'removed'`, `state not in (…)`) cannot be expressed yet: the generated schema lists them as "not enforced", and the module that owns them adds the values to its spec when it moves (offers ×2, payments ×2, messaging, workqueues).

**Migrations.** The kernel applies a module's schema at startup outside production and with `npm run migrate` in production: it creates missing collections with their validator, keeps the validator equal to the spec, and syncs the indexes to the Mongoose schema (`Model.syncIndexes`); unchanged modules are skipped (a hash in `kernel.migrations`). Later changes that need data work (backfills, renames) are TypeScript migrations (`mongoMigrations: { id, up(db) }`) recorded in `kernel.migrations`. The module contract suite compares the collections, validators and indexes with the spec, as it compared columns. A module's PostgreSQL migrations that only updated **existing installs** (seed permissions added later, removed settings keys) are not ported: on MongoDB every install starts from the seed in code.

## 4. Infrastructure on MongoDB

| Part | Plan |
|---|---|
| **Job queue** (158 jobs, schedule phrases, "once across instances", retries with backoff, one waiting and one running per queue) | A small queue in the kernel on `kernel.jobs`: workers claim a job with `findOneAndUpdate` and a lease, a unique key keeps one waiting job per queue, schedules are computed by the existing phrase parser, failures are retried with backoff. It implements the existing `JobScheduler` interface, so no module changes. Chosen over Agenda: Agenda's locking and scheduling semantics differ from what the modules rely on |
| **Rate limits** | `RATE_LIMIT_STORE=mongo` (shared windows), `memory` in development |
| **Audit history** | One collection; append-only is enforced by the repository and by the database user's role (no delete or update on `audit.*` except the purge job's user). The hash chain and signed checkpoints stay. Monthly partitions go: the retention purge deletes by month on an indexed field |
| **Search** | OpenSearch in production (unchanged). The development and test engine (PostgreSQL full text + trigrams today) becomes a MongoDB engine with a text index and prefix matching; misspelling tolerance in development is weaker, documented. It passes the same engine contract tests |
| **Reports** | SQL aggregates and window functions become aggregation pipelines (`$group`, `$setWindowFields`) |
| **Pagination** | The kernel's keyset paging (`(sort, id) > (…)`) becomes the equivalent `$or` filter on (sort, `_id`) |

## 5. Tests and development

- Tests start one in-memory replica set per run (`mongodb-memory-server`, version pinned to 6.0.29 in `package.json`). It runs an installed MongoDB when there is one (`C:\Program Files\MongoDB\Server\<version>\bin\mongod.exe`, or `MONGOMS_SYSTEM_BINARY`); otherwise it downloads the binary on first run (on Windows a 785 MB archive). Each test app gets its own database from a pool in its process; closing the app empties it, so the next app reuses its collections and indexes.
- Development without `MONGODB_URI` starts the same embedded replica set (in memory, or in `MONGO_DATA_DIR`), as PGlite did. With a local MongoDB server instead, run it as a single-node replica set (`replication: replSetName: rs0` in `mongod.cfg`, then `rs.initiate()` once). Download: https://www.mongodb.com/try/download/community
- `npm run check` stays the gate: generated code fresh, types, boundaries, API conformance, all tests, every endpoint over HTTP.

## 6. Phases

Each phase ends with `npm run check` green and a report; the next starts after approval.

| Phase | Work | Done when |
|---|---|---|
| **M1 Foundations** | Kernel MongoDB layer (client, naming, transactions with retry, lock-by-write, id mapping, keyset paging), schema setup and migrations, kernel collections, job queue, rate-limit store, inbox, refs, idempotency; generator (types, validators, indexes); test harness (in-memory replica set); contract suite on collections. Pilot: **settings** and **access** ported to `infra/mongo/` | kernel tests and the two pilot modules pass on MongoDB; the pattern is written into `backend/docs/BUILDING-MODULES.md` |
| **M2 Modules, in tranches** (dependency order, parallel builders as before) | A: identity, audit, media, notifications · B: customers, catalog, inventory, sellers, purchasing, workqueues · C: offers, search, promotions, cart, orders, content · D: payments, shipping, checkout, messaging, reviews, finance, returns · E: support, trust, advertising, reports, warehouse · F: wishlist, wallet, fulfillment-service | each module's tests and its `test:http` pass on MongoDB |
| **M3 Remove PostgreSQL** | Delete `infra/postgres/`, PGlite, `pg`, `pg-boss`, Kysely; configuration (`MONGODB_URI`); docs 02, 03, README, FORMAT, .env.example | `npm run check` green with MongoDB only |
| **M4 Real server** | Run against a local MongoDB 6.0 replica set: migrate, start, `test:http --url`, and the whole suite under real concurrency (as was done on PostgreSQL, where it found deadlocks and lost updates) | all green on the real server |

## 7. Risks

- **Write conflicts instead of waiting.** PostgreSQL makes a second transaction wait for a row lock; MongoDB aborts it and the wrapper retries. Hot documents (popular stock items, ledger balances) may retry under load; M4 measures it.
- **Transaction limits.** A transaction may run 60 s by default and should touch at most a few thousand documents; bulk jobs work in batches, as most already do.
- **Partial and expression indexes.** 60 partial and 22 expression indexes need care (§2); the contract suite checks each against the spec.
- **No foreign keys or triggers.** Integrity inside a module moves into the repositories; the audit history's append-only rule moves to database roles.
- **Development search** is less tolerant of misspellings than the PostgreSQL engine; production uses OpenSearch.
- **Size.** About the same order of work as one of the earlier build passes: 33 repositories rewritten, plus the kernel. M1 is the one that sets the pattern; M2 parallelises.
