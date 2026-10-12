# Wallet (`wallet`)

Customer store credit with an auditable ledger (refunds to credit, goodwill credit within approval limits, price adjustments, use at checkout, expiry), gift cards, and a placeholder for loyalty rewards. Checkout and payments use the balance through the in-process public API.

- **Group:** Later phases · **Launch phase:** 3 · **Plan chapters:** 15, 7, 13, 6
- **Depends on:** [customers](customers.md), [payments](payments.md) · **Optional:** [access](access.md), [support](support.md), [orders](orders.md), [notifications](notifications.md), [finance](finance.md), [audit](audit.md), [media](media.md)

## Owns
- Store credit accounts and balance, made of credit lots with their source and expiry
- Credit ledger: refund to credit, goodwill credit, price adjustment, gift card redemption, checkout hold, capture and release, reversal on refund of an order paid with credit, expiry, staff correction
- Goodwill credit grants with reason, linked case or order, and approval above the staff member's limit
- Holds at checkout (reserve while payment runs, capture on order acceptance, release on failure)
- Gift cards: issuance in batches, codes, balance check, redemption into store credit, void and expiry
- Loyalty points ledger (phase 4 experiment; designed, off)

**Not here:**
- Card refunds and the choice of refund destination: payments and returns (they call creditRefund when the customer chose store credit)
- Case decisions and remedies: support (calls grantGoodwill)
- Coupons and discounts: promotions
- Accounting of the credit liability: finance (consumes wallet events)
- Approval limits and second reviewers: access

## Store API

| Method | Path | Purpose | Auth | Body → Response |
|---|---|---|---|---|
| GET | `/api/store/wallet/credit` | Store credit balance, lots with expiry and recent history | customer | `WalletOverview` |
| GET | `/api/store/wallet/credit/entries` | Credit history | customer | Page<LedgerEntry> |
| POST | `/api/store/wallet/gift-cards/redeem` | Add a gift card to store credit _(idempotent)_ | customer | `{ code: string }` → `WalletOverview` |
| POST | `/api/store/wallet/gift-cards/check` | Check a gift card balance | shopper | `{ code: string }` → `{ remaining: Money, expiresAt: datetime?, state: string }` |
| GET | `/api/store/wallet/loyalty` | Loyalty points (experiment; NOT_IMPLEMENTED until a program is defined) _(phase 4)_ | customer | `LoyaltyAccount` |

## Admin API

| Method | Path | Purpose | Auth | Body → Response |
|---|---|---|---|---|
| GET | `/api/admin/wallet/customers/{customerId}` | A customer's credit balance, lots, goodwill in the last 30 days and pending grants | staff<br>`wallet.credit.view` | `CustomerWalletAdmin` |
| GET | `/api/admin/wallet/customers/{customerId}/entries` | A customer's credit ledger | staff<br>`wallet.credit.view` | Page<LedgerEntry> |
| POST | `/api/admin/wallet/goodwill` | Grant goodwill credit with a reason _(idempotent, audited)_ | staff<br>`wallet.goodwill.grant` | `GoodwillInput` → `GoodwillGrant` |
| GET | `/api/admin/wallet/goodwill` | Goodwill grants for review | staff<br>`wallet.credit.view` | Page<GoodwillGrant> |
| POST | `/api/admin/wallet/goodwill/{id}/reverse` | Reverse an unused goodwill grant _(idempotent, audited)_ | staff<br>`wallet.credit.correct` | `{ reason: text }` → `GoodwillGrant` |
| POST | `/api/admin/wallet/customers/{customerId}/corrections` | Correct a balance (positive or negative) with a reason _(idempotent, audited)_ | staff<br>`wallet.credit.correct` | `{ amount: Money, reason: text, reference: string? }` → `CreditCorrection` |
| POST | `/api/admin/wallet/gift-cards` | Issue a batch of gift cards _(idempotent, audited)_ | staff<br>`wallet.gift_cards.manage` | `GiftCardBatchInput` → `{ batchId: uuid, count: int, total: Money, status: enum(issued|pending_approval), codesFileId: uuid?, codesAvailableUntil: datetime? }` |
| GET | `/api/admin/wallet/gift-cards/batches/{id}/codes` | Download a batch's gift card codes once _(audited)_ | staff<br>`wallet.gift_cards.manage` | `{ batchId: uuid, codes: string[], count: int, deliveredAt: datetime }` |
| GET | `/api/admin/wallet/gift-cards` | Gift cards | staff<br>`wallet.gift_cards.manage` | Page<GiftCard> |
| POST | `/api/admin/wallet/gift-cards/{id}/void` | Void a gift card (lost, fraud) _(idempotent, audited)_ | staff<br>`wallet.gift_cards.manage` | `{ reason: text }` → `GiftCard` |

