# Building a module's business logic

How to turn a scaffolded module (`npm run module:new`: every endpoint answers 501) into a working one,
and how to change a built one. Every module follows the same patterns, so read this once and any module
reads the same.

## 1. Sources of truth (read before writing code)

| What | Where |
|---|---|
| The module's design: endpoints, types, tables, state machines, events, jobs, settings, permissions, public API, with descriptions that state the business rules | `docs/api/spec/modules/<module>.json` (readable: `docs/api/modules/<module>.md`) |
| Generated TypeScript of that design (types, Zod schemas, row types, `PublicApi` interface) | `src/spec/<module>.ts` (generated; never edit) |
| Business context from the plan, chapter by chapter | `docs/00-phase0-understanding.md`; spec `chapters` say which plan chapters apply |
| Authorization: what the middleware already guarantees | `docs/03-auth-middleware.md` |
| GraphQL fields this module owns | `src/modules/<module>/graphql/schema.ts` and the list in `graphql/resolvers.ts` |
| Screens that call each endpoint | spec `screens`; the prototype in `design/prototype/` |

The spec is the contract. Build exactly what it says: same names, statuses, transitions, error
codes, events and payloads. **Do not edit the spec, `src/spec/**`, `docs/api/**` or anything outside
`src/modules/<module>/`.** If the spec is wrong or missing something you need (a column, an error
code, an event), work within it if you reasonably can, and list it under "Spec gaps" in your report.

## 2. Layers

```
http/<area>.ts      thin: map HandlerInput → service call → response. No queries, no rules.
graphql/resolvers   thin: call service read methods (batched where the field is on a list).
service.ts          use cases: authorization beyond the middleware, rules, transactions, events, audit.
                    Past about 1,000 lines: service/core.ts (deps and shared helpers) + one class per feature in
                    service/<feature>.ts, and a short service.ts that builds them and implements the PublicApi (see orders).
domain/             pure rules and state machines (no I/O): pricing math, eligibility, transitions.
repository.ts       one class on ctx.mongo (the module's own collections, §5b); the class is the repository's type.
ports.ts            row types and provider ports, when the module has any.
schema.ts           the GENERATED Mongoose schemas, one per spec table.
providers/          provider adapters (email, payments, carriers, storage) behind ports, with a dev adapter.
```

- Handlers receive `{ params, query, body, page, principal, sellerId, sellerAccess, scope, can, actor, requestId, idempotencyKey, operationId, request, reply }` (`src/kernel/http/index.ts`). Pass what the service needs; don't pass `request`/`reply` into services.
- The service implements the spec's `PublicApi` interface (already declared on the class). Public API methods are called by other modules in-process; keep them free of HTTP concerns.
- Map DB rows (snake_case) to API types (camelCase) in the repository or a `mappers.ts`; keep the mapping in one place per type.
- Time comes from `ctx.clock.now()`, never `new Date()` in services (tests move the clock). IDs from `newId()` (`kernel/lib/ids`). Human references from `ctx.refs` (`MK-…`, `RT-…`). Money from `kernel/lib/money` (integer minor units, never floats).
- Runtime settings: `await ctx.settings.get('key')` (spec `settings`; the settings module overrides the default). Another module's setting, read-only: `await ctx.settings.read('reports.maxExportRows')` (its value in force, else its spec default) — never duplicate a setting to keep two equal.
- Business rate limits (wrong codes, attempts per hour): `await ctx.rateLimit(key, { limit, windowMs })` → `{ allowed, retryAfterMs }`, counted in the kernel's shared windows (the key is scoped to your module; every server instance counts together; a refused attempt is not counted; `peek: true` only looks). Never keep counters in memory: production runs several instances. Refuse with `RATE_LIMITED` and `retryAfterSeconds`.
- The Official Store's display name is `OFFICIAL_STORE_NAME` and its seller id `OFFICIAL_STORE_ID` (`src/spec/common.ts`); never hardcode either.

## 3. What the middleware already did (don't repeat it)

Before a handler runs: the token is verified; the caller kind, app (audience), seller context and member
access, endpoint `permission`, `permissionWhen`, staff session liveness, step-up proofs (re-auth tokens), rate limits, launch phase
and Idempotency-Key replay are all checked (`docs/03-auth-middleware.md`). In particular:

