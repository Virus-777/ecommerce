# Module spec format

One JSON file per backend module: `docs/api/spec/modules/<module>.json`.
`node docs/api/tools/build.mjs` validates every file and generates:

- `docs/api/openapi.json`: OpenAPI 3.1 for Swagger UI, Redoc, Postman and client generators
- `docs/api/modules/<module>.md`: readable reference per module
- `docs/api/viewer/data.js`: data for the visual API reference

## File shape

```jsonc
{
  "name": "catalog",                       // kebab-case, = URL segment, = collection prefix (catalog.<table>)
  "title": "Catalog",
  "group": "Catalog and stock",            // Platform | Participants | Catalog and stock | Buying | After-sales and money | Growth | Later phases
  "phase": 1,                              // plan ch. 20 launch phase (1–4); 3–4 are off at launch
  "chapters": [5, 8],                      // plan chapters this module implements
  "summary": "One or two sentences: what it owns.",
  "owns": ["Categories and attributes", "…"],          // capabilities, plain words
  "notOwns": ["Prices and stock belong to offers and inventory"],  // optional: boundary notes
  "dependsOn": ["media"],                  // must be enabled (hard dependency)
  "optionalDeps": ["search"],              // used when enabled
  "publicApi": [                           // functions other modules call in-process (not HTTP)
    { "name": "snapshotForOrder", "signature": "(variantId: uuid) => ProductSnapshot", "desc": "…", "usedBy": ["orders"] }
  ],
  "types": { "Product": { "id": "uuid", "title": "string", "brandId": "uuid?" } },
  "tables": [
    { "name": "products", "desc": "…", "columns": { "id": "uuid pk", "brand_id": "uuid → brands", "review_state": "text" }, "indexes": ["(review_state, id)"] }
  ],
  "stateMachines": [
    { "name": "Product review", "field": "Product.reviewState", "initial": "draft",
      "transitions": [["draft", "submit", "submitted"], ["submitted", "approve", "approved"]],
      "notes": "…" }
  ],
  "endpoints": [ /* see below */ ],
  "events": {
    "publishes": [ { "name": "catalog.product.approved", "when": "A reviewer approves a submission", "payload": { "productId": "uuid" } } ],
    "consumes":  [ { "name": "sellers.seller.suspended", "does": "Stop showing the seller's draft submissions in the review queue" } ]
  },
  "permissions": [ { "key": "catalog.products.review", "audience": "staff", "desc": "Approve, request changes, reject" } ],
                                           // seller permissions may add "ownerOnly": true and "delegable": false
  "approvalActions": [                     // actions that can need an approval request (access module checks limits)
    { "key": "finance.payouts.release", "desc": "Release a payout run", "limit": "money",   // money | units | percent | none
      "secondReviewer": "above-limit",     // always | above-limit | never
      "stepUp": "always",                  // optional: approving always needs the approver's password again (purpose approval)
      "approvers": "Finance Manager; Business Owner above $50,000 (example)" }
  ],
  "jobs": [ { "name": "catalog.reindex-stale", "schedule": "every 10 min", "does": "…" } ],   // schedule: "every N min|hours", "hourly", "daily|nightly HH:MM market time", "weekly", "monthly", "on boot"; anything else fails boot
  "settings": [ { "key": "maxImagesPerProduct", "type": "int", "default": 12, "desc": "…", "min": 1, "max": 30 } ],   // see "Settings"
  "integrations": [ { "name": "S3-compatible storage", "purpose": "…" } ],
  "notes": ["Anything a builder must know"]
}
```

## Type notation

Used in `types`, `body`, `query`, event `payload` and inline objects.

| Write | Means |
|---|---|
| `string` `text` `int` `number` `bool` `json` | primitives (`text` = long string) |
| `uuid` `email` `url` `date` `datetime` | formatted strings (`date` = YYYY-MM-DD, `datetime` = ISO 8601 UTC) |
| `Money` `Address` `Actor` `MediaRef` `DateRange` `TimelineEvent` `ApprovalInfo` `Deadline` | shared types in `common.json` |
| `Product` | a type in this module's `types` |
| `catalog.ProductSnapshot` | a type from another module (`module.Type`) |
| `T?` | optional and nullable |
| `T[]` | array |
| `enum(a\|b\|c)` | one of the values |
| `map<T>` | object with string keys and `T` values |
| `{ "type": "int", "desc": "…" }` | any of the above with a description |
| `{ "type": "string", "permission": "orders.customers.view-contact", "mask": "email" }` | a sensitive field: masked (`email` → `a***@example.com`, `phone` → `***12`, `name` → `A.`) or hidden (`hide` → null) in seller and admin responses for callers without the permission, centrally after the handler. The GraphQL field that returns it carries `@sensitive(permission, mask)` with the same values; `graphql.mjs` checks they match |
| `{ "field": "type", … }` (nested object) | inline object. An object is a descriptor (rows above) only when all its keys are among `type`, `desc`, `permission`, `mask`; `{ "type": "enum(a\|b)", "note": "text" }` is an object with a field named `type` |

