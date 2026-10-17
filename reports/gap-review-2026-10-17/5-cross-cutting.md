# Cross-cutting review: identity, sessions, GraphQL, conventions, realtime, deployment

Backend `E:/Work/Ecommerce` @ d8dc4981 (main). Frontend `E:/Work/Ecommerce-frontend` working tree, including uncommitted changes. This was a read-only review. The scratch scripts it used are in `scratchpad/xc/`.

## Executive summary

1. **The staff changes have been adopted.** All six items listed as "never adopted" are done in the working tree:
   - `/invitation#token` with the pass code
   - `/reset-password`
   - no staff 2-step UI
   - password re-authentication through `POST /api/admin/identity/reauth`, covering all 4 purposes
   - no `X-Step-Up-Code` and no step-up kind `code`, in either the frontend or the OpenAPI
   - the seller app's call to `GET /api/store/identity/security` is allowed: `x-auth: account` accepts a seller token.
2. **GraphQL is clean at the manifest level.** All 29 persisted operations have the same ids and text (compared by AST) as the backend's runtime `spec/graphql.ts`. All 29 validate against `schema.<area>.graphql`, and every variable the pages pass exists. 16 of the 29 are never used by the web apps.
3. **High (production GraphQL):** the Seller Center sends two queries that are not persisted (`SellerCategories`, `SellerProductCard`). Production refuses them (`GRAPHQL_PERSISTED_ONLY`). As a result, New product, Offer, and the Products and Inventory category filters fail in production.
4. **High (production GraphQL):** the seller order page adds `onLabelQuantity` and `label` to `SellerOrderDetail` in development only. Production runs the persisted text without them. Labelled units then look shippable or cancellable again, and labels can't be reprinted.
5. **High (online only):** the website never sends a real app proof. The session always sends `X-App-Proof: dev`, which production refuses. Offline staff are fine because of `APP_PROOF_LOCAL_NETWORK`, but a public store or Seller Center could not start sessions.
6. **High (offline, security):** there is no UI and no CLI for the staff lifecycle. Nobody can disable, lock, sign out or revoke the roles of a departing staff member, or list, resend or revoke invitations. A leaver keeps their access.
7. **High (online):** seller team invitations link to `${SELLER_URL}/invitation#token=…`, but the Seller Center has no `/invitation` route. Invited seller staff can't join.
8. **Medium:**
   - A refresh refused as 403 (`origin_not_allowed`) is treated as fatal. Staff who open the Admin Center by IP, or by any hostname other than `API_URL`, lose their session on every reload and after 15 minutes.
   - `session_idle` is not handled: the Admin Center shows errors in every panel instead of the sign-in page.
   - Seller sign-in ignores SMS 2-step.
   - The Admin Center's links to store pages are dead offline.
9. **Conventions are consistent:**
   - the error envelope and its `details.reason` / `retryAfterSeconds`
   - `X-Client: web`
   - page and cursor pagination (all 199 list endpoints take both)
   - `Idempotency-Key`: all 50 required endpoints that the web calls send it
   - the upload flow: `uploads → content → complete → poll`, with the store, seller and admin response shapes handled.
10. **Realtime:** the backend has no SSE, websocket or GraphQL subscriptions, and the apps don't expect push. They poll every 60 s. Push devices are Android-only.

| Section | High | Medium | Low |
|---|---|---|---|
| A Mismatches | 3 | 3 | 4 |
| B Backend-only | 2 | 4 | 4 |
| C Frontend-only | 0 | 0 | 3 |
| D Missing | 0 | 2 | 2 |
| E Internet | 7 items noted | | |

---

## Scope check 2: the staff changes reported as not adopted, verified one by one

