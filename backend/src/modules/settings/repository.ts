import type { PageRequest } from '../../kernel/lib/pagination.js';
import { orThrow } from '../../kernel/lib/or-throw.js';
import { inc, type Store } from '../../kernel/store/index.js';
import type { Page } from '../../spec/common.js';
import type { SettingsDb } from '../../spec/settings.js';
import {
  changeColumns,
  SEED_ACTOR,
  toChange,
  toFlag,
  toValue,
  type ChangeFilter,
  type ChangePatch,
  type ChangeRecord,
  type ChangeRow,
  type DefinitionRecord,
  type FlagRecord,
  type FlagRow,
  type ValueRecord,
  type ValueRow,
} from './records.js';

type DefinitionRow = SettingsDb['definitions'];
type ChangeKeyRow = SettingsDb['change_keys'];

/**
 * settings.definitions, settings.values, settings.changes, settings.change_keys, settings.feature_flags.
 *
 * Written against `Store` (kernel/store/index.ts) and so in the one vocabulary both databases understand:
 * this module's data is in MySQL or in MongoDB depending on `MYSQL_MODULES`, and nothing here knows which
 * (docs/10-mysql-migration.md §10.5a). The conditions are `{ column: value | list | { op, value } }` with
 * `or` for alternatives; `items[].key` is a path into a JSON array; and a version bump is `inc`, which the
 * server computes, rather than a value this process read and wrote back.
 */
export class SettingsRepository {
  readonly #t;

