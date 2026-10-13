import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { SettingsDb } from '../../spec/settings.js';
import type { DefinitionRecord, SettingsRepository } from './ports.js';
import { changeColumns, SEED_ACTOR, toChange, toFlag, toValue, type ChangeRow, type FlagRow, type ValueRow } from './records.js';

type DefinitionRow = SettingsDb['definitions'];
type ChangeKeyRow = SettingsDb['change_keys'];

/** MongoDB adapter for SettingsRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoSettingsRepository(store: ModuleStore): SettingsRepository {
  const t = {
    definitions: store.table<DefinitionRow>('definitions'),
    values: store.table<ValueRow>('values'),
    changes: store.table<ChangeRow>('changes'),
    changeKeys: store.table<ChangeKeyRow>('change_keys'),
    flags: store.table<FlagRow>('feature_flags'),
  };

  const repo: SettingsRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoSettingsRepository(tx))),

    /* ---------------------------------------------------------------- definitions */

    async upsertDefinitions(defs: DefinitionRecord[], at: Date) {
      // registered_at stays as first written; every other field is refreshed and the definition is available again
      await t.definitions.upsertMany(
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
    },

    markUnavailableExcept: (keys, at) => t.definitions.updateMany({ unavailable_since: null, ...(keys.length ? { key: { $nin: keys } } : {}) }, { unavailable_since: at }),

    /* ---------------------------------------------------------------- values */

    openValues: async () => (await t.values.find({ effective_to: null })).map(toValue),

    async valueAt(key, at) {
      const r = await t.values.findOne({ key, effective_from: { $lte: at }, $or: [{ effective_to: null }, { effective_to: { $gt: at } }] }, { sort: { effective_from: -1, version: -1 } });
      return r ? toValue(r) : null;
    },

    async openValue(key, opts = {}) {
      const r = await t.values.findOne({ key, effective_to: null }, { sort: { version: -1 }, forUpdate: opts.forUpdate });
      return r ? toValue(r) : null;
    },

    async latestVersion(key) {
      return (await t.values.findOne({ key }, { sort: { version: -1 } }))?.version ?? 0;
    },

    recentValues: async (key, limit) => (await t.values.find({ key }, { sort: { version: -1 }, limit })).map(toValue),

    async pageValues(key, page) {
      const p = await t.values.page({ key }, page, { column: 'created_at', direction: 'desc' });
      return { ...p, items: p.items.map(toValue) };
    },

    async lastChangeAmong(keys) {
      if (!keys.length) return null;
      // != in SQL also skips rows whose changed_by_id is null
      const r = await t.values.findOne({ key: { $in: keys }, changed_by_id: { $nin: [SEED_ACTOR.id, null] } }, { sort: { created_at: -1, version: -1 } });
      return r ? toValue(r) : null;
    },

    async closeValue(id, at) {
      await t.values.update(id, { effective_to: at });
    },

    async insertValue(v) {
      await t.values.insert({
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
    },

    /* ---------------------------------------------------------------- changes */

    async insertChange(c) {
      await t.changes.insert({
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
    },

    async getChange(id, opts = {}) {
      const r = await t.changes.get(id, opts);
      return r ? toChange(r) : null;
    },

    async getChangeByApprovalRequest(requestId, opts = {}) {
      const r = await t.changes.findOne({ approval_request_id: requestId }, { sort: { created_at: -1 }, forUpdate: opts.forUpdate });
      return r ? toChange(r) : null;
    },

    async updateChange(id, patch) {
      const r = await t.changes.update(id, { $set: changeColumns(patch), $inc: { version: 1 } });
      if (!r) throw new Error(`settings: change ${id} not found`);
      return toChange(r);
    },

    async listChanges(filter, page) {
      const p = await t.changes.page(
        {
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.key ? { 'items.key': filter.key } : {}),
          ...(filter.keys ? { $and: [{ 'items.key': { $in: filter.keys } }] } : {}),
        },
        page,
        { column: 'created_at', direction: 'desc' },
      );
      return { ...p, items: p.items.map(toChange) };
    },

    openChanges: async () => (await t.changes.find({ status: { $in: ['pending_approval', 'scheduled'] } }, { sort: { effective_at: 1, id: 1 } })).map(toChange),

    dueChanges: async (now, limit) => (await t.changes.find({ status: 'scheduled', effective_at: { $lte: now } }, { sort: { effective_at: 1, id: 1 }, limit })).map(toChange),

    /* ---------------------------------------------------------------- change keys */

    async keyConflicts(keys, exceptChangeId) {
      if (!keys.length) return [];
      const open = await t.changeKeys.find({ open: true, key: { $in: keys }, ...(exceptChangeId ? { change_id: { $ne: exceptChangeId } } : {}) });
      const refs = new Map((await t.changes.getMany([...new Set(open.map((k) => k.change_id))])).map((c) => [c.id, c.ref]));
      return open.filter((k) => refs.has(k.change_id)).map((k) => ({ key: k.key, changeId: k.change_id, ref: refs.get(k.change_id)! }));
    },

    async claimKeys(changeId, keys) {
      if (!keys.length) return true;
      // one open change per key (unique key where open): a key another open change holds is not claimed
      const claimed = await t.changeKeys.insertManyIfAbsent(
        keys.map((key) => ({ change_id: changeId, key, open: true })),
        ['key', 'open'],
      );
      return claimed === keys.length;
    },

    async releaseKeys(changeId) {
      await t.changeKeys.updateMany({ change_id: changeId, open: true }, { open: false });
    },

    /* ---------------------------------------------------------------- feature flags */

    listFlags: async () => (await t.flags.find({}, { sort: { key: 1 } })).map(toFlag),

    async syncFlags(flags) {
      await t.flags.upsertMany(
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
    },

    async upsertFlag(f) {
      const row = await t.flags.upsert(
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
    },
  };
  return repo;
}
