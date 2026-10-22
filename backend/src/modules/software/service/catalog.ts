/**
 * What staff keep and customers browse: categories, apps (with their pictures and files), packs, the Recommended
 * tab's rails, deals and ratings. The catalog is small (a market's apps), so lists are read whole, filtered and
 * sorted here, and paged with pageOf.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import { isIsoDate } from '../../../kernel/lib/dates.js';
import { newId } from '../../../kernel/lib/ids.js';
import { pageOf, type Page, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type {
  AppAdmin,
  AppAdminRow,
  AppCard,
  AppFiles,
  AppInput,
  AppPermission,
  AppReview,
  CategoryRef,
  CompanyRef,
  PackAdmin,
  PackApp,
  PackCard,
  PackInput,
  RailAdmin,
  RailsInput,
  ReviewAdmin,
  ReviewInput,
  ReviewModeration,
  SoftwareApp,
  SoftwareCategory,
  SoftwareCategoryInput,
  SoftwareDeals,
  SoftwareHome,
  SoftwareRail,
  VersionEntry,
} from '../../../spec/software.js';
import {
  APP_STATUSES,
  DEFAULT_RAILS,
  LIMITS,
  PLATFORMS,
  RAIL_LIMIT,
  RAIL_SOURCES,
  RAIL_STYLES,
  TOP_RATED_MIN_REVIEWS,
  appPrice,
  currentAmount,
  isIconName,
  isValidSlug,
  LICENCE_DEVICES_MAX,
  moneyLabel,
  packSaving,
  ratingOf,
  saleRuns,
  searchTextOf,
  shortName,
  sizeLabel,
  slugOf,
  validUntilLabel,
  withRating,
  type AppStatus,
} from '../domain/rules.js';
import type { AppRow, CategoryRow, PackRow, RailRow, ReviewRow, StoredFile } from '../ports.js';
import { SoftwareBase, appFileOut, fileOf, filesOf, invalid, notFound, optionalText, requireText, stringsOf, textList, unique, type By } from './base.js';

type Refs = Map<string, common.MediaRef>;
type Cats = Map<string, CategoryRow>;
type Usage = 'content_block' | 'software_file';
const DAY_MS = 86_400_000;

const companyOf = (v: unknown): CompanyRef => {
  const c = (v && typeof v === 'object' ? v : {}) as CompanyRef;
  return { name: String(c.name ?? ''), companyId: c.companyId ?? null, companySlug: c.companySlug ?? null };
};
const versionsOf = (v: unknown): VersionEntry[] => (Array.isArray(v) ? (v as VersionEntry[]).filter((x) => x && typeof x.version === 'string' && typeof x.date === 'string').map((x) => ({ version: x.version, date: x.date, notes: x.notes ?? null })) : []);
const permissionsOf = (v: unknown): AppPermission[] => (Array.isArray(v) ? (v as AppPermission[]).filter((x) => x && typeof x.name === 'string').map((x) => ({ name: x.name, desc: String(x.desc ?? '') })) : []);
const platformsOf = (v: unknown) => stringsOf(v).filter((p): p is AppCard['platforms'][number] => (PLATFORMS as readonly string[]).includes(p));
/** The value the input gives, or the stored one when the field is left out (PATCH) */
const keep = <T>(given: T | undefined, before: T): T => (given === undefined ? before : given);

export class SoftwareCatalog extends SoftwareBase {
  /* ---------------------------------------------------------------- reading the catalog */

  /** Apps the store shows: published (and, for lists, shown in the department) */
  protected async storeApps(inDepartment = true): Promise<AppRow[]> {
    return this.repo.listApps({ statuses: ['published'], ...(inDepartment ? { inDepartment: true } : {}) });
  }

  protected async categoryMap(): Promise<Cats> {
    return new Map((await this.repo.listCategories()).map((c) => [c.id, c]));
  }

  protected categoryRef(c: CategoryRow | undefined): CategoryRef {
    return c ? { slug: c.slug, name: c.name } : { slug: 'uncategorized', name: 'Other' };
  }

  /** What the customer owns among `appIds` (nothing for visitors) */
  protected async ownedOf(customerId: string | null, appIds?: readonly string[]): Promise<Set<string>> {
    return customerId ? this.repo.ownedAppIds(customerId, appIds) : new Set();
  }

  protected appCard(a: AppRow, cats: Cats, refs: Refs, owned: Set<string>): AppCard {
    const rating = ratingOf(a.rating_sum, a.rating_count, a.rating_stars);
    return {
      id: a.id,
      slug: a.slug,
      title: a.title,
      company: companyOf(a.company),
      brief: a.brief,
      icon: a.icon_id ? (refs.get(a.icon_id) ?? null) : null,
      category: this.categoryRef(cats.get(a.category_id)),
      rating: rating.average,
      ratingCount: rating.count,
      sizeBytes: Number(a.size_bytes),
      sizeLabel: sizeLabel(Number(a.size_bytes)),
      price: appPrice(a, this.now()),
      platforms: platformsOf(a.platforms),
      owned: owned.has(a.id),
    };
  }

  /** Cards with their icons, categories and what the customer owns */
  protected async appCards(apps: AppRow[], customerId: string | null, cats?: Cats): Promise<AppCard[]> {
    if (!apps.length) return [];
    const [categories, refs, owned] = await Promise.all([cats ? Promise.resolve(cats) : this.categoryMap(), this.refsMap(apps.map((a) => a.icon_id), 'medium'), this.ownedOf(customerId, apps.map((a) => a.id))]);
    return apps.map((a) => this.appCard(a, categories, refs, owned));
  }

  protected packApps(p: PackRow, byId: Map<string, AppRow>, refs: Refs): PackApp[] {
    return stringsOf(p.app_ids)
      .map((id) => byId.get(id))
      .filter((a): a is AppRow => Boolean(a))
      .map((a) => ({ id: a.id, slug: a.slug, title: a.title, icon: a.icon_id ? (refs.get(a.icon_id) ?? null) : null }));
  }

  /** The pack's price against its apps' regular prices */
  protected packNumbers(p: PackRow, byId: Map<string, AppRow>) {
    const apps = stringsOf(p.app_ids).map((id) => byId.get(id)).filter((a): a is AppRow => Boolean(a));
    const { total, savePercent } = packSaving(Number(p.price), apps.map((a) => (a.free ? 0 : Number(a.price ?? 0))));
    return { apps, total, savePercent };
  }

