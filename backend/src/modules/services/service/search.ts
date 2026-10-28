/**
 * Services in the integrated search (search module's `GET /api/store/search/departments`): the published services,
 * providers and categories of each area that match what the customer typed, as ranked hits with the store path
 * each one opens.
 *
 * Every group carries its area, because search lays them out under different departments: `os_install` and
 * `post_sale` belong to the Phones department (its own tabs), `welfare` and `booking` are departments of their
 * own. Each group is the area's own `q` list, so a hit reads exactly like the card those screens show.
 */
import { groupFrom, groupFromList, groupPage, line, scoreOf, stars, wanted, WEAK_MATCH } from '../../../kernel/lib/dept-search.js';
import type * as common from '../../../spec/common.js';
import type { ProviderCard, ServiceCard, ServiceCategory } from '../../../spec/services.js';
import type { Viewer } from './catalog.js';
import { ServicesStatisticsPart } from './statistics.js';

/** Which areas answer for a section of the search screen, and how their hits are headed. */
const AREAS = {
  phones: ['os_install', 'post_sale'],
  welfare: ['welfare'],
  booking: ['booking'],
} as const;

const SERVICE_GROUP: Record<string, { kind: string; title: string }> = {
  os_install: { kind: 'os_install_service', title: 'OS install' },
  post_sale: { kind: 'post_sale_service', title: 'Post-sale repairs' },
  welfare: { kind: 'welfare_service', title: 'Services' },
  booking: { kind: 'booking_service', title: 'Services' },
};

const PROVIDER_GROUP: Record<string, { kind: string; title: string }> = {
  welfare: { kind: 'welfare_provider', title: 'Providers' },
  booking: { kind: 'booking_provider', title: 'Providers' },
};

const CATEGORY_GROUP: Record<string, { kind: string; title: string }> = {
  welfare: { kind: 'welfare_category', title: 'Categories' },
  booking: { kind: 'booking_category', title: 'Categories' },
};

/** The service page each area opens (the Phones department shows its services in its own tabs). */
const servicePath = (area: string, slug: string): string =>
  area === 'os_install' ? `/phones/os-install/${slug}` : area === 'post_sale' ? `/phones/post-sale/${slug}` : area === 'welfare' ? `/welfare/${slug}` : `/booking/${slug}`;

const priceOf = (s: ServiceCard): string | null => {
  if (s.priceUnit === 'free' || !s.fromPrice) return s.priceUnit === 'free' ? 'Free' : null;
  const amount = `$${(s.fromPrice.amount / 100).toFixed(2)}`;
  return s.priceUnit === 'hour' ? `${amount}/hr` : s.priceUnit === 'visit' ? `${amount}/visit` : s.priceUnit === 'night' ? `${amount}/night` : amount;
};

export class ServicesSearchPart extends ServicesStatisticsPart {
  /** Public API (search): services, providers and categories of the asked-for sections matching the typed text. */
  async searchServices(input: common.DeptSearchRequest): Promise<common.DeptSearchResult> {
    const q = input.q.trim();
    if (!q) return { groups: [] };
    const sections = input.sections?.length ? input.sections.filter((s): s is keyof typeof AREAS => s in AREAS) : (Object.keys(AREAS) as (keyof typeof AREAS)[]);
    const areas = [...new Set(sections.flatMap((s) => [...AREAS[s]]))];
    const viewer = await this.viewerOf(input.customerId ?? null);
    const groups = (await Promise.all(areas.map((area) => this.areaGroups(q, area, input, viewer)))).flat();
    return { groups };
  }

  private async areaGroups(q: string, area: string, input: common.DeptSearchRequest, viewer: Viewer): Promise<common.DeptSearchGroup[]> {
    const service = SERVICE_GROUP[area];
    const provider = PROVIDER_GROUP[area];
    const category = CATEGORY_GROUP[area];
    const page = groupPage(input);
    const [services, providers, categories] = await Promise.all([
      service && wanted(input, service.kind) ? this.listServices({ area, q }, page, viewer) : null,
      provider && wanted(input, provider.kind) ? this.listProviders({ area, q }, page, viewer) : null,
      category && wanted(input, category.kind) ? this.listCategories({ area }) : null,
    ]);
    return [
      services && service && groupFrom(service.kind, service.title, services, (s) => this.serviceHit(q, s, area), { area }),
      providers && provider && groupFrom(provider.kind, provider.title, providers, (p) => this.providerHit(q, p, area), { area }),
      categories && category && groupFromList(category.kind, category.title, categories, input, (c) => this.categoryHit(q, c, area), { area }),
    ].filter((g): g is common.DeptSearchGroup => Boolean(g));
  }

  private serviceHit(q: string, s: ServiceCard, area: string): common.DeptSearchHit {
    return {
      id: s.id,
      kind: SERVICE_GROUP[area]!.kind,
      title: s.title,
      meta: line(s.provider.name, s.durationLabel, stars(s.rating.average, s.rating.count)),
      sub: line(s.distance, s.coverage ?? s.supportedLabel),
      image: s.image ?? null,
      badge: s.coveredByWarranty ? 'Covered' : (s.badge ?? null),
      badgeTone: s.coveredByWarranty ? 'brand' : 'neutral',
      priceLabel: priceOf(s),
      wasLabel: null,
      path: servicePath(area, s.slug),
      score: scoreOf(q, s.title, [s.summary, s.provider.name, s.category?.name, s.supportedLabel, ...s.tags]) || WEAK_MATCH,
    };
  }

  private providerHit(q: string, p: ProviderCard, area: string): common.DeptSearchHit {
    return {
      id: p.id,
      kind: PROVIDER_GROUP[area]!.kind,
      title: p.name,
      meta: line(p.kind, p.category?.name, p.city),
      sub: line(p.openLabel, p.distance, p.nextFree),
      image: p.logo ?? p.cover ?? null,
      badge: p.verified ? 'Verified' : null,
      badgeTone: 'info',
      priceLabel: stars(p.rating.average, p.rating.count),
      wasLabel: null,
      path: `/providers/${p.slug}?area=${area}`,
      score: scoreOf(q, p.name, [p.kind, p.category?.name, p.city, p.address]) || WEAK_MATCH,
    };
  }

  private categoryHit(q: string, c: ServiceCategory, area: string): common.DeptSearchHit {
    return {
      id: c.id,
      kind: CATEGORY_GROUP[area]!.kind,
      title: c.name,
      meta: c.serviceCount === 1 ? '1 service' : `${c.serviceCount.toLocaleString('en-US')} services`,
      sub: null,
      image: null,
      badge: null,
      badgeTone: null,
      priceLabel: null,
      wasLabel: null,
      path: `/${area === 'booking' ? 'booking' : 'welfare'}?category=${c.slug}`,
      score: scoreOf(q, c.name),
    };
  }
}