## Types

### CreditBalance

| Field | Type |
|---|---|
| customerId | `uuid` |
| available | `Money` |
| held | `Money` |
| nextExpiry | `LotExpiry?` |
| usableOn | `string` e.g. Any item from any seller; not on gift cards |

### LotExpiry

| Field | Type |
|---|---|
| amount | `Money` |
| expiresAt | `datetime` |

### CreditLot

| Field | Type |
|---|---|
| id | `uuid` |
| source | `enum(refund|goodwill|price_adjustment|gift_card|correction)` |
| original | `Money` |
| remaining | `Money` |
| expiresAt | `datetime?` |
| createdAt | `datetime` |
| reference | `string?` |

### LedgerEntry

| Field | Type |
|---|---|
| id | `uuid` |
| at | `datetime` |
| kind | `enum(refund_to_credit|goodwill|price_adjustment|gift_card_redeemed|hold|capture|release|order_refund_returned|expiry|correction|reversal)` |
| amount | `Money` Signed: credits positive, uses negative |
| balanceAfter | `Money` |
| label | `string` e.g. Goodwill credit · case CS-260903-1876, late delivery; Used on order MK-260830-11764 |
| orderId | `uuid?` |
| orderRef | `string?` |
| caseRef | `string?` |
| refundId | `uuid?` |
| actor | `Actor?` |
| reason | `text?` |

### CreditHold

| Field | Type |
|---|---|
| id | `uuid` |
| customerId | `uuid` |
| quoteId | `uuid` |
| orderId | `uuid?` |
| amount | `Money` |
| state | `enum(held|captured|released)` |
| expiresAt | `datetime` |

### WalletOverview

| Field | Type |
|---|---|
| balance | `CreditBalance` |
| lots | `CreditLot[]` |
| recent | `LedgerEntry[]` |
| giftCardsEnabled | `bool` |
| howToUse | `string` e.g. Choose to use it at the payment step of checkout. |

### GoodwillInput

| Field | Type |
|---|---|
| customerId | `uuid` |
| amount | `Money` |
| reason | `text` |
| reasonCode | `enum(late_delivery|service_failure|price_adjustment|damaged_item|other)` |
| caseId | `uuid?` |
| orderId | `uuid?` |
| chargedTo | `enum(platform|seller)` Seller-charged goodwill is posted to seller earnings by finance |
| sellerId | `uuid?` |
| expiresInDays | `int?` |

### GoodwillGrant

| Field | Type |
|---|---|
| id | `uuid` |
| customerId | `uuid` |
| customerName | `string?` |
| amount | `Money` |
| reason | `text` |
| reasonCode | `string` |
| caseRef | `string?` |
| orderRef | `string?` |
| chargedTo | `enum(platform|seller)` |
| sellerId | `uuid?` |
| state | `enum(pending_approval|granted|rejected|reversed)` |
| approval | `ApprovalInfo?` |
| requestedBy | `Actor` |
| decidedBy | `Actor?` |
| createdAt | `datetime` |
| grantedAt | `datetime?` |
| ledgerEntryId | `uuid?` |

### GiftCard

