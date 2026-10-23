# Departments (`departments`)

The app's department pages opened from the home Departments rail: the Phones (standalone phones staff add), Blogs (topics, staff authors, posts, reactions, replies and reports), the Companies directory (industries, company pages, inquiries) and the Play center (games and ranking tables). Staff manage all of it in Admin › Departments.

- **Group:** Growth · **Launch phase:** 2 · **Plan chapters:** -
- **Depends on:** [media](media.md) · **Optional:** [search](search.md), [catalog](catalog.md), [customers](customers.md), [audit](audit.md), [promotions](promotions.md)

## Owns
- Phones: standalone phones staff add for the Phone tab (brand, name, overview, storage sizes with prices, colors, preview photos, full-size advertisement images, a grouped spec sheet), in order. No ordering: the page links to a store search
- Farm machines: machine types and the machines staff pick (catalog products, bought through cart and checkout) with their attachments
- Blogs: topics, author profiles, posts (sanitized rich text, cover, publish state), likes and dislikes, customer replies, reports and their review
- Companies: industries, company pages (logo, photos, description, contacts, map location, verified mark) and customer inquiries
- Play center: games (list only at this phase: no playing inside the app) and the ranking tables staff keep per game and period
- Blog saves, author follows and reply likes of customers
- Company and game reviews (1–5 stars, one per customer) and their moderation
- Play center scores: player IDs, per-game server keys for game partners, posted scores, rankings computed from them, prize weeks and the coupons won (promotions.issueCode)

**Not here:**
- Buying a phone: the Phone tab only shows information; Find in store opens the store search
- The Departments rail itself (titles, icons, destinations): content (homepage section kind departments)
- The carousel ads at the top of Companies and Play center: advertising (placements companies_top, play_top)
- Files: media (uploads with purpose content_image)

## Store API

| Method | Path | Purpose | Auth | Body → Response |
|---|---|---|---|---|
| GET | `/api/store/departments/phones` | The Phone tab: published phones as cards, in staff order | visitor | `PhonesPage` |
| GET | `/api/store/departments/phones/{slug}` | A phone page: Detail and Advertisements tabs | visitor | `Phone` |
| GET | `/api/store/departments/farm` | Farm machines: types and picked machines | visitor | `FarmPage` |
| GET | `/api/store/departments/farm/machines/{productId}` | A picked machine with its attachments | visitor | `FarmMachine` |
| GET | `/api/store/departments/blogs/topics` | Visible blog topics in order | visitor | `BlogTopic[]` |
| GET | `/api/store/departments/blogs/posts` | Published posts, newest first | visitor | Page<BlogPostCard> |
| GET | `/api/store/departments/blogs/posts/{slug}` | A published post with its body and the previous and next posts | visitor | `BlogPost` |
| POST | `/api/store/departments/blogs/posts/{id}/reaction` | Like, dislike or clear the reaction | customer | `{ reaction: enum(like|dislike|none) }` → `BlogReactionResult` |
| GET | `/api/store/departments/blogs/posts/{id}/replies` | Visible replies, oldest first | visitor | Page<BlogReply> |
| POST | `/api/store/departments/blogs/posts/{id}/replies` | Write a reply | customer | `{ text: string, parentId: uuid? }` → `BlogReply` |
| DELETE | `/api/store/departments/blogs/replies/{id}` | Delete my reply | customer | 204 No content |
| POST | `/api/store/departments/blogs/posts/{id}/save` | Save or unsave a post (bookmark) | customer | `{ saved: bool }` → `BlogSaveResult` |
| GET | `/api/store/departments/blogs/saved` | My saved posts, last saved first | customer | Page<BlogPostCard> |
| POST | `/api/store/departments/blogs/replies/{id}/like` | Like a reply or take the like back | customer | `{ liked: bool }` → `BlogReplyLikeResult` |
| POST | `/api/store/departments/blogs/authors/{id}/follow` | Follow or unfollow an author | customer | `{ following: bool }` → `BlogFollowResult` |
| GET | `/api/store/departments/blogs/following` | Authors I follow, last followed first | customer | Page<BlogAuthorCard> |
| GET | `/api/store/departments/blogs/authors/{slug}` | An author's profile | visitor | `BlogAuthor` |
| GET | `/api/store/departments/blogs/authors/{slug}/posts` | An author's published posts, newest first | visitor | Page<BlogPostCard> |
| POST | `/api/store/departments/blogs/reports` | Report a post, a reply or an author | customer | `BlogReportInput` → `{ id: uuid }` |
| GET | `/api/store/departments/industries` | Visible industries in order | visitor | `Industry[]` |
| GET | `/api/store/departments/companies` | Published companies in staff order | visitor | Page<CompanyCard> |
| GET | `/api/store/departments/companies/{slug}` | A company page | visitor | `Company` |
| GET | `/api/store/departments/companies/{slug}/reviews` | A company's visible reviews, newest first | visitor | Page<DeptReview> |
| POST | `/api/store/departments/companies/{slug}/reviews` | Rate a company, or change my review | customer | `ReviewInput` → `DeptReview` |
| POST | `/api/store/departments/companies/{id}/inquiries` | Send an inquiry to a company (staff pass it on) _(idempotent)_ | customer | `InquiryInput` → `InquiryReceipt` |
| GET | `/api/store/departments/play/games` | Published games in staff order, with their genres | visitor | `PlayGames` |
| GET | `/api/store/departments/play/games/{slug}` | A game's page | visitor | `Game` |
| GET | `/api/store/departments/play/games/{slug}/reviews` | A game's visible reviews, newest first | visitor | Page<DeptReview> |
| POST | `/api/store/departments/play/games/{slug}/reviews` | Rate a game, or change my review | customer | `ReviewInput` → `DeptReview` |
| GET | `/api/store/departments/play/player` | My player ID for game partners | customer | `PlayPlayer` |
| GET | `/api/store/departments/play/rankings` | A game's ranking table for a period | visitor | `RankingTable` |

## Admin API

