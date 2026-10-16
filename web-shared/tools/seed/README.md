# Marketly seed

Fills a running Marketly backend with the design's sample data **through the HTTP API only**, so the store,
Seller Center and Admin Center show real content: the Official Store and five sellers, about 21 products with
photos, offers with stock and was-prices, coupons and a flash sale, a published homepage, help, policies and an
About page, customers with addresses, orders in every state, reviews and Q&A.

Node 22+ (built-ins only). No backend code is changed or imported.

## Prerequisites

1. **Backend database that survives restarts.** Either the embedded server with `MONGO_DATA_DIR` (since R2 it
   keeps `MONGO_PORT`, default 27018, and replica set `rs0`; delete a data folder made before R2 once), or an
   external single-node replica set the backend points at:

   ```sh
   mongod --replSet rs0 --port 27018 --dbpath E:/Work/Ecommerce-api/backend/.data/mongo-rs
   mongosh --port 27018 --eval 'rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27018" }] })'
   ```

   In `E:/Work/Ecommerce-api/backend/.env`:

   ```
   MONGODB_URI=mongodb://127.0.0.1:27018/marketly?replicaSet=rs0
   JOBS_ENABLED=true      # media processing, search indexing, refunds, policy effective dates, homepage cache
   RATE_LIMITS=false      # the seed makes ~1,500 requests
   DEV_TOKENS=true        # default outside production: dev tokens, X-App-Proof: dev, re-auth proofs dev-reauth.<purpose>,
                          # and the /api/dev routes the seed reads (outbox, test deposits)
   LAUNCH_PHASE=2         # dev Google sign-in and flash sales are phase 2
   ```

2. **Business Owners first, with the server stopped** (the bootstrap is a CLI, not an API):

   ```sh
   cd E:/Work/Ecommerce-api/backend
   npm run -s bootstrap-owner -- --email olivia.owner@marketly.test --name "Olivia Owner" \
     --deputy-email morgan.hale@marketly.test --deputy-name "Morgan Hale" \
     > E:/Work/Ecommerce-frontend/web-shared/.seed/bootstrap-owner.txt
   ```

   It prints, per person, `Invited <name> <email> as … (account <id>).`, `Link: …#token=…` and
   `Pass code: XXXX-XXXX`. The seed reads the account ids, links and pass codes from that file (git-ignored; it
   holds secrets) and accepts each invitation with the pass code and the password `Marketly-dev-2026!`. Staff
   have no authenticator (since 2026-10-14). A link works 7 days and 5 wrong pass codes end it. For a new link
   and pass code, append `npm run -s staff-link -- --email <email>` to the same file (a later block replaces the
   earlier one) and run `npm run seed -- --only owners`. With an external `mongod` the CLIs also work while the
   server runs.