| Field | Type |
|---|---|
| id | `uuid` |
| codeLast4 | `string` |
| batchId | `uuid?` |
| initial | `Money` |
| remaining | `Money` |
| state | `enum(issued|active|redeemed|voided|expired)` |
| purpose | `enum(promotional|customer_service|sold)` |
| expiresAt | `datetime?` |
| redeemedBy | `uuid?` |
| redeemedAt | `datetime?` |
| createdBy | `Actor` |
| createdAt | `datetime` |

### GiftCardBatchInput

| Field | Type |
|---|---|
| count | `int` |
| amount | `Money` |
| purpose | `enum(promotional|customer_service|sold)` |
| expiresAt | `datetime?` |
| reason | `text` |
| costCenter | `string?` |

### CustomerWalletAdmin

| Field | Type |
|---|---|
| balance | `CreditBalance` |
| lots | `CreditLot[]` |
| goodwillLast30Days | `Money` |
| goodwillLimitPerCustomer | `Money` |
| pendingGrants | `GoodwillGrant[]` |
| pendingCorrections | `CreditCorrection[]` Corrections waiting for a second reviewer |

### CreditCorrection

| Field | Type |
|---|---|
| id | `uuid` |
| customerId | `uuid` |
| amount | `Money` Signed: positive adds credit, negative takes it away |
| reason | `text` |
| reference | `string?` |
| state | `enum(pending_approval|applied|rejected|failed)` |
| approval | `ApprovalInfo?` |
| entry | `LedgerEntry?` The ledger entry once applied |
| failure | `string?` Why an approved correction could not be applied (e.g. the customer no longer has the credit to take away) |
| requestedBy | `Actor` |
| decidedBy | `Actor?` |
| createdAt | `datetime` |
| decidedAt | `datetime?` |

### LoyaltyAccount

| Field | Type |
|---|---|
| customerId | `uuid` |
| points | `int` |
| tier | `string?` |
| pendingPoints | `int` |
| programTerms | `string?` |

## Status flows

### Credit correction (`CreditCorrection.state`)

```mermaid
stateDiagram-v2
  [*] --> pending_approval
  pending_approval --> applied: apply
  pending_approval --> rejected: reject
  pending_approval --> failed: fail
```

Within the caller's adjustment limit a correction is applied in the same call (pending_approval → applied). Above it the access approval decides: approved applies it (fail when a negative correction finds less credit than it takes), rejected or expired ends it rejected.

### Credit hold (`CreditHold.state`)

```mermaid
stateDiagram-v2
  [*] --> held
  held --> captured: capture
  held --> released: release
  held --> released: expire
  held --> held: extend
```

A hold expires after holdTtlMinutes unless extended: while its payment is pending check, payments extends it (extendHold) up to pendingHoldMaxHours after it was made, so a slow bank answer never turns into INSUFFICIENT_CREDIT at capture. Captured credit returns only through creditRefund.

### Goodwill grant (`GoodwillGrant.state`)

```mermaid
stateDiagram-v2
  [*] --> pending_approval
  pending_approval --> granted: approve
  pending_approval --> rejected: reject
  granted --> reversed: reverse
```

Within the requester's goodwill limit the grant is approved immediately (pending_approval → granted in the same call). Above it, an access approval request is raised (e.g. Support limit $50, Finance $2,000). reverse removes unused credit only, with a reason.

### Gift card (`GiftCard.state`)

```mermaid
stateDiagram-v2
  [*] --> issued
  issued --> active: activate
  active --> redeemed: redeem
  issued --> voided: void
  active --> voided: void
  active --> expired: expire
```

Redeeming moves the full remaining value into a store credit lot (source gift_card). Expiry follows the law of the service region; default no expiry for sold cards.

## Data (schema `wallet`)

**accounts**

| Column | Type |
|---|---|
| customer_id | uuid pk |
| currency | text |
| available | bigint check >= 0 |
| held | bigint check >= 0 |
| updated_at | timestamptz |
| version | int |

**lots**: Credit in buckets with source and expiry; uses consume earliest-expiring first

