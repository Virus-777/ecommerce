/**
 * The departments this module owns in the integrated search (search module's `GET /api/store/search/departments`):
 * Phones, Farm machines, Blogs, Companies and the Play center. Each section answers with the records that match
 * what the customer typed, as ranked hits with the store path each one opens.
 *
 * Where the department's own list already takes `q` (posts, companies, games) the search uses it, so a hit reads
 * exactly like the card those screens show; the short staff-ordered lists (phones, machines, topics, industries,
 * genres) are scored in memory.
 */
import { format as formatMoney } from '../../../kernel/lib/money.js';
import { groupFrom, groupFromList, groupPage, line, scoreOf, stars, wanted, WEAK_MATCH } from '../../../kernel/lib/dept-search.js';
import type * as common from '../../../spec/common.js';
import type { BlogPostCard, BlogTopic, CompanyCard, FarmMachineCard, FarmType, GameCard, Industry, PhoneCard } from '../../../spec/departments.js';
import type { AuthorRow } from '../ports.js';
import { mediaOf } from './base.js';
import { DepartmentsExport } from './export.js';

/** The sections of the search screen this module answers for. */
const SECTIONS = ['phones', 'farm', 'blogs', 'companies', 'play'] as const;
type Section = (typeof SECTIONS)[number];

