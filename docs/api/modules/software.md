# Softwares (`software`)

The app's Softwares department: apps for phones and PCs that customers download. Staff keep the categories, apps, files, packs and the home rails in Admin › Departments › Softwares. Free apps are owned on Get; paid apps and packs are bought with a card in their own payment flow (payments purchase intents, not cart and checkout), and owners download the files through signed links.

- **Group:** Growth · **Launch phase:** 2 · **Plan chapters:** -
- **Depends on:** [media](media.md), [payments](payments.md) · **Optional:** [customers](customers.md), [audit](audit.md), [notifications](notifications.md)

## Owns
- Software categories (Applications, AI, Games, Education, Business, …) with icons and order
- Apps: title, company, brief, icon, screenshots, descriptions, what you get, price and sale price, files (package and optional databases), version, what's new, version history, runtime platforms, minimum requirements, notice, permissions, status
- Packs: several apps sold together for one price
- Home rails of the Recommended tab (staff pick, newest, a category, a platform or top rated)
- Purchases (SW- references) and their payment status; entitlements (who owns which app); downloads and views counted per app
- Ratings and reviews from owners

**Not here:**
- Card payments: payments purchase intents (authorizePurchase, completeAction, capturePurchase)
- Files: media (software_package uploads, private; content_image for icons and screenshots); signed links come from media.signedDownload
- Companies: the departments module's Companies directory; an app keeps the company's name and, when linked, its id and slug
- Ads above the Recommended tab: advertising placement software_top

## Store API

| Method | Path | Purpose | Auth | Body → Response |
|---|---|---|---|---|
| GET | `/api/store/software/home` | The Recommended tab: rails and the pack deal | visitor | `SoftwareHome` |
| GET | `/api/store/software/categories` | Visible categories with their app counts | visitor | `SoftwareCategory[]` |
| GET | `/api/store/software/apps` | Published apps shown in the department | visitor | Page<AppCard> |
| GET | `/api/store/software/apps/{slug}` | An app with its files, versions, permissions and newest reviews | visitor | `SoftwareApp` |
| GET | `/api/store/software/deals` | Packs and apps on sale | visitor | `SoftwareDeals` |
| GET | `/api/store/software/apps/{slug}/reviews` | An app's reviews, newest first | visitor | Page<AppReview> |
| POST | `/api/store/software/apps/{slug}/reviews` | Rate an app you own, or change your rating | customer | `ReviewInput` → `AppReview` |
| POST | `/api/store/software/apps/{slug}/get` | Own a free app | customer | `Entitlement` |
| POST | `/api/store/software/apps/{slug}/downloads` | A signed link to download an owned app's package or a database | customer | `DownloadInput` → `media.DownloadLink` |
| GET | `/api/store/software/payment-options` | Saved cards and a new-card session for buying an app or a pack | customer | `payments.PaymentOptions` |
| POST | `/api/store/software/purchases` | Buy an app or a pack _(idempotent)_ | customer | `PurchaseInput` → `SoftwarePurchase` |
| GET | `/api/store/software/purchases/{id}` | A purchase and its payment status | customer | `SoftwarePurchase` |
| POST | `/api/store/software/purchases/{id}/complete-action` | Finish the bank challenge of a purchase _(idempotent)_ | customer | `CompleteActionInput` → `SoftwarePurchase` |
| POST | `/api/store/software/purchases/{id}/retry` | Pay a failed purchase again _(idempotent)_ | customer | `RetryPaymentInput` → `SoftwarePurchase` |
| GET | `/api/store/software/purchases` | My software purchases, newest first | customer | Page<SoftwarePurchase> |
| GET | `/api/store/software/library` | Apps I own, newest first | customer | Page<LibraryApp> |

## Admin API