| Column | Type |
|---|---|
| id | uuid pk |
| customer_id | uuid → accounts |
| source | text (refund|goodwill|price_adjustment|gift_card|correction) |
| original | bigint check > 0 |
| remaining | bigint check >= 0 |
| expires_at | timestamptz? |
| reference | text? |
| state | text (active|depleted|expired) |
| created_at | timestamptz |

Indexes: `(customer_id, state, expires_at)`, `(state, expires_at) where state = 'active'`

**ledger**: Append-only; balance is the sum of entries

| Column | Type |
|---|---|
| id | uuid pk |
| customer_id | uuid → accounts |
| kind | text |
| amount | bigint |
| balance_after | bigint |
| lot_allocations | jsonb |
| order_id | uuid? |
| refund_id | uuid? |
| case_id | uuid? |
| hold_id | uuid? |
| idempotency_key | text? |
| actor_kind | text |
| actor_id | text? |
| reason | text? |
| at | timestamptz |

Indexes: `(customer_id, at)`, `unique (idempotency_key)`, `unique (refund_id, kind) where refund_id is not null`, `(order_id) where order_id is not null`, `(hold_id) where hold_id is not null`

**holds**

| Column | Type |
|---|---|
| id | uuid pk |
| customer_id | uuid → accounts |
| quote_id | uuid |
| order_id | uuid? |
| amount | bigint check > 0 |
| state | text (held|captured|released) |
| expires_at | timestamptz |
| idempotency_key | text unique |

Indexes: `unique (quote_id) where state = 'held'`, `(state, expires_at)`, `(customer_id, state)`

**gift_card_batches**: Issued batches. The plain codes are kept only encrypted (secret-store key) until the issuer downloads them once or giftCardCodesTtlHours pass, then cleared; cards keep only code hashes

| Column | Type |
|---|---|
| id | uuid pk |
| count | int |
| amount | bigint |
| currency | text |
| purpose | text |
| expires_at | timestamptz? |
| reason | text |
| cost_center | text? |
| status | text (pending_approval|issued|rejected) |
| approval_request_id | uuid? |
| codes_ciphertext | text? |
| codes_file_id | uuid? (private media document, usage gift_card_codes, when media is enabled) |
| codes_delivered_at | timestamptz? |
| codes_expire_at | timestamptz? |
| created_by | text |
| idempotency_key | text unique |
| created_at | timestamptz |

Indexes: `(status, created_at)`, `(codes_expire_at) where codes_ciphertext is not null`

**goodwill_grants**

| Column | Type |
|---|---|
| id | uuid pk |
| customer_id | uuid |
| amount | bigint check > 0 |
| currency | text |
| reason | text |
| reason_code | text |
| case_id | uuid? |
| order_id | uuid? |
| charged_to | text |
| seller_id | uuid? |
| state | text (pending_approval|granted|rejected|reversed) |
| approval_request_id | uuid? |
| requested_by | text |
| decided_by | text? |
| ledger_entry_id | uuid? |
| idempotency_key | text unique |
| created_at | timestamptz |

Indexes: `(state, created_at)`, `(customer_id, created_at)`, `(approval_request_id) where approval_request_id is not null`, `(ledger_entry_id) where ledger_entry_id is not null`

**gift_cards**

| Column | Type |
|---|---|
| id | uuid pk |
| code_hash | text unique |
| code_last4 | text |
| batch_id | uuid? |
| initial | bigint check > 0 |
| remaining | bigint check >= 0 |
| currency | text |
| state | text (issued|active|redeemed|voided|expired) |
| purpose | text |
| expires_at | timestamptz? |
| redeemed_by | uuid? |
| redeemed_at | timestamptz? |
| created_by | text |
| created_at | timestamptz |

Indexes: `(batch_id, created_at)`, `(code_last4)`, `(state, expires_at)`

**credit_corrections**: Staff balance corrections. One within the caller's adjustment limit is applied at once (state applied); one above it is saved pending_approval with its access approval request and applied (or rejected, or failed when the credit is no longer there) on access.approval.decided

