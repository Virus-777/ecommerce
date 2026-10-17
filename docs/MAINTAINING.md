# Maintaining the Marketly backend

A guide for the person who looks after this backend alone. It covers running and testing it, making the
common changes, operating MongoDB, deploying, and what to do when a check fails. For the rules a module's
code follows, read [backend/docs/BUILDING-MODULES.md](../backend/docs/BUILDING-MODULES.md) once; for the
API itself, [docs/api/README.md](api/README.md).

## 1. The one idea: the spec decides, the code follows

The API design in `docs/api/spec` (one JSON file per module, format in `docs/api/spec/FORMAT.md`) is the
source of truth. `npm run gen` turns it into TypeScript: types and validation, routes, event payloads, the
MongoDB collections with their indexes, each module's API reference. `npm run check` fails when the code and
the spec disagree. So nearly every change follows the same three steps:

1. change the spec (`docs/api/spec/modules/<module>.json`);
2. regenerate (§3);
3. write or change the code the compiler now asks for, then `npm run check`.

Never edit a file whose first line says `GENERATED`; change the spec and regenerate instead.

## 2. Run and test

From `backend/`:

| Command | What it does |
|---|---|
| `npm install` | once, and after pulling a change to `package.json` |
| `npm run dev` | the API on http://localhost:4000 with reload; API reference at `/docs`. Without `MONGODB_URI` it starts its own MongoDB in memory (set `MONGO_DATA_DIR=.data/mongo` to keep the data) |
| `npm run token -- staff` | a development token (`visitor`, `customer`, `seller`, `staff`). Every endpoint needs a token: `curl -H "Authorization: Bearer <token>" …` |
| `npx vitest run src/modules/<module>` | one module's tests (a minute or two). Use this while working |
| `TEST_MONGODB_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0 npx vitest run` | the tests on a real MongoDB instead of the in-memory one (after a MongoDB upgrade, for example). They create databases named `t<n>_<n>` and drop them at the end; never point it at a production server |
| `npm run simulate` | realistic traffic over real HTTP on the database of `MONGODB_URI` (local servers only): staff, sellers, products, store content (the five policies, navigation, homepage, help center, About page), customers, orders, shipping, returns, refunds, a payout run, then read-only database checks. Leaves its data in place; report in `backend/.data/simulate-report.json`. `-- --scale medium` makes about 4× the data, `-- --seed <n>` repeats a run's random choices. The first run creates the Business Owner and keeps its sign-in in `backend/.data/simulate-owner.json` (keep that file) |
| `npm run check` | everything, in order: spec freshness, types, module boundaries, API conformance, all tests, every endpoint over HTTP. About 8 minutes. Run it before every commit you keep |

Requirements: Node 22 or newer; MongoDB 6.0 installed (`C:\Program Files\MongoDB\Server\6.0`) makes the
tests start faster, otherwise the first run downloads it. Settings are environment variables, listed with
their defaults in `backend/.env.example` and `backend/README.md`; put local values in `backend/.env`
(never commit it).

## 3. Regenerating after a spec change

From the repository root, then `backend/`:

```bash
node docs/api/tools/build.mjs      # checks the spec, rebuilds docs/api (openapi.json, module pages, viewer)
node docs/api/tools/graphql.mjs    # only if a GraphQL fragment or screen query changed
cd backend && npm run gen          # spec → src/spec/**, each module's schema.ts, README.md, graphql/schema.ts
```

`build.mjs` refuses a spec with mistakes and says where. `npm run gen` also prints "spec gaps" (a type used
but never defined, for example): fix those in the spec.

## 4. Where things are

```
docs/api/spec/            the design: common.json + modules/<module>.json        ← change this first
docs/api/                 generated from it: openapi.json, modules/*.md, viewer
backend/src/
  spec/                   GENERATED types, validation and metadata per module
  kernel/                 shared plumbing, no business rules: auth middleware, routes, MongoDB, events, jobs
  modules/<module>/       one folder per business area (33)
  modules.config.ts       which modules run
  integration/            tests of whole flows across modules (an order from checkout to refund …)
  testing/                test helpers: buildTestApp, tokens, clocks, real sign-in flows
backend/tools/            the generator and the checks behind the npm scripts
```

Inside a module (`src/modules/orders` is a good one to read first):