| Method | Path | Purpose | Auth | Body → Response |
|---|---|---|---|---|
| GET | `/api/admin/departments/phones` | Every phone in staff order | staff<br>`departments.view` | `PhonesAdmin` |
| POST | `/api/admin/departments/phones` | Add a phone _(audited)_ | staff<br>`departments.phones.manage` | `PhoneInput` → `PhoneAdmin` |
| PUT | `/api/admin/departments/phones/order` | Change the order of the Phone tab _(audited)_ | staff<br>`departments.phones.manage` | `PhonesOrderInput` → `PhonesAdmin` |
| GET | `/api/admin/departments/phones/{id}` | A phone for editing | staff<br>`departments.view` | `PhoneAdmin` |
| PATCH | `/api/admin/departments/phones/{id}` | Edit, hide or show a phone _(audited)_ | staff<br>`departments.phones.manage` | `PhoneInput` → `PhoneAdmin` |
| DELETE | `/api/admin/departments/phones/{id}` | Delete a phone and release its photos _(audited)_ | staff<br>`departments.phones.manage` | 204 No content |
| GET | `/api/admin/departments/farm` | Farm machine types and picks | staff<br>`departments.view` | `FarmAdmin` |
| PUT | `/api/admin/departments/farm` | Replace the farm machine types and picks _(audited)_ | staff<br>`departments.farm.manage` | `FarmInput` → `FarmAdmin` |
| GET | `/api/admin/departments/blogs/topics` | Every blog topic | staff<br>`departments.view` | `BlogTopic[]` |
| POST | `/api/admin/departments/blogs/topics` | Add a topic _(audited)_ | staff<br>`departments.blogs.manage` | `BlogTopicInput` → `BlogTopic` |
| PATCH | `/api/admin/departments/blogs/topics/{id}` | Rename, reorder, hide or show a topic _(audited)_ | staff<br>`departments.blogs.manage` | `BlogTopicInput` → `BlogTopic` |
| DELETE | `/api/admin/departments/blogs/topics/{id}` | Delete a topic without posts _(audited)_ | staff<br>`departments.blogs.manage` | 204 No content |
| GET | `/api/admin/departments/blogs/authors` | Every author profile | staff<br>`departments.view` | `BlogAuthorAdmin[]` |
| POST | `/api/admin/departments/blogs/authors` | Add an author profile _(audited)_ | staff<br>`departments.blogs.manage` | `BlogAuthorInput` → `BlogAuthorAdmin` |
| PATCH | `/api/admin/departments/blogs/authors/{id}` | Edit an author profile _(audited)_ | staff<br>`departments.blogs.manage` | `BlogAuthorInput` → `BlogAuthorAdmin` |
| DELETE | `/api/admin/departments/blogs/authors/{id}` | Delete an author without posts _(audited)_ | staff<br>`departments.blogs.manage` | 204 No content |
| GET | `/api/admin/departments/blogs/posts` | Posts, newest change first | staff<br>`departments.view` | Page<BlogPostAdmin> |
| POST | `/api/admin/departments/blogs/posts` | Write a post _(audited)_ | staff<br>`departments.blogs.manage` | `BlogPostInput` → `BlogPostAdmin` |
| GET | `/api/admin/departments/blogs/posts/{id}` | A post for editing | staff<br>`departments.view` | `BlogPostAdmin` |
| PATCH | `/api/admin/departments/blogs/posts/{id}` | Edit, publish or unpublish a post _(audited)_ | staff<br>`departments.blogs.manage` | `BlogPostInput` → `BlogPostAdmin` |
| DELETE | `/api/admin/departments/blogs/posts/{id}` | Delete a post with its reactions, replies and reports _(audited)_ | staff<br>`departments.blogs.manage` | 204 No content |
| GET | `/api/admin/departments/blogs/replies` | Replies, newest first | staff<br>`departments.view` | Page<BlogReplyAdmin> |
| PATCH | `/api/admin/departments/blogs/replies/{id}` | Hide or show a reply _(audited)_ | staff<br>`departments.blogs.manage` | `{ status: enum(visible|hidden) }` → `BlogReplyAdmin` |
| GET | `/api/admin/departments/blogs/reports` | Reports, newest first | staff<br>`departments.view` | Page<BlogReportAdmin> |
| PATCH | `/api/admin/departments/blogs/reports/{id}` | Uphold or dismiss a report _(audited)_ | staff<br>`departments.blogs.manage` | `{ status: enum(upheld|dismissed) }` → `BlogReportAdmin` |
| GET | `/api/admin/departments/industries` | Every industry | staff<br>`departments.view` | `Industry[]` |
| POST | `/api/admin/departments/industries` | Add an industry _(audited)_ | staff<br>`departments.companies.manage` | `IndustryInput` → `Industry` |
| PATCH | `/api/admin/departments/industries/{id}` | Rename, reorder, hide or show an industry _(audited)_ | staff<br>`departments.companies.manage` | `IndustryInput` → `Industry` |
| DELETE | `/api/admin/departments/industries/{id}` | Delete an industry without companies _(audited)_ | staff<br>`departments.companies.manage` | 204 No content |
| GET | `/api/admin/departments/companies` | Companies in staff order | staff<br>`departments.view` | Page<CompanyAdmin> |
| POST | `/api/admin/departments/companies` | Add a company _(audited)_ | staff<br>`departments.companies.manage` | `CompanyInput` → `CompanyAdmin` |
| GET | `/api/admin/departments/companies/{id}` | A company for editing | staff<br>`departments.view` | `CompanyAdmin` |
| PATCH | `/api/admin/departments/companies/{id}` | Edit, hide or show a company _(audited)_ | staff<br>`departments.companies.manage` | `CompanyInput` → `CompanyAdmin` |
| DELETE | `/api/admin/departments/companies/{id}` | Delete a company with its inquiries _(audited)_ | staff<br>`departments.companies.manage` | 204 No content |
| GET | `/api/admin/departments/inquiries` | Inquiries, newest first | staff<br>`departments.view` | Page<InquiryAdmin> |
| PATCH | `/api/admin/departments/inquiries/{id}` | Mark an inquiry replied or closed, or note what was done _(audited)_ | staff<br>`departments.companies.manage` | `InquiryUpdate` → `InquiryAdmin` |
| GET | `/api/admin/departments/play/games` | Games in staff order | staff<br>`departments.view` | `GameAdmin[]` |
| POST | `/api/admin/departments/play/games` | Add a game _(audited)_ | staff<br>`departments.play.manage` | `GameInput` → `GameAdmin` |
| PATCH | `/api/admin/departments/play/games/{id}` | Edit, hide or show a game _(audited)_ | staff<br>`departments.play.manage` | `GameInput` → `GameAdmin` |
| DELETE | `/api/admin/departments/play/games/{id}` | Delete a game with its ranking tables _(audited)_ | staff<br>`departments.play.manage` | 204 No content |
| GET | `/api/admin/departments/play/games/{id}/rankings/{period}` | A game's ranking table for a period | staff<br>`departments.view` | `RankingTable` |
| PUT | `/api/admin/departments/play/games/{id}/rankings/{period}` | Replace a game's ranking table for a period _(audited)_ | staff<br>`departments.play.manage` | `RankingInput` → `RankingTable` |
| GET | `/api/admin/departments/play/games/{id}/keys` | A game's server keys, newest first (never the keys themselves) | staff<br>`departments.view` | `GameKey[]` |
| POST | `/api/admin/departments/play/games/{id}/keys` | Make a server key for the game's partner (shown once) _(audited)_ | staff<br>`departments.play.keys` | `GameKeySecret` |
| POST | `/api/admin/departments/play/games/{id}/keys/{keyId}/rotate` | Replace a key: the old one stops working now and a new one is shown once _(audited)_ | staff<br>`departments.play.keys` | `GameKeySecret` |
| POST | `/api/admin/departments/play/games/{id}/keys/{keyId}/revoke` | Stop a key from posting scores _(audited)_ | staff<br>`departments.play.keys` | `GameKey` |
| GET | `/api/admin/departments/play/games/{id}/awards` | Coupons a game's prize weeks gave, newest week first | staff<br>`departments.view` | Page<PrizeAward> |
| GET | `/api/admin/departments/play/players` | Find customers' player IDs (to help a game partner) | staff<br>`departments.view` | `PlayerLookup[]` |
| GET | `/api/admin/departments/reviews` | Company and game reviews, last changed first | staff<br>`departments.view` | Page<ReviewAdmin> |
| POST | `/api/admin/departments/reviews/{id}/moderate` | Hide or show a company or game review _(audited)_ | staff<br>`departments.reviews.manage` | `ReviewModeration` → `ReviewAdmin` |