| Method | Path | Purpose | Auth | Body → Response |
|---|---|---|---|---|
| GET | `/api/admin/software/categories` | All categories in order | staff<br>`software.view` | `SoftwareCategory[]` |
| POST | `/api/admin/software/categories` | Add a category _(audited)_ | staff<br>`software.manage` | `SoftwareCategoryInput` → `SoftwareCategory` |
| PATCH | `/api/admin/software/categories/{id}` | Rename, reorder, hide or show a category _(audited)_ | staff<br>`software.manage` | `SoftwareCategoryInput` → `SoftwareCategory` |
| DELETE | `/api/admin/software/categories/{id}` | Delete an empty category _(audited)_ | staff<br>`software.manage` | 204 No content |
| GET | `/api/admin/software/apps` | Apps with filters | staff<br>`software.view` | Page<AppAdminRow> |
| POST | `/api/admin/software/apps` | Add an app _(audited)_ | staff<br>`software.manage` | `AppInput` → `AppAdmin` |
| GET | `/api/admin/software/apps/{id}` | An app for editing | staff<br>`software.view` | `AppAdmin` |
| PATCH | `/api/admin/software/apps/{id}` | Change an app, its files, price or status _(audited)_ | staff<br>`software.manage` | `AppInput` → `AppAdmin` |
| DELETE | `/api/admin/software/apps/{id}` | Delete an app nobody owns _(audited)_ | staff<br>`software.manage` | 204 No content |
| GET | `/api/admin/software/packs` | Packs in order | staff<br>`software.view` | `PackAdmin[]` |
| POST | `/api/admin/software/packs` | Add a pack _(audited)_ | staff<br>`software.manage` | `PackInput` → `PackAdmin` |
| PATCH | `/api/admin/software/packs/{id}` | Change a pack _(audited)_ | staff<br>`software.manage` | `PackInput` → `PackAdmin` |
| DELETE | `/api/admin/software/packs/{id}` | Delete a pack that was never sold _(audited)_ | staff<br>`software.manage` | 204 No content |
| GET | `/api/admin/software/rails` | The Recommended tab's rails in order | staff<br>`software.view` | `RailAdmin[]` |
| PUT | `/api/admin/software/rails` | Replace the Recommended tab's rails _(audited)_ | staff<br>`software.manage` | `RailsInput` → `RailAdmin[]` |
| GET | `/api/admin/software/purchases` | Purchases, newest first | staff<br>`software.view` | Page<PurchaseAdmin> |
| POST | `/api/admin/software/entitlements` | Give a customer an app (support goodwill or a payment settled elsewhere) _(audited)_ | staff<br>`software.manage` | `GrantInput` → `Entitlement` |
| GET | `/api/admin/software/reviews` | Reviews, newest first | staff<br>`software.view` | Page<ReviewAdmin> |
| POST | `/api/admin/software/reviews/{id}/moderate` | Hide or show a review _(audited)_ | staff<br>`software.manage` | `ReviewModeration` → `ReviewAdmin` |

## Types

### SoftwareCategory

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| name | `string` |
| icon | `string?` Lucide icon name |
| position | `int` |
| visible | `bool` |
| appCount | `int` Published apps in the department |

### SoftwareCategoryInput

| Field | Type |
|---|---|
| name | `string` |
| slug | `string?` |
| icon | `string?` |
| position | `int?` |
| visible | `bool?` |

### CategoryRef

| Field | Type |
|---|---|
| slug | `string` |
| name | `string` |

### CompanyRef

| Field | Type |
|---|---|
| name | `string` |
| companyId | `uuid?` A Companies directory record (departments module) |
| companySlug | `string?` Opens /companies/{slug} in the app |

### AppPrice

| Field | Type |
|---|---|
| free | `bool` |
| amount | `Money?` Regular price; null when free |
| saleAmount | `Money?` Sale price while a sale runs |
| saleEndsAt | `datetime?` |
| current | `Money?` What the customer pays now (sale price during a sale); null when free |
| label | `string` Free, or the current price, e.g. $12.49 |
| wasLabel | `string?` Regular price during a sale, e.g. $24.99 |
| offPercent | `int?` Whole percent off during a sale, e.g. 50 |

