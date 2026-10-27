/**
 * Integrated search across the ten departments (`GET /api/store/search/departments` and
 * `/departments/{key}`): the same query the product catalogue answers is asked of every department module at
 * once, and what they send back becomes one section per department, ranked against each other.
 *
 * Search owns none of these records: each module filters and shapes its own (one `DeptSearchHit` per record, with
 * the store path the app opens and the shared match score). A module that is switched off or not built yet is
 * simply absent; one that fails or takes longer than `departmentFanoutTimeoutMs` is left out and the answer says
 * `partial`, so the screen shows what did arrive instead of an error.
 */
import { isNotImplemented } from '../../../kernel/errors/index.js';
import type * as common from '../../../spec/common.js';
import type { DepartmentResults, DepartmentSection, DepartmentShortcut, DepartmentSuggestGroup } from '../../../spec/search.js';
import { BY_KEY, DEPARTMENTS, RAIL_ORDER, SECTION_OF_KIND, departmentsNamed, modulesFor, sectionsOfModule, type DepartmentDef, type SectionKey, type SectionModule } from '../domain/departments.js';
import { SearchIndexer } from './indexer.js';

/** What one module sent back, and whether it was able to answer at all. */
interface ModuleAnswer {
  groups: common.DeptSearchGroup[];
  failed: boolean;
}

const EMPTY: ModuleAnswer = { groups: [], failed: false };

/** The best match of a section: how sections of different departments are ranked against each other. */
const bestScore = (s: DepartmentSection): number => Math.max(0, ...s.groups.flatMap((g) => g.items.map((i) => i.score)));

export class SearchDepartments extends SearchIndexer {
  /**
   * One section per department with matches, best match first, plus a shortcut for a department the query names
   * but that has no matching record of its own (so Booking and Daily rewards answer their own name).
   */
  async departmentResults(q: string, limit?: number): Promise<DepartmentResults> {
    const query = q.trim();
    const per = limit ?? (await this.setting('departmentSectionLimit'));
    if (!query || !(await this.setting('departmentSearch'))) return { query: q, total: 0, sections: [], shortcuts: [], partial: false };

    const answers = await this.ask(DEPARTMENTS.map((d) => d.key), { q: query, limit: per });
    const sections = this.sectionsOf(answers.groups);
    const named = departmentsNamed(query);
    const shortcuts: DepartmentShortcut[] = named.filter((d) => !sections.some((s) => s.key === d.key)).map(shortcutOf);
    return {
      query: q,
      total: sections.reduce((n, s) => n + s.total, 0),
      sections,
      shortcuts,
      partial: answers.failed,
    };
  }

  /** One department's own results, each group paged on its own (the scoped list behind a department's chip). */
  async departmentSection(key: string, q: string, opts: { kind?: string; cursor?: string; limit?: number } = {}): Promise<DepartmentSection | null> {
    const def = BY_KEY.get(key as SectionKey);
    if (!def) return null;
    const query = q.trim();
    const per = opts.limit ?? (await this.setting('departmentScopeLimit'));
    const empty: DepartmentSection = { key: def.key, name: def.name, icon: def.icon, path: def.path, total: 0, groups: [] };
    if (!query || !(await this.setting('departmentSearch'))) return empty;
    if (opts.kind && !def.kinds.includes(opts.kind)) return empty;

    const answers = await this.ask([def.key], {
      q: query,
      limit: per,
      ...(opts.kind ? { kinds: [opts.kind] } : {}),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    });
    return this.sectionsOf(answers.groups).find((s) => s.key === def.key) ?? empty;
  }

  /** The suggestions panel's department groups: a few hits per department while the customer is still typing. */
  async departmentSuggestions(q: string): Promise<DepartmentSuggestGroup[]> {
    const query = q.trim();
    if (!query || !(await this.setting('departmentSearch'))) return [];
    const per = await this.setting('departmentSuggestLimit');
    const answers = await this.ask(DEPARTMENTS.map((d) => d.key), { q: query, limit: per });
    return this.sectionsOf(answers.groups)
      .map((s) => ({
        key: s.key,
        name: s.name,
        icon: s.icon,
        path: s.path,
        total: s.total,
        items: s.groups
          .flatMap((g) => g.items)
          .sort((a, b) => b.score - a.score)
          .slice(0, per),
      }))
      .filter((g) => g.items.length);
  }