## Endpoints

```jsonc
{
  "id": "approveProduct",                  // unique in the module, camelCase; becomes the OpenAPI operationId (catalog.approveProduct)
  "area": "admin",                         // store | seller | admin | public | webhooks
  "method": "POST",
  "path": "/products/{id}/approve",        // relative to the area prefix: /api/admin/catalog/products/{id}/approve
  "summary": "Approve a submitted product",
  "desc": "Optional longer explanation: rules, side effects.",
  "auth": "staff",                         // every endpoint needs a token (docs/03-auth-middleware.md); per area:
                                           //   store: visitor | shopper | customer | account (any signed-in realm; every app's origin)
                                           //   public: visitor | refresh (refresh token, cookie or body) | bootstrap (app proof, one endpoint)
                                           //   seller: seller · admin: staff · webhooks: provider
  "permission": "catalog.products.review", // optional; must be declared by some module
  "permissionWhen": [                      // optional: an extra permission when the request is about someone else
    { "if": { "query.view": "all" }, "permission": "access.approvals.view-all" }   // value, or "!self" / "!self-member"
  ],
  "stepUp": { "kind": "reauth", "purpose": "payout-account" },  // optional: a single-use re-auth token (password, or a member's 2-step code)
                                           //   in the body field reauthToken (the body, inline or a type of this module, must declare it).
                                           //   The purpose must be listed in identity ReauthRequest.purpose (the build checks it);
                                           //   errors must list STEP_UP_REQUIRED. A missing proof is 403 STEP_UP_REQUIRED, never 400.
                                           //   Money approvals don't use stepUp (only amounts above stepUpAbove need it): they take an
                                           //   optional "reauthToken" (purpose approval) in the body, checked by access.decide
  "sellerContext": "optional",             // seller area only: works before a seller is chosen
  "scope": "own-member",                   // optional override of the derived record scope:
                                           //   public | own-customer | own-seller | own-member | guest-order | staff
  "rateLimit": "sign-in",                  // optional rate-limit class (docs/03 §11): sign-in | registration | password-reset | code |
                                           //   bootstrap | export; an unknown class fails startup. A POST whose path ends in /exports
                                           //   counts as export without it
  "params": { "id": "uuid" },              // must match {placeholders} in path
  "query": { "q": "string?" },
  "paging": true,                          // adds cursor/page/limit (1–100, default 24) and wraps response in Page<…>
  "body": { "note": "string?" },           // type name, inline object, "binary" (raw bytes, any content type; the handler
                                           //   gets the request stream, never buffered, and enforces its own limit), or omitted
  "response": "Product",                   // type, "Product[]", inline object, or null for no body (204 unless status says otherwise, e.g. 202)
  "status": 200,                           // success status (default 200; 201 create; 202 accepted; 204 no content)
  "errors": ["ILLEGAL_TRANSITION"],        // codes from common.json or module-specific UPPER_SNAKE
  "idempotent": false,                     // true → Idempotency-Key header required (rules in docs/api/README.md, Idempotency)
  "audited": true,                         // writes to the action history
  "approval": "Above $2,000 needs a second Finance reviewer",   // optional approval rule
  "events": ["catalog.product.approved"],  // events this call publishes
  "screens": ["admin/product-review"],     // prototype screen ids that use this endpoint
  "phase": 1                               // optional: later phase than the module
}
```

## Tables