| Item | Status | Evidence |
|---|---|---|
| Staff invitation accept page `/invitation#token=…` with the one-time pass code | **Adopted** | `web:admin-center/src/main.tsx:18-25` (route); `web:admin-center/src/app/Invitation.tsx:17-80` (lookups, then accept with `{token, passCode, password, name, device}`; handles `PASS_CODE_INVALID.attemptsLeft` and `INVITATION_INVALID`). Matches `identity.AcceptInvitationRequest` and the link built at `backend:backend/src/modules/identity/service/invitations.ts:42`. Public paths skip the sign-in gate: `web:admin-center/src/app/session.tsx` `PUBLIC_PATHS`. |
| `/reset-password` page | **Adopted** | `web:admin-center/src/app/ResetPassword.tsx` (hash link from `staff-link`, plus `password_reset_required` from sign-in through router state). The link format matches `backend:.../identity/service/passwords.ts:22`. |
| No staff TOTP | **Adopted** | No 2-step enrolment, code entry or recovery codes anywhere in `admin-center/src` or `web-shared/src/layouts`. The only "two-step" text is the customer flag in `web:admin-center/src/pages/admin/Customers.tsx:55`, which is correct. `SignIn.tsx:13` still lists `second_factor_required` in its result type, but that branch can't be reached and does no harm. |
| Staff step-up = password re-auth (`POST /api/admin/identity/reauth`; purposes role-grant, staff-account, payout-destination, approval) | **Adopted** | `web:admin-center/src/pages/admin/data/step-up.tsx` (retries on 403 `STEP_UP_REQUIRED`, uses `details.purpose`, keeps unused tokens for 4.5 min). Used for staff-invitations and role permissions (`Staff.tsx:107,207`), approval-requests approve (`Inbox.tsx:430`), payout-run approve (`Payouts.tsx:188`), and destination-review approve and reject (`Payouts.tsx:255-256`). The other step-up endpoints have no UI (B1, B2). |
| `X-Step-Up-Code` header and step-up kind `code` removed | **Clean** | Zero hits in `frontend/`, `seller-center/`, `admin-center/` and `web-shared/src`. Zero `"kind":"code"` in `openapi.json`. The backend only keeps tests proving the header is ignored (`backend:backend/src/kernel/http/http.test.ts:315`). |
| Seller app calls `GET /api/store/identity/security` | **Works** | The OpenAPI operation is `x-auth: account`, and its description says it accepts a member session of either audience. `checkAudience` skips the audience check for `account` (`backend:backend/src/kernel/auth/index.ts:79-83`). Callers: `web:seller-center/src/app/session.tsx:78` (member name) and `Help.tsx:140` (email). |

## Scope check 3: GraphQL persisted operations

- **Same ids and text.** The 29 manifests and `.graphql` files in `web-shared/src/api/graphql/<area>/` differ from `docs/api/graphql/operations/<area>/` only in CRLF line endings. Compared with the runtime table `backend:backend/src/spec/graphql.ts` (`persistedQueries`), all 29 ids exist with the same name, and the printed ASTs are identical. Some backend texts are formatted differently (argument commas), which doesn't matter because the server runs its own text by id.
- **Schema validity.** All 29 validate against `schema.{store,seller,admin}.graphql` (graphql-js `validate`, after stripping the empty `extend type X` lines). The two inline Seller Center queries are also valid against the schema; they are just not persisted (A1).
- **Variables.** Every variable that the 13 used operations receive from pages is declared, and no required variable is missing.
- **Used by the web (13):**
  - store: AccountOverview, OrderList, OrderDetail, ReturnDetail, CaseDetail
  - seller: SellerOrderDetail, SellerReturnDetail, SellerProductDetail (earnings preview only)
  - admin: AdminCase, AdminDashboard, AdminOrder, AdminProductReview, AdminSeller
- **Never used by the web (16):**
  - store: CartPage, CategoryPage, CheckoutReview, HomePage, OffersPage, OrderConfirmation, ProductPage, SearchResults, SellerStorefront
  - seller: SellerDashboard, SellerFinanceOverview, SellerPerformance, SellerStatement
  - admin: AdminCustomer, AdminPayoutRun, OpsQueues

  These screens stay on REST on purpose (comments in each page). The Android app can still use them. See A8 for stale reasons given in those comments.
- **Text instead of id.** Admin pages that send text without an `operationName` (`ProductReview.tsx:96`) are accepted, because persisted-only does not apply to the admin area (`backend:backend/src/kernel/graphql/index.ts:358`).

---

## A. Mismatches