- **Step-up** (spec `stepUp`): the proof is verified before the handler, after the idempotency replay (a replay
  never spends a proof). A re-auth token is claimed once for the request (`identity.consumeReauthToken`) and given
  back if the request fails (any status 400 or above, a handler error included), so the person can retry without
  confirming again. A refused proof also frees the Idempotency-Key. Handlers never read, verify or consume the proof.
- **Idempotency** (spec `idempotent`): the kernel stores the response (status and body) per operation, caller and
  key, and replays it for 24 hours. A handler that throws frees the key, so the retry runs again.
- **Masking** (spec type fields with `permission` and `mask`): on admin and seller endpoints the kernel masks those
  fields in the response for callers without the permission (`kernel/auth/masking.ts`). Return the full value; never
  mask in the handler. GraphQL fields marked `@sensitive(permission, mask)` get the same masks in the seller and admin schemas.

The service still owns:

- **Record scope.** A customer, seller or visitor must only reach their own records. Read tenant tables
  with the owner condition of `input.scope` (`kernel/auth/scope.ts`; a table's owner column is `seller_id` /
  `customer_id`, or the one its spec `tenant` names). Another tenant's record is **NOT_FOUND (404)**, never FORBIDDEN (don't confirm it exists).
  Never take the owner id from the body: sellers act for `input.sellerId`, customers for `scope.customerId`/`principal.accountId`.
- **Business permissions** the spec describes in prose (e.g. "only the assignee or a lead may…"): use `input.can('perm')`.
- **Approval limits** (§6).

## 4. Errors

Throw `ctx.error(code, message?, details?)` for your module's codes: module codes are scoped (the same
code can have another status in another module) and an error thrown to another module in-process must keep
your status. `new AppError(code, …)` (`kernel/errors`) is fine for common codes. Use the codes in the endpoint's
`errors` list and the module's `errorCodes`; generic ones: `NOT_FOUND`, `VALIDATION_FAILED` (business
validation, with `details.issues: [{ path, message }]`), `CONFLICT`, `ILLEGAL_TRANSITION` (state machines
throw it for you), `APPROVAL_REQUIRED`. Status comes from the code's definition. Messages are for people:
short, specific, no internals.

## 5. Writes: transaction → events → audit

```ts
async approveThing(id: string, input: { actor: Actor; reason?: string; requestId: string }) {
  const { before, after } = await this.deps.repo.transaction(async (tx) => {
    const before = await tx.getThing(id, { forUpdate: true });
    if (!before) throw new AppError('NOT_FOUND', 'Thing not found');
    const status = thingMachine.next(before.status, 'approve');        // ILLEGAL_TRANSITION if not allowed
    const after = await tx.updateThing(id, { status, approvedAt: this.now() });
    return { before, after };
  });
  this.deps.ctx.events.publish('mod.thing.approved', { thingId: id, … }, { actor: input.actor, requestId: input.requestId });
  await this.audit({ action: 'mod.thing.approve', actionLabel: 'Approved thing', category: 'catalog',
    target: { type: 'thing', id, ref: after.ref, label: after.name }, before, after, reason: input.reason }, input);
  return after;
}
```

- **Inside a transaction, touch only your own repository.** Take references (`ctx.refs`), settings,
  other modules' calls, audit and events before the transaction or after the commit: they run outside its session,
  and a write conflict runs the transaction function again (§5b), which would repeat them.
