import { isIP } from 'node:net';
import { AppError, isAppError, isNotImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { Principal } from '../../kernel/auth/index.js';
import { isUuid, newId } from '../../kernel/lib/ids.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import { decodeCursor, encodeCursor, toPageRequest, type PageRequest } from '../../kernel/lib/pagination.js';
import { dateInZone } from '../../kernel/lib/clock.js';
import { secretFor } from '../../kernel/lib/secrets.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type * as reports from '../../spec/reports.js';
import {
  AuditFilters as AuditFiltersSchema,
  RecordInput as RecordInputSchema,
  type AuditEntry,
  type AuditFilters,
  type AuditPublicApi,
  type AuditSummary,
  type IntegrityStatus,
  type RecordInput,
  type RetentionPolicy,
  type RoleName,
  type SellerAuditEntry,
} from '../../spec/audit.js';
import { CHECKPOINT_KEY_ID, CHECKPOINT_PURPOSE, checkpointMac, checkpointMacOk, GENESIS_HASH, hashRow, normalizeTargets, sameBytes, toHex, verifyRows, type ChainRow } from './domain/chain.js';
import { cleanOptionalText, cleanText, redact } from './domain/redaction.js';
import {
  addDays,
  approvalOf,
  DATASET,
  dayWindow,
  decideRetention,
  DEFAULT_MAX_EXPORT_ROWS,
  nextPurgeAt,
  PURGE_ACTION,
  purgeCutoff,
  RETENTION_ACTION,
  RETENTION_TARGET,
  retentionEventFor,
  roleLabel,
  toSellerEntry,
  withName,
  withStep,
  type ApprovalProjection,
  type Category,
} from './domain/rules.js';
import { retentionChangeMachine } from './domain/state-machines.js';
import type { AuditRepository, CheckpointRow, EntryQuery, NewChainRow, RetentionRow } from './repository.js';
import { normalizeIp } from './text.js';

export interface AuditServiceDeps {
  repo: AuditRepository;
  ctx: ModuleContext<'audit'>;
}

/** Who is acting on an audit endpoint (from the HTTP handler input). */
export interface Caller {
  principal: Principal;
  actor: common.Actor;
  requestId: string;
  ip?: string | null;
}

type Prepared = Omit<NewChainRow, 'prevHash' | 'hash' | 'ip'> & { rawIp: string | null };

const SYSTEM: common.Actor = { kind: 'system', id: null, name: 'Marketly' };
const VERIFY_BATCH = 1000;
const EXPORT_BATCH = 1000;
const MAX_HISTORY = 100;

const years = (n: number) => `${n} year${n === 1 ? '' : 's'}`;

function invalid(path: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });
}

function parseActor(text: string | null): common.Actor | null {
  if (!text) return null;
  try {
    const a = JSON.parse(text) as common.Actor;
    if (a && typeof a === 'object' && typeof a.kind === 'string') return { kind: a.kind, id: a.id ?? null, name: a.name ?? null };
  } catch {
    /* an id stored as plain text */
  }
  return { kind: 'staff', id: text, name: null };
}

const actorText = (a: common.Actor) => JSON.stringify({ kind: a.kind, id: a.id ?? null, name: a.name ?? null });

/**
 * Action history use cases. Depends only on its repository, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/audit.json.
 */
export class AuditService implements AuditPublicApi {
  #datasetRegistered: Promise<void> | undefined;

  constructor(protected readonly deps: AuditServiceDeps) {}

  private get ctx() {
    return this.deps.ctx;
  }
  private get repo() {
    return this.deps.repo;
  }
  private now() {
    return this.ctx.clock.now();
  }
  private get timeZone() {
    return this.ctx.config.market.timeZone;
  }

  /* ================================================================ public API (in-process) */

  /** Append one entry. Call it inside the same transaction as the change (outbox once introduced), so a change is never saved without its history. Roles are resolved through access.rolesOf when the actor is staff and actorRoles is omitted. */
  async record(entry: RecordInput): Promise<string> {
    const [id] = await this.recordMany([entry]);
    return id!;
  }

  /** Bulk actions (bulk catalog edit, payout run items) in one call */
  async recordMany(entries: RecordInput[]): Promise<string[]> {
    if (!entries.length) return [];
    const redactKeys = await this.ctx.settings.get('redactKeys');
    const roles = new Map<string, Promise<RoleName[]>>();
    const prepared = await Promise.all(entries.map((e, i) => this.prepare(e, redactKeys, roles, entries.length > 1 ? `[${i}].` : '')));
    return this.append(prepared);
  }