| File | What it holds |
|---|---|
| `module.ts` | wiring: routes, event consumers, jobs, GraphQL resolvers |
| `contract.ts` | the only file other modules may import |
| `http/<area>.ts` | one small handler per endpoint (`store`, `seller`, `admin`, `public`, `webhooks`) |
| `service.ts` | the module's use cases. Large modules: `service.ts` builds the classes in `service/<feature>.ts` and delegates to them; `service/core.ts` holds what every feature shares |
| `repository.ts` | every database read and write, as one class (`OrdersRepository`) |
| `schema.ts` | GENERATED Mongoose schemas, one per collection |
| `ports.ts` | row types and the interfaces of outside providers (email, payments, carriers …), when the module has any |
| `providers/` | provider adapters, each with a development version that needs no network |
| `domain/` | rules without I/O: state machines, calculations |
| `test/`, `<module>.test.ts` | behaviour tests; the contract test holds the module to its spec |
| `README.md` | GENERATED: the module's API reference |

## 5. Common changes

**Change a business rule.** Find the use case in `service.ts` or `service/<feature>.ts` (search for the
endpoint's operation id in `http/<area>.ts` to see which method it calls). Change it, add or adjust a test
in the module's `test/` folder, run the module's tests, then `npm run check`. If the rule is written in
the spec's description text, update the text too.

**Add a field to a response.** Add it to the type in the spec, regenerate (§3). The compiler then points
at the code that builds that type; fill the field in. If it needs data that is not stored yet, add a column
first (next item).

**Add a column or a collection.** Add it to the module's `tables` in the spec (FORMAT.md describes the column
types, `?` for nullable, indexes), regenerate. The next start (or `npm run migrate`) creates the collection
and its indexes. Existing documents do not get the new field: if they need a value, add a data migration
(§6). Read and write the field in `repository.ts`.

**Add an endpoint.** Add it to the spec's `endpoints` (path, method, area, auth, permission, request and
response types), regenerate. The compiler now asks for its handler in `http/<area>.ts`; write the handler
(it calls a service method) and the method. Every endpoint is behind a token: the middleware checks the
token, caller, permission and limits before the handler runs, so the handler never does.

**Add an event or a job.** Events: `events.publishes` in the publishing module's spec, `events.consumes` in
each subscriber's, regenerate, then `ctx.events.publish(...)` after the transaction commits and
`ctx.events.on(...)` in the subscriber's `module.ts`. Jobs: `jobs` in the spec with a schedule phrase the
scheduler knows (FORMAT.md), then `ctx.jobs.handle(...)` in `module.ts`. Consumers and jobs must be safe
to run twice (BUILDING-MODULES.md §5, §9).

**Add a setting.** `settings` in the spec (key, type, default), regenerate, read it with
`await ctx.settings.get('key')`. Staff change it in the Admin Center; nothing else to wire.

**Turn a module on or off.** `src/modules.config.ts`. The server refuses to start when an enabled module
needs one that is off, and names it.

**Add a module.** Write `docs/api/spec/modules/<name>.json`, run `node docs/api/tools/build.mjs`, then
`npm run module:new <name>`: it creates the folder with every handler answering 501. Add the module to
`modules.config.ts` and build it out following BUILDING-MODULES.md.

**Remove something from the spec.** Remove it, regenerate, delete the code the compiler then flags.
Removing a collection or an index from the spec does not delete it from an existing database (§6).

## 6. MongoDB

**Server.** Production needs a MongoDB 6.0 or newer **replica set**: transactions need one, even with a single
server. A single local server becomes a one-member replica set by adding to `mongod.cfg`:

```yaml
replication:
  replSetName: rs0
```

then restarting the service and running once, in `mongosh`: `rs.initiate()`. Connect with
`MONGODB_URI=mongodb://user:password@host:27017/marketly?replicaSet=rs0` (percent-encode special characters in
the password: `@` → `%40`, `#` → `%23`).

**Collections and indexes.** Each spec table is a collection named `<module>.<table>` (`orders.orders`).
`npm run migrate` (and every start outside production) creates missing collections, keeps each collection's
validator equal to the spec, and makes the indexes match it: missing ones are built and ones the spec no longer
lists are dropped. It skips a module whose spec did not change since the last run. It never drops a
collection: when the spec loses a table, drop the collection by hand once nothing uses it
(`db.getCollection('orders.ref_sequences').drop()` in `mongosh`; that one was removed from the spec in October 2026).

**Data migrations.** Changes to existing documents (fill a new field, rename a value) go in the module's
manifest, `module.ts`:

```ts
mongoMigrations: [
  { id: '2026-11-01-fill-gift-flag', async up(db) {
      await db.collection('orders.orders').updateMany({ is_gift: { $exists: false } }, { $set: { is_gift: false } });
  } },
],
```