**A1 · High · Seller Center sends two queries that are not persisted; production refuses them**
- Evidence:
  - The queries: `web:seller-center/src/pages/data/products.ts:168` (`query SellerProductCard`) and `:264` (`query SellerCategories`).
  - Sent as text with no operation name from `Inventory.tsx:68`, `Products.tsx:138`, `ProductNew.tsx:170,175` and `Offer.tsx:117`.
  - Production refuses text on `/graphql/seller`: `backend:backend/src/kernel/config/index.ts:201` (`graphqlPersistedOnly: e.GRAPHQL_PERSISTED_ONLY ?? prod`), `backend:backend/.env.production.example:82`, and `kernel/graphql/index.ts:358`.
  - The web team's open request R4 (`web:web-shared/docs/BACKEND-REQUESTS.md:60-76`) asks for exactly these two operations.
- Impact: in production, New product submission fails as a whole page (`ProductNew.tsx:186`, where `failed` includes `categories`). Create offer can't load the product card, and the Products and Inventory category filters are empty. Offline (staff only) this doesn't apply, but it blocks an online Seller Center.

**A2 · High · `SellerOrderDetail` extra fields exist only in development**
- Evidence:
  - `web:seller-center/src/pages/data/orders.ts:33-35` rewrites the persisted text to add `onLabelQuantity` and `label { id labelUrl }`.
  - `web:web-shared/src/api/graphql.ts:47-53` compares the text and falls back to sending text only when `import.meta.env.DEV`. Production sends the manifest id, so the server runs the text without those fields.
  - Readers: `Order.tsx:161` (`awaitingHandover`), `:343` and `:939` (print label), and `orders.ts:374` (`toShipQty = openQty - (onLabelQuantity ?? 0)`).
- Impact: in production, units already on a bought label count as shippable or cancellable again (the G80 double-ship/cancel risk), and the "print label" buttons say there is no label. Fix: R4, i.e. add the fields to the persisted operation.

**A3 · High (online) · The website never sends a real app proof**
- Evidence:
  - `web:web-shared/src/api/session.ts:90` defaults `appProof` to `'dev'`, and `ApiProvider` never passes one (`web:web-shared/src/api/provider.tsx:37`). There is no Turnstile anywhere in the frontend.
  - The backend refuses `dev` in production (`backend:backend/src/kernel/config/index.ts:239`, and `kernel/auth/app-proof.ts:50`). It accepts no proof only from private-network IPs when `APP_PROOF_LOCAL_NETWORK=true` (`app-proof.ts:48`).
- Impact: the offline staff server works. A public store or Seller Center would answer every first visit with 401 `APP_PROOF_INVALID`, so no session could start and no page would load.

**A4 · Medium · Seller sign-in ignores SMS 2-step and a forced password reset**
- Evidence:
  - `web:seller-center/src/app/SignIn.tsx:52,68`: the method is only `'totp' | 'recovery_code'`. It never calls `POST /api/public/identity/sign-in-challenges/{id}/send-sms`, and `rememberDevice` is always false (`:103`).
  - The backend challenge methods are `totp | sms | recovery_code` (`identity.SignInChallenge`).
  - `password_reset_required` only shows a message (`:71-74`) and drops `passwordResetToken`. The store sign-in handles all of these (`frontend/src/pages/auth/SignIn.tsx:65-67, 280-330`).
- Impact: a seller whose only 2-step method is SMS can sign in only with a recovery code. A seller who was forced to reset is told to start over on the store, by email.

**A5 · Medium · A refused cookie refresh (403) is fatal instead of falling back**
- Evidence:
  - `web:web-shared/src/api/session.ts:153-155`: the refresh resolves to `null` only for 401, 423 or `ACCOUNT_DISABLED`. Anything else throws, and `token()` then fails for every request.
  - The backend answers 403 `FORBIDDEN` with `reason: origin_not_allowed` when the `Origin` is neither in the CORS lists nor the `API_URL` origin (`backend:backend/src/kernel/auth/chain.ts:457-465`).
