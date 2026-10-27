/**
 * Softwares in the integrated search (search module's `GET /api/store/search/departments`): the published apps,
 * the packs and the visible categories that match what the customer typed, as ranked hits with the store path
 * each one opens.
 *
 * Apps are the department's own `q` list, so a hit reads exactly like the card the Softwares screens show, and
 * paging the group is that list's own cursor. Packs and categories are short lists kept in memory.
 */
import { groupFrom, groupFromList, groupPage, line, scoreOf, stars, wanted, WEAK_MATCH } from '../../../kernel/lib/dept-search.js';
import type * as common from '../../../spec/common.js';
import type { AppCard, PackCard, SoftwareCategory } from '../../../spec/software.js';
import { SoftwareStatisticsPart } from './statistics.js';

export class SoftwareSearchPart extends SoftwareStatisticsPart {
  /** Public API (search): apps, packs and categories matching the typed text. */
  async searchSoftware(input: common.DeptSearchRequest): Promise<common.DeptSearchResult> {
    const q = input.q.trim();
    if (!q) return { groups: [] };
    const [apps, deals, categories] = await Promise.all([
      wanted(input, 'app') ? this.listApps({ q }, groupPage(input), null) : null,
      wanted(input, 'pack') ? this.getDeals(null) : null,
      wanted(input, 'software_category') ? this.listCategories() : null,
    ]);
    const groups = [
      apps && groupFrom('app', 'Apps', apps, (a) => this.appHit(q, a)),
      deals && groupFromList('pack', 'Packs', deals.packs, input, (p) => this.packHit(q, p)),
      categories && groupFromList('software_category', 'Categories', categories.filter((c) => c.visible), input, (c) => this.categoryHit(q, c)),
    ].filter((g): g is common.DeptSearchGroup => Boolean(g));
    return { groups };
  }

  private appHit(q: string, a: AppCard): common.DeptSearchHit {
    return {
      id: a.id,
      kind: 'app',
      title: a.title,
      meta: line(stars(a.rating, a.ratingCount), a.category.name, a.sizeLabel),
      sub: a.brief,
      image: a.icon ?? null,
      badge: a.owned ? 'Owned' : a.price.offPercent ? `−${a.price.offPercent}%` : null,
      badgeTone: a.owned ? 'brand' : 'deal',
      priceLabel: a.price.label,
      wasLabel: a.price.wasLabel ?? null,
      path: `/software/app/${a.slug}`,
      score: scoreOf(q, a.title, [a.company.name, a.brief, a.category.name]) || WEAK_MATCH,
    };
  }

  private packHit(q: string, p: PackCard): common.DeptSearchHit {
    return {
      id: p.id,
      kind: 'pack',
      title: p.name,
      meta: line(p.count === 1 ? '1 app' : `${p.count} apps`, p.savePercent ? `Save ${p.savePercent}%` : null, p.licenceLabel),
      sub: p.summary ?? null,
      image: p.apps[0]?.icon ?? null,
      badge: p.owned ? 'Owned' : null,
      badgeTone: 'brand',
      priceLabel: p.priceLabel,
      wasLabel: p.totalLabel,
      path: '/software?tab=deals',
      score: scoreOf(q, p.name, [p.summary, ...p.apps.map((a) => a.title)]),
    };
  }

  private categoryHit(q: string, c: SoftwareCategory): common.DeptSearchHit {
    return {
      id: c.id,
      kind: 'software_category',
      title: c.name,
      meta: c.appCount === 1 ? '1 app' : `${c.appCount.toLocaleString('en-US')} apps`,
      sub: null,
      image: null,
      badge: null,
      badgeTone: null,
      priceLabel: null,
      wasLabel: null,
      path: `/software/apps?category=${c.slug}`,
      score: scoreOf(q, c.name),
    };
  }
}
