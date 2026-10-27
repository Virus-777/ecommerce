# Phase: MySQL 8.0 migration plan

Status: **plan only, nothing built** (re-measured 2026-10-23). No code has changed. Each phase in §23 starts only after the owner approves it. Decided by the owner on 2026-10-22: D1 (MySQL 8.0 or later), D2 (ids as readable text), D5 (MySQL search engine), D9 (portable `mysqld`); D11 (geographic points, §3) is new and open; the other decisions in §3 are still open.

**Re-census of 2026-10-23.** The first census was taken at 01:04 on 2026-10-22, from commit `3dcf7961`. The whole ten-Departments programme (six modules: departments, services, software, food, rewards, farm) landed between 02:29 and 23:37 that same day, followed by the advertising and API work of 10-23. Every count below was therefore re-measured on `d27cc18e`. The drift is **additive**: six new modules, 54 tables and about 1,800 lines of repository, with no new kind of data access. Every file:line reference this plan makes into the modules it first analysed (orders, finance, search, sellers, support, payments, promotions) still resolves to the same code, except the two noted in Appendix C. Nothing of the design changes; the numbers, the tranches and four appendix lists do.

The database requirement has changed again: the backend moves from MongoDB 6.0 (Mongoose) to **MySQL 8.0**. This plan does five things:

- keeps every current behaviour of the API, events, jobs and GraphQL;
- designs the schema for many concurrent users and writes, and for tables of 100,000 to tens of millions of rows;
- lays out relationships (keys), views and functions on purpose;
- keeps GraphQL reads cheap;
- keeps the code simple enough for one person to maintain offline (docs/MAINTAINING.md).

The spec's table notation started as SQL (PostgreSQL, docs/04 §2). Most of the data model therefore goes back to a relational shape with little rework. The work is in four places: the kernel data layer, the 40 repositories, the search engine, and the places where MongoDB behaviour (write conflicts, embedded arrays, aggregation pipelines) stands in for something SQL does differently.

---

## 0. Summary