- Impact: when staff open the Admin Center by IP or by a hostname other than `API_URL` (e.g. `https://192.168.1.10` while `API_URL=https://marketly.lan`), they can sign in, but every reload drops them to sign-in, and once the 15-minute access token expires every API call fails until they reload.
- The same happens in development when `backend/.env` is copied from `.env.example`. That file lists only `http://localhost:300x` origins (`.env.example:95-97`), while Vite binds `127.0.0.1` (`web:web-shared/vite.ts:31`). The checked-in `.env` does include `127.0.0.1` (`.env:74-76`).

**A6 · Medium · Idle staff sessions are not handled**
- Evidence:
  - `backend:backend/src/kernel/auth/chain.ts:282` answers 401 with `reason: session_idle` once `staffIdleMinutes` passes.
  - The client refreshes only for `token_*` reasons (`web:web-shared/src/api/errors.ts:30-31`), and nothing in `admin-center` or `web-shared` reacts to `session_idle`. A grep finds no handler.
- Impact: after an idle period every admin panel shows "Signed out after a period without activity", while the sidebar still looks signed in. The user only reaches the sign-in page once the access token expires (a refresh then fails because the session is no longer live, `identity/service/sessions.ts:125`) and they reload.

**A7 · Low · Raw-fetch helpers bypass the client rules**
- Evidence: `web:web-shared/src/api/uploads.ts:39-46` and `imageSpec.ts:94-96`.
  - They refresh on any 401, not only `token_*`.
  - They use relative `/api/...` paths and ignore `baseUrl`.
  - The comment in `imageSpec.ts:9-11` ("until the backend serves the endpoint") is stale: `GET /api/<area>/media/image-specs` exists in all 3 areas.
- Impact: harmless today because all apps use the same origin. It would break if an app ever set `baseUrl`.

**A8 · Low · Stale reasons for staying on REST**
- Evidence: `web:seller-center/src/pages/Dashboard.tsx:17-18`, `Finance.tsx:20-21` and `Statement.tsx:16-17` say the screen queries fail because of G13 (`Money.formatted` null). The backend fixed G13 (`backend:BACKEND-ANSWERS.md:75`; resolver in `kernel/graphql/index.ts:208`).
- Impact: none for users. These screens could move to their persisted queries, which are among the 16 unused.

**A9 · Low · The `__Secure-` refresh cookie in development relies on the browser's localhost exception**
- Evidence: the cookie is `Secure; SameSite=Strict; Path=/api/public/identity/sessions` (`backend:backend/src/modules/identity/http/client.ts:38`), while the dev servers run plain `http://127.0.0.1:300x` (`web-shared/vite.ts:31`).
- Impact: Chromium and Firefox treat `localhost`/`127.0.0.1` as secure, so this works there; Safari and a LAN IP over http do not. Not verified in a browser. Production is HTTPS on one origin, so this is a development concern only.

**A10 · Low (risk, not reproduced) · Token expiry is judged by the client clock**
- Evidence: `web:web-shared/src/api/session.ts:115` (`claims.exp*1000 - Date.now() > 30_000`).
- Impact: on an offline LAN without time sync, a staff PC running more than about 14.5 minutes fast would refresh before every call. Refreshes are rate-limited per session (`kernel/auth/chain.ts:449`), which would end in `RATE_LIMITED`. A fix is to compare against `accessTokenExpiresAt` minus the skew measured at adopt time.

## B. Backend-only (no web surface)

These were verified against the template-literal usage. Of the media operations flagged as unused, these are in fact used through `uploads.ts` and `imageSpec.ts`, in every area:
- `POST …/media/uploads`
- `PUT …/uploads/{id}/content`
- `POST …/uploads/{id}/complete`
- `GET …/assets/{id}`
- `GET …/image-specs`

The real unused counts are store 3 of 8, seller 5 of 10 and admin 7 of 12 (B6). Similarly, `app-sessions`, `sessions/refresh` and `sessions/sign-out` are used by `session.ts`.

**B1 · High (offline core, security) · Staff lifecycle is API-only**
- Unused endpoints:
  - identity: `GET /api/admin/identity/accounts`, `accounts/{id}`, `accounts/{id}/security-activity`; `POST accounts/{id}/{disable,enable,lock,unlock,force-password-reset,sign-out-all}`
  - staff invitations: `GET /api/admin/identity/invitations`, `POST invitations/{id}/{resend,revoke}`
  - access: `POST /api/admin/access/role-assignments`, `role-assignments/{id}/revoke`, `GET members/{accountId}`, `away-periods` (create, cancel, end), `PUT roles/{id}/coverage`, `roles/{id}/archive`, `PATCH roles/{id}`
