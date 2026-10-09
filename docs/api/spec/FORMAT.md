# Module spec format

One JSON file per backend module: `docs/api/spec/modules/<module>.json`.
`node docs/api/tools/build.mjs` validates every file and generates:

- `docs/api/openapi.json`: OpenAPI 3.1 for Swagger UI, Redoc, Postman and client generators
- `docs/api/modules/<module>.md`: readable reference per module
- `docs/api/viewer/data.js`: data for the visual API reference

## File shape

```jsonc
{
  "name": "catalog",                       // kebab-case, = URL segment, = DB schema (snake_case)
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
      "approvers": "Finance Manager; Business Owner above $50,000 (example)" }
  ],
  "jobs": [ { "name": "catalog.reindex-stale", "schedule": "every 10 min", "does": "…" } ],
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
| `{ "type": "string", "permission": "orders.customers.view-contact", "mask": "email" }` | a sensitive field: masked (email, phone, name) or hidden (hide) for staff and sellers without the permission |
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
  "auth": "staff",                         // every endpoint needs a token (docs/03-auth-middleware.md):
                                           //   visitor | shopper | customer | account (store, public)
                                           //   seller (seller) | staff (admin) | refresh | bootstrap (public) | provider (webhooks)
  "permission": "catalog.products.review", // optional; must be declared by some module
  "permissionWhen": [                      // optional: an extra permission when the request is about someone else
    { "if": { "query.view": "all" }, "permission": "access.approvals.view-all" }   // value, or "!self" / "!self-member"
  ],
  "stepUp": { "kind": "reauth", "purpose": "payout-account" },  // optional: reauth = reauthToken in the body; code = X-Step-Up-Code header
  "sellerContext": "optional",             // seller area only: works before a seller is chosen
  "scope": "own-member",                   // optional override of the derived record scope:
                                           //   public | own-customer | own-seller | own-member | guest-order | staff
  "rateLimit": "sign-in",                  // optional named rate-limit class
  "params": { "id": "uuid" },              // must match {placeholders} in path
  "query": { "q": "string?" },
  "paging": true,                          // adds cursor/page/limit and wraps response in Page<…>
  "body": { "note": "string?" },           // type name, inline object, "binary" (raw bytes, any content type; the handler
                                           //   gets a Uint8Array, up to 512 MB, and enforces its own limit), or omitted
  "response": "Product",                   // type, "Product[]", inline object, or null for 204
  "status": 200,                           // success status (default 200; 201 create; 202 accepted; 204 no content)
  "errors": ["ILLEGAL_TRANSITION"],        // codes from common.json or module-specific UPPER_SNAKE
  "idempotent": false,                     // true → Idempotency-Key header required
  "audited": true,                         // writes to the action history
  "approval": "Above $2,000 needs a second Finance reviewer",   // optional approval rule
  "events": ["catalog.product.approved"],  // events this call publishes
  "screens": ["admin/product-review"],     // prototype screen ids that use this endpoint
  "phase": 1                               // optional: later phase than the module
}
```

## Tables

Column notation: `<type>[?] [pk] [unique] [→ table] [check <expr>] [(comment)]`, e.g. `"uuid? → items"`, `"text (open|closed)"` (a list of plain words becomes a CHECK). Index notation: `"(a, b)"`, `"(a, b) unique"`, `"unique (a) where …"`, `"pk (a, b)"`, `"gin(expr)"`, and `"unique nulls not distinct (a, b)"` when null key columns must count as equal (one row per key, e.g. a saved product with no variant). The generator turns them into the module's first migration (`backend/tools/lib/sql.ts`); later migrations must match what the spec says.

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

`OFFICIAL_STORE_ID` is the seller id of the Official Store wherever a seller id is required (feedback, reviews, returns terms, conversations, report facts, promotion lines). The sellers module never issues it.

## Rules
1. Paths are nouns, plural, kebab-case; actions on a record are `POST /{things}/{id}/{verb}` (e.g. `/payouts/{id}/approve`).
2. Every list endpoint is `paging: true` unless it is small and bounded (e.g. categories).
3. Money is `Money`; never floats. Times are `datetime` (UTC).
4. Anything that moves money or creates orders is `idempotent: true`.
5. Status changes go through a declared state machine; illegal moves return `ILLEGAL_TRANSITION`.
6. Material admin actions are `audited: true` and take a `reason` where the plan asks for one.
7. Tables live in the module's own schema; reference other modules by id only (no cross-module foreign keys).
8. Every endpoint requires a token. Only `identity.startAppSession` uses `bootstrap` (an app proof instead of a token). Secrets never go in URL paths or queries.
9. Tables with a `seller_id` or `customer_id` column are tenant tables: seller and customer callers only reach their own rows. Add `"tenant": false` to a table to opt out, or `"tenant": "<column>"` to name another column.
