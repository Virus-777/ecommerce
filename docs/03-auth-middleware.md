# Authentication and authorization middleware per role

Status: **v3, implemented in the kernel** (2026-10-09; updated 2026-10-11 to match the API contract fixes). The open decisions in §18 were taken with the recommended option; see "Decisions taken".

v3 adds your rule: **every API endpoint requires a token, and tokens are verified in middleware** (§0). v2 still let 78 endpoints run without a token.

v1 was reviewed twice: a fact-check against every spec, and a security review. v2 fixes:
- 6 factual errors: wrong approvers, a missed re-auth endpoint, an endpoint wrongly listed as exempt;
- 2 critical gaps: record scope had no enforcement; development tokens were on everywhere;
- 9 high-risk gaps: revocation across servers, token format, web token storage, guest sessions, step-up binding, field-level data, anonymous callers recorded as "system", secrets in URLs, role grants that carry authority.

§16 lists every change. §17 lists what is built and what still waits for the identity, access, sellers and customers modules.

## 0. Rule: every endpoint requires a token, verified in middleware

**Every request to `/api/*`, `/graphql/*`, `/webhooks/*` and `/files/*` must carry a token.** Token verification is middleware (M4, §3): it runs before validation and before any module code. Handlers and services never read headers or tokens; they receive a verified `principal`. A request with no token, or with a token that fails verification, is refused with 401, including requests to URLs that don't exist (401 before 404), so the API can't be explored without a token. The only exceptions are CORS preflights, a plain `OPTIONS`, and `/docs` when it is enabled ("Other entry points" below).

**Not endpoints: the Admin Center's web files.** When `ADMIN_APP_DIR` is set (the one-server deployment, `backend/deploy/linux/README.md`), the server also answers `GET`/`HEAD` outside `/api`, `/graphql`, `/files`, `/webhooks`, `/health` and `/docs` with the built Admin Center: its `index.html`, scripts, styles and images (`kernel/http/admin-app.ts`). These are the same static files any web server would hand out, hold no data, and carry no token; the app then starts a session and calls `/api` with tokens like any other client. Every path under `/api` and `/graphql`, including unknown ones, still requires a token. The plain-HTTP `HTTP_REDIRECT_PORT` (301 to the https address only) and the internal health port (`HEALTH_PORT`, loopback by default) are not part of the API either.

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

| Endpoints | Count | v2 | v3 auth kind | Token required |
|---|---|---|---|---|
| Store browsing (product, category, search, reviews, help, policies, storefronts, delivery estimates) | 47 | `anyone`, no token | **`visitor`** | store visitor token or customer token |
| Store cart, checkout, guest order pages | 103 | `shopper` (guest header or customer) | `shopper` | store visitor token or customer token |
| Store account pages | 97 | `customer` | `customer` | customer access token |
| Self-service security under `/api/store/identity` (security, password, email change, 2-step, devices, security activity) | 11 | `customer` | **`account`** | access token of any app (customer, seller or staff); every app's origin may call them (§5) |
| Seller Center | 260 | `seller` | `seller` | seller access token |
| Admin Center and Operations | 745 | `staff` | `staff` | staff access token |
| Public: sign-in (password, Google/Apple, 2-step), registration, codes, password policy and reset, invitations, order links, unsubscribe, app config, fee schedule, brand-owner reports | 19 | `anyone`, no token | **`visitor`** | visitor token of any app (store, seller or admin) |
| Public: start a guest session | 1 | `anyone` | **removed**, replaced by the bootstrap endpoint | – |
| Public: refresh tokens, sign out | 2 | `anyone`, refresh token in the body | **`refresh`** | refresh token (cookie on the website, body on Android), verified in middleware |
| Webhooks | 9 | `provider` | `provider` | provider signature, verified in middleware (M11) |
| File downloads `GET`/`HEAD /files/{bucket}/{key}` (not a spec endpoint) | 1 route | – | **`file-link`** | the link's own signature, verified in middleware (M4) |
| GraphQL store / seller / admin | 3 endpoints (not in the 1,294) | store open to anyone | same as the area | store: visitor or customer token; seller and admin: access token |
| **Bootstrap:** `POST /api/public/identity/app-sessions` | 1 (new) | – | **`bootstrap`** | none: this endpoint issues the first token (below) |

### The one endpoint that can't require a token

Something has to hand out the first token, so the **bootstrap endpoint** is the single entry point without one. Instead of a token, it requires proof that the request comes from a real Marketly app, and it can do nothing else:

The proof travels in `X-App-Proof`:

- **Android:** `play:<token>`, a Play Integrity verdict for the Marketly app, checked on the server. *Not wired yet:* until the deployment supplies a verifier, a `play:` proof answers 503 `SERVICE_UNAVAILABLE`.
- **Website:** `turnstile:<token>`, a Cloudflare Turnstile challenge solved in the browser and checked with `TURNSTILE_SECRET` (503 without the secret).
- **Development and tests:** the literal `dev` (only while development tokens are on, §16; refused at startup in production).
- Anything else, or a failed check: 401 `APP_PROOF_INVALID`.
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
| `/docs` (Swagger UI and OpenAPI) | only with `DOCS_ENABLED` (default: on in development, off elsewhere; production refuses to start with it). When on, `/docs` and `/docs/*` are served without a token, so a browser can open them; when off, `/docs` is an unknown URL (401 without a token) |
| CORS preflight | `OPTIONS` with `Access-Control-Request-Method` is answered before authentication: 204, with the CORS headers for an allowed origin (§5). An `OPTIONS` without that header skips authentication too and gets 404 (no route answers `OPTIONS`) |
| Email and SMS links (password reset, invitation, order link, unsubscribe) | the link opens an app page, which first gets a visitor token, then sends the link's one-time token in the request body |
| Search engines and link previews | they can't call the API without a token. If the website is server-rendered for search engines, the render server uses its own **service token** (decision 9) |
| Response caching | every request now carries a token, so public reads are cached inside the server (read models), not by a CDN keyed on the URL. Exception: `/files` responses, whose token is part of the URL; public renditions are `Cache-Control: public, max-age=3600` (File links above) |

