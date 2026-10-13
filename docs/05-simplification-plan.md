# Phase: simplification plan (one maintainer, offline)

Status: **approved 2026-10-13**; building R1 first (§4).

The owner will maintain the backend alone, without an assistant. Every change below has one aim: a developer who
opens a module for the first time finds one obvious way to do each thing, reads less code to understand a feature,
and never has to keep two copies of the same logic in step. Behaviour does not change: the API, the spec, the 7,636
tests and the 6,456 HTTP checks stay green after every step.

Starting point (after M3, main 330f1fe): MongoDB is the only database. Backend code, not counting generated files:
about 160,000 lines in the kernel, 33 modules and the tools.

## 1. What makes the code harder than it needs to be

| Problem | Where | Cost to a maintainer |
|---|---|---|
| The same helper written again in many modules | regex escaping (27 files), "insert unless a unique key exists" (56 files), duplicate-key detection (16, some still checking PostgreSQL's 23505), `found()` (41), a generic filter converter copied 4 times (`infra/mongo/generic.ts`), "nulls last" sorting by hand (6) | a bug fixed in one copy stays in the others |
| A hand-written interface repeats every repository method | `ports.ts` (33 files, ~2,200 lines of `XRepository` signatures) | every repository change is made twice; only 1 test ever swaps a fake repository in |
| Folders shaped for several databases | `infra/mongo/repository.ts`, `infra/mongo/schema.ts`, `infra/<provider>/…` | an extra level to find the one data file |
| Very large single files next to modules split by feature | `inventory/service.ts` 3,404 lines, `identity` 2,875, `access` 2,715, `customers` 2,261, `purchasing` 1,910; others already use `service/<feature>.ts` | two patterns to learn; long files are hard to navigate |
| Leftovers from the migration | spec items nothing reads (`orders.ref_sequences`, `search.searchEngine`, `tenantTables`), comments and test names that mention the old design, test clocks fixed before a slow boot (flaky under load) | dead ends when reading the code |

## 2. The changes

**R1. Kernel helpers instead of copies.** One place for each data pattern, used by every repository:
- `table.insertIfAbsent(row)` checks every unique index of the collection (from the spec), not only the primary key;
- `table.where(filter)`: the port-style filter (`<>`, `not in`, empty lists, `like`) with SQL's null meaning — the four `generic.ts` copies become this;
- `contains(text)` (escaped, case-insensitive), a `collation` option on reads, `nullsLast` sorting, `table.increment(key, fields)` (an upserted `$inc`), paging on a computed key;
- `isDuplicateKey(err)` for the few places that still race on a unique key; `orThrow(row, what)` for "not found".
Then each repository drops its local copies. **Done when** a grep for the old local helpers finds nothing.

**R2. One file per module for data, typed from its implementation.** `repository.ts` at the module root (today
`infra/mongo/repository.ts`) and `schema.ts` next to it (generated, today `infra/mongo/schema.ts`). The repository's
type is the type of what it returns (`export type OrdersRepository = ReturnType<typeof createOrdersRepository>`), so
the hand-written interface in `ports.ts` goes; `ports.ts` keeps only what is not the repository (row aliases,
provider ports) or disappears where nothing is left. Provider adapters stay in `providers/` (renamed from
`infra/<provider>/`).

**R3. One service layout.** A module's service is `service.ts` for small modules, and `service/<feature>.ts` plus a
short `service.ts` that composes them once a module passes about 1,000 lines. The five largest single files are
split that way along the features their spec already names (no logic changes, moves only).

**R4. Leftovers removed.** Unused spec items (after a check that nothing reads them), migration-era comments and
names, the contract-test headers; test harnesses set their fixed clock after the app has booted (the flaky
`token_not_yet_valid` failures under load). The open owner question on `search.searchEngine` is settled by the owner.

**R5. Maintainer guide.** `docs/MAINTAINING.md`, plain and short: run and test, the spec-first workflow (change the
spec → `npm run gen` → write the handler), add an endpoint, add a module, MongoDB operations (replica set, backups,
indexes, migrations as `mongoMigrations`), deploy, where everything is, and what to do when `npm run check` fails.
`backend/README.md` and `BUILDING-MODULES.md` are trimmed to point at it instead of repeating it.

## 3. What does not change

The spec-first design (the spec generates types, routes, schemas and docs; `npm run check` keeps code and spec
equal), the module boundaries (`contract.ts`, `ctx.use`), the auth middleware, the API, GraphQL and the tests'
meaning. These are what keep a large codebase safe to change alone.

## 4. Order and size

R1 first (kernel; one builder), then R2–R4 per module group in parallel (like M2), then R5. Each step ends with
`npm run check` green and a commit per module. About the size of M2.

## 5. Owner decisions (2026-10-13)

1. R2: the hand-written repository interfaces are replaced by the type of the implementation. **Approved.**
2. R2: `infra/mongo/` and `infra/<provider>/` are flattened (`repository.ts`, `schema.ts`, `providers/`). **Approved.**
3. R3: the five largest service files are split by feature. **Approved.**
4. R4: `search.searchEngine` is removed from the spec and the settings API; `SEARCH_ENGINE` is the one switch. **Approved.**