- Evidence: the inventory, and `Staff.tsx` calls only roles, members, coverage, away-periods (read), staff-invitations, role permissions and limit-changes (`web:admin-center/src/pages/admin/Staff.tsx:70-212`). The CLI covers only links and passwords (`backend:docs/MAINTAINING.md:238-243`, `staff-link`).
- Impact: staff can't be offboarded (no disable, lock, sign-out or role removal) or have their roles changed after the invite, and pending invitations can't be seen or cancelled. Because this server is staff-only, a departed employee keeps access.
- Host: Admin › Staff (`admin/staff`), as a member detail drawer with Disable, Lock, Sign out everywhere, Require new password and Roles, plus an Invitations tab. All of these must go through `useStepUp` (staff-account and role-grant).

**B2 · Medium · Refund approval has no UI**
- Evidence: `POST /api/admin/returns/refunds/{id}/approve` (`Idempotency-Key` required, the `returns.refunds.approve` approval action; OpenAPI screens admin/returns, admin/case and ops/return-inspection) is called nowhere. `RefundRequest.status` includes `requested` and `under_review`.
- Impact: refund requests waiting for a refund approver can't be approved from the Admin Center. Please confirm with the returns reviewer whether every path goes through approval-requests instead.

**B3 · High (online) · Seller team invitations can't be accepted**
- Evidence: the backend link is `${appUrl('seller')}/invitation#token=…` (`backend:backend/src/modules/identity/service/invitations.ts:42`). `InvitationView.existingAccount` and `AcceptInvitationRequest.currentPassword` exist for members. The Seller Center has no `/invitation` route (nothing in `web:seller-center/src/main.tsx` or the catalogue), while `seller-center/src/pages/Staff.tsx:135` sends invitations.
- Impact: invited seller staff land on Not found. Host: a public `/invitation` page in the Seller Center, like the admin one but with a "current password" mode for existing accounts and no pass code.

**B4 · Medium · Google/Apple sign-in removed from the UI, backend keeps it**
- Evidence: the uncommitted diff removes `GoogleButton`, `AppleButton` and the seller dev Google path (`frontend/src/pages/auth/SignIn.tsx`, `Register.tsx`, `seller-center/src/app/SignIn.tsx`). `POST /api/public/identity/external-sign-ins` remains.
- Impact: accounts created through Google or Apple (`hasPassword=false`) can't sign in on the web, and there is no set-password flow (`web:frontend/src/pages/account/data/password.ts:1-2`). They can recover only through "Forgot password", which needs email. This needs internet anyway (E).

**B5 · Medium · Seller step-up features with no UI**
- Evidence: `POST /api/seller/sellers/business/change-requests` (reauth `business-change`) and `POST /api/seller/sellers/account/close` (reauth `seller-closure`) are not called. Only `payout-account` is wired (`Finance.tsx:175`).
- Impact: sellers can't change business details or close their account. Host: Seller › Store profile. The seller reviewer may report this as well.

**B6 · Medium/Low · Media library and moderation**
- Unused:
  - admin: `GET /api/admin/media/assets`, `DELETE`, `PATCH`, `POST …/checks`, `…/remove`, `…/restore`, `GET …/download`
  - seller: `GET /api/seller/media/assets` (library), `DELETE`, `PATCH`, `POST …/checks`, `GET …/download`
  - store: `DELETE`, `PATCH`, `GET …/download`
- Impact:
  - Admin "take a file down" (policy, rights or privacy) and restore is a moderation capability with no screen. Medium; host: Admin › Catalog or Trust.
  - Seller media library and pre-submit image checks are nice-to-have.
  - Private document download: the admin seller application uses the signed `doc.file.url` directly (`SellerApplication.tsx:633`), so the gap is minor.