Each table is a MongoDB collection `<module>.<table>` (docs/04-mongodb-migration.md §2–3); the notation keeps SQL type names. Column notation: `<type>[?] [pk] [unique] [→ table] [check <expr>] [(comment)]`, e.g. `"uuid? → items"`, `"text (open|closed)"` (a list of plain words is the set of allowed values). Types: `uuid`, `text`, `char(n)`, `int`, `smallint`, `bigint`, `numeric(p,s)` (exact, read as a string), `bool`, `date` (`YYYY-MM-DD`), `timestamptz`, `jsonb`, `bytea`, arrays (`text[]`); `tsvector` columns are not stored (search is the search engine's job). `?` allows null; without it a value must be present (an empty string is a value). Index notation: `"(a, b)"`, `"(a, b) unique"`, `"unique (a) where …"`, `"pk (a, b)"`, `"gin(expr)"`, and `"unique nulls not distinct (a, b)"` when null key columns must count as equal (one row per key, e.g. a saved product with no variant); a plain unique key ignores rows with a null in it. `npm run gen` turns tables into the Mongoose schemas, validators and indexes (`backend/tools/lib/tables.ts`, `mongo.ts`, `mongoose.ts`), and the kernel applies them (`npm run migrate`).

## Settings

Runtime settings a module reads through `ctx.settings`. The settings module lists them on the settings page and changes them with an effective date. Only `key`, `default` and `desc` are required; whatever else is left out, the settings module infers (type from the default, unit from the key name, `min` 0 for numbers, approval and seller visibility from the module).

```jsonc
{ "key": "minimumPayout",                  // camelCase; read as <module>.<key>
  "type": "money",                         // int | number | bool | string | money | duration | time | enum | json
  "default": { "amount": 2500, "currency": "USD" },
  "desc": "Smaller balances roll to the next run",
  "min": 0, "max": 100000,                 // numbers: amount in minor units for money
  "choices": ["weekly", "monthly"],        // enum only
  "unit": "days",                          // shown after the value: days, hours, business days, %, MB…
  "approval": "second_reviewer",           // none | second_reviewer | business_owner (who approves a change)
  "sellerVisible": true,                   // scheduled changes are announced to sellers
  "minLeadDays": 14,                       // earliest effective date after saving (seller-visible keys also get settings.sellerVisibleMinLeadDays)
  "editable": false }                      // shown read-only (default true)
```

`duration` is a whole number in `unit` (days, hours, minutes, business days); `time` is `HH:MM` in the market time zone. Declare `type`, bounds and `approval` for every setting that moves money, sets a limit or deadline customers or sellers rely on, or needs approval; purely technical keys (cache seconds, batch sizes) may carry only `type`.

Module-specific error codes go in `"errorCodes": { "OFFER_CHANGED": { "status": 409, "meaning": "…" } }` at the top level of the module file.

## Constants

Reserved values every module may use go in `common.json` under `constants`. `npm run gen` exports each from `backend/src/spec/common.ts` (`export const OFFICIAL_STORE_ID = '…' as const;`).

```jsonc
"constants": {
  "OFFICIAL_STORE_ID": { "value": "00000000-0000-7000-8000-000000000001", "desc": "…" }   // UPPER_SNAKE name; string, number or boolean value
}
```

`OFFICIAL_STORE_ID` is the seller id of the Official Store wherever a seller id is required (feedback, reviews, returns terms, conversations, report facts, promotion lines). The sellers module never issues it. `OFFICIAL_STORE_NAME` is its display name wherever a seller name is shown.

## Approval responses

An endpoint whose action may need approval (`approval` rule, access `check()` answers `approval_required`) answers in one of two ways:

- **Saved, pending approval**: the module keeps its record in a pending state, calls `access.requestApproval` and answers its normal success status (200, 201 or 202 as declared) with `approval: ApprovalInfo` (required = true, approvalRequestId) in the response body. It finishes on `access.approval.decided`. This is the default.
- **Nothing saved**: only when the action cannot be recorded before approval does it answer `409 APPROVAL_REQUIRED` with `details.approvalRequestId`; the caller repeats the call after the approval.

A response type that can carry a pending approval declares `approval: ApprovalInfo?` (or an existing field such as `pendingApproval`).

## Customer data export hook

Modules holding a customer's personal data (orders, returns, support, messaging, reviews, wishlist, wallet…) declare a public API function `exportCustomerData` with the signature `(input: { customerId: uuid, accountId: uuid }) => CustomerDataSection[]` (common.CustomerDataSection) and `usedBy: ["customers"]`. customers.build-data-exports calls it on every enabled module that declares it and writes each section into the export ZIP; a module that fails is retried, never silently left out.

## Rules
1. Paths are nouns, plural, kebab-case; actions on a record are `POST /{things}/{id}/{verb}` (e.g. `/payouts/{id}/approve`).
2. Every list endpoint is `paging: true` unless it is small and bounded (e.g. categories).
3. Money is `Money`; never floats. Times are `datetime` (UTC).
4. Anything that moves money or creates orders is `idempotent: true`.
5. Status changes go through a declared state machine; illegal moves return `ILLEGAL_TRANSITION`.
6. Material admin actions are `audited: true` and take a `reason` where the plan asks for one.
7. Tables are the module's own collections; reference other modules by id only (no cross-module references).
8. Every endpoint requires a token. Only `identity.startAppSession` uses `bootstrap` (an app proof instead of a token). Secrets never go in URL paths or queries.
9. Tables with a `seller_id` or `customer_id` column are tenant tables: seller and customer callers only reach their own rows. Add `"tenant": false` to a table to opt out, or `"tenant": "<column>"` to name another column.
