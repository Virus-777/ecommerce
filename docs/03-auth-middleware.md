# Authentication and authorization middleware per role

Status: **v3, implemented in the kernel** (2026-10-09). The open decisions in §18 were taken with the recommended option; see "Decisions taken".

v3 adds your rule: **every API endpoint requires a token, and tokens are verified in middleware** (§0). v2 still let 78 endpoints run without a token.

v1 was reviewed twice: a fact-check against every spec, and a security review. v2 fixes:
- 6 factual errors: wrong approvers, a missed re-auth endpoint, an endpoint wrongly listed as exempt;
- 2 critical gaps: record scope had no enforcement; development tokens were on everywhere;
- 9 high-risk gaps: revocation across servers, token format, web token storage, guest sessions, step-up binding, field-level data, anonymous callers recorded as "system", secrets in URLs, role grants that carry authority.

§16 lists every change. §17 lists what is built and what still waits for the identity, access, sellers and customers modules.

## 0. Rule: every endpoint requires a token, verified in middleware

**Every request to `/api/*`, `/graphql/*`, `/webhooks/*` and `/files/*` must carry a token.** Token verification is middleware (M4, §3): it runs before validation and before any module code. Handlers and services never read headers or tokens; they receive a verified `principal`. A request with no token, or with a token that fails verification, is refused with 401, including requests to URLs that don't exist (401 before 404), so the API can't be explored without a token.

### Token kinds

| Token | Who holds it | How it's obtained | Verified by M4 against | Lifetime |
|---|---|---|---|---|
| **Visitor token** (new) | anyone using a Marketly app before signing in: store shoppers, the sign-in pages of Seller Center and Admin Center | `POST /api/public/identity/app-sessions` when the app first opens (the bootstrap endpoint below) | same JWT rules as access tokens; `kind: visitor`, audience of the app | 15 min access token + 30-day refresh, rotating |
| **Access token** | customers, seller owners and members, staff | sign-in | JWT: signature, `kid`, `iss`, `aud`, `typ`, expiry; revocation (§6) | 15 min |
| **Refresh token** | the same callers (visitors included) | issued with the access token | hash lookup in `identity.sessions`; reuse rules (§5) | 24 h – 30 days |
| **Provider signature** | payment, carrier, email, SMS, storage and verification providers | shared secret per provider | provider-specific HMAC or signature over the raw body, with a timestamp window | per request |
| **Signed file link** (new) | whoever the API handed a file link to: an `<img src>` in the store, a download button, the Android app | from an API response that already passed the token checks (download endpoints, `refs`, asset views) | HMAC-SHA256 with `secretFor(config, 'media.files')` over the exact bucket, key, expiry, content type and disposition (§0 "File links") | private files: `downloadUrlTtlMinutes` (10 min); public renditions: permanent |

The **visitor token replaces the guest header and guest token.** For the store, the visitor session *is* the guest session: it holds the cart, recently viewed items and guest order grants. The `X-Guest-Session` header is retired, so every caller sends `Authorization: Bearer …`. Signing in claims the visitor session into the account (§8).

### Every endpoint, mapped to its token

| Endpoints | Count | Today | v3 auth kind | Token required |
|---|---|---|---|---|
| Store browsing (product, category, search, reviews, help, policies, storefronts, delivery estimates) | 47 | `anyone`, no token | **`visitor`** | store visitor token or customer token |
| Store cart, checkout, guest order pages | 102 | `shopper` (guest header or customer) | `shopper` | store visitor token or customer token |
| Store account pages | 105 | `customer` | `customer` | customer access token |
| Seller Center | 256 | `seller` | `seller` | seller access token |
| Admin Center and Operations | 728 | `staff` | `staff` | staff access token |
| Public: sign-in (password, Google/Apple, 2-step), registration, codes, password policy and reset, invitations, order links, unsubscribe, app config, fee schedule, brand-owner reports | 19 | `anyone`, no token | **`visitor`** | visitor token of any app (store, seller or admin) |
| Public: start a guest session | 1 | `anyone` | **removed**, replaced by the bootstrap endpoint | – |
| Public: refresh tokens, sign out | 2 | `anyone`, refresh token in the body | **`refresh`** | refresh token (cookie on the website, body on Android), verified in middleware |
| Webhooks | 9 | `provider` | `provider` | provider signature, verified in middleware (M11) |
| File downloads `GET`/`HEAD /files/{bucket}/{key}` (not a spec endpoint) | 1 route | – | **`file-link`** | the link's own signature, verified in middleware (M4) |
| GraphQL store / seller / admin | 3 endpoints (not in the 1,269) | store open to anyone | same as the area | store: visitor or customer token; seller and admin: access token |
| **Bootstrap:** `POST /api/public/identity/app-sessions` | 1 (new) | – | **`bootstrap`** | none: this endpoint issues the first token (below) |

### The one endpoint that can't require a token

Something has to hand out the first token, so the **bootstrap endpoint** is the single entry point without one. Instead of a token, it requires proof that the request comes from a real Marketly app, and it can do nothing else:

- **Android:** a Play Integrity verdict for the Marketly app, checked on the server.
- **Website:** a bot challenge (e.g. Cloudflare Turnstile) solved in the browser and checked on the server.
- **Strict rate limits:** per IP and per device installation (§11).
- **Narrow output:** it issues only a visitor token, which can do no more than an anonymous visitor could in v2: read public data and keep a cart.

### File links (files the API serves)

Files are kept on the server's own disk (media, `MEDIA_STORAGE=local`; owner decision: no S3), so the API serves them: there is no storage host or CDN that could check a presigned URL for us. An `<img src>`, a `<video>` or a plain download link can't send an `Authorization` header, so **the link's signature is its token**, the same way a provider's signature is the token of a webhook.

```
GET /files/marketly-private/originals/<uuid>.pdf?exp=1791640800&ct=application%2Fpdf&cd=attachment%3B+filename%3D%22license.pdf%22&sig=<base64url HMAC>
GET /files/marketly-public/renditions/<uuid>/medium.webp?sig=<base64url HMAC>
```