| Column | Type |
|---|---|
| id | uuid pk |
| customer_id | uuid |
| amount | bigint (signed) |
| currency | text |
| reason | text |
| reference | text? |
| state | text (pending_approval|applied|rejected|failed) |
| approval_request_id | uuid? |
| requested_by | text |
| decided_by | text? |
| decided_at | timestamptz? |
| ledger_entry_id | uuid? |
| failure | text? |
| idempotency_key | text unique |
| created_at | timestamptz |

Indexes: `(customer_id, state, created_at)`, `(approval_request_id) where approval_request_id is not null`

**loyalty_entries**: Phase 4 experiment: points earned and spent

| Column | Type |
|---|---|
| id | uuid pk |
| customer_id | uuid |
| points | int |
| kind | text |
| order_id | uuid? |
| at | timestamptz |

Indexes: `(customer_id, at)`

## Events

| Publishes | When | Payload | Consumed by |
|---|---|---|---|
| `wallet.credit.granted` | Credit is added (refund to credit, goodwill, price adjustment, gift card) | `{ customerId: uuid, entryId: uuid, kind: enum(refund_to_credit|order_refund_returned|goodwill|price_adjustment|gift_card_redeemed), amount: Money, chargedTo: enum(platform|seller)?, sellerId: uuid?, caseId: uuid?, orderId: uuid? }` | finance |
| `wallet.credit.used` | A hold is captured on an accepted order | `{ customerId: uuid, orderId: uuid, amount: Money }` | finance |
| `wallet.credit.expired` | A lot expires unused | `{ customerId: uuid, entryId: uuid, lotId: uuid, source: enum(refund|goodwill|price_adjustment|gift_card|correction), amount: Money }` | finance |
| `wallet.credit.expiring` | A lot with an unused balance reaches one of expiryReminderDays before it expires | `{ customerId: uuid, lotId: uuid, amount: Money, expiresAt: datetime, daysLeft: int }` | notifications |
| `wallet.credit.reversed` | A goodwill grant is reversed | `{ customerId: uuid, entryId: uuid, grantId: uuid, grantEntryId: uuid, amount: Money, chargedTo: enum(platform|seller), sellerId: uuid?, caseId: uuid?, orderId: uuid?, reason: text }` | finance |
| `wallet.credit.corrected` | Staff correct a balance | `{ customerId: uuid, entryId: uuid, amount: Money, reason: text }` | finance |
| `wallet.goodwill.decided` | A goodwill grant waiting for approval is granted or rejected | `{ grantId: uuid, customerId: uuid, status: enum(granted|rejected), amount: Money, caseId: uuid? }` | support |
| `wallet.gift_card.issued` | A gift card batch is issued | `{ batchId: uuid, count: int, total: Money, purpose: string }` | - |
| `wallet.gift_card.redeemed` | A gift card is added to store credit | `{ giftCardId: uuid, customerId: uuid, amount: Money }` | - |

| Consumes | From | Does |
|---|---|---|
| `orders.order.placed` | orders | Capture the quote's credit hold if payments has not already |
| `payments.payment.failed` | payments | Release the quote's credit hold |
| `access.approval.decided` | access | Grant or reject pending goodwill, corrections and gift card batches |
| `identity.user.registered` | identity | Create an empty wallet account lazily on first credit (no-op otherwise) |

## In-process API (for other modules)

