# News for customers — design

Status: **built** (2026-10-18; backend, Admin Center, store, Android spec). Earlier: design. Owner decisions (2026-10-18): no customer notification on publish;
categories are staff-editable; a second person approves every post before it is published.

## 1. What it is

Short posts from Marketly to customers: announcements (new sellers or brands, new features), service updates
(holiday shipping cut-offs, support hours, delays), events (upcoming sales) and policy changes in plain words.
Staff write them in the Admin Center; customers read them in the store (website, phone layout, Android app).

Not in scope: comments, likes, per-customer targeting, email newsletters (those are notifications › broadcasts),
news for sellers (Seller Center), and paid placements (ads).

## 2. Where it lives in the backend

News is a new item type of the **content** module, next to campaign pages and help articles. It reuses what
content already has, so there is no new module to maintain:

| Reused from content | How news uses it |
|---|---|
| Publication state machine (draft → in review → approved → scheduled → published → unpublished → removed) | Same states and the same `transition` action endpoint as help articles |
| Versions (draft and live version, restore an old version as a new draft) | Editing a live post makes a draft; the live post stays until the draft is published |
| Review rule `content.reviewRequired` (setting) | New key `news`, default **true**: someone other than the writer approves before publishing (SAME_REVIEWER). It can be turned off in Settings like the other keys |
| Owner, schedule (publish at / remove at, time zone), audit entries, removal with reason | Same |
| Sanitized rich text (headings, lists, links, tables) | The post body |
| Media uploads, purpose `content_image` | Cover image and images in the body |
| Store link check (`/pages/…` → store routes) | Call-to-action links |

### Data (collections `content.news_posts` and `content.news_categories`, versions in `content.versions` with entity `news`)

| Field | Notes |
|---|---|
| id, slug | Slug from the title, unique; changing it later keeps the old slug as a redirect |
| title | ≤ 90 characters |
| summary | ≤ 200 characters; shown on cards and in link previews |
| categoryId | One staff-editable category (below); required |
| cover | Optional image, 16 : 9 (1200 × 675); without one the card shows a tinted category icon |
| body | Sanitized rich text |
| cta | Optional button: label + link (store path or https), e.g. "See the deals" → `/deals` |
| pinned | Pinned posts list first; at most 3 pinned (pinning a 4th unpins the oldest) |
| publishAt / removeAt | Scheduling; after removeAt the post leaves the list but its link still opens it, marked "Archived" |
| status, owner, versions, review | As other content items |

**Categories** (`content.news_categories`, staff-editable): id, name (≤ 30 characters, unique), slug, icon (from the
content icon list, shown when a post has no cover), position (order of the filter chips), visible, post count.
Seeded with Announcements, Service updates, Events, Policy changes. Rules:
- Hiding a category removes its chip from the store; its posts stay published and show under "All".
- A category can be deleted only when no post uses it (CONFLICT names the posts); otherwise move the posts first.
- Renaming changes the slug; the old slug keeps working as a filter link.
- Changes are audited (`content.news.category.create / update / reorder / delete`); no review step for categories.

## 3. API

Every endpoint needs a token (visitor token for the store), as all others.

### Store (`/api/store/content`, auth `visitor`)

| Endpoint | Returns |
|---|---|
| `GET /news?category&cursor&limit` | Published posts, pinned first, then newest; `category` is a category slug; cursor paging (the phone lazy-loads, the website pages) → `NewsCard` (id, slug, url `/news/{slug}`, title, summary, category {id, slug, name, icon}, cover, pinned, publishedAt) |
| `GET /news/categories` | Visible categories in order, each with its published post count (the filter chips; empty categories are left out) |
| `GET /news/{slug}` | One post → `NewsPost` (card fields + body, cta, updatedAt, version, archived, related: 3 newest other posts). 404 when not published; an old slug redirects |
| `GET /news/summary` | `{ latestPublishedAt, count }` — lets the store show a "new" dot without loading the list |

### Admin (`/api/admin/content`, auth `staff`)

| Endpoint | Permission |
|---|---|
| `GET /news?status&categoryId&q` (list), `GET /news/counts` (tab counts) | `content.view` |
| `POST /news` (draft), `GET /news/{id}`, `PATCH /news/{id}` | `content.news.manage` |
| `POST /news/{id}/preview` (`useDraft`; the desktop / phone frame is the browser's) | `content.view` |
| `POST /news/{id}/transition` (submit, approve, request changes, schedule, cancel schedule, publish, unpublish, remove, restore, discard draft) | manage; approve, request changes, schedule, publish, unpublish need `content.news.publish`; remove needs `content.pages.remove` |
| `POST /news/{id}/pin` (`pinned`) | `content.news.publish` |
| `GET /news/{id}/versions`, `POST /news/{id}/versions/{n}/restore` | manage |
| `GET /news-categories`, `POST /news-categories`, `PATCH /news-categories/{id}` (rename, icon, visible, `position` to reorder), `DELETE /news-categories/{id}` | list: `content.view`; changes: `content.news.manage` |

Events: `content.news.published` (id, slug, url, title, categoryId) and `content.news.unpublished` (for caches
and Action history; nothing notifies customers).
Audit: `content.news.create / update / publish / unpublish / remove / restore`.

### Permissions and roles

New: `content.news.manage`, `content.news.publish`. Content Manager gets both; Marketing Manager gets manage
(writes drafts and categories). With review on, the approver is any holder of `content.news.publish` other than
the draft's writer, so at least two people need publish rights (e.g. two Content Managers, or a Content Manager and
a Business Owner); Business Owner and Platform Admin: as for other content.

