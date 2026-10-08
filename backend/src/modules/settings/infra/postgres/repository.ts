import { sql, type Kysely, type Selectable } from 'kysely';
import type { Json } from '../../../../kernel/db/types.js';
import { paginate, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type { SettingsDb } from '../../../../spec/settings.js';
import type { ChangeFilter, ChangeMeta, ChangePatch, ChangeRecord, DefinitionRecord, FlagRecord, SettingsRepository, ValueRecord } from '../../ports.js';

type ValueRow = Selectable<SettingsDb['values']>;
type ChangeRow = Selectable<SettingsDb['changes']>;
type FlagRow = Selectable<SettingsDb['feature_flags']>;

/** jsonb parameters go as JSON text (arrays would otherwise be sent as Postgres arrays) */
const json = (v: unknown): Json => JSON.stringify(v ?? null);

/** Who wrote the boot seed of market defaults */
export const SEED_ACTOR = { kind: 'system', id: 'settings.seed' } as const;

const toValue = (r: ValueRow): ValueRecord => ({
  id: r.id,
  key: r.key,
  version: r.version,
  value: r.value,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  applyScope: r.apply_scope as ValueRecord['applyScope'],
  changeId: r.change_id,
  changedBy: { kind: r.changed_by_kind, id: r.changed_by_id },
  approvedById: r.approved_by_id,
  reason: r.reason,
  createdAt: r.created_at,
});

const toChange = (r: ChangeRow): ChangeRecord => ({
  id: r.id,
  ref: r.ref,
  status: r.status as ChangeRecord['status'],
  items: r.items as unknown as ChangeRecord['items'],
  effectiveAt: r.effective_at,
  applyScope: r.apply_scope as ChangeRecord['applyScope'],
  reason: r.reason,
  meta: r.impact as unknown as ChangeMeta,
  createdByKind: r.created_by_kind,
  createdById: r.created_by_id,
  createdAt: r.created_at,
  submittedAt: r.submitted_at,
  approvalRequestId: r.approval_request_id,
  appliedAt: r.applied_at,
  cancelReason: r.cancel_reason,
  version: r.version,
  announcedAt: r.announced_at,
});

const toFlag = (r: FlagRow): FlagRecord => ({
  key: r.key,
  module: r.module,
  label: r.label,
  description: r.description,
  enabled: r.enabled,
  rollout: r.rollout as FlagRecord['rollout'],
  percentage: r.percentage,
  public: r.public,
  plannedPhase: r.planned_phase,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});

const changeColumns = (p: ChangePatch) => {
  const out: Partial<Record<keyof ChangeRow, unknown>> = {};
  if (p.status !== undefined) out.status = p.status;
  if (p.items !== undefined) out.items = json(p.items);
  if (p.effectiveAt !== undefined) out.effective_at = p.effectiveAt;
  if (p.applyScope !== undefined) out.apply_scope = p.applyScope;
  if (p.reason !== undefined) out.reason = p.reason;
  if (p.meta !== undefined) out.impact = json(p.meta);
  if (p.submittedAt !== undefined) out.submitted_at = p.submittedAt;
  if (p.approvalRequestId !== undefined) out.approval_request_id = p.approvalRequestId;
  if (p.appliedAt !== undefined) out.applied_at = p.appliedAt;
  if (p.cancelReason !== undefined) out.cancel_reason = p.cancelReason;
  if (p.announcedAt !== undefined) out.announced_at = p.announcedAt;
  return out;
};

/** Postgres adapter for SettingsRepository. `db` is scoped to the `settings` schema. */
export function createPostgresSettingsRepository(db: Kysely<SettingsDb>): SettingsRepository {
  const repo: SettingsRepository = {
    transaction: (fn) => db.transaction().execute((trx) => fn(createPostgresSettingsRepository(trx))),

    /* ---------------------------------------------------------------- definitions */

    async upsertDefinitions(defs: DefinitionRecord[], at: Date) {
      if (!defs.length) return;
      const rows = defs.map((d) => ({
        key: d.key,
        module: d.module,
        section: d.section,
        label: d.label,
        description: d.description,
        value_type: d.valueType,
        schema: json(d.schema),
        default_value: json(d.default),
        editable: d.editable,
        approval: d.approval,
        min_lead_days: d.minLeadDays,
        apply_scopes: json(d.applyScopes),
        seller_visible: d.sellerVisible,
        public: d.public,
        example_value: d.exampleValue,
        edit_permission: d.editPermission,
        registered_at: at,
        unavailable_since: null,
      }));
      for (let i = 0; i < rows.length; i += 200) {
        await db
          .insertInto('definitions')
          .values(rows.slice(i, i + 200))
          .onConflict((oc) =>
            oc.column('key').doUpdateSet((eb) => ({
              module: eb.ref('excluded.module'),
              section: eb.ref('excluded.section'),
              label: eb.ref('excluded.label'),
              description: eb.ref('excluded.description'),
              value_type: eb.ref('excluded.value_type'),
              schema: eb.ref('excluded.schema'),
              default_value: eb.ref('excluded.default_value'),
              editable: eb.ref('excluded.editable'),
              approval: eb.ref('excluded.approval'),
              min_lead_days: eb.ref('excluded.min_lead_days'),
              apply_scopes: eb.ref('excluded.apply_scopes'),
              seller_visible: eb.ref('excluded.seller_visible'),
              public: eb.ref('excluded.public'),
              example_value: eb.ref('excluded.example_value'),
              edit_permission: eb.ref('excluded.edit_permission'),
              unavailable_since: null,
            })),
          )
          .execute();
      }
    },

    async markUnavailableExcept(keys, at) {
      let q = db.updateTable('definitions').set({ unavailable_since: at }).where('unavailable_since', 'is', null);
      if (keys.length) q = q.where('key', 'not in', keys);
      const r = await q.executeTakeFirst();
      return Number(r.numUpdatedRows);
    },

    /* ---------------------------------------------------------------- values */

    async openValues() {
      return (await db.selectFrom('values').selectAll().where('effective_to', 'is', null).execute()).map(toValue);
    },

    async valueAt(key, at) {
      const r = await db
        .selectFrom('values')
        .selectAll()
        .where('key', '=', key)
        .where('effective_from', '<=', at)
        .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', at)]))
        .orderBy('effective_from', 'desc')
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirst();
      return r ? toValue(r) : null;
    },

    async openValue(key, opts = {}) {
      let q = db.selectFrom('values').selectAll().where('key', '=', key).where('effective_to', 'is', null).orderBy('version', 'desc').limit(1);
      if (opts.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? toValue(r) : null;
    },

    async latestVersion(key) {
      const r = await db.selectFrom('values').select((eb) => eb.fn.max('version').as('v')).where('key', '=', key).executeTakeFirst();
      return Number(r?.v ?? 0);
    },

    async recentValues(key, limit) {
      return (await db.selectFrom('values').selectAll().where('key', '=', key).orderBy('version', 'desc').limit(limit).execute()).map(toValue);
    },

    async pageValues(key, page: PageRequest) {
      const p = await paginate(db.selectFrom('values').selectAll().where('key', '=', key), page, { column: 'created_at', direction: 'desc' });
      return { ...p, items: p.items.map(toValue) };
    },

    async lastChangeAmong(keys) {
      if (!keys.length) return null;
      const r = await db
        .selectFrom('values')
        .selectAll()
        .where('key', 'in', keys)
        .where('changed_by_id', '!=', SEED_ACTOR.id)
        .orderBy('created_at', 'desc')
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirst();
      return r ? toValue(r) : null;
    },

    async closeValue(id, at) {
      await db.updateTable('values').set({ effective_to: at }).where('id', '=', id).execute();
    },

    async insertValue(v) {
      await db
        .insertInto('values')
        .values({
          id: v.id,
          key: v.key,
          version: v.version,
          value: json(v.value),
          effective_from: v.effectiveFrom,
          effective_to: v.effectiveTo,
          apply_scope: v.applyScope,
          change_id: v.changeId,
          changed_by_kind: v.changedBy.kind,
          changed_by_id: v.changedBy.id,
          approved_by_id: v.approvedById,
          reason: v.reason,
          created_at: v.createdAt,
        })
        .execute();
    },

    /* ---------------------------------------------------------------- changes */

    async insertChange(c) {
      await db
        .insertInto('changes')
        .values({
          id: c.id,
          ref: c.ref,
          status: c.status,
          items: json(c.items),
          effective_at: c.effectiveAt,
          apply_scope: c.applyScope,
          reason: c.reason,
          impact: json(c.meta),
          created_by_kind: c.createdByKind,
          created_by_id: c.createdById,
          created_at: c.createdAt,
          submitted_at: c.submittedAt,
          approval_request_id: c.approvalRequestId,
          applied_at: c.appliedAt,
          cancel_reason: c.cancelReason,
          version: c.version,
          announced_at: c.announcedAt,
        })
        .execute();
    },

    async getChange(id, opts = {}) {
      let q = db.selectFrom('changes').selectAll().where('id', '=', id);
      if (opts.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? toChange(r) : null;
    },

    async getChangeByApprovalRequest(requestId, opts = {}) {
      let q = db.selectFrom('changes').selectAll().where('approval_request_id', '=', requestId).orderBy('created_at', 'desc').limit(1);
      if (opts.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? toChange(r) : null;
    },

    async updateChange(id, patch) {
      const r = await db
        .updateTable('changes')
        .set({ ...(changeColumns(patch) as object), version: sql<number>`version + 1` })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toChange(r);
    },

    async listChanges(filter: ChangeFilter, page) {
      let q = db.selectFrom('changes').selectAll();
      if (filter.status) q = q.where('status', '=', filter.status);
      if (filter.key) q = q.where(sql<boolean>`items @> ${json([{ key: filter.key }])}::jsonb`);
      if (filter.keys) {
        if (!filter.keys.length) q = q.where(sql<boolean>`false`);
        else q = q.where(sql<boolean>`exists (select 1 from jsonb_array_elements(items) as i where i->>'key' in (${sql.join(filter.keys)}))`);
      }
      const p = await paginate(q, page, { column: 'created_at', direction: 'desc' });
      return { ...p, items: p.items.map(toChange) };
    },

    async openChanges() {
      return (await db.selectFrom('changes').selectAll().where('status', 'in', ['pending_approval', 'scheduled']).orderBy('effective_at', 'asc').orderBy('id').execute()).map(toChange);
    },

    async dueChanges(now, limit) {
      return (
        await db.selectFrom('changes').selectAll().where('status', '=', 'scheduled').where('effective_at', '<=', now).orderBy('effective_at', 'asc').orderBy('id').limit(limit).execute()
      ).map(toChange);
    },

    /* ---------------------------------------------------------------- change keys */

    async keyConflicts(keys, exceptChangeId) {
      if (!keys.length) return [];
      let q = db
        .selectFrom('change_keys as k')
        .innerJoin('changes as c', 'c.id', 'k.change_id')
        .select(['k.key', 'k.change_id as changeId', 'c.ref'])
        .where('k.open', '=', true)
        .where('k.key', 'in', keys);
      if (exceptChangeId) q = q.where('k.change_id', '!=', exceptChangeId);
      return q.execute();
    },

    async claimKeys(changeId, keys) {
      if (!keys.length) return true;
      const r = await db
        .insertInto('change_keys')
        .values(keys.map((key) => ({ change_id: changeId, key, open: true })))
        .onConflict((oc) => oc.doNothing())
        .executeTakeFirst();
      return Number(r.numInsertedOrUpdatedRows ?? 0) === keys.length;
    },

    async releaseKeys(changeId) {
      await db.updateTable('change_keys').set({ open: false }).where('change_id', '=', changeId).where('open', '=', true).execute();
    },

    /* ---------------------------------------------------------------- feature flags */

    async listFlags() {
      return (await db.selectFrom('feature_flags').selectAll().orderBy('key').execute()).map(toFlag);
    },

    async syncFlags(flags) {
      if (!flags.length) return;
      await db
        .insertInto('feature_flags')
        .values(
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
        )
        .onConflict((oc) =>
          oc.column('key').doUpdateSet((eb) => ({
            module: eb.ref('excluded.module'),
            label: eb.ref('excluded.label'),
            description: eb.ref('excluded.description'),
            public: eb.ref('excluded.public'),
            planned_phase: eb.ref('excluded.planned_phase'),
          })),
        )
        .execute();
    },

    async upsertFlag(f) {
      const row = {
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
      };
      const r = await db
        .insertInto('feature_flags')
        .values(row)
        .onConflict((oc) =>
          oc.column('key').doUpdateSet({ enabled: f.enabled, rollout: f.rollout, percentage: f.percentage, updated_by: f.updatedBy, updated_at: f.updatedAt }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return toFlag(r);
    },
  };
  return repo;
}