| | Today (MongoDB) | Planned (MySQL 8.0) |
|---|---|---|
| Server | MongoDB 6.0.29, replica set `rs0` (needed for transactions) | MySQL 8.0 or later (8.0 from 8.0.36, never 8.0.29; 8.4 LTS; later releases), InnoDB, single server; a replica can be added later (§21) |
| Access library | Mongoose 8, generated schema per collection | **mysql2** driver + **Kysely** query builder (typed, generated table types), behind the same kernel `Table` helper |
| Storage | 471 spec tables → collections `<module>.<table>` | 471 tables `<module>_<table>` in one database `marketly`, plus the 11 `kernel_*` tables (482 in all) |
| Keys | `_id` = UUIDv7 string | `id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin` primary key (decision D2) |
| Integrity | `$jsonSchema` validator, unique and partial indexes, checks in repositories | NOT NULL, CHECK (enum values, `>= 0`), primary/unique keys, **foreign keys inside a module**, generated columns for partial unique keys |
| Locks | lock-by-write (`$inc _lock`), conflicts retried | `SELECT … FOR UPDATE` (waits instead of aborting); deadlocks and lock timeouts retried |
| Isolation | snapshot + write-conflict detection | **READ COMMITTED** + explicit locks or atomic updates (§11; this is where behaviour must be preserved carefully) |
| Search (dev/small prod) | Mongo engine on embedded `terms[]` and `offers[]` | **MySQL engine** on child tables (`search_terms`, `search_offers`, `search_document_categories` …) and FULLTEXT ngram. OpenSearch stays optional |
| Aggregations | ~170 `$group`, 39 `$lookup`, 4 `$facet`, 1 `$setWindowFields`, 16 update pipelines | GROUP BY, JOIN / EXISTS, CTE, window functions, `INSERT … ON DUPLICATE KEY UPDATE` |
| TTL indexes | idempotency 24 h, webhooks 90 d, jobs 7 d, rate limits | one kernel purge job, deleting in batches |
| Backups | mongodump/mongorestore via ops.sh | mysqldump `--single-transaction` (+ binlog for point-in-time) via the same ops.sh flow |
| Tests | mongodb-memory-server (in-memory replica set) | a portable `mysqld` started by the test setup (like today's in-memory server) or an installed one; a template database cloned per worker |

Size of the job, measured on main `d27cc18e` (2026-10-23): **40 modules; 471 tables; 5,603 columns; 901 indexes** (125 unique, 70 partial, 17 expression/GIN); **329 references inside modules (none across modules)**; 437 JSON columns; 17 array columns; 8 binary columns; 1,620 endpoints. In code: about **15,500 lines of repositories**, plus the search engine. Module-wide counts: about **738 transactions, 581 `forUpdate` reads, 148 `claim()` calls and 169 jobs**.

For comparison, the figures of the first census (commit `3dcf7961`, 2026-10-22), on the same counting method: 34 modules; 417 tables; 4,915 columns; 800 indexes; 291 references; 357 JSON columns; 16 array columns; 13,687 lines of repositories; 690 transactions; 543 `forUpdate` reads; 162 jobs. The six Departments modules account for nearly all of the difference: 54 tables, 676 columns, 96 indexes, 245 endpoints, 6 jobs and about 1,800 lines of repository.

---

## 1. Ground rules

1. **Behaviour does not change.** The API, OpenAPI document, GraphQL schemas, events, jobs, settings, permissions and error codes stay byte-for-byte the same. `npm run check` (types, boundaries, API conformance, about 9,750 tests, roughly 8,000 HTTP checks over 1,620 endpoints) and `npm run simulate` are the proof. Where MySQL behaves differently by nature (lock waits instead of retries, the order of keys inside JSON), §25 says how the old behaviour is kept, or why the difference cannot be seen.
2. **Services and domain code do not change.** Only `repository.ts`, the generated `schema.ts`, `module.ts` wiring and tests that read the database directly change. The repository class keeps its method names and signatures, so services compile unchanged. Exception: the fix lists in Appendix C (concurrency) and Appendix D (GraphQL batching), which are done first, on MongoDB, so they are proved before the database changes.
3. **The spec still decides.** Tables, columns, indexes and the new items (views, foreign key options, text lengths) are written in `docs/api/spec/modules/*.json`; `npm run gen` writes the DDL and the types; `npm run migrate` applies them.
4. **Module boundaries stay.** A module reads and writes only its own tables. There are no foreign keys or joins across modules (modules can be switched off). The compiler and `check:boundaries` enforce this (§10.6).
5. **Speed decides where logic runs** (owner, 2026-10-22: "using clever SQL for business logic is okay if it can speed up the query"). Business rules stay in TypeScript by default. A rule may move into SQL when that is measurably faster: set-based statements, window functions, stored procedures, triggers, or SQL-computed values. Examples are fewer round trips while a hot row is locked, or work done in the database instead of fetching rows to JavaScript. Each such piece follows the rules in §9.5: measured, owned by one module, tested by the module's tests, and written in the spec like the rest of the schema.

---

## 2. Sizing assumptions (what "large" means here)

The design is checked against these figures; the load test (§22) seeds them.

| Area | Design volume | Hot path |
|---|---|---|
| Catalog | 100k products, 300k variants, 500k offers | search, category pages, product page (GraphQL) |
| Orders | 2M orders, 6M order items, 20M timeline rows per year | checkout bursts; seller and admin order lists |
| Money | 20M finance ledger entries; 50k seller accounts | posting under row locks; statements; payout runs |
| Stock | 1M stock levels; 30M stock movements | reservations at checkout on popular SKUs |
| Logs | 50M notification deliveries/events, 10M audit entries, 5M job runs | append-only; purged by age |
| Departments (added 2026-10-23) | 5M game scores, 2M blog reactions and reply likes, 200k blog replies; 500k food orders and 300k software purchases per year; 100k services requests; 50k farm orders; small staff-kept catalogues (a few thousand phones, companies, restaurants, apps, providers, dealers) | `departments_scores` and the reaction tables are append-per-interaction; the staff catalogues are small and read whole (see the geographic lists below) |
| Concurrency | 2,000 concurrent sessions; 300 requests/s steady, 1,000/s peak; 50 checkouts/s burst; 30 seller bulk jobs at once | |
| Server | one Ubuntu server, 8–16 vCPU, 32–64 GB RAM, NVMe SSD | §20 assumes 32 GB |

Rule for every list endpoint: no read may scan more than the page plus one row, apart from the exact `total` that page mode returns (§16.4). Every filter that a list offers has an index whose leftmost columns are its equality filters and whose last column is the list's sort, followed by `id`.

**One standing exception, to be settled by D11.** The lists sorted by distance from the customer — nearby restaurants (`food/service/catalog.ts:162`) and the nearest farm dealer — read the whole table and sort in JavaScript with `kernel/lib/geo.ts`. They break the rule above by design. At today's volumes (a few thousand rows) that is the cheapest thing that works, and the DECIMAL round trip already matches §5.1 (the services read `Number(lat)` and write `.toFixed(6)`, so nothing changes on MySQL). The rule applies again as soon as these catalogues pass a few thousand rows; D11 decides what happens then.

---

## 3. Decisions

Owner decisions of 2026-10-22: **D1, D2, D5 and D9**. Owner decisions of 2026-10-23, at the start of Y0: **D4, D10 and D11** (D11 was new in the re-census; the first census was taken before the modules that hold map points existed). **D3, D6, D7 and D8 were decided on 2026-10-24, at the start of Y1**, each as the plan recommended: mysql2 + Kysely; purge the event inbox after 90 days; `mysqldump --single-transaction` plus binlogs; and 503 `SERVICE_BUSY` when the lock retries run out. Every decision in this plan is now made.

**D10 is the one that changes the shape of the plan.** Starting empty removes the data audit (§18.1), the ETL and its verification (§18.2–18.3) and the rehearsal phase (the old Y6), and turns the cutover into a switch of environment variables (§18.3). §18 is rewritten accordingly. The one thing it costs is listed there: the 107 real products live only in the running MongoDB dev database, so Y0 exports them to a seed file before anything else is done.

| # | Decision | Choice | Alternative and trade-off |
|---|---|---|---|
| D1 | Server version | **Decided: MySQL 8.0 or later.** Supported range: **8.0 from 8.0.36** (never 8.0.29), **8.4 LTS**, and later releases. The code, the DDL and the configuration use only what every version in the range accepts (§20.1); the start-up check refuses an older server. **The production server will run Ubuntu's own `mysql-server-8.0` package** (owner, 2026-10-27), which 22.04 and 24.04 still ship and patch past the April 2026 end of Oracle's own 8.0 support. So the 8.0 half of the range is not a precaution — it is the server — and the **8.0 test run of §19 is a real gate on Y1, not a formality**. Nothing in the code may use a feature newer than 8.0.36. | (not chosen) 8.4 LTS from Oracle's apt repository: supported until 2032 and would let the 8.0 half of the range be dropped, at the cost of a third-party repository on an offline server |
| D2 | How ids are stored | **Decided: as readable text**, `CHAR(36) ascii_bin`. Readable in any SQL tool; GraphQL ids, cursors and logs stay exactly the same; no conversion code to get wrong | (not chosen) `BINARY(16)`: keys about 2× smaller, but every query must convert ids |
| D3 | Query layer | **Decided (2026-10-24): mysql2 + Kysely**: typed SQL, generated table types, `forUpdate()`, `skipLocked()`, `onDuplicateKeyUpdate()`. The codebase used Kysely before (PostgreSQL). | Raw mysql2 strings: fewer layers, no compiler help. Drizzle/Prisma: an ORM model on top of the spec, two sources of truth. |
| D4 | Foreign keys | **Decided (2026-10-23): on, inside each module** (ON DELETE RESTRICT; CASCADE only for pure child lists that the code already deletes with their parent). The spec can turn one off with `nofk` where the load test shows lock waits. | None: a little faster to write, but integrity rests on code alone (as on MongoDB). |
| D5 | Search engine | **Decided: a MySQL engine** for development and for production up to about 100k products, passing the same engine contract tests and benchmark (§14). The OpenSearch code is kept | OpenSearch stays the fallback for a deployment that outgrows it: better fuzzy search, but an extra server and 2–4 GB of RAM |
| D6 | Event inbox (`processed_events`) | **Decided (2026-10-24): purge keys older than 90 days.** Events are in-process with no redelivery, so a key older than any retry window can never be used again. | Keep forever, as today: the table grows by every event (11k rows in dev already). |
| D7 | Backups | **Decided (2026-10-24): mysqldump `--single-transaction`** in the existing ops.sh flow, plus binlogs kept 7 days for point-in-time recovery | Percona XtraBackup or MySQL Shell `util.dumpInstance`: faster above about 20 GB, but more tools to keep offline. |
| D8 | Lock retries used up | **Decided (2026-10-24):** after 5 attempts (deadlock or lock timeout), answer **503 `SERVICE_BUSY`** with `Retry-After: 1` | Today an exhausted MongoDB retry is a 500. |
| D9 | Dev and test database | **Decided: portable `mysqld`**: the dev server and test setup start a private `mysqld` from an installed MySQL or an unzipped one, with its data in `.data/mysql`, as mongodb-memory-server does today. An installed service via `MYSQL_URL` also works. | Always require an installed service. |
| D10 | Existing data | **Decided (2026-10-23): start empty.** Production has never gone live and no server holds real data, so a fresh install creates the schema and seeds from code, as M2 did. §18 is rewritten around this: no audit, no ETL, no rehearsal. **One carve-out:** the 107 real products (DummyJSON / Open Food Facts) exist only in the running MongoDB dev database — their import tool was removed on 2026-10-17 and only their images survive as local files — so Y0 exports them to a seed file in the repository before anything else (§18.1) | (not chosen) Move it with an ETL tool: keeps every row of the dev database and of any running server, at the cost of the audit tool, the ETL, its verification, a rehearsal phase and a maintenance window |
| D11 | Geographic points | **Decided (2026-10-23): keep them as they are: `lat`/`lng` as `DECIMAL(9,6)`, distance computed in TypeScript** (`kernel/lib/geo.ts`), with the lists that sort by distance reading the whole table. It is what the code does today, it needs nothing from MySQL, and the catalogues are staff-kept and small. The repositories cap such a read and the module's tests assert the cap | Two ways out when a catalogue grows past a few thousand rows: (a) **a bounding box first** — indexes on `(lat)` and `(lng)`, `WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?` to narrow, then the exact distance in TypeScript; no new types, and it stays inside the §10.4 `Table` operations. (b) **`POINT NOT NULL SRID 4326` with a SPATIAL index** and `ST_Distance_Sphere`, which is what MySQL is built for, but adds a column type the generator, the ETL and the row types do not handle, for two tables. Recommended order: (a) when needed, (b) only if (a) is measured to be too slow |

---

## 4. Database layout and naming

- **One database** `marketly` (`MYSQL_URL=mysql://marketly_app:…@127.0.0.1:3306/marketly`, or a unix socket). One database keeps the following simple: backups (one dump), test isolation (one database per test slot), user privileges, and transactions that span the kernel and a module.
- **Table names:** `<module>_<table>` with `-` replaced by `_`: `catalog_products`, `orders_order_items`, `fulfillment_service_inbound_shipments`. The longest is 40 characters; MySQL allows 64. The generator refuses a name collision (`a_b` + `c` vs `a` + `b_c`). Kernel tables are `kernel_*`.
- **Identifiers are always quoted** with backticks by the generator and by Kysely. Twelve column names are MySQL reserved words (Appendix E: `key` ×19, `condition` ×6, `lines` ×4, `check`, `before`, `by`, `schema`, `system`, `trigger`, `groups`, `last_value`, `sensitive`). No column is renamed, so rows keep their spec shape.
- **Index names:** `ix_<table>_<n>`, `uq_<table>_<n>`, `fk_<table>_<column>`, `ft_<table>_<n>`, so they stay under 64 characters. The generated spec keeps a readable description of each one.
- **Views:** `<module>_v_<name>` (§9). Maintenance-only views: `ops_v_<name>`.
- **Character set:** `utf8mb4` everywhere; see §5.2 for collations.

---

## 5. Types, collations and keys

### 5.1 Column types

| Spec type (count) | MySQL | Read as (JS) | Note |
|---|---|---|---|
| `uuid` (1,302) | `CHAR(36) CHARACTER SET ascii COLLATE ascii_bin` | string | UUIDv7 ids are time-ordered, so new primary keys append to the end of the B-tree (no page splits, unlike random UUIDv4) |
| `text` (2,071), indexed or enum (≈ 595) | `VARCHAR(n)`: enum columns `VARCHAR(32)` unless a value is longer; other indexed text `VARCHAR(255)` unless the spec says `varchar(n)` | string | The generator checks every index key fits InnoDB's 3,072-byte limit (utf8mb4 is 4 bytes per character) |
| `text`, not indexed | `TEXT` (64 KB), or `mediumtext` where the spec says so | string | Short values stay in the row page (InnoDB DYNAMIC format). **Checked in Y0, and the list in this row was wrong:** the long bodies named here — content pages, help articles, news posts and notification templates — are not text columns at all. They live inside JSON: `content.versions.snapshot` and `notifications.template_versions.content`. MySQL JSON holds up to `max_allowed_packet`, so they were never near the 64 KB limit. Only two uncapped text bodies can realistically pass it, and both are now `mediumtext`: `content.policy_versions.body` (a full legal policy) and `departments.blog_posts.body` (a staff-written article). Every other `text` column is short-form — notes, messages, reviews, notices — and keeps `TEXT`. With D10 there are no existing values to measure (§18.3), so this is reasoning about shape, not data; `STRICT_TRANS_TABLES` turns a value that does not fit into an error rather than a silent truncation, and widening is an `ALGORITHM=INPLACE` change |
| `char(n)` (8) | `CHAR(n) CHARACTER SET ascii` | string | Currency codes and similar |
| `int` (433) | `INT` | number | Money stays in integer minor units |
| `smallint` | `SMALLINT` | number | |
| `bigint` (207), `bigserial` | `BIGINT`; an identity column is `BIGINT AUTO_INCREMENT` | number (`supportBigNumbers`, strings only above 2^53) | |
| `numeric(p,s)` (24) | `DECIMAL(p,s)` | string (mysql2's default) | Exact, as today. Note: DECIMAL returns the full scale (`"12.50"` where Decimal128 kept `"12.5"`); §25 covers where that matters. Four of the 24 are the map points `customers.addresses.lat/lng` and `food.restaurants.lat/lng` (`numeric(9,6)`): the services already read them with `Number()` and write them with `.toFixed(6)`, so the padded scale is invisible there (D11) |

**All 24 now carry an explicit precision and scale** (2026-10-27). Thirteen were written as a bare `numeric`, which this row quietly assumed could not happen. MySQL reads a bare `DECIMAL` as **`DECIMAL(10,0)`** — an integer — so every one of them would have silently truncated its decimals: cubic feet, durations, scores, rates, approval limits. The generator now refuses a `numeric` with no precision rather than letting MySQL choose, and the spec carries the sizes. They are generous on purpose: widening a DECIMAL later is an `ALGORITHM=INPLACE` change, while a value that does not fit is a hard error under `STRICT_TRANS_TABLES`. Percentages follow the columns that already had a size ((5,2), (6,2)); scores and weights are (12,6); quantities and volumes (12,3)–(14,3); generic limits, values and thresholds (14,4).
| `bool` (178) | `TINYINT(1)` (`BOOLEAN`) | boolean (kernel type cast) | |
| `date` (70) | `DATE` | string `YYYY-MM-DD` (type cast keeps it a string) | |
| `time` (2) | `TIME` | string `HH:MM:SS`, trimmed to `HH:MM` where the spec stored `HH:MM` | |
| `timestamptz` (835) | `DATETIME(3)`, always UTC (session `time_zone='+00:00'`) | Date | Not `TIMESTAMP`, which stops in 2038. Millisecond precision matches MongoDB dates |
| `jsonb` (437) | `JSON` | parsed object | MySQL reorders object keys; §25 shows nothing depends on key order |
| `text[]` / `uuid[]` (17) | per column, §8: `JSON` array with a multi-valued index, or a child table | string[] | |
| `bytea` (8) | `VARBINARY(n)` (hashes: `BINARY(32)`), or `BLOB` for encrypted values | Uint8Array | |
| `inet` (9) | `VARCHAR(45) CHARACTER SET ascii` | string | |
| `tsvector` (1) | not stored (search engine), as today | | |

### 5.2 Collations (keeping MongoDB's comparison rules)

MySQL's default collation `utf8mb4_0900_ai_ci` ignores case **and accents**. Used everywhere, it would quietly change the unique keys (SKU `ABC` vs `abc`, slugs, codes) and the sort order. So:

| Use | Collation | Why |
|---|---|---|
| Every text column by default | **`utf8mb4_0900_bin`** | Compares like MongoDB without a collation: case-sensitive, accent-sensitive, code-point order, no padding. Unique keys and sorts behave as today |
| Columns with a `lower()` or `upper()` index today, and reads that pass `CASE_INSENSITIVE` — **exactly two, checked in Y0**: `orders.orders.contact_email` and `promotions.coupon_codes.code` | **`utf8mb4_0900_as_ci`** (spec flag `ci`) | MongoDB's `{locale:'en', strength:2}` ignores case but not accents. `as_ci` is the same rule, and the index is used directly. **The emails in identity, sellers and customers turned out not to belong here:** all three lower-case an address before storing it (`identity/domain/policy.ts` `normalizeEmail`, and the same in customers and sellers), so the stored value is already normalised and a case-insensitive collation would add nothing. The one real exception is `sellers.applications` `account.workEmail`, a path inside a JSON column, so it is a generated column in Appendix B rather than a flag here |
| `contains()` / `startsWith()` search boxes | `col LIKE ? COLLATE utf8mb4_0900_as_ci`, with `%`, `_` and `\` escaped | Same meaning as today's escaped `$regex` with option `i` |
| ids, codes, hashes | `ascii_bin` | Smaller and exact |

### 5.3 Primary keys

- Single-column `pk` (406 tables): `PRIMARY KEY (id)`.
- Composite `pk (a, b)` (28 tables): `PRIMARY KEY (a, b)`. The spec's column order is kept, so the clustered order matches the main lookup (`stock_levels (stock_item_id, location_id)`).
- No key in the spec (37 tables: daily facts, link tables, logs): an invisible surrogate `row_id BIGINT UNSIGNED AUTO_INCREMENT INVISIBLE PRIMARY KEY`. InnoDB needs a real primary key; an invisible column never appears in `SELECT *`, so rows keep their spec shape. Where such a table has a natural unique key (`(seller_id, day)` in the fact tables), that key is declared `UNIQUE` and is what upserts target.

---

## 6. Constraints and relationships

### 6.1 What each spec rule becomes

| Spec | MySQL |
|---|---|
| NOT NULL (`?` absent) | `NOT NULL`. An empty string is a value, as today |
| enum values `(a\|b\|c)` (145 columns) | `VARCHAR(32)` + `CHECK (col IN ('a','b','c'))`. Not the `ENUM` type: ENUM sorts by position rather than by text, which would change `ORDER BY status`, and changing its values rebuilds the table |
| `check > 0`, `check >= 0` (15) | `CHECK (...)` (enforced since 8.0.16) |
| `pk` | primary key (§5.3) |
| `unique` column (120) | `UNIQUE`. MySQL, like the spec, lets several rows hold NULL |
| `unique (a, b)` | `UNIQUE (a, b)` |
| `unique nulls not distinct (…)` (6) | a functional unique key on `COALESCE(col, '')` for each nullable column (Appendix A) |
| partial `unique (…) where cond` (32) | a **functional key part** `(IF(cond, first_col, NULL))`. MySQL never compares a key that contains NULL, so rows outside the condition are not checked: exactly what a partial unique index means. Appendix A gives the exact form of every one |
| partial non-unique `(…) where cond` (38) | a plain index with the condition's columns added after the equality columns and before the sort/range column (MySQL has no partial indexes; the extra entries cost little and the condition is filtered inside the index) |
| `lower(col)` / `upper(col)` | the column's collation (§5.2) + a plain or unique index |
| `gin(… gin_trgm_ops)` (7) | `FULLTEXT … WITH PARSER ngram` (ngram size 3, the same idea as trigrams); terms shorter than 3 characters fall back to `LIKE` |
| `gin(to_tsvector(…))` (2, never queried today) | `FULLTEXT … WITH PARSER ngram` on the same columns, used by the admin customer and seller search boxes, which today run a regex |
| `gin(array)` / `gin(jsonb_path_ops)` | §8 |
| `→ table` reference (329, all inside one module) | `FOREIGN KEY … REFERENCES … ON DELETE RESTRICT ON UPDATE RESTRICT` (D4), with options in §6.2 |

The generator checks that each functional unique key it writes is used by the repository's `insertIfAbsent`/`upsert` key detection (the kernel reads the same definition the DDL came from, as `Table` reads `def.indexes` today).

### 6.2 Foreign keys: the relationship plan

- **Inside a module only.** Cross-module ids (`order.customer_id` → customers) stay plain indexed columns: modules can be switched off and are kept consistent by events, as today.
- **Default `ON DELETE RESTRICT`**: a parent cannot be deleted while children exist. The repositories already delete children first wherever the old PostgreSQL schema cascaded (docs/04 §2, "deletes that cascaded are explicit"), so RESTRICT changes nothing and catches mistakes.
- **`ON DELETE CASCADE`** only where the spec marks a reference `→ table cascade`. The code that deletes them explicitly stays (simple and visible); the cascade is a backstop.
  **Marked in Y0, where the code demonstrably deletes the children and then the parent** (6 references): `notifications.notice_recipients → notices` (`notifications/repository.ts:327-328`) and the five child lists of a blog post and reply that `departments.deletePostCascade` and `deleteReplyCascade` walk. **`role_permissions` was a candidate and is not one:** a role is never deleted anywhere in `access`, so RESTRICT is the honest declaration and would catch a future mistake, which is what RESTRICT is for. The `*_lines` and `*_items` lists are left at RESTRICT for now: each needs its own delete path read, a wrong cascade is silent, and Y2 rewrites those repositories anyway — that is the moment someone is looking at them closely.
  One consequence worth stating: because MySQL fires no trigger for a cascaded delete, a child table that cascades cannot also keep a parent summary column by trigger (§9.5.3). The departments counters (`blog_posts.like_count`, `reply_count`, `blog_replies.like_count`) are therefore kept by the repository, under the locks added in Appendix C, and §9.5.3 will not propose triggers for them.
- **`nofk`** in the spec drops one foreign key. It is used only when the load test (§22) shows the parent row's shared lock causing waits. The likely candidates are append-only logs that point at very hot parents (`inventory_stock_movements → stock_items`, `orders_timeline → orders`). In those flows the parent is normally already locked by the same transaction, so a foreign key costs nothing there.
- **An index on every foreign key column.** The generator reuses an existing index that starts with the column (as MySQL requires) and reports redundant ones; for example `offers stock_item_id` is covered by the unique key on it (an open item from docs/05).
- **No orphans to clear.** MongoDB enforced none of the 329 references, but D10 starts the MySQL database empty, so the foreign keys are created with the tables and have nothing to validate against. This is the one place where starting empty makes D4 easier; it also means the first rows ever written are the first test of each key.

### 6.3 Append-only tables

**Confirmed in Y0 by reading every write to each table — five tables, not four:** `audit_entries`, **`audit_entry_targets`** (missing from the first list; the repository says as much at `audit/repository.ts:169`, and the retention purge deletes a target row with its entry), `audit_checkpoints`, `finance_ledger_entries` and `wallet_ledger`. All five now carry `"appendOnly": true` in the spec. Two were considered and rejected: `finance_trading_entries` is deleted at `finance/service/ledger.ts:180`, which removes a pending cost-of-goods placeholder, and `wallet_loyalty_entries` is a phase-4 table nothing writes yet, so there is nothing to confirm. Each append-only table gets two triggers:

```sql
CREATE TRIGGER audit_entries_no_update BEFORE UPDATE ON audit_entries FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_entries is append-only';
CREATE TRIGGER audit_entries_no_delete BEFORE DELETE ON audit_entries FOR EACH ROW
  IF COALESCE(@marketly_purge, '') <> 'audit-retention' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_entries is append-only';
  END IF;
```

Only the retention purge job sets `@marketly_purge` in its own session. Today append-only is enforced by repository convention alone (the role named in docs/04 was never created). This keeps the rule with one application user. The ledger tables have no purge, so their delete trigger always refuses.

---

## 7. Indexing strategy

1. **Carry over all 901 spec indexes** (Appendix A for the 87 partial/expression ones). The generator then flags:
   - an index that is a prefix of another (redundant);
   - a foreign key with no index starting with it;
   - a paged list (`Table.page` order or `pageAggregate` key) without a `(…filters, sort, id)` index.
2. **Secondary indexes carry the primary key.** With `CHAR(36)` ids each entry has 36 extra bytes. So `id` is not added to an index for keyset paging: InnoDB already appends it. `(seller_id, created_at)` serves `ORDER BY created_at DESC, id DESC`.
3. **Descending indexes** (8.0) where a list sorts mixed directions, e.g. `(rating DESC, rating_count DESC)`.
4. **Covering indexes** for the few hottest reads, checked with `EXPLAIN` in Y3:
   - stock availability by item;
   - offer quote by variant;
   - session lookup by token hash;
   - permission checks.
5. **Invisible indexes** (`ALTER TABLE … ALTER INDEX … INVISIBLE`) are how an index is retired: make it invisible, watch the slow log for a week, then drop it in the spec.
6. **FULLTEXT ngram** (§6.1) for substring search boxes on large tables. On small tables (< 20k rows) `LIKE '%x%'` with the `as_ci` collation is simpler and fast enough; the spec says which.
7. **Generated columns for JSON paths** that a list filters on (§8.2): `STORED` when sorted or ranged, `VIRTUAL` + index otherwise.
8. **Statistics:** `ANALYZE TABLE` after the data load, and histograms (`ANALYZE TABLE … UPDATE HISTOGRAM ON status, kind`) on low-cardinality status columns that are filtered without an index, so the optimizer picks the right plan.

---

## 8. Arrays and JSON

### 8.1 The 17 array columns

| Column | Queried? | Plan |
|---|---|---|
| `search.search_documents.category_path_ids` | yes: category listing ordered by rank | **child table** `search_document_categories (category_id, product_id, rank_all, rank_in_stock)`; a multi-valued index cannot serve ORDER BY (§14) |
| `search.search_documents.seller_ids`, `conditions` | facets/filters | derived from `search_offers` rows (already a table); the arrays go |
| `search.search_documents.gtins` | GTIN lookup | child table `search_gtins (gtin, product_id)` |
| `search.search_documents.terms` (json `{t,w}[]`) | every search | child table `search_terms (stem, product_id, weight)` (§14) |
| `audit.entries.search_words` | `$all` words | `JSON` + multi-valued index `((CAST(search_words AS CHAR(40) ARRAY)))`, queried with one `MEMBER OF` per word (AND). Alternative if slow: child table `audit_entry_words` |
| `orders.orders.flag_kinds` | membership | `JSON` + multi-valued index; `? MEMBER OF (flag_kinds)` |
| `offers.offers.content_gaps` | membership | `JSON` + multi-valued index |
| `notifications.announcements.seller_ids`, `shipping.notices.*_ids` / `postal_prefixes`, `shipping.exceptions.order_item_ids`, `orders.order_facts.item_ids`, `search.synonyms.terms`, `search.reindex_jobs.ids`, `warehouse.package_items.serial_numbers`, `software.apps.platforms` | read with the row only | plain `JSON` array |

### 8.2 JSON columns (437)

Most JSON columns are snapshots or option lists read with their row: they stay `JSON`, with no change. Where a query filters or sorts on a path inside one (Appendix B lists every place from the code census), the rule is:

- **list filter or sort on a large table** → a generated column (`snapshot_title VARCHAR(255) AS (snapshot->>'$.title') STORED`) with an index, or FULLTEXT if it is a search box. Example: `orders_order_items.product_snapshot.title`, which the seller order search reads.
- **rare admin filter combined with a selective indexed filter** → `JSON_EXTRACT`/`->>` in the WHERE clause, no index.
- **membership in a JSON array of objects** (`related_subjects $elemMatch {type,id}`, `actor_roles.key`) → a multi-valued index over `CAST(col->'$[*].ref' AS CHAR(80) ARRAY)` where a single path is enough, or a small child table where two fields must match together (`workqueues_item_subjects (item_id, type, subject_id)`).
- **string dates inside JSON compared as ranges** (`decision.decidedAt`, `info_request.replyDueAt`) → a generated `DATETIME(3)` column.

---

## 9. Views, summary tables, functions and triggers

### 9.1 Policy

| Object | Used for | Not used for |
|---|---|---|
| **Views** | (a) module-internal join shapes the code reads often, MERGE-able only (no GROUP BY, DISTINCT, LIMIT or UNION, so MySQL folds them into the outer query and uses the base indexes); (b) read-only `ops_v_*` views for the maintainer's ad-hoc SQL | aggregates on large tables. MySQL has no materialized views: an aggregate view is recomputed in a temporary table on every read |
| **Summary (read-model) tables** | anything aggregated that a screen reads often: the existing `reports_fact_*` tables, plus the new ones below, kept in step in the writing transaction or by the existing events and jobs | |
| **Set-based SQL** (INSERT … SELECT, UPDATE … JOIN, window functions, CTEs, conditional aggregation) | the first choice whenever code reads rows into JavaScript only to compute and write them back, or sorts and ranks in JavaScript (§9.5.1) | |
| **Stored procedures** | hot multi-statement paths that hold a contended row lock: one `CALL` instead of 4–8 round trips shortens how long the lock is held (§9.5.2) | flows that call providers, publish events, or touch another module's tables |
| **Stored functions** | two small helpers for views and ad-hoc SQL (§9.4); others only where a measurement shows a gain | per-row filters in large WHERE clauses: MySQL calls a stored function once per row, so an inline expression or a generated column is faster |
| **Triggers** | append-only guards (§6.3); summary columns that a trigger keeps exact in the same statement, where that removes a round trip from a hot write (§9.5.3) | anything on a table whose rows are deleted by a foreign key cascade (MySQL does not fire triggers for cascaded actions) |
| **Event Scheduler** | off | jobs stay in the app's queue (one place to look) |

Views are written in the spec's new `views` section (`{ "name": "group_rows", "sql": "…", "desc": "…" }`). The generator creates them with `ALGORITHM=MERGE SQL SECURITY INVOKER`, refuses a non-mergeable view, and the contract suite checks they exist.

**The notation exists from Y0; the SQL is written in Y1** (decided 2026-10-24). The other Y0 spec additions — `ci`, `appendOnly`, `cascade`, the text sizes — are declarations *about columns that already exist*: each is either true of the code today or it is not, and Y0 checked which. A view is new code. Ten views written in Y0 would be ten pieces of SQL that nothing can execute, parse or prove MERGE-able until a MySQL server exists, so the first time any of them was checked would be the first time the generator ran. In Y1 the generator, the contract suite and a server arrive together and each view is proved as it is written. `ViewSpec` and the module-doc rendering are already in place, so Y1 fills a slot rather than cutting one.

### 9.2 Views (replacing `$lookup` joins inside a module)

| View | Joins | Replaces | Read by |
|---|---|---|---|
| `orders_v_group_rows` | seller order groups + orders (placed_at, ref, contact) | `orders/repository.ts:225` `$lookup` | seller order list, sorted by placed_at or dispatch_by |
| `orders_v_item_rows` | order items + order (ref, placed_at, state) + the snapshot columns generated in §8.2 | `#lookupAny` EXISTS helpers (×7) | admin and seller order search |
| `finance_v_statement_entries` | ledger entries + earnings lot state + payout run | `finance/repository.ts:341,344,357` | statements |
| `finance_v_lot_entries` | earnings lots + their pending ledger entries | `finance:309,329,405` | pending totals, payout due |
| `returns_v_return_items` | return items + return (status, fulfilled_by) | `returns:224,242,258` | used quantities, open returns per product |
| `purchasing_v_receipt_lines` | deliveries → receipts → PO lines | `purchasing:447,461,463` | supplier performance |
| `trust_v_report_subjects` | report subjects + reports (not merged) | `trust:138,228` | report lists by subject |
| `messaging_v_participant_conversations` | participants + conversations | `messaging:153,167` | inboxes, guest unread |
| `notifications_v_inbox` | notice recipients + notices | `notifications:188` | inbox counts and lists |
| `inventory_v_stock_rows` | stock items + levels + locations | `inventory:208` (nested lookup) | stock lists (sums: §9.3) |

Maintainer views (`ops_v_*`, read-only, documented in MAINTAINING.md):
- `ops_v_orders` (order with customer contact, totals, state);
- `ops_v_seller_money` (accounts with available/pending/held);
- `ops_v_stock` (item, location, on hand, reserved);
- `ops_v_jobs` (queue state, last run, failures);
- `ops_v_audit_recent`.

### 9.3 Summary columns and tables (replacing repeated aggregations)

Columns that the writing transaction keeps up to date. It already holds the needed row lock, so the extra work is one UPDATE.

| New column(s) | On | Kept by | Replaces |
|---|---|---|---|
| `sellable_total`, `damaged_total`, `reserved_total` | `inventory_stock_items` | every stock-level write (already locked through `StockTx`) | `$lookup` + `$map/$filter` sums for list filters (`inventory:208`) |
| `answer_count`, `seller_answered`, `max_helpful` | `reviews_questions` | answer publish/hide | `reviews:190` lookup |
| `usage_count` | `media_assets` | usage attach/detach | `media lookupUsages` (in use / unused filters) |
| `open_return_qty` | `returns_return_items` aggregate per order item, as `returns_order_item_totals (order_item_id, used_qty, open_qty)` | return state changes | `usedQuantities`, `openReturnsPerProduct` |
| `seller_summaries` read model (deferred in docs/05 follow-ups) | `sellers` | events from finance, reviews, support, orders | admin seller list's in-memory sort capped at 1,000 rows |
| `like_count`, `dislike_count`, `reply_count` (exist already) | `departments_blog_posts` | the reaction and reply writes | counting `blog_reactions` and `blog_replies` on every read of a post card |
| `like_count` (exists already) | `departments_blog_replies` | the reply-like writes | counting `blog_reply_likes` per reply |

The four departments counters are the same pattern as the rest of this table and need no new column, but two of the three writers do not hold a lock today (Appendix C, the two 2026-10-23 entries). They are fixed in Y0 with the rest.

Existing read models stay: reports facts, `finance_seller_accounts` (stored balances), `reviews_seller_feedback_summaries`, `search_documents` cards and ranks, `catalog_listing_stats`.

### 9.4 Stored functions

```sql
-- money in minor units → '12.50 USD' (views and ad-hoc SQL only)
CREATE FUNCTION fn_money(minor BIGINT, currency CHAR(3)) RETURNS VARCHAR(40) DETERMINISTIC NO SQL
  RETURN CONCAT(FORMAT(minor / 100, 2), ' ', currency);
-- an instant as the market's calendar day (needs the time-zone tables, §20)
CREATE FUNCTION fn_market_day(ts DATETIME(3), tz VARCHAR(64)) RETURNS DATE DETERMINISTIC NO SQL
  RETURN DATE(CONVERT_TZ(ts, '+00:00', tz));
```

Generated columns cannot call stored functions (a MySQL rule), and the code does not depend on these two. Repositories write the SQL expression directly.

### 9.5 Business logic in SQL where it is faster

Logic moves into SQL where it makes a hot path faster. The candidates below come from the code census. Each one is built in Y3, kept only if the benchmark or the load test (§22) shows a gain, and otherwise left in TypeScript. The kept ones replace the TypeScript code; the same rule never lives in two places.

#### 9.5.1 Set-based statements instead of JavaScript loops

| Today | In SQL | Gain |
|---|---|---|
| `finance` `sellerBalancesByDay` walks back one day at a time in JS (`finance/service/reports.ts:226-259`) | one query: daily per-bucket sums, then `SUM(...) OVER (PARTITION BY seller_id ORDER BY day DESC)` subtracted from today's balances | one statement instead of a loop over days |
| `search` `sumSales` reads `product_sales_daily` and bulk-writes `sales_30d` (`search/repository.ts:332`) | `UPDATE search_documents d JOIN (SELECT product_id, SUM(qty) … GROUP BY product_id) s … SET d.sales_30d = s.n` | no rows travel to Node |
| `search` `rankBestSellers` emulates row_number with `$push` + `$unwind` (`:354-372`) | `ROW_NUMBER() OVER (PARTITION BY category_id ORDER BY sales_30d DESC, product_id)` in one `UPDATE … JOIN` | one statement |
| `search` `ensureRanks` / stored ranks | one `UPDATE` with the ranking expression (weights as parameters), then `UPDATE search_document_categories … JOIN` | as today, without the update pipeline |
| `search` facets: several passes | one statement per request: a CTE of the matching ids, then `UNION ALL` of the facet `GROUP BY`s (§14.2), one round trip | fewer round trips; the 30 s cache stays |
| `reports` rebuilds (`rebuild` 400 days, `rebuildCustomers` in batches of 500) | `INSERT … SELECT … GROUP BY … ON DUPLICATE KEY UPDATE` from the module's own fact tables, in day-range batches | minutes become seconds at large volume |
| `reports` top-N sellers/products sorted in JS (`financial.ts:289,361,437`) | `ORDER BY … LIMIT n` in the aggregate query | only n rows returned |
| `support` reply-time median, gathered with `$push` and computed in JS (`support/repository.ts:329-370`) | `ROW_NUMBER()` + `COUNT() OVER` to pick the middle row(s) per seller | no arrays of every reply time |
| `sellers` latest snapshot per seller, `workqueues` queue counts, `reviews` moderation counts | `ROW_NUMBER() … = 1`; conditional `SUM(CASE …)`; `GROUP BY … WITH ROLLUP` | one statement each |
| jobs that walk all rows to update a few (shipping `detectStalled`, returns `inspectionDeadlines` …) | one guarded `UPDATE … WHERE <deadline passed> AND state = …` that returns the changed ids for the events (`SELECT … FOR UPDATE SKIP LOCKED` + `UPDATE` in batches) | no full read |

Cross-module data still comes through public APIs. A set-based statement only reads and writes its own module's tables (reports' pull from finance stays an API call).

#### 9.5.2 Stored procedures on hot locked paths

On a contended row, throughput is limited by how long the lock is held. Each statement round trip inside the transaction adds to that time (about 0.2–0.5 ms on the same server, more under load). A procedure runs the whole locked section in one `CALL`.

| Procedure | Does, in one call | Hot row it shortens |
|---|---|---|
| `inventory_reserve(p_reservation JSON)` | locks the stock levels in `(stock_item_id, location_id)` order; checks availability; updates `reserved`; inserts the reservation lines and movements; updates the summary columns (§9.3); returns the outcome per line | stock levels of popular SKUs during checkout bursts |
| `inventory_release(p_reservation_id)` | the reverse, in the same lock order | same |
| `finance_post(p_entries JSON)` | locks the seller account; computes `balance_after` for each entry; inserts the ledger rows; updates the bucket totals; returns the new balances | `finance_seller_accounts` of busy sellers |
| `audit_append(p_entries JSON)` | takes the chain lock row; reads the head; for each entry `hash = UNHEX(SHA2(CONCAT(prev_hash, canonical_json), 256))`, where TypeScript builds the canonical JSON as today; inserts; returns seq and hash | the single `audit:chain` lock that every audited action passes (§11.2) |
| `kernel_claim_job(p_name, p_now, p_lease_s)` | `SELECT … FOR UPDATE SKIP LOCKED` + `UPDATE` to active, as §12, in one call | job queue under many workers |
| `promotions_redeem(p_lines JSON)` | the guarded budget, usage and flash-stock updates for a whole order, all or nothing | promotion counters in flash sales |

Rules for every procedure:

- **One module.** It is named `<module>_<name>`, touches only its module's tables, and is called only from that module's repository (`tx.call('inventory_reserve', input)`, a new `ModuleStore.call` that runs `CALL` on the transaction's connection and reads the result set). `check:boundaries` checks the table names in its body.
- **Inside the transaction wrapper.** The procedure never starts or commits a transaction itself. A deadlock or lock timeout inside it is retried by the wrapper like any other statement (§10.3). Events are still published by TypeScript after the commit, from the procedure's returned rows.
- **Errors as codes.** It refuses with `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'INSUFFICIENT_STOCK'` (a spec error code). The kernel maps such a message to the same `AppError` the TypeScript code throws today, so API responses do not change.
- **Plain inputs.** Input is one JSON argument plus scalars, read with `JSON_TABLE`. Results are a result set whose columns are named like the row types.
- **Behaviour parity.** The module's existing tests run unchanged against the procedure. Y3 adds a parity test: the old TypeScript path and the procedure on the same seeded data give the same rows.

#### 9.5.3 Triggers for summary columns

Where a summary column (§9.3) is written on a hot path, an `AFTER INSERT/UPDATE/DELETE` trigger keeps it exact in the same statement, so the repository makes one write instead of two:

- `inventory_stock_items` totals from `inventory_stock_levels`;
- `reviews_questions.answer_count` / `max_helpful` from answers and votes;
- `media_assets.usage_count` from usages.

Each trigger is written in the spec, owned by its module, and covered by the module's tests. A table whose child rows are removed by an `ON DELETE CASCADE` foreign key never gets such a trigger, because MySQL does not fire triggers for cascaded deletes; the generator refuses that combination. If a trigger shows no gain in Y5, the summary column is kept by the repository instead (§9.3).

#### 9.5.4 How SQL routines are stored and shipped

- **In the spec**, like tables and views:
  - each module's JSON gets `routines` (`{ "name": "inventory_reserve", "kind": "procedure", "file": "sql/inventory_reserve.sql", "desc": "…" }`) and `triggers`;
  - the SQL bodies live in `backend/src/modules/<module>/sql/*.sql`, next to the repository that calls them, with comments explaining the rule.
- **Applied by `npm run migrate`**: MySQL 8.0 has no `CREATE OR REPLACE PROCEDURE`, so a changed routine is dropped and recreated (by hash, in `kernel_migrations`). Routines are created with `SQL SECURITY INVOKER`.
- **Configuration**: `log_bin_trust_function_creators = ON` (§20). With the binary log on, MySQL otherwise refuses to create functions for a user without SUPER.
- **Backups**: they already include them (`mysqldump --routines --triggers`, §21.3).
- **Contract and docs**: the contract suite checks every routine and trigger exists with the spec's hash. `docs/api/db/<module>.sql` shows them, and MAINTAINING.md gets "reading and changing a stored procedure".
- **Versions**: everything used here (`JSON_TABLE`, `SIGNAL`, window functions, `SHA2`) is in 8.0.36, 8.4 and later (§20.1).

---

## 10. Kernel data layer (`src/kernel/mysql/`)

### 10.1 Files

| File | Holds | Replaces |
|---|---|---|
| `index.ts` | pool, `MysqlStore` (transaction with retry, counters, `module()`, kernel tables), `connectMysql` (URL, or the portable server in dev/tests) | `kernel/mongo/index.ts` |
| `module-store.ts` | `ModuleStore` (`table()`, `db` Kysely typed to the module's tables, `transaction`, `lock`, `claim`, `seen`, `nextValue(s)`; `call` for the module's stored procedures comes with §9.5.2). Its own file rather than part of `index.ts`, as the MongoDB one was: it is the only place that touches `kernel_locks` and `kernel_processed_events`, and the Kysely wiring below is a page of its own | `kernel/mongo/index.ts` |
| `table.ts` | `Table<R>`, with the same method names as today: get, findOne, find, getMany, count, exists, distinct, page, pageQuery (was pageAggregate), insert, insertMany, insertIfAbsent, insertManyIfAbsent, upsert, upsertMany, increment, update, updateOne, updateMany, delete, deleteMany | `kernel/mongo/table.ts` |
| `where.ts` | `Where<R>` → SQL with SQL's own null rules (the `whereFilter` meanings move unchanged), plus `or`, `contains`, `startsWith`, `equalsIgnoringCase`, `memberOf`/`allMembersOf`, and `raw` for a condition `Where` has no shape for. No `likePattern`: the `like` condition is MySQL's own `LIKE` | `kernel/mongo/filters.ts` |
| `schema.ts` | `migrateMysql`: desired DDL from the spec vs `information_schema`, applying additive changes online; data migrations; hashes in `kernel_migrations` | `kernel/mongo/schema.ts` |
| `kernel-tables.ts` | DDL of the kernel tables (§12) | `kernel/mongo/schemas.ts` |
| `errors.ts` | `isDuplicateKey` (1062) with the key name, `isDeadlock` (1213), `isLockTimeout` (1205), `isConnectionLost` | |
| *(not in this folder)* | the three kernel services that are not data access — `mysqlRateLimitStore`, `mysqlIdempotencyStore`, `mysqlWebhookEventLog` — are written **beside their MongoDB twins** in `kernel/auth/rate-limit.ts`, `kernel/http/idempotency.ts` and `kernel/auth/chain.ts`, under the interface both implement. The contract tests then run over both stores with `describe.each`, which is what holds them to the same promises, and Y4 deletes one function per file rather than a folder | |
| `portable.ts` | finds and starts a private `mysqld` (dev/tests, D9) | `binary.ts` + mongodb-memory-server |

### 10.2 Connection and pool

- mysql2 pool, one per process.
  - `connectionLimit` from `MYSQL_POOL_SIZE` (default 30), `waitForConnections: true`, `queueLimit: 0`, `connectTimeout: 10s`. An acquire that waits more than 5 s logs a warning ("pool exhausted"), shown in the same log as `TX_SLOW_MS`.
  - Version check on the first connection: 8.0.36 or later, never 8.0.29 (§20.1).
  - Session setup on every new connection: `SET time_zone='+00:00', transaction_isolation='READ-COMMITTED', sql_mode=<§20>, innodb_lock_wait_timeout=10`.
  - Options: `dateStrings: ['DATE']` (DATE stays a string; DATETIME becomes a Date), `supportBigNumbers: true`, `decimalNumbers: false`, `charset: 'utf8mb4'` plus the session statement below, `namedPlaceholders: false`, **`timezone: 'Z'`**. They live together as `CLIENT_OPTIONS` in `kernel/mysql/portable.ts`, beside the charset constants and for the same reason: a connection that differs in any of them reads and writes different values from the same bytes.
  - **`timezone: 'Z'` is not a nicety** (found 2026-10-27, building `table.ts`). mysql2 turns a JS `Date` into a DATETIME **in the host's local time** and reads it back the same way, so a round trip on one connection always agrees with itself — which is exactly why nothing would have caught this. What is *stored* does not agree: on a UTC+9 machine a `12:00Z` timestamp was written as `21:00`, nine hours in the future to `NOW()`, to every date function, to `WHERE at < NOW()` in every job, and to every report that groups by day — the session is `time_zone = '+00:00'`. Two connections that disagree about the host's offset also disagree about the value. It would have been invisible in development on a UTC server and wrong on a machine that is not, or the other way round. There is a test that stores one timestamp and reads `DATE_FORMAT` of it back.
  - `TINYINT(1)` → boolean and the `Uint8Array` of a `bytea` column are converted by `Table` from the generated `TableDef`, not by a connection `typeCast`. The def knows which columns they are; `typeCast` would have to guess from the field's width, and mysql2 ignores it for prepared statements, so the conversion would quietly stop happening the day a query moved to `execute()`. JSON needs nothing on the way out (mysql2 parses it) and stringifying on the way in (below).
  - **Charset and collation take two steps, not one** (found 2026-10-27, building `portable.ts`). This row first read `charset: 'utf8mb4_0900_bin'`. That cannot work: the handshake carries the collation as a **single byte**, and `utf8mb4_0900_bin` has id **309**, so mysql2 throws `ERR_OUT_OF_RANGE` before it reaches the server. `utf8mb4_0900_ai_ci` is id 255 and fits, which is exactly why the default never shows the problem and why this would have been found only at the first connection. So a connection is opened with `charset: 'utf8mb4'` and then run `SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin`, which gives `collation_connection = utf8mb4_0900_bin` and makes `'ABC' = 'abc'` false as §5.2 requires. Both constants live in `kernel/mysql/portable.ts` (`CONNECT_CHARSET`, `SESSION_COLLATION`) so the pool, the tools and the tests cannot drift apart, and a test asserts the one-step form still throws — if mysql2 ever widens the field, that test fails and this can be simplified. **Every connection must run it:** without it, string literals compare case-insensitively and §5.2's rules silently do not apply to them.
  - The pool keeps mysql2's default `CLIENT_FOUND_ROWS`, so `affectedRows` counts **matched** rows, which is what `updateMany` returns today (`matchedCount`). Confirmed on the server: an `UPDATE` that sets a column to the value it already holds answers 2 for two matched rows, with `changedRows` 0.
- Statements outside a transaction run on any pooled connection. A transaction takes one connection for its whole life. The total of all processes' pools must stay below `max_connections` (§20).

### 10.3 Transactions

`store.transaction(fn)`, as today:

1. Take a connection, `START TRANSACTION` (READ COMMITTED), run `fn(txStore)`, `COMMIT`.
2. On **deadlock (1213)** or **lock wait timeout (1205)** (with `innodb_rollback_on_timeout=ON` the whole transaction is rolled back, so re-running is safe): roll back and run `fn` again. Up to 5 attempts, with a jittered backoff of 20–200 ms. When they are used up, answer 503 `SERVICE_BUSY` (D8).
3. On a **connection lost during COMMIT** (the outcome is unknown, like MongoDB's `UnknownTransactionCommitResult`): run again only where `fn` is idempotent through a natural key or `claim()`, which is already the rule for consumers and jobs. Otherwise report the error.
4. The rules stay: only the database inside `fn`, never providers; events published after the commit; one statement at a time on the transaction's connection (no `Promise.all` inside); a nested `transaction` call joins the outer one.
5. Logging stays: a transaction slower than `TX_SLOW_MS` or retried logs `slow or retried transaction` with the module, ms, attempts **and the MySQL error** (deadlock or timeout), so hot rows show in the log.

### 10.4 What each `Table` operation becomes

| Today (MongoDB) | MySQL |
|---|---|
| `get(id, {forUpdate})` | `SELECT … WHERE id = ? FOR UPDATE` (inside a transaction; outside, a plain read as today) |
| `find(f, {forUpdate, sort, limit})` | `SELECT … WHERE … ORDER BY … LIMIT … FOR UPDATE`; for several rows the sort is by primary key unless the caller gives a lock order (§11.2) |
| `nullsLast` | `ORDER BY col IS NULL, col` (no aggregation needed any more) |
| `collation: CASE_INSENSITIVE` | the column is `as_ci` already; ad-hoc: `COLLATE utf8mb4_0900_as_ci` |
| `page()` keyset | `WHERE … AND (col < ? OR (col = ? AND id < ?)) ORDER BY col DESC, id DESC LIMIT n+1` (same cursor values) |
| `page()` page mode | `SELECT COUNT(*)` + `LIMIT/OFFSET` (two statements; parallel outside a transaction, as today) |
| `pageAggregate(pipeline, key)` | `pageQuery(kyselyQuery, key)`: a Kysely select that computes `key` (`COALESCE(due_at, '9999-12-31')`), wrapped as a derived table and keyset-paged on `(key, id)`; page mode counts the same derived table |
| `insert`, `insertMany` | `INSERT … VALUES (…),(…)` in batches of 500 rows. An identity column is `AUTO_INCREMENT`, not a kernel counter: `insert` reads the number back from `insertId`, and a multi-row insert gets a contiguous block from it (checked on the server). A JSON column is `JSON.stringify`d first — mysql2 expands a bound array into a value list and an object into `key = value` pairs, so an array column bound directly fails with "column count doesn't match value count" |
| `insertIfAbsent(row)` | `INSERT`; on duplicate key (1062) return undefined. In MySQL a duplicate-key error fails **only the statement**, not the transaction, so the "never insert-and-catch" rule from MongoDB goes away — and with it the whole pre-read of every unique index, which also closes the window between the check and the write. With `key`, a duplicate on a different unique key is re-thrown (the error names the key) |
| `insertManyIfAbsent` | **one statement per row**, not a batch. A multi-row `INSERT … ON DUPLICATE KEY UPDATE` would be one round trip, but `affectedRows` cannot then say how many rows were new: under `CLIENT_FOUND_ROWS` a row that was inserted and a row that was found both count 1. Where the count is not wanted, `insertMany` is the batch |
| `upsert(row, {key})` | one `INSERT … ON DUPLICATE KEY UPDATE col = new.col …` (row alias syntax, 8.0.19+) when `key` is the only unique key the row could break. **An `AUTO_INCREMENT` primary key the row leaves blank is never at risk** — the number it gets is new — so this covers more of the 149 two-key tables than the row first assumed: the common shape (identity id + one business key) takes the one statement. Otherwise: `SELECT … FOR UPDATE` on `key`, then UPDATE or INSERT. On that path a 1062 is only treated as "someone else inserted it, so update" when the error names `key`'s own index; a clash on a *different* unique key is raised. Swallowing it would be the worst outcome — the `UPDATE … WHERE key` that followed would match nothing and the upsert would answer "done" having written nothing. `key` must be a declared unique key, or `upsert` refuses before touching the server |
| `increment(key, {n})` | `INSERT … ON DUPLICATE KEY UPDATE n = n + new.n`, then the row is read on the same connection. Where the exact new value matters (counters, refs, rate limits): `n = LAST_INSERT_ID(n + ?)` + `SELECT LAST_INSERT_ID()`, which is atomic per connection |
| `updateOne/update/updateMany` with `$set` | `UPDATE … SET … WHERE …`. `updateOne` is **three statements in a transaction**: `SELECT … ORDER BY … LIMIT 1 FOR UPDATE` to find and hold the row, `UPDATE … WHERE <primary key>`, then a read of it. Not `UPDATE … LIMIT 1` followed by a re-read of the same filter — the update may be the very thing that stops the filter matching (a status change), and without the lock the row read back could be someone else's write. The lock is the one §11.2 wants anyway |
| `$inc` | `SET n = <table>.n + ?` — the table name is not optional. `INSERT … ON DUPLICATE KEY UPDATE` brings the row being inserted into scope under an alias, so a bare `n` in `n = n + ?` is **ambiguous** and MySQL refuses the statement rather than guessing (this is how `increment` was caught). So an expression in a patch is a function of the table it reads from, and `inc`, `decToZero` and `jsonAppend` write the name in |
| `$expr` caps (promotions, advertising) | `UPDATE … SET used = used + ? WHERE id = ? AND used + ? <= cap` and check `affectedRows` |
| update pipelines (`$max(x - n, 0)`, `$min`, `$concat`) | SQL expressions: `GREATEST(x - ?, 0)`, `LEAST(a, b, c)`, `CONCAT(...)` |
| `distinct(field, f)` | `SELECT DISTINCT` |
| `aggregate(pipeline)` | Kysely select with GROUP BY / JOIN / window functions (§13) |
| `$merge` with compare-and-set (search) | `INSERT … SELECT … ON DUPLICATE KEY UPDATE … IF(old._read = new._read, …)`, or a keyed UPDATE … JOIN |
| `bulkWrite` of upserts | multi-row `INSERT … ON DUPLICATE KEY UPDATE`, 500 rows per statement |

### 10.5 Filters in repositories

Repositories pass MongoDB filter objects today (`{ status: { $in: [...] }, $or: [...] }`). These become:

- **simple filters**: the kernel's `Where<R>` (it already exists in `filters.ts`, with SQL meanings: `null` = IS NULL, a list = IN, `{op:'<>'}` skips NULL, `not in`, `between`, `like`), plus `or: Where<R>[]`. It is typed by the row type, so a misspelt column fails to compile;
- **joins, aggregates, JSON paths, CASE expressions**: Kysely directly (`tx.db.selectFrom('orders_orders')…`). Raw SQL uses the `sql` tag with bound parameters only; string concatenation of values is never allowed (`check:boundaries` flags it).

### 10.6 Boundaries

- `ModuleStore.db` is a Kysely instance typed with **only that module's tables and views** (the generated `src/spec/<module>.ts` exports `<Module>Tables`). A query on another module's table does not compile.
- **Inside a transaction, `db` is built on a pool of exactly one connection: the transaction's** (built 2026-10-27). Kysely takes a connection from a pool per statement, so a `db` built on the real pool would open a *second* connection and see none of the transaction's uncommitted work — and worse, its own writes would commit outside it and survive a rollback. Both are in the tests. Two details make it work: Kysely wants mysql2's **callback** pool, which `mysql2/promise` keeps one level down (`pool.pool`, `connection.connection`, neither in the published types), and the one-connection pool must pass on only the handful of members Kysely asks for — handing it the connection itself lets it `release()` the transaction's connection mid-transaction, and wrapping it in a clone or a prototype breaks mysql2's internals. `release` and `end` do nothing: the connection goes back to the real pool when the transaction ends.
- The pool's `SET NAMES … COLLATE utf8mb4_0900_bin` reaches Kysely's connections because it uses the same underlying pool, whose `connection` event runs the session setup. A test asks six connections at once what `@@collation_connection` is, rather than one — one connection has been set up by hand since the version check, so asking once passes even when the hook is gone.
- `check:boundaries` adds two checks:
  - no `sql` string in `src/modules/<m>/` names another module's table prefix;
  - no `kernel_` table is used outside the kernel.
- Tests that read another module's tables (e.g. `checkout/test/credit.test.ts`) keep going through `app.kernel.mysql.module(name)`, as they do today with `app.kernel.mongo.module`.

---

## 11. Concurrency: keeping today's guarantees on InnoDB

### 11.1 Why this needs care

MongoDB transactions read from a snapshot, and **abort the second writer** of a document (a write conflict), which the wrapper retries. A read-modify-write without a lock is therefore still safe on MongoDB. The second transaction re-runs and reads the new value.

InnoDB does the opposite: the second writer **waits** for the first to commit and then writes over it. Under READ COMMITTED or REPEATABLE READ, an UPDATE that sets a value computed from an earlier unlocked SELECT silently loses the first transaction's change.

### 11.2 Rules (written into BUILDING-MODULES.md)

1. **Every read whose value is written back** inside a transaction uses `forUpdate` (or `lock()`), or the write is atomic in SQL (`SET n = n + ?`, `SET x = GREATEST(x - ?, 0)`, or a guarded `WHERE` with an `affectedRows` check). Appendix C lists the 15 places the census found, with the fix for each. They are fixed on MongoDB in Y0, where they are latent bugs for the reads made outside a transaction.
2. **A detector proves rule 1.** In tests and development, `Table` records each row read in a transaction without a lock. If the same transaction later updates that row with a value, `Table` throws `UNLOCKED_READ_MODIFY_WRITE` (table, id, file:line). The full test suite and the simulator run with the detector on in Y2. **What the detector cannot see:** a read-modify-write that never opens a transaction at all. Both 2026-10-23 entries in Appendix C are of that kind. So the detector proves rule 1 inside transactions only, and Appendix C is re-read by hand whenever modules are added.
3. **Lock order stays the rule.** Rows locked together are locked in one order: by primary key, or the order a module documents. Inventory's order is reservations → their lines → stock levels sorted by `(stock_item_id, location_id)`. `find(…, {forUpdate})` without an explicit sort locks in primary-key order.
4. **READ COMMITTED.** It has no gap locks, so concurrent inserts into the same range do not deadlock (checkout under load). Phantom protection was never given by MongoDB either: check-then-insert flows rely on unique keys, `insertIfAbsent` or `lock(name)`, and they keep doing so.
5. **`lock(name)`**: `INSERT INTO kernel_locks (name, n) VALUES (?, 1) ON DUPLICATE KEY UPDATE n = n + 1`. The row lock is held until commit; a second transaction waits (MongoDB made it conflict and retry). It is used by access, audit (chain), backups and shipping.
6. **Version columns** (28 `version + 1` bumps after a locked read, and `inventory.updateLevel`'s `WHERE version = ?`) stay as they are; on MySQL they are plain compare-and-set.
7. **Short transactions.** Nothing slow inside (already the rule). `innodb_lock_wait_timeout = 10` s, so a stuck request fails within 10 s instead of 50.
8. **Hot rows** (measured in Y5) and how each stays fast:

| Hot row | Pressure | Plan |
|---|---|---|
| popular stock levels | many checkouts of one SKU | lock held only for reserve + insert (no provider calls), in one `inventory_reserve` call (§9.5.2); sorted lock order; measured at 50 checkouts/s on 1 SKU |
| `finance_seller_accounts` | every sale, fee and refund of a seller | one locked row per post, as today, in one `finance_post` call (§9.5.2); the ledger insert is append-only |
| `audit` chain (`lock('audit:chain')`) | every audited action serialises on one row | append in its own short transaction (it already runs after the action; failures are logged, never fail the request), as one `audit_append` procedure call (§9.5.2). If Y5 still shows waits, batch the appends: a queue in the process, one chain append per 50 ms |
| promotion budgets and usage counters | flash sales | atomic guarded UPDATE (`used + ? <= cap`); no read-then-write |
| `payments_intents` (added 2026-10-23) | one table now serves four purchase sources: checkout, food orders, software purchases and farm orders | no shared row to lock: each purchase gets its own intent. Two attempts at the same purchase race on the partial unique key `(purchase_module, purchase_ref_id) where status in (…)` (Appendix A), so the loser gets a duplicate-key error on its own statement, not a lock wait. That is the shape §10.4 wants for `insertIfAbsent`; the services treat 1062 on that key as "an intent is already open" |
| `kernel_counters`, `kernel_ref_counters` | every insert into an identity table, every order or return ref | taken on a **separate autocommit connection** (`LAST_INSERT_ID(value + n)`), so the row lock lasts microseconds. A number taken by a rolled-back transaction is skipped, as today ("never rolled back"). One round trip: the value `LAST_INSERT_ID(…)` was handed comes back as `insertId` on the result, so only the branch that creates the counter row needs anything else |
| identity columns (2) | | native `AUTO_INCREMENT` (`innodb_autoinc_lock_mode=2`) |

---

## 12. Kernel tables and infrastructure

| Kernel table | Columns and keys | Notes |
|---|---|---|
| `kernel_migrations` | `id VARCHAR(190) PK`, `hash`, `at` | schema hashes and data-migration ids, as today |
| `kernel_counters` | `name VARCHAR(190) PK`, `value BIGINT` | §11 |
| `kernel_ref_counters` | `(prefix, period) PK`, `value` | `MK-YYMMDD-NNNNN`, same numbering |
| `kernel_locks` | `name PK`, `n` | §11.2 rule 5 |
| `kernel_processed_events` | `(module, \`key\`) PK`, `at` + index `(at)` | `claim()` = `INSERT`; a duplicate (1062) means already claimed, and only the statement fails, so the handler's transaction goes on. Purged after 90 days (D6) |
| `kernel_idempotency_keys` | `(scope, \`key\`) PK`, request_hash, status, response_status, `response_body MEDIUMTEXT`, created_at, completed_at; index `(created_at)` | `begin` = `INSERT`, or on a duplicate `SELECT … FOR UPDATE` and compare, as today |
| `kernel_webhook_events` | `(provider, event_id) PK`, received_at; index | purge after 90 days |
| `kernel_rate_limits` | `(scope, \`key\`, window_start) PK`, window_end, count | One statement that both counts the attempt and says whether it was allowed — the busiest statement in the system, since every HTTP request passes through it. **Not** as this row first had it (`count + 1000000` as the refusal): that corrupts the stored count, permanently and by a million a time. What works, written 2026-10-27:<br>`INSERT … VALUES (…, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE count = IF(count < ?, count + LAST_INSERT_ID(1), count + LAST_INSERT_ID(0))`<br>Only the taken branch of an `IF` is evaluated, so `LAST_INSERT_ID` ends up 1 for allowed and 0 for refused, a refused attempt adds nothing (the rule MongoDB kept), and the answer rides back on `insertId` in the same packet — no second `SELECT`. **`LAST_INSERT_ID(1)` in the VALUES is not optional**: a plain INSERT sets nothing, so the first request of a new window would be judged by whatever the last statement on that pooled connection left behind — after any refusal that is 0, and every new window would open refused. Taking it out makes four tests fail; leaving it out would have made a bug nobody could see. The existing `kernel.purge-rate-limits` job deletes ended windows |
| `kernel_jobs` | id, name, state, run_at, attempts, max_attempts, lease_until, started_at, finished_at, error, created_at; **`uq_queued ((IF(state='queued', name, NULL)))`**, **`uq_active ((IF(state='active', name, NULL)))`**, `ix (state, run_at)`, `ix (finished_at)` | same rules: one waiting and one running per job. The states are `queued`, `active`, `completed`, `failed` — the words the MongoDB runner already writes. The CHECK first said `done`, which would have been a difference between the two runners for no reason |
| `kernel_job_schedules` | `job PK`, `schedule`, next_run_at | "once across instances": `UPDATE … SET next_run_at = ? WHERE job = ? AND next_run_at = ?`, and only the instance with `affectedRows = 1` enqueues. **The `schedule` column was missing** from this row and from the DDL until the runner was written (2026-10-27): the key column was named `schedule` but held the job name, and the phrase from the spec had nowhere to live. The runner compares the stored phrase with the spec's to notice that a job's schedule has been edited — without it an edited job would keep firing on its old clock until something else happened to rewrite the row. There is a test that edits a schedule and waits for the new one |
| `kernel_job_boots` | `job_deploy PK`, at | boot jobs once per deploy |

**Job claim** (replaces `findOneAndUpdate`):

```sql
START TRANSACTION;
SELECT id FROM kernel_jobs WHERE name = ? AND state = 'queued' AND run_at <= ? ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED;
UPDATE kernel_jobs SET state='active', started_at=?, lease_until=?, attempts=attempts+1 WHERE id = ?;   -- 1062 on uq_active → already running → ROLLBACK, return null
COMMIT;
```

`SKIP LOCKED` lets many workers claim in parallel without waiting on each other. Backoff, leases, lost-run recovery, manual `runNow` and the in-process fallback are unchanged (kernel/jobs/mongo.ts → kernel/jobs/mysql.ts), and mysql-jobs.test.ts mirrors mongo-jobs.test.ts test for test, so the two runners are held to one set of promises.

**The runner's single statements are retried too**, not just its transactions (found 2026-10-27 when a deadlock escaped in a full test run and failed the call). §10.3 retries a transaction because a deadlock means "you were the victim, run it again", and an autocommit statement needs that for the same reason: several instances enqueue the same job names at once, and two INSERTs racing on the functional unique index `uq_kernel_jobs_queued` take insert-intention locks that can deadlock. Every statement in the file is safe to run again — an INSERT either inserts or finds the row (1062, which is not retryable and still means what it meant), and the updates are by primary key or guarded by the value they expect. A deadlock takes real contention to produce, so the test injects the server's answer rather than the conditions.

Two tests are MySQL's own, because the MongoDB runner has nothing to compare them with. One holds a row with `FOR UPDATE` from another connection and insists the **next** job in the same pass still runs: without `SKIP LOCKED` the claim would wait on the held row for the full `innodb_lock_wait_timeout` and the whole queue would wait with it (checked by taking `SKIP LOCKED` out — the test then times out). The other has one instance already running a job and insists a second instance treats the 1062 on `uq_active` as "someone else has it" rather than as an error.

**TTL indexes → one purge job.** `kernel.purge-expired` runs every 10 min and replaces MongoDB's TTL monitor. Each table is purged in batches (`DELETE … WHERE created_at < ? ORDER BY created_at LIMIT 5000`, repeated until fewer rows are deleted), so locks stay short and replication-friendly:
- idempotency keys after 24 h;
- webhook events after 90 d;
- finished jobs after 7 d;
- job boots after 90 d;
- processed events after 90 d (D6).

Module purges (audit retention, logs) keep their own jobs.

**Revocation polling** (every 3 s, three range queries on `identity_sessions.revoked_at`, `guest_sessions.claimed_at`, `accounts.tokens_valid_after`) uses the indexes from Appendix A, so each poll is an index range read.

**Live notices across processes.** Today one process serves the SSE streams. MongoDB change streams were the documented path to scale out; MySQL has no change streams. If the API ever runs as several processes, each process polls `notifications_notices` for `id > last_seen` every second (an index range read, since UUIDv7 ids are time-ordered) and feeds its own `LiveHub`. This is not needed for the current one-process deployment and is only written down here.

---

## 13. Translating module data access

### 13.1 Pattern table (applies to every module)

| MongoDB pattern (census count) | SQL |
|---|---|
| `$lookup` as EXISTS filter (orders `#lookupAny` ×7, finance ×3, media ×3) | `WHERE EXISTS (SELECT 1 FROM … WHERE … )` with an index on the join key |
| `$lookup` + `$unwind` join (≈ 20) | `JOIN`, or a §9.2 view where repeated |
| `$group` (≈ 150) | `GROUP BY`; multi-level groups used for distinct counts → `COUNT(DISTINCT …)` |
| `$facet` (3 + pageAggregate) | separate statements, run in parallel outside a transaction, or `WITH base AS (…)` + `UNION ALL` of grouped selects |
| `$setWindowFields` row_number (sellers:279) and the emulation (search:361) | `ROW_NUMBER() OVER (PARTITION BY … ORDER BY …)` in a CTE |
| "latest row per key" (`$sort` + `$group $first`) | `ROW_NUMBER() … = 1`, or `JOIN (SELECT key, MAX(at) …)` with an index on `(key, at)` |
| `$dateToString`/`$dateTrunc` with a time zone | stored market-day columns where they exist (`day DATE` in facts); else `DATE(CONVERT_TZ(at, '+00:00', ?))` after a loose index range on `at` (as `sellerSalesByDay` does today); weeks: `day - INTERVAL WEEKDAY(day) DAY`; months: `DATE_FORMAT(day, '%Y-%m-01')` |
| `$expr` comparing two columns (≈ 25) | plain `WHERE a < b` |
| regex search on a column (≈ 60 sites) | `contains()` → `LIKE` (as_ci), or FULLTEXT where the spec has one |
| `$regexMatch` with `$concat` (customers:129) | FULLTEXT ngram on (first_name, last_name, email) |
| `$push` / `$addToSet` as accumulators (orders:286, promotions:169, support:346) | `JSON_ARRAYAGG(...)`, or a GROUP BY read and grouping in JS (support's reply-time median is computed in JS already) |
| array rewrite in code (`serial_numbers`, `reasons`) | unchanged read-modify-write under the parent's row lock (rule 11.2.1) |
| `distinct` (≈ 100) | `SELECT DISTINCT`, with an index whose leftmost column is the distinct field where the table is large |

### 13.2 Notes per heavy module (from the census, ordered by work)

- **search**: a redesign (§14).
- **finance** (17 aggregations, 12 lookups, 2 paged aggregates). Joins and EXISTS map one to one.
  - Add `day DATE` (market day, set by finance at insert) to `finance_ledger_entries` with an index `(seller_id, day)` and `(type, day)`. `dailyTypeSums` then groups by an indexed column instead of converting time zones per row.
  - The admin seller list (`finance:173-201`) becomes one keyset query with EXISTS filters.
  - `sellerBalancesByDay` stays the same JS walk.
- **reports** (16 aggregations, 21 `$group`).
  - `bumpDaily` becomes `INSERT … ON DUPLICATE KEY UPDATE sales = sales + new.sales, first_at = LEAST(first_at, new.first_at)`; `replaceDay` becomes DELETE + multi-row INSERT in one transaction.
  - `salesAgg`'s three-level groups become `COUNT(DISTINCT order_id), COUNT(DISTINCT customer_key)`.
  - Add `placed_day`, `paid_day`, `delivered_day`, `completed_day` (`DATE`, market time, set at insert) to `fact_order_items`, with indexes `(seller_id, placed_day)`. The bucket filters then run on indexes. A change of market time zone triggers the existing `rebuild`.
- **orders** (4 paged aggregates, `#lookupAny`, JSON snapshot search):
  - the views from §9.2;
  - generated columns `item_title` (from `product_snapshot.title`, FULLTEXT ngram), `seller_sku` and `category_id`;
  - `contact_email` uses the `as_ci` collation.
- **inventory**: the summary columns from §9.3 replace the nested lookup. `StockTx.lock` becomes `SELECT … FROM inventory_stock_levels WHERE (stock_item_id, location_id) IN (…) ORDER BY stock_item_id, location_id FOR UPDATE`. The version compare-and-set stays.
- **promotions and advertising**: guarded atomic UPDATEs (Appendix C, §10.4). The clamps become `GREATEST(x - ?, 0)`.
- **purchasing**: three chained lookups become one view plus GROUP BY. Its 8 `distinct` and 8 regex sites get indexes or `contains()`.
- **reviews**:
  - `$facet` moderation counts become one `GROUP BY queue, content_type WITH ROLLUP`;
  - the questions page uses the summary columns;
  - `recomputeSellerSummary` becomes one GROUP BY.
- **notifications**: the inbox view; unread counts via `COUNT(*)` on `(account_id, read_at)`; 10 `updateMany` become UPDATEs.
- **sellers**:
  - `ROW_NUMBER` for the latest N snapshots;
  - generated columns on `performance_snapshots.metrics->'$.dispatch_reliability.value'` (the admin list filter);
  - application JSON paths (Appendix B).
- **audit**:
  - `search_words` gets a multi-valued index;
  - the chain append stays under `lock('audit:chain')`;
  - `seq` is a counter;
  - the old no-op `audit.prepare-partitions` job stays a no-op unless partitioning is adopted (§22.4).

**The six Departments modules (added 2026-10-22, read into this plan on 2026-10-23).** None of them needs a pattern that §13.1 does not already list: their 18 new `$group` sites are plain counts, one "best row per key" and one two-level group. They write no search documents (`departments` only *reads* `search.getProductCards(ids)`, already batched), so §14 is untouched.

- **departments** (23 tables, the largest of the six; about 680 lines of repository). Its 13 `$group`s are counts per key → `GROUP BY`. Two to watch:
  - `bests()` (`repository.ts:618`) is `$sort` + `$group $first` → `ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY score DESC, played_at) = 1`. The existing indexes on `scores` are `(game_id, week, score)` and `(game_id, day, score)`; add `customer_id` and `played_at` to them, or accept a filesort on a week's rows;
  - `weekPlayerCounts()` → `COUNT(DISTINCT customer_id) … GROUP BY game_id`.
  - The four counters on `blog_posts` and `blog_replies` are §9.3 summary columns, and two of their writers need the Appendix C fix.
  - `contains()` search boxes on `blog_posts (title, summary)`, `phones (title)` and `companies (name, tagline, city)` are `LIKE` with the `as_ci` collation: these are staff-kept catalogues well under the 20k rows of §7.6, so no FULLTEXT. Revisit if the companies directory grows.
  - `prize_awards.rank` is a MySQL reserved word (Appendix E).
- **services**: the only new JSON-path query in the six, `requests.contact.name` / `.phone` regex (`repository.ts:156`) → Appendix B. Six `forUpdate` reads, no aggregation beyond two counts.
- **software**: `apps.platforms` is the 17th array column (plain JSON, §8.1). `rails.limit` and `apps.databases` are reserved words. Purchases search on `ref` → `LIKE`. Entitlements and purchases use `claim()` for the payment events, so they follow the §12 rule that a claim commits with its effects.
- **food**: baskets and orders map one to one. `food.geocode-restaurants` scans `WHERE lat IS NULL AND point_source <> 'staff'` on a table whose only index is `(status, position)` — a full scan of a small table, run by a job, which is acceptable; the nearby-restaurant list is D11. `baskets.lines` and `orders.lines` are reserved words.
- **rewards**: a points ledger in miniature. `accounts.balance` is written with the atomic increment of §10.4 and `entries.balance_after` takes the value that same statement returns, so no separate read and no lock beyond the row — the `finance_post` shape of §9.5.2 is not needed at this size. `entries.dedupe_key` and `redemptions.idempotency_key` are plain unique columns, so the idempotent point adjustment is `INSERT` + catch 1062. `progress.count + 1` already reads with `forUpdate` (rule 11.2.1 satisfied), and its `refs` array is rewritten under that same row lock.
- **farm**: two tables, nothing unusual; the nearest-dealer list is D11.

---

## 14. Search engine on MySQL (`SEARCH_ENGINE=mysql`)

The engine contract (`search/ports.ts`), its contract tests (`search/test/engine-contract.ts`), the service and the OpenSearch engine stay. A new `mysql-engine.ts` replaces `mongo-engine.ts`. The read model is written in the same transactions as today (`upsertDocument`).

### 14.1 Tables

| Table | Key and indexes | Replaces |
|---|---|---|
| `search_documents` (one row per product) | PK product id. Columns: slug, title, title_norm, brand_id/name, category_id, offer_count, featured_offer_id/price, min/max_price, on_sale, in_stock, free_delivery, same_day_cutoff, rating, rating_count, sales_30d, popularity, first_listed_at, best_seller_rank, **card columns flattened** (`card_all_offer_id`, `card_all_price`, `card_all_in_stock`, `card_all_n`, `card_in_stock_*` …), rank_all, rank_in_stock, rank_key. Indexes: `(in_stock, featured_price)`, `first_listed_at`, `(rating DESC, rating_count DESC)`, `brand_id`, `sales_30d`, `rank_key` | embedded `card_*` objects |
| `search_offers` (exists) | PK offer id; `(product_id, in_stock, price)`, `(seller_id, price)`, `(condition, price)`, `(product_id, official)` | the embedded `offers[]` copy. Offer filters become `EXISTS (SELECT 1 FROM search_offers o WHERE o.product_id = d.id AND …)` |
| `search_terms` | PK `(stem, product_id)`, index `(product_id)`; column weight | `terms[{t,w}]` + wildcard index |
| `search_document_categories` | PK `(category_id, product_id)`; `(category_id, rank_in_stock DESC, product_id)`, `(category_id, rank_all DESC, product_id)` | `category_path_ids` + the rank indexes |
| `search_document_attributes` | PK `(attr_key, value_norm, product_id)`; `(product_id)`; value as displayed | `attributes` map + wildcard index |
| `search_gtins` | PK `(gtin, product_id)` | `gtins[]` |
| `search_title_words` | PK `(word, product_id)` | `title_norm` regex `(^\| )x` for typo candidates and known prefixes |
| `suggestion_terms` (exists) | `(term)`, `(kind, weight DESC)`; plus `suggestion_term_words (word, term_id)` for word-start matches | regex on term |

`STORE_CARDS` (recomputing card offers from the embedded array in an update pipeline) becomes a TypeScript function `cardsOf(offers)` called in the same transaction that writes the offers (the offers are already in memory there), followed by one UPDATE. `rank_key` invalidation and `ensureRanks` stay. `ensureRanks` updates `search_documents` and copies the ranks into `search_document_categories` in one statement (`UPDATE … JOIN`).

### 14.2 Queries

- **Text match** (AND over stems; OR within a synonym group):
  `SELECT product_id, SUM(weight) r FROM search_terms WHERE stem IN (…) GROUP BY product_id HAVING COUNT(DISTINCT stem) = k`.
  This is a derived table joined to the document filters. Relevance is `r/(r+1)`, as today. Typing prefixes use `stem LIKE 'abc%'`, an index range on the primary key.
- **Typos**: candidate words come from `search_title_words WHERE word LIKE 'w%'` (same first letter, as today) plus suggestion words. Trigram ranking stays in JS (`rankSimilar`), as do `autoCorrectBelowResults` and its count-first rule.
- **Listings without words** (category pages): the stored-rank path reads `search_document_categories` by `(category_id, rank_in_stock DESC, product_id)` with `LIMIT`/`OFFSET`, then scores only the page. This is the 50k-product case that runs in 0.17 s today.
- **Facets**: the filtered product ids are built once per request in a temporary table (`CREATE TEMPORARY TABLE` on the request's connection, in memory with `temptable`). Each facet is then a `GROUP BY` joined to it:
  - categories via `search_document_categories`;
  - brands, ratings, availability, delivery and price from `search_documents`;
  - sellers and conditions via `search_offers`;
  - attributes via `search_document_attributes`.

  Each facet still leaves out its own filter, so facets with different filters get their own id set. Identical sets are shared, as today. The 30 s facet cache stays.
- **Sorting**: score, price (the card or matched offer's price, computed in the derived table), newest, rating, best-selling, always with `id` as the last key. Offset paging and the 10,000-result window stay.

### 14.3 Acceptance

- The engine contract suite passes.
- `npm run bench:search` (1k/20k/50k products) runs both engines side by side in one process. The MySQL engine must be **no slower than the MongoDB numbers in docs/07 §8–9**: 50k products, category list ≤ 0.2 s, first-visit facets ≤ 0.7 s, two words ≤ 50 ms, suggestions ≤ 20 ms.
- If a case misses its target, it is tuned (covering indexes, precomputed facet counts per category in `catalog_listing_stats`). The fallback is OpenSearch for that deployment (D5).
- Behaviour notes carry over: the "In stock" facet counting card offers (docs/07, found but not fixed) is reproduced exactly, not fixed silently.

---

## 15. Reports and statistics

- The fact tables keep their shape, with the market-day columns from §13.2 added. Every report query becomes one SQL statement over indexed `(seller_id, day)` or `(day)` ranges. Top-N stays in JS, as today, or `ORDER BY … LIMIT n`.
- The financial statistics (docs/09: `seller.earnings`, `seller.profit_by_product`, `finance.platform_income`, `finance.seller_money`, `trading.pnl`) map one to one: `salesAgg` → GROUP BY on `fact_order_items`, `dailySums` → GROUP BY on the daily facts, `companySums`/`balanceTotals` → GROUP BY on day.
- Granularity and comparison periods are computed in TS, as today.
- **Time-zone tables.** `CONVERT_TZ` with zone names needs MySQL's time-zone tables. On Ubuntu, db-setup loads them offline with `mysql_tzinfo_to_sql /usr/share/zoneinfo`. For Windows development, a generated `deploy/mysql/timezones.sql` ships in the repo. Market-day columns mean most reports never call `CONVERT_TZ`.
- Reports read from the primary. A read replica for reports and exports is an option in §21.

---

## 16. GraphQL friendliness

GraphQL is a read layer: resolvers call module public APIs, which read repositories. Making it SQL-friendly means: no per-row queries, stable cursors, and indexes for every parent → child list.

### 16.1 Batch every field that resolves per parent (Y0, on MongoDB)

The GraphQL census found that `createBatchLoader` is used by about 30 fields, but many fields still query once per parent. Each one is a group of SQL round trips per list item once on MySQL. Appendix D lists them in priority order:
1. search card hydration (`catalog.getProduct` + `getOffer` + the category tree per card);
2. `Order.*` fields from payments, returns, support and shipping;
3. `OrderItem.returnEligibility`;
4. about 15 lazy `Seller` fields in admin lists;
5. promotion items.

Each gets a public API that takes a list of ids and answers with a `Map` (one `WHERE id IN (…)`), and the existing batch loader calls it. The "batch" functions that loop over ids one at a time (`Offer.product`/`variant`, `Seller.balance`, promotions campaign, wishlist lists) get real batch reads.

### 16.2 Batch loader rules

- `createBatchLoader` gets a **per-request cache** (the same key within one request is fetched once) and a **cap of 500 ids per statement**: larger batches are split into chunks run in parallel.
- `WHERE id IN (…)` results are re-ordered to the requested order, and missing ids map to `null` (the field is nullable, as the schema rules require).

### 16.3 Indexes for nested lists

Every parent → children list a GraphQL type exposes (`Order.items`, `Order.timeline`, `OrderGroup.shipments`, `Product.offers`, `Seller.restrictions` …) has an index `(parent_id, <its sort>)`. The generator check from §7.1 covers these.

### 16.4 Paging and cursors

- Cursors stay exactly as they are (base64url JSON of `[sortValue, id]`, `{$date}` for computed date keys, `[offset]` for offset lists). A cursor issued before the switch keeps working.
- Page mode keeps its exact `total`. On large filtered lists the `COUNT(*)` runs on the same covering index as the page. If Y5 shows a list where it costs more than 100 ms, that list gets a cached count (the facet-cache pattern, 30 s). The `total` value does not change shape.

### 16.5 Consistency

Resolvers read outside transactions, as today, so one response may combine reads from slightly different moments. That is unchanged: under READ COMMITTED each statement sees the latest commit. Per-request snapshot transactions are not used: they would hold a connection for the whole GraphQL request.

### 16.6 Cost limits

Depth 9, cost 1,500, page size 100 and a 10 s timeout per field stay. The 10 s timeout is matched by `MAX_EXECUTION_TIME(10000)` hints on GraphQL-driven SELECTs, so a runaway query is stopped in the database too.

---

## 17. Schema generation and migrations

### 17.1 Spec notation additions (FORMAT.md)

| Notation | Meaning |
|---|---|
| `varchar(n)`, `mediumtext`, `longtext` | text sizes (default rules in §5.1) |
| `uuid → table cascade` / `→ table nofk` | foreign key options (§6.2) |
| index `fulltext(a, b)` | FULLTEXT ngram |
| index `(snapshot->>'$.title' varchar(255))` | indexed generated column from a JSON path |
| index `multi(flag_kinds varchar(32))` | multi-valued index on a JSON array |
| table `"appendOnly": true` | append-only triggers (§6.3) |
| module `"views": [...]` | MERGE views (§9.2) |
| module `"routines": [...]`, `"triggers": [...]` | stored procedures, functions and summary triggers, bodies in `src/modules/<m>/sql/*.sql` (§9.5) |
| column flag `ci` | `utf8mb4_0900_as_ci` (replaces lower()/upper() index notation; the old notation stays accepted). **Written as a flag, not as `"collation": "ci"` as first planned**: table columns are a `Record<string, string>` and every other property of a column (`pk`, `unique`, `check`, `→ table`) is already a flag in that string, so a flag needed no change to the spec shape and reads the same way as its neighbours |

### 17.2 Generator (`npm run gen`)

- `tools/lib/mysql.ts` replaces `tools/lib/mongo.ts` + `mongoose.ts`. It writes:
  - per module `src/modules/<m>/schema.ts` (GENERATED): the tables' DDL objects, views and triggers;
  - `src/spec/<m>.ts`: row types (unchanged) and the Kysely table interfaces (`ColumnType<Select, Insert, Update>`);
  - `docs/api/db/<module>.sql`: readable DDL per module, for the maintainer.
- `tools/lib/tables.ts` (the parser) stays and learns the §17.1 notation.
- Checks: index key length; reserved words (quoted); functional key parts; partial-unique translation; index redundancy; foreign-key indexes; view mergeability; table name collisions.

**Applied to a real server, 2026-10-27.** `npm run check:ddl` generates the whole schema from the spec and creates it on a throwaway database, because a generated string can look perfect and still be refused. The result: **471 of 471 tables, 1,568 indexes, 329 foreign keys, 161 CHECK constraints and 10 append-only triggers, every statement accepted** by MySQL 8.4.13.

It did not pass first time, and the seven things it caught are worth keeping, because none would have been found by reading:

| Refused | Why, and what it changed |
|---|---|
| `access_role_assignments`, `notifications_template_versions` | A partial index carries its condition's columns, so `where status = 'active'` puts `status` in a key — but the generator only counted columns named in the index's own column list, so `status` stayed `TEXT`, which MySQL will not key without a prefix length. The condition's columns now count as indexed |
| `reports_metric_suggestions`, `support_cases` | Same cause, different route: a **foreign key column** is indexed by MySQL itself, so a `text` FK source cannot stay `TEXT`. A reference now counts as indexed |
| Nine foreign keys | The generator assumed every target keys on `id`. `access.permissions` and `access.approval_actions` key on `key`, `finance.recon_days` on `date`, `notifications.topics` on `key`. The key now follows the target's declared primary key, and a composite or surrogate target gets no single-column key and says so |
| `catalog_brand_stats` | `pk (brand_id, category_id)` with a nullable `category_id`, where NULL means "all categories". MySQL refuses NULL in a PRIMARY KEY. It now takes the invisible surrogate of §5.3 as its primary key and the declared key becomes a UNIQUE with `COALESCE` on the nullable part — the "nulls not distinct" treatment of §6.1 — so the rollup row stays unique instead of unconstrained |
| `media_usages` | `unique (asset_id, module, kind, ref_id)` came to 3,096 bytes, just past InnoDB's 3,072. §5.1's default of `VARCHAR(255)` for an indexed text column is too generous for a four-column key: `module`, `kind` and `ref_id` are now `varchar(32)`, `varchar(32)` and `varchar(64)` in the spec |
| `search_search_documents` | A plain index over `category_path_ids`, an array column. MySQL indexes JSON only through a generated column or a multi-valued index, and which one depends on the query (§8.1), so the generator emits no key and says what the spec has to decide |
| `wallet_gift_card_batches` | `where codes_ciphertext is not null` tried to put a BLOB in the key. A condition column MySQL cannot key is now left out, with a note naming Appendix A's answer — a generated `has_codes` flag, which Y2 adds with the query in front of it |

Two translations that Appendix A describes were also missing entirely and are now in: an index column written `lower(col)` or `upper(col)` becomes a plain key on the column, because on MySQL the collation does the work — and the generator **refuses** it unless the column carries `ci`, since a key on the raw column with a case-sensitive collation would quietly stop treating `ABC` and `abc` as one value. An index column written `coalesce(col, 'sentinel')` keeps the COALESCE as a functional key part, with the spec's own sentinel rather than an empty string.

`docs/api/db/<module>.sql` (40 files, 552 KB) is the readable output, each statement preceded by the decisions behind it — including every partial index whose column order Y2 should confirm with EXPLAIN.

### 17.3 Migrate (`npm run migrate`, and at start-up outside production)

- `migrateMysql` reads `information_schema` (tables, columns, indexes, check constraints, foreign keys, views, triggers) and compares it with the spec's DDL. Unchanged modules are skipped by hash, as today. One pass over `information_schema` for the whole database, not one per table.
- **A table is described in pieces, not as one `CREATE TABLE` string** (built 2026-10-27). Migrate has to answer "*which* part is missing", which a statement cannot be asked. So `TableSchema` in `kernel/mysql/schema.ts` holds the columns, primary key, keys, checks, foreign keys and triggers separately, `createTableSql` builds the statement from them, and the generator writes `docs/api/db/<module>.sql` with that same function — so what gets applied and what gets read can never drift. Turning the generator inside out this way left all 471 tables applying and 552 KB of generated SQL byte-identical.
- **What migrate believes a column says must be what the server says it is.** The diff reads our own generated column lines (`parseColumnDdl`) and compares them with `information_schema`; if those two ever disagree the diff is worthless in both directions — it would refuse a schema that is already right, or accept one that is wrong, and nothing else would notice. So `check:ddl` now reads back **every column of the whole schema** (5,640 of them) and insists migrate's reading matches the server's, type, nullability and collation. Making the desired collation *total* was the part that mattered: a column that leaves the collation to the table default had nothing to compare against until `collationOf` filled it in, so a database where that column had been altered would have passed.
- **Additive changes are applied automatically**, online:
  - CREATE TABLE / VIEW / TRIGGER;
  - `ADD COLUMN` (`ALGORITHM=INSTANT`);
  - `ADD INDEX` (`ALGORITHM=INPLACE, LOCK=NONE`);
  - adding a value to an enum CHECK (drop and re-add the check);
  - a new foreign key, once the orphan check passes.
- **Destructive or rewriting changes are never automatic.** These are dropping or renaming a column, changing a type, or narrowing a length. They are refused by name with both definitions (`SchemaRewriteNeeded`) **before anything is applied**, and need a hand-written data migration (`migrations: [{ id, up(store) }]`, recorded in `kernel_migrations`, as today). A table or column left out of the spec is reported in the result and never dropped (as MongoDB's "never drops collections"), because the thing that is not in the spec may be the thing that is right; extra **indexes** are dropped, as `syncIndexes` does today, and the primary key and the keys MySQL keeps for its own foreign keys are left alone.
- **Large tables.** `INSTANT`/`INPLACE` changes run while the API runs. A change that needs a table copy on a table over 1M rows is refused at start-up and must be run by hand in a maintenance window (MAINTAINING.md gets the recipe).
- The kernel's own tables are created if absent and not diffed: they are hand-written in `kernel-tables.ts` rather than generated from a spec, so a change to one of them is a change to the kernel and comes with its own migration.
- The 28 existing MongoDB data migrations are **not ported**: they upgraded existing MongoDB installs. On MySQL the ETL (§18) moves data already upgraded, and a fresh install starts from the seeds in code (as M2 did). They were 14 at the first census and 28 on 2026-10-23, so they are being added at roughly seven a day while the Departments work lands. Under D10 this stops mattering at the cutover: nothing reads the old database, so no migration has to have run against it. What does matter is that a change a migration made on MongoDB must also exist in the spec, or the MySQL schema will simply not have it. The generator freshness check (`npm run gen:check`) is what proves that, because a column that only a migration knows about never reaches `schema.ts`.

---

## 18. Starting empty (D10)

The owner decided on 2026-10-23 that the MySQL system **starts with no data**. Production has never gone live and no server holds real customer, order or money data, so there is nothing to preserve but the development catalogue. This removes the three largest pieces of the original plan — a read-only data audit over every collection, an ETL tool with per-table checksums, and two full rehearsals — and replaces them with a seed and a switch.

What is lost, and the one thing that is kept, is in §18.1. What a fresh install does is §18.2. The cutover is §18.3.

### 18.1 The one carve-out: the 107 real products (Y0, first task)

The development database holds 107 real products built from DummyJSON and Open Food Facts (CC BY-SA, credited in the storefront). Their import tool was removed on 2026-10-17 and only their images survive, as local files under the media root. They exist nowhere else. Starting empty would lose them, and they cannot be re-imported on a server with no internet.

So the first task of Y0 is a one-off exporter, `tools/export-catalog-seed.ts`, run **once**, against the MongoDB development database:

- it reads the catalog, offers and media rows of those products and writes `backend/src/modules/catalog/seed/real-products.json` (products, variants, attributes, offers and the media ids their images already have);
- the file is committed, so the catalogue survives in the repository rather than in a database;
- `npm run seed` (dev and demo only, never production) loads it through the public APIs, exactly as the departments and staff-ads seeders already do;
- the images need nothing: they are already files, and their ids are in the export.

Everything else in the development database — simulator people, orders, money, the departments sample data — is regenerated by `npm run simulate` and the existing seeders, so none of it is exported.

### 18.2 A fresh install

1. `npm run db-setup` creates the database, the users and the time-zone tables (§21.2).
2. `npm run migrate` creates every table, view, trigger and routine from the spec (§17.3). Foreign keys are created with the tables: on an empty database there are no orphans to clear first, which is the one place where D10 makes D4 easier.
3. The kernel seeds what it always seeds at first boot: settings defaults, permissions and roles, the Official Store, the departments and the staff ads.
4. Development and demo only: `npm run seed` adds the real products of §18.1, and `npm run simulate` adds people, orders and money.
5. `ANALYZE TABLE` on everything, then `marketly check`.

There is no verification step comparing two databases, because there is nothing to compare against. What replaces it is the ordinary gate: `npm run check` (types, boundaries, API conformance, about 9,750 tests, the HTTP checks) and `npm run simulate`, whose 20 database invariants (ledger sums equal stored balances, stock levels equal movements, coupon usage within caps, no duplicate refs, every order has its items) now run against MySQL instead of MongoDB. The audit chain is verified by `audit.verify-chain` over data the MySQL system wrote itself.

### 18.3 Cutover

With no data to move, the cutover is no longer a maintenance window with a timed ETL:

1. A final MongoDB backup (mongodump), kept offline, so the old system can be read if a number is ever questioned.
2. Stop `marketly.service`.
3. Switch `.env.production`: add `MYSQL_URL`, remove `MONGODB_URI`.
4. `npm run db-setup`, `npm run migrate`, start, then `marketly check`.
5. Staff smoke test: sign in, place an order, a seller page, reports.

Expected downtime: minutes, and bounded by `migrate` rather than by the size of the data.

**Rollback** is the same switch in reverse, and it stays genuinely cheap for as long as MongoDB is kept: the old database is left untouched and stopped (not removed) for 30 days. The difference from an ETL cutover is that nothing has to be re-moved to go back. As before, once the new system has taken real writes, go forward and fix rather than roll back.

**What is no longer needed:** `tools/mongo-audit.ts`, `tools/mongo-to-mysql.ts`, the per-table checksum compare, the orphan anti-joins, the counter and job copy, the `FOREIGN_KEY_CHECKS=0` bulk load, and the two rehearsals of Y6. Mongoose is no longer needed as a devDependency after Y4 either, because no tool reads MongoDB any more; it goes with the rest of the MongoDB code in Y4.

**What this costs, written down plainly.** The ETL would have proved, row by row, that MySQL reads back exactly what MongoDB stored — DECIMAL scale, DATETIME precision, JSON number forms, collation duplicates (§25). Starting empty gives up that proof. Three things stand in its place: the contract suite compares every table, column, type, index, foreign key, check, view and trigger against the spec (§19); the concurrency and invariant tests run on the real server (§19, §22.3); and the `varchar(n)` sizes, which the audit would have measured from real values, are instead chosen from the spec and enforced by the generator, with `STRICT_TRANS_TABLES` (§20) turning any value that does not fit into an error rather than a silent truncation. The residual risk is that a size is chosen too small and is only found when a real value hits it; §17.3's additive migrations make widening a column an `ALGORITHM=INPLACE` change, so that is a cheap mistake to fix.

---

## 19. Tests and development

**One server for the whole run** (built 2026-10-27, `testing/mysql.ts` + `testing/global-setup.ts`). Each MySQL test file first started a `mysqld` of its own on a port of its own: seven servers for seven files, all running beside the MongoDB replica set and four hundred other test files, and two such files could never run at the same time. Now global setup starts one server for the run (or uses `TEST_MYSQL_URL`) and each file takes a database of its own from it, named after the vitest worker slot and reused by the next file in that slot — the same arrangement `testing/mongo.ts` has. The `kernel/mysql` folder went from 34 s to 13 s, and the run stopped reporting killed workers. A machine with no MySQL yet still runs the MongoDB tests: the failure is handed to `testing/mysql.ts` and only the MySQL tests fail, with the reason.

- **Portable server (D9).** `kernel/mysql/portable.ts` looks for `mysqld` and starts a private one:
  - where it looks: `MYSQLD_PATH`; `C:\Program Files\MySQL\MySQL Server <version>\bin` (8.0, 8.4 or later; the newest found wins); `/usr/sbin/mysqld`; or an unzipped "ZIP Archive" build under `~/.cache/mysql` (offline: copy the zip once). Pointing `MYSQLD_PATH` at another unzipped version is how the 8.0 and 8.4 test runs of §20.1 are made;
  - the same version floor as the server check (§20.1);
  - first run: `--initialize-insecure` in `.data/mysql-test` (tests) or `MYSQL_DATA_DIR` (development);
  - it listens on `127.0.0.1:MYSQL_PORT` (default 3307, so it never collides with a service on 3306);
  - test server only: `innodb_flush_log_at_trx_commit=2`, `sync_binlog=0`, `skip-log-bin` for speed.

  With `MYSQL_URL` (development) or `TEST_MYSQL_URL` (tests), an installed server is used instead.
- **Test databases.**
  1. Global setup migrates a template database `t_template` once per run (hash-cached between runs).
  2. Each Vitest worker slot clones it into `t<slot>_<n>` with `CREATE TABLE … LIKE` for each table, then views and triggers, about 2–4 s for 482 tables, once per slot.
  3. Between apps, `empty()` truncates only the tables the app wrote. `Table` records written tables in test mode, so this is usually 5–40 `TRUNCATE`s with `FOREIGN_KEY_CHECKS=0`. Data migrations re-run, as now.
  4. At the end of the run, `t%` databases are dropped.
- **The contract suite** (`module-suite.ts`) compares tables, columns, types, indexes, foreign keys, checks, views and triggers with the spec, as it compares collections today.
- **Tests that read the database directly** (63 references in about 47 files) switch from `kernel.mongo.db.collection()` to `kernel.mysql.module(name).table()`/`db`. MongoDB-internal kernel tests (`mongo.test.ts`, `mongo-jobs.test.ts`, `embedded.test.ts`) are replaced by MySQL ones. New kernel tests cover:
  - deadlock retry;
  - the lock-timeout rollback;
  - duplicate key inside a transaction;
  - the unlocked read-modify-write detector;
  - `SKIP LOCKED` claims by 10 parallel workers;
  - functional partial uniques;
  - collation rules.
- **Concurrency tests** (new `src/integration/concurrency.test.ts`, on the real server):
  - 50 parallel checkouts of 1 SKU with stock 20: exactly 20 succeed, stock never negative;
  - 20 parallel coupon redemptions with cap 10;
  - 30 parallel ledger posts to one seller: balance = ledger sum;
  - 10 job workers × 100 jobs: each job runs once.
- `npm run check` stays the gate. `npm run simulate` works against `MYSQL_URL` (local only, as today).

---

## 20. Server configuration (`/etc/mysql/mysql.conf.d/marketly.cnf`, 32 GB RAM, NVMe)

```ini
[mysqld]
# connections and network
bind-address                   = 127.0.0.1
skip_name_resolve              = ON
max_connections                = 400          # Σ pool sizes of all processes + admin headroom
thread_cache_size              = 100
local_infile                   = OFF
# character set, time, strictness
character_set_server           = utf8mb4
collation_server               = utf8mb4_0900_bin
default_time_zone              = '+00:00'
sql_mode                       = ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION
transaction_isolation          = READ-COMMITTED
# InnoDB memory and I/O
innodb_buffer_pool_size        = 20G           # ~60% of RAM on a shared API+DB server
innodb_buffer_pool_instances   = 8
innodb_redo_log_capacity       = 4G            # 8.0.30+
innodb_flush_log_at_trx_commit = 1             # durable commits (money)
innodb_flush_method            = O_DIRECT
innodb_io_capacity             = 2000
innodb_io_capacity_max         = 4000
innodb_file_per_table          = ON
innodb_autoinc_lock_mode       = 2
innodb_adaptive_hash_index     = OFF           # less latch contention under many writers; 8.4's default
# locks
innodb_lock_wait_timeout       = 10
innodb_rollback_on_timeout     = ON            # a timeout rolls back the whole transaction → safe retry
innodb_deadlock_detect         = ON
innodb_print_all_deadlocks     = ON            # every deadlock in the error log (Y5 tuning)
# temp tables, sorts
tmp_table_size                 = 64M
max_heap_table_size            = 64M
temptable_max_ram              = 2G
table_open_cache               = 4000
table_definition_cache         = 2000
max_allowed_packet             = 64M
group_concat_max_len           = 1048576
# full text (ngram = trigrams)
ngram_token_size               = 3
innodb_ft_enable_stopword      = OFF
# binary log: point-in-time recovery, future replica
log_bin                        = mysql-bin
# binlog_format is not set: ROW is the default, and the variable is deprecated from 8.0.34 (§20.1)
sync_binlog                    = 1
binlog_expire_logs_seconds     = 604800        # 7 days
server_id                      = 1
gtid_mode                      = ON
enforce_gtid_consistency       = ON
# observability
slow_query_log                 = ON
long_query_time                = 0.2
performance_schema             = ON
event_scheduler                = OFF
log_bin_trust_function_creators = ON          # module stored functions with the binary log on (§9.5.4)
```

The same file works on 8.0, 8.4 LTS and later releases (D1). It contains no setting that a later version removed or deprecated (§20.1).

### 20.1 Version compatibility (D1: 8.0 or later)

The backend supports **MySQL 8.0 from 8.0.36, 8.4 LTS and later releases** with one code base, one DDL and one configuration file. The rules below keep it that way.

**Floor and start-up check.** At connect, the kernel reads `SELECT VERSION()` and refuses to start on anything older than 8.0.36, or on 8.0.29 (a release with known instant-ADD COLUMN bugs). The error message names the version found and the supported range. `npm run migrate` and `db-setup` run the same check.

**What the code relies on, and when each arrived.** Every one is at or below the 8.0.36 floor, so Ubuntu's `mysql-server-8.0` has all of them:

| Feature | Since | Used by |
|---|---|---|
| `CHECK` constraints enforced | 8.0.16 | the enum and range checks of §6.1 |
| Functional key parts | 8.0.13 | the partial unique keys of Appendix A, `IF(cond, col, NULL)` |
| Multi-valued indexes | 8.0.17 | the array columns of §8.1 |
| `INSTANT` ADD COLUMN | 8.0.12 (never 8.0.29) | `migrateMysql` adding a column online (§17.3) |
| `SELECT … FOR UPDATE SKIP LOCKED` | 8.0.1 | the job claim of §12 |
| Row alias in `ON DUPLICATE KEY UPDATE` (`AS new`) | **8.0.19** | upsert, `increment`, counters, rate limits — the newest thing used anywhere |
| `INVISIBLE` columns | 8.0.23 | the surrogate primary key of §5.3 |
| `utf8mb4_0900_bin` / `as_ci` | 8.0.0 | §5.2 |

The row alias is the one to watch: it is the newest feature in the code base and the floor exists mostly for it. The older `VALUES(col)` form it replaces is deprecated from 8.0.20, so there is no version in the supported range where both are wrong.

**Verified on a real server, 2026-10-27.** Before any kernel code was written, MySQL **8.4.13** was unzipped to `~/.cache/mysql` (D9) and every claim below was executed against it. All passed. What was proved, and why each one matters:

| Checked | Result |
|---|---|
| The Appendix A partial unique key, `UNIQUE ((IF(cond, col, NULL)))` | Two rows inside the condition collide (1062); rows **outside** it are not compared at all. This is the cleverest single translation in the plan, and it behaves exactly as §6.1 claims |
| A NULL key part is never compared | Two `payments_intents` rows with a NULL `purchase_module` coexist, while two live purchase intents on the same purchase collide. The Appendix A key added for it is correctly scoped |
| `utf8mb4_0900_bin` / `as_ci` / `ai_ci` | `ABC = abc` is false under `bin` and true under `as_ci`; `as_ci` is accent-**sensitive** and `ai_ci` is not. §5.2's whole collation argument holds |
| Duplicate key inside a transaction | Fails **only its own statement**: the two neighbouring inserts committed. This is what `insertIfAbsent` and `claim()` rest on (§25), and it is the opposite of MongoDB |
| `FOR UPDATE SKIP LOCKED` | With one session holding job 1, a second session claimed job 2. The job queue of §12 works |
| Multi-valued index on a JSON array | `MEMBER OF` matched, and `EXPLAIN` showed `key: mv_flags` — the index is **used**, not merely created (§8.1) |
| Row alias `AS new` in `ON DUPLICATE KEY UPDATE` | A counter reached 8 from 5 + 3 (§10.4) |
| `LAST_INSERT_ID(n + ?)` for an exact new value | Returned 2 after two increments — the ref-counter trick of §11.2 |
| Invisible surrogate primary key | `SELECT *` returned only the spec's columns (§5.3) |
| Enforced `CHECK` | Refused a value outside the enum list with 3819 (§6.1) |
| `COALESCE` unique (nulls not distinct) | Two NULLs counted as equal and collided (§6.1) |
| Descending index + `ROW_NUMBER` + CTE | Latest-per-key returned correctly (§7.3, §13.1) |
| `FULLTEXT ... WITH PARSER ngram` | Matched `iPhone` inside a product title (§6.1) |
| `DATETIME(3)` | Kept milliseconds (.144, .145, .146) (§5.1) |

**One practical finding for §21 and MAINTAINING.md:** the Windows `mysql` client defaults to the console code page (cp850 on this machine), and a collation expression then fails with 1253, `COLLATION 'utf8mb4_0900_bin' is not valid for CHARACTER SET 'cp850'`. Every command-line invocation needs `--default-character-set=utf8mb4`: `db-setup`, the backup and restore scripts, and any ad-hoc SQL the maintainer runs. The driver sets it already (§10.2), so this is the command line only.

**Features the plan relies on, and the version that added them** (all present in 8.0.36, 8.4 and later):

| Feature | Since |
|---|---|
| functional key parts (partial unique keys, Appendix A) | 8.0.13 |
| enforced CHECK constraints | 8.0.16 |
| multi-valued indexes on JSON arrays | 8.0.17 |
| row alias in `INSERT … ON DUPLICATE KEY UPDATE` (`AS new`) | 8.0.19 |
| invisible columns (surrogate keys) and invisible indexes | 8.0.23 / 8.0.0 |
| `innodb_redo_log_capacity` | 8.0.30 |
| `SKIP LOCKED`, window functions, CTEs, descending indexes, `utf8mb4_0900_*` collations | 8.0.1–8.0.2 |

**Avoided because a later version deprecates or removes them:**

| Avoided | Reason | Used instead |
|---|---|---|
| `VALUES(col)` in ON DUPLICATE KEY UPDATE | deprecated since 8.0.20 | row alias `new.col` |
| `mysql_native_password`, `default_authentication_plugin` | off by default in 8.4, removed in 9.0 | `caching_sha2_password` (mysql2 supports it) |
| `binlog_format`, `expire_logs_days`, `innodb_log_file_size` | deprecated or replaced | defaults; `binlog_expire_logs_seconds`; `innodb_redo_log_capacity` |
| `SQL_CALC_FOUND_ROWS` / `FOUND_ROWS()` | deprecated since 8.0.17 | a separate `COUNT(*)` (§10.4) |
| integer display widths, `ZEROFILL`, `FLOAT(M,D)` | deprecated | plain `INT`, `BIGINT`, `DECIMAL`. The exception is `TINYINT(1)`, which MySQL keeps as the boolean marker |
| the `utf8` / `utf8mb3` character set names | deprecated | `utf8mb4` everywhere |
| `MASTER`/`SLAVE` statements and variables | replaced since 8.0.22–8.0.26, removed in 8.4 | `CHANGE REPLICATION SOURCE TO`, `SHOW REPLICA STATUS` (only for the later read replica, §21.5) |
| `AUTO_INCREMENT` on FLOAT/DOUBLE, nested `SQL_CACHE` hints, the query cache | removed | nothing needed |
| behaviour that differs by version: the default of `innodb_adaptive_hash_index` (ON in 8.0, OFF in 8.4) | | set explicitly in `marketly.cnf` |

The generator's DDL check (§17.2) refuses the avoided items, so a spec change cannot bring one back.

**Upgrading later.** 8.0 → 8.4 is an in-place upgrade: stop the server, install the new package, start it (the server upgrades its data dictionary itself), then run `marketly check`. Take a backup before, and restore it once on a spare machine afterwards (§21.3). No code or spec change is needed. A move past 8.4 follows the same steps, after its release notes are checked against the table above.

**Tested on both.** The kernel tests, the contract suite and the concurrency integration tests (§19) run on **8.0 and 8.4** before Y1 ends and again before the cutover. The full module suite runs on the version the server will use.

---

## 21. Deployment, users, backups and monitoring

### 21.1 Install (`backend/deploy/linux`)

- `install.sh` installs MySQL from a `.deb` bundle copied to the offline server, replacing the MongoDB 6.0 `.deb`s:
  - **8.0**: `mysql-server-8.0` from the Ubuntu archive (`apt-get download` with its dependencies on a machine with internet);
  - **8.4 LTS or later**: Oracle's "DEB Bundle" tar for the Ubuntu release.

  `install.sh` accepts either and refuses a version below the floor (§20.1). The "Ubuntu 22.04 only" note goes: MySQL is packaged for 22.04 and 24.04.
- It installs `marketly.cnf`, restarts MySQL, then runs `db-setup` and `migrate`. `marketly.service` gets `After=mysql.service`.

### 21.2 `db-setup` (replaces replica-set initiation)

- Creates the `marketly` database (utf8mb4, `utf8mb4_0900_bin`).
- Loads the time-zone tables.
- Creates three users with `caching_sha2_password`, passwords from `.env.production`:

| User | Privileges |
|---|---|
| `marketly_app` | SELECT, INSERT, UPDATE, DELETE, EXECUTE, CREATE TEMPORARY TABLES on `marketly.*` (no DDL) |
| `marketly_migrate` | the app privileges plus ALTER, CREATE, CREATE VIEW, DROP, INDEX, REFERENCES, TRIGGER, CREATE ROUTINE, ALTER ROUTINE (used by `migrate` and at start-up outside production) |
| `marketly_backup` | SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, PROCESS, RELOAD, REPLICATION CLIENT, EVENT |

### 21.3 Backups (keeps the docs/08 flow; only the dump commands change)

- **`backup.sh`**:
  - `mysqldump --single-transaction --quick --routines --triggers --events --hex-blob --set-gtid-purged=OFF marketly | gzip > database.sql.gz` (a consistent snapshot without locking writes), plus `media.tar.gz`, `config.tar.gz` and the manifest, as today;
  - the binlog position goes in the manifest;
  - the timer, 02:30 runs and 14-day retention stay.
- **Point-in-time recovery**: the latest dump plus `mysqlbinlog --start-position=<manifest> …` up to a chosen time. The recipe goes in MAINTAINING.md. This is new: MongoDB had no point-in-time recovery here.
- **`restore.sh`**: stop the API → `DROP DATABASE marketly; CREATE DATABASE …` → load the dump → swap media → `migrate` → start.
  - The `ops.sh` dry run becomes: test the gzip, check the dump header (MySQL dump, database marketly), and load into a scratch database `marketly_restore_check`, which is then dropped.
  - The safety backup is taken before every restore, as today.
  - The two-person approval and everything in the Admin Center stay.
- **Old backups**: MongoDB archives cannot be restored after the switch. The final MongoDB backup is kept offline. The Backups page labels an uploaded archive of the wrong kind "MongoDB backup from before the MySQL move" and refuses it.

### 21.4 Monitoring

- **`check.sh`** replaces `rs.status()` with:
  - `mysqladmin ping`;
  - `Threads_connected` vs `max_connections`;
  - InnoDB history list length (a sign of long transactions);
  - deadlocks since start;
  - the slow-log size;
  - free disk on `/var/lib/mysql`;
  - backup age.
- **The app log** keeps `slow or retried transaction` and adds "pool exhausted".

### 21.5 Later scale-out (not needed now; designed for)

- A **read replica** (GTID replication is already on) for reports, exports and statistics, through `MYSQL_READ_URL`. The rule is: only explicitly marked read-only report paths use it, never a read that follows a write.
- **InnoDB Cluster** (Group Replication) for failover, if the single server becomes a risk.
- **Several API processes**: see the live-notice polling in §12.

---

## 22. Performance and load testing (Y5)

### 22.1 Data

`npm run simulate -- --scale large` plus a bulk seeder `tools/seed-volume.ts` (local only) that writes §2's volumes directly through the repositories, in batches. Seeding takes about 1–2 hours.

### 22.2 Load tool

`tools/load.ts` is offline and plain Node (undici, with workers). It runs these scenarios for 15 minutes each, then mixed:

| Scenario | Shape | Target (p95) |
|---|---|---|
| Browse | GraphQL HomePage, CategoryPage, SearchResults, ProductPage; 1,500 virtual users | ≤ 300 ms (search ≤ 400 ms) |
| Checkout burst | 50 checkouts/s, 30% on 10 hot SKUs | ≤ 800 ms; zero oversell; retries ≤ 2% |
| Seller work | 200 sellers: order lists, bulk offer updates, statements | lists ≤ 300 ms |
| Admin | 30 staff: order/seller/customer lists over the full volume, reports for 12 months | lists ≤ 500 ms, reports ≤ 2 s |
| Jobs | all 169 jobs running alongside | no job overruns its schedule |

### 22.3 Invariants checked after each run

- stock never negative, and levels = movements;
- ledger sum = balances;
- coupon and budget caps held;
- each job ran once per schedule;
- no duplicate refs;
- audit chain verifies;
- no 500s;
- 503 `SERVICE_BUSY` below 0.1%.

### 22.4 Tuning loop

`performance_schema` digests (top statements by total time), the slow log, `EXPLAIN ANALYZE` for each statement over 50 ms, and the deadlock log. Fixes go into the spec (indexes), the repository (query shape, lock order), or `nofk`.

**Partitioning is a last resort.** If a log table passes 50M rows and its purge becomes slow, that table moves to `RANGE` partitions by month. Candidates: audit entries, notification deliveries, kernel jobs, search query log. Its primary key becomes `(id, at)` and it gets no foreign keys; the purge then drops partitions. `audit.prepare-partitions` then gets its job back.

---

## 23. Phases

Each phase ends with `npm run check` green and a report. The next starts after approval (docs/MAINTAINING.md, phased workflow). Builders work in worktrees, as in M2 (at most 4 running tests at once, `--maxWorkers=2`, with progress logs).

| Phase | Work | Done when |
|---|---|---|
| **Y0 Prepare on MongoDB** (started 2026-10-23, branch `build/mysql-migration`) | 1. The catalogue exporter of §18.1, run once while MongoDB still holds the 107 real products — **before anything else**. 2. Appendix C concurrency fixes, including the two `departments/service/blogs.ts` writers found on 2026-10-23. 3. Appendix D GraphQL batching fixes + batch-loader cache and cap. 4. **Spec additions — done.** The notation (sizes, `ci`, `cascade`/`nofk`, `appendOnly`, `views`) is in `lib/tables.ts` and `spec.ts` with a test of its own, documented in FORMAT.md and rendered in the module docs. Applied where Y0 could confirm it from the code: 5 append-only tables, 2 `ci` columns, 6 cascades, 2 `mediumtext` bodies. No `nofk` (that waits for Y5 measurements) and no view SQL (Y1, §9.1). 5. Re-run the census (§0) and Appendices A, B, C and E, and keep re-running them whenever modules are added: the 2026-10-22 census went stale within two hours. D4, D10 and D11 were decided at the start of this phase; D3, D6, D7 and D8 are confirmed before Y1. | Check green on MongoDB; `real-products.json` committed and `npm run seed` reproduces the catalogue; census current; no behaviour change |
| **Y1 Foundations** | The §9.2 view SQL, written against the generator and the contract suite that prove it (§9.1). `kernel/mysql/*`: pool, transactions with retry, `Table`, `Where`, locks, claim, counters, migrate, kernel tables. Jobs on MySQL (`SKIP LOCKED`); rate limits; idempotency; webhook log; refs; purge job. Generator → DDL, Kysely types, views, triggers. Portable `mysqld`; test harness; contract suite; read-modify-write detector. During the transition a module chooses `store: 'mongo' \| 'mysql'` (as M1 did). The kernel's own tables and jobs move to MySQL first; each module's inbox claims go to the store of that module's data, so a claim always commits with its effects. Pilots: **settings, access**. | Kernel tests and the two pilots pass on MySQL **8.0 and 8.4** (§20.1); BUILDING-MODULES.md gets the MySQL section |
| **Y2 Modules in tranches** | 37 modules in seven tranches (tables in brackets). A: identity, audit, media, notifications, backups [45] · B: customers, catalog, inventory, sellers, purchasing, workqueues [91] · C: offers, promotions, cart, orders, content [56] · D: payments, shipping, checkout, messaging, reviews, finance, returns [100] · E: support, trust, advertising, reports, warehouse [71] · F: wishlist, wallet, fulfillment-service [26] · **G (new): departments, services, software, food, rewards, farm [54]**. Per module: repository rewrite, views, summary columns, tests reading tables. | Each module's tests, contract and `test:http` pass on MySQL with the detector on |
| **Y3 Search, reports, statistics, SQL speed-ups** | MySQL search engine (§14) + benchmark; reports market-day columns; finance ledger `day`; statistics queries; `EXPLAIN` review of every list; the §9.5 candidates (set-based statements, stored procedures, summary triggers), each with a parity test and a before/after measurement | Engine contract green; bench targets met; financial statistics equal to MongoDB on the same seeded data; each kept §9.5 item shows its gain, the rest stay in TypeScript |
| **Y4 Remove MongoDB** | Delete `kernel/mongo`, Mongoose (nothing reads MongoDB any more under D10, so it goes here rather than being kept for an ETL), mongodb-memory-server, the Mongo engine, Mongo env vars. Update docs 02, MAINTAINING, README, FORMAT, `.env.example`, BUILDING-MODULES, docs/08, the deploy scripts (`install.sh`, `db-setup`, `backup.sh`, `restore.sh`, `ops.sh`, `check.sh`, the `marketly` command) | Check green with MySQL only |
| **Y5 Volume and concurrency** | Seeder, load tool, scenarios and invariants (§22); tuning; the decisions on `nofk`, cached counts and audit batching | Targets met, invariants hold, deadlock retries under 2% |
| **Y6 Cutover** (was Y7; the old Y6 rehearsal is removed by D10) | §18.3 on the server: final mongodump kept offline, stop, switch `.env.production`, `db-setup`, `migrate`, start, `marketly check`, staff smoke test. The old MongoDB is kept stopped for 30 days, then removed | Server on MySQL; `marketly check` green; first nightly backup restored as a test |

Rough size: Y1 is the pattern-setting phase (like M1). Y2 is similar to M2: about 15,500 lines of repositories, done in parallel. The search engine is the largest single piece.

**Why G is its own tranche and comes last.** The six Departments modules were written after the first census and are self-contained: they depend on media, payments, customers and promotions and are depended on by nothing, so they can only follow A, C and D. Putting them in C (where `departments` was first listed, before the module existed) would have made that tranche the largest of the seven. They also share one shape — a small staff-kept catalogue, a customer-facing list and an order or request table — so one builder who has done `food` can do `services` and `farm` quickly.

---

## 24. Risks

| Risk | Mitigation |
|---|---|
| **Lost updates**: unlocked read-modify-write was safe on MongoDB (write conflicts), and is not on InnoDB | Rule 11.2.1, the Appendix C fixes first, the detector in tests and the simulator, the concurrency integration tests |
| **Lock waits and deadlocks on hot rows** | sorted lock order, short transactions, atomic guarded updates, a 10 s timeout with retry, Y5 measurements, `nofk` where foreign keys add waits |
| **Search slower than the tuned MongoDB engine** (facets especially) | child tables + per-request id set + facet cache; benchmark gate; OpenSearch fallback (D5) |
| **Behaviour drift from collations** (MySQL's default ignores case and accents) | `utf8mb4_0900_bin` default, `as_ci` only where `lower()` was used. Under D10 there is no existing data to find duplicates in, so the unique keys themselves are the check: the first insert that collides fails loudly instead of being found by an audit |
| **Values that read back differently** (DECIMAL scale, `TIME` seconds, JSON key order, `CHAR` trailing spaces, booleans as 0/1) | conversion in one place (`Table` type cast), §25 list, and the audit chain verified over data MySQL wrote itself. D10 removes the ETL checksum that would have compared the two databases row by row; §18.3 says what stands in its place and what residual risk is accepted |
| **Large `ALTER TABLE` later** | INSTANT/INPLACE-only automatic migrations; refusal + manual recipe for table copies over 1M rows |
| **MySQL 8.0 end of life** (April 2026) | D1 supports 8.0 or later: the code avoids everything later versions deprecate (§20.1), tests run on 8.0 and 8.4, and Ubuntu still patches its 8.0 package. A new server should start on 8.4 LTS; an existing 8.0 server upgrades in place |
| **Logic in SQL is harder to debug and test** (§9.5) | only where measured faster; one module per routine; parity tests; SQL bodies in `src/modules/<m>/sql/` next to their caller, commented; errors keep the spec's codes |
| **Offline maintenance** | one database, plain SQL views to inspect data, `docs/api/db/*.sql` to read, `ops_v_*` views, backups with point-in-time recovery, MAINTAINING.md recipes (deadlock log, slow log, `EXPLAIN`, adding an index, a manual ALTER) |
| **The backend keeps growing while the migration runs** (six modules and 54 tables arrived within hours of the first census; 14 data migrations in two days) | this is the normal state of the project, not an accident. Three defences: the census in §0 and Appendices A, B, C and E are re-run at the start of every phase, not once; new modules are written to the §11.2 rules on MongoDB from the start, so they arrive migration-ready; and a module added after its tranche has passed joins the next one rather than reopening it. the cutover is the only point where a late module is a real problem, so the module freeze starts when Y5 ends |
| **Test-suite speed** | template clone per worker, truncating only touched tables, a test server without fsync. Goal: the suite within 10 minutes (8.5 today, 9,757 tests in 396 files) |

---

## 25. Behaviour differences and how each is kept

| Area | MongoDB today | MySQL by default | Kept by |
|---|---|---|---|
| Text compare and sort | binary, case-sensitive | `0900_ai_ci`: ignores case and accents | `utf8mb4_0900_bin` default (§5.2) |
| NULL order | nulls first ascending | nulls first ascending | same; `nullsLast` → `col IS NULL, col` |
| Unique keys with NULL | partial filters let several nulls through | several NULLs allowed | same; `COALESCE` keys where the spec says nulls not distinct |
| Second writer | aborts and retries | waits, then overwrites | locked reads / atomic updates (§11) |
| Duplicate key in a transaction | aborts the transaction | fails the statement only | `insertIfAbsent` = INSERT + catch; claim = INSERT + catch |
| `updateMany` return | matched count | affected (changed) rows | `CLIENT_FOUND_ROWS` gives matched rows |
| Dates | ms precision | DATETIME(0) by default, and mysql2 writes a Date in the host's local time | `DATETIME(3)`, UTC session, **and `timezone: 'Z'` on every connection** (§10.2) |
| numeric | Decimal128 keeps its digits (`"12.5"`) | DECIMAL pads the scale (`"12.50"`) | the 24 numeric columns are rates, quantities and the four map points, all of which the services format themselves (`Number()`, `.toFixed(6)`). The audit chain hashes only canonical JSON of what it wrote. With D10 there is no old value to compare against, so any column where text equality matters is kept as `VARCHAR` by the spec rather than found by an audit |
| JSON objects | key order as written | keys reordered, duplicates dropped | nothing compares serialised JSON except the audit chain, which canonicalises (sorted keys) before hashing; tests compare parsed objects |
| JSON numbers | int32/int64/double | INT/UINT/DOUBLE | the same JS values |
| booleans | true/false | 1/0 | `TINYINT(1)`, converted by `Table` from the generated def rather than by a connection `typeCast` (§10.2) |
| `TIME` | `"HH:MM"` string | `"HH:MM:SS"` | type cast trims to the spec's form |
| `CHAR(n)` | trailing spaces kept | trailing spaces removed on read | only fixed-length codes use `CHAR` |
| Empty string vs NULL | distinct | distinct | same |
| Regex search `i` | case-insensitive, accent-sensitive | | `LIKE … COLLATE utf8mb4_0900_as_ci` with escapes |
| Exhausted retries | 500 | | 503 `SERVICE_BUSY` (D8: the one intended change) |
| Development without a server | embedded MongoDB | | portable `mysqld` (D9) |

---

## Appendix A: Partial, expression and GIN indexes in MySQL

The generator writes these, with every identifier quoted (`key`, `condition`, `open` …). `IF(cond, col, NULL)` makes rows outside the condition hold a NULL key, which MySQL never compares, so this is a partial unique key. Non-unique partial indexes become plain composite indexes with the condition's columns placed for index filtering. Each is confirmed with `EXPLAIN` against its query in Y2.

| Table | Spec index | MySQL |
|---|---|---|
| access.role_assignments | `(account_id) where status = 'active'` | INDEX (account_id, status) |
| access.role_assignments | `(role_id) where status = 'active'` | INDEX (role_id, status) |
| access.role_assignments | `unique (account_id, role_id) where status in ('active','pending_acceptance','pending_approval')` | UNIQUE ((IF(status IN ('active','pending_acceptance','pending_approval'), account_id, NULL)), role_id) |
| access.approval_requests | `unique (action_key, target_type, target_id) where status in ('pending','partially_approved','returned')` | UNIQUE ((IF(status in ('pending','partially_approved','returned'), action_key, NULL)), target_type, target_id) |
| access.approval_decisions | `unique (request_id, by_account_id) where decision = 'approved'` | UNIQUE ((IF(decision = 'approved', request_id, NULL)), by_account_id) |
| audit.entries | `(seller_id, at desc) where visible_to_seller` | INDEX (seller_id, visible_to_seller, at DESC) |
| audit.entries | `gin(search_words)` | JSON array + multi-valued index `((CAST(col AS CHAR(n) ARRAY)))`, or child table (§9) |
| cart.carts | `unique (customer_id) where status = 'active'` | UNIQUE ((IF(status = 'active', customer_id, NULL))) |
| cart.carts | `unique (guest_session_id) where status = 'active'` | UNIQUE ((IF(status = 'active', guest_session_id, NULL))) |
| catalog.products | `gin(search)` | JSON array + multi-valued index `((CAST(col AS CHAR(n) ARRAY)))`, or child table (§9) |
| checkout.sessions | `gin(email gin_trgm_ops)` | FULLTEXT (email) WITH PARSER ngram |
| checkout.sessions | `gin(contact_name gin_trgm_ops)` | FULLTEXT (contact_name) WITH PARSER ngram |
| customers.customers | `gin(to_tsvector(first_name || ' ' || last_name || ' ' || email))` | FULLTEXT (first_name, last_name, email) WITH PARSER ngram |
| customers.addresses | `unique(customer_id) where is_default and deleted_at is null` | UNIQUE ((IF(is_default and deleted_at is null, customer_id, NULL))) |
| finance.payout_runs | `unique (cutoff_at) where status <> 'cancelled'` | UNIQUE ((IF(status <> 'cancelled', cutoff_at, NULL))) |
| identity.accounts | `(tokens_valid_after) where tokens_valid_after is not null` | INDEX (tokens_valid_after) |
| identity.two_step_methods | `(account_id) where removed_at is null` | INDEX (account_id, removed_at) |
| identity.devices | `unique (account_id, installation_id) where installation_id is not null` | UNIQUE (account_id, installation_id) (a NULL key is never compared) |
| identity.sessions | `(account_id) where revoked_at is null` | INDEX (account_id, revoked_at) |
| identity.sessions | `(seller_id) where revoked_at is null` | INDEX (seller_id, revoked_at) |
| identity.sessions | `(previous_token_hash) where previous_token_hash is not null` | INDEX (previous_token_hash) |
| identity.sessions | `(revoked_at) where revoked_at is not null` | INDEX (revoked_at) |
| identity.invitations | `(account_id) where account_id is not null` | INDEX (account_id) |
| identity.guest_sessions | `(previous_token_hash) where previous_token_hash is not null` | INDEX (previous_token_hash) |
| identity.guest_sessions | `(claimed_at) where claimed_at is not null` | INDEX (claimed_at) |
| inventory.stock_items | `unique (owner_type, coalesce(seller_id, '00000000-0000-0000-0000-000000000000'), sku)` | UNIQUE (owner_type, (COALESCE(seller_id, '')), sku) |
| inventory.stock_items | `(service_location_id) where service_location_id is not null` | INDEX (service_location_id) |
| inventory.held_stock | `(review_date) where released_at is null` | INDEX (released_at, review_date) |
| media.uploads | `(url_expires_at) where completed_at is null` | INDEX (completed_at, url_expires_at) |
| media.usages | `(asset_id) where detached_at is null` | INDEX (asset_id, detached_at) |
| media.usages | `unique (asset_id, module, kind, ref_id) where detached_at is null` | UNIQUE ((IF(detached_at is null, asset_id, NULL)), module, kind, ref_id) |
| messaging.conversations | `unique nulls not distinct (kind, customer_id, seller_id, application_id, order_id, order_item_id, return_id, product_id) where kind <> 'support'` | UNIQUE ((IF(kind <> 'support', COALESCE(kind, ''), NULL)), (COALESCE(customer_id, '')), (COALESCE(seller_id, '')), (COALESCE(application_id, '')), (COALESCE(order_id, '')), (COALESCE(order_item_id, '')), (COALESCE(return_id, '')), (COALESCE(product_id, ''))) |
| messaging.conversations | `unique nulls not distinct (kind, customer_id, order_id, case_id) where kind = 'support'` | UNIQUE ((IF(kind = 'support', COALESCE(kind, ''), NULL)), (COALESCE(customer_id, '')), (COALESCE(order_id, '')), (COALESCE(case_id, ''))) |
| notifications.template_versions | `(template_id) where status = 'draft'` | INDEX (template_id, status) |
| notifications.notices | `gin(link jsonb_path_ops)` | generated column(s) for the queried JSON paths + index (or child table, see §9) |
| notifications.push_devices | `(account_id) where invalidated_at is null` | INDEX (account_id, invalidated_at) |
| notifications.suppressions | `unique (channel, address_hash) where removed_at is null` | UNIQUE ((IF(removed_at is null, channel, NULL)), address_hash) |
| offers.offers | `unique nulls not distinct (owner_type, seller_id, seller_sku)` | UNIQUE ((COALESCE(owner_type, '')), (COALESCE(seller_id, '')), (COALESCE(seller_sku, ''))) |
| offers.offers | `unique nulls not distinct (owner_type, seller_id, variant_id) where condition = 'new' and status <> 'removed'` | UNIQUE ((IF(`condition` = 'new' and status <> 'removed', COALESCE(owner_type, ''), NULL)), (COALESCE(seller_id, '')), (COALESCE(variant_id, ''))) |
| offers.offers | `unique (stock_item_id) where status <> 'removed'` | UNIQUE ((IF(status <> 'removed', stock_item_id, NULL))) |
| offers.offers | `gin(title gin_trgm_ops)` | FULLTEXT (title) WITH PARSER ngram |
| offers.featured_offers | `(dirty) where dirty` | INDEX (dirty) |
| orders.orders | `(lower(contact_email))` | column COLLATE utf8mb4_0900_as_ci + plain index |
| orders.orders | `gin(contact_name gin_trgm_ops)` | FULLTEXT (contact_name) WITH PARSER ngram |
| orders.orders | `gin(contact_email gin_trgm_ops)` | FULLTEXT (contact_email) WITH PARSER ngram |
| orders.orders | `gin(flag_kinds)` | JSON array + multi-valued index `((CAST(col AS CHAR(n) ARRAY)))`, or child table (§9) |
| payments.intents | `unique (checkout_session_id) where status in ('created','authorizing','requires_action','pending_check','authorized','partially_captured','captured')` | UNIQUE ((IF(status in ('created','authorizing','requires_action','pending_check','authorized','partially_captured','captured'), checkout_session_id, NULL))) |
| payments.intents (added 2026-10-23) | `unique (purchase_module, purchase_ref_id) where status in ('created','authorizing','requires_action','pending_check','authorized','captured')` | UNIQUE ((IF(status in ('created','authorizing','requires_action','pending_check','authorized','captured'), purchase_module, NULL)), purchase_ref_id). A checkout intent holds NULL in `purchase_module`, so its key part is NULL and MySQL never compares it: the key covers purchase intents only, which is exactly what the partial index means. The status list is deliberately **not** the one in the row above (no `partially_captured`); the generator writes each from the spec and the two are never merged |
| payments.refunds | `unique (origin, origin_id) where origin_id is not null and origin <> 'cancellation' and status <> 'cancelled'` | UNIQUE ((IF(origin_id is not null and origin <> 'cancellation' and status <> 'cancelled', origin, NULL)), origin_id) |
| payments.disputes | `(approval_request_id) where approval_request_id is not null` | INDEX (approval_request_id) |
| promotions.coupon_codes | `unique (upper(code)) where active` | code COLLATE utf8mb4_0900_as_ci; UNIQUE ((IF(active, code, NULL))) |
| purchasing.supplier_items | `(stock_item_id) where preferred` | INDEX (stock_item_id, preferred) |
| purchasing.receipts | `unique (delivery_id) where status = 'in_progress'` | UNIQUE ((IF(status = 'in_progress', delivery_id, NULL))) |
| search.search_documents | `gin(terms jsonb_path_ops)` | generated column(s) for the queried JSON paths + index (or child table, see §9) |
| search.search_documents | `gin(title_norm gin_trgm_ops)` | FULLTEXT (title_norm) WITH PARSER ngram |
| search.search_documents | `gin(seller_ids)` | JSON array + multi-valued index `((CAST(col AS CHAR(n) ARRAY)))`, or child table (§9) |
| search.search_documents | `gin(category_path_ids)` | JSON array + multi-valued index `((CAST(col AS CHAR(n) ARRAY)))`, or child table (§9) |
| search.search_documents | `gin(attributes jsonb_path_ops)` | generated column(s) for the queried JSON paths + index (or child table, see §9) |
| search.suggestion_terms | `gin(term gin_trgm_ops)` | FULLTEXT (term) WITH PARSER ngram |
| search.query_log | `(results, at) where results = 0` | INDEX (results, at) |
| sellers.sellers | `gin(to_tsvector(store_name || ' ' || legal_name))` | FULLTEXT (store_name, legal_name) WITH PARSER ngram |
| sellers.members | `unique(seller_id, email) where status in ('invited','active','suspended')` | UNIQUE ((IF(status in ('invited','active','suspended'), seller_id, NULL)), email) |
| sellers.members | `unique(seller_id) where is_owner and status = 'active'` | UNIQUE ((IF(is_owner and status = 'active', seller_id, NULL))) |
| sellers.payout_changes | `unique (seller_id) where state = 'pending'` | UNIQUE ((IF(state = 'pending', seller_id, NULL))) |
| sellers.payout_changes | `unique (seller_id) where state = 'verified'` | UNIQUE ((IF(state = 'verified', seller_id, NULL))) |
| settings.change_keys | `unique (key) where open` | UNIQUE ((IF(`open` = 1, `key`, NULL))) |
| shipping.dispatch_watch | `(due_at) where overdue_since is null` | INDEX (overdue_since, due_at) |
| shipping.exceptions | `unique nulls not distinct (group_id, kind, shipment_id) where status in ('open','in_progress','escalated')` | UNIQUE ((IF(status in ('open','in_progress','escalated'), COALESCE(group_id, ''), NULL)), (COALESCE(kind, '')), (COALESCE(shipment_id, ''))) |
| support.cases | `(approval_request_id) where approval_request_id is not null` | INDEX (approval_request_id) |
| support.cases | `(trust_report_id) where trust_report_id is not null` | INDEX (trust_report_id) |
| trust.reports | `unique(dedupe_key) where status in ('open','under_review','escalated')` | UNIQUE ((IF(status in ('open','under_review','escalated'), dedupe_key, NULL))) |
| trust.recommendations | `(approval_request_id) where approval_request_id is not null` | INDEX (approval_request_id) |
| trust.enforcements | `(reversal_request_id) where reversal_request_id is not null` | INDEX (reversal_request_id) |
| trust.appeals | `unique(source, external_appeal_id) where external_appeal_id is not null` | UNIQUE (source, external_appeal_id) |
| wallet.lots | `(state, expires_at) where state = 'active'` | INDEX (state, expires_at) |
| wallet.ledger | `unique (refund_id, kind) where refund_id is not null` | UNIQUE (refund_id, kind) |
| wallet.ledger | `(order_id) where order_id is not null` | INDEX (order_id) |
| wallet.ledger | `(hold_id) where hold_id is not null` | INDEX (hold_id) |
| wallet.holds | `unique (quote_id) where state = 'held'` | UNIQUE ((IF(state = 'held', quote_id, NULL))) |
| wallet.gift_card_batches | `(codes_expire_at) where codes_ciphertext is not null` | stored flag `has_codes` (generated: codes_ciphertext IS NOT NULL) + INDEX (has_codes, codes_expire_at) |
| wallet.goodwill_grants | `(approval_request_id) where approval_request_id is not null` | INDEX (approval_request_id) |
| wallet.goodwill_grants | `(ledger_entry_id) where ledger_entry_id is not null` | INDEX (ledger_entry_id) |
| wallet.credit_corrections | `(approval_request_id) where approval_request_id is not null` | INDEX (approval_request_id) |
| warehouse.bin_assignments | `unique (stock_item_id) where primary_bin` | UNIQUE ((IF(`primary_bin` = 1, stock_item_id, NULL))) |
| wishlist.lists | `unique (customer_id) where is_default` | UNIQUE ((IF(`is_default` = 1, customer_id, NULL))) |
| wishlist.items | `unique nulls not distinct (list_id, product_id, variant_id)` | UNIQUE ((COALESCE(list_id, '')), (COALESCE(product_id, '')), (COALESCE(variant_id, ''))) |
| workqueues.intake_rules | `(event) where active` | INDEX (event, active) |
| workqueues.items | `unique(dedupe_key) where state in ('open','assigned','in_progress','waiting')` | UNIQUE ((IF(state in ('open','assigned','in_progress','waiting'), dedupe_key, NULL))) |
| workqueues.items | `(deadline_state, due_at) where state in ('open','assigned','in_progress','waiting')` | INDEX (deadline_state, state, due_at) |
| workqueues.items | `(seller_id, state) where visible_to_seller` | INDEX (seller_id, visible_to_seller, state) |
| workqueues.saved_filters | `(shared) where shared` | INDEX (shared) |

## Appendix B: Queries on paths inside JSON and array columns

From the code census (2026-10-22). "Generated" means an indexed generated column (§8.2); "JSON" means a `->>` path in the WHERE clause with no index of its own (another selective filter narrows the rows first).

| Where (repository) | Table | Path / operator | Plan |
|---|---|---|---|
| search mongo-engine:40,44,107,659 | search_documents | `terms.t` equality/prefix, `gtins` | `search_terms`, `search_gtins` (§14) |
| search mongo-engine:128 | search_documents | `attributes.<key>` in (case-insensitive) | `search_document_attributes` (value_norm) |
| search mongo-engine:146 | search_documents | `offers $elemMatch`, `offers.0` exists | EXISTS on `search_offers` |
| search mongo-engine:222 | search_documents | sort on card offer price | flattened card columns |
| search repository:235,237; engine:119,593,648 | search_documents | `category_path_ids`/`seller_ids` in | `search_document_categories`; `search_offers.seller_id` |
| search repository:280,285 | search_documents | `variant_options.id`, `gtins` | child table `search_variant_options` / `search_gtins` |
| audit repository:202 | entries | `actor_roles.key` | multi-valued index on `actor_roles->'$[*].key'` |
| audit:227 | entries | `search_words $all` | multi-valued index, one `MEMBER OF` per word |
| workqueues:14,47 | items | `related_subjects $elemMatch {type,id}`, `.ref` | child table `workqueues_item_subjects (item_id, type, subject_id)` |
| trust:174 | report_events | `detail.key` | JSON (filtered by report id first) |
| trust:220-224 | reports + subjects | `$elemMatch` | JOIN `trust_v_report_subjects` |
| warehouse:119 | fulfillments | `discrepancy_ids.id` | multi-valued index |
| sellers:70 | sellers | `contact.email` regex | generated `contact_email` (as_ci) + index |
| sellers:76 | applications | `business.categoryIds` | multi-valued index |
| sellers:81,175 | performance_snapshots | `metrics.dispatch_reliability.value/status` | generated columns + index `(seller_id, dispatch_value)` |
| sellers:192,209,213,214 | applications | account.storeName, business.legalName, payout destination ids, postal code, lower(line1/workEmail) | generated columns for storeName, legalName, workEmail (as_ci) + indexes; others JSON |
| orders:162,235,401 | order_items | `product_snapshot.title` (regex), `offer_snapshot.sellerSku`, `product_snapshot.categoryId` | generated `item_title` (FULLTEXT ngram), `seller_sku`, `category_id` + indexes |
| orders:483 | orders | `flag_kinds` membership | multi-valued index |
| offers:149 | offers | `content_gaps` membership | multi-valued index |
| offers:162 | eligibility | `reasons.code` | multi-valued index on `reasons->'$[*].code'` |
| offers:176 | offers | `ineligible_source.kind/id` | generated columns + index |
| messaging:168 | conversations | `subject.title/orderRef/returnRef` regex | generated `subject_text` (CONCAT_WS) + FULLTEXT ngram |
| media:130, 270-273 | assets | `check_result.passed`, `processing_spec.*` ne | generated `check_passed`; JSON for processing_spec (job scan) |
| advertising:442 | creatives | `link_check.state` | generated + index |
| payments:179 | intents | `method.last4` | generated + index |
| returns:120 | returns | `info_request.replyDueAt` (string range) | generated `reply_due_at DATETIME(3)` + index |
| support:297 | case_items | `snapshot.productId` in | generated + index |
| support:353 | cases | `decision.outcome`, `decision.decidedAt` (string range) | generated `decision_outcome`, `decided_at DATETIME(3)` + index `(seller_id, decided_at)` |
| services:156 (added 2026-10-23) | requests | `contact.name`, `contact.phone` regex | generated `contact_name` / `contact_phone` (as_ci) + index; requests are always narrowed by provider, service or state first, so JSON in the WHERE clause is also enough |
| settings:183 | changes | `items.key` | multi-valued index |
| notifications:538 | member_preferences | `groups.promotions` | JSON (read per seller) |
| catalog:93; reviews:135 | products; reviews | `recrop_media_ids.0`, `media_ids.0` (non-empty) | `JSON_LENGTH(col) > 0`; generated flag if it is a list filter |
| notifications (spec gin(link)) | notices | link paths | generated columns for the paths the inbox filters on |

## Appendix C: Read-modify-write fixes (done in Y0, on MongoDB)

Each fix makes the write safe without relying on MongoDB's write-conflict retry. Most become an atomic SQL update.

**Worked through on 2026-10-23/24, branch `build/mysql-migration`; typecheck clean, 2,014 tests in the touched modules.** The census was right about there being a problem, and wrong about where it was often enough to be worth saying: of its 13 code rows, **6 needed a fix, 5 were already safe** (locked since the census, or locked by a wrapper the census did not follow), and **2 were correct by design**. One site the census missed turned up next to one it listed.

| Outcome | Sites |
|---|---|
| **Fixed** | reviews/moderation (`last` branch); finance/ledger ×2; checkout/placement; departments/blogs ×2; inventory/returns; promotions/reverseItem; promotions/onItemSplit (**new**); purchasing/closePurchaseOrder; finance/holds |
| **Already safe** — struck | payments/intents (reads with `forUpdate` at `intents.ts:299`); inventory `incoming_expectations` (all four sites already pass `{ forUpdate: true }`); trust/extend (every caller goes through `core.write`, which locks the report); orders/placement (`core.write` → `lockAndLoad` locks the order) |
| **Correct by design** — documented | fulfillment-service/inbound; warehouse/packing: the parent is locked and every writer of the children locks the parent first |
| **Open** | purchasing/receipts.ts:192 writes `qtyReceived`/`qtyDamaged` from values computed before the lock. It is partly protected by a `curPo.status` compare-and-set that raises CONFLICT, so a concurrent receipt that does not move the status could still race. Left alone deliberately: the fix means restructuring how `afterLines` is built, which is more than a lock. Y2 does it with the module |

Two lessons for the phases after this one. **The detector of §11.2 rule 2 would have found none of the three worst cases**, because they never opened a transaction. **And an appendix of file:line entries decays**: five entries were already fixed and one site was missing, inside two days. Re-read the code, do not trust the list.

Re-run on 2026-10-23 over the six Departments modules. They are mostly written in the locked style already — `rewards` reads its progress row with `forUpdate` before `count + 1`, and `departments.reactToBlogPost` locks the post before recomputing its counters — but two writers in `departments/service/blogs.ts` recount from the source rows and write the result **with no transaction at all**. They are the last two rows below. Note what they imply for §11.2 rule 2: the detector watches unlocked reads *inside* a transaction, so it will not catch a read-modify-write that never opens one. Those have to be found by reading the code, which is why this appendix is re-run whenever modules are added.

| Place | Today | Fix |
|---|---|---|
| reviews/service/moderation.ts:195→199 — **done** | `report_count: last.report_count + 1` after an unlocked find | `forUpdate: true` on the `last` read. The `item` branch above it was already locked |
| finance/service/ledger.ts:311→321, 513→523 — **done** | `refunded_fee + feeBack` after an unlocked `fee_charges` read | `forUpdate: true` on both `fee_charges` reads. Not an atomic `$inc`: the new `status` depends on the resulting total |
| inventory/service/returns.ts:196 | `return_outcomes.quantity + n` | atomic increment |
| inventory/service/items.ts:240; receiving.ts:90,148,261 | `incoming_expectations.quantity_open ±` under the item lock only | atomic increment (or lock the expectation row in the documented order) |
| trust/service/reports.ts:184 | `reporter_count + 1` from an unlocked aggregate | lock the report row first (and document it) |
| promotions/service/checkout.ts:469→484 | line read **outside** the transaction, then `reversed + amount` | read inside, with `forUpdate`, after the redemption lock |
| purchasing/service/purchase-orders.ts:265→274 | lines read outside the transaction, then `qtyClosed + qty` | read inside, after the PO lock |
| orders/service/placement.ts:430→435 | `captured_total + amount` from an aggregate in `core.write` | confirm that `core.write` locks the order; else an atomic add |
| finance/service/holds.ts:407→410 | job recomputes `amounts_owed` with no transaction | a transaction + `forUpdate` |
| ~~payments/service/intents.ts:305~~ (was :359) | **already safe**: the intent is read with `forUpdate` inside the transaction (`intents.ts:299`), so the census entry is out of date | none |
| checkout/service/placement.ts:346 — **done** | `attempt_count + 1` with no transaction | new `repo.bumpAttempt(id)`: `$inc` returning the row after, so the attempt number is the caller's own |
| fulfillment-service/service/inbound.ts:594; warehouse/service/packing.ts:191 | child rows rewritten under the parent's lock | keep; document "parent lock covers children" (the detector allows it when the parent is locked) |
| departments/service/blogs.ts:346-356 — **done** (added 2026-10-23) | `likeBlogReply`: inserts or deletes the like row, then `countReplyLikes`, then writes `like_count`. No transaction, so two likes on the same reply can interleave and the later count be overwritten by the earlier one | wrap in a transaction and lock the reply row first (`getReply(id, { forUpdate: true })`), or drop the stored count and read it from `blog_reply_likes` (the table is small and already indexed by reply) |
| departments/service/blogs.ts:364-366 — **done** (added 2026-10-23) | `recountReplies`: `countVisibleReplies` then writes `reply_count`, no transaction | same fix, locking the post row; `reactToBlogPost` two functions above is the pattern to copy |
| finance/service/ledger.ts:323, 525 | lot re-read, already locked at 296 | none (safe) |

## Appendix D: GraphQL fields to batch (done in Y0)

**Priority 1 is done** (2026-10-24, branch `build/mysql-migration`; full suite 9,763 tests green). Two things to carry into the rest of the appendix:

- **The APIs it says to add mostly exist already.** `catalog.getProducts(ids)` and `offers.getOffers(ids)` were both in the spec and both implemented; the resolvers were simply still calling the single-id versions. Check the module before writing a new public API — this is the third appendix in this plan found to be out of date.
- **`createBatchLoader` needed a per-call chunk size, not just the §16.2 cap.** `catalog.getProducts` refuses more than 200 ids, so the flat 500 would have failed on a large page with VALIDATION_FAILED. `load(ctx, key, id, fetch, chunk)` now takes the callee's own limit, and the cap is `min(chunk, 500)`. Every batch API this appendix touches needs its limit read, not assumed.

Also done in the kernel: the per-request result cache (which remembers ids that came back missing, so they are not asked for twice), and `src/kernel/graphql/batch-loader.test.ts` covering collection, the cache, cached misses, per-request isolation, chunk splitting, key isolation and that a failed batch stays retryable.

**Worth knowing before doing priorities 2–5: no persisted *list* query selects these order fields today.** Checked across `docs/api/graphql/operations`: `payment`, `refunds`, `paymentDisputes` and `refundable` appear only on order- and case-detail operations. So priority 2 is not fixing a live N+1 — it is making sure that the first list query to select one of these fields does not quietly become 50 round trips on MySQL. That makes it worth doing, and also worth doing cheaply: batch what batches without a redesign, and write down what does not (as `refundable` now is).

One harness note for the modules still to do: a module that stubs its dependencies in tests (search stubs catalog, offers and inventory in `test/helpers.ts`) needs the batch method added to the stub too, or the field silently answers empty.

| Priority | Field(s) | Today | Batch API to add |
|---|---|---|---|
| 1 — **done** | Search cards: `SearchResults.items`, `Product.related`, suggestions, `emptyGuidance.popular` | `catalog.getProduct` + `offers.getOffer` per card; the category tree re-read per card | Both batch APIs already existed; the resolvers now use them through the loader, and the category tree is read once per request. Every mapper in `search/graphql/resolvers.ts` takes the request context for this |
| 1 — **done** | `Product.bestSellerRank`, `Product.related`, `Seller.categories` | batch-capable APIs called with `[root.id]` | routed through the batch loader (`rankOf`, `relatedOf`, `sellerCategoriesOf`) |
| 2 — **done** (except `refundable`) | `Order.payment`, `refunds`, `paymentDisputes` | per order | `paymentsForOrders`, `refundsWithViewsForOrders`, `disputesForOrders`, all through the loader. Underneath: `intents.intentsOfOrders` (one read with the same precedence) and `views.paymentDetails`, which turns the **seven reads per payment** of `paymentDetail` into one read per child table for the whole set; the single-payment version now delegates to it. `repo.webhooksForMany` likewise. **`refundable` is left per-order on purpose:** it goes through `intentOfOrder`'s fallback, which *writes* (it links an intent to an order), and through `caps()`, which needs its own batching; no persisted query selects it on a list |
| 2 — **done** | `Order.returns`, `refundRequests`; `Order.cases`; `Order.deliveryExceptions` **and `OrderGroup.deliveryExceptions`**; `Order.conversations`; `Order.auditTrail` | per order | `listForOrders` / `refundsForOrders` (returns), `listForOrders` (support), `forOrders` **and `forGroups`** (shipping), `viewsForOrders` (messaging); every single-order method now delegates to its batch, so each rule has one home. **audit needed no new API**: `trailOf` already took a list, and its hand-rolled batcher was replaced by the kernel loader. Where a viewer is involved (returns, support, messaging, the seller view of shipping) the loader key carries it, so two areas never share a batch |
| 3 | `OrderItem.returnEligibility` (returns:181), `discountFunding` (promotions:99) | per item | `returns.eligibilityForItems(ids)`, `promotions.fundingForItems(ids)` |
| 4 | About 15 lazy `Seller` fields (sellers:84-150) plus `returnCounts`/`returnTerms`, `inbox`/`replyStats`, `finance`, `openWorkItems` | per seller in admin lists | `…ForSellers(ids)` (the existing `balancesForSellers` style) |
| 5 | Flash sale/deal items `offer`/`product` (promotions:31-38) | per item | `offers.getOffers`, `catalog.getProducts` |
| — | Loops dressed as batches: `Offer.product`/`variant` (offers:69-77), `Seller.balance` (finance:70), promotions campaign (:29), wishlist lists (:92) | sequential per id | real `IN (…)` reads |
| — | `Product.offers`, `offer`, `featuredDecision`, `SellerCollection.offers`, `Offer.priceContext/priceHistory/statusLog/priceChanges`, `earningsPreview`; `Customer.*` admin fields; `Return.case`, `Return.conversation` | per parent | batch where the parent is a list in a persisted query; leave single-parent fields |

Kernel — **done**: `createBatchLoader` has the per-request result cache and chunking, with a per-call chunk size for APIs whose own limit is lower (§16.2).

## Appendix E: Column names that are MySQL reserved words

These are always quoted by the generator and Kysely. Raw `sql` fragments must quote them too. Re-scanned on 2026-10-23: the Departments modules added three words and widened four counts.

| Column | Tables (count) |
|---|---|
| `key` | 21 (access.roles, access.permissions, access.approval_actions, advertising.placements, settings, rewards.tasks, software.rails …) |
| `condition` | 8 (cart.cart_items, catalog.offer_index, inventory.stock_items, offers.offers, rewards.rewards, rewards.redemptions …) |
| `lines` | 6 (fulfillment-service.inbound_receipts, removal_orders, orders.shipment_refs, purchasing.supplier_claims, food.baskets, food.orders) |
| `by` | 2 (shipping.tracking_corrections, rewards.entries) |
| `rank` | departments.prize_awards (new; reserved since 8.0.2 as a window function) |
| `limit` | software.rails (new) |
| `databases` | software.apps (new) |
| `check` | finance.recon_items |
| `before` | audit.entries |
| `schema` | settings.definitions |
| `system` | access.roles |
| `sensitive` | access.permissions |
| `trigger` | advertising.placements |
| `groups` | notifications.member_preferences |
| `last_value` | payments.ref_sequences |

Checked and **not** reserved, so they need no quoting (listed because they are new and look like keywords): `visible` (15 tables), `at` (62 tables), `status`, `active`, `position`.

## Appendix F: Files that change

| Area | Files |
|---|---|
| Kernel | `src/kernel/mongo/*` → `src/kernel/mysql/*` (§10.1); `kernel/jobs/mongo.ts` → `mysql.ts`; `kernel/auth/rate-limit.ts`, `kernel/auth/chain.ts` (webhook log), `kernel/http/idempotency.ts`, `kernel/lib/refs.ts`, `kernel/graphql/helpers.ts` (batch loader cache/cap), `kernel/config` (env vars), `app.ts` (connect, purge job) |
| Generator | `tools/lib/mongo.ts`, `tools/lib/mongoose.ts` → `tools/lib/mysql.ts`; `tools/lib/tables.ts` (notation); `tools/generate.ts`; `tools/migrate.ts`; `tools/db-setup.ts`; new `tools/export-catalog-seed.ts` (Y0, one-off, §18.1), `tools/seed-volume.ts`, `tools/load.ts`; `tools/simulate*` (DB checks in SQL); `tools/check-boundaries.ts` |
| Modules (40) | `repository.ts` (rewrite), `sql/*.sql` (stored procedures and triggers where §9.5 keeps them), `schema.ts` (generated), `module.ts` (store wiring), `migrations.ts` (emptied), tests that read tables; search: `mysql-engine.ts` replaces `mongo-engine.ts`, `cards.ts` → TS function |
| Spec | `docs/api/spec/modules/*.json` (sizes, views, FK options, appendOnly, collation, JSON-path indexes, new summary columns and child tables), `FORMAT.md`, new generated `docs/api/db/*.sql` |
| Tests | `src/testing/global-setup.ts`, `src/testing/mongo.ts` → `mysql.ts`, `module-suite.ts`, new `src/integration/concurrency.test.ts` |
| Deploy | `backend/deploy/linux/*` (install, `marketly.cnf`, backup, restore, ops, check), `.env.example`, `.env.production.example` |
| Docs | docs/02 (database section), docs/04 (superseded note), docs/08 (backup commands), MAINTAINING.md (§6 becomes MySQL: server, users, backups, point-in-time recovery, slow log, deadlocks, manual ALTER), BUILDING-MODULES.md (§5b MySQL rules: locks, atomic updates, Where, Kysely), backend README |

New environment variables: `MYSQL_URL`, `MYSQL_POOL_SIZE` (30), `MYSQL_DATA_DIR` / `MYSQL_PORT` (portable server), `MYSQLD_PATH`, `TEST_MYSQL_URL`, `MYSQL_READ_URL` (later). Removed: `MONGODB_URI`, `MONGO_DATA_DIR`, `MONGO_PORT`, `TEST_MONGODB_URI`, `MONGOMS_SYSTEM_BINARY`. Renamed values: `JOBS_BACKEND=mysql`, `RATE_LIMIT_STORE=mysql`, `SEARCH_ENGINE=mysql`. `TX_SLOW_MS`, `MIGRATE_ON_START`, `REVOCATION_POLL_MS` stay.