Each runs once, in order, on the next `npm run migrate` (its id is remembered in `kernel.migrations`). Never
change or reuse the id of one that has run; add a new one instead. Make `up` safe to run again (filter on
the documents that still need the change), because a run can be cut off.

**Backups.** Back up with the MongoDB Database Tools (installed separately from the server):

```bash
mongodump   --uri "$MONGODB_URI" --oplog --gzip --out backup-2026-10-13      # consistent copy of the whole server
mongorestore --uri "$MONGODB_URI" --oplogReplay --gzip --drop backup-2026-10-13
```

Run the dump daily from a scheduler, keep several days, and practise a restore into a spare server now and then:
a backup that was never restored is not known to work. Media files live in `MEDIA_STORAGE_DIR` (or the
storage provider), not in MongoDB: back that folder up as well.

**Looking at the data.** `mongosh "$MONGODB_URI"`, then `db.getCollection('orders.orders').find({ ref: 'MK-…' })`.
Ids are stored in `_id`. Money is in integer minor units (cents) or Decimal128. Change data through the API
when you can: the API keeps the audit trail, publishes events and keeps related collections in step; a hand
edit does none of that.

**Slow or retried transactions.** The log line `slow or retried transaction` with `{ module, ms, attempts }`
means a module's transaction took longer than `TX_SLOW_MS` (default 200 ms) or ran more than once: MongoDB
aborted it on a write conflict (another request changed the same document first) or a failover, and it was run
again from the start. Now and then is normal. The same module showing up often under load means requests queue
on one busy document (a counter, a stock or balance row). Then: keep that transaction short (read and decide
before it, no waiting inside it), move the update of the busy document to the end of the transaction so the
conflict window is small, or take it out of the transaction as one conditional update
(`updateOne({ _id, stock: { $gte: n } }, { $inc: { stock: -n } })`), which needs no transaction at all.

## 7. Deploying

Production is **one offline Ubuntu server** (owner decision 2026-10-15): MongoDB, the Marketly server (API,
scheduled jobs and the Admin Center pages on one HTTPS address) and daily backups. The step-by-step, from what to
download to renewing the certificate, is **[`backend/deploy/linux/README.md`](../backend/deploy/linux/README.md)**.
In short:

1. On the development PC: build the Admin Center, then `npm run package -- --admin <admin-center/dist>`
   (`tools/package.ts`): a release folder and `release/marketly-<version>-<commit>.tar.gz` with the compiled server
   (`dist/src/main.js`), the production tools (`dist/tools/*.js`: migrate, bootstrap-owner, staff-link, keys,
   db-setup, run with plain `node`), production `node_modules`, `deploy/linux/` and `.env.production.example`.
2. On the server: `sudo bash marketly-…/deploy/linux/install.sh`. It creates `/etc/marketly/marketly.env` with new
   keys the first time (`npm run keys`), sets MongoDB up as the replica set `rs0` (`npm run db-setup`), applies the
   schema (`migrate`; production never migrates on start), switches `/opt/marketly/current`, and (re)starts the
   systemd service. One process runs the API and the jobs (`JOBS_ENABLED=true`, `JOBS_BACKEND=mongo`, `DEPLOY_ID`
   set to the release name).
3. The first time: `make-cert.sh` makes the HTTPS certificate (`TLS_CERT_FILE`, `TLS_KEY_FILE`), signed by a
   root made on the server that each staff PC trusts once. HTTPS is required: the staff refresh cookie
   (`__Secure-mk_refresh_admin`) only travels over HTTPS, and production on a non-loopback `HOST` refuses to start
   without TLS (unless `TRUST_PROXY` says a proxy terminates it). Staff may open the Admin Center by the
   `API_URL` name or by any other name or IP the certificate covers (`https://192.168.1.10`): the session refresh
   accepts a page on the address the request came to (`ownOrigin` in `kernel/auth/chain.ts`), so they stay signed
   in across reloads either way.
4. Health: `GET /health` on `HEALTH_PORT` (plain HTTP on `127.0.0.1`); `sudo marketly check` checks it and
   everything else.