### AppCard

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| title | `string` |
| company | `CompanyRef` |
| brief | `string` Up to 60 characters, shown in lists |
| icon | `MediaRef?` |
| category | `CategoryRef` |
| rating | `number?` Null without ratings |
| ratingCount | `int` |
| sizeBytes | `int` Package plus databases |
| sizeLabel | `string` e.g. 1.2 GB |
| price | `AppPrice` |
| platforms | `enum(android|ios|windows|macos|linux|web)[]` |
| owned | `bool` The signed-in customer owns it; false for visitors |

### AppFile

| Field | Type |
|---|---|
| id | `uuid` media asset id |
| kind | `enum(package|database)` |
| name | `string` File name |
| sizeBytes | `int` |
| sizeLabel | `string` |
| uploadedAt | `datetime?` |

### AppFiles

| Field | Type |
|---|---|
| package | `AppFile?` |
| databases | `AppFile[]` |
| databasesNote | `string?` e.g. Preset library and LUT packs, needed for offline use |

### AppPermission

| Field | Type |
|---|---|
| name | `string` e.g. Storage |
| desc | `string` e.g. Open and save photos on this device |

### VersionEntry

| Field | Type |
|---|---|
| version | `string` |
| date | `date` |
| notes | `string?` |

### RatingSummary

| Field | Type |
|---|---|
| average | `number?` Null without reviews |
| count | `int` |
| stars | `int[]` Counts for 5, 4, 3, 2 and 1 stars |

### AppReview

| Field | Type |
|---|---|
| id | `uuid` |
| name | `string` First name and last initial, e.g. Dana R. |
| stars | `int` |
| text | `string?` |
| date | `datetime` |
| mine | `bool` |

### ReviewInput

| Field | Type |
|---|---|
| stars | `int` 1 to 5 |
| text | `string?` Up to 1,000 characters |

### SoftwareApp

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| title | `string` |
| company | `CompanyRef` |
| brief | `string` |
| icon | `MediaRef?` |
| category | `CategoryRef` |
| subcategory | `string?` e.g. Photo editing |
| screenshots | `MediaRef[]` |
| description | `string` |
| moreDescription | `string?` |
| whatYouGet | `string[]` |
| price | `AppPrice` |
| licenceLabel | `string?` e.g. One-time purchase · 2 devices |
| version | `string?` |
| releasedAt | `date?` When the current version came out (Updated) |
| whatsNew | `string?` |
| versionHistory | `VersionEntry[]` Earlier versions, newest first |
| files | `AppFiles` Names and sizes only; downloads go through POST /apps/{slug}/downloads |
| sizeBytes | `int` |
| sizeLabel | `string` |
| platforms | `enum(android|ios|windows|macos|linux|web)[]` |
| platformLabels | `string[]` Runtime platforms with minimum versions, e.g. Windows 10+ |
| minRequirements | `string?` |
| notice | `string?` Shown in a highlighted box |
| permissions | `AppPermission[]` |
| views | `int` |
| downloads | `int` |
| ratings | `RatingSummary` |
| reviews | `AppReview[]` Newest three |
| allowReviews | `bool` |
| owned | `bool` |
| canReview | `bool` Owner who has not reviewed yet |
| myReview | `AppReview?` |

### PackApp

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| title | `string` |
| icon | `MediaRef?` |

### PackCard

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| name | `string` |
| apps | `PackApp[]` |
| count | `int` |
| price | `Money` |
| priceLabel | `string` |
| totalLabel | `string` The apps' regular prices added up, e.g. $99.97 |
| savePercent | `int` |
| licenceLabel | `string?` e.g. Lifetime licence |
| summary | `string?` e.g. Writer, Sheets and Slides Pro — 3 apps for $59.99 |
| owned | `bool` The customer owns every app in it |

### SoftwareRail