3. Start the backend (`npm run dev` in `backend/`, http://127.0.0.1:4000). The seed mints dev tokens with
   the backend's dev key (`backend/.data/dev-signing-key.json`), so it must run on the same machine.

## Run

```sh
npm run seed                                  # from the repository root (or: npm run seed -w @marketly/web-shared)
npm run seed -- --only orders,reviews         # just these steps (always re-run, even if done before)
npm run seed -- --force                       # every step again (existing records are looked up, not duplicated)
npm run seed -- --api http://127.0.0.1:4000 --backend E:/Work/Ecommerce-api/backend
SEED_DEBUG=1 npm run seed -- --only verify    # log every request with its status and time
```

Steps, in order: `owners`, `taxonomy`, `media`, `official`, `sellers`, `promotions`, `content`, `customers`,
`orders`, `reviews`, `design`, `verify`. A full run takes about **20–25 minutes**, mostly waiting for jobs: every upload
waits for `media.process` (about 8–10 s each, ~70 uploads), refunds wait for `payments.process-refunds` (up to
~1 min), search waits for `search.process-dirty` (every 30 s).

**Re-runnable.** `web-shared/.seed/state.json` (git-ignored) keeps the ids of everything created under stable
keys, finished steps and per-order progress. A second run skips finished steps; `--only`/`--force` re-run steps
and look records up (by name, slug, SKU or email) before creating them. If the backend database was reset,
delete `state.json` (or pass `--reset`) and run bootstrap-owner + the seed again.

## What it creates

| Area | Data |
|---|---|
| Staff | Olivia Owner and Morgan Hale accept their invitations (link + pass code + password) and sign in to the Admin Center with email and password (no authenticator for staff). Staff work then uses dev staff tokens **as their accounts**, so approval limits and two-person rules apply: Olivia creates and requests, Morgan approves. |
| Taxonomy | 8 categories with 35 subcategories (fixtures), each with a tile image (`Category.image`, set with the admin category `imageId`), 11 brands (Halden, Kestrel, Brightline, Mosswood, Tidewell, Trailhead, Corvo, Pellar, Nordvik, Aster, Northwind) |
| Media | Real PNGs (1200×1200, tinted background with a shape, one colour per variant; 3 photos for the first variant), store logos and banners, homepage and About banners, PDF verification documents |
| Official Store | Location *Reno fulfillment center* (Reno, NV) with pick bins and box types; 8 products (Halden Aurora with Midnight black / Stone / Sage, Aurora Buds, Studio 2, Brightline lamp, Pellar skillet, Nordvik sweater, Mosswood pour-over, Aster serum); variant list prices (`listPrice`, which the was-price check reads); offers with stock by adjustment and verified was-prices ($229 → $189) |
| Sellers | Northwind Audio, Pixel & Port, Casa Verde Home, Trailhead Outfitters, Gadget Grove: owner account, invitation (code read from the invitation email in the dev outbox), application with documents, approval, payout test deposits (amounts from `GET /api/dev/finance/test-deposits`), shipping settings and profile, storefront (logo, banner, introduction, tagline), 13 products, launch review, variant list prices set by staff (sellers can't send `listPrice`), offers with stock. Other offers on the Aurora: Northwind (new, $184 + $6.99 shipping), Pixel & Port (used – like new, $149), Gadget Grove (refurbished, $129) |
| Promotions | `WELCOME20` ($20 off $100+), clip-only "$5 off your first Official Store order", *Home Week flash deals* (Kestrel monitor, Halden speaker, Mosswood duvet, Pellar skillet), Casa Verde's own "15% off Mosswood bedding" |
| Content | Homepage (Home Week banner, category shortcuts, flash deals, featured products, popular products, featured sellers, promise strip), header/footer navigation and service strip, 9 help categories and 10 articles (customer + seller; author Olivia, approver Morgan), policies `returns`, `shipping`, `privacy`, `purchase_terms`, `seller_rules` (Morgan approves as policy owner, Olivia decides the Business Owner approval request), About page |
| Customers | Jordan Lee (Home 2140 Alder St Apt 5, 97205, default; Work 815 SW 2nd Ave Floor 4, 97204; marketing consent), Mara Diaz, Devon Price, Ines Keller, Priya Kapoor, Sam Rivera |
| Orders | Jordan: multi-seller order with WELCOME20 (Official Store delivered + return requested on the pour-over, Pixel & Port in transit, Casa Verde delayed), preparing (Trailhead), delivered skillet, backpack delivered → returned → refunded, cancelled shoes, speaker + cable kit with the cable kit cancelled by the seller, monitor in transit. Others: Aurora orders delivered for Mara, Devon, Ines, Priya; Sam's new and shipped orders. Payment with the dev adapter (`tok_visa`); seller shipments with carrier-format tracking numbers; Official Store packages through the warehouse (wave, pick, pack, label); deliveries by signed carrier webhooks |
| Reviews | 6 reviews (Aurora 5★/4★/2★/5★, skillet, speaker), seller and Official Store responses, seller feedback, 6 questions with staff, seller and customer answers (one left unanswered) |
| Design states (`design`) | The states the Customer Store design views show, for `/design/check` (see below): Jordan's cart (Aurora, pour-over, lamp, Pocket speaker, linen duvet: 3 packages); an order placed for the confirmation page; a cancellation requested (Casa Verde duvet); a failed delivery attempt (Pixel & Port SSDs, carrier `attempt_failed` webhook); a keyboard return received by Pixel & Port; a damaged kettle replaced by Casa Verde (replacement shipped, in transit); the pour-over return approved by the Official Store (QR drop-off) and a speaker return requested from Northwind; support cases open (duvet late, seller replied), decided (sheets never shipped: full refund) and two resolved; five conversations (Casa Verde, Pixel & Port, Northwind, Official Store, Marketly Support); Official Store out of Aurora Stone; coupons `HOMEWEEK15` and `NWA10` (clipped by Jordan); a review report by Jordan; a guest order (Taylor Brooks: skillet delivered, bottle in transit); checkouts with a declined payment, a payment being checked and a rejected coupon |

## Design samples (`design` step)

`npm run seed -- --only design` brings the live data to the states the store design shows and writes
`web-shared/.seed/design-samples.json` (git-ignored, no secrets). `/design/check` in the store dev server reads it
and opens every screen view on its record, in the right session (the `/design` index links to the same URLs):

```json
{
  "customer": { "email": "jordan.lee@example.com", "first": "Jordan", "last": "Lee" },
  "samples": {
    "account/return@refund-sent": { "session": "customer", "params": { "ref": "RT-…" } },
    "store/search-empty@": { "session": "visitor", "query": { "q": "halden aurora", "condition": "used", "priceMax": "10000" } },
    "auth/guest-orders@found": {
      "session": "visitor",
      "query": { "ref": "MK-…" },
      "before": [{ "method": "POST", "path": "/api/store/customers/guest-orders/lookup", "body": { "orderRef": "MK-…", "email": "…" } }]
    }
  }
}
```

Keys are `<screenId>@<view>` (view `''` for the default). `params` and `query` build the URL with `href()` (the
catalogue's `sample` fills missing params). `session` is `visitor` (signed out: a fresh guest session) or
`customer` (dev Google sign-in as `customer`). `before` lists requests the check makes in that session first (a
guest cart, a guest order look-up). The check runs the visitor rows first, then the customer rows, and ends signed
in as Jordan. Views without a sample keep the catalogue example and are marked in the results.

The step is re-runnable: finished stages are remembered in `state.json` → `design`, and records are looked up
before they are made. Two kinds of state don't last, so **run the step again shortly before a check**:

- Checkout sessions expire after 60 idle minutes (30 minutes after a declined payment). Jordan's cart and the
  declined-payment and rejected-coupon checkouts are made again on every run (a declined payment creates no order).
- The *payment being checked* checkout is made once only. The dev processor's uncertain answer is settled by the
  `payments.check-uncertain` job (every 30 s), so the payment is pending for about a minute and then shows the
  declined result. Each new attempt would be another (cancelled) order that counts against the Official Store's
  purchase limit (3 per offer per customer in 30 days). That limit is also why Jordan's cart holds the Aurora in
  Sage and the pour-over in Slate (the design shows Midnight black and Cream).

## Signing in

- **Admin Center (owners):** `olivia.owner@marketly.test` / `morgan.hale@marketly.test`, password
  `Marketly-dev-2026!` (also in `web-shared/.seed/state.json` → `owners`; never commit that file). Email and
  password only: staff have no 2-step sign-in, and sensitive actions ask for the password again (re-auth).
  `totpSecret` and `recoveryCodes` left in an older state file are unused. A forgotten password:
  `npm run -s staff-link -- --email <email>` in the backend prints a reset link (Admin Center `/reset-password`).
- **Store (Jordan and the other customers):** they were created with the dev Google sign-in and have **no
  password**. In the store app use *Continue with Google* in development (the backend accepts the id token
  `dev:jordan.lee@example.com:Jordan:Lee`), or a dev customer token (`npm run -s token -- customer --account
  <Jordan's account id>` in the backend). Seeded customers have no password, and the API has no set-password
  flow for such accounts (G12). To try password sign-up by hand, register a new customer in the store and read
  the code from the dev outbox: `GET /api/dev/notifications/outbox?to=<email>` with any dev token →
  `items[0].data.code.value` (password-reset links: `data.reset.url`, guest order links: `data.guest.url`).
- **Seller Center:** seller owners (e.g. `hannah@northwindaudio.example.com`) are also dev-Google accounts;
  use a dev seller token: `npm run -s token -- seller --seller <sellerId> --account <owner accountId>` (ids in
  `state.json` → `sellers`).

## Reset

1. Stop the backend.
2. Empty the database: stop `mongod` and delete `backend/.data/mongo-rs` (then start it and run
   `rs.initiate` again), or drop the `marketly` database. With the old embedded setup: delete
   `backend/.data/mongo`.
3. Run `bootstrap-owner` again (step 2 above), start the backend.
4. `npm run seed -- --reset`.

## Layout

```
tools/seed/
  index.mjs          CLI, step runner, summary
  data.mjs           all sample data (from web-shared/src/data/fixtures.ts and frontend/src/pages/store/data)
  lib/http.mjs       fetch client: retries, Idempotency-Key, error envelope, polling, signed webhooks
  lib/tokens.mjs     dev tokens minted from the backend's dev key (falls back to `npm run token`)
  lib/outbox.mjs     dev routes: invitation code from GET /api/dev/notifications/outbox, GET /api/dev/finance/test-deposits
  lib/codes.mjs      GTINs, tracking numbers, webhook signature; computed invitation code and test deposits
                     (used only when a dev route answers 404, i.e. an older backend)
  lib/files.mjs      PNG and PDF generators (zlib)
  lib/context.mjs    shared helpers: uploads, sign-in, tokens per person
  lib/state.mjs      state file
  steps/*.mjs        one module per step (steps/design.mjs: design states + design-samples.json)
```