- **Transactions:** `ctx.mongo.transaction((tx) => …)`; give the repository a `transaction(fn)` that hands `fn` a repository bound to `tx` (§5b). Use `forUpdate` when a decision depends on the record you're changing (stock, balances, states).
- **Events** are published **after** the commit (delivery is asynchronous; subscribers never fail the publisher). Payloads must match the spec (validated outside production). Publish exactly the events the spec lists for the action.
- **Audit:** endpoints marked `audited` (and material changes the spec describes) write one entry via the audit module, which every module but cart, checkout and wishlist has as an optional dependency:
  ```ts
  protected async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: { actor: Actor; requestId?: string }) {
    await this.deps.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.deps.ctx.name, requestId: by.requestId });
  }
  ```
  (If `audit` is not in the module's `optionalDeps`, skip auditing and note it as a spec gap.)
- **Idempotency:** the kernel stores and replays responses for `idempotent` endpoints. Still make money and stock operations safe to retry at the data level (unique keys, `insertIfAbsent`).
- **Event consumers** claim a key with `tx.claim(key)` on the module store (the envelope id, or a natural key such as `order-placed:<orderId>`) inside the transaction that applies their effects: the claim and the effects commit together, so a redelivered event changes nothing (`ModuleStore.claim` in kernel/mongo/index.ts). Wire the envelope id through: `ctx.events.on(name, (e) => service.onX(e.payload, e.id))`.
- **Permissions of a caller handed to you in-process** (a principal in an export or admin read): `ctx.can(principal, permission)` gives the same answer their request got, development tokens included.
- **Event consumers** (`onXFromY`) must be idempotent (same event twice = same result) and must not throw for records they don't know (log and ignore).

## 5b. Repositories on MongoDB (docs/04-mongodb-migration.md)

Every module keeps its data in MongoDB, one collection per spec table (`<module>.<table>`):

```ts
// module.ts
import { schemas } from './schema.js';                         // GENERATED Mongoose schemas, one per spec table
export default defineModule({ spec, version, schemas, register(ctx) {
  const service = new ThingService({ repo: new ThingRepository(ctx.mongo), ctx });
  …
```

```ts
// repository.ts: one class; services type their dependency as this class (no separate interface)
export class ThingRepository {
  readonly #things;
  constructor(private readonly store: ModuleStore) {
    this.#things = store.table<ThingRow>('things');              // rows keep their spec shape (id, snake_case)
  }
  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: ThingRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new ThingRepository(tx)));
  }
  getThing(id: string, o?: { forUpdate?: boolean }) {             // { forUpdate: true } locks it inside a transaction
    return this.#things.get(id, o);
  }
  listThings(statuses: string[], page: PageRequest) {
    return this.#things.page({ status: { $in: statuses } }, page, { column: 'created_at', direction: 'desc' });
  }
  updateThing(id: string, patch: Partial<ThingRow>) {             // a $set patch, operators ($inc, $push), or a pipeline
    return this.#things.update(id, patch);
  }
}
```

- **Filters and sorts name row fields** (`id`, `seller_id`); the table translates the primary key to `_id`, and Mongoose casts values by the schema (numeric strings to Decimal128). Unknown fields throw (`strict`, `strictQuery`).
- **Transactions are retried** when MongoDB reports a write conflict: the function runs again, so it must only read and write this module's tables (no events, provider calls or other modules; that was already the rule). Run operations inside one transaction one after another, never with `Promise.all`.
- **`forUpdate`** locks by writing (`_lock` is incremented): a second transaction writing the same document conflicts and is retried after the first commits. Keep the lock order the module already uses (inventory: reservations, their lines, then stock levels).
- **Never insert-and-catch a duplicate key inside a transaction**: the error aborts the whole transaction. Use `insertIfAbsent` / `insertManyIfAbsent` (on conflict do nothing) and `upsert` / `upsertMany` (on conflict do update).
- **Nulls and lists:** `{ col: { $ne: x } }` also matches documents where `col` is null; when null rows must not match (the spec's `<>` conditions mean that), write `{ col: { $nin: [x, null] } }` (or a `whereFilter` `<>`). "Is not null" is `{ $ne: null }` (`whereFilter`: `{ op: 'is not', value: null }`); `<>` null matches nothing. `{ $in: [] }` matches nothing; a condition on an array of objects is a dotted filter (`{ 'items.key': key }`); a join is two reads.
- **Kernel helpers: use these, never a local copy** (`kernel/mongo/index.ts`, `kernel/lib/`; tests in `kernel/mongo/mongo.test.ts`):

  | Need | Use |
  |---|---|
  | Insert unless a unique key is taken (on conflict do nothing) | `t.insertIfAbsent(row)` / `t.insertManyIfAbsent(rows)`: checks the primary key and every unique index of the spec (partial and case-insensitive ones included); `undefined` / a count when skipped. Pass `key` only for "on conflict (key) do nothing". |
  | A count that goes up (on conflict do update n = n + x) | `t.increment({ owner, day }, { count: 1, bytes })`: an upserted `$inc`, returns the row |
  | A Where object (`{ col: value \| list \| { op, value } }`) as a filter, with SQL's nulls | `whereFilter(where)`; types `Where<R>`, `Cond<V>` |
  | A search box term | `{ name: contains(q) }` (trimmed, escaped, case-insensitive); `likePattern(p)` for SQL LIKE; `escapeRegExp(s)` (`kernel/lib/text.ts`) to build other patterns |
  | Compare like `lower(x) = lower(y)` (a `lower(col)` index) | `t.find(f, { collation: CASE_INSENSITIVE })`; also `findOne`, `exists`, `count` |
  | PostgreSQL's "nulls last" in ascending order | `t.find(f, { sort: { due_at: 1, id: 1 }, nullsLast: ['due_at'] })` |
  | A list sorted by a computed value (a rank, a deadline with a default) | `t.pageAggregate([{ $match: t.filter(f) }, { $addFields: { rank: … } }], page, { key: 'rank', direction: 'desc' })` |
  | A write outside a transaction that may lose a race on a unique key | `isDuplicateKey(err)`; give the service a neutral answer (`undefined`, or a small error class of the module), never a database code |
  | "This row must exist" (a bug if not: 500, not 404) | `` orThrow(row, `orders: order ${id}`) `` (`kernel/lib/or-throw.ts`) |

  `t.page` already runs its count and read one after another inside a transaction.
- **Inbox, locks, counters:** `store.claim(key)` inside the transaction of the effects (true the first time); `store.lock(name)` serialises transactions on a name; `store.nextValue(name)` for sequences and identity columns, `store.nextValues(name, n)` to number a batch in one round trip (`t.insertMany` does this for identity columns).
- **Seed data** lives in code (`domain/seed.ts`), applied on boot. A schema change is a spec change (`npm run gen`; the kernel syncs validators and indexes); data changes after launch (backfills, renames) are `mongoMigrations: [{ id, up(db) }]` in the manifest, each run once.
- **Tests** read a module's collections the way its repository does: `app.kernel.mongo.module(name, spec.collections, schemas).table(t)`, and a module that may have moved to MySQL through `app.kernel.boot.stores` instead (§5c).

## 5c. Repositories on either database (docs/10-mysql-migration.md §10.5)

The database is moving to MySQL 8.0, one module at a time. A module whose turn has come writes its repository
against `ctx.store`, the seam both databases are behind (`kernel/store/index.ts`); `MYSQL_MODULES` then decides
at boot which one it is. Nothing else in the module changes, and the module's own tests are run both ways to
prove it (`npm run test:mysql-modules`). `settings` and `access` are the two pilots to copy.

```ts
// module.ts: ctx.store instead of ctx.mongo. The generated `schemas` stay (the modules still on MongoDB need them)
const service = new ThingService({ repo: new ThingRepository(ctx.store), ctx });
```
```ts
// repository.ts: the class of §5b with `Store` in place of `ModuleStore`, and `tx` still its own repository
constructor(private readonly store: Store) { this.#things = store.table<ThingRow>('things'); }
```

`Store` has the methods of §5b with the same meanings (`get`, `find`, `page`, `insertIfAbsent`, `upsert`,
`increment`, `update`, `updateMany`, `transaction`, `lock`, `claim`, `nextValue` …). What differs is the
vocabulary of filters and patches, which is SQL's reading rather than MongoDB's:

| Instead of | Write |
|---|---|
| `{ status: { $in: list } }`, `{ at: { $lte: now } }` | `{ status: list }`, `{ at: { op: '<=', value: now } }` — a value, a list, `null` or `{ op, value }` (`Cond`) |
| `{ $or: [a, b] }` | `{ or: [a, b] }`, and `{ and: [a, b] }` where one column needs two conditions that an object cannot hold |
| `{ 'items.key': k }` (a dotted path into a JSON array) | `{ 'items[].key': k }`, or `{ 'role_keys[]': k }` for the array's own elements. The `[]` is what tells SQL the column is an array (`MEMBER OF`); a value or a list, while an operator or `null` is refused by both stores |
| `{ pairs: { $elemMatch: { type, id } } }` | `{ 'pairs[]': { type, id } }` — "some **one** element has these fields", which two dotted paths cannot say (they may be satisfied by two different elements). Equalities only, matched as a subset of the element |
| `catch (err) { if (isDuplicateKey(err)) … }` from a store's own errors | `isDuplicateKey` from `kernel/store/index.js`: it answers for whichever database raised it |
| `{ $inc: { version: 1 } }`, `$push` | `{ version: inc('version', 1) }`, `{ log: jsonAppend('log', entry) }` — expressions the server computes |
| `{ 'check_result.passed': false }` (a path into a JSON **object**) | the same spelling, and SQL is told which column is JSON by the table's def. `<>` means "has a value, and it is not this"; `is not` is MongoDB's own `$ne` — "not this, including not set". Pick the one the old filter meant |
| `{ name: contains(q) }`, `startsWith`, `equalsIgnoringCase` | `{ name: { op: 'contains', value: q } }`, `'starts with'`, `'equals ignoring case'` — the term is matched literally, ignoring case, and trimmed |
| `aggregate([{ $match }, { $group: { _id: '$k', n: { $sum: 1 } } }])` | `table.countBy(['k'], where)` → `[{ k, n }]`, and `table.sum('bytes', where)` for a total. A money (DECIMAL) column is refused by `sum` on both stores: see §5c's note below |
| `aggregate`, `pageAggregate`, update pipelines, Kysely | the module's **queries port**, below: each belongs to one database. `decToZero` and a hand-written `expr` are SQL, and the MongoDB side refuses them by name rather than guessing |

Four things the pilots got wrong first:

- **`insertIfAbsent` with no `key`** is the portable spelling. A `key` names one unique index, and the two
  databases do not spell the same index the same way: `settings_change_keys` is unique on `(key)` while the row
  is open, which is a functional index on `(key)` in MySQL and a partial one in MongoDB — `(key, open)` is not a
  key of the MySQL table at all, and `(key)` alone would make MongoDB's upsert match a closed row as well. With
  no key named, both stores check every unique index the spec gives the table, which is the question meant.
- **A patch that depends on the row it writes** is not one `updateMany`. `supersedeDecisions` writes
  `superseded_<decision>` per row, so it is one `updateMany` per decision value rather than one `$in`.
- **A JSON column that cannot be null still holds `null`** — as a JSON document, not as SQL NULL. The table
  does that translation: a repository passes and reads `null` either way and never writes `'null'` itself.
- **`<>` and lists keep SQL's nulls**, as §5b already said: `{ op: '<>', value: x }` does not match a row whose
  column is null, and `{ col: [] }` matches nothing. The rule has not changed; MySQL is where it came from.

**A read that is not the same question in both databases goes in a queries port** (docs/10 §10.5e): a join,
a window function, a `GROUP BY` with more than a count, a money total, a projection of three columns out of
forty. Four files, and `media` is the one to copy:

```
repository.ts     the whole module, in the neutral vocabulary, on ctx.store
queries.ts        the interface — name the reads ("orphans", "pageByUsage"), do not invent a combinator
queries.mongo.ts  the pipelines, moved as they were
queries.mysql.ts  the SQL. `ReadOptions.and` adds one EXISTS to an ordinary Table read, which keeps the
                  paging and the row conversion written once; ctx.mysql.db is Kysely, typed, for the rest
```

`module.ts` picks one line — `ctx.mysql ? mysqlXQueries(ctx.mysql) : mongoXQueries(ctx.mongo)` — and the
repository takes `(ctx.store, queries)` and passes the port to its transaction clone. `ctx.mysql` is there
only while the module's data is in MySQL, which is what makes that line the whole switch.

**The detector cannot see a read taken *outside* the transaction that writes it**, and that is where the worst
of them hide. It watches unlocked reads *inside* a transaction, so a service that reads a row (or a list, or
"the latest one"), opens a transaction and then writes what it decided from that read gets no warning at all —
on either database. Every open row of docs/10 Appendix C turned out to be this shape, and so did a fix in each
of five modules converted in tranche C. The tell is a write whose **value or target row** comes from above the
`repo.transaction(…)` call: `map.get(id) ?? row.x`, `lines[i].qty + n`, "the newest submission". The answer is
to re-read it inside the transaction with `{ forUpdate: true }` and decide again there — or, where the whole
decision is one statement, a guarded `updateMany` whose filter does the checking.

**Lock a row before you write it, even where something else already serialises the writers.** Converting
media turned seven tests red at once: `attach` and `detach` read an asset's usage row and then write it,
inside a transaction that had already locked the *asset*. The read-modify-write detector (§11.2 rule 1) was
right — the asset's lock serialises today's two callers and says nothing about the next one — and the fix is
`{ forUpdate: true }` on the read. On MongoDB that was a lost update waiting for a second writer, with
nothing to report it.

**A conversion changes code, not the schema.** If a module cannot answer a query without a new column, a
generated column or an index, say so in the report rather than editing its spec: that decision is made once,
with EXPLAIN, for all of them (docs/10 §10.5e). Regenerating also touches files every other module shares.

**Tests of a module whose data may be in MySQL read it through the store the app chose** —
`app.kernel.boot.stores.get('<module>')!.table<Row>('things')` — and so do tests of other modules that reach
into its tables. A test that builds its own `app.kernel.mongo.module(…)` reads a database the module no longer
writes to: the rows are simply not there, and nothing in the log says why (22 of access's tests failed that way
at once, and the repository was not the problem).

**The kernel's own data** — reference numbers, Idempotency-Key rows, the webhook log, rate-limit windows, the
job queue, counters, locks and the event inbox — moves with `KERNEL_STORE=mysql`, independently of any module,
and `JOBS_BACKEND` / `RATE_LIMIT_STORE` follow it unless they are set. Modules notice nothing: `ctx.refs.next`,
`store.claim`, `store.lock` and `store.nextValue` mean the same thing either way. MySQL has no TTL indexes, so
`kernel.purge-expired` deletes in batches what used to expire by itself (docs/10 §12); a module with retention
rules of its own keeps its own job, as before.

## 6. Approvals and limits (money and enforcement actions)

Where the spec names an `approvalActions` key or says an action needs approval:

```ts
const access = this.deps.ctx.use('access');                        // or tryUse when optional
const check = await access.check(principal, 'finance.payout.release', { amount });
if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason);
if (check.decision === 'approval_required') {
  const req = await access.requestApproval({ actionKey: 'finance.payout.release', target: {…}, amount, requestedBy: actor, … });
  // save the record pending and answer the endpoint's normal status with `approval` in the body (FORMAT.md "Approval responses");
  // 409 APPROVAL_REQUIRED only when nothing was saved
}
```

Finish the pending record in the consumer of `access.approval.decided` (filter on your action keys).
Granting a permission never grants financial authority: `check` is the only source of "allowed".

## 7. Reads, lists and paging

- `paging: true` handlers get `input.page`; the repository pages with `table.page(filter, page, { column: 'created_at', direction: 'desc' })` (keyset on the column and `id`; `kernel/mongo/table.ts`). Small bounded lists can use `pageOf(array, page)` (`kernel/lib/pagination`).
- Filters in the spec's `query` are all optional unless typed otherwise; apply only the ones given.
- Batch lookups across modules (`getAccounts(ids)`, `getStaffRef`) instead of calling per row.

## 8. Other modules

- `ctx.use('x')` for `dependsOn`, `ctx.tryUse('x')` for `optionalDeps` (undefined when that module is off: degrade as the spec describes). Only functions in that module's spec `publicApi` exist; types come from `src/spec/<x>.ts` (import `type` only, or from `modules/<x>/contract.ts`).
- Never read another module's tables. React to other modules through the events your spec `consumes`.
- Every module is built, so a dependency answers for real. A NOT_IMPLEMENTED from one is a bug: don't swallow it in business paths. In tests, boot real dependencies and stub only to control an answer (§10).

## 9. Providers, jobs, webhooks, GraphQL

- **Providers** (email, push, payment processor, carriers, file storage, virus scanning, address
  validation): define a port (an interface) in `ports.ts`, put a **deterministic dev adapter** in `providers/<provider>.ts` (a folder `providers/<provider>/` when it needs several files)
  (no network; e.g. payments: amounts ending in `02` decline, `03` time out; storage: local `.data/` or memory;
  email: recorded as sent). Wire the dev adapter in `module.ts`; real adapters come later behind the same port.
- **Jobs** (`spec.jobs`): implement every handler wired in `module.ts`. Make them restartable and idempotent (in production a failed
  run is retried with backoff, and a run can be cut off by a deploy and run again);
  process in bounded batches (walk all rows with a keyset cursor; never re-read the same first page each run); use `ctx.clock`.
  The schedule must be a phrase the scheduler times (FORMAT.md); any other phrase fails boot. A job that acts "at a cutoff"
  runs on an interval and checks the cutoff itself, idempotent per cutoff.
- **Webhooks:** register `ctx.http.webhookVerifier(hmacWebhookVerifier(ctx.config, ctx.name))`
  (`kernel/http/webhooks.ts`) unless the provider has its own scheme. The middleware rejects bad signatures
  and marks replays; handlers process `body` idempotently by provider event id.
- **Session cookies** (identity only): `ctx.http.sessionCookie(...operationIds)` declares the endpoints whose
  responses set or clear the website's refresh cookie, so they get credentialed CORS for their app's origins
  (refresh-kind endpoints have it already). There is one cookie per app (`__Secure-mk_refresh_store`, `_seller`,
  `_admin`); refresh and sign-out read only the cookie of the app named by the body's `audience`
  (`refreshCookieOf` in `kernel/auth/chain.ts`).
- **Served files** (media only): `ctx.http.files(route)` serves `GET /files/{bucket}/{key}` by signed links
  (`secretFor(config, '<module>.files')`), verified by the middleware before `serve()` runs.
- **GraphQL:** implement every field listed in `graphql/resolvers.ts` by calling service read methods.
  The resolver context has `principal`, `auth` and `scope`-relevant data; apply the same record scope as REST.
- **Work items:** `workqueues.raise({ …, sourceModule: ctx.name })`: the kind must be one of the spec's work item kinds (typed) and the queue one that workqueues seeds.
- **Files:** every uploaded file you keep must be attached with `media.attach` under the right usage kind, or media's orphan sweep deletes it after 30 days.
- **Customer data export:** a module holding a customer's personal data declares `exportCustomerData({ customerId, accountId }) => CustomerDataSection[]` (FORMAT.md) and anonymises on `customers.account.closed`.
- **Kernel helpers added during tranche 1:**
  - `ctx.modules`: the modules running in this process (don't read `modules.config.ts`).
  - `ctx.afterBoot(fn)`: runs once every module has registered: call other modules at startup there (register a dataset, warm a cache), never in `register`.
  - `secretFor(ctx.config, '<module>.<purpose>')` (`kernel/lib/secrets.ts`): the key for links and tokens your module signs (download links, unsubscribe tokens). Never invent secrets or borrow webhook secrets.
  - `ctx.config.publicUrls.store | seller | admin`: base addresses for links in emails and documents. Never hardcode a domain.

## 9b. Examples to copy

All 33 modules are built. wishlist, wallet and fulfillment-service are off at launch (`modules.config.ts`);
tests enable them with `only: [...]`, and `MODULES=…,fulfillment-service` boots Fulfilled by Marketly (set its
`serviceLocationId` / `serviceShippingProfileId` settings or rely on the defaults first).

- Modules to read first: `orders` (a service split by feature, lock order, events), `inventory` (stock in
  transactions), `settings` (a small module).
- Whole flows with real modules: `src/integration/order-lifecycle.test.ts` (checkout, payment, shipment,
  delivery, return, refund) and `fulfilled-by-marketly.test.ts`.
- Real sign-in and set-up for tests: `src/testing/flows.ts` (staff with roles, customers, seller sign-in;
  `flows.liveListing()` gives a seller with a live offer).

Call other modules' public APIs for real; in tests boot them (`only: [...]` pulls dependencies) rather than
stubbing, unless you need to control an answer. Notifications already turns the events your spec publishes
into notices, so publish exactly the spec's events and payloads.

## 10. Tests

Keep `describeModule('<module>')` (the contract suite) and add behaviour tests in `<module>.test.ts`
(split into `test/*.test.ts` files inside the module if large). Test through HTTP like a client:

```ts
import { auth, buildTestApp, callers } from '../../testing/app.js';
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildTestApp({
    only: ['mymodule'],
    // only dependencies whose answers you need to control:
    apiStubs: { identity: { getAccounts: async (ids) => ids.map((id) => ({ id, name: 'Ana', … })) } },
  });
});
// apiStubs replace functions for callers through the public API; the module's own methods stay bound to it
// (private fields keep working) and its routes, consumers and this.fn() calls run its own code, so stub every
// function your code path reaches. A stubbed optional dependency that is off answers `ctx.tryUse` with its
// stub, so { 'fulfillment-service': { isServiceOffer } } isolates a test without booting it. Never patch
// `ctx.tryUse` or Object.assign onto services.
const res = await app.inject({ method: 'POST', url: '/api/admin/mymodule/things', headers: auth(callers.staff()), payload: {…} });
await app.kernel.events.drain();   // wait for event consumers
```

- Cover, per endpoint group: the happy path, record scope (another seller's/customer's id → 404),
  business validation, every state transition the spec lists (and an illegal one → 409), approvals
  where relevant, events published (subscribe with `app.kernel.events.subscribe('test', name, fn)`),
  audit entries written (stub `audit.record` and assert the calls), jobs (`app.kernel.jobs.runNow`), consumers.
- Vitest 5 clears mock **calls** before every test (`clearMocks` default): calls made at boot or in `beforeAll` (`afterBoot` hooks) are gone by the time a test runs; record them in the stub implementation if a test needs them.
- Clocks: `movingClock()` (real time you can move ahead; dev tokens stay valid) is the easy default.
  A fixed clock is set to its time **after** `buildTestApp` returns (`clock.set(...)`): a slow boot otherwise
  leaves tokens signed at the fixed time "not yet valid" under load. Apps on a fixed clock: set `tokenClock.now = () => clock.now()` (from `testing/app.ts`), and a larger
  `tokenClock.ttlSeconds` if the test moves the clock far ahead, so `callers.*` tokens stay valid at the app's time.
- Dates: `marketDate(at, days?)` (from `testing/app.ts`) is the market's calendar date (YYYY-MM-DD) `days` after `at`,
  which is what modules mean by "today". Compare module dates with it, never with `toISOString().slice(0, 10)`.
- Callers: `callers.visitor({ audience })`, `callers.customer({ accountId })`, `callers.seller({ sellerId, permissions })`,
  `callers.staff(['perm'])` (default all permissions). These are dev tokens; their permissions stand in for access/sellers.
- A module with many test files keeps a `test/helpers.ts` whose `boot()` builds the app once with its clock, stubs
  and callers, and returns a kit (`app`, `clock`, `call()` …) for every file.
- Real flows (`flows(app, clock)` from `testing/flows.ts`): staff with roles, customers, seller sign-in, uploads and
  `liveListing()`, all through real tokens from identity (no dev tokens). Use them where a test needs the real chain.
- Run: `npx vitest run src/modules/<module>` while working; before finishing: `npx tsc --noEmit`,
  `npm run check:boundaries`, `npx vitest run src/modules/<module>` and `npm run test:http -- --only <module>`
  (every endpoint over HTTP: handlers must not answer 401/403 for the right caller, 500, or 400 for valid input).

## 11. Done means

- No `notImplemented` left in the module: every endpoint, public API function, event consumer, job and GraphQL field works.
- Behaviour matches the spec text; deviations are listed as spec gaps.
- Typecheck, boundaries, the module's tests and `test:http --only <module>` pass.
- Bump `version` in `module.ts`: `1.0.0` when first built, then on every change (`npm run modules` shows it).