| Field | Type |
|---|---|
| key | `string` |
| title | `string` |
| source | `enum(manual|newest|category|platform|top_rated)` |
| style | `enum(carousel|list)` carousel: tiles side by side; list: rows |
| apps | `AppCard[]` |
| seeAll | `string?` Query string for GET /apps, e.g. category=games or rail=recommended; null hides See all |

### SoftwareHome

| Field | Type |
|---|---|
| rails | `SoftwareRail[]` |
| featuredPack | `PackCard?` The first visible pack, shown as the pack deal card |

### SoftwareDeals

| Field | Type |
|---|---|
| packs | `PackCard[]` |
| discounts | `AppCard[]` Apps on sale now, biggest discount first |
| discountsUntilLabel | `string?` e.g. Prices valid until Oct 31 (the latest sale end) |

### PurchaseItem

| Field | Type |
|---|---|
| appId | `uuid` |
| slug | `string` |
| title | `string` |
| icon | `MediaRef?` |

### SoftwarePurchase

| Field | Type |
|---|---|
| id | `uuid` |
| ref | `string` e.g. SW-4K7Q2 |
| status | `enum(pending_payment|requires_action|paid|failed|cancelled)` pending_payment also covers a payment the bank is still checking |
| statusLabel | `string` |
| title | `string` The app or pack name |
| packId | `uuid?` |
| items | `PurchaseItem[]` |
| amount | `Money` |
| payment | `payments.PurchasePaymentStatus?` |
| createdAt | `datetime` |
| paidAt | `datetime?` |

### PurchaseInput

| Field | Type |
|---|---|
| appId | `uuid?` Exactly one of appId and packId |
| packId | `uuid?` |
| expectedAmount | `Money` The price the customer saw; PRICE_CHANGED when it differs |
| method | `payments.MethodSelection` |
| returnUrl | `url` |

### RetryPaymentInput

| Field | Type |
|---|---|
| method | `payments.MethodSelection` |
| returnUrl | `url` |

### CompleteActionInput

| Field | Type |
|---|---|
| resultToken | `string` |

### DownloadInput

| Field | Type |
|---|---|
| fileId | `uuid?` A database file; the package when absent |

### Entitlement

| Field | Type |
|---|---|
| appId | `uuid` |
| slug | `string` |
| title | `string` |
| source | `enum(free|purchase|pack|staff)` |
| ownedAt | `datetime` |

### LibraryApp

| Field | Type |
|---|---|
| app | `AppCard` |
| source | `enum(free|purchase|pack|staff)` |
| ownedAt | `datetime` |

### AppAdminRow

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| title | `string` |
| company | `CompanyRef` |
| icon | `MediaRef?` |
| category | `CategoryRef` |
| price | `AppPrice` |
| sizeLabel | `string` |
| platforms | `enum(android|ios|windows|macos|linux|web)[]` |
| rating | `number?` |
| ratingCount | `int` |
| downloads | `int` |
| views | `int` |
| version | `string?` |
| status | `enum(draft|in_review|published|hidden)` |
| updatedAt | `datetime` |

### AppAdmin

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| title | `string` |
| company | `CompanyRef` |
| categoryId | `uuid` |
| subcategory | `string?` |
| brief | `string` |
| icon | `MediaRef?` |
| screenshots | `MediaRef[]` |
| description | `string` |
| moreDescription | `string?` |
| whatYouGet | `string[]` |
| price | `AppPrice` |
| licenceLabel | `string?` |
| files | `AppFiles` |
| sizeBytes | `int` |
| sizeLabel | `string` |
| version | `string?` |
| releasedAt | `date?` |
| whatsNew | `string?` |
| versionHistory | `VersionEntry[]` |
| platforms | `enum(android|ios|windows|macos|linux|web)[]` |
| platformLabels | `string[]` |
| minRequirements | `string?` |
| notice | `string?` |
| permissions | `AppPermission[]` |
| status | `enum(draft|in_review|published|hidden)` |
| showInDepartment | `bool` Listed in rails, categories and search; a hidden-from-department app still opens by link |
| allowReviews | `bool` |
| position | `int` |
| views | `int` |
| downloads | `int` |
| owners | `int` |
| ratings | `RatingSummary` |
| updatedAt | `datetime` |
| updatedBy | `string?` Staff name |