## 4. Admin Center

**Marketing and content › News** (new sidebar item between "Homepage and pages" and "Help and policies").

- **List**: tabs All · Drafts · In review · Scheduled · Published · Archived with counts; search; category filter.
  Rows: title, category badge, status, pinned, owner, publish date, last change. Rows open the editor.
- **Categories** (button "Manage categories" on the list → dialog): add, rename, choose icon, show/hide, drag to
  reorder, delete (only when unused; otherwise the dialog lists the posts to move).
- **Editor** (full page, like the campaign page editor): title, slug, category, summary with counter, cover upload
  with crop (16 : 9), body editor (same rich text tools as help articles), optional button (label + link, checked),
  pin switch, publish at / remove at with time zone.
  Side panel: live preview (desktop / phone), status and review, version history with restore.
- **Actions** (review on): the writer Saves the draft and Submits it for review; another person with publish
  rights Approves (or Requests changes with a reason); then Schedule or Publish now. Unpublish · Remove (reason
  required). Every action is in Action history.
- **Review waiting**: the list's "In review" tab (with its count) shows posts and drafts waiting for approval.
  Not built: a work-queue item or dashboard card for them (the work queues do not take content reviews yet, help
  articles included; it needs a content event and a workqueues intake rule).
- An approved post can be sent back (Request changes) or removed before it goes live; a live post's unpublished
  draft can be discarded (the live post stays). These two moves were added to the shared Content publication
  state machine, so help articles and pages get them too.

## 5. Store

### Website (tablet and desktop)

- **`/news`** — page title "News", category chips (All + the visible categories in staff order, e.g. Announcements ·
  Service updates · Events · Policy changes; `?category={slug}`),
  pinned posts as large cards on top, then a grid of cards (cover, category, date, title, summary). Numbered pages.
- **`/news/{slug}`** — breadcrumb News › title, category and date, cover, body, the optional button, "More news"
  (3 cards). An archived post shows a note "This news is archived" above the body.
- **Links in**: header navigation and footer get a "News" link (staff add it in Navigation; we seed it), and the
  homepage gets an optional **"Latest news" section** (new section kind `news`, 3 newest posts, "All news →").

### Phone layout and Android app

The phone has no header links or footer, and the Account tab needs sign-in, so news must be reachable from Home:

- The **"Latest news" section on Home** (horizontal row of cards, "All news →").
- **Account tab** menu item "News" (with the other info links), with a dot when there is news newer than the
  last one the customer opened (`GET /news/summary` vs. the last seen date kept on the device).
- `/news` lazy-loads (infinite scroll); `/news/{slug}` opens with the app bar back arrow. Deep links
  `https://<store host>/news` and `/news/{slug}` open the screens in the app.
- Android spec pages to add: `screens/info-news.md`, `screens/info-news-post.md`; update `store-home.md`
  (section kind `news`) and `account-overview.md` (menu item).

## 6. Telling customers about a post

Decided: **no notification**. Customers find posts on Home ("Latest news"), the News page and the "new" dot in
the Account tab. An in-app inbox notice (topic `customer.news`) can be added later without changing posts.

## 7. Edge cases

- Unpublishing removes the post from the list and the homepage section at once; its link answers 404
  (removed) or shows the archived note (past removeAt).
- Pinned + scheduled: the pin applies from publish time. A removed post loses its pin.
- Links in the body and the button go through the same link check as banners (no `javascript:`, store paths
  rewritten for the store routes).
- Time: dates shown in the market time zone (PT), like the rest of the store.
- Cache: the store list is cached briefly and cleared on publish / unpublish, like campaign pages.

## 8. Build plan (after the decisions)

1. Backend: spec (types, endpoints, permissions, events, setting key `reviewRequired.news`), `npm run gen`,
   service + store/admin handlers, categories, homepage section kind `news`, migration (seed categories,
   permissions to roles, navigation link, setting key), tests. Docs rebuilt.
2. Admin Center: News list + editor + categories dialog + sidebar item.
3. Store: `/news`, `/news/{slug}`, homepage section, navigation link, Account menu item with the dot.
4. Android spec pages.