**B7 · Low · Members' security extras**
- `POST /api/store/identity/two-step/recovery-codes` (replace recovery codes) has no UI: `Security.tsx:274` only shows the remaining count.
- `GET /api/store/identity/devices` is unused, but the security overview already lists devices.
- Members can confirm step-ups with a 2-step `code` (`identity.ReauthRequest.code`), but the UI only offers a password.
- The Seller Center has no "my sign-in and security" screen, although the store-area endpoints accept seller tokens (`x-auth: account`). Members must use the store account pages.

**B8 · Low · 16 persisted screen queries are not used by the web** (list above). They are for Android, so this is internal.

**B9 · Integration only:**
- 9 webhooks (payments, carriers, email and SMS events, inbound email, payouts, verification, media)
- push-device registration (`/api/{store,seller}/notifications/push-devices`, Android FCM)
- `POST /api/public/customers/unsubscribe` (email links)
- `POST /api/public/trust/reports` (rights owners)

No web screen is expected for any of these.

**B10 · Low · Admin notifications delivery tooling** (deliveries, retry, suppressions, stats, broadcasts) has no screen. It is mostly irrelevant offline, where no email or SMS goes out.

## C. Frontend-only

**C1 · Low · The back-office layout falls back to fixture identities**
- Evidence: `web:web-shared/src/layouts/BackOfficeLayout.tsx:181,250` uses `STAFF` from `web-shared/src/data/staff.ts` ("Riley Chen", "Avery Stone · Northwind Audio") when no identity is provided.
- Impact: signed-in pages always provide an identity, so these names show only on unauthenticated layouts such as `/design`.

**C2 · Low · `/design` ships in the production Admin Center**
- Evidence: `web:web-shared/src/routes/createAppRouter.tsx:124`. Only `/design/check` is limited to development.
- Impact: staff can open a design screen index at `https://<server>/design`. Harmless, but not a product screen.

**C3 · Low (OK) · Development-only paths are properly gated**
- `/api/dev/payments/intents/{id}/settle` (`web:frontend/src/pages/store/data/checkout-api.ts:139-150`) shows only when `import.meta.env.DEV` (`PaymentResult.tsx:337`).
- The seller `DEV_REAUTH` applies only when `import.meta.env.DEV && claims.dev` (`Finance.tsx:114`).
- No production path calls `/api/dev`.

## D. Missing (neither side, or a broken link between them)

**D1 · Medium · Admin Center links to store pages are dead on the offline server**
- Evidence:
  - The store links come from `href('store/product' | 'store/official' | 'store/home' | 'help/article' | 'info/policy')` in `web:admin-center/src/pages/admin/Reviews.tsx:321`, `Catalog.tsx:40`, `Official.tsx:34`, `Content.tsx:307,451`, `Notifications.tsx:442` and `HelpContent.tsx:336,401,608`.
  - These resolve to `APP_URLS.store`, which defaults to `http://127.0.0.1:3000` (`web:web-shared/src/routes/apps.ts:12`). The current `admin-center/dist` was built with all three URLs set to `https://marketly.lan`, so these links open the Admin SPA itself and land on Not found.
  - `MAINTAINING.md` §6 doesn't say how to set `VITE_*_URL` for the admin build.
- Impact: "View on store" and "Preview" links in moderation and content screens go nowhere offline. Either hide them when the store isn't deployed or show an in-app preview.

**D2 · Medium · No "signed out" experience for staff**
- Neither side defines a client signal for the end of a staff session (idle, revoked or disabled) that sends the user to sign-in. The backend uses three different shapes: 401 `session_idle`, 401 `token_revoked` (the client then refreshes, which fails), and 403 `ACCOUNT_DISABLED` on refresh.
- A single rule would help, e.g. "401 whose reason is not `token_*`, on a staff token, means go to sign-in". See A5 and A6.

**D3 · Low · Passkeys don't exist on either side.** The 2-step methods are TOTP and SMS, plus recovery codes. This is noted because the scope asked; no gap against the spec.

**D4 · Low · No way to set a password for password-less members.** Google/Apple-only accounts can't add a password (G28 noted as "no set-password flow"). This now matters more because B4 removed external sign-in.

## E. Internet dependencies in this scope