### AppInput

| Field | Type |
|---|---|
| title | `string` |
| slug | `string?` |
| company | `CompanyRef` |
| categoryId | `uuid` |
| subcategory | `string?` |
| brief | `string` Up to 60 characters |
| iconId | `uuid?` content_image upload, square, at least 512 × 512 |
| screenshotIds | `uuid[]?` Up to 10 content_image uploads, in order |
| description | `string` |
| moreDescription | `string?` |
| whatYouGet | `string[]?` |
| free | `bool` |
| price | `Money?` Required when not free |
| salePrice | `Money?` Below price |
| saleEndsAt | `datetime?` Required with salePrice |
| licenceLabel | `string?` |
| packageId | `uuid?` software_package upload; needed to publish |
| databaseIds | `uuid[]?` software_package uploads |
| databasesNote | `string?` |
| version | `string?` |
| releasedAt | `date?` |
| whatsNew | `string?` |
| versionHistory | `VersionEntry[]?` |
| platforms | `enum(android|ios|windows|macos|linux|web)[]` |
| platformLabels | `string[]?` |
| minRequirements | `string?` |
| notice | `string?` |
| permissions | `AppPermission[]?` |
| status | `enum(draft|in_review|published|hidden)?` |
| showInDepartment | `bool?` |
| allowReviews | `bool?` |
| position | `int?` |

### PackAdmin

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| name | `string` |
| summary | `string?` |
| apps | `PackApp[]` |
| price | `Money` |
| totalLabel | `string` |
| savePercent | `int` |
| licenceLabel | `string?` |
| visible | `bool` |
| position | `int` |
| sold | `int` |
| updatedAt | `datetime` |

### PackInput

| Field | Type |
|---|---|
| name | `string` |
| slug | `string?` |
| summary | `string?` |
| appIds | `uuid[]` Two or more paid apps |
| price | `Money` |
| licenceLabel | `string?` |
| visible | `bool?` |
| position | `int?` |

### RailAdmin

| Field | Type |
|---|---|
| key | `string` |
| title | `string` |
| source | `enum(manual|newest|category|platform|top_rated)` |
| style | `enum(carousel|list)` |
| categoryId | `uuid?` |
| platform | `enum(android|ios|windows|macos|linux|web)?` |
| appIds | `uuid[]` manual rails: the apps in order |
| limit | `int` Apps shown, 3 to 20 |
| visible | `bool` |

### RailsInput

| Field | Type |
|---|---|
| rails | `RailAdmin[]` |

### PurchaseAdmin

| Field | Type |
|---|---|
| id | `uuid` |
| ref | `string` |
| status | `enum(pending_payment|requires_action|paid|failed|cancelled)` |
| title | `string` |
| packId | `uuid?` |
| items | `PurchaseItem[]` |
| amount | `Money` |
| customer | `{"id":"uuid","name":"string?","email":"email?"}` |
| methodLabel | `string?` |
| intentId | `uuid?` |
| declineMessage | `string?` |
| createdAt | `datetime` |
| paidAt | `datetime?` |

### ReviewAdmin

| Field | Type |
|---|---|
| id | `uuid` |
| app | `PackApp` |
| name | `string` |
| customerId | `uuid` |
| stars | `int` |
| text | `string?` |
| hidden | `bool` |
| date | `datetime` |

### ReviewModeration

| Field | Type |
|---|---|
| hidden | `bool` |
| reason | `string?` |

### GrantInput

| Field | Type |
|---|---|
| customerId | `uuid` |
| appId | `uuid` |
| reason | `string` |

## Status flows

### Software purchase (`SoftwarePurchase.status`)

