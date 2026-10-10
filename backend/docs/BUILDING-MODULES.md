# Building a module's business logic

How to turn a scaffolded module (every endpoint answers 501) into a working one. Every module
follows the same patterns, so read this once and any module reads the same.

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
http/<area>.ts      thin: map HandlerInput → service call → response. No SQL, no rules.
graphql/resolvers   thin: call service read methods (batched where the field is on a list).
service.ts          use cases: authorization beyond the middleware, rules, transactions, events, audit.
domain/             pure rules and state machines (no I/O): pricing math, eligibility, transitions.
ports.ts            repository interface (+ provider ports) in domain terms.
infra/postgres/     Kysely repository on ctx.db (already scoped to the module's schema).
infra/<provider>/   provider adapters (email, payments, carriers, storage) behind ports, with a dev adapter.
```

- Handlers receive `{ params, query, body, page, principal, sellerId, sellerAccess, scope, can, actor, requestId, idempotencyKey }` (`src/kernel/http/index.ts`). Pass what the service needs; don't pass `request`/`reply` into services.
- The service implements the spec's `PublicApi` interface (already declared on the class). Public API methods are called by other modules in-process; keep them free of HTTP concerns.
- Map DB rows (snake_case) to API types (camelCase) in the repository or a `mappers.ts`; keep the mapping in one place per type.
- Time comes from `ctx.clock.now()`, never `new Date()` in services (tests move the clock). IDs from `newId()` (`kernel/lib/ids`). Human references from `ctx.refs` (`MK-…`, `RT-…`). Money from `kernel/lib/money` (integer minor units, never floats).
- Runtime settings: `await ctx.settings.get('key')` (spec `settings`; the settings module overrides the default). Another module's setting, read-only: `await ctx.settings.read('reports.maxExportRows')` (its value in force, else its spec default) — never duplicate a setting to keep two equal.
- The Official Store's display name is `OFFICIAL_STORE_NAME` and its seller id `OFFICIAL_STORE_ID` (`src/spec/common.ts`); never hardcode either.

## 3. What the middleware already did (don't repeat it)

Before a handler runs: the token is verified; the caller kind, app (audience), seller context and member
access, endpoint `permission`, `permissionWhen`, staff 2-step, step-up proofs, rate limits, launch phase
and Idempotency-Key replay are all checked (`docs/03-auth-middleware.md`). The service still owns:

- **Record scope.** A customer, seller or visitor must only reach their own records. Read tenant tables
  through `scoped(ctx.db, input.scope, spec.tenantTables)` (`kernel/auth/scope.ts`) or add the owner
  condition explicitly. Another tenant's record is **NOT_FOUND (404)**, never FORBIDDEN (don't confirm it exists).
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
  other modules' calls, audit and events before the transaction or after the commit: they use their own
  connection, and on PGlite (development and tests: one connection) a call inside a transaction waits forever.
- **Transactions:** `ctx.db.transaction().execute(async (trx) => …)`; give the repository a `transaction(fn)` that hands `fn` a repository bound to `trx`. Use `forUpdate()` when a decision depends on the row you're changing (stock, balances, states).
- **Events** are published **after** the commit (delivery is asynchronous; subscribers never fail the publisher). Payloads must match the spec (validated outside production). Publish exactly the events the spec lists for the action.
- **Audit:** endpoints marked `audited` (and material changes the spec describes) write one entry via the audit module, which every module has as an optional dependency:
  ```ts
  protected async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: { actor: Actor; requestId?: string }) {
    await this.deps.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.deps.ctx.name, requestId: by.requestId });
  }
  ```
  (If `audit` is not in the module's `optionalDeps`, skip auditing and note it as a spec gap.)
- **Idempotency:** the kernel stores and replays responses for `idempotent` endpoints. Still make money and stock operations safe to retry at the data level (unique keys, `on conflict do nothing`).
- **Event consumers** claim a key with `ctx.inbox.claim(trx, key)` (the envelope id, or a natural key such as `order-placed:<orderId>`) inside the transaction that applies their effects: the claim and the effects commit together, so a redelivered event changes nothing (kernel/events/inbox.ts). Wire the envelope id through: `ctx.events.on(name, (e) => service.onX(e.payload, e.id))`.
- **Permissions of a caller handed to you in-process** (a principal in an export or admin read): `ctx.can(principal, permission)` gives the same answer their request got, development tokens included.
- **Event consumers** (`onXFromY`) must be idempotent (same event twice = same result) and must not throw for records they don't know (log and ignore).

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

- `paging: true` handlers get `input.page`; use `paginate(query, page, { column: 'created_at', direction: 'desc' })` (`kernel/lib/pagination`). Small bounded lists can use `pageOf(array, page)`.
- Filters in the spec's `query` are all optional unless typed otherwise; apply only the ones given.
- Batch lookups across modules (`getAccounts(ids)`, `getStaffRef`) instead of calling per row.

## 8. Other modules

- `ctx.use('x')` for `dependsOn`, `ctx.tryUse('x')` for `optionalDeps` (undefined when that module is off: degrade as the spec describes). Only functions in that module's spec `publicApi` exist; types come from `src/spec/<x>.ts` (import `type` only, or from `modules/<x>/contract.ts`).
- Never read another module's tables. React to other modules through the events your spec `consumes`.
- A dependency may still be unbuilt (it answers NOT_IMPLEMENTED). Don't swallow that in business paths; in tests, stub it (§10).

## 9. Providers, jobs, webhooks, GraphQL

- **Providers** (email, push, payment processor, carriers, file storage, virus scanning, address
  validation): define a port in `ports.ts`, put a **deterministic dev adapter** in `infra/<provider>/dev.ts`
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

## 9b. Modules already built

Built and merged: tranche 1 **identity, access, settings, audit, media, notifications**; tranche 2 **customers, catalog, inventory, sellers, purchasing, workqueues**; tranche 3 **offers, cart, orders, search, promotions, content**; tranche 4 **checkout, payments, shipping, finance, returns, messaging, reviews**; tranche 5 **support, trust, advertising, reports, warehouse** (all 30 launch modules). The phase 3–4 modules (wishlist, wallet, fulfillment-service) are off in `modules.config.ts`; tests enable them with `only: [...]`. `flows.liveListing()` sets up a seller with a live offer; `src/integration/order-lifecycle.test.ts` shows a whole order (checkout, payment, shipment, delivery, return, refund) with real modules. Real end-to-end flows for tests (staff with roles, customers, seller sign-in) are in `src/testing/flows.ts`; see `src/integration/*.test.ts`. Call their
public APIs for real; in tests boot them (`only: [...]` pulls dependencies) rather than stubbing, unless
you need to control an answer. Notifications already consumes the events your spec publishes and turns
them into notices, so publish exactly the spec's events and payloads. Stub only modules that are not
built yet.

## 10. Tests

Keep `describeModule('<module>')` (the contract suite) and add behaviour tests in `<module>.test.ts`
(split into `test/*.test.ts` files inside the module if large). Test through HTTP like a client:

```ts
import { auth, buildTestApp, callers } from '../../testing/app.js';
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildTestApp({
    only: ['mymodule'],
    // dependencies built in other tranches, or ones you need to control:
    apiStubs: { identity: { getAccounts: async (ids) => ids.map((id) => ({ id, name: 'Ana', … })) } },
  });
});
const res = await app.inject({ method: 'POST', url: '/api/admin/mymodule/things', headers: auth(callers.staff()), payload: {…} });
await app.kernel.events.drain();   // wait for event consumers
```

- Cover, per endpoint group: the happy path, record scope (another seller's/customer's id → 404),
  business validation, every state transition the spec lists (and an illegal one → 409), approvals
  where relevant, events published (subscribe with `app.kernel.events.subscribe('test', name, fn)`),
  audit entries written (stub `audit.record` and assert the calls), jobs (`app.kernel.jobs.runNow`), consumers.
- Vitest 5 clears mock **calls** before every test (`clearMocks` default): calls made at boot or in `beforeAll` (`afterBoot` hooks) are gone by the time a test runs; record them in the stub implementation if a test needs them.
- Clocks: `movingClock()` (real time you can move ahead; dev tokens stay valid) is the easy default.
  Apps on a fixed clock: set `tokenClock.now = () => clock.now()` (from `testing/app.ts`), and a larger
  `tokenClock.ttlSeconds` if the test moves the clock far ahead, so `callers.*` tokens stay valid at the app's time.
- Callers: `callers.visitor()`, `callers.customer({ accountId })`, `callers.seller({ sellerId, permissions })`,
  `callers.staff(['perm'])` (default all permissions). These are dev tokens; their permissions stand in for access/sellers.
- Run: `npx vitest run src/modules/<module>` while working; before finishing: `npx tsc --noEmit`,
  `npm run check:boundaries`, `npx vitest run src/modules/<module>` and `npm run test:http -- --only <module>`
  (every endpoint over HTTP: handlers must not answer 401/403 for the right caller, 500, or 400 for valid input).

## 11. Done means

- No `notImplemented` left in the module: every endpoint, public API function, event consumer, job and GraphQL field works.
- Behaviour matches the spec text; deviations are listed as spec gaps.
- Typecheck, boundaries, the module's tests and `test:http --only <module>` pass.
- Bump `version` in `module.ts` to `1.0.0`.