5. On a new database only: create the first admins (next section). On the server the commands are
   `sudo marketly bootstrap-owner …` and `sudo marketly staff-link …` (the same tools, run as the service user with
   the server's settings); on a development PC, `npm run bootstrap-owner -- …` as below.

Every production setting and its reason is in `backend/.env.production.example`; `backend/README.md`
"Configuration" lists them all. The server refuses to start with a missing or unsafe value and says which.

To roll back, `sudo marketly rollback` (the previous release is kept). Index changes are harmless both ways; a
data migration that already ran stays applied, so write migrations the old code can live with.

### The first admins, and staff links without email

Nobody becomes an admin by signing up. The first two Business Owners are invited from the server:

```bash
npm run bootstrap-owner -- --email olivia@company.example --name "Olivia Hart" \
  --deputy-email daniel@company.example --deputy-name "Daniel Reyes"
```

It prints a link and a pass code per person (`Link: …`, `Pass code: XXXX-XXXX`). Hand both over in person; the
link opens the Admin Center (`ADMIN_URL` must be an address their computer reaches), where they type the pass code
and choose a password. That signs them in; from then on staff sign in with email and password (no authenticator
app: the server is offline and only staff use it, owner decision 2026-10-14). Staff confirm sensitive actions
(granting roles, staff accounts, payout destinations, large approvals) by typing their password again. Links last
7 days (setting `identity.invitationTtlDays`); 5 wrong pass codes end a link. The command refuses once a Business
Owner exists or is invited, so it can't be used to take over a running system. The owners then invite the other
staff from Admin Center > Staff.

The server sends no email when it has no internet access, and the pass code is never emailed or shown in the Admin
Center, so staff get their link and pass code from the server instead. Each run issues a new link (and pass code)
and the previous ones stop working (both are stored only as hashes, so an old one cannot be shown again):

| Situation | Command |
|---|---|
| Someone was invited from the Admin Center (always: the Admin Center never shows the pass code), lost their link, let it expire, or typed 5 wrong pass codes | `npm run staff-link -- --email ana@company.example` (prints `Link:` and `Pass code:`) |
| Someone forgot their password | the same command: once they have an account, it prints a password reset link |
| A Business Owner invitation went to a mistyped email | `npm run staff-link -- --email olivia@compnay.example --revoke "Mistyped email"`, then `bootstrap-owner` again |

Every action is in the audit trail as "Server operator". Check who is asking before handing over a link and pass
code: together they let the person in.

## 8. When `npm run check` fails

It runs six steps and stops at the first failure; the name in the output tells you which.

| Step | What it means | Usual fix |
|---|---|---|
| `gen:check` | generated files are older than the spec | run §3 and commit the result |
| `typecheck` | the code does not match the types (often: the spec changed and code was not updated) | follow the compiler messages; they point at the exact line |
| `check:boundaries` | a module imports another module's file other than its `contract.ts` | call the other module through `ctx.use('<module>')` (its spec `publicApi`) or react to its events |
| `check:api` | the running server's API differs from `docs/api/openapi.json` | regenerate (§3); if it persists, a handler or route was changed by hand |
| `test` | a test failed | run that file alone (`npx vitest run <file>`). If it passes alone but failed in the full run, it is timing: look for something done after the reply is sent, or a clock set before the app starts (set it after) |
| `test:http` | an endpoint answered wrongly to a generated request: 500, a 401/403 for the right caller, or 400 for valid input | the report is in `backend/.data/test-http-report.json`; reproduce with `npm run test:http -- --only <module>` |

`npm run test:http` on its own uses a throwaway in-memory database. With `-- --url` it calls a running server and
**writes into that server's database**: generated sample records, and change requests waiting for approval (fee
rules, return policies …). Use `--url` only on a database you can throw away, and never approve its sample requests.

## 9. Rules that keep the system correct

These are easy to break without noticing; each is explained in BUILDING-MODULES.md.

- **Every endpoint needs a token**, and the token is checked only in the middleware (`src/kernel/auth`).
- **A transaction may run twice.** MongoDB retries it on a write conflict, so inside `repo.transaction(...)`
  only read and write this module's collections: publish events, call other modules, audit and send email after it.
- **Inside a transaction, one database call at a time** (no `Promise.all`).
- **Never insert and catch a duplicate-key error inside a transaction**; use `insertIfAbsent` / `upsert`.
- **Time from `ctx.clock.now()`**, never `new Date()` in services (tests move the clock).
- **Money in integer minor units** (`kernel/lib/money`), never floating-point amounts.
- **Use the kernel helpers** listed in BUILDING-MODULES.md §5b instead of writing another copy.

## 10. Open items

Decisions still open and known limits are listed at the end of `backend/README.md` ("Open points in the
design") and in [docs/04-mongodb-migration.md](04-mongodb-migration.md) (the real-server run, M4, and its risks).