```mermaid
stateDiagram-v2
  [*] --> pending_payment
  pending_payment --> requires_action: challenge
  pending_payment --> paid: pay
  pending_payment --> failed: fail
  requires_action --> paid: pay
  requires_action --> failed: fail
  requires_action --> cancelled: abandon
  failed --> pending_payment: retry
  failed --> cancelled: abandon
```

pay: the card is authorized and the purchase captures it at once (payments.capturePurchase), then grants the entitlements. A pending check stays pending_payment until payments.purchase.authorized or payments.purchase.failed. requires_action purchases older than 30 minutes are abandoned (the intent is voided).

## Data (schema `software`)

**categories**

| Column | Type |
|---|---|
| id | uuid pk |
| slug | text unique |
| name | text |
| icon | text? |
| position | int |
| visible | bool |
| created_at | timestamptz |
| updated_at | timestamptz |

Indexes: `(position)`

**apps**

| Column | Type |
|---|---|
| id | uuid pk |
| slug | text unique |
| title | text |
| company | jsonb (CompanyRef) |
| category_id | uuid → categories |
| subcategory | text? |
| brief | text |
| icon_id | uuid? |
| screenshot_ids | jsonb |
| description | text |
| more_description | text? |
| what_you_get | jsonb |
| free | bool |
| price | bigint? |
| sale_price | bigint? |
| sale_ends_at | timestamptz? |
| currency | text |
| licence_label | text? |
| package | jsonb? (AppFile) |
| databases | jsonb (AppFile[]) |
| databases_note | text? |
| size_bytes | bigint |
| version | text? |
| released_at | date? |
| whats_new | text? |
| version_history | jsonb |
| platforms | text[] |
| platform_labels | jsonb |
| min_requirements | text? |
| notice | text? |
| permissions | jsonb |
| status | text (draft|in_review|published|hidden) |
| show_in_department | bool |
| allow_reviews | bool |
| position | int |
| views | bigint |
| downloads | bigint |
| owners | int |
| rating_sum | int |
| rating_count | int |
| rating_stars | jsonb |
| search_text | text |
| created_at | timestamptz |
| updated_at | timestamptz |
| updated_by | text? |

Indexes: `(status, show_in_department, category_id, position)`, `(status, released_at)`, `(status, sale_ends_at)`, `(status, rating_count)`

**packs**

| Column | Type |
|---|---|
| id | uuid pk |
| slug | text unique |
| name | text |
| summary | text? |
| app_ids | jsonb |
| price | bigint |
| currency | text |
| licence_label | text? |
| visible | bool |
| position | int |
| sold | int |
| created_at | timestamptz |
| updated_at | timestamptz |

Indexes: `(visible, position)`

**rails**: The Recommended tab's rails, one row per rail

| Column | Type |
|---|---|
| key | text pk |
| title | text |
| source | text |
| style | text |
| category_id | uuid? |
| platform | text? |
| app_ids | jsonb |
| limit | int |
| visible | bool |
| position | int |
| updated_at | timestamptz |

Indexes: `(position)`

**purchases**

| Column | Type |
|---|---|
| id | uuid pk |
| ref | text unique |
| customer_id | uuid |
| app_id | uuid? |
| pack_id | uuid? |
| title | text |
| items | jsonb (PurchaseItem[]) |
| amount | bigint |
| currency | text |
| status | text (pending_payment|requires_action|paid|failed|cancelled) |
| intent_id | uuid? |
| attempts | int |
| method_label | text? |
| decline_message | text? |
| idempotency_key | text unique |
| created_at | timestamptz |
| updated_at | timestamptz |
| paid_at | timestamptz? |

Indexes: `(customer_id, created_at)`, `(status, created_at)`, `(intent_id)`

**entitlements**

| Column | Type |
|---|---|
| id | uuid pk |
| customer_id | uuid |
| app_id | uuid → apps |
| source | text (free|purchase|pack|staff) |
| purchase_id | uuid? |
| granted_by | text? |
| created_at | timestamptz |

Indexes: `unique (customer_id, app_id)`, `(app_id)`

