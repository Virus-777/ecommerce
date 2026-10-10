/**
 * Shared plumbing of the search service: context, time, settings, optional modules, audit, the category
 * tree and small helpers. The use cases build on it: base → indexer → queries → admin → SearchService.
 */
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import { dateInZone, zoneOffsetMs } from '../../../kernel/lib/clock.js';
import type { ModuleContext, PublicApiMap } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as common from '../../../spec/common.js';
import { FilterError } from '../domain/query.js';
import type { SearchEngine, SearchRepository } from '../ports.js';

export interface SearchServiceDeps {
  repo: SearchRepository;
  engine: SearchEngine;
  ctx: ModuleContext<'search'>;
}

/** Who acts: for events and audit entries */
export interface By {
  actor: common.Actor;
  requestId?: string;
}

export const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });

export interface CategoryNode {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  visible: boolean;
  comingSoon: boolean;
  position: number;
  children: string[];
}

/** The category tree from catalog (listCategories with hidden ones), in memory */
export class CategoryTree {
  readonly byId = new Map<string, CategoryNode>();
  readonly bySlug = new Map<string, CategoryNode>();
  readonly roots: string[] = [];

  constructor(categories: catalog.Category[]) {
    const walk = (list: catalog.Category[], parent: string | null) => {
      for (const c of [...list].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))) {
        const node: CategoryNode = { id: c.id, parentId: parent, name: c.name, slug: c.slug, visible: c.visible, comingSoon: c.comingSoon, position: c.position, children: [] };
        this.byId.set(c.id, node);
        this.bySlug.set(c.slug, node);
        if (parent) this.byId.get(parent)?.children.push(c.id);
        else this.roots.push(c.id);
        walk(c.children ?? [], c.id);
      }
    };
    walk(categories, null);
  }

  /** Root → category */
  path(id: string | null | undefined): CategoryNode[] {
    const out: CategoryNode[] = [];
    const seen = new Set<string>();
    let cur = id ? this.byId.get(id) : undefined;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.unshift(cur);
      cur = cur.parentId ? this.byId.get(cur.parentId) : undefined;
    }
    return out;
  }

  crumb = (n: CategoryNode) => ({ id: n.id, name: n.name, slug: n.slug });
}

export class SearchBase {
  constructor(protected readonly deps: SearchServiceDeps) {}

  protected get repo() {
    return this.deps.repo;
  }
  protected get engine() {
    return this.deps.engine;
  }
  protected get ctx() {
    return this.deps.ctx;
  }
  protected now() {
    return this.ctx.clock.now();
  }
  protected get catalog() {
    return this.ctx.use('catalog');
  }
  protected get offers() {
    return this.ctx.use('offers');
  }

  protected async setting<K extends 'pageSize' | 'typoSimilarityThreshold' | 'autoCorrectBelowResults' | 'recentSearchesMax' | 'recentSearchRetentionDays' | 'newArrivalsWindowDays' | 'bestSellingMinOrders' | 'transitBusinessDays' | 'excludeOutOfStockByDefault' | 'searchEngine'>(key: K) {
    return this.ctx.settings.get(key);
  }

  /**
   * Calls an optional module (or a dependency for an optional part of an answer). Off, not built yet or
   * failing → undefined, and the related fields stay empty (spec: "with any of them off, the related fields
   * are simply empty").
   */
  protected async optional<M extends keyof PublicApiMap, R>(module: M, what: string, fn: (api: PublicApiMap[M]) => Promise<R>): Promise<R | undefined> {
    const api = (module === 'catalog' || module === 'offers' ? this.ctx.use(module as never) : this.ctx.tryUse(module as never)) as PublicApiMap[M] | undefined;
    if (!api) return undefined;
    try {
      return await fn(api);
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err, module, what }, `search: ${module} could not answer (${what})`);
      return undefined;
    }
  }

  /** Audited endpoints (synonyms, reindex, ranking policy): written to the action history when audit is enabled */
  protected async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: By) {
    await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId });
  }

  protected filterError(err: unknown): never {
    if (err instanceof FilterError) throw this.ctx.error('INVALID_FILTER', err.message, { filter: err.filter });
    throw err;
  }

  protected async categoryTree(): Promise<CategoryTree> {
    return new CategoryTree((await this.optional('catalog', 'category tree', (c) => c.listCategories({ includeHidden: true }))) ?? []);
  }

  /** Market wall-clock time HH:mm (same-day dispatch cutoffs) */
  protected marketTime(at = this.now()): string {
    const local = new Date(at.getTime() + zoneOffsetMs(at, this.ctx.config.market.timeZone));
    return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
  }

  protected marketDate(at = this.now()): string {
    return dateInZone(at, this.ctx.config.market.timeZone);
  }
}