const count = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export class DepartmentsSearch extends DepartmentsExport {
  /** Public API (search): the asked-for sections' records matching the typed text. */
  async searchDepartments(input: common.DeptSearchRequest): Promise<common.DeptSearchResult> {
    const q = input.q.trim();
    if (!q) return { groups: [] };
    const sections: Section[] = input.sections?.length ? SECTIONS.filter((s) => input.sections!.includes(s)) : [...SECTIONS];
    const groups = (
      await Promise.all(
        sections.map((s) =>
          s === 'phones'
            ? this.phoneGroups(q, input)
            : s === 'farm'
              ? this.farmGroups(q, input)
              : s === 'blogs'
                ? this.blogGroups(q, input)
                : s === 'companies'
                  ? this.companyGroups(q, input)
                  : this.playGroups(q, input),
        ),
      )
    ).flat();
    return { groups };
  }

  /* ------------------------------------------------------------------ Phones */

  private async phoneGroups(q: string, input: common.DeptSearchRequest): Promise<common.DeptSearchGroup[]> {
    if (!wanted(input, 'phone')) return [];
    const { phones } = await this.getPhones();
    const group = groupFromList('phone', 'Phones', phones, input, (p) => this.phoneHit(q, p));
    return group ? [group] : [];
  }

  private phoneHit(q: string, p: PhoneCard): common.DeptSearchHit {
    return {
      id: p.id,
      kind: 'phone',
      // the name is the phone's heading on its own page, and staff usually put the brand in it already
      title: p.name,
      meta: line(p.brand, p.meta),
      sub: null,
      image: p.image ?? null,
      badge: p.dealPercent ? `−${p.dealPercent}%` : null,
      badgeTone: 'deal',
      priceLabel: formatMoney(p.price),
      wasLabel: p.was ? formatMoney(p.was) : null,
      path: `/phones/${p.slug}`,
      score: scoreOf(q, p.name, [p.brand, p.meta]),
    };
  }

  /* ------------------------------------------------------------------ Farm machines */

  private async farmGroups(q: string, input: common.DeptSearchRequest): Promise<common.DeptSearchGroup[]> {
    const askMachines = wanted(input, 'farm_machine');
    const askTypes = wanted(input, 'farm_machine_type');
    if (!askMachines && !askTypes) return [];
    const farm = await this.getFarm({});
    const names = new Map(farm.types.map((t) => [t.id, t.name]));
    return [
      askMachines ? groupFromList('farm_machine', 'Machines', farm.machines, input, (m) => this.machineHit(q, m, names.get(m.typeId))) : null,
      askTypes ? groupFromList('farm_machine_type', 'Machine types', farm.types, input, (t) => this.farmTypeHit(q, t, farm.machines)) : null,
    ].filter((g): g is common.DeptSearchGroup => Boolean(g));
  }

  private machineHit(q: string, m: FarmMachineCard, typeName: string | undefined): common.DeptSearchHit {
    const p = m.product;
    return {
      id: p.productId,
      kind: 'farm_machine',
      title: p.title,
      meta: line(typeName, ...m.highlights),
      sub: line(p.sellerName, p.deliveryCue),
      image: p.image ?? null,
      badge: p.discountPct ? `−${p.discountPct}%` : null,
      badgeTone: 'deal',
      priceLabel: formatMoney(p.price),
      wasLabel: p.wasPrice ? formatMoney(p.wasPrice) : null,
      path: `/farm-machines/${p.productId}`,
      score: scoreOf(q, p.title, [p.brandName, typeName, ...m.highlights]),
    };
  }

  private farmTypeHit(q: string, t: FarmType, machines: FarmMachineCard[]): common.DeptSearchHit {
    const n = machines.filter((m) => m.typeId === t.id).length;
    return {
      id: t.id,
      kind: 'farm_machine_type',
      title: t.name,
      meta: count(n, 'machine', 'machines'),
      sub: null,
      image: null,
      badge: null,
      badgeTone: null,
      priceLabel: null,
      wasLabel: null,
      path: `/farm-machines?type=${t.slug}`,
      score: scoreOf(q, t.name),
    };
  }

  /* ------------------------------------------------------------------ Blogs */

  private async blogGroups(q: string, input: common.DeptSearchRequest): Promise<common.DeptSearchGroup[]> {
    const [posts, topics, authors] = await Promise.all([
      wanted(input, 'post') ? this.listBlogPosts({ q }, groupPage(input)) : null,
      wanted(input, 'topic') ? this.listBlogTopics() : null,
      wanted(input, 'author') ? this.repo.listAuthors() : null,
    ]);
    const avatars = authors ? await this.refsMap(authors.map((a) => mediaOf(a.avatar)?.id), 'thumb') : null;
    return [
      posts && groupFrom('post', 'Posts', posts, (p) => this.postHit(q, p)),
      authors && avatars && groupFromList('author', 'Authors', authors, input, (a) => this.authorHit(q, a, avatars)),
      topics && groupFromList('topic', 'Topics', topics, input, (t) => this.topicHit(q, t)),
    ].filter((g): g is common.DeptSearchGroup => Boolean(g));
  }

  private postHit(q: string, p: BlogPostCard): common.DeptSearchHit {
    return {
      id: p.id,
      kind: 'post',
      title: p.title,
      meta: line(p.topic?.name, p.author.name, `${p.readMinutes} min read`),
      sub: p.summary ?? null,
      image: p.cover ?? null,
      badge: p.featured ? 'Featured' : null,
      badgeTone: 'brand',
      priceLabel: null,
      wasLabel: null,
      path: `/blogs/${p.slug}`,
      score: scoreOf(q, p.title, [p.summary, p.topic?.name, p.author.name]) || WEAK_MATCH,
    };
  }

  private authorHit(q: string, a: AuthorRow, avatars: Map<string, common.MediaRef>): common.DeptSearchHit {
    const avatar = mediaOf(a.avatar);
    return {
      id: a.id,
      kind: 'author',
      title: a.name,
      meta: a.bio ? a.bio.slice(0, 120) : 'Author',
      sub: null,
      image: avatar ? (avatars.get(avatar.id) ?? null) : null,
      badge: null,
      badgeTone: null,
      priceLabel: null,
      wasLabel: null,
      path: `/blogs/authors/${a.slug}`,
      score: scoreOf(q, a.name, [a.bio]),
    };
  }

  private topicHit(q: string, t: BlogTopic): common.DeptSearchHit {
    return {
      id: t.id,
      kind: 'topic',
      title: t.name,
      meta: count(t.postCount, 'post', 'posts'),
      sub: null,
      image: null,
      badge: null,
      badgeTone: null,
      priceLabel: null,
      wasLabel: null,
      path: `/blogs?topic=${t.slug}`,
      score: scoreOf(q, t.name),
    };
  }

  /* ------------------------------------------------------------------ Companies */

  private async companyGroups(q: string, input: common.DeptSearchRequest): Promise<common.DeptSearchGroup[]> {
    const [companies, industries] = await Promise.all([
      wanted(input, 'company') ? this.listCompanies({ q }, groupPage(input)) : null,
      wanted(input, 'industry') ? this.listIndustries() : null,
    ]);
    return [
      companies && groupFrom('company', 'Companies', companies, (c) => this.companyHit(q, c)),
      industries && groupFromList('industry', 'Industries', industries, input, (i) => this.industryHit(q, i)),
    ].filter((g): g is common.DeptSearchGroup => Boolean(g));
  }

  private companyHit(q: string, c: CompanyCard): common.DeptSearchHit {
    return {
      id: c.id,
      kind: 'company',
      title: c.name,
      meta: line(c.industry?.name, c.city),
      sub: c.tagline ?? null,
      image: c.logo ?? null,
      badge: c.verified ? 'Verified' : null,
      badgeTone: 'info',
      priceLabel: stars(c.rating, c.ratingCount),
      wasLabel: null,
      path: `/companies/${c.slug}`,
      score: scoreOf(q, c.name, [c.tagline, c.industry?.name, c.city]) || WEAK_MATCH,
    };
  }

  private industryHit(q: string, i: Industry): common.DeptSearchHit {
    return {
      id: i.id,
      kind: 'industry',
      title: i.name,
      meta: count(i.companyCount, 'company', 'companies'),
      sub: null,
      image: null,
      badge: null,
      badgeTone: null,
      priceLabel: null,
      wasLabel: null,
      path: `/companies?industry=${i.slug}`,
      score: scoreOf(q, i.name),
    };
  }

  /* ------------------------------------------------------------------ Play center */

  private async playGroups(q: string, input: common.DeptSearchRequest): Promise<common.DeptSearchGroup[]> {
    const askGames = wanted(input, 'game');
    const askGenres = wanted(input, 'genre');
    if (!askGames && !askGenres) return [];
    const { games, genres } = await this.listGames({ q: askGames ? q : undefined });
    const all = askGenres ? (await this.listGames({})).genres : genres;
    return [
      askGames ? groupFromList('game', 'Games', games, input, (g) => this.gameHit(q, g)) : null,
      askGenres ? groupFromList('genre', 'Genres', all, input, (g) => this.genreHit(q, g, games)) : null,
    ].filter((g): g is common.DeptSearchGroup => Boolean(g));
  }

  private gameHit(q: string, g: GameCard): common.DeptSearchHit {
    return {
      id: g.id,
      kind: 'game',
      title: g.title,
      meta: line(g.genre, stars(g.rating, g.ratingCount), g.playersLabel),
      sub: null,
      image: g.icon ?? g.cover ?? null,
      badge: g.hasPrizes ? 'Win coupons' : null,
      badgeTone: 'brand',
      priceLabel: null,
      wasLabel: null,
      path: `/play/games/${g.slug}`,
      score: scoreOf(q, g.title, [g.genre]) || WEAK_MATCH,
    };
  }

  private genreHit(q: string, genre: string, games: GameCard[]): common.DeptSearchHit {
    const n = games.filter((g) => g.genre === genre).length;
    return {
      id: genre,
      kind: 'genre',
      title: genre,
      meta: n ? count(n, 'game', 'games') : 'Genre',
      sub: null,
      image: null,
      badge: null,
      badgeTone: null,
      priceLabel: null,
      wasLabel: null,
      path: '/play',
      score: scoreOf(q, genre),
    };
  }
}