  /* ---------------------------------------------------------------- the fan-out */

  /** Asks every module that answers for these sections, all at once, and keeps what came back in time. */
  private async ask(keys: readonly SectionKey[], input: Omit<common.DeptSearchRequest, 'sections'>): Promise<ModuleAnswer> {
    const timeout = await this.setting('departmentFanoutTimeoutMs');
    const calls = modulesFor(keys).map(({ module, sections }) => this.askModule(module, { ...input, sections }, timeout));
    const answers = await Promise.all(calls);
    return { groups: answers.flatMap((a) => a.groups), failed: answers.some((a) => a.failed) };
  }

  /**
   * One module's answer. Off or not built yet (NOT_IMPLEMENTED) counts as no answer and not as a failure, the way
   * every other optional part of a search answer behaves; a failure or a timeout makes the results `partial`.
   */
  private async askModule(module: SectionModule, input: common.DeptSearchRequest, timeoutMs: number): Promise<ModuleAnswer> {
    const api = this.ctx.tryUse(module as never) as { [k: string]: (i: common.DeptSearchRequest) => Promise<common.DeptSearchResult> } | undefined;
    if (!api) return EMPTY;
    const fn = api[FUNCTION_OF[module]];
    if (typeof fn !== 'function') return EMPTY;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        fn.call(api, input),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
        }),
      ]);
      if (result === 'timeout') {
        this.ctx.log.warn({ module, q: input.q, timeoutMs }, 'search: a department took too long and was left out');
        return { groups: [], failed: true };
      }
      return { groups: result.groups ?? [], failed: false };
    } catch (err) {
      if (isNotImplemented(err)) return EMPTY;
      this.ctx.log.warn({ err, module, q: input.q }, 'search: a department could not answer');
      return { groups: [], failed: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** The modules' groups laid out as the screen's sections: best match first, then size, then the rail's order. */
  private sectionsOf(groups: readonly common.DeptSearchGroup[]): DepartmentSection[] {
    const byKey = new Map<SectionKey, common.DeptSearchGroup[]>();
    for (const g of groups) {
      if (!g.items?.length) continue;
      const key = SECTION_OF_KIND.get(g.kind);
      if (!key) continue;
      byKey.set(key, [...(byKey.get(key) ?? []), g]);
    }
    const sections = [...byKey].map(([key, list]) => {
      const def = BY_KEY.get(key)!;
      const order = (g: common.DeptSearchGroup) => {
        const i = def.kinds.indexOf(g.kind);
        return i < 0 ? def.kinds.length : i;
      };
      const ordered = [...list].sort((a, b) => order(a) - order(b));
      return {
        key: def.key,
        name: def.name,
        icon: def.icon,
        path: def.path,
        total: ordered.reduce((n, g) => n + g.total, 0),
        groups: ordered,
      } satisfies DepartmentSection;
    });
    return sections.sort((a, b) => bestScore(b) - bestScore(a) || b.total - a.total || (RAIL_ORDER.get(a.key) ?? 99) - (RAIL_ORDER.get(b.key) ?? 99));
  }
}

/** The public API function each module answers the integrated search with. */
const FUNCTION_OF: Record<SectionModule, string> = {
  departments: 'searchDepartments',
  software: 'searchSoftware',
  services: 'searchServices',
  food: 'searchFood',
  rewards: 'searchRewards',
};

const shortcutOf = (d: DepartmentDef): DepartmentShortcut => ({ key: d.key, name: d.name, icon: d.icon, path: d.path, tagline: d.tagline });

/** Kept for the tests: which sections a module answers for. */
export { sectionsOfModule };
