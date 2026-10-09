/**
 * Saved filters, personal or shared. target=work_items filters this module's item list (with a live
 * count of matching open items); target=screen stores a filter for another module's list screen.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { SavedFilter, SavedFilterInput } from '../../../spec/workqueues.js';
import type { SavedFilterRow } from '../ports.js';
import type { Core, Viewer } from './core.js';
import type { FilterInput, Items } from './items.js';

const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });

export class Filters {
  constructor(
    private readonly core: Core,
    private readonly items: Items,
  ) {}

  get repo() {
    return this.core.repo;
  }

  async #views(v: Viewer, rows: SavedFilterRow[]): Promise<SavedFilter[]> {
    const refs = await this.core.staffRefs(rows.map((r) => r.owner_staff_id));
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        name: r.name,
        owner: refs.get(r.owner_staff_id)!,
        shared: r.shared,
        target: r.target as SavedFilter['target'],
        screen: r.screen,
        screenState: r.screen_state,
        filters: r.filters ?? {},
        count: r.target === 'work_items' ? await this.items.count(v, (r.filters ?? {}) as FilterInput) : null,
        createdAt: r.created_at.toISOString(),
      })),
    );
  }

  async list(v: Viewer, screen?: string): Promise<SavedFilter[]> {
    await this.core.ensureSeeded();
    const rows = (await this.repo.listSavedFilters(v.staffId)).filter((r) => !screen || r.screen === screen);
    return this.#views(v, rows);
  }

  async #validate(v: Viewer, input: SavedFilterInput): Promise<Record<string, unknown>> {
    if (!input.name?.trim()) throw invalid('name', 'A name is required');
    if (input.target !== 'work_items' && input.target !== 'screen') throw invalid('target', 'Use work_items or screen');
    if (input.target === 'screen' && !input.screen?.trim()) throw invalid('screen', 'Say which screen this filter is for');
    const filters = input.filters ?? {};
    if (typeof filters !== 'object' || Array.isArray(filters)) throw invalid('filters', 'Filters are the query parameters as an object');
    if (input.target === 'work_items') await this.items.toQuery(v, filters as FilterInput, await this.repo.listQueues());
    return filters as Record<string, unknown>;
  }

  async create(v: Viewer, input: SavedFilterInput): Promise<SavedFilter> {
    const filters = await this.#validate(v, input);
    const row: SavedFilterRow = {
      id: newId(),
      owner_staff_id: v.staffId,
      name: input.name.trim(),
      shared: input.shared ?? false,
      target: input.target,
      screen: input.screen?.trim() || null,
      screen_state: input.screenState ?? null,
      filters: filters as never,
      created_at: this.core.now(),
    };
    await this.repo.insertSavedFilter(row);
    return (await this.#views(v, [row]))[0]!;
  }

  async #own(v: Viewer, id: string): Promise<SavedFilterRow> {
    const row = await this.repo.getSavedFilter(id);
    if (!row || (row.owner_staff_id !== v.staffId && !row.shared)) throw new AppError('NOT_FOUND', 'Saved filter not found');
    if (row.owner_staff_id !== v.staffId) throw new AppError('FORBIDDEN', 'Only the owner can change a saved filter');
    return row;
  }

  async update(v: Viewer, id: string, input: SavedFilterInput): Promise<SavedFilter> {
    await this.#own(v, id);
    const filters = await this.#validate(v, input);
    const row = await this.repo.updateSavedFilter(id, {
      name: input.name.trim(),
      shared: input.shared ?? false,
      target: input.target,
      screen: input.screen?.trim() || null,
      screen_state: input.screenState ?? null,
      filters: filters as never,
    });
    return (await this.#views(v, [row]))[0]!;
  }

  async remove(v: Viewer, id: string): Promise<void> {
    await this.#own(v, id);
    await this.repo.deleteSavedFilter(id);
  }
}