  /** Staff history for a record, embedded in other modules' admin detail responses (order, seller, payout) */
  async historyOf(targetType: string, targetId: string, limit?: number): Promise<AuditEntry[]> {
    const n = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit!), 1), MAX_HISTORY) : 20;
    const page = await this.repo.targetHistory(targetType, targetId, { includeRelated: true }, { mode: 'cursor', cursor: null, limit: n });
    return this.toEntries(page.items);
  }

  /** Batched, paged history per record for the Action history card on admin 360 views (order, seller, customer, payout run). includeRelated also matches entries where the record is one of relatedTargets. Newest first. */
  async trailOf(targetType: string, targetIds: string[], opts: { includeRelated?: boolean; category?: string; page?: common.PageInput }): Promise<Map<string, common.Page<AuditEntry>>> {
    const req = toPageRequest(opts?.page);
    const category = opts?.category ? opts.category.toLowerCase() : undefined;
    const ids = [...new Set(targetIds)];
    const pages = await Promise.all(ids.map((id) => this.repo.targetHistory(targetType, id, { includeRelated: opts?.includeRelated ?? true, category }, req)));
    const approvals = await this.repo.approvalStates(pages.flatMap((p) => p.items.flatMap((r) => (r.approvalRequestId ? [r.approvalRequestId] : []))));
    return new Map(ids.map((id, i) => [id, { ...pages[i]!, items: pages[i]!.items.map((r) => this.toEntry(r, approvals)) }]));
  }

  /** The action history with filters, newest first (same as GET /entries) */
  async searchEntries(filters: AuditFilters, page: common.PageInput): Promise<common.Page<AuditEntry>> {
    return this.search(filters, toPageRequest(page));
  }

  /** One entry with before/after and approval */
  async getEntry(entryId: string): Promise<AuditEntry | null> {
    if (!isUuid(entryId)) return null;
    const row = await this.repo.getEntry(entryId.toLowerCase());
    return row ? (await this.toEntries([row]))[0]! : null;
  }

  /** Export rows for reports dataset audit.admin.entries (filters are AuditFilters; values are already redacted at record time) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    if (dataset !== DATASET) throw invalid('dataset', `audit serves only the ${DATASET} dataset`);
    if (principal?.kind !== 'staff') throw new AppError('FORBIDDEN', 'The action history is exported by staff only', { permission: 'audit.entries.export' });
    const q = this.entryQuery(this.parseFilters(filters ?? {}));
    const afterSeq = cursor ? Number(decodeCursor(cursor)[0]) : null;
    if (afterSeq !== null && !Number.isFinite(afterSeq)) throw invalid('cursor', 'not a cursor from this export');
    const rows = await this.repo.entriesBySeq(q, afterSeq, EXPORT_BATCH + 1);
    const batch = rows.slice(0, EXPORT_BATCH);
    const entries = await this.toEntries(batch);
    const out = entries.map((e, i) => ({
      seq: e.seq,
      id: e.id,
      at: e.at,
      actorKind: e.actor.kind,
      actorId: e.actor.id ?? null,
      actorName: e.actor.name ?? null,
      actorRoles: e.actorRoles.map((r) => r.name).join(', '),
      action: e.action,
      actionLabel: e.actionLabel,
      module: e.module,
      category: e.category,
      targetType: e.target.type,
      targetId: e.target.id,
      targetRef: e.target.ref ?? null,
      targetLabel: e.target.label ?? null,
      sellerId: e.target.sellerId ?? null,
      relatedTargets: e.relatedTargets.map((t) => `${t.type}:${t.id}`).join(', '),
      reason: e.reason ?? null,
      beforeText: e.change.before ?? null,
      afterText: e.change.after ?? null,
      before: e.before ?? null,
      after: e.after ?? null,
      evidence: e.evidence.join(', '),
      approvalState: e.approval.state,
      approvalRequestId: e.approval.approvalRequestId ?? null,
      approvalNote: e.approval.note ?? null,
      approvers: e.approval.approvers.join(', '),
      requestId: e.requestId ?? null,
      ip: e.ip ?? null,
      visibleToSeller: e.visibleToSeller,
      prevHash: toHex(batch[i]!.prevHash),
      hash: toHex(batch[i]!.hash),
    }));
    return rows.length > EXPORT_BATCH ? { rows: out, nextCursor: encodeCursor([batch.at(-1)!.seq]) } : { rows: out };
  }

  /* ================================================================ admin endpoints */

  async search(filters: AuditFilters, page: PageRequest): Promise<common.Page<AuditEntry>> {
    const q = this.entryQuery(this.parseFilters(filters));
    const p = await this.repo.searchEntries(q, page);
    return { ...p, items: await this.toEntries(p.items) };
  }

  async entryOrThrow(id: string): Promise<AuditEntry> {
    const e = await this.getEntry(id);
    if (!e) throw new AppError('NOT_FOUND', 'Action history entry not found');
    return e;
  }

  async summary(q: { from?: string; to?: string }): Promise<AuditSummary> {
    const to = q.to ?? dateInZone(this.now(), this.timeZone);
    const from = q.from ?? addDays(to, -29);
    if (from > to) throw invalid('from', 'from must be on or before to');
    const w = dayWindow(from, to, this.timeZone);
    const c = await this.repo.summary(w.from!, w.to!);
    return {
      range: { from, to },
      total: c.total,
      pendingSecondReview: c.pendingSecondReview,
      financial: c.financial,
      sellerEnforcement: c.sellerEnforcement,
      settings: c.settings,
      byActor: Object.fromEntries(c.byActor.map((a) => [a.name, a.n])),
    };
  }

  async targetHistory(type: string, id: string, page: PageRequest): Promise<common.Page<AuditEntry>> {
    const p = await this.repo.targetHistory(type, id, { includeRelated: true }, page);
    return { ...p, items: await this.toEntries(p.items) };
  }

  /* ---------------------------------------------------------------- exports (reports runs the jobs) */

  async createExport(body: { filters: AuditFilters; format: 'csv' | 'jsonl'; reason: string }, by: Caller): Promise<reports.ExportJob> {
    const reportsApi = this.ctx.tryUse('reports');
    if (!reportsApi) throw new AppError('DATASET_UNAVAILABLE', 'Exports are unavailable right now', { dataset: DATASET });
    const reason = body.reason?.trim();
    if (!reason) throw invalid('reason', 'Say why you are exporting the action history');
    const filters = this.parseFilters(body.filters ?? {});
    const [matched, max] = await Promise.all([this.repo.countEntries(this.entryQuery(filters)), this.maxExportRows()]);
    if (matched > max) throw this.tooLarge(matched, max);
    await this.registerDataset(reportsApi);

    // the reason is in the action history before the job exists
    await this.recordOwn(
      {
        action: 'audit.export.requested',
        actionLabel: 'Exported action history',
        category: 'security',
        target: { type: 'export', id: DATASET, label: `Action history export (${body.format.toUpperCase()})`, screen: 'admin/audit' },
        reason,
        after: { filters, format: body.format, matched },
        afterText: `${matched} entr${matched === 1 ? 'y' : 'ies'} · ${body.format.toUpperCase()}`,
      },
      by,
    );
    try {
      return await reportsApi.requestExport({ dataset: DATASET, filters, format: body.format, principal: by.principal });
    } catch (err) {
      if (isAppError(err) && err.code === 'EXPORT_TOO_LARGE') throw this.tooLarge(matched, max);
      throw err;
    }
  }

  async listExports(status: string | undefined, page: PageRequest, by: Caller, allRequesters: boolean): Promise<common.Page<reports.ExportJob>> {
    const reportsApi = this.ctx.tryUse('reports');
    if (!reportsApi) return { items: [], nextCursor: null };
    const cursor = page.mode === 'cursor' ? (page.cursor ?? undefined) : undefined;
    const res = await reportsApi.listExports({ dataset: DATASET, ...(status ? { state: status } : {}), allRequesters }, by.principal, cursor);
    return { items: res.items, nextCursor: res.nextCursor ?? null };
  }

  async getExport(id: string, by: Caller): Promise<reports.ExportJob> {
    const reportsApi = this.ctx.tryUse('reports');
    if (!reportsApi) throw new AppError('NOT_FOUND', 'Export not found');
    const job = await reportsApi.getExport(id, by.principal);
    if (!job || job.dataset !== DATASET) throw new AppError('NOT_FOUND', 'Export not found');
    if (job.state === 'ready' && job.downloadUrl) {
      await this.recordOwn(
        {
          action: 'audit.export.link_issued',
          actionLabel: 'Downloaded action history export',
          category: 'security',
          target: { type: 'export', id: job.id, ref: job.ref, label: job.fileName ?? 'Action history export', screen: 'admin/audit' },
          after: { exportId: job.id, fileName: job.fileName ?? null, sha256: job.sha256 ?? null, expiresAt: job.expiresAt ?? null, rowCount: job.rowCount ?? null },
        },
        by,
      );
    }
    return job;
  }

  private tooLarge(matched: number, max: number) {
    return this.ctx.error('EXPORT_TOO_LARGE', `The filters match ${matched} entries, more than one export can hold (${max}); narrow the date range`, { matched, max });
  }

  /** reports.maxExportRows through the kernel's cross-module settings reader (the reports default when settings is off) */
  private async maxExportRows(): Promise<number> {
    const v = await this.ctx.settings.read('reports.maxExportRows');
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_EXPORT_ROWS;
  }

  /** At boot, so the export screen shows the dataset's title and columns before anyone exports (retried on the first export) */
  async registerExportDataset(): Promise<void> {
    const api = this.ctx.tryUse('reports');
    if (api) await this.registerDataset(api);
  }

  /** reports reads the rows through exportRows; the dataset is registered once, before the first export */
  private registerDataset(api: reports.ReportsPublicApi) {
    this.#datasetRegistered ??= api
      .registerDataset({
        key: DATASET,
        owner: 'audit',
        title: 'Action history',
        permission: 'audit.entries.export',
        audience: 'staff',
        screens: ['admin/audit'],
        available: true,
        phase: 1,
        columns: [
          ['seq', 'Seq'], ['id', 'Entry id'], ['at', 'Time'], ['actorKind', 'Actor kind'], ['actorId', 'Actor id'], ['actorName', 'Actor'],
          ['actorRoles', 'Roles'], ['action', 'Action key'], ['actionLabel', 'Action'], ['module', 'Module'], ['category', 'Category'],
          ['targetType', 'Target type'], ['targetId', 'Target id'], ['targetRef', 'Reference'], ['targetLabel', 'Target'], ['sellerId', 'Seller id'],
          ['relatedTargets', 'Related records'], ['reason', 'Reason'], ['beforeText', 'Before'], ['afterText', 'After'], ['before', 'Before (data)'],
          ['after', 'After (data)'], ['evidence', 'Evidence'], ['approvalState', 'Approval'], ['approvalRequestId', 'Approval request'],
          ['approvalNote', 'Approval note'], ['approvers', 'Approvers'], ['requestId', 'Request id'], ['ip', 'IP address'],
          ['visibleToSeller', 'Visible to seller'], ['prevHash', 'Previous hash'], ['hash', 'Hash'],
        ].map(([key, label]) => ({ key, label })),
      })
      .catch((err) => {
        this.#datasetRegistered = undefined;
        if (!isNotImplemented(err)) throw err; // reports not built yet: requestExport answers for it
      });
    return this.#datasetRegistered;
  }

  /* ---------------------------------------------------------------- retention */

  async getRetention(): Promise<RetentionPolicy> {
    const r = await this.repo.retention(await this.ctx.settings.get('retainYears'));
    return this.policyOf(r);
  }

  /** Lengthening applies now (200). Shortening waits for Business Owner approval (202 with pendingChange). */
  async updateRetention(body: { retainYears: number; reason: string }, by: Caller): Promise<RetentionPolicy> {
    const reason = body.reason?.trim();
    if (!reason) throw invalid('reason', 'Say why retention changes');
    const minimum = await this.ctx.settings.get('minimumRetentionYears');
    const defaultYears = await this.ctx.settings.get('retainYears');

    const first = await this.repo.transaction(async (tx) => {
      const before = await tx.retention(defaultYears, { forUpdate: true });
      const move = decideRetention(before.retainYears, body.retainYears, minimum, before.pendingYears !== null);
      if (move.kind !== 'lengthen') return { move, before, after: before };
      const after = await tx.updateRetention({ retainYears: body.retainYears, updatedBy: actorText(by.actor), updatedAt: this.now() });
      return { move, before, after };
    });
    if (first.move.kind === 'unchanged') return this.policyOf(first.after);
    if (first.move.kind === 'lengthen') {
      await this.retentionApplied(first.before.retainYears, first.after.retainYears, by.actor, reason, { by, approvalNote: 'Lengthening needs no approval' });
      return this.policyOf(first.after);
    }

    // shortening: Business Owner approval through access (secondReviewer: always)
    const access = this.ctx.tryUse('access');
    if (!access) throw new AppError('APPROVAL_REQUIRED', 'Shortening retention needs Business Owner approval, and approvals are unavailable right now', { action: RETENTION_ACTION });
    const check = await access.check(by.principal, RETENTION_ACTION);
    if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'You cannot shorten retention', { action: RETENTION_ACTION });
    const current = first.before.retainYears;

    if (check.decision === 'allowed') {
      const after = await this.repo.transaction(async (tx) => {
        const r = await tx.retention(defaultYears, { forUpdate: true });
        decideRetention(r.retainYears, body.retainYears, minimum, r.pendingYears !== null);
        return tx.updateRetention({ retainYears: body.retainYears, updatedBy: actorText(by.actor), updatedAt: this.now() });
      });
      await this.retentionApplied(current, after.retainYears, by.actor, reason, { by, approvalNote: check.reason || null });
      return this.policyOf(after);
    }

    const request = await access.requestApproval({
      action: RETENTION_ACTION,
      target: { type: RETENTION_TARGET.type, id: RETENTION_TARGET.id, label: RETENTION_TARGET.label, screen: RETENTION_TARGET.screen },
      summary: `Shorten action history retention from ${years(current)} to ${years(body.retainYears)}`,
      details: { before: { retainYears: current }, after: { retainYears: body.retainYears } },
      reason,
      requestedBy: by.principal,
    });
    const pending = await this.repo.transaction(async (tx) => {
      const r = await tx.retention(defaultYears, { forUpdate: true });
      if (r.pendingApprovalRequestId !== request.id) decideRetention(r.retainYears, body.retainYears, minimum, r.pendingYears !== null);
      return tx.updateRetention({ pendingYears: body.retainYears, pendingReason: reason, pendingApprovalRequestId: request.id, pendingRequestedBy: actorText(by.actor) });
    });
    await this.recordOwn(
      {
        action: 'audit.retention.change_requested',
        actionLabel: 'Requested shorter action history retention',
        category: 'settings',
        target: RETENTION_TARGET,
        reason,
        before: { retainYears: current },
        after: { retainYears: body.retainYears },
        beforeText: years(current),
        afterText: years(body.retainYears),
        approvalRequestId: request.id,
      },
      by,
    );
    // saved pending: the normal 200 with pendingChange.approval (FORMAT.md, Approval responses)
    return this.policyOf(pending);
  }

  /** Publishes the change and writes its entry (lengthened now, or shortened after approval). */
  private async retentionApplied(previous: number, now: number, actor: common.Actor, reason: string | null, o: { by?: Caller; approvalRequestId?: string; approvalNote?: string | null }) {
    this.ctx.events.publish('audit.retention.changed', { retainYears: now, previousYears: previous, by: actor }, { actor, requestId: o.by?.requestId });
    await this.record({
      actor,
      module: 'audit',
      action: 'audit.retention.changed',
      actionLabel: `Changed action history retention to ${years(now)}`,
      category: 'settings',
      target: RETENTION_TARGET,
      reason,
      before: { retainYears: previous },
      after: { retainYears: now },
      beforeText: years(previous),
      afterText: years(now),
      approvalRequestId: o.approvalRequestId ?? null,
      approvalNote: o.approvalNote ?? null,
      requestId: o.by?.requestId ?? null,
      ip: o.by?.ip ?? null,
    });
  }

  private async policyOf(r: RetentionRow): Promise<RetentionPolicy> {
    const [minimumYears, oldest] = await Promise.all([this.ctx.settings.get('minimumRetentionYears'), this.repo.oldestEntryAt()]);
    let pendingChange: RetentionPolicy['pendingChange'] = null;
    if (r.pendingYears !== null) {
      const requestId = r.pendingApprovalRequestId;
      const requested = requestId ? await this.repo.latestEntryFor(requestId, 'audit.retention.change_requested') : null;
      pendingChange = {
        retainYears: r.pendingYears,
        reason: r.pendingReason ?? '',
        approval: await this.approvalInfoOf(requestId),
        requestedBy: parseActor(r.pendingRequestedBy) ?? SYSTEM,
        requestedAt: (requested?.at ?? r.updatedAt ?? this.now()).toISOString(),
      };
    }
    return {
      retainYears: r.retainYears,
      minimumYears,
      oldestEntryAt: oldest?.toISOString() ?? null,
      nextPurgeAt: nextPurgeAt(this.now(), this.timeZone).toISOString(),
      lastPurge: r.lastPurgeAt ? { at: r.lastPurgeAt.toISOString(), removedEntries: r.lastPurgeRemoved ?? 0, removedThrough: (r.lastPurgeThrough ?? r.lastPurgeAt).toISOString() } : null,
      updatedBy: parseActor(r.updatedBy),
      updatedAt: r.updatedAt?.toISOString() ?? null,
      pendingChange,
    };
  }

  private async approvalInfoOf(requestId: string | null): Promise<common.ApprovalInfo> {
    const access = this.ctx.tryUse('access');
    if (access && requestId) {
      try {
        return await access.approvalInfo(requestId);
      } catch (err) {
        if (!isNotImplemented(err)) this.ctx.log.warn({ err, requestId }, 'access.approvalInfo failed; showing the local approval state');
      }
    }
    const p = requestId ? (await this.repo.approvalStates([requestId])).get(requestId) : undefined;
    return {
      required: true,
      reason: p?.awaiting ? `Waiting for ${p.awaiting}` : 'Shortening retention needs Business Owner approval',
      approvalRequestId: requestId,
      approvers: p?.awaiting ? [p.awaiting] : ['Business Owner'],
    };
  }

  /* ---------------------------------------------------------------- integrity */

  async integrity(): Promise<IntegrityStatus> {
    const [last, lastOk, cp] = await Promise.all([this.repo.lastIntegrityCheck(), this.repo.lastOkIntegrityCheck(), this.repo.latestCheckpoint()]);
    const signatureOk = cp ? this.checkpointOk(cp) : null;
    const checkpoint = { lastCheckpointSeq: cp?.seq ?? null, lastCheckpointAt: cp ? cp.createdAt.toISOString() : null, checkpointSignatureOk: signatureOk };
    const forged = `The signed checkpoint at entry #${cp?.seq} does not verify: the action history may have been rewritten. Platform Administrator and Business Owner were notified.`;
    if (!last) {
      if (signatureOk === false) return { ok: false, lastVerifiedAt: null, lastVerifiedSeq: null, brokenAtSeq: cp!.seq, ...checkpoint, message: forged };
      return { ok: true, lastVerifiedAt: null, lastVerifiedSeq: null, brokenAtSeq: null, ...checkpoint, message: 'The chain has not been verified yet' };
    }
    const ok = last.ok !== false && signatureOk !== false;
    return {
      ok,
      lastVerifiedAt: (last.finishedAt ?? last.startedAt).toISOString(),
      lastVerifiedSeq: lastOk ? lastOk.toSeq : null,
      brokenAtSeq: ok ? null : signatureOk === false ? cp!.seq : last.brokenAtSeq,
      ...checkpoint,
      message: ok
        ? lastOk && lastOk.toSeq > 0
          ? `Every entry through #${lastOk.toSeq} verifies`
          : 'No entries to verify yet'
        : signatureOk === false
          ? forged
          : `Broken link at entry #${last.brokenAtSeq}: entries from there on cannot be trusted. Platform Administrator and Business Owner were notified.`,
    };
  }

  /** The checkpoint key (HKDF from APP_SECRET, never stored in the database) */
  private checkpointKey(): string {
    return secretFor(this.ctx.config, CHECKPOINT_PURPOSE);
  }

  private checkpointOk(cp: CheckpointRow): boolean {
    return checkpointMacOk(this.checkpointKey(), cp);
  }

  /** Signs and stores a checkpoint at seq (ignored when one exists there already) */
  private async writeCheckpoint(repo: AuditRepository, seq: number, hash: Uint8Array, kind: CheckpointRow['kind']): Promise<void> {
    await repo.insertCheckpoint({ id: newId(), seq, hash, mac: checkpointMac(this.checkpointKey(), seq, hash), keyId: CHECKPOINT_KEY_ID, kind, createdAt: this.now() });
  }

  /* ================================================================ seller endpoint */

  async sellerHistory(sellerId: string, q: { from?: string; to?: string; targetType?: string }, page: PageRequest): Promise<common.Page<SellerAuditEntry>> {
    if (q.from && q.to && q.from > q.to) throw invalid('from', 'from must be on or before to');
    const w = dayWindow(q.from, q.to, this.timeZone);
    const p = await this.repo.sellerEntries(sellerId.toLowerCase(), { ...w, targetType: q.targetType }, page);
    return { ...p, items: (await this.toEntries(p.items)).map(toSellerEntry) };
  }

  /* ================================================================ events consumed */

  /** access.approval.requested: Create or reset the approval_states row (pending, awaiting the eligible reviewers) */
  async onApprovalRequestedFromAccess(event: EventPayload<'access.approval.requested'>, meta?: { at?: string }): Promise<void> {
    const at = meta?.at ?? this.now().toISOString();
    const awaiting = await this.awaitingFor(event.nominatedReviewerId ?? null, event.eligibleRoleKeys ?? []);
    await this.repo.transaction(async (tx) => {
      const existing = await tx.getApprovalState(event.requestId, { forUpdate: true });
      if (existing?.steps.some((s) => s.at === at && (s.label === 'Requested' || s.label === 'Resubmitted'))) return; // same event again
      const label = existing ? 'Resubmitted' : 'Requested';
      await tx.saveApprovalState({
        approvalRequestId: event.requestId,
        state: 'pending',
        approvers: [],
        steps: withStep(existing?.steps ?? [], { at, label, detail: event.summary, actor: event.requestedBy }),
        awaiting,
        decidedAt: null,
        updatedAt: this.now(),
      });
    });
  }

  /** access.approval.partially_approved: Add the first approval to approval_states (still pending a second reviewer) */
  async onApprovalPartiallyApprovedFromAccess(event: EventPayload<'access.approval.partially_approved'>, meta?: { at?: string }): Promise<void> {
    const at = meta?.at ?? this.now().toISOString();
    const n = event.remainingApprovals;
    await this.updateProjection(event.requestId, (p) => ({
      ...p,
      state: 'partially_approved',
      approvers: withName(p.approvers, event.approvedBy.name ?? event.approvedBy.id),
      steps: withStep(p.steps, { at, label: 'Approved', detail: `${n} more approval${n === 1 ? '' : 's'} needed`, actor: event.approvedBy }),
    }));
  }

  /** access.approval.returned: Mark the approval state returned with the comment */
  async onApprovalReturnedFromAccess(event: EventPayload<'access.approval.returned'>, meta?: { at?: string }): Promise<void> {
    const at = meta?.at ?? this.now().toISOString();
    await this.updateProjection(event.requestId, (p) => ({
      ...p,
      state: 'returned',
      awaiting: null,
      steps: withStep(p.steps, { at, label: 'Returned', detail: event.comment, actor: event.by }),
    }));
  }

  /** access.approval.decided: Set the final approval state and decision time; for audit.retention.change apply or drop the pending retention change */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>, meta?: { at?: string }): Promise<void> {
    const at = meta?.at ?? this.now().toISOString();
    const label = { approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled', expired: 'Expired' }[event.outcome];
    await this.updateProjection(event.requestId, (p) => ({
      ...p,
      state: event.outcome,
      awaiting: null,
      decidedAt: new Date(at),
      approvers: event.outcome === 'approved' ? withName(p.approvers, event.decidedBy?.name ?? event.decidedBy?.id) : p.approvers,
      steps: withStep(p.steps, { at, label, detail: event.reason ?? null, actor: event.decidedBy ?? null }),
    }));
    if (event.actionKey === RETENTION_ACTION) await this.finishRetentionChange(event);
  }

  private async updateProjection(requestId: string, change: (p: ApprovalProjection) => ApprovalProjection) {
    await this.repo.transaction(async (tx) => {
      const existing = (await tx.getApprovalState(requestId, { forUpdate: true })) ?? {
        approvalRequestId: requestId,
        state: 'pending',
        approvers: [],
        steps: [],
        awaiting: null,
        decidedAt: null,
        updatedAt: this.now(),
      };
      await tx.saveApprovalState({ ...change(existing), approvalRequestId: requestId, updatedAt: this.now() });
    });
  }

  /** Who the request waits for: the nominated reviewer by name, else the eligible roles. */
  private async awaitingFor(nominatedReviewerId: string | null, roleKeys: readonly string[]): Promise<string | null> {
    const access = this.ctx.tryUse('access');
    if (nominatedReviewerId && access) {
      try {
        const ref = await access.getStaffRef(nominatedReviewerId);
        if (ref?.name) return ref.name;
      } catch (err) {
        if (!isNotImplemented(err)) this.ctx.log.warn({ err }, 'access.getStaffRef failed');
      }
    }
    return roleKeys.length ? roleKeys.map(roleLabel).join(' or ') : null;
  }

  private async finishRetentionChange(event: EventPayload<'access.approval.decided'>) {
    const minimum = await this.ctx.settings.get('minimumRetentionYears');
    const defaultYears = await this.ctx.settings.get('retainYears');
    const done = await this.repo.transaction(async (tx) => {
      const r = await tx.retention(defaultYears, { forUpdate: true });
      if (r.pendingYears === null || r.pendingApprovalRequestId !== event.requestId) return null; // unknown or already finished
      retentionChangeMachine.next('pending_approval', retentionEventFor(event.outcome));
      const clear = { pendingYears: null, pendingReason: null, pendingApprovalRequestId: null, pendingRequestedBy: null };
      const apply = event.outcome === 'approved' && r.pendingYears >= minimum;
      const after = await tx.updateRetention(apply ? { ...clear, retainYears: r.pendingYears, updatedBy: r.pendingRequestedBy, updatedAt: this.now() } : clear);
      return { before: r, after, apply };
    });
    if (!done) return;
    const { before, after, apply } = done;
    const requester = parseActor(before.pendingRequestedBy) ?? SYSTEM;
    if (apply) {
      await this.retentionApplied(before.retainYears, after.retainYears, requester, before.pendingReason, { approvalRequestId: event.requestId });
      return;
    }
    const belowMinimum = event.outcome === 'approved';
    await this.record({
      actor: event.decidedBy ?? SYSTEM,
      module: 'audit',
      action: 'audit.retention.change_dropped',
      actionLabel: belowMinimum ? 'Dropped retention change below the legal minimum' : `Retention change ${event.outcome}`,
      category: 'settings',
      target: RETENTION_TARGET,
      reason: belowMinimum ? `${years(before.pendingYears!)} is below the legal minimum of ${years(minimum)}` : (event.reason ?? null),
      before: { retainYears: before.retainYears, pendingYears: before.pendingYears },
      after: { retainYears: after.retainYears },
      beforeText: `${years(before.retainYears)} (requested ${years(before.pendingYears!)})`,
      afterText: years(after.retainYears),
      approvalRequestId: event.requestId,
    });
  }

  /* ================================================================ jobs */

  /**
   * Job audit.verify-chain (daily 03:00 market time): Verify the newest checkpoint's HMAC, recompute hashes from it;
   * on success write a new signed checkpoint at the last seq; on a hash or signature mismatch publish
   * audit.integrity.failed (Platform Administrator and Business Owner are notified)
   */
  async verifyChain(): Promise<IntegrityStatus> {
    const startedAt = this.now();
    const id = newId();
    const maxSeq = await this.repo.maxSeq();
    const checkpoint = await this.repo.latestCheckpoint();
    const anchorCheck = checkpoint ? null : await this.repo.lastOkIntegrityCheck();
    let broken: number | null = null;
    let expectedPrev: Uint8Array | undefined;
    let afterSeq: number | null = null;

    if (checkpoint) {
      if (!this.checkpointOk(checkpoint)) broken = checkpoint.seq; // someone rewrote the checkpoint (or its key changed)
      else {
        const anchor = await this.repo.entryBySeq(checkpoint.seq);
        if (anchor) {
          // the entry the checkpoint signed is still that entry: the same hash, and that hash recomputes from the row
          if (!sameBytes(anchor.hash, checkpoint.hash) || !sameBytes(hashRow(anchor.prevHash, anchor), anchor.hash)) broken = anchor.seq!;
          else {
            expectedPrev = anchor.hash;
            afterSeq = anchor.seq!;
          }
        } else if (checkpoint.kind === 'purge') {
          // purged through the checkpoint: the first kept entry links to it
          expectedPrev = checkpoint.hash;
          afterSeq = checkpoint.seq;
        } else broken = checkpoint.seq; // a verified entry disappeared without a purge
      }
    } else if (anchorCheck && anchorCheck.toSeq > 0 && maxSeq !== null) {
      // installs verified before checkpoints existed: continue from the last clean run
      const anchor = await this.repo.entryBySeq(anchorCheck.toSeq);
      if (anchor) {
        // the anchor itself is recomputed too, so an edit of the last verified row is caught
        if (!sameBytes(hashRow(anchor.prevHash, anchor), anchor.hash)) broken = anchor.seq!;
        else {
          expectedPrev = anchor.hash;
          afterSeq = anchor.seq!;
        }
      } // purged since: verify from the oldest kept entry and its checkpoint
    }

    const checkpoints = await this.repo.purgeCheckpoints();
    const firstLink = (row: ChainRow) => sameBytes(row.prevHash, GENESIS_HASH) || checkpoints.some((c) => c.seq < row.seq! && c.hash === toHex(row.prevHash));
    let fromSeq: number | null = afterSeq === null ? null : afterSeq + 1;
    let lastSeq: number | null = afterSeq;
    while (broken === null && maxSeq !== null) {
      const rows = await this.repo.entriesBySeq(null, afterSeq, VERIFY_BATCH, maxSeq);
      if (!rows.length) break;
      fromSeq ??= rows[0]!.seq!;
      const res = verifyRows(rows, expectedPrev, firstLink);
      if (!res.ok) {
        broken = res.brokenAtSeq;
        break;
      }
      expectedPrev = res.lastHash;
      afterSeq = res.lastSeq ?? afterSeq;
      lastSeq = afterSeq;
    }

    // a clean run signs where it stopped, so the next run starts there and a later rewrite of everything up to it is caught
    if (broken === null && lastSeq !== null && expectedPrev && (!checkpoint || lastSeq > checkpoint.seq)) await this.writeCheckpoint(this.repo, lastSeq, expectedPrev, 'verified');
    const toSeq = broken ?? lastSeq ?? 0;
    await this.repo.saveIntegrityCheck({ id, startedAt, finishedAt: this.now(), fromSeq: Math.min(fromSeq ?? toSeq, toSeq), toSeq, ok: broken === null, brokenAtSeq: broken });
    if (broken !== null) {
      this.ctx.log.error({ brokenAtSeq: broken }, 'audit hash chain is broken');
      this.ctx.events.publish('audit.integrity.failed', { brokenAtSeq: broken, detectedAt: this.now().toISOString() });
    }
    return this.integrity();
  }

  /**
   * Job audit.purge-expired (monthly): Write a signed checkpoint at the last entry before the cut-off, then delete the
   * entries before the cut-off that come before every kept entry in the chain, with their related targets. Record the
   * purge as an entry.
   */
  async purgeExpired(): Promise<{ removed: number; removedThrough: string }> {
    const now = this.now();
    const [minimum, defaultYears, redactKeys] = await Promise.all([
      this.ctx.settings.get('minimumRetentionYears'),
      this.ctx.settings.get('retainYears'),
      this.ctx.settings.get('redactKeys'),
    ]);
    const r = await this.repo.retention(defaultYears);
    const keepYears = Math.max(r.retainYears, minimum);
    const cutoff = purgeCutoff(now, keepYears, this.timeZone);

    const { removed } = await this.repo.transaction(async (tx) => {
      const none = { removed: 0 };
      await tx.lockChain();
      const head = await tx.chainHead();
      if (!head) return none;
      // a prefix of the chain by seq, so the kept part stays one unbroken chain (a backdated entry keeps what follows it)
      const keepFrom = await tx.firstSeqAtOrAfter(cutoff);
      const last = await tx.lastEntryBefore(keepFrom);
      if (!last) return none;
      // first a signed checkpoint at the last entry that goes, in the same transaction: verification continues from it
      await this.writeCheckpoint(tx, last.seq, last.hash, 'purge');
      const purged = await tx.purgeEntries(keepFrom, cutoff);
      if (!purged.removed) return none;
      const entry = await this.prepare(
        {
          actor: SYSTEM,
          module: 'audit',
          action: PURGE_ACTION,
          actionLabel: `Purged ${purged.removed} action history entr${purged.removed === 1 ? 'y' : 'ies'} older than ${years(keepYears)}`,
          category: 'settings',
          target: RETENTION_TARGET,
          reason: `Retention period of ${years(keepYears)}`,
          after: {
            removedEntries: purged.removed,
            removedThrough: cutoff.toISOString(),
            retainYears: keepYears,
            checkpoint: { seq: last.seq, hash: toHex(last.hash) },
          },
          afterText: `${purged.removed} entries before ${cutoff.toISOString().slice(0, 10)} removed`,
        },
        redactKeys,
        new Map(),
      );
      // the purge entry links to the chain head as it was, so the chain still verifies through the checkpoint
      await this.append([entry], { tx, prevHash: head.hash });
      return purged;
    });
    await this.repo.updateRetention({ lastPurgeAt: now, lastPurgeRemoved: removed, lastPurgeThrough: cutoff });
    return { removed, removedThrough: cutoff.toISOString() };
  }

  /**
   * Job audit.prepare-partitions (daily): does nothing and always succeeds (entries are one collection, there is
   * nothing to prepare); the job keeps its spec name and schedule.
   */
  async preparePartitions(): Promise<{ created: number }> {
    return { created: 0 };
  }

  /* ================================================================ internals */

  /** Writes an entry for this module's own endpoints. */
  private async recordOwn(entry: Omit<RecordInput, 'actor' | 'module' | 'requestId' | 'ip'>, by: Caller): Promise<string> {
    return this.record({ ...entry, actor: by.actor, module: 'audit', requestId: by.requestId, ip: by.ip ?? null });
  }

  private parseFilters(filters: unknown): AuditFilters {
    const r = AuditFiltersSchema.safeParse(filters);
    if (!r.success) throw new AppError('VALIDATION_FAILED', 'Some filters are invalid', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    return r.data;
  }

  private entryQuery(f: AuditFilters): EntryQuery {
    return {
      ...f,
      from: f.from ? new Date(f.from) : undefined,
      to: f.to ? new Date(f.to) : undefined,
    } as EntryQuery;
  }

  /** Validates, redacts and resolves roles; no I/O on the chain yet. */
  private async prepare(input: RecordInput, redactKeys: readonly string[], roleCache: Map<string, Promise<RoleName[]>>, path = ''): Promise<Prepared> {
    const parsed = RecordInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppError('VALIDATION_FAILED', 'The action history entry is invalid', { issues: parsed.error.issues.map((i) => ({ path: `${path}${i.path.join('.')}`, message: i.message })) });
    }
    const e = parsed.data;
    const roles = e.actorRoles ?? (await this.rolesOf(e.actor, roleCache));
    const related = e.relatedTargets ?? [];
    const sellerId = e.target.sellerId ?? related.find((t) => t.sellerId)?.sellerId ?? (e.target.type === 'seller' && isUuid(e.target.id) ? e.target.id : null);
    const rawIp = e.ip ? e.ip.split('%')[0]!.trim() : null;
    const searchText = [
      e.target.ref,
      e.target.label,
      e.target.id,
      ...related.flatMap((t) => [t.ref, t.label, t.id]),
      e.reason,
      e.actor.name,
      e.actionLabel,
      e.action,
    ]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .map(cleanText)
      .join(' ');
    return {
      id: newId(),
      at: e.at ? new Date(e.at) : this.now(),
      actorKind: e.actor.kind,
      actorId: cleanOptionalText(e.actor.id),
      actorName: cleanOptionalText(e.actor.name),
      actorRoles: roles.map((r) => ({ key: cleanText(r.key), name: cleanText(r.name) })),
      action: cleanText(e.action),
      actionLabel: cleanText(e.actionLabel),
      module: cleanText(e.module),
      category: e.category,
      targetType: cleanText(e.target.type),
      targetId: cleanText(e.target.id),
      targetRef: cleanOptionalText(e.target.ref),
      targetLabel: cleanOptionalText(e.target.label),
      targetScreen: cleanOptionalText(e.target.screen),
      sellerId: sellerId ? sellerId.toLowerCase() : null,
      reason: cleanOptionalText(e.reason),
      before: redact(e.before, redactKeys),
      after: redact(e.after, redactKeys),
      beforeText: cleanOptionalText(e.beforeText),
      afterText: cleanOptionalText(e.afterText),
      evidence: (e.evidence ?? []).map(cleanText),
      approvalRequestId: e.approvalRequestId ? e.approvalRequestId.toLowerCase() : null,
      approvalNote: cleanOptionalText(e.approvalNote),
      requestId: cleanOptionalText(e.requestId),
      visibleToSeller: e.visibleToSeller ?? false,
      relatedTargets: normalizeTargets(related.map((t) => ({ type: cleanText(t.type), id: cleanText(t.id) }))),
      searchText,
      rawIp: rawIp && isIP(rawIp) ? rawIp : null,
    };
  }

  /** Staff roles at the time of the action; access being off or failing never blocks the history. */
  private rolesOf(actor: common.Actor, cache: Map<string, Promise<RoleName[]>>): Promise<RoleName[]> {
    if (actor.kind !== 'staff' || !actor.id || !isUuid(actor.id)) return Promise.resolve([]);
    const access = this.ctx.tryUse('access');
    if (!access) return Promise.resolve([]);
    let roles = cache.get(actor.id);
    if (!roles) {
      roles = access
        .rolesOf(actor.id)
        .then((rs) => (rs ?? []).map((r) => ({ key: r.key, name: r.name })))
        .catch((err) => {
          if (!isNotImplemented(err)) this.ctx.log.warn({ err, accountId: actor.id }, 'access.rolesOf failed; entry recorded without roles');
          return [];
        });
      cache.set(actor.id, roles);
    }
    return roles;
  }

  /**
   * Appends entries to the chain. Appends are serialized by a transaction-scoped lock on the chain,
   * so concurrent calls never link to the same head.
   */
  private async append(prepared: readonly Prepared[], o: { tx?: AuditRepository; prevHash?: Uint8Array } = {}): Promise<string[]> {
    const run = async (tx: AuditRepository) => {
      await tx.lockChain();
      const head = o.prevHash ? null : await tx.chainHead();
      const ips = prepared.map((p) => (p.rawIp === null ? null : normalizeIp(p.rawIp)));
      let prev = o.prevHash ?? head?.hash ?? GENESIS_HASH;
      const rows: NewChainRow[] = prepared.map(({ rawIp: _raw, ...p }, i) => {
        const base = { ...p, ip: ips[i] ?? null };
        const hash = hashRow(prev, base);
        const row = { ...base, prevHash: prev, hash };
        prev = hash;
        return row;
      });
      await tx.insertEntries(rows);
      return rows.map((r) => r.id);
    };
    return o.tx ? run(o.tx) : this.repo.transaction(run);
  }

  private async toEntries(rows: readonly ChainRow[]): Promise<AuditEntry[]> {
    const approvals = await this.repo.approvalStates(rows.flatMap((r) => (r.approvalRequestId ? [r.approvalRequestId] : [])));
    return rows.map((r) => this.toEntry(r, approvals));
  }

  private toEntry(r: ChainRow, approvals: Map<string, ApprovalProjection>): AuditEntry {
    return {
      id: r.id,
      seq: r.seq!,
      at: r.at.toISOString(),
      actor: { kind: r.actorKind as common.Actor['kind'], id: r.actorId, name: r.actorName },
      actorRoles: Array.isArray(r.actorRoles) ? (r.actorRoles as RoleName[]) : [],
      action: r.action,
      actionLabel: r.actionLabel,
      module: r.module,
      category: r.category as Category,
      target: { type: r.targetType, id: r.targetId, ref: r.targetRef, label: r.targetLabel, sellerId: r.sellerId, screen: r.targetScreen },
      relatedTargets: r.relatedTargets.map((t) => ({ type: t.type, id: t.id })),
      reason: r.reason,
      change: { before: r.beforeText, after: r.afterText },
      before: r.before ?? null,
      after: r.after ?? null,
      evidence: Array.isArray(r.evidence) ? (r.evidence as string[]) : [],
      approval: approvalOf(r.approvalRequestId, r.approvalNote, r.approvalRequestId ? approvals.get(r.approvalRequestId) : undefined),
      requestId: r.requestId,
      ip: r.ip,
      visibleToSeller: r.visibleToSeller,
    };
  }
}