  constructor(private readonly store: Store) {
    this.#t = {
      definitions: store.table<DefinitionRow>('definitions'),
      values: store.table<ValueRow>('values'),
      changes: store.table<ChangeRow>('changes'),
      changeKeys: store.table<ChangeKeyRow>('change_keys'),
      flags: store.table<FlagRow>('feature_flags'),
    };
  }

  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: SettingsRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new SettingsRepository(tx)));
  }

  /* ---------------------------------------------------------------- definitions */

  /** Insert or refresh definitions (registered_at kept; unavailable_since cleared) */
  async upsertDefinitions(defs: DefinitionRecord[], at: Date): Promise<void> {
    // registered_at stays as first written; every other field is refreshed and the definition is available again
    await this.#t.definitions.upsertMany(
      defs.map((d) => ({
        key: d.key,
        module: d.module,
        section: d.section,
        label: d.label,
        description: d.description,
        value_type: d.valueType,
        schema: d.schema,
        default_value: d.default,
        editable: d.editable,
        approval: d.approval,
        min_lead_days: d.minLeadDays,
        apply_scopes: d.applyScopes,
        seller_visible: d.sellerVisible,
        public: d.public,
        example_value: d.exampleValue,
        edit_permission: d.editPermission,
        registered_at: at,
        unavailable_since: null,
      })),
      { update: ({ key: _key, registered_at: _registered, ...rest }) => rest },
    );
  }

  /** Mark every definition not in `keys` unavailable (module disabled), once */
  markUnavailableExcept(keys: string[], at: Date): Promise<number> {
    // "not in" an empty list leaves the column unfiltered, which is what no keys at all means: every one of them
    return this.#t.definitions.updateMany({ unavailable_since: null, key: { op: 'not in', value: keys } }, { unavailable_since: at });
  }

  /* ---------------------------------------------------------------- values */

  /** Versions in force or last written per key (effective_to is null) */
  async openValues(): Promise<ValueRecord[]> {
    return (await this.#t.values.find({ effective_to: null })).map(toValue);
  }

  async valueAt(key: string, at: Date): Promise<ValueRecord | null> {
    const r = await this.#t.values.findOne(
      { key, effective_from: { op: '<=', value: at }, or: [{ effective_to: null }, { effective_to: { op: '>', value: at } }] },
      { sort: { effective_from: -1, version: -1 } },
    );
    return r ? toValue(r) : null;
  }

  async openValue(key: string, opts: { forUpdate?: boolean } = {}): Promise<ValueRecord | null> {
    const r = await this.#t.values.findOne({ key, effective_to: null }, { sort: { version: -1 }, forUpdate: opts.forUpdate });
    return r ? toValue(r) : null;
  }

  async latestVersion(key: string): Promise<number> {
    return (await this.#t.values.findOne({ key }, { sort: { version: -1 } }))?.version ?? 0;
  }

  async recentValues(key: string, limit: number): Promise<ValueRecord[]> {
    return (await this.#t.values.find({ key }, { sort: { version: -1 }, limit })).map(toValue);
  }

  async pageValues(key: string, page: PageRequest): Promise<Page<ValueRecord>> {
    const p = await this.#t.values.page({ key }, page, { column: 'created_at', direction: 'desc' });
    return { ...p, items: p.items.map(toValue) };
  }

  /** Latest version written by a person (not the boot seed) among keys */
  async lastChangeAmong(keys: string[]): Promise<ValueRecord | null> {
    if (!keys.length) return null;
    // `<>` never matches a null changed_by_id either, on either store (kernel/mongo/filters.ts)
    const r = await this.#t.values.findOne({ key: keys, changed_by_id: { op: '<>', value: SEED_ACTOR.id } }, { sort: { created_at: -1, version: -1 } });
    return r ? toValue(r) : null;
  }

  async closeValue(id: string, at: Date): Promise<void> {
    await this.#t.values.update(id, { effective_to: at });
  }

  async insertValue(v: ValueRecord): Promise<void> {
    await this.#t.values.insert({
      id: v.id,
      key: v.key,
      version: v.version,
      value: v.value,
      effective_from: v.effectiveFrom,
      effective_to: v.effectiveTo,
      apply_scope: v.applyScope,
      change_id: v.changeId,
      changed_by_kind: v.changedBy.kind,
      changed_by_id: v.changedBy.id,
      approved_by_id: v.approvedById,
      reason: v.reason,
      created_at: v.createdAt,
    });
  }

  /* ---------------------------------------------------------------- changes */

  async insertChange(c: ChangeRecord): Promise<void> {
    await this.#t.changes.insert({
      id: c.id,
      ref: c.ref,
      status: c.status,
      items: c.items,
      effective_at: c.effectiveAt,
      apply_scope: c.applyScope,
      reason: c.reason,
      impact: c.meta,
      created_by_kind: c.createdByKind,
      created_by_id: c.createdById,
      created_at: c.createdAt,
      submitted_at: c.submittedAt,
      approval_request_id: c.approvalRequestId,
      applied_at: c.appliedAt,
      cancel_reason: c.cancelReason,
      version: c.version,
      announced_at: c.announcedAt,
    });
  }

  async getChange(id: string, opts: { forUpdate?: boolean } = {}): Promise<ChangeRecord | null> {
    const r = await this.#t.changes.get(id, opts);
    return r ? toChange(r) : null;
  }

  async getChangeByApprovalRequest(requestId: string, opts: { forUpdate?: boolean } = {}): Promise<ChangeRecord | null> {
    const r = await this.#t.changes.findOne({ approval_request_id: requestId }, { sort: { created_at: -1 }, forUpdate: opts.forUpdate });
    return r ? toChange(r) : null;
  }

  /** Applies the patch and bumps the row version */
  async updateChange(id: string, patch: ChangePatch): Promise<ChangeRecord> {
    return toChange(orThrow(await this.#t.changes.update(id, { ...changeColumns(patch), version: inc('version', 1) }), `settings: change ${id}`));
  }

  async listChanges(filter: ChangeFilter, page: PageRequest): Promise<Page<ChangeRecord>> {
    // a key, and the keys of a section: both ask "is some item of this change about that key", which is what a
    // [] path asks of a JSON array. Two conditions on one name, so they go in `and` — a caller may give both
    // (?key= and ?section=), and then a change has to be about the key and about something in the section.
    const p = await this.#t.changes.page(
      {
        ...(filter.status ? { status: filter.status } : {}),
        and: [...(filter.key ? [{ 'items[].key': filter.key }] : []), ...(filter.keys ? [{ 'items[].key': filter.keys }] : [])],
      },
      page,
      { column: 'created_at', direction: 'desc' },
    );
    return { ...p, items: p.items.map(toChange) };
  }

  /** pending_approval and scheduled changes, soonest first */
  async openChanges(): Promise<ChangeRecord[]> {
    return (await this.#t.changes.find({ status: ['pending_approval', 'scheduled'] }, { sort: { effective_at: 1, id: 1 } })).map(toChange);
  }

  /** Scheduled changes whose effective time has come, oldest first */
  async dueChanges(now: Date, limit: number): Promise<ChangeRecord[]> {
    return (await this.#t.changes.find({ status: 'scheduled', effective_at: { op: '<=', value: now } }, { sort: { effective_at: 1, id: 1 }, limit })).map(toChange);
  }

  /* ---------------------------------------------------------------- change keys (one open change per key) */

  /** Open changes (other than `exceptChangeId`) that touch any of the keys */
  async keyConflicts(keys: string[], exceptChangeId?: string): Promise<{ key: string; changeId: string; ref: string }[]> {
    if (!keys.length) return [];
    // `is not` is "is distinct from", which is what excluding one change means: every row but that one
    const open = await this.#t.changeKeys.find({ open: true, key: keys, ...(exceptChangeId ? { change_id: { op: 'is not', value: exceptChangeId } } : {}) });
    const refs = new Map((await this.#t.changes.getMany([...new Set(open.map((k) => k.change_id))])).map((c) => [c.id, c.ref]));
    return open.filter((k) => refs.has(k.change_id)).map((k) => ({ key: k.key, changeId: k.change_id, ref: refs.get(k.change_id)! }));
  }

  /** Claims the keys for a change; false when another open change holds one */
  async claimKeys(changeId: string, keys: string[]): Promise<boolean> {
    if (!keys.length) return true;
    // One open change per key, which the table's unique key *where open* is what enforces. Naming no key is
    // what says "unless a unique index refuses it": each store then asks its own index, which is the only way
    // this reads the same on both. Naming (key, open) would be a MongoDB upsert filter, and no key of the
    // table at all — a partial unique index is on (key), with the open rows being the ones it covers.
    const claimed = await this.#t.changeKeys.insertManyIfAbsent(keys.map((key) => ({ change_id: changeId, key, open: true })));
    return claimed === keys.length;
  }

  async releaseKeys(changeId: string): Promise<void> {
    await this.#t.changeKeys.updateMany({ change_id: changeId, open: true }, { open: false });
  }

  /* ---------------------------------------------------------------- feature flags */

  async listFlags(): Promise<FlagRecord[]> {
    return (await this.#t.flags.find({}, { sort: { key: 1 } })).map(toFlag);
  }

  /** Inserts missing flags off, refreshes descriptive fields of existing ones (state untouched) */
  async syncFlags(flags: Omit<FlagRecord, 'enabled' | 'rollout' | 'percentage' | 'updatedBy' | 'updatedAt'>[]): Promise<void> {
    await this.#t.flags.upsertMany(
      flags.map((f) => ({
        key: f.key,
        module: f.module,
        label: f.label,
        description: f.description,
        enabled: false,
        rollout: 'everyone',
        percentage: null,
        public: f.public,
        planned_phase: f.plannedPhase,
        updated_by: null,
        updated_at: null,
      })),
      { update: (r) => ({ module: r.module, label: r.label, description: r.description, public: r.public, planned_phase: r.planned_phase }) },
    );
  }

  async upsertFlag(f: FlagRecord): Promise<FlagRecord> {
    const row = await this.#t.flags.upsert(
      {
        key: f.key,
        module: f.module,
        label: f.label,
        description: f.description,
        enabled: f.enabled,
        rollout: f.rollout,
        percentage: f.percentage,
        public: f.public,
        planned_phase: f.plannedPhase,
        updated_by: f.updatedBy,
        updated_at: f.updatedAt,
      },
      { update: { enabled: f.enabled, rollout: f.rollout, percentage: f.percentage, updated_by: f.updatedBy, updated_at: f.updatedAt } },
    );
    return toFlag(row);
  }
}