## Webhooks

| Method | Path | Purpose | Auth | Body → Response |
|---|---|---|---|---|
| POST | `/webhooks/departments/play/scores` | A game partner's server posts a customer's score | provider | `ScoreInput` → `ScoreReceipt` |

## Types

### PhoneStorage

| Field | Type |
|---|---|
| size | `string` e.g. 256 GB |
| price | `Money` |
| was | `Money?` Shown crossed out with Save $200 when above price |

### PhoneColor

| Field | Type |
|---|---|
| name | `string` Full name for the title line, e.g. Titanium Gray |
| short | `string?` Under the swatch, e.g. Gray; null means name |
| hex | `string` Swatch color #RRGGBB |

### PhonePhoto

| Field | Type |
|---|---|
| id | `uuid` Media asset id |
| url | `url` Large rendition (1280 px wide at most, the photo's own ratio): the Photos tab |
| zoomUrl | `url` Zoom rendition (2048 px wide at most): the full-screen viewer |
| thumbUrl | `url?` Thumb rendition: gallery strip and admin grid |
| width | `int?` |
| height | `int?` |
| alt | `string?` Staff description, read by screen readers |

### PhoneSpecRow

| Field | Type |
|---|---|
| name | `string` e.g. Refresh rate |
| value | `string` e.g. 1–120 Hz |

### PhoneSpecGroup

| Field | Type |
|---|---|
| name | `string` e.g. Display |
| rows | `PhoneSpecRow[]` |

### PhoneCard

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| brand | `string` |
| name | `string` |
| meta | `string` First storage and first color, e.g. 256 GB · Titanium Gray |
| price | `Money` The first storage's price |
| was | `Money?` |
| dealPercent | `int?` Whole percent off the was price (the −15% badge); null without a deal |
| image | `MediaRef?` The cover photo (first), medium rendition |

### PhonesPage

| Field | Type |
|---|---|
| phones | `PhoneCard[]` Published phones in staff order |
| brands | `string[]` Brands of those phones, in first-seen order: the brand chips |

### Phone

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| brand | `string` |
| name | `string` |
| overview | `text?` Plain text; blank lines separate paragraphs |
| storage | `PhoneStorage[]` At least one; the first is selected when the page opens |
| colors | `PhoneColor[]` May be empty; the first is selected when the page opens |
| photos | `PhonePhoto[]` Preview photos: the Detail tab gallery, in staff order; the first is the cover |
| adImages | `PhonePhoto[]` Advertisement images for the Advertisements tab (not the gallery photos), full size in staff order; empty: the tab is not shown |
| specGroups | `PhoneSpecGroup[]` |
| showServices | `bool` Show the free OS install and post-sale card |
| searchTerm | `string` What Find in store searches for (staff term, else the name) |
| updatedAt | `datetime` |

### PhoneAdmin

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| brand | `string` |
| name | `string` |
| overview | `text?` |
| storage | `PhoneStorage[]` |
| colors | `PhoneColor[]` |
| photos | `PhonePhoto[]` |
| adImages | `PhonePhoto[]` |
| specGroups | `PhoneSpecGroup[]` |
| showServices | `bool` |
| searchTerm | `string?` Null: Find in store searches for the name |
| status | `enum(published|hidden)` |
| position | `int` 1-based place on the Phone tab |
| createdAt | `datetime` |
| updatedAt | `datetime` |
| updatedBy | `Actor?` |

### PhonesAdmin

| Field | Type |
|---|---|
| items | `PhoneAdmin[]` Every phone in staff order, hidden ones included |

### PhonePhotoInput

| Field | Type |
|---|---|
| id | `uuid` content_image upload, at least 1080 px wide |
| alt | `string?` |

### PhoneInput

| Field | Type |
|---|---|
| brand | `string` At most 40 characters |
| name | `string` At most 80 characters |
| slug | `string?` |
| overview | `text?` At most 1,000 characters |
| storage | `PhoneStorage[]` 1–8 sizes in order, each with a price above zero; was, when given, above price; one currency (the market's) |
| colors | `PhoneColor[]?` Up to 12, in order |
| photos | `PhonePhotoInput[]` 1–20 preview photos in order (the Detail tab gallery); the first is the cover |
| adImages | `PhonePhotoInput[]?` Up to 20 advertisement images in order (the Advertisements tab), content_image uploads at least 1080 px wide, none of them also a preview photo |
| specGroups | `PhoneSpecGroup[]?` Up to 20 groups of up to 30 rows; rows with an empty name or value are left out, then empty groups |
| showServices | `bool?` |
| searchTerm | `string?` At most 80 characters |
| status | `enum(published|hidden)?` |
| position | `int?` 1-based; new phones go last when not given |

### PhonesOrderInput

| Field | Type |
|---|---|
| ids | `uuid[]` Every phone id, in the new order |

### BlogTopic

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| name | `string` |
| position | `int` |
| visible | `bool` |
| postCount | `int` Published posts |

### BlogTopicInput

| Field | Type |
|---|---|
| name | `string` |
| slug | `string?` |
| position | `int?` |
| visible | `bool?` |

### BlogTopicRef

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| name | `string` |

### BlogAuthorCard

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| name | `string` |
| avatar | `MediaRef?` |

### BlogAuthor

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| name | `string` |
| avatar | `MediaRef?` |
| email | `email?` Public contact address the author chose to show |
| bio | `string?` |
| postCount | `int` Published posts |
| likeCount | `int` Likes on the published posts |
| reportCount | `int` Reports about the author and their posts that staff upheld |
| joinedAt | `datetime` |
| followerCount | `int` Customers following the author |
| following | `bool` The signed-in customer follows the author; false for visitors |

### BlogAuthorAdmin

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| name | `string` |
| avatar | `MediaRef?` |
| email | `email?` |
| bio | `string?` |
| postCount | `int` All posts, drafts included |
| likeCount | `int` |
| reportCount | `int` |
| followerCount | `int` |
| createdAt | `datetime` |
| updatedAt | `datetime` |

### BlogAuthorInput

| Field | Type |
|---|---|
| name | `string` |
| slug | `string?` |
| email | `email?` |
| avatar | `MediaRef?` |
| bio | `string?` |

### BlogPostCard

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| title | `string` |
| summary | `string?` |
| cover | `MediaRef?` |
| topic | `BlogTopicRef?` |
| author | `BlogAuthorCard` |
| publishedAt | `datetime` |
| readMinutes | `int` |
| likeCount | `int` |
| dislikeCount | `int` |
| replyCount | `int` |
| featured | `bool` Shown large at the top of the list |

### BlogPost

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| title | `string` |
| summary | `string?` |
| cover | `MediaRef?` |
| topic | `BlogTopicRef?` |
| author | `BlogAuthorCard` |
| publishedAt | `datetime` |
| readMinutes | `int` |
| likeCount | `int` |
| dislikeCount | `int` |
| replyCount | `int` |
| featured | `bool` |
| body | `text` Rich text as sanitized HTML (p, h2–h4, lists, links, tables, blockquote, strong/em) |
| myReaction | `enum(like|dislike)?` The signed-in customer's reaction; null for visitors |
| saved | `bool` The signed-in customer saved the post (bookmark); false for visitors |
| authorPostCount | `int` The author's published posts (the author card's 42 posts) |
| authorLikeCount | `int` Likes on the author's published posts |
| previous | `BlogPostCard?` The post published just before this one |
| next | `BlogPostCard?` The post published just after this one |

### BlogPostAdmin

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| title | `string` |
| summary | `string?` |
| cover | `MediaRef?` |
| body | `text` |
| topic | `BlogTopicRef?` |
| author | `BlogAuthorCard` |
| status | `enum(draft|published|unpublished)` |
| featured | `bool` |
| publishedAt | `datetime?` |
| readMinutes | `int` |
| likeCount | `int` |
| dislikeCount | `int` |
| replyCount | `int` |
| openReportCount | `int` |
| createdAt | `datetime` |
| updatedAt | `datetime` |

### BlogPostInput

| Field | Type |
|---|---|
| title | `string` At most 120 characters |
| slug | `string?` Made from the title when omitted |
| summary | `string?` At most 240 characters |
| body | `text` |
| cover | `MediaRef?` 16:9 picture (content_image upload) |
| topicId | `uuid?` |
| authorId | `uuid` |
| featured | `bool?` |
| status | `enum(draft|published|unpublished)?` Publishing sets publishedAt the first time |

### BlogReactionResult

| Field | Type |
|---|---|
| likeCount | `int` |
| dislikeCount | `int` |
| myReaction | `enum(like|dislike)?` |

### BlogReply

| Field | Type |
|---|---|
| id | `uuid` |
| postId | `uuid` |
| parentId | `uuid?` The reply this one answers (one level) |
| authorName | `string` The customer's first name and last initial |
| text | `string` |
| createdAt | `datetime` |
| mine | `bool` Written by the signed-in customer (they can delete it) |
| likeCount | `int` |
| liked | `bool` The signed-in customer liked the reply; false for visitors |

### BlogReplyAdmin

| Field | Type |
|---|---|
| id | `uuid` |
| postId | `uuid` |
| postTitle | `string` |
| parentId | `uuid?` |
| customerId | `uuid` |
| authorName | `string` |
| text | `string` |
| status | `enum(visible|hidden)` |
| openReportCount | `int` |
| likeCount | `int` |
| createdAt | `datetime` |

### BlogSaveResult

| Field | Type |
|---|---|
| saved | `bool` |

### BlogFollowResult

| Field | Type |
|---|---|
| following | `bool` |
| followerCount | `int` |

### BlogReplyLikeResult

| Field | Type |
|---|---|
| liked | `bool` |
| likeCount | `int` |

### BlogReportInput

| Field | Type |
|---|---|
| targetType | `enum(post|reply|author)` |
| targetId | `uuid` |
| reason | `enum(spam|offensive|misleading|other)` |
| note | `string?` |

### BlogReportAdmin

| Field | Type |
|---|---|
| id | `uuid` |
| targetType | `enum(post|reply|author)` |
| targetId | `uuid` |
| targetLabel | `string` Post title, the reply's first words or the author's name |
| reason | `enum(spam|offensive|misleading|other)` |
| note | `string?` |
| status | `enum(open|upheld|dismissed)` |
| reporterId | `uuid` |
| createdAt | `datetime` |
| decidedAt | `datetime?` |

### Industry

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| name | `string` |
| position | `int` |
| visible | `bool` |
| companyCount | `int` Published companies |

### IndustryInput

| Field | Type |
|---|---|
| name | `string` |
| slug | `string?` |
| position | `int?` |
| visible | `bool?` |

### IndustryRef

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| name | `string` |

### CompanyContacts

| Field | Type |
|---|---|
| phone | `string?` |
| email | `email?` |
| website | `url?` |
| address | `string?` |

### GeoPoint

| Field | Type |
|---|---|
| lat | `number` |
| lng | `number` |

### RatingSummary

| Field | Type |
|---|---|
| average | `number?` Average stars of the visible reviews, one decimal; null without reviews |
| count | `int` |
| stars | `int[]` Counts for 5, 4, 3, 2 and 1 stars |

### DeptReview

| Field | Type |
|---|---|
| id | `uuid` |
| name | `string` First name and last initial, e.g. Dana R. |
| stars | `int` |
| text | `string?` |
| date | `datetime` When it was written or last changed |
| mine | `bool` |
| hidden | `bool` Staff hid it (only ever true on the customer's own review: hidden reviews are not listed) |

### ReviewInput

| Field | Type |
|---|---|
| stars | `int` 1 to 5 |
| text | `string?` Up to 1,000 characters |

### ReviewTarget

| Field | Type |
|---|---|
| type | `enum(company|game)` |
| id | `uuid` |
| slug | `string` |
| name | `string` |

### ReviewAdmin

| Field | Type |
|---|---|
| id | `uuid` |
| target | `ReviewTarget` |
| name | `string` |
| customerId | `uuid` |
| stars | `int` |
| text | `string?` |
| hidden | `bool` |
| hiddenReason | `string?` |
| date | `datetime` |
| createdAt | `datetime` |

### ReviewModeration

| Field | Type |
|---|---|
| hidden | `bool` |
| reason | `string?` Why it is hidden (kept for staff; up to 300 characters) |

### CompanyCard

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| name | `string` |
| logo | `MediaRef?` |
| industry | `IndustryRef?` |
| city | `string?` |
| tagline | `string?` |
| verified | `bool` |
| rating | `number?` Average stars of the visible reviews (★ 4.8); null without reviews |
| ratingCount | `int` Visible reviews, the (312) next to the stars |

### Company

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| name | `string` |
| logo | `MediaRef?` |
| industry | `IndustryRef?` |
| city | `string?` |
| tagline | `string?` |
| verified | `bool` |
| rating | `number?` |
| ratingCount | `int` |
| ratingSummary | `RatingSummary` |
| myReview | `DeptReview?` The signed-in customer's review; null for visitors and customers who have not reviewed |
| description | `text?` Plain text; blank lines separate paragraphs |
| photos | `MediaRef[]` Carousel and gallery pictures in order (up to 12) |
| founded | `int?` Year |
| employees | `string?` e.g. 50–100 |
| contacts | `CompanyContacts` |
| location | `GeoPoint?` |

### CompanyAdmin

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| name | `string` |
| logo | `MediaRef?` |
| industry | `IndustryRef?` |
| city | `string?` |
| tagline | `string?` |
| verified | `bool` |
| description | `text?` |
| photos | `MediaRef[]` |
| founded | `int?` |
| employees | `string?` |
| contacts | `CompanyContacts` |
| location | `GeoPoint?` |
| rating | `number?` |
| ratingCount | `int` |
| hiddenReviewCount | `int` |
| status | `enum(published|hidden)` |
| position | `int` |
| openInquiryCount | `int` |
| createdAt | `datetime` |
| updatedAt | `datetime` |

### CompanyInput

| Field | Type |
|---|---|
| name | `string` |
| slug | `string?` |
| logo | `MediaRef?` |
| industryId | `uuid?` |
| city | `string?` |
| tagline | `string?` At most 120 characters |
| verified | `bool?` |
| description | `text?` |
| photos | `MediaRef[]?` |
| founded | `int?` |
| employees | `string?` |
| contacts | `CompanyContacts?` |
| location | `GeoPoint?` |
| status | `enum(published|hidden)?` |
| position | `int?` |

### InquiryInput

| Field | Type |
|---|---|
| name | `string` |
| email | `email` |
| phone | `string?` |
| message | `string` At most 2,000 characters |

### InquiryReceipt

| Field | Type |
|---|---|
| id | `uuid` |
| message | `string` e.g. Sent to Northwind Tools. They usually reply by email. |

### InquiryAdmin

| Field | Type |
|---|---|
| id | `uuid` |
| companyId | `uuid` |
| companyName | `string` |
| customerId | `uuid?` |
| name | `string` |
| email | `email` |
| phone | `string?` |
| message | `string` |
| status | `enum(new|replied|closed)` |
| staffNote | `string?` |
| createdAt | `datetime` |
| updatedAt | `datetime` |

### InquiryUpdate

| Field | Type |
|---|---|
| status | `enum(new|replied|closed)?` |
| staffNote | `string?` |

### GameCard

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| title | `string` |
| genre | `string` |
| icon | `MediaRef?` |
| cover | `MediaRef?` |
| playersLabel | `string?` e.g. 12k players this week |
| featured | `bool` |
| hasPrizes | `bool` Top ranks win coupons (shows the Win coupons badge) |
| rating | `number?` Average stars of the visible reviews (genre · ★ 4.6); null without reviews |
| ratingCount | `int` |

### GamePrize

| Field | Type |
|---|---|
| ranks | `string` e.g. #1 or #4–10 (made from fromRank and toRank when they are set) |
| reward | `string` e.g. $20 coupon |
| fromRank | `int?` First rank of the tier |
| toRank | `int?` Last rank of the tier |

### GamePrizeAdmin

| Field | Type |
|---|---|
| ranks | `string` |
| reward | `string` |
| fromRank | `int?` |
| toRank | `int?` |
| campaignId | `uuid?` The promotions coupon campaign whose codes the tier's winners get |
| campaignName | `string?` |
| campaignActive | `bool` The campaign can give codes now (running or scheduled to start) |

### GamePrizeInput

| Field | Type |
|---|---|
| ranks | `string?` Label such as #4–10; made from fromRank and toRank when omitted |
| reward | `string` e.g. $20 coupon |
| fromRank | `int?` 1–100; read from ranks (#1, #2–3) when omitted |
| toRank | `int?` |
| campaignId | `uuid?` A promotions coupon campaign; without one the tier is shown but nothing is issued |

### PrizeWeek

| Field | Type |
|---|---|
| startsOn | `date` Monday, market time |
| endsOn | `date` Sunday, market time |
| endsAt | `datetime` Midnight after Sunday, market time |
| endsLabel | `string` e.g. Ends Sun, Oct 25 |

### PlayerStats

| Field | Type |
|---|---|
| playerId | `string` The customer's player ID, e.g. MK-7F3K-92QD |
| best | `int?` Best score ever in this game; null before the first score |
| weekBest | `int?` Best score this prize week |
| weekRank | `int?` Rank in this week's table; null without a score this week |
| gamesPlayed | `int` Scores posted for the customer in this game |
| pointsToTop100 | `int?` Points this week's best needs to reach the top 100; null when already in it or without a score this week |

### Game

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| title | `string` |
| genre | `string` |
| icon | `MediaRef?` |
| cover | `MediaRef?` |
| playersLabel | `string?` |
| featured | `bool` |
| hasPrizes | `bool` |
| rating | `number?` |
| ratingCount | `int` |
| ratingSummary | `RatingSummary` |
| myReview | `DeptReview?` The signed-in customer's review; null for visitors and customers who have not reviewed |
| description | `text?` |
| howToPlay | `string[]` Short steps in order |
| prizes | `GamePrize[]` |
| prizeNote | `string?` Footnote under the rewards, e.g. Coupons land in Account › Coupons on Monday. Minimum order $30. |
| week | `PrizeWeek` This prize week (Monday–Sunday, market time) |
| scoresLive | `bool` Rankings come from the scores the game posts (else the table staff keep) |
| you | `PlayerStats?` The signed-in customer's best, this week's rank and games played; null for visitors |
| playable | `bool` False at this phase: the Play button says Coming soon |

### GameAdmin

| Field | Type |
|---|---|
| id | `uuid` |
| slug | `string` |
| title | `string` |
| genre | `string` |
| icon | `MediaRef?` |
| cover | `MediaRef?` |
| playersLabel | `string?` |
| featured | `bool` |
| description | `text?` |
| howToPlay | `string[]` |
| prizes | `GamePrizeAdmin[]` |
| prizeNote | `string?` |
| status | `enum(published|hidden)` |
| position | `int` |
| rankingsUpdatedAt | `datetime?` |
| rating | `number?` |
| ratingCount | `int` |
| scoresLive | `bool` |
| scoreCount | `int` Scores the game's server posted |
| activeKeyCount | `int` Server keys that can post scores |
| createdAt | `datetime` |
| updatedAt | `datetime` |

### GameInput

| Field | Type |
|---|---|
| title | `string` |
| slug | `string?` |
| genre | `string` |
| icon | `MediaRef?` |
| cover | `MediaRef?` |
| playersLabel | `string?` |
| featured | `bool?` |
| description | `text?` |
| howToPlay | `string[]?` |
| prizes | `GamePrizeInput[]?` |
| prizeNote | `string?` Up to 200 characters |
| status | `enum(published|hidden)?` |
| position | `int?` |

### PlayGames

| Field | Type |
|---|---|
| games | `GameCard[]` |
| genres | `string[]` Genres of the listed games, in first-seen order |

### RankingEntry

| Field | Type |
|---|---|
| rank | `int` |
| name | `string` |
| score | `int` |
| change | `int?` Places moved since the last update: positive up, negative down, 0 same, null new |
| mine | `bool?` The signed-in customer's row (posted scores only) |

### RankingYou

| Field | Type |
|---|---|
| rank | `int?` Null without a score in the period |
| score | `int?` |
| name | `string` |
| pointsToTop100 | `int?` e.g. 1,180 points to reach the top 100; null when already in it or without a score |

### RankingTable

| Field | Type |
|---|---|
| game | `GameCard` |
| period | `enum(today|week|all_time)` |
| entries | `RankingEntry[]` Best first (up to 100); with q, the matching players with their real ranks |
| updatedAt | `datetime?` |
| source | `enum(scores|staff)` scores: worked out from the scores the game posts (best score per player); staff: the table staff keep |
| playerCount | `int` Players in the period's table |
| week | `PrizeWeek` This prize week (week ends Sun, Oct 25) |
| you | `RankingYou?` The signed-in customer's place (posted scores only); null for visitors and staff-kept tables |

### PlayPlayer

| Field | Type |
|---|---|
| playerId | `string` Stable short code the customer copies into a game, e.g. MK-7F3K-92QD |
| name | `string` How rankings show the customer: first name and last initial |
| gamesPlayed | `int` Scores posted for the customer in every game |
| createdAt | `datetime` |

### PlayerLookup

| Field | Type |
|---|---|
| customerId | `uuid` |
| name | `string` |
| playerId | `string` |

### GameKey

| Field | Type |
|---|---|
| id | `uuid` |
| hint | `string` The key's last characters, e.g. …k3Qd |
| status | `enum(active|revoked)` |
| createdAt | `datetime` |
| lastUsedAt | `datetime?` |
| revokedAt | `datetime?` |

### GameKeySecret

| Field | Type |
|---|---|
| key | `GameKey` |
| secret | `string` The server key, shown this once (only its hash is kept). The game's server sends it in the X-Game-Key header |

### ScoreInput

| Field | Type |
|---|---|
| scoreId | `string` The partner's own id of this score (1–100 characters); the same id is recorded once |
| playerId | `string` The player ID the customer copied from the app |
| score | `int` 0 or more |
| playedAt | `datetime?` When the game ended; now when omitted. At most scoreMaxAgeMinutes old, at most 5 minutes ahead |

### ScoreReceipt

| Field | Type |
|---|---|
| id | `uuid` |
| scoreId | `string` |
| playerId | `string` |
| score | `int` |
| playedAt | `datetime` |
| duplicate | `bool` This scoreId was recorded before; nothing changed |
| best | `int` The player's best score in this game |
| weekRank | `int?` The player's rank in this week's table |

### PrizeAward

| Field | Type |
|---|---|
| id | `uuid` |
| gameId | `uuid` |
| week | `date` Monday of the prize week |
| customerId | `uuid` |
| name | `string` |
| rank | `int` |
| score | `int` |
| reward | `string` |
| campaignId | `uuid` |
| code | `string?` |
| state | `enum(issued|failed)` |
| error | `string?` Why the code could not be issued (tried again every hour) |
| at | `datetime` |

### RankingRowInput

| Field | Type |
|---|---|
| name | `string` |
| score | `int` |
| change | `int?` |

### RankingInput

| Field | Type |
|---|---|
| entries | `RankingRowInput[]` Up to 100 rows; ranks follow the score, best first |

### FarmType

| Field | Type |
|---|---|
| id | `string` |
| name | `string` e.g. Tractors |
| slug | `string` |

### FarmMachineCard

| Field | Type |
|---|---|
| product | `search.ProductCard` The machine (a catalog product sold through cart and checkout) |
| typeId | `string` |
| highlights | `string[]` Short spec lines, e.g. 25 hp · 4WD |

### FarmPage

| Field | Type |
|---|---|
| types | `FarmType[]` |
| machines | `FarmMachineCard[]` Picked machines in order; ones the store no longer shows are left out |

### FarmMachine

| Field | Type |
|---|---|
| product | `search.ProductCard` |
| typeId | `string` |
| highlights | `string[]` |
| attachments | `search.ProductCard[]` Attachments to add with the machine (catalog products) |

### FarmMachineInput

| Field | Type |
|---|---|
| productId | `uuid` |
| typeId | `string` |
| highlights | `string[]?` |
| attachmentIds | `uuid[]?` Up to 8 catalog products |

### FarmInput

| Field | Type |
|---|---|
| types | `FarmType[]` 1–12 types in order; ids are kept, new ones get one |
| machines | `FarmMachineInput[]` Up to 100 machines in order |

### FarmAdmin

| Field | Type |
|---|---|
| types | `FarmType[]` |
| machines | `FarmMachineInput[]` |
| products | `search.ProductCard[]` Cards of the picked machines and attachments the store still shows |
| updatedAt | `datetime?` |

## Data (schema `departments`)

**phone_picks**: Before standalone phones (2026-10-23): one row (id phones) with the picked product ids. The departments.import-phone-picks job turns them into phones once and then empties product_ids

| Column | Type |
|---|---|
| id | text pk |
| product_ids | jsonb |
| updated_by | text? |
| updated_at | timestamptz |

**phones**: The phones of the Phone tab, kept by staff (standalone: not catalog products, no ordering)

| Column | Type |
|---|---|
| id | uuid pk |
| slug | text unique |
| brand | text |
| name | text |
| overview | text? |
| storage | jsonb (PhoneStorage[]: size, price and was in minor units, currency) |
| colors | jsonb (PhoneColor[]) |
| photos | jsonb ({ id, alt }[]: preview photos) |
| ad_images | jsonb ({ id, alt }[]: advertisement images) |
| spec_groups | jsonb (PhoneSpecGroup[]) |
| show_services | bool |
| search_term | text? |
| status | text (published|hidden) |
| position | int |
| created_at | timestamptz |
| updated_at | timestamptz |
| updated_by | text? |

Indexes: `(status, position)`

**blog_topics**

| Column | Type |
|---|---|
| id | uuid pk |
| slug | text unique |
| name | text |
| position | int |
| visible | bool |

**blog_authors**

| Column | Type |
|---|---|
| id | uuid pk |
| slug | text unique |
| name | text |
| email | text? |
| avatar | jsonb? |
| bio | text? |
| created_at | timestamptz |
| updated_at | timestamptz |

**blog_posts**

| Column | Type |
|---|---|
| id | uuid pk |
| slug | text unique |
| title | text |
| summary | text? |
| body | mediumtext |
| cover | jsonb? |
| topic_id | uuid? → blog_topics |
| author_id | uuid → blog_authors |
| status | text |
| featured | bool |
| published_at | timestamptz? |
| read_minutes | int |
| like_count | int |
| dislike_count | int |
| reply_count | int |
| created_at | timestamptz |
| updated_at | timestamptz |

Indexes: `(status, published_at)`, `(topic_id, status, published_at)`, `(author_id, status, published_at)`

**blog_reactions**

| Column | Type |
|---|---|
| id | uuid pk |
| post_id | uuid → blog_posts cascade |
| customer_id | uuid |
| reaction | text |
| at | timestamptz |

Indexes: `unique (post_id, customer_id)`

**blog_replies**

| Column | Type |
|---|---|
| id | uuid pk |
| post_id | uuid → blog_posts cascade |
| parent_id | uuid? |
| customer_id | uuid |
| author_name | text |
| text | text |
| status | text |
| like_count | int (customers who liked it) |
| created_at | timestamptz |

Indexes: `(post_id, status, created_at)`, `(status, created_at)`

**blog_reports**

| Column | Type |
|---|---|
| id | uuid pk |
| target_type | text |
| target_id | uuid |
| reporter_id | uuid |
| reason | text |
| note | text? |
| status | text |
| created_at | timestamptz |
| decided_at | timestamptz? |
| decided_by | text? |

Indexes: `unique (target_type, target_id, reporter_id)`, `(status, created_at)`

**industries**

| Column | Type |
|---|---|
| id | uuid pk |
| slug | text unique |
| name | text |
| position | int |
| visible | bool |

**companies**

| Column | Type |
|---|---|
| id | uuid pk |
| slug | text unique |
| name | text |
| logo | jsonb? |
| industry_id | uuid? → industries |
| city | text? |
| tagline | text? |
| verified | bool |
| description | text? |
| photos | jsonb |
| founded | int? |
| employees | text? |
| contacts | jsonb |
| location | jsonb? |
| status | text |
| position | int |
| created_at | timestamptz |
| updated_at | timestamptz |

Indexes: `(status, position)`, `(industry_id, status, position)`

**inquiries**

| Column | Type |
|---|---|
| id | uuid pk |
| company_id | uuid → companies |
| customer_id | uuid? |
| name | text |
| email | text |
| phone | text? |
| message | text |
| status | text |
| staff_note | text? |
| created_at | timestamptz |
| updated_at | timestamptz |

Indexes: `(status, created_at)`, `(company_id, created_at)`

**games**

| Column | Type |
|---|---|
| id | uuid pk |
| slug | text unique |
| title | text |
| genre | text |
| icon | jsonb? |
| cover | jsonb? |
| players_label | text? |
| featured | bool |
| description | text? |
| how_to_play | jsonb |
| prizes | jsonb (tiers: ranks, reward, from_rank, to_rank, campaign_id) |
| prize_note | text? |
| status | text |
| position | int |
| created_at | timestamptz |
| updated_at | timestamptz |

Indexes: `(status, position)`

**rankings**: One row per game and period (today, week, all_time)

| Column | Type |
|---|---|
| id | uuid pk |
| game_id | uuid → games |
| period | text |
| entries | jsonb |
| updated_by | text? |
| updated_at | timestamptz |

Indexes: `unique (game_id, period)`

**blog_saves**: Posts a customer saved (bookmarks)

| Column | Type |
|---|---|
| id | uuid pk |
| post_id | uuid → blog_posts cascade |
| customer_id | uuid |
| saved_at | timestamptz |

Indexes: `unique (customer_id, post_id)`, `(customer_id, saved_at)`, `(post_id)`

**blog_follows**: Authors a customer follows

| Column | Type |
|---|---|
| id | uuid pk |
| author_id | uuid → blog_authors |
| customer_id | uuid |
| followed_at | timestamptz |

Indexes: `unique (author_id, customer_id)`, `(customer_id, followed_at)`

**blog_reply_likes**

| Column | Type |
|---|---|
| id | uuid pk |
| reply_id | uuid → blog_replies cascade |
| post_id | uuid → blog_posts cascade |
| customer_id | uuid |
| at | timestamptz |

Indexes: `unique (reply_id, customer_id)`, `(post_id, customer_id)`

**reviews**: Customer reviews of companies and games: one per customer and target, editable

| Column | Type |
|---|---|
| id | uuid pk |
| target_type | text (company|game) |
| target_id | uuid |
| customer_id | uuid |
| name | text (first name and last initial when written) |
| stars | int (1 to 5) |
| text | text? |
| hidden | bool |
| hidden_reason | text? |
| created_at | timestamptz |
| updated_at | timestamptz |

Indexes: `unique (target_type, target_id, customer_id)`, `(target_type, target_id, hidden, updated_at)`, `(hidden, updated_at)`

**players**: Play center player IDs: one stable short code per customer

| Column | Type |
|---|---|
| id | uuid pk |
| code | text unique (MK-XXXX-XXXX) |
| customer_id | uuid unique |
| name | text (first name and last initial, refreshed when the customer opens it) |
| created_at | timestamptz |
| updated_at | timestamptz |

**game_keys**: Server keys of game partners; only a SHA-256 hash of each key is kept

| Column | Type |
|---|---|
| id | uuid pk |
| game_id | uuid → games |
| key_hash | text unique |
| hint | text |
| status | text (active|revoked) |
| created_by | text? |
| created_at | timestamptz |
| last_used_at | timestamptz? |
| revoked_at | timestamptz? |
| revoked_by | text? |

Indexes: `(game_id, status)`

**scores**: Scores game servers posted; day and week are the market day and the Monday of its prize week

| Column | Type |
|---|---|
| id | uuid pk |
| game_id | uuid → games |
| partner_score_id | text |
| player_id | uuid → players |
| customer_id | uuid |
| score | int |
| played_at | timestamptz |
| day | date |
| week | date |
| received_at | timestamptz |

Indexes: `unique (game_id, partner_score_id)`, `(game_id, week, score)`, `(game_id, day, score)`, `(game_id, score)`, `(game_id, customer_id, played_at)`, `(customer_id)`

**prize_weeks**: Prize weeks whose winners were worked out: done once every winner has a code

| Column | Type |
|---|---|
| id | uuid pk |
| game_id | uuid → games |
| week | date |
| state | text (awarding|done) |
| winners | int |
| updated_at | timestamptz |

Indexes: `unique (game_id, week)`

**prize_awards**: One coupon per game, week and winner (promotions.issueCode, key play:<game>:<week>:<customer>)

| Column | Type |
|---|---|
| id | uuid pk |
| game_id | uuid → games |
| week | date |
| customer_id | uuid |
| name | text |
| rank | int |
| score | int |
| reward | text |
| campaign_id | uuid |
| code | text? |
| code_id | uuid? |
| state | text (issued|failed) |
| error | text? |
| created_at | timestamptz |
| updated_at | timestamptz |

Indexes: `unique (game_id, week, customer_id)`, `(game_id, week, rank)`, `(state, week)`

**farm_setup**: One row (id farm): machine types and the picked machines with their attachments

| Column | Type |
|---|---|
| id | text pk |
| types | jsonb |
| machines | jsonb |
| updated_by | text? |
| updated_at | timestamptz |

## Events

| Publishes | When | Payload | Consumed by |
|---|---|---|---|
| `departments.blog.followed_author_posted` | A post is published for the first time: one event per customer following its author | `{ customerId: uuid, postId: uuid, postSlug: string, postTitle: string, authorId: uuid, authorName: string }` | notifications |
| `departments.play.prize_awarded` | A prize week ended and a winner got their coupon code (once per game, week and winner) | `{ customerId: uuid, gameId: uuid, gameSlug: string, gameTitle: string, week: date, rank: int, reward: string, code: string, codeEndsAt: datetime? }` | notifications |

## In-process API (for other modules)

| Function | Signature | Used by |
|---|---|---|
| linkTargets | `(input: { kind: 'phone', q?: string, ids?: string[], slugs?: string[], limit?: int }) => LinkTarget[]`<br>Link targets for ad destination pickers (search by q, or resolve ids or URL slugs): phones of the Phones department (/phones/{slug}; available when published), each with its store path the app opens, a label, a short meta line, an image and whether it is shown in the store. Unknown ids are left out. | advertising |
| getFarmMachine | `(productId: uuid) => FarmMachine`<br>A picked farm machine with its attachments as product cards (prices and availability now), like GET /farm/machines/{productId}; NOT_FOUND when it isn't picked or the store no longer shows it. Farm orders price machines and attachments with it. | farm |
| exportCustomerData | `(input: { customerId: uuid, accountId: uuid }) => CustomerDataSection[]`<br>The customer's blog reactions, replies, reports, saved posts, followed authors and reply likes; company inquiries; company and game reviews; Play center player ID, scores and prize coupons, for the personal data export. Reactions, replies, reports and inquiries are kept by account id, the rest by customers-module id (both ids are looked up everywhere) | customers |

## Permissions

| Key | Who | Allows |
|---|---|---|
| `departments.view` | staff | See the department pages' content in Admin › Departments |
| `departments.phones.manage` | staff | Add, edit, order and delete the phones of the Phone tab |
| `departments.farm.manage` | staff | Farm machine types, picked machines and their attachments |
| `departments.blogs.manage` | staff | Blog topics, authors and posts; hide replies and decide reports |
| `departments.companies.manage` | staff | Industries and company pages; handle inquiries |
| `departments.play.manage` | staff | Play center games, prize tiers and ranking tables |
| `departments.play.keys` | staff | Make, rotate and revoke the server keys game partners post scores with |
| `departments.reviews.manage` | staff | Hide or show customers' company and game reviews |

## Error codes

| Code | Status | Meaning |
|---|---|---|
| `SLUG_TAKEN` | 409 | Another record already uses this slug. |
| `IN_USE` | 409 | Posts or companies still use it; move or delete them first. |
| `ALREADY_REPORTED` | 409 | You already reported this. |
| `REVIEWS_NOT_ALLOWED` | 403 | This account can't write reviews right now. |
| `TOO_MANY_KEYS` | 409 | The game already has two active server keys; revoke or rotate one. |
| `UNKNOWN_PLAYER` | 422 | No customer has this player ID. |
| `GAME_NOT_ACTIVE` | 409 | The game is hidden and takes no scores. |
| `SCORE_ID_REUSED` | 409 | This scoreId was already used for a different player or score. |
| `SCORE_TOO_OLD` | 422 | The score was played too long ago (or in the future) to count. |
| `REPLIES_CLOSED` | 409 | Replies are closed for now. |

## Background jobs

| Job | Schedule | Does |
|---|---|---|
| `departments.import-phone-picks` | on boot | Once: turns the products picked for the Phone tab before standalone phones (phone_picks, id phones) into phones, in the same order: brand and title, description as overview, storage sizes from the product variants' storage or capacity option (else one Standard row) with the price of its search card, color options (a grey swatch when the color name is unknown), the product images as photos (attached as content_block usages) and its specs as one Specifications group; then empties product_ids so it never runs again. A phone whose slug already exists counts as imported. Products catalog cannot read or search shows no price for are skipped and logged; while catalog or search is off the picks wait for a later start. |
| `departments.award-prize-weeks` | hourly | For every game with prize tiers linked to coupon campaigns, works out the winners of each prize week that ended at least scoreMaxAgeMinutes ago (the last 4 weeks), issues each winner's coupon with promotions.issueCode (key play:<game>:<week>:<customer>, so a retry gives the same code) and publishes departments.play.prize_awarded. Winners whose code could not be issued are tried again next hour. |

## Settings

| Key | Default | Rules | Meaning |
|---|---|---|---|
| blogRepliesOpen | `true` | bool | Customers can reply to blog posts |
| scoreMaxAgeMinutes | `60` | duration, minutes, 5–1440 | How old a posted score may be; a prize week is settled this long after it ends, so no late score can change it |

## Notes
- Phones are standalone records (2026-10-23 decision): staff add them in Admin › Departments › Phones with prices, options, a spec sheet, preview photos and advertisement images; there is no ordering. The app page has Detail and Advertisements tabs (2026-10-23: the second tab shows its own advertisement images, not the gallery photos) and a Find in store button that opens the store search for searchTerm.
- Department pages exist only in the app for now (2026-10-21 decision): the web store has no pages for these endpoints yet.
- Blog posts are written by staff under author profiles; customers react, reply and report (2026-10-21 decision). Replies are shown at once and hidden by staff when needed.
- Play center is list-only at this phase (2026-10-21 decision): games and the ranking tables staff keep. Game.playable is false: games are not played inside the app.
- Play center scores (2026-10-22 decision): a game partner's server posts scores to POST /webhooks/departments/play/scores with the game's server key (X-Game-Key; staff make, rotate and revoke keys, shown once, kept as SHA-256 hashes). The customer is named by their player ID (GET /play/player, a stable code like MK-7F3K-92QD). Rankings (today, this week, all time) are each player's best score in the period, ties going to whoever reached it first, names shown as first name and last initial. A game without posted scores keeps its staff-kept table.
- Prize weeks run Monday–Sunday in the market time zone. Each prize tier names its ranks and a promotions coupon campaign; the hourly departments.award-prize-weeks job settles a week scoreMaxAgeMinutes after it ends, gives each winner their own code (promotions.issueCode, idempotent per game, week and winner) and publishes departments.play.prize_awarded for the notification (coupons show in Account › Coupons).
- Blog saves, follows, reply likes, reviews and player IDs key customers by their customers-module id (the store principal's customerId, else the account id), as promotions and notifications do. Reactions, replies and reports keep the account id they always used.
- Company and game reviews: 1–5 stars and an optional text, one per customer and target, changed by posting again; the name is the customer's first name and last initial. Ratings count visible reviews only; staff hide or show reviews in Admin › Departments › Reviews.
- Bodies are sanitized HTML with the same allow-list as content's news and help (a copy of content domain rules sanitizeHtml, since modules don't import each other's files). Pictures are content_image uploads attached with media.attach to the record that shows them.
- Slugs are made from the name or title when omitted (lowercase words joined by -) and must be unique per table; a taken slug answers SLUG_TAKEN.
- A reply's authorName is the customer's first name and last initial when it was written (customers.getProfile), else Customer.
- Farm machines are ordered in farm orders (farm module, 2026-10-22 decision 3; it replaced the 2026-10-21 cart and checkout flow): the app quotes and places the machine with the chosen attachments there. Renting is left out of v1.