  protected async packCards(packs: PackRow[], customerId: string | null): Promise<PackCard[]> {
    if (!packs.length) return [];
    const ids = unique(packs.flatMap((p) => stringsOf(p.app_ids)));
    const apps = await this.repo.appsByIds(ids);
    const byId = new Map(apps.map((a) => [a.id, a]));
    const [refs, owned] = await Promise.all([this.refsMap(apps.map((a) => a.icon_id), 'thumb'), this.ownedOf(customerId, ids)]);
    return packs.map((p) => {
      const n = this.packNumbers(p, byId);
      const price = { amount: Number(p.price), currency: p.currency };
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        apps: this.packApps(p, byId, refs),
        count: n.apps.length,
        price,
        priceLabel: moneyLabel(price),
        totalLabel: moneyLabel({ amount: n.total, currency: p.currency }),
        savePercent: n.savePercent,
        licenceLabel: p.licence_label,
        summary: p.summary,
        owned: n.apps.length > 0 && n.apps.every((a) => owned.has(a.id)),
      };
    });
  }

  /* ---------------------------------------------------------------- store: browsing */

  /** Published apps in the department per category */
  private appCounts(apps: AppRow[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const a of apps) if (a.status === 'published' && a.show_in_department) counts.set(a.category_id, (counts.get(a.category_id) ?? 0) + 1);
    return counts;
  }

  private categoryOut(c: CategoryRow, counts: Map<string, number>): SoftwareCategory {
    return { id: c.id, slug: c.slug, name: c.name, icon: c.icon, position: c.position, visible: c.visible, appCount: counts.get(c.id) ?? 0 };
  }

  async listCategories(): Promise<SoftwareCategory[]> {
    const [cats, apps] = await Promise.all([this.repo.listCategories(true), this.storeApps()]);
    const counts = this.appCounts(apps);
    return cats.map((c) => this.categoryOut(c, counts));
  }

  /** Sort orders of GET /apps; the default keeps the staff order */
  private sorted(apps: AppRow[], sort: string | undefined): AppRow[] {
    const now = this.now();
    const avg = (a: AppRow) => (a.rating_count > 0 ? a.rating_sum / a.rating_count : 0);
    const price = (a: AppRow) => currentAmount(a, now) ?? 0;
    const released = (a: AppRow) => (a.released_at ? Date.parse(a.released_at) : a.created_at.getTime());
    const by: Record<string, (a: AppRow, b: AppRow) => number> = {
      popular: (a, b) => Number(b.downloads) - Number(a.downloads) || Number(b.views) - Number(a.views),
      newest: (a, b) => released(b) - released(a),
      rating: (a, b) => avg(b) - avg(a) || b.rating_count - a.rating_count,
      price_low: (a, b) => price(a) - price(b),
      price_high: (a, b) => price(b) - price(a),
    };
    const cmp = sort ? by[sort] : undefined;
    return cmp ? [...apps].sort((a, b) => cmp(a, b) || a.position - b.position || a.title.localeCompare(b.title)) : apps;
  }

  /** The category a rail shows: its own, or for a default rail its default category by slug */
  private railCategoryId(r: RailRow, bySlug: Map<string, CategoryRow>): string | null {
    if (r.category_id) return r.category_id;
    const slug = DEFAULT_RAILS.find((d) => d.key === r.key)?.categorySlug;
    return slug ? (bySlug.get(slug)?.id ?? null) : null;
  }

  /** A rail's apps among the department's apps, in rail order (all of them: callers apply the limit) */
  private railApps(r: RailRow, apps: AppRow[], cats: CategoryRow[]): AppRow[] {
    const bySlug = new Map(cats.map((c) => [c.slug, c]));
    switch (r.source) {
      case 'manual': {
        const byId = new Map(apps.map((a) => [a.id, a]));
        return stringsOf(r.app_ids)
          .map((id) => byId.get(id))
          .filter((a): a is AppRow => Boolean(a));
      }
      case 'newest':
        return this.sorted(apps, 'newest');
      case 'category': {
        const id = this.railCategoryId(r, bySlug);
        return id ? apps.filter((a) => a.category_id === id) : [];
      }
      case 'platform':
        return r.platform ? apps.filter((a) => platformsOf(a.platforms).includes(r.platform as never)) : [];
      case 'top_rated':
        return this.sorted(
          apps.filter((a) => a.rating_count >= TOP_RATED_MIN_REVIEWS),
          'rating',
        );
      default:
        return [];
    }
  }

  private seeAllOf(r: RailRow, cats: CategoryRow[]): string | null {
    switch (r.source) {
      case 'category': {
        const id = this.railCategoryId(r, new Map(cats.map((c) => [c.slug, c])));
        const c = cats.find((x) => x.id === id);
        return c ? `category=${encodeURIComponent(c.slug)}` : null;
      }
      case 'platform':
        return r.platform ? `platform=${r.platform}` : null;
      case 'newest':
        return 'sort=newest';
      default:
        return `rail=${encodeURIComponent(r.key)}`;
    }
  }

  async listApps(q: { category?: string; q?: string; platform?: string; rail?: string; sort?: string }, page: PageRequest, principal: Principal | null): Promise<Page<AppCard>> {
    const [all, cats] = await Promise.all([this.storeApps(), this.repo.listCategories()]);
    let apps = all;
    if (q.rail) {
      const rail = (await this.rails()).find((r) => r.key === q.rail);
      apps = rail && rail.visible ? this.railApps(rail, apps, cats) : [];
    }
    if (q.category) {
      const c = cats.find((x) => x.slug === q.category);
      apps = c && c.visible ? apps.filter((a) => a.category_id === c.id) : [];
    }
    if (q.platform) apps = apps.filter((a) => platformsOf(a.platforms).includes(q.platform as never));
    const term = q.q?.trim().toLowerCase();
    if (term) apps = apps.filter((a) => a.search_text.includes(term));
    const paged = pageOf(this.sorted(apps, q.sort), page);
    const customerId = await this.viewerOf(principal);
    return { ...paged, items: await this.appCards(paged.items, customerId, new Map(cats.map((c) => [c.id, c]))) };
  }

  async getHome(principal: Principal | null): Promise<SoftwareHome> {
    const [apps, cats, rails, packs, customerId] = await Promise.all([this.storeApps(), this.repo.listCategories(), this.rails(), this.repo.listPacks(true), this.viewerOf(principal)]);
    const visibleCats = cats.filter((c) => c.visible);
    const shown = apps.filter((a) => visibleCats.some((c) => c.id === a.category_id));
    const catMap = new Map(cats.map((c) => [c.id, c]));
    const out: SoftwareRail[] = [];
    for (const r of rails) {
      if (!r.visible) continue;
      const list = this.railApps(r, shown, cats).slice(0, r.limit);
      if (!list.length) continue; // an empty rail is left out
      out.push({ key: r.key, title: r.title, source: r.source as SoftwareRail['source'], style: r.style as SoftwareRail['style'], apps: await this.appCards(list, customerId, catMap), seeAll: this.seeAllOf(r, cats) });
    }
    const [featuredPack] = await this.packCards(packs.slice(0, 1), customerId);
    return { rails: out, featuredPack: featuredPack ?? null };
  }

  async getDeals(principal: Principal | null): Promise<SoftwareDeals> {
    const now = this.now();
    const [apps, packs, customerId] = await Promise.all([this.storeApps(), this.repo.listPacks(true), this.viewerOf(principal)]);
    const onSale = apps
      .filter((a) => saleRuns(a, now))
      .map((a) => ({ a, off: appPrice(a, now).offPercent ?? 0 }))
      .sort((x, y) => y.off - x.off || x.a.position - y.a.position || x.a.title.localeCompare(y.a.title))
      .map((x) => x.a);
    const latest = onSale.reduce<Date | null>((m, a) => (a.sale_ends_at && (!m || a.sale_ends_at > m) ? a.sale_ends_at : m), null);
    return { packs: await this.packCards(packs, customerId), discounts: await this.appCards(onSale, customerId), discountsUntilLabel: latest ? validUntilLabel(latest, this.tz) : null };
  }

  /* ---------------------------------------------------------------- store: an app */

  /** A published app by slug (also when not shown in the department); NOT_FOUND otherwise */
  protected async publishedApp(slug: string): Promise<AppRow> {
    const a = await this.repo.appBySlug(slug);
    if (!a || a.status !== 'published') throw notFound('App');
    return a;
  }

  protected reviewOut(r: ReviewRow, customerId: string | null): AppReview {
    return { id: r.id, name: r.name, stars: r.stars, text: r.text, date: r.updated_at.toISOString(), mine: Boolean(customerId && r.customer_id === customerId) };
  }

  protected filesOut(a: AppRow): AppFiles {
    const pkg = fileOf(a.package);
    const databases = filesOf(a.databases);
    const databasesSize = databases.reduce((s, d) => s + d.sizeBytes, 0);
    return {
      package: pkg ? appFileOut(pkg) : null,
      databases: databases.map(appFileOut),
      databasesNote: a.databases_note,
      databasesSizeBytes: databasesSize,
      databasesSizeLabel: databases.length ? sizeLabel(databasesSize) : null,
    };
  }

  /**
   * Counts a view once per visitor (or signed-in account) per app per day: the kernel's shared rate-limit windows
   * (ctx.rateLimit, one hit allowed per UTC day and key) are the dedupe, so every server instance counts together.
   */
  private async countView(a: AppRow, principal: Principal | null): Promise<boolean> {
    const who = principal?.accountId ? `a:${principal.accountId}` : principal?.sessionId ? `s:${principal.sessionId}` : null;
    if (!who) return false;
    const { allowed } = await this.ctx.rateLimit(`view:${a.id}:${who}`, { limit: 1, windowMs: DAY_MS });
    if (allowed) await this.repo.bump(a.id, { views: 1 });
    return allowed;
  }

  async getApp(slug: string, principal: Principal | null): Promise<SoftwareApp> {
    const a = await this.publishedApp(slug);
    const counted = await this.countView(a, principal);
    const customerId = await this.viewerOf(principal);
    const [cats, refs, newest, entitlement, mine] = await Promise.all([
      this.categoryMap(),
      this.refsMap([a.icon_id, ...stringsOf(a.screenshot_ids)]),
      this.repo.newestReviews(a.id, 3),
      customerId ? this.repo.entitlement(customerId, a.id) : Promise.resolve(undefined),
      customerId ? this.repo.reviewOf(a.id, customerId) : Promise.resolve(undefined),
    ]);
    const size = Number(a.size_bytes);
    // an owner of a paid app sees its licence key (issued now when it has none yet)
    const owned = entitlement ? await this.ensureLicence(entitlement, a) : undefined;
    return {
      id: a.id,
      slug: a.slug,
      title: a.title,
      company: companyOf(a.company),
      brief: a.brief,
      icon: a.icon_id ? (refs.get(a.icon_id) ?? null) : null,
      category: this.categoryRef(cats.get(a.category_id)),
      subcategory: a.subcategory,
      screenshots: stringsOf(a.screenshot_ids)
        .map((id) => refs.get(id))
        .filter((r): r is common.MediaRef => Boolean(r)),
      description: a.description,
      moreDescription: a.more_description,
      whatYouGet: stringsOf(a.what_you_get),
      price: appPrice(a, this.now()),
      licenceLabel: a.licence_label,
      licenceDevices: a.free ? null : (a.licence_devices ?? null),
      version: a.version,
      releasedAt: a.released_at,
      whatsNew: a.whats_new,
      versionHistory: versionsOf(a.version_history),
      files: this.filesOut(a),
      sizeBytes: size,
      sizeLabel: sizeLabel(size),
      // any signed-in customer downloads the files (owner decision 2026-10-22); visitors sign in first
      canDownload: Boolean(customerId),
      platforms: platformsOf(a.platforms),
      platformLabels: stringsOf(a.platform_labels),
      minRequirements: a.min_requirements,
      notice: a.notice,
      permissions: permissionsOf(a.permissions),
      views: Number(a.views) + (counted ? 1 : 0),
      downloads: Number(a.downloads),
      ratings: ratingOf(a.rating_sum, a.rating_count, a.rating_stars),
      reviews: newest.map((r) => this.reviewOut(r, customerId)),
      allowReviews: a.allow_reviews,
      owned: Boolean(owned),
      canReview: Boolean(owned) && a.allow_reviews && !mine,
      myReview: mine ? this.reviewOut(mine, customerId) : null,
      licence: this.licenceOut(owned, a),
    };
  }

  async listAppReviews(slug: string, q: { stars?: number }, page: PageRequest, principal: Principal | null): Promise<Page<AppReview>> {
    const a = await this.publishedApp(slug);
    const [paged, customerId] = await Promise.all([this.repo.pageVisibleReviews(a.id, q.stars, page), this.viewerOf(principal)]);
    return { ...paged, items: paged.items.map((r) => this.reviewOut(r, customerId)) };
  }

  /**
   * Rates an owned app, or changes the customer's rating (one review per customer: POST upserts). The app's
   * rating_sum, rating_count and stars move in the same transaction; hidden reviews don't count.
   */
  async reviewApp(customerId: string, slug: string, input: ReviewInput): Promise<AppReview> {
    const a = await this.publishedApp(slug);
    if (!(await this.repo.entitlement(customerId, a.id))) throw this.ctx.error('NOT_OWNED', 'Get or buy the app to rate it.');
    if (!a.allow_reviews) throw this.ctx.error('REVIEWS_OFF', 'Reviews are turned off for this app.');
    if (!Number.isInteger(input.stars) || input.stars < 1 || input.stars > 5) throw invalid('stars', 'Choose 1 to 5 stars');
    const text = optionalText(input.text, 'text', LIMITS.reviewText);
    const name = shortName(await this.customerName(customerId));
    const now = this.now();
    const review = await this.repo.transaction(async (tx) => {
      const app = (await tx.getApp(a.id, { forUpdate: true }))!;
      const before = await tx.reviewOf(a.id, customerId);
      if (!before) {
        const row = await tx.insertReview({ id: newId(), app_id: a.id, customer_id: customerId, name, stars: input.stars, text, hidden: false, hidden_reason: null, created_at: now, updated_at: now });
        if (!row) throw new AppError('CONFLICT', 'Your review is being saved; try again.');
        await tx.updateApp(a.id, { rating_sum: app.rating_sum + input.stars, rating_count: app.rating_count + 1, rating_stars: withRating(app.rating_stars, input.stars, 1) });
        return row;
      }
      const after = (await tx.updateReview(before.id, { stars: input.stars, text, name, updated_at: now }))!;
      if (!before.hidden && before.stars !== input.stars) {
        await tx.updateApp(a.id, { rating_sum: app.rating_sum - before.stars + input.stars, rating_stars: withRating(withRating(app.rating_stars, before.stars, -1), input.stars, 1) });
      }
      return after;
    });
    return this.reviewOut(review, customerId);
  }

  /* ---------------------------------------------------------------- admin: categories */

  async listCategoriesAdmin(): Promise<SoftwareCategory[]> {
    const [cats, apps] = await Promise.all([this.repo.listCategories(), this.storeApps()]);
    const counts = this.appCounts(apps);
    return cats.map((c) => this.categoryOut(c, counts));
  }

  private async categoryFields(input: SoftwareCategoryInput, exceptId?: string) {
    const name = requireText(input.name, 'name', LIMITS.name);
    const slug = slugOf(input.slug, name);
    if (!slug || !isValidSlug(slug)) throw invalid('slug', 'Use lowercase letters, digits and hyphens');
    const other = await this.repo.categoryBySlug(slug);
    if (other && other.id !== exceptId) throw this.ctx.error('SLUG_TAKEN', `Another category already uses the slug ${slug}`);
    const icon = optionalText(input.icon, 'icon', 40);
    if (icon && !isIconName(icon)) throw invalid('icon', 'Use a Lucide icon name like gamepad-2');
    if (input.position != null && (!Number.isInteger(input.position) || input.position < 0)) throw invalid('position', 'Use a whole number, 0 or more');
    return { name, slug, icon };
  }

  private async oneCategory(c: CategoryRow): Promise<SoftwareCategory> {
    return this.categoryOut(c, this.appCounts(await this.storeApps()));
  }

  async createCategory(input: SoftwareCategoryInput, by: By): Promise<SoftwareCategory> {
    const f = await this.categoryFields(input);
    const now = this.now();
    const row = await this.repo.insertCategory({ id: newId(), ...f, position: input.position ?? (await this.repo.countCategories()) + 1, visible: input.visible ?? true, created_at: now, updated_at: now });
    const out = await this.oneCategory(row);
    await this.audit({ action: 'software.category.create', actionLabel: 'Added a software category', target: { type: 'software_category', id: row.id, label: row.name }, after: out }, by);
    return out;
  }

  async updateCategory(id: string, input: SoftwareCategoryInput, by: By): Promise<SoftwareCategory> {
    const before = await this.repo.getCategory(id);
    if (!before) throw notFound('Category');
    const f = await this.categoryFields(input, id);
    const row = (await this.repo.updateCategory(id, { ...f, ...(input.position != null ? { position: input.position } : {}), ...(input.visible != null ? { visible: input.visible } : {}), updated_at: this.now() }))!;
    const out = await this.oneCategory(row);
    await this.audit({ action: 'software.category.update', actionLabel: 'Changed a software category', target: { type: 'software_category', id, label: row.name }, before, after: out }, by);
    return out;
  }

  async deleteCategory(id: string, by: By): Promise<void> {
    const c = await this.repo.getCategory(id);
    if (!c) throw notFound('Category');
    if (await this.repo.countAppsInCategory(id)) throw this.ctx.error('IN_USE', 'Apps still use this category; move them first.');
    if ((await this.rails()).some((r) => r.category_id === id)) throw this.ctx.error('IN_USE', 'A rail of the Recommended tab shows this category; change the rail first.');
    await this.repo.deleteCategory(id);
    await this.audit({ action: 'software.category.delete', actionLabel: 'Deleted a software category', target: { type: 'software_category', id, label: c.name }, before: c }, by);
  }

  /* ---------------------------------------------------------------- admin: apps */

  private appAdminRow(a: AppRow, cats: Cats, refs: Refs): AppAdminRow {
    const rating = ratingOf(a.rating_sum, a.rating_count, a.rating_stars);
    return {
      id: a.id,
      slug: a.slug,
      title: a.title,
      company: companyOf(a.company),
      icon: a.icon_id ? (refs.get(a.icon_id) ?? null) : null,
      category: this.categoryRef(cats.get(a.category_id)),
      price: appPrice(a, this.now(), true),
      sizeLabel: sizeLabel(Number(a.size_bytes)),
      platforms: platformsOf(a.platforms),
      rating: rating.average,
      ratingCount: rating.count,
      downloads: Number(a.downloads),
      views: Number(a.views),
      version: a.version,
      status: a.status,
      updatedAt: a.updated_at.toISOString(),
    };
  }

  async listAppsAdmin(q: { categoryId?: string; status?: string; platform?: string; q?: string }, page: PageRequest): Promise<Page<AppAdminRow>> {
    let apps = await this.repo.listApps({ ...(q.status ? { statuses: [q.status] } : {}), ...(q.categoryId ? { categoryId: q.categoryId } : {}), ...(q.platform ? { platform: q.platform } : {}) });
    const term = q.q?.trim().toLowerCase();
    if (term) apps = apps.filter((a) => a.search_text.includes(term) || a.slug.includes(term));
    const paged = pageOf(apps, page);
    const [cats, refs] = await Promise.all([this.categoryMap(), this.refsMap(paged.items.map((a) => a.icon_id), 'thumb')]);
    return { ...paged, items: paged.items.map((a) => this.appAdminRow(a, cats, refs)) };
  }

  async getAppAdmin(id: string): Promise<AppAdmin> {
    const a = await this.repo.getApp(id);
    if (!a) throw notFound('App');
    const refs = await this.refsMap([a.icon_id, ...stringsOf(a.screenshot_ids)]);
    const size = Number(a.size_bytes);
    return {
      id: a.id,
      slug: a.slug,
      title: a.title,
      company: companyOf(a.company),
      categoryId: a.category_id,
      subcategory: a.subcategory,
      brief: a.brief,
      icon: a.icon_id ? (refs.get(a.icon_id) ?? null) : null,
      screenshots: stringsOf(a.screenshot_ids)
        .map((s) => refs.get(s))
        .filter((r): r is common.MediaRef => Boolean(r)),
      description: a.description,
      moreDescription: a.more_description,
      whatYouGet: stringsOf(a.what_you_get),
      price: appPrice(a, this.now(), true),
      licenceLabel: a.licence_label,
      licenceDevices: a.licence_devices ?? null,
      files: this.filesOut(a),
      sizeBytes: size,
      sizeLabel: sizeLabel(size),
      version: a.version,
      releasedAt: a.released_at,
      whatsNew: a.whats_new,
      versionHistory: versionsOf(a.version_history),
      platforms: platformsOf(a.platforms),
      platformLabels: stringsOf(a.platform_labels),
      minRequirements: a.min_requirements,
      notice: a.notice,
      permissions: permissionsOf(a.permissions),
      status: a.status,
      showInDepartment: a.show_in_department,
      allowReviews: a.allow_reviews,
      position: a.position,
      views: Number(a.views),
      downloads: Number(a.downloads),
      owners: a.owners,
      ratings: ratingOf(a.rating_sum, a.rating_count, a.rating_stars),
      updatedAt: a.updated_at.toISOString(),
      updatedBy: a.updated_by,
    };
  }

  private checkPrice(m: common.Money | null | undefined, path: string): number | null {
    if (!m) return null;
    if (!Number.isSafeInteger(m.amount) || m.amount <= 0) throw invalid(`${path}.amount`, 'Use a whole amount in cents, more than 0');
    if (m.currency && m.currency !== this.currency) throw invalid(`${path}.currency`, `Use ${this.currency}`);
    return m.amount;
  }

  /** The app's fields from the input (PATCH: optional fields left out keep their stored value), validated */
  private async appFields(input: AppInput, before?: AppRow) {
    const title = requireText(input.title, 'title', LIMITS.title);
    const slug = slugOf(keep(input.slug, before?.slug ?? null), title);
    if (!slug || !isValidSlug(slug)) throw invalid('slug', 'Use lowercase letters, digits and hyphens');
    if (await this.repo.appSlugTaken(slug, before?.id)) throw this.ctx.error('SLUG_TAKEN', `Another app already uses the slug ${slug}`);
    const companyName = requireText(input.company?.name, 'company.name', LIMITS.company);
    const category = input.categoryId ? await this.repo.getCategory(input.categoryId) : undefined;
    if (!category) throw invalid('categoryId', 'Category not found');
    const brief = requireText(input.brief, 'brief', LIMITS.brief);
    const description = requireText(input.description, 'description', LIMITS.description);

    const free = Boolean(input.free);
    const price = free ? null : this.checkPrice(keep(input.price, before?.price != null ? { amount: before.price, currency: before.currency } : null), 'price');
    let salePrice = free ? null : this.checkPrice(keep(input.salePrice, before?.sale_price != null ? { amount: before.sale_price, currency: before.currency } : null), 'salePrice');
    const saleEndsRaw = keep(input.saleEndsAt, before?.sale_ends_at ? before.sale_ends_at.toISOString() : null);
    let saleEndsAt: Date | null = null;
    if (salePrice != null) {
      if (price == null) throw invalid('price', 'Set the regular price before a sale price');
      if (salePrice >= price) throw invalid('salePrice', 'The sale price must be below the price');
      if (!saleEndsRaw) throw invalid('saleEndsAt', 'Say when the sale ends');
      saleEndsAt = new Date(saleEndsRaw);
      if (Number.isNaN(saleEndsAt.getTime())) throw invalid('saleEndsAt', 'Use a date and time');
    } else salePrice = null;

    const platforms = unique(input.platforms ?? []);
    platforms.forEach((p, i) => {
      if (!(PLATFORMS as readonly string[]).includes(p)) throw invalid(`platforms[${i}]`, 'Unknown platform');
    });
    const versionHistory = (keep(input.versionHistory, versionsOf(before?.version_history)) ?? []).map((v, i) => {
      const version = requireText(v.version, `versionHistory[${i}].version`, 30);
      if (!isIsoDate(v.date)) throw invalid(`versionHistory[${i}].date`, 'Use a date (YYYY-MM-DD)');
      return { version, date: v.date, notes: optionalText(v.notes, `versionHistory[${i}].notes`, LIMITS.versionNotes) };
    });
    if (versionHistory.length > LIMITS.versions) throw invalid('versionHistory', `Use at most ${LIMITS.versions} versions`);
    const permissions = (keep(input.permissions, permissionsOf(before?.permissions)) ?? []).map((p, i) => ({ name: requireText(p.name, `permissions[${i}].name`, 40), desc: requireText(p.desc, `permissions[${i}].desc`, LIMITS.listItem) }));
    if (permissions.length > LIMITS.permissions) throw invalid('permissions', `Use at most ${LIMITS.permissions} permissions`);
    const releasedAt = keep(input.releasedAt, before?.released_at ?? null) ?? null;
    if (releasedAt && !isIsoDate(releasedAt)) throw invalid('releasedAt', 'Use a date (YYYY-MM-DD)');
    const status = (input.status ?? before?.status ?? 'draft') as AppStatus;
    if (!(APP_STATUSES as readonly string[]).includes(status)) throw invalid('status', 'Unknown status');
    if (input.position != null && (!Number.isInteger(input.position) || input.position < 0)) throw invalid('position', 'Use a whole number, 0 or more');
    const subcategory = optionalText(keep(input.subcategory, before?.subcategory ?? null), 'subcategory', LIMITS.subcategory);
    const licenceDevices = free ? null : (keep(input.licenceDevices, before?.licence_devices ?? null) ?? null);
    if (licenceDevices != null && (!Number.isInteger(licenceDevices) || licenceDevices < 1 || licenceDevices > LICENCE_DEVICES_MAX)) throw invalid('licenceDevices', `Use a whole number from 1 to ${LICENCE_DEVICES_MAX}, or leave it empty for no limit`);

    return {
      category,
      row: {
        slug,
        title,
        company: { name: companyName, companyId: input.company.companyId ?? null, companySlug: input.company.companySlug ?? null },
        category_id: category.id,
        subcategory,
        brief,
        description,
        more_description: optionalText(keep(input.moreDescription, before?.more_description ?? null), 'moreDescription', LIMITS.description),
        what_you_get: textList(keep(input.whatYouGet, stringsOf(before?.what_you_get)), 'whatYouGet', LIMITS.listItems, LIMITS.listItem),
        free,
        price,
        sale_price: salePrice,
        sale_ends_at: saleEndsAt,
        currency: this.currency,
        licence_label: optionalText(keep(input.licenceLabel, before?.licence_label ?? null), 'licenceLabel', 60),
        licence_devices: licenceDevices,
        databases_note: optionalText(keep(input.databasesNote, before?.databases_note ?? null), 'databasesNote', 200),
        version: optionalText(keep(input.version, before?.version ?? null), 'version', 30),
        released_at: releasedAt,
        whats_new: optionalText(keep(input.whatsNew, before?.whats_new ?? null), 'whatsNew', LIMITS.versionNotes),
        version_history: versionHistory,
        platforms,
        platform_labels: textList(keep(input.platformLabels, stringsOf(before?.platform_labels)), 'platformLabels', LIMITS.platformLabels, 40),
        min_requirements: optionalText(keep(input.minRequirements, before?.min_requirements ?? null), 'minRequirements', LIMITS.notice),
        notice: optionalText(keep(input.notice, before?.notice ?? null), 'notice', LIMITS.notice),
        permissions,
        status,
        show_in_department: input.showInDepartment ?? before?.show_in_department ?? true,
        allow_reviews: input.allowReviews ?? before?.allow_reviews ?? true,
        search_text: searchTextOf({ title, company: companyName, brief, category: category.name, subcategory }),
      },
    };
  }

  /** The icon, screenshots, package and databases the input asks for (left out: the stored ones) */
  private async appFilesOf(input: AppInput, before?: AppRow) {
    const iconId = keep(input.iconId, before?.icon_id ?? null) ?? null;
    const screenshotIds = unique(keep(input.screenshotIds, stringsOf(before?.screenshot_ids)) ?? []);
    if (screenshotIds.length > LIMITS.screenshots) throw invalid('screenshotIds', `Use at most ${LIMITS.screenshots} screenshots`);
    const packageId = keep(input.packageId, fileOf(before?.package)?.id ?? null) ?? null;
    const databaseIds = unique(keep(input.databaseIds, filesOf(before?.databases).map((f) => f.id)) ?? []);
    if (databaseIds.length > LIMITS.databases) throw invalid('databaseIds', `Use at most ${LIMITS.databases} databases`);
    if (packageId && databaseIds.includes(packageId)) throw invalid('databaseIds', 'The package cannot also be a database');
    const known = new Map([...(fileOf(before?.package) ? [fileOf(before?.package)!] : []), ...filesOf(before?.databases)].map((f) => [f.id, f]));
    // files already on the app keep their recorded name and size; new ones are read from media
    const pkg = packageId ? (known.get(packageId) ? { ...known.get(packageId)!, kind: 'package' as const } : await this.packageFile(packageId, 'package', 'packageId')) : null;
    const databases: StoredFile[] = [];
    for (const [i, id] of databaseIds.entries()) databases.push(known.get(id) ? { ...known.get(id)!, kind: 'database' } : await this.packageFile(id, 'database', `databaseIds[${i}]`));
    return { iconId, screenshotIds, pkg, databases };
  }

  /** Publishing needs an icon, the package and, for a paid app, a price: every missing one is an issue */
  private checkPublishable(status: string, f: { iconId: string | null; pkg: StoredFile | null }, free: boolean, price: number | null) {
    if (status !== 'published') return;
    const issues: { path: string; message: string }[] = [];
    if (!f.iconId) issues.push({ path: 'iconId', message: 'Add an icon to publish the app' });
    if (!f.pkg) issues.push({ path: 'packageId', message: 'Add the app package to publish the app' });
    if (!free && price == null) issues.push({ path: 'price', message: 'Set a price to publish a paid app' });
    if (issues.length) throw new AppError('VALIDATION_FAILED', issues.map((i) => i.message).join('. '), { issues });
  }

  private filesUsed(a: { iconId: string | null; screenshotIds: string[]; pkg: StoredFile | null; databases: StoredFile[] }): { id: string; usage: Usage; path: string }[] {
    return [
      ...(a.iconId ? [{ id: a.iconId, usage: 'content_block' as const, path: 'iconId' }] : []),
      ...a.screenshotIds.map((id, i) => ({ id, usage: 'content_block' as const, path: `screenshotIds[${i}]` })),
      ...(a.pkg ? [{ id: a.pkg.id, usage: 'software_file' as const, path: 'packageId' }] : []),
      ...a.databases.map((d, i) => ({ id: d.id, usage: 'software_file' as const, path: `databaseIds[${i}]` })),
    ];
  }

  private storedFilesOf(a: AppRow) {
    return this.filesUsed({ iconId: a.icon_id, screenshotIds: stringsOf(a.screenshot_ids), pkg: fileOf(a.package), databases: filesOf(a.databases) });
  }

  async createApp(input: AppInput, by: By): Promise<AppAdmin> {
    const { row } = await this.appFields(input);
    const files = await this.appFilesOf(input);
    this.checkPublishable(row.status, files, row.free, row.price);
    const id = newId();
    const now = this.now();
    const position = input.position ?? (await this.repo.maxAppPosition()) + 1;
    await this.withFiles(id, row.title, [], this.filesUsed(files), () =>
      this.repo.insertApp({
        id,
        ...row,
        icon_id: files.iconId,
        screenshot_ids: files.screenshotIds,
        package: files.pkg,
        databases: files.databases,
        size_bytes: (files.pkg?.sizeBytes ?? 0) + files.databases.reduce((s, d) => s + d.sizeBytes, 0),
        position,
        views: 0,
        downloads: 0,
        owners: 0,
        rating_sum: 0,
        rating_count: 0,
        rating_stars: [0, 0, 0, 0, 0],
        created_at: now,
        updated_at: now,
        updated_by: by.actor.name ?? null,
      } as AppRow),
    );
    const out = await this.getAppAdmin(id);
    await this.audit({ action: 'software.app.create', actionLabel: 'Added an app', target: { type: 'software_app', id, label: row.title }, after: { slug: out.slug, status: out.status, price: out.price } }, by);
    return out;
  }

  async updateApp(id: string, input: AppInput, by: By): Promise<AppAdmin> {
    const before = await this.repo.getApp(id);
    if (!before) throw notFound('App');
    const { row } = await this.appFields(input, before);
    const files = await this.appFilesOf(input, before);
    this.checkPublishable(row.status, files, row.free, row.price);
    await this.withFiles(id, row.title, this.storedFilesOf(before), this.filesUsed(files), () =>
      this.repo.updateApp(id, {
        ...row,
        icon_id: files.iconId,
        screenshot_ids: files.screenshotIds,
        package: files.pkg,
        databases: files.databases,
        size_bytes: (files.pkg?.sizeBytes ?? 0) + files.databases.reduce((s, d) => s + d.sizeBytes, 0),
        ...(input.position != null ? { position: input.position } : {}),
        updated_at: this.now(),
        updated_by: by.actor.name ?? null,
      } as Partial<AppRow>),
    );
    const out = await this.getAppAdmin(id);
    await this.audit(
      {
        action: 'software.app.update',
        actionLabel: 'Changed an app',
        target: { type: 'software_app', id, label: row.title },
        before: { slug: before.slug, status: before.status, price: before.price, salePrice: before.sale_price, packageId: fileOf(before.package)?.id ?? null },
        after: { slug: out.slug, status: out.status, price: row.price, salePrice: row.sale_price, packageId: out.files.package?.id ?? null },
      },
      by,
    );
    return out;
  }

  /** An app nobody owns, bought or packed can be deleted; others can only be hidden (IN_USE) */
  async deleteApp(id: string, by: By): Promise<void> {
    const a = await this.repo.getApp(id);
    if (!a) throw notFound('App');
    if (await this.repo.countOwners(id)) throw this.ctx.error('IN_USE', 'Customers own this app; hide it instead.');
    if (await this.repo.countAppPurchases(id)) throw this.ctx.error('IN_USE', 'Purchases include this app; hide it instead.');
    if ((await this.repo.packsWithApp(id)).length) throw this.ctx.error('IN_USE', 'A pack includes this app; take it out of the pack first.');
    await this.repo.deleteApp(id);
    await this.repo.deleteAppReviews(id);
    await this.detachAll(id, this.storedFilesOf(a));
    await this.audit({ action: 'software.app.delete', actionLabel: 'Deleted an app', target: { type: 'software_app', id, label: a.title }, before: { slug: a.slug, status: a.status } }, by);
  }

  /* ---------------------------------------------------------------- admin: packs */

  private async packsAdmin(packs: PackRow[]): Promise<PackAdmin[]> {
    const apps = await this.repo.appsByIds(unique(packs.flatMap((p) => stringsOf(p.app_ids))));
    const byId = new Map(apps.map((a) => [a.id, a]));
    const refs = await this.refsMap(apps.map((a) => a.icon_id), 'thumb');
    return packs.map((p) => {
      const n = this.packNumbers(p, byId);
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        summary: p.summary,
        apps: this.packApps(p, byId, refs),
        price: { amount: Number(p.price), currency: p.currency },
        totalLabel: moneyLabel({ amount: n.total, currency: p.currency }),
        savePercent: n.savePercent,
        licenceLabel: p.licence_label,
        visible: p.visible,
        position: p.position,
        sold: p.sold,
        updatedAt: p.updated_at.toISOString(),
      };
    });
  }

  async listPacksAdmin(): Promise<PackAdmin[]> {
    return this.packsAdmin(await this.repo.listPacks());
  }

  private async packFields(input: PackInput, exceptId?: string) {
    const name = requireText(input.name, 'name', LIMITS.name);
    const slug = slugOf(input.slug, name);
    if (!slug || !isValidSlug(slug)) throw invalid('slug', 'Use lowercase letters, digits and hyphens');
    if (await this.repo.packSlugTaken(slug, exceptId)) throw this.ctx.error('SLUG_TAKEN', `Another pack already uses the slug ${slug}`);
    const appIds = unique(input.appIds ?? []);
    if (appIds.length < 2) throw invalid('appIds', 'A pack has two or more apps');
    if (appIds.length > LIMITS.packApps) throw invalid('appIds', `Use at most ${LIMITS.packApps} apps`);
    const apps = new Map((await this.repo.appsByIds(appIds)).map((a) => [a.id, a]));
    appIds.forEach((id, i) => {
      const a = apps.get(id);
      if (!a) throw invalid(`appIds[${i}]`, 'App not found');
      if (a.free || a.price == null) throw invalid(`appIds[${i}]`, `${a.title} is free; a pack has paid apps only`);
    });
    const price = this.checkPrice(input.price, 'price');
    if (price == null) throw invalid('price', 'Set the pack price');
    if (input.position != null && (!Number.isInteger(input.position) || input.position < 0)) throw invalid('position', 'Use a whole number, 0 or more');
    return { name, slug, summary: optionalText(input.summary, 'summary', 160), app_ids: appIds, price, currency: this.currency, licence_label: optionalText(input.licenceLabel, 'licenceLabel', 60) };
  }

  async createPack(input: PackInput, by: By): Promise<PackAdmin> {
    const f = await this.packFields(input);
    const now = this.now();
    const row = await this.repo.insertPack({ id: newId(), ...f, visible: input.visible ?? true, position: input.position ?? (await this.repo.countPacks()) + 1, sold: 0, created_at: now, updated_at: now });
    const [out] = await this.packsAdmin([row]);
    await this.audit({ action: 'software.pack.create', actionLabel: 'Added an app pack', target: { type: 'software_pack', id: row.id, label: row.name }, after: out }, by);
    return out!;
  }

  async updatePack(id: string, input: PackInput, by: By): Promise<PackAdmin> {
    const before = await this.repo.getPack(id);
    if (!before) throw notFound('Pack');
    const f = await this.packFields(input, id);
    const row = (await this.repo.updatePack(id, { ...f, ...(input.visible != null ? { visible: input.visible } : {}), ...(input.position != null ? { position: input.position } : {}), updated_at: this.now() }))!;
    const [out] = await this.packsAdmin([row]);
    await this.audit({ action: 'software.pack.update', actionLabel: 'Changed an app pack', target: { type: 'software_pack', id, label: row.name }, before, after: out }, by);
    return out!;
  }

  /** A pack that was never sold can be deleted; others can only be hidden (IN_USE) */
  async deletePack(id: string, by: By): Promise<void> {
    const p = await this.repo.getPack(id);
    if (!p) throw notFound('Pack');
    if (p.sold > 0 || (await this.repo.countPackPurchases(id))) throw this.ctx.error('IN_USE', 'Customers bought this pack; hide it instead.');
    await this.repo.deletePack(id);
    await this.audit({ action: 'software.pack.delete', actionLabel: 'Deleted an app pack', target: { type: 'software_pack', id, label: p.name }, before: p }, by);
  }

  /* ---------------------------------------------------------------- rails */

  /**
   * The rails in order. The first read of a database stores the default rails (spec notes, Rails) once: a claim
   * keeps them from coming back after staff remove them.
   */
  protected async rails(): Promise<RailRow[]> {
    const rows = await this.repo.listRails();
    if (rows.length) return rows;
    const cats = await this.repo.listCategories();
    const now = this.now();
    const defaults: RailRow[] = DEFAULT_RAILS.map((d, i) => ({
      key: d.key,
      title: d.title,
      source: d.source,
      style: d.style,
      category_id: d.categorySlug ? (cats.find((c) => c.slug === d.categorySlug)?.id ?? null) : null,
      platform: d.platform ?? null,
      app_ids: [],
      limit: d.limit,
      visible: true,
      position: i + 1,
      updated_at: now,
    }));
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim('default-rails'))) return;
      if ((await tx.listRails()).length) return;
      await tx.replaceRails(defaults);
    });
    return this.repo.listRails();
  }

  private railOut(r: RailRow, cats: CategoryRow[]): RailAdmin {
    return {
      key: r.key,
      title: r.title,
      source: r.source as RailAdmin['source'],
      style: r.style as RailAdmin['style'],
      categoryId: r.source === 'category' ? this.railCategoryId(r, new Map(cats.map((c) => [c.slug, c]))) : null,
      platform: (r.platform as RailAdmin['platform']) ?? null,
      appIds: stringsOf(r.app_ids),
      limit: r.limit,
      visible: r.visible,
    };
  }

  async getRails(): Promise<RailAdmin[]> {
    const [rails, cats] = await Promise.all([this.rails(), this.repo.listCategories()]);
    return rails.map((r) => this.railOut(r, cats));
  }

  async setRails(input: RailsInput, by: By): Promise<RailAdmin[]> {
    const list = input.rails ?? [];
    if (list.length > LIMITS.rails) throw invalid('rails', `Use at most ${LIMITS.rails} rails`);
    const before = await this.getRails();
    const keys = new Set<string>();
    const now = this.now();
    const rows: RailRow[] = [];
    for (const [i, r] of list.entries()) {
      const path = `rails[${i}]`;
      const key = requireText(r.key, `${path}.key`, 40);
      if (!isValidSlug(key)) throw invalid(`${path}.key`, 'Use lowercase letters, digits and hyphens');
      if (keys.has(key)) throw invalid(`${path}.key`, 'Each rail has its own key');
      keys.add(key);
      if (!(RAIL_SOURCES as readonly string[]).includes(r.source)) throw invalid(`${path}.source`, 'Unknown source');
      if (!(RAIL_STYLES as readonly string[]).includes(r.style)) throw invalid(`${path}.style`, 'Unknown style');
      if (!Number.isInteger(r.limit) || r.limit < RAIL_LIMIT.min || r.limit > RAIL_LIMIT.max) throw invalid(`${path}.limit`, `Show ${RAIL_LIMIT.min} to ${RAIL_LIMIT.max} apps`);
      let categoryId: string | null = null;
      if (r.source === 'category') {
        if (!r.categoryId || !(await this.repo.getCategory(r.categoryId))) throw invalid(`${path}.categoryId`, 'Choose a category');
        categoryId = r.categoryId;
      }
      if (r.source === 'platform' && (!r.platform || !(PLATFORMS as readonly string[]).includes(r.platform))) throw invalid(`${path}.platform`, 'Choose a platform');
      const appIds = r.source === 'manual' ? unique(r.appIds ?? []) : [];
      if (appIds.length > RAIL_LIMIT.max) throw invalid(`${path}.appIds`, `Use at most ${RAIL_LIMIT.max} apps`);
      if (appIds.length) {
        const found = new Set((await this.repo.appsByIds(appIds)).map((a) => a.id));
        appIds.forEach((id, k) => {
          if (!found.has(id)) throw invalid(`${path}.appIds[${k}]`, 'App not found');
        });
      }
      rows.push({ key, title: requireText(r.title, `${path}.title`, LIMITS.railTitle), source: r.source, style: r.style, category_id: categoryId, platform: r.source === 'platform' ? (r.platform ?? null) : null, app_ids: appIds, limit: r.limit, visible: r.visible ?? true, position: i + 1, updated_at: now });
    }
    await this.repo.transaction(async (tx) => {
      await tx.claim('default-rails'); // staff's rails from now on: the defaults never come back
      await tx.replaceRails(rows);
    });
    const after = await this.getRails();
    await this.audit({ action: 'software.rails.set', actionLabel: 'Changed the Softwares Recommended tab', target: { type: 'software_rails', id: 'recommended', label: 'Recommended tab' }, before, after }, by);
    return after;
  }

  /* ---------------------------------------------------------------- admin: reviews */

  private async reviewsAdmin(rows: ReviewRow[]): Promise<ReviewAdmin[]> {
    const apps = await this.repo.appsByIds(unique(rows.map((r) => r.app_id)));
    const byId = new Map(apps.map((a) => [a.id, a]));
    const refs = await this.refsMap(apps.map((a) => a.icon_id), 'thumb');
    return rows.map((r) => {
      const a = byId.get(r.app_id);
      return {
        id: r.id,
        app: a ? { id: a.id, slug: a.slug, title: a.title, icon: a.icon_id ? (refs.get(a.icon_id) ?? null) : null } : { id: r.app_id, slug: '', title: 'Deleted app', icon: null },
        name: r.name,
        customerId: r.customer_id,
        stars: r.stars,
        text: r.text,
        hidden: r.hidden,
        date: r.updated_at.toISOString(),
      };
    });
  }

  async listReviewsAdmin(q: { appId?: string; hidden?: boolean; stars?: number }, page: PageRequest): Promise<Page<ReviewAdmin>> {
    const paged = await this.repo.pageAdminReviews(q, page);
    return { ...paged, items: await this.reviewsAdmin(paged.items) };
  }

  /** Hides or shows a review; the app's rating counts visible reviews only */
  async moderateReview(id: string, input: ReviewModeration, by: By): Promise<ReviewAdmin> {
    const reason = optionalText(input.reason, 'reason', 500);
    const { before, after } = await this.repo.transaction(async (tx) => {
      const r = await tx.getReview(id, { forUpdate: true });
      if (!r) throw notFound('Review');
      if (r.hidden === input.hidden) return { before: r, after: r };
      const app = await tx.getApp(r.app_id, { forUpdate: true });
      const delta = input.hidden ? -1 : 1;
      if (app) await tx.updateApp(app.id, { rating_sum: app.rating_sum + delta * r.stars, rating_count: Math.max(0, app.rating_count + delta), rating_stars: withRating(app.rating_stars, r.stars, delta) });
      const after = (await tx.updateReview(id, { hidden: input.hidden, hidden_reason: input.hidden ? reason : null }))!;
      return { before: r, after };
    });
    const [out] = await this.reviewsAdmin([after]);
    if (before.hidden !== after.hidden) {
      await this.audit({ action: input.hidden ? 'software.review.hide' : 'software.review.show', actionLabel: input.hidden ? 'Hid an app review' : 'Showed an app review', target: { type: 'software_review', id, label: out!.app.title }, reason, before: { hidden: before.hidden }, after: { hidden: after.hidden } }, by);
    }
    return out!;
  }
}