**reviews**

| Column | Type |
|---|---|
| id | uuid pk |
| app_id | uuid → apps |
| customer_id | uuid |
| name | text |
| stars | int |
| text | text? |
| hidden | bool |
| hidden_reason | text? |
| created_at | timestamptz |
| updated_at | timestamptz |

Indexes: `unique (app_id, customer_id)`, `(app_id, hidden, created_at)`

## Events

| Publishes | When | Payload | Consumed by |
|---|---|---|---|
| `software.purchase.paid` | A purchase is paid and its apps are owned | `{ purchaseId: uuid, ref: string, customerId: uuid, title: string, amount: Money, appIds: uuid[] }` | notifications |
| `software.purchase.failed` | A purchase's payment fails | `{ purchaseId: uuid, ref: string, customerId: uuid, title: string }` | - |

| Consumes | From | Does |
|---|---|---|
| `payments.purchase.authorized` | payments | module software: capture and mark the purchase paid (a payment that was pending or finished its bank challenge outside the app) |
| `payments.purchase.failed` | payments | module software: mark the purchase failed |

## In-process API (for other modules)

| Function | Signature | Used by |
|---|---|---|
| exportCustomerData | `(input: { customerId: uuid, accountId: uuid }) => CustomerDataSection[]`<br>The customer's software purchases (reference, apps, amount, status, dates), owned apps and reviews for the personal data export | customers |

## Permissions

| Key | Who | Allows |
|---|---|---|
| `software.view` | staff | See apps, packs, purchases and reviews in Admin › Departments › Softwares |
| `software.manage` | staff | Categories, apps and their files, packs, rails, hide reviews, give an app to a customer |

## Error codes

| Code | Status | Meaning |
|---|---|---|
| `SLUG_TAKEN` | 409 | Another record already uses this slug. |
| `IN_USE` | 409 | Apps, packs or purchases still use it. |
| `NOT_OWNED` | 403 | Get or buy the app first. |
| `NOT_FREE` | 409 | This app is paid; buy it instead. |
| `NOT_FOR_SALE` | 409 | This app or pack can't be bought right now. |
| `ALREADY_OWNED` | 409 | You already own this app (or every app in the pack). |
| `PRICE_CHANGED` | 409 | The price changed; details.amount is the new price. |
| `REVIEWS_OFF` | 409 | Reviews are turned off for this app. |
| `FILE_MISSING` | 404 | That file isn't available yet. |
| `FILE_NOT_READY` | 409 | An uploaded file isn't ready or has the wrong purpose. |

## Background jobs

| Job | Schedule | Does |
|---|---|---|
| `software.abandon-stale` | every 10 min | Cancel purchases left in requires_action for 30 minutes and void their intents |

## Notes
- 2026-10-22 (user): software gets its own payment flow, not cart and checkout. The card is charged at once (authorize, then capture) and the apps are owned immediately; refunds are handled outside the app for now.
- Prices: an app is free or has a price; a sale price applies until saleEndsAt and shows in Deals. A pack's price is fixed by staff; totalLabel adds up its apps' regular prices and savePercent compares the two. A pack buyer who already owns some of its apps still pays the pack price (ALREADY_OWNED only when they own all).
- Purchase refs are SW- plus five characters from 23456789ABCDEFGHJKLMNPQRSTUVWXYZ.
- Size: package plus databases, from the media assets' sizes. Labels use 1,000-based units (MB, GB) with one decimal above 1 GB.
- Rails: manual (the staff's apps in order), newest (releasedAt), category, platform (e.g. windows and macos for PC apps) and top_rated (ratings with at least 3 reviews). Default rails: Recommended for you (manual, carousel), New apps (newest, list), Games (category games, carousel), Browsers (category browsers, list), PC apps (platform windows, carousel).
- The reviewer's name is their first name and last initial (customers.getCustomer), else Customer. Ratings count only visible reviews.
- Customers are customers-module ids (the store principal's customerId), as payments and promotions use.