- The Google Fonts `<link>` in `web:frontend/index.html:8-10` and `web:seller-center/index.html:8-10`. The Admin Center bundles its fonts (`admin-center/index.html:8`), as the admin CSP `default-src 'self'` requires (`backend:backend/src/kernel/http/admin-app.ts:46-55`).
- App proof:
  - Turnstile verification calls `https://challenges.cloudflare.com/turnstile/v0/siteverify` (`backend:backend/src/kernel/auth/app-proof.ts:54`).
  - Play Integrity on Android.
  - Neither runs offline; `APP_PROOF_LOCAL_NETWORK` covers that case.
- Google/Apple ID-token verification for `external-sign-ins`.
- SMS 2-step codes, and email for verification, resets and order links. Offline, staff links come from the CLI instead.
- FCM push devices (Android).
- The USPS tracking link in `web:frontend/src/pages/account/Tracking.tsx:20`.

---

## Other scope checks (no gaps found)

- **Error envelope and codes.** `{error:{code,message,details}}` is parsed in `web:web-shared/src/api/errors.ts:47-53`. `VALIDATION_FAILED.details.issues[].path` is a dotted string, which matches `fieldErrors` (`backend:backend/src/kernel/http/server.ts:83`). `RATE_LIMITED.details.retryAfterSeconds` matches `errorMessage` (`kernel/auth/rate-limit.ts:175`). `token_*` reasons match `isTokenProblem` (`kernel/auth/index.ts:67-68`).
- **Idempotency.** 50 operations require `Idempotency-Key`. Every one the web calls sends it:
  - checkout place, complete-action and retry-payment
  - order cancellations and cancel-items
  - return create, remedy and approve-without-return
  - admin refunds create
  - payout-run approve and payouts retry
  - reconciliation correct
  - seller payout-account change and labels
  - support cases and requests, and case decide
  - warehouse package label

  The other 24 are not called (finance holds and adjustments, wallet, payments capture and void, fulfillment-service, refunds approve, labels void, appeal decide, gift-card redeem).
- **X-Client.** It is used only for the Android version gate (`kernel/auth/chain.ts:197-208`). The web sends `web` everywhere, including raw fetches.
- **CORS and origins.** API calls are same-origin through the dev proxy (`web-shared/vite.ts:14-16`). Credentials are sent only on identity cookie routes (`client.ts:15-16`, `session.ts:141-150`), matching `SESSION_COOKIE_ENDPOINTS`. In production the Admin Center is same-origin.
- **Pagination.** All 199 GET list operations accept both `page` and `cursor`, plus `limit`. Pages use both styles (e.g. `help/Cases.tsx:28-41`).
- **Upload flow.**
  - The store body is the plain spec; the admin body is `{upload, ownerKind}` (`uploads.ts:62`, which matches `POST /api/admin/media/uploads`).
  - Content is sent as `application/octet-stream`.
  - `complete` returns 202 `MediaAsset`. Seller and admin `GET assets/{id}` return `{asset,…}`, which `unwrap` handles.
  - `image-specs` returns `{productImage}` (`media.ProductImageSpec`), which matches `imageSpec.ts:99-101`.
- **Deployment fit (Admin Center served by the API).**
  - Vite `base` is the default `/`. The router has no basename, so `/`, `/ops/*`, `/invitation` and `/reset-password` all fall through to `index.html` (`backend:backend/src/kernel/http/admin-app.ts:113-128`).
  - The API base is `''`, so the app calls the same origin.
  - The built `index.html` has no inline script (CSP compatible).
  - The `__Secure-mk_refresh_admin` cookie works over the server's HTTPS. The Origin check passes when staff use the `API_URL` hostname (A5 otherwise).
  - Signed `/files` links use `API_URL`, so admin images satisfy `img-src 'self'` only when staff browse by that same host.
- **Realtime.** No backend SSE, websocket or GraphQL subscription exists (grep across `backend/src` and the schemas). The apps poll:
  - work queues and the inbox every 60 s (`admin-center/src/app/session.tsx:84-85`)
  - seller order counts and the inbox every 60 s
  - the upload status every 1.5 s.

  No app expects push.