| Function | Signature | Used by |
|---|---|---|
| getBalance | `(customerId: uuid) => CreditBalance`<br>Available balance and soonest expiry, for checkout step 4 'Use my Marketly credit'. | checkout, customers, graphql |
| holdCredit | `(customerId: uuid, quoteId: uuid, amount: Money, idempotencyKey: string) => CreditHold`<br>Reserve credit for a quote; earliest-expiring lots first. Fails with INSUFFICIENT_CREDIT. | checkout, payments |
| captureHold | `(holdId: uuid, orderId: uuid) => CreditHold`<br>Turn a hold into a use when the order is accepted. | payments, checkout |
| releaseHold | `(holdId: uuid) => CreditHold`<br>Release a hold on payment failure or quote expiry. | payments, checkout |
| extendHold | `(holdId: uuid, until: datetime) => CreditHold`<br>Keep a held credit hold alive while its payment is pending check (payments calls it from the status-check job until the result is known), so the hold does not expire into INSUFFICIENT_CREDIT at capture. Never shortens a hold; capped at pendingHoldMaxHours after the hold was made; a captured or released hold is returned unchanged. | payments, checkout |
| getLiabilityTotal | `(asOf?: datetime) => { available: Money, held: Money, accounts: int }`<br>Total store credit outstanding (available plus held) over all accounts, for finance's daily store_credit check against its liability | finance |
| creditRefund | `(input: { customerId: uuid, refundId: uuid, orderId: uuid, amount: Money, reason: string }, idempotencyKey: string) => LedgerEntry`<br>Refund to store credit (customer's choice) or return the credit part of a refunded order. Called by returns for return refunds to store credit and by payments for the refunds it executes (other origins with destination store_credit, and the credit part of a mixed tender). Idempotent per refundId; the payment tender split decides how much goes back to credit. | payments, returns |
| grantGoodwill | `(input: GoodwillInput, actor: Actor, idempotencyKey: string) => GoodwillGrant`<br>Goodwill credit from a support case or order; above the actor's limit it becomes pending approval. | support |
| getCustomerWallet | `(customerId: uuid) => CustomerWalletAdmin`<br>Staff view of a customer's credit: balance, lots, goodwill in the last 30 days against the per-customer limit, and pending grants (GET /admin/wallet/customers/{customerId}). | graphql |
| exportCustomerData | `(input: { customerId: uuid, accountId: uuid }) => CustomerDataSection[]`<br>Customer data export hook (FORMAT.md): the customer's store credit lots (source, amounts, expiry) and ledger entries (what was added, used, returned, expired, corrected) as plain records. Staff names and internal reasons are left out. Called by customers when it builds a data export | customers |

## Permissions

| Key | Who | Allows |
|---|---|---|
| `wallet.credit.view` | staff | View customer credit balances, ledgers and goodwill grants |
| `wallet.goodwill.grant` | staff | Grant goodwill credit within the approval limit |
| `wallet.credit.correct` | staff | Reverse goodwill and correct balances (Finance) |
| `wallet.gift_cards.manage` | staff | Issue, list and void gift cards |

## Approval actions

Checked through the access module (limits per role, second reviewer).

| Action | Limit | Second reviewer | Approvers | Meaning |
|---|---|---|---|---|
| `wallet.goodwill.grant` | money | above-limit | Support up to $50 (example); a Finance member whose limit covers it (e.g. Finance $2,000) above that | Grant goodwill store credit to a customer |
| `wallet.credit.correct` | money | above-limit | Within the caller's adjustment limit; a second Finance reviewer above it | Correct a customer's store credit balance |
| `wallet.gift-cards.issue` | money | above-limit | Within the caller's limit; Finance Manager above it | Issue a batch of gift cards (batch total) |

## Error codes

| Code | Status | Meaning |
|---|---|---|
| `INSUFFICIENT_CREDIT` | 409 | Available credit is lower than requested. |
| `GOODWILL_LIMIT_EXCEEDED` | 409 | The customer's 30-day goodwill limit would be exceeded. |
| `CREDIT_ALREADY_USED` | 409 | The credit was already used and cannot be reversed. |
| `GIFT_CARD_INVALID` | 422 | Unknown, voided, expired or already redeemed gift card. |
| `GIFT_CARD_CODES_UNAVAILABLE` | 410 | The batch's codes were already downloaded, have expired (giftCardCodesTtlHours) or the batch is not issued yet. Void the batch and issue a new one if the codes were lost. |

## Background jobs

| Job | Schedule | Does |
|---|---|---|
| `wallet.expire-lots` | daily 00:30 market time | Expire lots past expiresAt (wallet.credit.expired); publish wallet.credit.expiring for lots expiryReminderDays (30 and 7) days before expiry, once per lot and reminder |
| `wallet.release-stale-holds` | every 1 min | Release holds past expiresAt (an extended hold's expiresAt is the extended time); delete undelivered gift card codes past giftCardCodesTtlHours |
| `wallet.balance-check` | daily 05:00 market time | Verify every account balance equals the ledger sum; report each difference to Finance's daily check with finance.recordExternalDifference (check store_credit, key = customer id + date; expected = ledger sum, actual = balance) when finance is enabled, otherwise log it |

## Settings

| Key | Default | Rules | Meaning |
|---|---|---|---|
| creditExpiryMonths | `12` | duration, months, 1–…, approval: business owner | Default expiry of goodwill and price-adjustment credit (refund credit follows local rules; default none) |
| expiryReminderDays | `[30,7]` | json | Days before a lot expires when the customer is reminded (wallet.credit.expiring) |
| goodwillMaxPerCustomer30Days | `{"amount":10000,"currency":"USD"}` | money, 0–…, approval: business owner | Goodwill a customer can receive in 30 days before Finance approval is always needed |
| holdTtlMinutes | `30` | duration, minutes, 1–… | Checkout hold lifetime |
| pendingHoldMaxHours | `48` | duration, hours, 1–168 | Longest a hold can be extended while its payment is pending check (extendHold), counted from when it was made |
| giftCardCodesTtlHours | `24` | duration, hours, 1–168, approval: second reviewer | How long the issuer can download a batch's plain gift card codes before they are deleted |
| giftCardsEnabled | `false` | bool, approval: business owner | Gift cards are a later service |
| loyaltyEnabled | `false` | bool, approval: business owner | Loyalty experiment (phase 4) |

## Notes
- Phase 3 (plan ch. 15 'later services'; ch. 7 'Coupons, Credits when supported'). The store-credit part of account/coupons and the 'Use my Marketly credit' checkbox in checkout use this module when enabled.
- Money moves only through the ledger; every write is idempotent (refundId, Idempotency-Key) so a retry never credits twice.
- Store credit used at checkout is a payment tender: payments records the tender split, and a later refund returns the credit part through creditRefund before any card refund.
- Goodwill funded by a seller (e.g. late dispatch) is posted to seller earnings by finance from wallet.credit.granted with chargedTo=seller; platform goodwill is a company cost. Reversing a grant publishes wallet.credit.reversed with grantEntryId, chargedTo and sellerId so finance credits the seller back and reduces the liability; expiries and corrections carry their ledger entry id (entryId) for the same reason.
- Gift card codes: plain codes exist only at issue time. They are kept encrypted on the batch (gift_card_batches.codes_ciphertext) until the issuer downloads them once (GET /gift-cards/batches/{id}/codes) or giftCardCodesTtlHours pass; with media enabled they are also written as a private media document (usage gift_card_codes, owner the batch) returned as codesFileId. Nothing keeps codes in process memory.
- Balance differences: wallet.balance-check reports every account whose balance differs from its ledger sum to finance (recordExternalDifference, check store_credit); finance also compares its liability with getLiabilityTotal each day.
- Granting access is not financial authority: goodwill and corrections use approval limits from access, never the permission alone.
- dependsOn follows the architecture doc (customers, payments); access is optional only so the module can boot alone in tests — production requires it for limits.

## GraphQL (read layer)

This module's fragment of the GraphQL schemas (see [../graphql/README.md](../graphql/README.md)). Writes stay on the REST endpoints above.

```graphql
# wallet (phase 3): store credit balance, lots and ledger, and the staff view of a customer's credit.
# Holds, captures, refunds to credit, goodwill grants, corrections and gift cards stay on REST and the
# in-process API (idempotency, approval limits, audit).

"Soonest-expiring credit"
type WalletLotExpiry @areas(in: [STORE, ADMIN]) @phase(n: 3) {
  amount: Money!
  expiresAt: DateTime!
}

enum WalletLotSource @areas(in: [STORE, ADMIN]) {
  REFUND
  GOODWILL
  PRICE_ADJUSTMENT
  GIFT_CARD
  CORRECTION
}

"A credit lot; lots are used earliest-expiring first"
type WalletCreditLot @areas(in: [STORE, ADMIN]) @phase(n: 3) {
  id: UUID!
  source: WalletLotSource!
  original: Money!
  remaining: Money!
  expiresAt: DateTime
  createdAt: DateTime!
  "e.g. case CS-260903-1876"
  reference: String
}

enum WalletEntryKind @areas(in: [STORE, ADMIN]) {
  REFUND_TO_CREDIT
  GOODWILL
  PRICE_ADJUSTMENT
  GIFT_CARD_REDEEMED
  HOLD
  CAPTURE
  RELEASE
  ORDER_REFUND_RETURNED
  EXPIRY
  CORRECTION
  REVERSAL
}

"One line of the credit history"
type WalletLedgerEntry @areas(in: [STORE, ADMIN]) @phase(n: 3) {
  id: UUID!
  at: DateTime!
  kind: WalletEntryKind!
  "Signed: credits positive, uses negative"
  amount: Money!
  balanceAfter: Money!
  "e.g. Goodwill credit · case CS-260903-1876, late delivery; Used on order MK-260830-11764"
  label: String!
  orderRef: String
  caseRef: String
  "Staff who made the entry (admin only)"
  actor: Actor @areas(in: [ADMIN])
  "Internal reason (admin only)"
  reason: String @areas(in: [ADMIN])
}

"Store credit balance (Account overview tile, Coupons and credit, checkout)"
type WalletBalance @areas(in: [STORE, ADMIN]) @phase(n: 3) {
  available: Money!
  "Reserved for a checkout in progress"
  held: Money!
  nextExpiry: WalletLotExpiry
  "e.g. Any item from any seller; not on gift cards"
  usableOn: String!
  lots: [WalletCreditLot!]!
  "Latest credit history entries"
  recentEntries(limit: Int = 5): [WalletLedgerEntry!]!
}

enum WalletGoodwillState @areas(in: [ADMIN]) {
  PENDING_APPROVAL
  GRANTED
  REJECTED
  REVERSED
}

enum WalletChargedTo @areas(in: [ADMIN]) {
  PLATFORM
  SELLER
}

"A goodwill credit grant with its approval"
type WalletGoodwillGrant @areas(in: [ADMIN]) @phase(n: 3) {
  id: UUID!
  amount: Money!
  reason: String!
  reasonCode: String!
  caseRef: String
  orderRef: String
  chargedTo: WalletChargedTo!
  sellerId: UUID
  state: WalletGoodwillState!
  approval: ApprovalInfo
  requestedBy: Actor!
  decidedBy: Actor
  createdAt: DateTime!
  grantedAt: DateTime
}

"Customer 360 credit panel: balance, goodwill in the last 30 days against the limit, pending grants"
type WalletCustomerAdmin @areas(in: [ADMIN]) @phase(n: 3) {
  balance: WalletBalance!
  goodwillLast30Days: Money!
  goodwillLimitPerCustomer: Money!
  pendingGrants: [WalletGoodwillGrant!]!
}

# ------------------------------------------------------------------ fields on other modules' types

extend type Customer {
  "My store credit (Account overview tile)"
  wallet: WalletBalance @areas(in: [STORE]) @phase(n: 3) @source(module: "wallet", fn: "getBalance")
  "Staff view of this customer's credit (Admin customer 360)"
  walletAdmin: WalletCustomerAdmin @areas(in: [ADMIN]) @auth(requires: STAFF, permission: "wallet.credit.view") @phase(n: 3) @source(module: "wallet", fn: "getCustomerWallet")
}
```