## 1. What every request must answer

| # | Question | Answered by | Where | Failure |
|---|---|---|---|---|
| 1 | **Who** is calling? | A token on **every** request (§0): visitor or access token; refresh token on refresh and sign-out; provider signature on webhooks | middleware (M4) | 401 `UNAUTHORIZED`, `details.reason` `token_*`, with `WWW-Authenticate: Bearer error="invalid_token"` (plain `Bearer` when the token is missing); see "When clients refresh" (§5) |
| 2 | **Which app** is the session for? | Token audience (store / seller / admin) against the API area | middleware | 403 `WRONG_AUDIENCE` |
| 3 | **What** may they do? | Staff: effective permissions from roles. Sellers: member permissions; owner-only keys | middleware | 403 `FORBIDDEN` (`details.permission`), 403 `OWNER_ONLY` |
| 4 | **Is it really them, now?** | Re-auth token (the password again, or a member's 2-step code) bound to session, seller and purpose for sensitive actions | middleware | 403 `STEP_UP_REQUIRED` |
| 5 | **Which records?** | Scoped data access: every query on a tenant table carries the caller's scope | **enforced in the data layer** (not left to handlers) | 404 `NOT_FOUND` (never reveals that the record exists) |
| 6 | **How much** may they approve? | `access.check(principal, action, amount)` against approval limits | service, through a kernel helper | 202 / 409 `APPROVAL_REQUIRED` |

### Principles

1. **Check permissions, never role names.** Roles are data in `access`: seeded, editable, custom ones allowed, and one person can hold several. Middleware matches **exact permission keys**. Wildcards in seeds are expanded when seeding, so a key a module adds later is never granted silently.
2. **Access is not authority.** A permission opens an action; an approval limit decides the amount. Assigning a role that carries a limit therefore needs the Business Owner (§12).
3. **Deny by default, derived from the spec.** Each endpoint's chain is built at startup from its spec fields. An endpoint with an unknown auth kind, or an admin GraphQL root field without `@auth`, fails the build.
4. **Scope is a property of data access, not a habit.** Tenant tables (anything with `seller_id`, `customer_id` or guest grants) are read for the caller's scope only, and a generated cross-tenant test should run for every endpoint with parameters (§7 says how much of this is built).
5. **One source of truth for revocation.** Revoked sessions live in the database (identity's collections) and every server polls them. A server never relies on having received an event (§6).
6. **Fail closed.** No endpoint takes an optional token: a missing or unverifiable token is always 401. If identity, access or sellers can't answer, the request gets 503, not access.
7. **One chain for REST and GraphQL.** GraphQL endpoints run the same middleware and mask the same sensitive fields the same way (§9).
8. **Restrictions are not sign-in blocks.** A restricted seller keeps orders, returns and support (scenario 7); services call `sellers.canSell` for the blocked activities.

## 2. Callers and actors

| Caller | Realm | Session | Areas | Identified by | Session rules | Actor recorded |
|---|---|---|---|---|---|---|
| **Visitor** (store: also the guest) | – | visitor session | store (`visitor`, `shopper`); public (`visitor`) | **visitor token**, `kind: visitor`, audience of the app (§0) | access 15 min; refresh 30 days after last activity; order grants 90 days; ends when claimed by sign-in | `visitor` (session id, never the token) |
| **Not yet identified** | – | none | only the bootstrap endpoint | app proof (Play Integrity / bot challenge) | – | `anonymous` (with IP) |
| **Customer** | member | store | store, plus `account` endpoints | access token, audience store | access 15 min; refresh 24 h, or 30 days with "keep me signed in"; 2-step optional | `customer` |
| **Seller owner** | member | seller | seller, plus `account` endpoints | access token, audience seller, with seller context | as customer; one seller at a time | `seller` (member id, seller id) |
| **Seller member** | member | seller | seller, plus `account` endpoints | as owner; role template | as owner; seller staff are phase 2 (at launch each seller has only its owner) | `seller` |
| **Staff** | staff | admin | admin, Operations, plus `account` endpoints | access token, audience admin | email and password (no 2-step, see "Staff sign-in without authenticator" below); **idle timeout 30 min**; absolute 12 h; new-device alert | `staff` (with roles) |
| **Provider** | – | – | webhooks | provider signature over the raw body | per-provider secrets, two active during rotation | `provider` (provider name) |
| **System** | – | – | none: jobs and event consumers only | branded actor, built only by the scheduler and the event bus | – | `system` |

v1 recorded anonymous callers and webhooks as `system`. v2 gives them their own actor kinds, so a rule like "system actions skip approval" can never apply to internet traffic.

**Staff sign-in without authenticator (2026-10-14).** The server runs offline and only staff use it, so the owner decided staff use no authenticator app. A staff invitation comes with a **pass code** (8 characters without look-alikes, shown as `XXXX-XXXX`) that the server operator prints with `npm run bootstrap-owner` or `npm run staff-link` and hands over with the link; only a keyed hash is stored, and it is never in `identity.invitation.created`, an email, an HTTP response or a log. `POST /api/public/identity/invitations/accept` takes the link token, the pass code and a new password and signs the person in at once; the 5th wrong pass code revokes the link (staff-link gives a new one). Staff then sign in with email and password only, cannot add a 2-step method (`TWO_STEP_NOT_FOR_STAFF`), and confirm sensitive actions by typing the password again (`POST /api/admin/identity/reauth` → `reauthToken`, §10). A database from before has its staff 2-step methods removed by identity's migration `2026-10-14-staff-without-two-step`. Customers and sellers keep their optional 2-step exactly as before.

**Roles.**
- **Sellers:** `owner`, `products_inventory`, `shipping`, `customer_service`, `custom` (stored in `sellers`).
- **Staff:** `business_owner`, `platform_administrator`, 16 management roles, the task roles `warehouse_worker`, `finance_staff` and `support_agent`, and custom roles (stored in `access`).

## 3. The middleware chain

```
request
  │ app-level onRequest (runs for every URL, including unknown routes)
  ├─ M1  requestContext      request id: the client's X-Request-Id when it matches [\w-]{1,100}, else a new one; echoed on every response
  ├─     cors                CORS headers per area (§5); a preflight is answered here (204), before authentication
  ├─ M2  ipRateLimit         per-IP bucket (signed file links: their own bucket); client IP from TRUST_PROXY hops/CIDRs
  ├─ M4  authenticate        REQUIRED on every URL: verify the token the endpoint's kind needs (§0): JWT (alg allowlist, kid, iss,
  │                          aud, typ, exp/iat ± 60 s) + revocation (§6); for admin tokens also fresh revocations (production) and
  │                          M10's session check; file-link signature (/files); app proof (bootstrap);
  │                          refresh and webhooks are deferred to preValidation (they need the body);
  │                          unknown URL without a valid token → 401 before 404
  ├─ M1  clientVersion       X-Client android/<versionCode> below the minimum → 426 (after authentication)
  │ route onRequest
  ├─ M3  phaseGate           endpoint launch phase > LAUNCH_PHASE → 501
  ├─ M5  principalRateLimit  per visitor session + IP / account / (account, seller) bucket; GraphQL counts as reads
  ├─ M6  audience            token audience ↔ API area; auth kind `account` takes any realm
  ├─ M7  callerKind          visitor | shopper | customer | account | seller | staff | refresh | provider | bootstrap
  ├─ M8  sellerContext       seller in token (unless sellerContext: optional); member active; token memberId = current member
  ├─ M9  permission          exact keys; staff effective set; seller member keys; ownerOnly → OWNER_ONLY
  │                          (M10, staff session liveness and idle timeout, runs in M4)
  │ preValidation (raw body available)
  ├─ M4  refresh             refresh token, cookie first then body; the cookie also needs an allowed Origin and X-Requested-With;
  │                          then 30 refreshes an hour per session
  ├─ M11 webhookSignature    provider verifier over raw bytes; timestamp window; returns {provider, eventId}; then 1,000/min per provider
  ├─ M12 classRateLimit      named classes keyed by IP, body fields or account (sign-in, registration, password-reset, code, bootstrap, export)
  ├─ M14 stepUp (present)    the proof is there (reauthToken in the body); else 403 STEP_UP_REQUIRED, never 400
  │ validation (Zod, from the spec)
  │ preHandler
  ├─ M9  permissionWhen      conditional permissions (§13)
  ├─ M13 idempotency         replay first
  ├─ M14 stepUp (verify)     VERIFY the re-auth token (bound to account, session, audience, seller, purpose) and claim it;
  │                          refused → the Idempotency-Key is freed for the retry
  ▼ handler
      record scope (§7) · authority (access.check)
      response → central field masking (§9) → serializer
  │ onResponse: failed → put the claimed re-auth token back · success → record the webhook event id
```

Every hook below is built (`kernel/auth/chain.ts`, `kernel/http/security.ts`, `kernel/http/server.ts`, `kernel/http/register.ts`).

| Middleware | Hook | Does | Failure |
|---|---|---|---|
| M1 requestContext | app onRequest | **Request id:** a client `X-Request-Id` matching `[\w-]{1,100}` becomes the request id (logs, audit `requestId`, the response header); otherwise the server makes one. It is for correlation only, never trusted. **Version gate**, after M4: `X-Client` is `web`, `android/<versionCode>` or `android/<versionName>+<versionCode>` (e.g. `android/1.4.2+142`). A version code below settings `apps.android.minVersionCode` (cached 60 s) is refused. Not gated: `web`, no header, `android/1.4.2` without a code, settings unavailable. Never used for trust | 426 `UPGRADE_REQUIRED` `details { minVersionCode, updateUrl }` |
| M2 ipRateLimit | app onRequest | Protects token verification and guest lookups, and also covers unknown routes (404 scanning). Shared store (§11) | 429 `RATE_LIMITED` + `Retry-After` |
| M4 authenticate | **app onRequest** (every URL); refresh in preValidation | **Mandatory.** Picks the verifier from the route's auth kind: JWT for visitor and access tokens (local verification, §5, plus revocation, §6); for admin tokens also the revocation freshness check (§6) and M10's session check; app proof for `bootstrap` (§0); the link's HMAC for `file-link` (§0 "File links": 401 bad, 403 expired). `refresh` and `provider` need the body, so their check runs in preValidation: the refresh token by hash lookup (cookie first, then body; cookie guard in §5), the signature in M11. Unmatched URLs need a valid visitor or access token, so 404 is only ever seen with a token | 401 + `WWW-Authenticate`; 403 for the cookie guard; 503 (§6) |
| M3 phaseGate | route onRequest | Runs after authentication, so the roadmap isn't visible without a token | 501 `NOT_IMPLEMENTED` (`details.reason` `later_phase`) |
| M5 principalRateLimit | route onRequest | Buckets per §11. GraphQL requests count as reads | 429 |
| M6 audience | route onRequest | 403, not 401, so clients don't loop on refresh. Auth kind `account` (self-service security endpoints) takes a signed-in token of any app; a visitor token gets 401 `sign_in_required` | 403 `WRONG_AUDIENCE` |
| M7 callerKind | route onRequest | `visitor` (any token of the app, signed in or not), `shopper`, `customer`, `account`, `seller`, `staff`, `refresh`, `provider`, `bootstrap`. `anyone` no longer exists | 401 `sign_in_required` |
| M8 sellerContext | route onRequest | Requires `sellerId` in the token unless the endpoint has `sellerContext: optional` (the two endpoints used to pick a seller). Member must be active, and the token's `memberId` must match the current member, so a removed and re-invited member's old tokens fail | 401 `seller_context_required`, 403 `NO_SELLER_ACCESS` |
| M9 permission | route onRequest; `permissionWhen` in preHandler | Exact-key match. Staff: effective set (§6). Seller: member keys; `ownerOnly` keys need `isOwner` even if listed. Conditional permissions (`permissionWhen`, §13) | 403 `FORBIDDEN` (`details.permission`) / `OWNER_ONLY` |
| M10 staffSession | app onRequest (in M4) | No 2-step stamp is required (staff sign in with email and password, 2026-10-14). **Every staff-token request** (REST, `/graphql/admin`, unknown URLs): M4 calls `identity.touchStaffSession(sid)`, cached 5 s per session per server. Identity refuses revoked, expired and idle sessions; idle is measured from `sessions.last_active_at`, which this call writes at most once a minute (refresh writes it too). Not checked: Admin Center visitor tokens, dev-key tokens with dev claims | 401 `token_revoked`; 401 `session_idle` with plain `WWW-Authenticate: Bearer` (sign in again: a refresh would fail); 503 `SERVICE_UNAVAILABLE` `sessions_unavailable` when identity doesn't answer |
| M11 webhookSignature | preValidation | Runs over the raw body. Verifiers are registered **per provider** and return `{provider, eventId, timestamp}`; the kernel enforces a window of at most 5 minutes, then the per-provider limit (§11). A replayed event id is acknowledged without running the handler | 401 (`signature_invalid`, `signature_expired`); 429 |
| M12 classRateLimit | preValidation | Named classes (spec `rateLimit`, or `export` for any POST whose path ends in `/exports`), counted in `kernel.rate_limits` (§11). An unknown class fails startup | 429 |
| M13 idempotency | preHandler | Runs **before** M14's verification, so a retried request replays instead of burning a re-auth token | 422 / 409 |
| M14 stepUp | preValidation (present) and preHandler (verify) | **preValidation, before the schema:** a missing proof (`reauthToken` in the body; `reauth` is the only step-up kind) is refused, never answered as a validation error. **preHandler, after the idempotency replay:** the proof is verified, and the re-auth token is claimed for this request (`identity.consumeReauthToken` marks it used only if it is still unused), so a parallel request with the same token is refused. If the request then fails (status 400 or above), onResponse puts the token back (`releaseReauthToken`) and the person can retry without confirming again. A refused proof also frees the request's Idempotency-Key, so the retry with a fresh proof can reuse the key | 403 `STEP_UP_REQUIRED` `details { kind, purpose }` |

Two things stay out of middleware on purpose:
- **The password confirmation for large approvals** depends on the amount, so `access.decide` checks it: the approval endpoints take an optional `reauthToken` (purpose `approval`) in the body, and access verifies and claims it only when the amount is above `stepUpAbove` (§10).
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
| Staff | token | admin | `staff`, `account` | – | effective set; conditional permissions | M10 always; M14 (re-auth token from the password) for role grants, staff account actions and payout-destination reviews (decision 5) | `{ staff }`: all records; sensitive fields masked by permission (§9) |
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
| Website (store, Seller Center, Admin Center) | One cookie per app, `__Secure-mk_refresh_store`, `__Secure-mk_refresh_seller` and `__Secure-mk_refresh_admin`, so signing into one app doesn't replace another's session in the same browser: `HttpOnly; Secure; SameSite=Strict; Path=/api/public/identity/sessions` (sent only to refresh and sign-out; a `__Host-` cookie would have to use `Path=/`). The body's `refreshToken` is then `""`. The access token stays in memory only | **Refresh guard:** refresh and sign-out with the cookie need an allowed `Origin` (any app's `CORS_*_ORIGINS`, or the API's own `API_URL`) and the `X-Requested-With` header (any value), which a cross-site form or link can't send; otherwise 403 `FORBIDDEN`, `details.reason` `origin_not_allowed` / `x_requested_with_required`. Credentialed CORS only on the cookie routes (below); Content-Security-Policy on Admin Center and Seller Center |
| Android app | Response body; stored with Android Keystore / EncryptedSharedPreferences. Refresh and sign-out send `refreshToken` in the body, and need neither `Origin` nor `X-Requested-With` | Verified App Links for order and reset links |

**Which token is read.** The browser sends every app's cookie to refresh and sign-out, so the website names its app in the body: `{ "audience": "store" }` (`seller`, `admin`). The middleware reads that app's cookie first, then the body's `refreshToken`; without `audience` it reads no cookie. A missing token is 401 `token_missing`; an unknown, expired, revoked or reused one is 401 `token_invalid`, as is an app's cookie holding another app's session; so signing out with an unknown token (or twice) is also a 401. Responses that issue tokens set the cookie of the session's app for web devices (`device.kind: web`); a refresh sets it when the token came in the cookie, and sign-out then clears only that app's cookie.

**CORS and credentials.** Each area takes its own app's origins (`CORS_STORE_ORIGINS`, `CORS_SELLER_ORIGINS`, `CORS_ADMIN_ORIGINS`); public endpoints, signed file links and the `account` endpoints under `/api/store/identity` take every app's origins, so Seller Center and Admin Center can call them. `Access-Control-Allow-Credentials: true` is sent, for allowed origins only, on every route that sets, clears or reads the refresh cookie:
- refresh and sign-out (auth kind `refresh`);
- `POST /api/public/identity/app-sessions`, `/sessions`, `/sign-in-challenges/{id}/verify`, `/external-sign-ins`, `/verifications/{id}/confirm`, `/invitations/accept`;
- `POST /api/seller/identity/session/seller-context`.

Browsers call these with `credentials: 'include'`. A module declares its cookie routes with `ctx.http.sessionCookie(...operationIds)`; the kernel matches them by path, so a preflight gets the same answer as the request. Because the cookie is `SameSite=Strict`, the apps and the API must share a site (e.g. `marketly.example` and `api.marketly.example`). Every CORS-allowed response exposes `WWW-Authenticate, X-Request-Id, Idempotent-Replayed, Retry-After`, and preflights allow the request headers `authorization, content-type, idempotency-key, x-app-proof, x-client, x-request-id, x-requested-with`.

- **Rotation:** a reused previous token within **20 s** (`identity.refreshReuseGraceSeconds`) returns the same new pair. This handles two tabs, or parallel app requests, refreshing at once. Reuse outside the window revokes the session and writes a security event, but **does not lock the account** (a visitor session simply ends). Clients refresh one request at a time.
- **When clients refresh.** Only on 401 `UNAUTHORIZED` whose `details.reason` starts with `token_` (`WWW-Authenticate: Bearer error="invalid_token"`, or plain `Bearer` for a missing token). Never on `session_idle` (sign in again), `sign_in_required`, `seller_context_required`, `FORBIDDEN`, `WRONG_AUDIENCE`, or a GraphQL field refusal (`FORBIDDEN` inside a 200 response). A 401 from refresh itself means sign in again (visitors: start a new app session).
- **Staff sessions:** idle timeout 30 minutes, absolute limit 12 hours, an alert on sign-in from a new device, and at most 3 concurrent staff sessions (proposal).
- **Impersonation ("act as customer") is not supported.** No endpoint mints a token for another account. Support uses the read-only customer view.
## 6. Revocation and caches

| What | Source of truth | How servers learn it | Rule |
|---|---|---|---|
| Revoked session | `identity.sessions.revoked_at` | Every server polls `revoked since <cursor>` every 2–5 s and loads the last 15 minutes on startup | token `sid` in the revoked set → 401 `token_revoked` |
| Account-wide revocation (disable, close, forced reset, staff "sign out everywhere") | **`accounts.tokens_valid_after`** (new column) | same poll | token `iat` < `tokens_valid_after` → 401. A token issued after unlocking keeps working |
| Admin sessions | `sessions` row (`revoked_at`, expiry, `last_active_at`) | M4 calls `identity.touchStaffSession` on every staff-token request (5 s cache per session per server; M10 in §3) | revoked, expired or unknown → 401 `token_revoked`; idle → 401 `session_idle`; identity not answering → 503 `sessions_unavailable`. Refresh and `identity.expire-sessions` measure idle from `last_active_at` too |
| Failed-sign-in lock | `accounts.locked_until` | – | **blocks new sign-ins only**; existing sessions continue. Otherwise anyone who knows an email could sign that person out |
| Staff permissions | `access.permissionsOf(accountId)` | cached 60 s; flushed on `access.role.changed`, `access.coverage.changed`, `access.away.started` and `access.away.ended` | Own active role assignments. **Cover alone grants nothing**: it re-routes work and notices, and the backup acts with their own roles and limits. Only an away period whose **delegation the Business Owner approved** (`delegateApprovals`, approval action `access.delegations.approve`) lends the covering person the covered roles' permissions and the away person's approval limits (never above them; decisions record `viaDelegationFrom`); a delegation still waiting for approval lends nothing, and rejecting it rejects the whole period. Away periods are read **at request time** (`now ∈ [from, to)`, status scheduled or active) and only while the away person still holds the handed-over role. Events are only a cache hint, so cover and delegation end on time even if the job scheduler is off |
| Seller member access | `sellers.getMemberAccess` | cached 60 s; flushed on `sellers.member.*`, `sellers.seller.closed` | `memberId` must match the token |

**Stale list, fail closed.** In production an admin request (any `aud: admin` token) gets 503 `SERVICE_UNAVAILABLE` whenever no revocation sync has succeeded within 30 s: `details.reason` `revocations_stale` (the last sync answered, but too long ago) or `revocations_unavailable` (identity did not answer or the sync failed). Outside production nothing is gated. Store and seller requests use the last list they have.

`identity.session.revoked` is still proposed as an event for notifications and audit. Correctness doesn't depend on it.

## 7. Record scope, enforced (Q5)

v1 left scope to a helper that each handler would have to remember to call. Across about 1,000 handlers that is a data breach waiting to happen. v2 designs it in four places; what is built is marked:

1. **Spec field `scope`** on every endpoint that returns tenant data: `own-seller | own-customer | own-member | guest-order | staff | public`. Generated defaults: seller area → `own-seller`; store area with `customer` auth → `own-customer`; `shopper` → `own-customer` or `guest-order`. *Built:* every handler receives `input.scope` (seller and member from the token, never the path; the customer id of the account; the visitor session).
2. **Scoped data access.** Tenant tables are read for that scope (`seller_id = ?` / `customer_id = ?` / the visitor session), on tables declared tenant-owned in the spec (`tenant` table flag). *Built in part:* module services and repositories filter by `input.scope` and answer 404 for another tenant's record. The tenant tables are generated into `spec.tenantTables`, but no kernel helper applies them yet, and no build check rejects an unscoped read of a tenant table (`check:boundaries` checks module imports only).
3. **Generated cross-tenant tests.** For every endpoint with path parameters: create the record as tenant A, call as tenant B, expect 404. *Not built* (§17); module tests cover some cross-tenant cases by hand.
4. **GraphQL:** there is no `@scope` directive. Record scope comes from the area (the seller schema's resolvers read the caller's own seller account, the store's the caller's own customer or guest session) and from the scoped loaders the resolvers share with REST.

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

- **Sensitive fields are marked in spec types**, for example `{ type: 'email', permission: 'orders.customers.view-contact', mask: 'email' }`. Handlers never decide; one central step masks them (`email` → `a***@example.com`, `phone` → `***12`, `name` → `A.`, `hide` → null) in the seller and admin areas unless the caller holds the permission. The store shows the shopper's own data.
  - **REST:** after the handler, from the field paths generated from the spec (`kernel/auth/masking.ts`).
  - **GraphQL:** fields carry `@sensitive(permission, mask)`, mirroring the spec's sensitive fields, and the field wrapper applies the same masks. `node docs/api/tools/graphql.mjs` fails the build when a `@sensitive` field doesn't match the spec (name, permission, mask) or a sensitive spec field is unmarked.
- **Public-API functions that return data shown to a person take `viewer: Principal`.** Aggregators (the seller 360, the customer 360) mark sections the viewer may not see as `unavailable: 'not_permitted'`. Example: `sellers.getSellerAdmin` must not show finance balances to a Seller Manager without finance permissions.
- **GraphQL:**
  - the admin, seller and store endpoints run M1–M10; GraphQL requests count as reads in the caller limits (§11);
  - every admin-only root field needs `@auth`, or the server refuses to start;
  - a field the caller may not read answers `FORBIDDEN` inside a 200 partial response, never `UNAUTHORIZED`, so clients don't refresh (§5);
  - introspection is off in production;
  - limits are built: depth 9 and `@cost` 1,500 (`QUERY_TOO_COMPLEX` before anything runs), page size clamped to 1–100, 10 s per request (`QUERY_TIMEOUT`); see [api/graphql/README.md](api/graphql/README.md#limits);
  - every API response, GraphQL `GET` included, is `Cache-Control: private, no-store` (every request now carries a token), so a CDN never serves one customer's page to another; public reads are cached inside the server.

## 10. Step-up and re-authentication

| Proof | Used for | Binding | Lifetime |
|---|---|---|---|
| Re-auth token, `reauthToken` in the body (spec `stepUp: { kind: 'reauth' }`, the only kind) | customer account closure, email change, 2-step removal, recovery-code regeneration; seller payout account change, business change, seller closure; *(decision 5)* sensitive staff actions: role grants (`role-grant`: set role permissions, invite staff, assign a role), staff account actions (`staff-account`: disable, enable, resend or revoke an invitation), payout destination reviews (`payout-destination`: approve, reject) | account + session + audience + seller + **purpose** (one per action: the request names the purpose and `verifyReauthToken` refuses a token issued for another) | single use, 5 minutes (`reauthTokenMinutes`); claimed before the handler runs and given back if the request fails |
| Approval re-auth token, **optional `reauthToken` in the body** (purpose `approval`) | money approvals above `stepUpAbove` ($10,000): `POST /api/admin/access/approval-requests/{id}/approve`, `POST /api/admin/finance/payout-runs/{id}/approve` and `POST /api/admin/returns/refunds/{id}/approve`, all through `access.decide` (returns claims it itself when it approves directly) | as above; missing or wrong → 403 `STEP_UP_REQUIRED` `{ kind: 'reauth', purpose: 'approval' }` from access | single use; given back when the decision is not recorded |

Members make a re-auth token with their password or a current 2-step code; **staff only with their password** (they have no 2-step since 2026-10-14, §2). The `X-Step-Up-Code` header and step-up kind `code` are gone.

- **Missing proof.** A spec step-up endpoint without its proof (`reauthToken` in the body) is refused before validation with 403 `STEP_UP_REQUIRED` `{ kind, purpose }`, never 400 (§3, M14). The approval token above is checked by `access`, not the middleware.

- **Shared failure counter.** Re-auth and every inline current-password check count against one identity counter that shares lockout with sign-in: 5 wrong answers lock step-up for 15 minutes and write a security event. Otherwise a stolen session becomes a password or 2-step guessing oracle.
- **Seller and staff re-auth.** `POST /api/seller/identity/reauth` issues tokens bound to the seller (it also works before a seller is chosen); `POST /api/admin/identity/reauth` issues them to staff (password only). The store `/reauth` is **not** an `account` endpoint, so a seller session can't use a store re-auth token on seller actions.

## 11. Rate limits

| Stage | Class | Key | Default |
|---|---|---|---|
| M2 (before auth, all URLs) | IP | client IP (`TRUST_PROXY`) | 600/min |
| M2 | Signed file links (`/files/…`) | client IP | 3,000/min, instead of the 600 |
| M5 (after auth) | Visitor | visitor session + client IP | 300/min, writes 30/min |
| M5 | Customer | account | 120/min, writes 30/min |
| M5 | Seller member | account + seller | 300/min |
| M5 | Staff | account | 600/min |
| M12 (preValidation) | `export`: creating an export (spec `rateLimit: "export"`, or any POST whose path ends in `/exports`) | account | 10/hour |
| M12 | `sign-in` (password, 2-step code, Google/Apple) | IP / email | 10/min per IP, 5 per 15 min per email |
| M12 | `registration`, `password-reset` | IP / email | 20/hour per IP, 5/hour per email |
| M12 | `code` (confirm, resend, text a code) | IP | 30/min |
| M12 | `bootstrap`: visitor token issue (`app-sessions`) | IP + installation id | 300/hour per IP, 30/hour per installation, after a valid app proof |
| preValidation | Refresh and sign-out | session | 30/hour per session, after the refresh token is verified |
| M11 | Webhooks | provider | 1,000/min per provider, after the signature is verified; the 600/min per-IP limit applies first |

Decision 4 took these as proposed. Every stage counts in the MongoDB collection `kernel.rate_limits`, so every server instance counts in the same fixed windows (no Redis; see [02-backend-architecture.md](02-backend-architecture.md#several-server-instances-jobs-and-rate-limits)); `RATE_LIMIT_STORE=memory` counts per process (the default without `MONGODB_URI`). Modules count their own business limits there too, with `ctx.rateLimit`. A spec `rateLimit` class the kernel doesn't know fails startup.

- **Writes** are requests other than `GET` and `HEAD`; GraphQL requests count as reads (the read layer has no mutations).
- **Retry-After.** Every 429 `RATE_LIMITED` carries `details.retryAfterSeconds` and a `Retry-After` header in seconds. Module 429s get the header too, from `details.retryAfterSeconds` or `details.lockedUntil`; a module 429 with neither has no header.
- **Failed-sign-in lock** is separate: identity counts failed sign-ins per email in `identity.sign_in_attempts` and answers 423 `ACCOUNT_LOCKED` (`details.lockedUntil`) when the account is locked.

**Enumeration.** Unknown emails get the same lockout and limit responses as real ones (identity simulates them), so `ACCOUNT_LOCKED` and the per-email 429 reveal nothing.

## 12. Governance of roles and accounts

Proposals, with what is built (status after gap pass 4):

- **Assigning a role that carries a non-zero approval limit needs Business Owner approval.** Otherwise new limits start at zero until the Business Owner reviews them. *Built in part:* limits live on roles and change only through `access.limits.change` (Business Owner); grants of roles with sensitive permissions (`sensitivePermissionPrefixes`: `access.`, `identity.staff-accounts.`, `finance.`, `audit.entries.export`, `settings.changes.`) need a second reviewer (`access.roles.sensitive-grant`, Platform Administrator or Business Owner, never the requester), and the Business Owner role or any role for yourself needs the Business Owner; an invitation can ask the Business Owner to review the new member's limits (`requestLimitReview`), and until then the member approves nothing. *Open:* a role whose limits are non-zero but whose permissions are not sensitive (e.g. Returns Manager, Customer Support Manager) is granted without a second reviewer.
- **Accounts holding the Business Owner role** (or limits above a threshold) can't be locked, disabled or force-reset without a second reviewer that includes the Business Owner or the designated deputy. *Open:* staff account actions need `identity.staff-accounts.manage` and the password again (re-auth token, `staff-account`), but no second reviewer. The last active Business Owner assignment can't be revoked (`LAST_BUSINESS_OWNER`).
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
| 3 | `reauthToken` (purpose `approval`; until 2026-10-14 a 2-step `stepUpCode`) and `STEP_UP_REQUIRED` on `finance.approvePayoutRun` and `returns.approveRefund` (they call `access.decide`) | finance, returns |
| 4 | Re-auth token binding: `verifyReauthToken(principal, token, purpose)` | identity publicApi |
| 5 | Common errors: `WRONG_AUDIENCE` 403, `STEP_UP_REQUIRED` **403** (was 401 in access and sellers), `OWNER_ONLY` 403, `NO_SELLER_ACCESS` 403, `UPGRADE_REQUIRED` 426, `SERVICE_UNAVAILABLE` 503 | common.json `errors` |
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
| `/health`, `/docs` | public | internal port; `/docs` only with `DOCS_ENABLED` (default: development; refused in production), then served without a token |

**v1 → v2:**

| Area | v1 | v2 |
|---|---|---|
| Record scope | helper for services | spec `scope` → `input.scope`, scoped data access, generated cross-tenant tests (§7 says what is built); GraphQL by area and shared scoped loaders (no `@scope`) |
| Development tokens | on outside production, public default secret, `*` staff | on only on this machine: loopback `HOST`, local database (below); warning logged |
| Revocation | in-memory list fed by events | database source of truth, polled; `tokens_valid_after`; admin liveness check; failed-sign-in locks don't revoke |
| Token format | "signed" | EdDSA JWT, alg allowlist, `kid`, `iss`, `aud`, `typ`, `iat`, `jti`, 60 s leeway, key rotation |
| Web tokens | undefined | HttpOnly refresh cookie per app, in-memory access token, Origin check, CORS allowlist, CSP |
| Guest | session id is the secret | separate 256-bit token, verified on attach, ends on claim |
| Step-up | account-bound token, consumed before idempotency | bound to session, seller and purpose; verified and claimed after the idempotency replay, given back if the request fails; shared failure counter; more endpoints |
| Field data | per handler | central masking from spec metadata; `viewer` on public APIs; GraphQL admin default-deny |
| Actors | anonymous = system | `anonymous`, `provider`, branded `system` |
| Secrets in URLs | not addressed | moved to bodies, redacted in logs |
| Role grants | access ≠ authority, stated | enforced: Business Owner approves roles with limits; Business Owner account protected; break-glass |
| Rate limits | one stage before auth | IP stage, principal stage, body stage; `TRUST_PROXY`; shared store |
| Webhooks | signature in onRequest | preValidation over raw bytes, per provider, event-id de-duplication |
| Seller context | blocked the context-picking endpoints | `sellerContext: optional`; memberId match |
| Errors | 401 for everything | 401 only for token problems; 403 for audience, step-up, owner-only |
| Facts | 6 errors | refund approval → Finance; `advertising.rules.change` → Business Owner; publication override is declared; Finance staff limits; seller closure needs re-auth; store `/reauth` is not exempt |

**Development tokens, as built** (`kernel/config/index.ts`). `DEV_TOKENS` is on by default in development and tests and can't be turned on in production. It enables the per-machine dev signing key, dev claims (permissions, owner flag), the `dev` app proof, the `dev-reauth.<purpose>` re-auth token (for dev-key tokens only), and default secrets. `HOST` defaults to `127.0.0.1` outside production and `0.0.0.0` in production. With `DEV_TOKENS` on, startup refuses a non-loopback `HOST` and a non-local `MONGODB_URI` (local = the embedded replica set, `localhost`, `127.0.0.0/8`, `::1`, or a socket). Without `DEV_TOKENS`, a non-loopback `HOST` needs a real `APP_SECRET`. To serve beyond this machine: `DEV_TOKENS=false` with `AUTH_SIGNING_JWK`, `AUTH_JWKS` and `APP_SECRET`.

## 17. What is built

**Built** (`backend/src/kernel/auth`, `kernel/http`), checked by `npm run check`:
- `chain.ts`: app-level onRequest authenticates **every** URL (unknown URLs and GraphQL included: 401 before 404), with the staff session check (`identity.touchStaffSession`) and the `X-Client` version gate (426); per-endpoint hooks for phase gate, caller rate limit, audience, caller kind, seller context + member access, permission / OWNER_ONLY, refresh token + cookie guard + per-session limit, webhook signature + per-provider limit + replay record, rate-limit classes, step-up proof present (preValidation), `permissionWhen`, step-up proof verified (preHandler);
- `tokens.ts`: EdDSA JWT verify/sign, `AUTH_JWKS`, per-machine dev key (`kid dev-…`, `dev` claims honoured only on dev keys);
- `revocation.ts` (fails closed for admin requests in production, §6), `rate-limit.ts` (§11), `app-proof.ts` (`dev`, `turnstile:`; `play:` answers 503 until a Play Integrity verifier is wired), `scope.ts` (`input.scope`), `masking.ts`, `authorities.ts` (answers from the identity, access, sellers, customers and settings public APIs, fail closed), `setup.ts`;
- `http/security.ts`: CORS per area, credentials on the cookie routes, every app's origins on `account` endpoints, exposed headers (§5); preflight before auth; no-store; `WWW-Authenticate` only on 401 `UNAUTHORIZED` (`error="invalid_token"` for a bad token, plain `Bearer` otherwise); health check moved to an internal port (`HEALTH_PORT`);
- `http/server.ts`: `X-Request-Id` (§3, M1), `Retry-After` on every 429 (§11), one error format; `config/index.ts`: the development-token guard (§16);
- `file-links.ts` + `http/files.ts`: signed file links for `GET`/`HEAD /files/{bucket}/{key}` (auth kind `file-link`), registered by the module that serves files (`ctx.http.files`, media) and verified in M4 with that module's key (`secretFor(config, '<module>.files')`); tested in `http/http.test.ts` (tampered, foreign key, longer life, other content type, private permanent link → 401; expired → 403) and over HTTP in `modules/media/test/files.test.ts`;
- spec: the `auth`, `scope`, `stepUp`, `permissionWhen`, `sellerContext`, `rateLimit`, sensitive-field and tenant metadata, generated into `src/spec`.

**Over real HTTP** (`npm run test:http`, part of `npm run check`): every endpoint is called on a listening server with spec-generated input: no token → 401, invalid token / refresh token / signature / app proof → 401, another app's token → 403, wrong caller → 401, missing permission → 403, missing or wrong step-up proof → 403 (never 400), right token → reaches the handler. Server checks: unknown URL → 401 (plain `WWW-Authenticate: Bearer`) and 404 with a token, no public `/health`, `/docs` off outside development, non-Bearer `Authorization` → 401, outdated Android `X-Client` → 426 and a current one → 200, CORS preflight without a token, unknown origins refused, exposed headers, credentialed CORS on the cookie routes (sign-in, app sessions, 2-step verify, refresh, seller context) and none elsewhere, `account` endpoints open to Seller Center while other store endpoints refuse it, cookie refresh without `Origin` or without `X-Requested-With` → 403, cookie refresh without `audience` → 401 and another app's session in an app's cookie → 401, GraphQL per area and caller, and the internal health port.

**Tests built:** for every one of the 1,294 endpoints: no token → 401 (bootstrap → APP_PROOF_INVALID), another app's token → 403 WRONG_AUDIENCE, missing permission → 403 FORBIDDEN or OWNER_ONLY, right token → reaches the handler. Kernel tests:
- `kernel/http/http.test.ts`: expired / foreign-key / tampered / malformed tokens, visitor vs customer, 426 after the token check, staff without 2-step, `permissionWhen`, seller context, owner-only + re-auth, a re-auth token used once even by parallel requests and given back when the request fails, a refused step-up freeing the Idempotency-Key, missing step-up → 403, guest scope, file links, app proof, refresh from cookie and body and the cookie guard, webhooks (replay, no verifier), CORS credentials and origins, exposed headers, `Retry-After`, Idempotency-Key, and the rate-limit buckets (visitor per session and IP, seller per account and seller, GraphQL as reads, refresh, exports, webhooks);
- `kernel/auth/revocation.test.ts` (fail closed in production), `kernel/auth/rate-limit.test.ts` (windows, two instances on one database), `kernel/config/config.test.ts` (development-token guard, `DOCS_ENABLED` refused in production);
- `modules/identity/test/admin.test.ts`: the staff idle timeout on every admin request;
- `modules/identity/test/sessions.test.ts`: one cookie per app (store and Seller Center sessions side by side, `audience` picks the cookie, sign-out clears only that app's), and `test/api.test.ts`: a re-auth token claimed once and given back.

**Not built yet:**
- the Play Integrity verifier (deployment);
- a kernel helper that applies the spec's tenant owner columns in repositories, a check against unscoped tenant reads, and generated cross-tenant 404 tests (§7).

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
  reauth.ts        verify and claim in preHandler, give back if the request fails
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

**Decisions taken** (recommended options): 1 all spec changes accepted; 2 seed sets kept as proposals until access is built; 3 "any active member" for seller reads; 4 rate limits as proposed; 5 fresh proof for sensitive staff actions (a 2-step code until 2026-10-14, now the password again); 6 deputy owner built as a standing second Business Owner at bootstrap, break-glass not built (§12); 7 HttpOnly refresh cookie on the website; 8 provider signature as the webhook token; 9 no service token (pure browser app); 10 Play Integrity + Turnstile; 11 unsubscribe through the link in the message; 12 one refresh cookie per app (store, Seller Center, Admin Center), named by `audience` on refresh and sign-out (§5).

The questions as asked:


1. **Spec changes (§15).** Accept them all, or name the ones to drop. Items 1–5 and 9 are small. Items 6, 10 and 11 (scope, field masking, viewer) touch every module spec.
2. **Seed role permissions (§14).** Confirm, or mark rows to change. Refund approval now sits with Finance, not Returns.
3. **Seller endpoints without a permission.** Keep "any active member" for reads, with the three flagged endpoints fixed (§13); or add `view` permissions per area.
4. **Rate limits (§11)** marked as proposals, and the staff concurrent-session cap of 3.
5. **Fresh 2-step for sensitive staff actions** (§10): role grants, staff account actions, finance destination changes, identity exports. Recommended: yes. *Changed 2026-10-14:* staff have no 2-step (offline, staff-only server), so the fresh proof is the password again (re-auth token).
6. **Business Owner protection and break-glass (§12).** Approve the deputy-owner procedure, and say who the deputy is. *Since then:* the deputy is named at bootstrap (`npm run bootstrap-owner` with `--deputy-email`/`--deputy-name`) and holds the Business Owner role from day one; the sealed, time-boxed break-glass role and the second reviewer on Business Owner account actions are still open (§12).
7. **Web token storage (§5).** HttpOnly refresh cookie for the website (recommended) vs keeping tokens in browser storage.
8. **Webhooks (§0).** Payment, carrier and email providers can't obtain our tokens. Accept their signature, verified in middleware, as their token (recommended)? Where a provider supports it, we can also require a secret header on top.
9. **Search engines and server rendering (§0).** If the website is server-rendered so product pages appear in search results, the render server needs a `service` token (client credentials kept on the server). If the website stays a pure browser app, no service token is needed.
10. **Bootstrap protection (§0).** Play Integrity for Android plus a bot challenge (e.g. Cloudflare Turnstile) for the website (recommended), or rate limits only.
11. **One-click unsubscribe from mail apps.** Gmail and Apple Mail's "Unsubscribe" button (RFC 8058) posts directly from the mail provider, which can't carry our token. Either rely on the unsubscribe link in the message (opens our page, which has a token), or allow that one call with only the signed unsubscribe token.