- **Issued** only inside responses that already passed the normal checks: `GET /assets/{id}/download` (store, seller, admin), `media.signedDownload` after the calling module checked access, private renditions in asset views, `media.refs`. Uploads don't use links: the bytes go to `PUT /api/{area}/media/uploads/{id}/content` with the caller's own token.
- **Signed** with HMAC-SHA256 and the key `secretFor(config, 'media.files')` (HKDF from `APP_SECRET`) over `GET`, bucket, key, `exp`, `ct` (content type) and `cd` (content disposition). Changing any part (another file, a longer life, `text/html` instead of the stored type) breaks the signature.
- **Verified in M4**, as auth kind **`file-link`** (`kernel/auth/file-links.ts`, `chain.ts`), before any module code: missing or wrong signature → **401** `UNAUTHORIZED` (`details.reason`: `link_missing` / `link_invalid`, no `WWW-Authenticate: Bearer`, since a token can't help); expired → **403** `FORBIDDEN` (`link_expired`): the app asks the API for a new link. A Bearer token does not open a file, and anything else under `/files` (another method, no key) is an unknown URL: 401 without a token, as everywhere. The route handler receives the file named by the verified link, never its own reading of the URL.
- **Private files** (originals, documents, evidence, exports, private renditions): links expire after `downloadUrlTtlMinutes` (10 min). Attachments are served `Cache-Control: private, no-store`; inline private images `private, max-age` up to the link's expiry.
- **Public renditions** (product images, store logos and banners, ad and content images): the **public-asset rule**: links without `exp` are accepted only for the public bucket, so stored URLs and `<img src>` keep working without a header. They are still signed per file, so the bucket can't be listed or guessed. Served `Cache-Control: public, max-age=3600`; a takedown replaces the file behind the same link (placeholder) and cached copies follow within the hour. Public URLs are rebuilt from the key on every read.
- **Every file** is served with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, so an uploaded file never runs as one of our pages; `Cross-Origin-Resource-Policy: cross-origin` lets the apps embed images; CORS allows the configured app origins (no credentials).
- **Ranges and caching:** `Range` (one range: 206, 416), `If-Range`, `HEAD`, `ETag` / `If-None-Match` and `Last-Modified` / `If-Modified-Since` (304), so video seeking and resumed downloads work.
- **Rate limit:** file requests count against their own IP bucket (3,000/min), not the API's 600/min, since a page of results loads many images.
- **Key safety:** keys are `/`-separated safe segments (no `..`, no leading dot, no Windows device names); storage refuses any other key, and the local adapter confirms every path stays inside its folder, so even a link signed for a bad key serves nothing (404).
- **Key rotation:** the key derives from `APP_SECRET`. Rotating it invalidates every link handed out, including public image URLs other modules stored (order snapshots); media's own asset views rebuild theirs.

### Other entry points

| Entry | Rule |
|---|---|
| `/health` | served on a separate internal port for the load balancer, not on the public listener |
| `/docs` (Swagger UI and OpenAPI) | off in production; elsewhere it needs a staff token |
| Email and SMS links (password reset, invitation, order link, unsubscribe) | the link opens an app page, which first gets a visitor token, then sends the link's one-time token in the request body |
| Search engines and link previews | they can't call the API without a token. If the website is server-rendered for search engines, the render server uses its own **service token** (decision 9) |
| Response caching | every request now carries a token, so public reads are cached inside the server (read models), not by a CDN keyed on the URL. Exception: `/files` responses, whose token is part of the URL; public renditions are `Cache-Control: public, max-age=3600` (File links above) |

## 1. What every request must answer

| # | Question | Answered by | Where | Failure |
|---|---|---|---|---|
| 1 | **Who** is calling? | A token on **every** request (§0): visitor or access token; refresh token on refresh and sign-out; provider signature on webhooks | middleware (M4) | 401 `UNAUTHORIZED` with `WWW-Authenticate: Bearer error="invalid_token"` |
| 2 | **Which app** is the session for? | Token audience (store / seller / admin) against the API area | middleware | 403 `WRONG_AUDIENCE` |
| 3 | **What** may they do? | Staff: effective permissions from roles. Sellers: member permissions; owner-only keys | middleware | 403 `FORBIDDEN` (`details.permission`), 403 `OWNER_ONLY` |
| 4 | **Is it really them, now?** | 2-step on staff sessions; re-auth token bound to session, seller and purpose for sensitive account changes | middleware | 403 `STEP_UP_REQUIRED` |
| 5 | **Which records?** | Scoped data access: every query on a tenant table carries the caller's scope | **enforced in the data layer** (not left to handlers) | 404 `NOT_FOUND` (never reveals that the record exists) |
| 6 | **How much** may they approve? | `access.check(principal, action, amount)` against approval limits | service, through a kernel helper | 202 / 409 `APPROVAL_REQUIRED` |

### Principles

1. **Check permissions, never role names.** Roles are data in `access`: seeded, editable, custom ones allowed, and one person can hold several. Middleware matches **exact permission keys**. Wildcards in seeds are expanded when seeding, so a key a module adds later is never granted silently.
2. **Access is not authority.** A permission opens an action; an approval limit decides the amount. Assigning a role that carries a limit therefore needs the Business Owner (§12).
3. **Deny by default, derived from the spec.** Each endpoint's chain is built at startup from its spec fields. An endpoint with an unknown auth kind, or an admin GraphQL root field without `@auth`, fails the build.
4. **Scope is a property of data access, not a habit.** Tenant tables (anything with `seller_id`, `customer_id` or guest grants) can only be read through scoped queries, and a generated cross-tenant test runs for every endpoint with parameters (§7).
5. **One source of truth for revocation.** Revoked sessions live in PostgreSQL and every server polls them. A server never relies on having received an event (§6).
6. **Fail closed.** No endpoint takes an optional token: a missing or unverifiable token is always 401. If identity, access or sellers can't answer, the request gets 503, not access.
7. **One chain for REST and GraphQL.** GraphQL endpoints run the same middleware and share the field-masking table (§9).
8. **Restrictions are not sign-in blocks.** A restricted seller keeps orders, returns and support (scenario 7); services call `sellers.canSell` for the blocked activities.

## 2. Callers and actors

| Caller | Realm | Session | Areas | Identified by | Session rules | Actor recorded |
|---|---|---|---|---|---|---|
| **Visitor** (store: also the guest) | – | visitor session | store (`visitor`, `shopper`); public (`visitor`) | **visitor token**, `kind: visitor`, audience of the app (§0) | access 15 min; refresh 30 days after last activity; order grants 90 days; ends when claimed by sign-in | `visitor` (session id, never the token) |
| **Not yet identified** | – | none | only the bootstrap endpoint | app proof (Play Integrity / bot challenge) | – | `anonymous` (with IP) |
| **Customer** | member | store | store, plus `account` endpoints | access token, audience store | access 15 min; refresh 24 h, or 30 days with "keep me signed in"; 2-step optional | `customer` |
| **Seller owner** | member | seller | seller, plus `account` endpoints | access token, audience seller, with seller context | as customer; one seller at a time | `seller` (member id, seller id) |
| **Seller member** | member | seller | seller, plus `account` endpoints | as owner; role template | as owner; seller staff are phase 2 (at launch each seller has only its owner) | `seller` |
| **Staff** | staff | admin | admin, Operations, plus `account` endpoints | access token, audience admin | 2-step always; **idle timeout 30 min**; absolute 12 h; new-device alert | `staff` (with roles) |
| **Provider** | – | – | webhooks | provider signature over the raw body | per-provider secrets, two active during rotation | `provider` (provider name) |
| **System** | – | – | none: jobs and event consumers only | branded actor, built only by the scheduler and the event bus | – | `system` |

v1 recorded anonymous callers and webhooks as `system`. v2 gives them their own actor kinds, so a rule like "system actions skip approval" can never apply to internet traffic.

**Roles.**
- **Sellers:** `owner`, `products_inventory`, `shipping`, `customer_service`, `custom` (stored in `sellers`).
- **Staff:** `business_owner`, `platform_administrator`, 16 management roles, the task roles `warehouse_worker`, `finance_staff` and `support_agent`, and custom roles (stored in `access`).

## 3. The middleware chain

```
request
  │ app-level onRequest (runs for every URL, including unknown routes)
  ├─ M1  requestContext      server request id (client X-Request-Id kept as clientRequestId); client kind and version for analytics and version gating only
  ├─ M2  ipRateLimit         per-IP bucket; client IP from TRUST_PROXY hops/CIDRs
  ├─ M4  authenticate        REQUIRED on every URL: verify the token the endpoint's kind needs (§0): JWT (alg allowlist, kid, iss,
  │                          aud, typ, exp/iat ± 60 s) + revocation (§6), refresh-token lookup, file-link signature (/files),
  │                          or (webhooks) defer to M11;
  │                          unknown URL without a valid token → 401 before 404; only `bootstrap` takes an app proof instead
  │ route onRequest
  ├─ M3  phaseGate           endpoint launch phase > LAUNCH_PHASE → 501
  ├─ M5  principalRateLimit  per account / visitor / (account, seller) bucket
  ├─ M6  audience            token audience ↔ API area; auth kind `account` takes any realm
  ├─ M7  callerKind          visitor | shopper | customer | account | seller | staff | refresh | provider | bootstrap
  ├─ M8  sellerContext       seller in token (unless sellerContext: optional); member active; token memberId = current member
  ├─ M9  permission          exact keys; staff effective set; seller member keys; ownerOnly → OWNER_ONLY
  ├─ M10 staffSession        twoStepVerifiedAt set; idle timeout; session alive (5 s cache)
  │ preValidation (raw body available)
  ├─ M11 webhookSignature    provider verifier over raw bytes; timestamp window; returns {provider, eventId}
  ├─ M12 bodyRateLimit       named classes keyed by body fields (sign-in per email, reset per email)
  │ validation (Zod, from the spec)
  │ preHandler
  ├─ M13 idempotency         replay first (already built)
  ├─ M14 reauth              VERIFY the re-auth token (bound to account, session, audience, seller, purpose)
  ▼ handler (one transaction)
      scoped data access (§7) · authority (access.check) · consume re-auth token · record webhook event id
      response → central field masking (§9) → serializer
```

| Middleware | Hook | Today | Does | Failure |
|---|---|---|---|---|
| M1 requestContext | app onRequest | partly | The server always generates the request id. A client `X-Request-Id` is kept as `clientRequestId`, so a client can't forge correlation in audit. `X-Client: web\|android/<version>` is used for analytics and "update required" (426) only, never for trust | 426 `UPGRADE_REQUIRED` (proposed) |
| M2 ipRateLimit | app onRequest | – | Protects token verification and guest lookups, and also covers unknown routes (404 scanning). Shared store (§11) | 429 `RATE_LIMITED` + `Retry-After` |
| M4 authenticate | **app onRequest** (every URL) | partly (optional on `anyone` today) | **Mandatory.** Picks the verifier from the route's auth kind: JWT for visitor and access tokens (local verification, §5, plus revocation, §6); hash lookup for `refresh`; handed to M11 for `provider`; app proof (Play Integrity / bot challenge) for `bootstrap`; the link's HMAC for `file-link` (§0 "File links": 401 bad, 403 expired). Unmatched URLs need a valid visitor or access token, so 404 is only ever seen with a token | 401 + `WWW-Authenticate` |
| M3 phaseGate | route onRequest | built | unchanged; now runs after authentication, so the roadmap isn't visible without a token | 501 |
| M5 principalRateLimit | route onRequest | – | Buckets per §11 | 429 |
| M6 audience | route onRequest | built (401) | Becomes 403 `WRONG_AUDIENCE`, so clients don't loop on refresh. New auth kind `account` (any realm) for self-service security endpoints | 403 `WRONG_AUDIENCE` |
| M7 callerKind | route onRequest | built | `visitor` (any token of the app, signed in or not), `shopper`, `customer`, `account`, `seller`, `staff`, `refresh`, `provider`, `bootstrap`. `anyone` no longer exists | 401 |
| M8 sellerContext | route onRequest | built, with the bug below | Requires `sellerId` in the token unless the endpoint has `sellerContext: optional`. **Today it blocks the two endpoints used to pick a seller.** Member must be active, and the token's `memberId` must match the current member, so a removed and re-invited member's old tokens fail | 401 `seller_context_required`, 403 `NO_SELLER_ACCESS` |
| M9 permission | route onRequest | built | Exact-key match. Staff: effective set (§6). Seller: member keys; `ownerOnly` keys need `isOwner` even if listed. Conditional permissions (`permissionWhen`, §13) | 403 `FORBIDDEN` / `OWNER_ONLY` |
| M10 staffSession | route onRequest | – | Staff sessions must carry `twoStepVerifiedAt`. 30-minute idle timeout. The session must still be alive (indexed lookup, 5 s cache) | 401 / 403 `STEP_UP_REQUIRED` |
| M11 webhookSignature | preValidation | in preHandler | Moves before validation and runs over raw bytes (`parseAs: 'buffer'`). Verifiers are registered **per provider** and return `{provider, eventId, timestamp}`; the kernel enforces a window of at most 5 minutes | 401 |
| M12 bodyRateLimit | preValidation | – | Sign-in and reset limits per email (identity notes), stored in PostgreSQL (`sign_in_attempts`) | 429 |
| M13 idempotency | preHandler | built | Runs **before** M14, so a retried request replays instead of burning a re-auth token | 422 / 409 |
| M14 reauth | preHandler | – | Verifies only; the token is consumed inside the handler's transaction after success | 403 `STEP_UP_REQUIRED` |

Two things stay out of middleware on purpose:
- **The 2-step code for large approvals** depends on the amount, so `access.decide` checks it, and now also for the payout-run and refund approvals that call it (§10).
- **Seller restrictions** are activity checks done through `sellers.canSell`.

## 4. Chains per caller

| Caller | M4 | M6 | M7 | M8 | M9 | M10 / M14 | Scope (§7) |
|---|---|---|---|---|---|---|---|
| Not yet identified | app proof, bootstrap only | – | `bootstrap` | – | – | – | none: receives a visitor token and nothing else |
| Visitor (store guest) | visitor token | store, or any app on public endpoints | `visitor`, `shopper` | – | – | – | `{ visitor }`: public data; own cart; order data only through grants (`hasGuestOrderAccess`) |
| Any caller refreshing | refresh token | – | `refresh` | – | – | – | own session only |
| Customer | access token | store; any realm for `account` | `visitor`, `customer`, `shopper`, `account` | – | – | M14: account closure, email change, 2-step removal, recovery codes | `{ customer }`. The visitor session is claimed at sign-in (§8) |
| Seller owner | token | seller | `seller`, `account` | yes | all seller keys, owner-only included | M14: payout account change, business change, seller closure | `{ seller, member }` from the token, never the path |
| Seller member | token | seller | `seller`, `account` | yes, memberId match | template keys; owner-only refused (`OWNER_ONLY`) | – | as owner. Endpoints about *a member* (preferences, profile) also check `own-member` |
| Staff | token | admin | `staff`, `account` | – | effective set; conditional permissions | M10 always; M14 for sensitive staff actions if decision 5 = yes | `{ staff }`: all records; sensitive fields masked by permission (§9) |
| Provider | signature (M11) | – | `provider` | – | – | event-id de-duplication in the handler transaction | provider's records |
| Holder of a file link | link signature (M4) | – | `file-link` | – | – | – | the one file the link names |

## 5. Tokens and sessions

**Access token**, issued by identity:
- **Format:** JWT signed with **EdDSA** (Ed25519). Verifiers accept only that algorithm.
- **Keys:** the private key lives only in identity and comes from the secret store. The kernel reads public keys by `kid` from config (`AUTH_JWKS`). During rotation the old key stays valid for at least token TTL + leeway.
- **Header and claims:** `typ: at+jwt`, `iss: marketly-identity`, `aud: store|seller|admin` (exact match), `kind: visitor|customer|seller|staff`, `sub` (account; absent for visitors), `sid` (session; for store visitors this is the guest session), `sellerId`, `memberId`, `authAt`, `twoStepAt`, `iat`, `exp`, `jti`.
- **Lifetime:** 15 minutes, with 60 s of clock leeway, for visitor and signed-in tokens alike. Visitor and signed-in tokens are the same format and go through the same middleware; only `kind` and what it unlocks differ.

**Other signed or secret tokens:**
- Re-auth, order links, password reset and invitations each use their own `typ` or are opaque random values stored hashed. None of them can be confused with an access token, and none of them replaces it: the request still needs a visitor or access token (§0).
- **No secret appears in a URL path or query** (§13): reset, invitation and order-link tokens move to POST bodies. The logger redacts any that remain, and those pages send `Referrer-Policy: no-referrer`.

**Refresh tokens:**

| Client | Where the refresh token lives | Protection |
|---|---|---|
| Website (store, Seller Center, Admin Center) | `__Secure-mk_refresh` cookie: `HttpOnly; Secure; SameSite=Strict; Path=/api/public/identity/sessions` (sent only to refresh and sign-out; a `__Host-` cookie would have to use `Path=/`). The access token stays in memory only | Refresh and sign-out require an allowed `Origin` and a custom header (`X-Requested-With`); CORS allowlist per area with credentials only on the refresh path; Content-Security-Policy on Admin Center and Seller Center |
| Android app | Response body, as today; stored with Android Keystore / EncryptedSharedPreferences | Verified App Links for order and reset links |

- **Rotation:** a reused previous token within **20 s** returns the same new pair. This handles two tabs, or parallel app requests, refreshing at once. Reuse outside the window revokes the session and writes a security event, but **does not lock the account**. Clients refresh one request at a time.
- **Staff sessions:** idle timeout 30 minutes, absolute limit 12 hours, an alert on sign-in from a new device, and at most 3 concurrent staff sessions (proposal).
- **Impersonation ("act as customer") is not supported.** No endpoint mints a token for another account. Support uses the read-only customer view.

## 6. Revocation and caches

| What | Source of truth | How servers learn it | Rule |
|---|---|---|---|
| Revoked session | `identity.sessions.revoked_at` | Every server polls `revoked since <cursor>` every 2–5 s and loads the last 15 minutes on startup | token `sid` in the revoked set → 401 |
| Account-wide revocation (disable, close, forced reset, staff "sign out everywhere") | **`accounts.tokens_valid_after`** (new column) | same poll | token `iat` < `tokens_valid_after` → 401. A token issued after unlocking keeps working |
| Admin sessions | `sessions` row | M10 checks liveness on every admin request (5 s cache) | revoked or idle → 401 |
| Failed-sign-in lock | `accounts.locked_until` | – | **blocks new sign-ins only**; existing sessions continue. Otherwise anyone who knows an email could sign that person out |
| Staff permissions | `access.permissionsOf(accountId)` | cached 60 s; flushed on `access.role.changed`, `access.coverage.changed`, `access.away.started` and `access.away.ended` | Own active role assignments. **Cover alone grants nothing**: it re-routes work and notices, and the backup acts with their own roles and limits. Only an away period whose **delegation the Business Owner approved** (`delegateApprovals`, approval action `access.delegations.approve`) lends the covering person the covered roles' permissions and the away person's approval limits (never above them; decisions record `viaDelegationFrom`); a delegation still waiting for approval lends nothing, and rejecting it rejects the whole period. Away periods are read **at request time** (`now ∈ [from, to)`, status scheduled or active) and only while the away person still holds the handed-over role. Events are only a cache hint, so cover and delegation end on time even if the job scheduler is off |
| Seller member access | `sellers.getMemberAccess` | cached 60 s; flushed on `sellers.member.*`, `sellers.seller.closed` | `memberId` must match the token |

`identity.session.revoked` is still proposed as an event for notifications and audit. Correctness doesn't depend on it.

## 7. Record scope, enforced (Q5)

v1 left scope to a helper that each handler would have to remember to call. Across about 1,000 handlers that is a data breach waiting to happen. v2 enforces it in four places:

1. **Spec field `scope`** on every endpoint and every GraphQL field that returns tenant data: `own-seller | own-customer | own-member | guest-order | staff | public`. Generated defaults: seller area → `own-seller`; store area with `customer` auth → `own-customer`; `shopper` → `own-customer` or `guest-order`.
2. **Scoped data access.** Tenant tables are read through `scoped(ctx.db, input.scope)`, a Kysely wrapper that adds `seller_id = ?` / `customer_id = ?` / grant joins to every query on a table declared as tenant-owned in the spec (a new `tenant: seller_id` table flag). `check:boundaries` rejects plain `selectFrom('<tenant table>')` outside the module's `infra/` scoped helpers.
3. **Generated cross-tenant tests.** For every endpoint with path parameters: create the record as tenant A, call as tenant B, expect 404. The contract suite generates these from the spec, the same way it generates the auth tests today.
4. **GraphQL**: the context carries the same scope, and resolvers for seller and store types must read through scoped loaders. A type without `@scope` in the seller or store schema fails the build.

`own-member` covers endpoints about one member, e.g. `PUT /api/seller/notifications/preferences/members/{memberId}`. The owner may change anyone's preferences; other members may change only their own.

## 8. Visitor sessions (the guest session)

- The app calls the bootstrap endpoint once, on first open, and gets a visitor access token and a refresh token. From then on every call carries `Authorization: Bearer <visitor token>`, exactly like a signed-in user. `X-Guest-Session` is retired.
- For the store, the visitor session **is** the guest session: cart, recently viewed items, guest checkout and guest order grants hang off its id (`sid`). v2's separate 256-bit guest token is no longer needed, because the session id is never the secret: the signed token is.
- The session id stays the identifier recorded in actors, events, timelines and audit. The token never appears there.
- **Signing in claims the visitor session.** The sign-in request carries the visitor token, identity moves the cart and order grants to the account, and the visitor session ends, so the next person on a shared computer can't use it. The app then holds a customer token instead.
- Visitor sessions of Seller Center and Admin Center can only call public sign-in endpoints; they hold no cart.
- Bootstrap limits are keyed by IP **and** device installation id, with a higher per-IP ceiling, because mobile carriers put many phones behind one IP (§11).
- Visitor sessions are created on app open rather than on first add to cart, so there will be many more of them. Rows are small, expire after 30 days without activity, and are purged by `identity.purge-expired`.

## 9. Field-level data and module-to-module calls

- **Sensitive fields are marked in spec types**, for example `{ type: 'email', permission: 'orders.customers.view-contact', mask: 'email' }`. One central step masks or strips them, both in the REST serializer and in the GraphQL field wrapper, from the same table. Handlers never decide.
- **Public-API functions that return data shown to a person take `viewer: Principal`.** Aggregators (the seller 360, the customer 360) mark sections the viewer may not see as `unavailable: 'not_permitted'`. Example: `sellers.getSellerAdmin` must not show finance balances to a Seller Manager without finance permissions.
- **GraphQL:**
  - the admin, seller and store endpoints run M1–M10;
  - every admin root field needs `@auth(STAFF, permission)`, or the build fails (today 139 of 199 `@source` fields carry `@auth`);
  - introspection is off in production;
  - the `@cost` limit is built, not only the depth limit;
  - every API response is `Cache-Control: private, no-store` (every request now carries a token), so a CDN never serves one customer's page to another; public reads are cached inside the server.

## 10. Step-up and re-authentication

| Proof | Used for | Binding | Lifetime |
|---|---|---|---|
| Staff 2-step at sign-in | every admin session | session | until idle or absolute limit |
| Re-auth token (password or 2-step code) | customer account closure, email change, 2-step removal, recovery-code regeneration; seller payout account change, business change, seller closure; staff actions that need a re-auth | account + session + audience + seller + **purpose** (one per action: the request names the purpose and `verifyReauthToken` refuses a token issued for another) | single use, 5 minutes, consumed after success |
| Approval 2-step code | money approvals above `stepUpAbove` ($10,000): `access.approveRequest`, **and** the finance payout-run approval and refund approval that call `access.decide` | request + amount | single use |
| *(decision 5)* Fresh 2-step for sensitive staff actions | role grants (`access.*`), staff account actions (`identity.staff-accounts.*`), finance destination changes, identity exports | action | single use |

- **Shared failure counter.** Re-auth, every inline current-password check and approval codes count against one identity counter that shares lockout with sign-in: 5 wrong answers lock step-up for 15 minutes and write a security event. Otherwise a stolen session becomes a password or 2-step guessing oracle.
- **Seller and staff re-auth.** `POST /api/seller/identity/reauth` issues tokens bound to the seller (it also works before a seller is chosen); `POST /api/admin/identity/reauth` issues them to staff. The store `/reauth` is **not** an `account` endpoint, so a seller session can't use a store re-auth token on seller actions.

## 11. Rate limits

| Stage | Class | Key | Default | Store |
|---|---|---|---|---|
| M2 (before auth, all URLs) | IP | client IP (`TRUST_PROXY`) | 600/min | shared (PostgreSQL `kernel.rate_limits`; per process with `RATE_LIMIT_STORE=memory`) |
| M5 (after auth) | Visitor | visitor session (and IP) | 300/min reads, writes 30/min | shared |
| M5 | Customer | account | 120/min, writes 30/min | shared |
| M5 | Seller member | account + seller | 300/min | shared |
| M5 | Staff | account | 600/min | shared |
| M5 | Exports | account | 10/hour | shared |
| M12 (body) | Sign-in | IP / email | 10/min per IP, 5 per 15 min per email | PostgreSQL (`sign_in_attempts`) |
| M12 | Registration, password reset | email / IP | 5/hour per email, 20/hour per IP | PostgreSQL |
| M4 (bootstrap) | Visitor token issue (`app-sessions`) | IP + installation id | 30/hour per installation, 300/hour per IP, after a valid app proof | shared |
| M4 | Refresh | session | 30/hour per session | shared |
| M11 | Webhooks | provider | 1,000/min | shared |

The identity limits come from the identity notes. The others are proposals. "Shared" is the PostgreSQL table `kernel.rate_limits`: every server instance counts in the same fixed windows (no Redis; see [02-backend-architecture.md](02-backend-architecture.md#several-server-instances-jobs-and-rate-limits)). Modules count their own business limits there too, with `ctx.rateLimit`.

**Enumeration.** Unknown emails get the same lockout and limit responses as real ones (identity simulates them), so `ACCOUNT_LOCKED` and the per-email 429 reveal nothing.

## 12. Governance of roles and accounts

Proposals, with what is built (status after gap pass 4):

- **Assigning a role that carries a non-zero approval limit needs Business Owner approval.** Otherwise new limits start at zero until the Business Owner reviews them. *Built in part:* limits live on roles and change only through `access.limits.change` (Business Owner); grants of roles with sensitive permissions (`sensitivePermissionPrefixes`: `access.`, `identity.staff-accounts.`, `finance.`, `audit.entries.export`, `settings.changes.`) need a second reviewer (`access.roles.sensitive-grant`, Platform Administrator or Business Owner, never the requester), and the Business Owner role or any role for yourself needs the Business Owner; an invitation can ask the Business Owner to review the new member's limits (`requestLimitReview`), and until then the member approves nothing. *Open:* a role whose limits are non-zero but whose permissions are not sensitive (e.g. Returns Manager, Customer Support Manager) is granted without a second reviewer.
- **Accounts holding the Business Owner role** (or limits above a threshold) can't be locked, disabled, force-reset or have 2-step reset without a second reviewer that includes the Business Owner or the designated deputy. *Open:* staff account actions need `identity.staff-accounts.manage` and a fresh 2-step code (`staff-account`), but no second reviewer. The last active Business Owner assignment can't be revoked (`LAST_BUSINESS_OWNER`).
- **Disabling an account suspends its role assignments instead of deleting them.** *Open:* access still revokes them on `identity.account.disabled` (and drops the person from lead/backup duties); re-enabling needs new grants, and a Business Owner grant then needs another Business Owner.
- **Deputy owner.** *Built:* `npm run bootstrap-owner -- --deputy-email … --deputy-name …` seats a second Business Owner (with Platform Administrator) next to the first, so the two-person rules work from day one: either can approve the sensitive grants the other requests, neither their own. Without a deputy, sensitive grants wait for a second Business Owner.
- **Break-glass.** A sealed deputy-owner role, activated by two people for at most 24 hours, alerting every Business Owner and fully audited. *Not built:* the deputy above is a standing second Business Owner, not a sealed role; there is no time-boxed emergency activation.
- **Logging and alerts.** Every 401/403/step-up failure is counted by account and IP. Staff `FORBIDDEN` on sensitive keys goes to audit. Re-auth and step-up failures write `security_events`. Spikes alert the Platform Administrator and the Business Owner.

## 13. Permission rules the middleware must know

**Endpoints with no `permission` (spec today):**
- **Admin, 29.** Self-service views (my access, my inbox, coverage), reference reads (product and brand lookups, fee calculator), and **approval decisions and away periods**. Decisions are authorized inside `access` (eligible approver, never the requester). Away periods are the caller's own unless they hold `access.away.manage`.
- **Seller, 84, of which 67 are in launch phases.** Most are reads of the seller's own data. Flagged:
  - `sellers.getPayoutAccount` and `sellers.listMembers` should need owner or `sellers.staff.manage`;
  - `notifications.updateMemberPreferences` needs the `own-member` scope (§7).

**Conditional permissions** (spec field `permissionWhen`, proposed):

| Endpoint | Condition | Permission |
|---|---|---|
| identity admin account actions | target is a staff account | `identity.staff-accounts.manage` |
| `access.listApprovalRequests` | `view=all` | `access.approvals.view-all` |
| `access.createAwayPeriod` / `endAwayPeriod` / `cancelAwayPeriod` | for someone else | `access.away.manage` |
| `notifications.updateMemberPreferences` | another member | owner, or `notifications.preferences.manage` |

**Seller owner-only keys:** `sellers.staff.manage`, `sellers.payout-account.manage` (never delegable), `sellers.business.change`, `sellers.agreements.accept`, `sellers.account.close`, and, for now, the finance view (`finance.balances.view`, per `PermissionEntry.ownerOnly`).

## 14. Seed permission sets (to confirm)

Staff roles get **staff-audience keys only.** The seed's wildcards are expanded to explicit keys at seed time, leaving out seller-audience keys such as `orders.fulfillment.*` or `finance.balances.view`.

| Role | Permissions (staff keys) | Approval actions (from the approvers in each spec; example limits) |
|---|---|---|
| **Business Owner** | every staff `*.view` key; `access.limits.approve`; `access.approvals.view-all`; `audit.entries.*`; `audit.retention.manage` | final approver above every limit, and the only approver of `access.limits.change`, `access.delegations.approve`, `advertising.rules.change`, `audit.retention.change`, `content.policies.approve`, `content.policies.short-notice`, `finance.fees.change`, `returns.baseline.change`, `returns.policies.shorten-window`, `settings.changes.apply-owner`, `fulfillment-service.fees.change` |
| **Platform Administrator** | `access.roles.view/manage`, `access.away.manage`, `identity.staff-accounts.manage`, `identity.accounts.view`, `settings.view`, `settings.changes.propose`, `settings.flags.manage`, `notifications.templates.*`, `notifications.routing.manage`, `audit.entries.view` (told about integrity failures), `audit.retention.manage` (proposes; shortening needs the Business Owner) | no financial authority; second approver of `access.roles.sensitive-grant`; second reviewer of `settings.changes.apply` (never their own change); recommend only: `settings.changes.apply-owner`, `audit.retention.change`, `access.limits.change`, `access.delegations.approve` |
| Official Store Manager | `offers.official.manage`, `offers.official.price`, `catalog.products.manage-official`, `inventory.stock.view`, `purchasing.orders.view` | `offers.prices.change` (±30%) |
| Purchasing Manager | `purchasing.*` | `purchasing.orders.send` (to $25,000) |
| Inventory Manager | `inventory.*` (staff keys), `fulfillment-service.operations.view` | `inventory.adjustments.apply` (50 units) |
| Warehouse Manager | `warehouse.*`, `inventory.stock.view`, `inventory.discrepancies.resolve`, `fulfillment-service.inbound.receive`, `fulfillment-service.operations.view` | `fulfillment-service.reimbursements.approve` (to $500, phase 4) |
| Order Manager | `orders.orders.*`, `orders.cancellations.decide`, `cart.carts.view`, `checkout.sessions.view`, `fulfillment-service.operations.view`, `trust.recommendations.decide` | – |
| Shipping Manager | `shipping.*` (staff keys) | `shipping.claims.open` (to $1,000) |
| Returns Manager | `returns.requests.*`, `returns.inspections.record`, `returns.exceptions.propose`, `returns.policies.manage`, `inventory.returns.record`, `fulfillment-service.inbound.receive`, `trust.recommendations.decide` | none: **refund approval belongs to Finance**; recommend only: `returns.baseline.change`, `returns.policies.shorten-window` |
| Catalog Manager | `catalog.*` (staff keys), `media.assets.*` (staff keys), `search.synonyms.manage`, `reviews.answers.staff`, `offers.offers.view`, `offers.offers.remove` (Catalog owns offer suspension, decision D8), `trust.recommendations.decide` | `catalog.products.publication-override` (with Trust and Risk Manager) |
| Seller Manager | `sellers.*` (staff keys), `offers.offers.view`, `offers.offers.remove`, `fulfillment-service.enrollment.review`, `trust.recommendations.decide` | `sellers.sellers.restrict`, `.suspend`, `.close` (second reviewer), `sellers.performance.targets` |
| Customer Support Manager | `support.*`, `customers.*` except `accounts.export`, `messaging.*`, `orders.orders.view`, `orders.customers.view-contact`, `returns.requests.view`, `wallet.credit.view`, `wallet.goodwill.grant`, `trust.recommendations.decide` | `support.remedies.approve`, `wallet.goodwill.grant` (to $50), `customers.accounts.close-with-obligations` |
| Finance Manager | `finance.*` (staff keys), `payments.*`, `returns.refunds.approve`, `reports.marketplace-finance.view`, `reports.trading.view`, `wallet.*`, `fulfillment-service.fees.manage`, `trust.recommendations.decide` | `finance.payouts.release`, `finance.holds.*`, `finance.adjustments.record`, `finance.writeoffs.approve`, `finance.credits.issue`, `finance.destinations.approve`, `finance.reconciliation.correct`, `payments.disputes.accept`, `returns.refunds.approve`, and the "above it" side of `advertising.charges.void`, `shipping.claims.open`, `wallet.gift-cards.issue`, `fulfillment-service.reimbursements.approve` and `fulfillment-service.charges.reverse` (to $10,000); recommend only: `finance.fees.change` |
| Marketing Manager | `promotions.*`, `content.homepage.manage`, `reports.customers-marketing.view`, `notifications.broadcasts.manage`, `advertising.campaigns.review` | `promotions.budgets.approve` (Marketing limit) |
| Advertising Manager | `advertising.*` (staff keys) | `advertising.charges.void` (within limit); recommend only: `advertising.rules.change` |
| Content Manager | `content.*`, `media.assets.manage`, `advertising.campaigns.review` | recommend only: `content.policies.approve`, `content.policies.short-notice` (the Business Owner approves) |
| Trust and Risk Manager | `trust.*` except `reports.export-identities`, `reviews.moderation.*`, `reviews.appeals.decide` | `trust.enforcements.reverse`, co-approver of publication override |
| Reports Analyst | `reports.*` (staff keys) except `readmodels.manage`, `search.analytics.view` | – |
| Warehouse worker (task) | `warehouse.view`, `warehouse.picking/packing/putaway.perform`, `warehouse.returns.receive`, `fulfillment-service.inbound.receive` | – |
| Finance staff (task) | `finance.ledger.view`, `finance.reconciliation.work`, `finance.payouts.prepare`, `finance.holds.manage`, `finance.adjustments.record`, `payments.refunds.view`, `returns.refunds.approve` | within their limits: `finance.holds.place/release`, `finance.adjustments.record` (to $500), `finance.reconciliation.correct` (to $200), `finance.credits.issue` (to $2,000), `payments.disputes.accept`, `returns.refunds.approve` (to $2,000) |
| Support agent (task) | `support.cases.view/handle`, `customers.accounts.view`, `customers.notes.write`, `messaging.conversations.read/participate`, `orders.orders.view`, `wallet.credit.view`, `wallet.goodwill.grant` | `support.remedies.approve` (to $50) |

Every staff role also gets `workqueues.items.view` and `workqueues.items.work` for its own queues. Limits are the spec's example values and must be confirmed by the Business Owner.

**Recommend only** is a seeded limit (authority `recommend_only`) for the roles that prepare a Business-Owner-only action: `access.check()` answers `approval_required` (not `denied`), so their proposal becomes a Business Owner approval request. A role without it may not even propose the action. Seeded limits added later reach existing installs at the next registry sync, only where the role never had a limit row for that action; seeded permissions added later arrive by migration. Advertising takes a reviewer's role (Advertising, Content or Marketing Manager) from `access.rolesOf`, never from the request body.

**Seller role templates** (48 seller keys):

| Template | Permissions |
|---|---|
| owner | all seller keys, owner-only included |
| products_inventory | `catalog.products.submit`, `offers.offers.manage`, `offers.prices.manage`, `offers.bulk.update`, `offers.offers.export`, `inventory.stock.adjust`, `inventory.stock.export`, `media.assets.upload`, `promotions.discounts.manage`, `fulfillment-service.inbound.manage`, `fulfillment-service.fees.view` (Fulfilled by Marketly, phase 4) |
| shipping | `orders.fulfillment.view/manage/export`, `shipping.seller-shipments.view/manage`, `shipping.seller-settings.view` |
| customer_service | `messaging.conversations.reply`, `support.cases.respond`, `returns.requests.respond`, `reviews.responses.post`, `orders.fulfillment.view` |
| custom | chosen by the owner; owner-only keys refused with `OWNER_ONLY`, non-delegable keys with `NOT_DELEGABLE` |

## 15. Spec changes this design needs

| # | Change | Where |
|---|---|---|
| 1 | Auth kind **`account`**: any signed-in account, any realm, for self-service security endpoints (`GET /security`, `PUT /password`, `POST /email-changes`, `/two-step/*`, `/devices/*`, `GET /security-activity`). Store `/reauth` stays `customer` | common.json `auth`, identity |
| 2 | Endpoint field **`stepUp: { kind: 'reauth', purpose }`**: `customers.requestClosure`, `sellers.changePayoutAccount`, `sellers.requestBusinessChange`, `sellers.requestSellerClosure`, `identity.requestEmailChange`, `identity.removeTwoStepMethod`, `identity.regenerateRecoveryCodes` | FORMAT.md, those modules |
| 3 | `stepUpCode` and `STEP_UP_REQUIRED` on `finance.approvePayoutRun` and `returns.approveRefund` (they call `access.decide`) | finance, returns |
| 4 | Re-auth token binding: `verifyReauthToken(principal, token, purpose)` | identity publicApi |
| 5 | Common errors: `WRONG_AUDIENCE` 403, `STEP_UP_REQUIRED` **403** (now 401 in access and sellers), `OWNER_ONLY` 403, `NO_SELLER_ACCESS` 403, `UPGRADE_REQUIRED` 426, `SERVICE_UNAVAILABLE` 503 | common.json `errors` |
| 6 | Endpoint field **`scope`** and table flag **`tenant`** (§7) | FORMAT.md, every module |
| 7 | Permission flags **`ownerOnly`**, **`delegable`** | FORMAT.md, module permissions |
| 8 | Endpoint field **`permissionWhen`** (§13) | FORMAT.md, identity, access, notifications |
| 9 | Endpoint field **`sellerContext: 'optional'`** on `identity` `GET /session/sellers` and `POST /session/seller-context` | identity |
| 10 | Field metadata **`permission` + `mask`** on sensitive type fields (§9) | types in orders, customers, media, trust, sellers |
| 11 | Public APIs returning person-facing data take **`viewer: Principal`** (sellers 360, customers 360) | sellers, customers |
| 12 | Identity: visitor sessions replace guest sessions (§0, §8); `accounts.tokens_valid_after`; refresh grace window; no lock on refresh reuse; staff idle timeout setting; tokens out of URL paths (`/password-resets/{token}`, `/invitations/{token}…`, `/order-links/{token}/redeem`) | identity |
| 13 | Access: assigning a role that carries a limit needs Business Owner approval; disabling an account suspends assignments | access |
| 14 | Event `identity.session.revoked` (informational) | identity |
| 15 | Endpoint field `rateLimit` (class) | FORMAT.md, identity |
| 16 | **Auth kinds** in common.json: remove `anyone`; add **`visitor`** (any token of the app), **`refresh`** (refresh token only), **`bootstrap`** (app proof only, one endpoint). build.mjs rejects any endpoint with no auth kind or with `anyone` | common.json `auth`, FORMAT.md, build.mjs |
| 17 | Move the 66 `anyone` endpoints to `visitor` (47 store, 19 public); refresh and sign-out to `refresh` | catalog, content, customers, offers, promotions, returns, reviews, search, sellers, shipping, support, wishlist, finance, identity, settings, trust |
| 18 | Identity: new `POST /api/public/identity/app-sessions` (bootstrap: app proof → visitor token + refresh token) replaces `POST /guest-sessions`; sign-in and registration claim the visitor session; token claim `kind` | identity |
| 19 | Headers: remove `X-Guest-Session`; add the app-proof header for bootstrap (`X-App-Proof`) | common.json `headers` |
| 20 | *(decision 9)* Auth kind `service` for our own server-side clients (website rendering), with client credentials held only on the server | common.json, identity |
| 21 | Re-auth purpose: `purpose` in `ReauthRequest` and on `reauth_tokens`, checked by `verifyReauthToken`; staff re-auth `POST /api/admin/identity/reauth`; seller re-auth works before a seller is chosen; identity publicApi drops `authenticate` and `verifyGuestSession` (the kernel verifies tokens) | identity |

## 16. Changes from v1 and v2

**v2 → v3 (every endpoint requires a token):**

| Area | v2 | v3 |
|---|---|---|
| Endpoints without a token | 78 (47 store browsing, 22 public, 9 webhooks) | 1: the bootstrap endpoint, protected by app proof and rate limits |
| Anonymous visitors | no token; optional token ignored when bad | visitor token from the bootstrap endpoint, verified like any access token |
| Guests | separate `X-Guest-Session` token | the store visitor session is the guest session; one `Authorization` header for everyone |
| Refresh and sign-out | open, refresh token in the body | `refresh` auth kind: middleware verifies the refresh token |
| Webhooks | signature checked in middleware | unchanged: the provider signature is the provider's token |
| Unknown URLs | 404 for anyone | 401 without a valid token, 404 only with one |
| Token verification | route hook, optional on 69 endpoints | app-level middleware, mandatory, before any module code |
| `/health`, `/docs` | public | internal port; `/docs` off in production, staff token elsewhere |

**v1 → v2:**

| Area | v1 | v2 |
|---|---|---|
| Record scope | helper for services | enforced: spec `scope`, scoped data access, generated cross-tenant tests, GraphQL `@scope` |
| Development tokens | on outside production, public default secret, `*` staff | off unless `NODE_ENV=development`; startup refuses a default secret on a non-loopback host or non-local database; warning logged; `*` only in tests |
| Revocation | in-memory list fed by events | PostgreSQL source of truth, polled; `tokens_valid_after`; admin liveness check; failed-sign-in locks don't revoke |
| Token format | "signed" | EdDSA JWT, alg allowlist, `kid`, `iss`, `aud`, `typ`, `iat`, `jti`, 60 s leeway, key rotation |
| Web tokens | undefined | HttpOnly refresh cookie, in-memory access token, Origin check, CORS allowlist, CSP |
| Guest | session id is the secret | separate 256-bit token, verified on attach, ends on claim |
| Step-up | account-bound token, consumed before idempotency | bound to session, seller and purpose; verified before, consumed after; shared failure counter; more endpoints |
| Field data | per handler | central masking from spec metadata; `viewer` on public APIs; GraphQL admin default-deny |
| Actors | anonymous = system | `anonymous`, `provider`, branded `system` |
| Secrets in URLs | not addressed | moved to bodies, redacted in logs |
| Role grants | access ≠ authority, stated | enforced: Business Owner approves roles with limits; Business Owner account protected; break-glass |
| Rate limits | one stage before auth | IP stage, principal stage, body stage; `TRUST_PROXY`; shared store |
| Webhooks | signature in onRequest | preValidation over raw bytes, per provider, event-id de-duplication |
| Seller context | blocked the context-picking endpoints | `sellerContext: optional`; memberId match |
| Errors | 401 for everything | 401 only for token problems; 403 for audience, step-up, owner-only |
| Facts | 6 errors | refund approval → Finance; `advertising.rules.change` → Business Owner; publication override is declared; Finance staff limits; seller closure needs re-auth; store `/reauth` is not exempt |

## 17. What is built

**Built** (`backend/src/kernel/auth`, `kernel/http`), checked by `npm run check`:
- `chain.ts`: app-level onRequest authenticates **every** URL (unknown URLs and GraphQL included: 401 before 404); per-endpoint hooks for phase gate, caller rate limit, audience, caller kind, seller context + member access, permission / OWNER_ONLY, staff 2-step, refresh token, webhook signature + replay record, rate-limit classes, `permissionWhen`, step-up;
- `tokens.ts`: EdDSA JWT verify/sign, `AUTH_JWKS`, per-machine dev key (`kid dev-…`, `dev` claims honoured only on dev keys);
- `revocation.ts`, `rate-limit.ts`, `app-proof.ts` (dev, Turnstile; Play Integrity pluggable), `scope.ts` (`input.scope`, `scoped()`), `masking.ts`, `authorities.ts` (answers from identity/access/sellers/customers public APIs, fail closed), `setup.ts`;
- `http/security.ts`: CORS per area, preflight before auth, no-store, WWW-Authenticate only for token problems; health check moved to an internal port (`HEALTH_PORT`);
- `file-links.ts` + `http/files.ts`: signed file links for `GET`/`HEAD /files/{bucket}/{key}` (auth kind `file-link`), registered by the module that serves files (`ctx.http.files`, media) and verified in M4 with that module's key (`secretFor(config, '<module>.files')`); tested in `http/http.test.ts` (tampered, foreign key, longer life, other content type, private permanent link → 401; expired → 403) and over HTTP in `modules/media/test/files.test.ts`;
- spec: the `auth`, `scope`, `stepUp`, `permissionWhen`, `sellerContext`, `rateLimit`, sensitive-field and tenant metadata, generated into `src/spec`.

**Over real HTTP** (`npm run test:http`, part of `npm run check`): every endpoint is called on a listening server with spec-generated input, about 6,300 requests: no token → 401, invalid token / refresh token / signature / app proof → 401, another app's token → 403, wrong caller → 401, missing permission → 403, missing step-up proof → 403, right token → reaches the handler; plus unknown URLs, CORS preflight, GraphQL per area, /docs and the internal health port.

**Tests built:** for every one of the 1,269 endpoints: no token → 401 (bootstrap → APP_PROOF_INVALID), another app's token → 403 WRONG_AUDIENCE, missing permission → 403 FORBIDDEN or OWNER_ONLY, right token → reaches the handler. Kernel tests: expired / foreign-key / tampered / malformed tokens, visitor vs customer, 2-step, `permissionWhen`, seller context, owner-only + re-auth, guest scope, app proof, refresh from cookie and body, webhooks without a verifier.

**Waits for the modules** (the middleware already calls these public APIs; until they exist it fails closed):
- identity: issue tokens and visitor tokens, `verifyRefreshToken`, `verifyReauthToken`/`consumeReauthToken`, `verifyStepUp`, `revocationsSince`;
- access: `hasPermission` with the seed role sets (§14); sellers: `getMemberAccess`; customers: `getCustomerByUserId`;
- each module: webhook verifiers, `scoped()` in repositories, and cross-tenant 404 tests once handlers exist;
- deployment: Play Integrity verifier, a shared rate-limit store for more than one server.

### Planned layout (v3 design, for reference)

```
backend/src/kernel/auth/
  authenticate.ts  app-level M4: mandatory token on every URL, verifier chosen by the route's auth kind
  tokens.ts        JWT verify (EdDSA, kid → AUTH_JWKS, iss/aud/typ/kind/leeway) for visitor and access tokens; dev tokens behind the new guard
  refresh.ts       refresh-token verification for the `refresh` kind
  bootstrap.ts     app proof (Play Integrity / bot challenge) for the bootstrap endpoint
  revocation.ts    poller over sessions.revoked_at and accounts.tokens_valid_after; boot load; admin liveness
  chain.ts         buildAuthChain(endpoint) → hooks; exported for GraphQL and other non-spec routes
  guards.ts        audience, caller kind, staff session (pure, shared with GraphQL @auth)
  seller.ts        seller context, memberId match, member-access cache
  permissions.ts   exact-key match, effective staff set with read-time cover, ownerOnly, permissionWhen
  reauth.ts        verify in preHandler, consume in the handler transaction
  rate-limit.ts    IP, principal and body stages; TRUST_PROXY; pluggable store
  scope.ts         Scope type, scoped(db, scope) wrapper for tenant tables
  masking.ts       field masking from spec metadata (REST serializer + GraphQL wrapper)
  authority.ts     access.check / requestApproval pattern (202 or APPROVAL_REQUIRED)
  actors.ts        anonymous / provider / branded system actors
backend/src/kernel/http/
  security.ts      CORS per area, CSP and Referrer-Policy headers, log redaction, /docs off in production
```

**Tests:**
- generated for **every** endpoint: **no token → 401**, a token of the wrong app → 403, an expired or tampered token → 401;
- unknown URL without a token → 401;
- bootstrap without a valid app proof → 401;
- generated per endpoint: auth kind, permission, owner-only, **cross-tenant 404**;
- kernel matrix of caller × area × auth kind;
- **two app instances on one database** for revocation (sign out on A, refused on B within 5 s);
- step-up binding (a store re-auth token is refused on a seller action);
- webhook replay;
- GraphQL admin fields without `@auth` fail the build.

## 18. Decisions

**Decisions taken** (recommended options): 1 all spec changes accepted; 2 seed sets kept as proposals until access is built; 3 "any active member" for seller reads; 4 rate limits as proposed; 5 fresh 2-step for sensitive staff actions; 6 deputy owner built as a standing second Business Owner at bootstrap, break-glass not built (§12); 7 HttpOnly refresh cookie on the website; 8 provider signature as the webhook token; 9 no service token (pure browser app); 10 Play Integrity + Turnstile; 11 unsubscribe through the link in the message.

The questions as asked:


1. **Spec changes (§15).** Accept them all, or name the ones to drop. Items 1–5 and 9 are small. Items 6, 10 and 11 (scope, field masking, viewer) touch every module spec.
2. **Seed role permissions (§14).** Confirm, or mark rows to change. Refund approval now sits with Finance, not Returns.
3. **Seller endpoints without a permission.** Keep "any active member" for reads, with the three flagged endpoints fixed (§13); or add `view` permissions per area.
4. **Rate limits (§11)** marked as proposals, and the staff concurrent-session cap of 3.
5. **Fresh 2-step for sensitive staff actions** (§10): role grants, staff account actions, finance destination changes, identity exports. Recommended: yes.
6. **Business Owner protection and break-glass (§12).** Approve the deputy-owner procedure, and say who the deputy is. *Since then:* the deputy is named at bootstrap (`npm run bootstrap-owner` with `--deputy-email`/`--deputy-name`) and holds the Business Owner role from day one; the sealed, time-boxed break-glass role and the second reviewer on Business Owner account actions are still open (§12).
7. **Web token storage (§5).** HttpOnly refresh cookie for the website (recommended) vs keeping tokens in browser storage.
8. **Webhooks (§0).** Payment, carrier and email providers can't obtain our tokens. Accept their signature, verified in middleware, as their token (recommended)? Where a provider supports it, we can also require a secret header on top.
9. **Search engines and server rendering (§0).** If the website is server-rendered so product pages appear in search results, the render server needs a `service` token (client credentials kept on the server). If the website stays a pure browser app, no service token is needed.
10. **Bootstrap protection (§0).** Play Integrity for Android plus a bot challenge (e.g. Cloudflare Turnstile) for the website (recommended), or rate limits only.
11. **One-click unsubscribe from mail apps.** Gmail and Apple Mail's "Unsubscribe" button (RFC 8058) posts directly from the mail provider, which can't carry our token. Either rely on the unsubscribe link in the message (opens our page, which has a token), or allow that one call with only the signed unsubscribe token.
