/**
 * Authorized exports for every module (plan ch. 18): the dataset registry, export jobs with
 * permission-filtered columns, files written through media, expiring single-user links, audit.
 */
import { createHash } from 'node:crypto';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { Page } from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type { ExportDataset, ExportJob, ReportQuery } from '../../../spec/reports.js';
import { CONTENT_TYPES, columnsFromRows, columnsOf, renderFile, type ExportColumn, type ExportFormat } from '../domain/files.js';
import { exportJobMachine } from '../domain/state-machines.js';
import type { DatasetRow, JobRow } from '../ports.js';
import { SYSTEM, invalid, notFound, type Caller, type ReportsCore } from './core.js';
import type { Definitions } from './definitions.js';
import type { Queries } from './queries.js';

export const REPORT_DATASET = 'reports.report_result';
const AUDIT_DATASET = 'audit.admin.entries';
/** Queued or running exports one person may have at a time */
const MAX_ACTIVE_PER_REQUESTER = 5;
/** Pages read from an owner per export (guards against a cursor that never ends) */
const MAX_PAGES = 100_000;

type ExportRowsApi = { exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string | null }> };

export interface ExportRequest {
  dataset?: string | null;
  reportKey?: string | null;
  query?: ReportQuery | null;
  filters?: unknown;
  format?: ExportFormat | null;
  sellerId?: string | null;
}

/** where the request came from: the admin or seller export endpoint, or another module's public API call */
export type Via = 'admin' | 'seller' | 'api';

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const EXT: Record<ExportFormat, string> = { csv: 'csv', xlsx: 'xlsx', jsonl: 'jsonl' };

export class Exports {
  constructor(
    private readonly core: ReportsCore,
    private readonly defs: Definitions,
    private readonly queries: Queries,
  ) {}

  /* ---------------------------------------------------------------- registry */

  /** The registry entry of a key (setting exportDatasets) merged with what the owner registered */
  private async entry(key: string): Promise<(DatasetRow & { inRegistry: boolean }) | undefined> {
    const cfg = await this.core.cfg();
    const seed = cfg.exportDatasets.find((d) => d.key === key);
    if (!seed) return undefined;
    const row = await this.core.repo.getDataset(key);
    return {
      key,
      owner_module: seed.owner,
      title: row?.title ?? key,
      permission: seed.permission,
      audience: seed.audience,
      columns: row?.columns ?? [],
      screens: seed.screens,
      available: this.ownerAvailable(seed.owner),
      phase: seed.phase,
      registered_at: row?.registered_at ?? null,
      inRegistry: true,
    };
  }

  private ownerAvailable(owner: string): boolean {
    return owner === 'reports' || this.core.running(owner);
  }

  /** At boot: one row per registry key, available while the owner module runs (columns come from the owner) */
  async seedRegistry() {
    const cfg = await this.core.cfg();
    for (const s of cfg.exportDatasets) {
      await this.core.repo.seedDataset({
        key: s.key,
        owner_module: s.owner,
        title: s.key === REPORT_DATASET ? 'Report results' : s.key,
        permission: s.permission,
        audience: s.audience,
        columns: [],
        screens: s.screens,
        available: this.ownerAvailable(s.owner),
        phase: s.phase,
        registered_at: null,
      });
    }
  }

  /** Owner modules register the columns of their datasets (before or after reports' own boot; idempotent) */
  async registerDataset(d: ExportDataset): Promise<void> {
    const cfg = await this.core.cfg();
    const seed = cfg.exportDatasets.find((x) => x.key === d.key);
    if (!seed) throw this.core.ctx.error('DATASET_UNAVAILABLE', `${d.key} is not in the export dataset registry`, { dataset: d.key });
    if (d.owner !== seed.owner) throw this.core.ctx.error('DATASET_UNAVAILABLE', `${d.key} belongs to ${seed.owner}, not ${d.owner}`, { dataset: d.key, owner: seed.owner });
    const columns = columnsOf(d.columns);
    if (columns.length !== (Array.isArray(d.columns) ? d.columns.length : 0)) throw invalid([{ path: 'columns', message: 'Columns are { key, label, permission? }' }]);
    await this.core.repo.registerDataset({
      key: d.key,
      owner_module: seed.owner,
      title: d.title || d.key,
      permission: seed.permission,
      audience: seed.audience,
      columns: columns as never,
      screens: seed.screens,
      available: this.ownerAvailable(seed.owner),
      phase: seed.phase,
      registered_at: this.core.now(),
    });
  }

  private datasetView(e: DatasetRow): ExportDataset {
    return {
      key: e.key as ExportDataset['key'],
      owner: e.owner_module,
      title: e.title,
      permission: e.permission,
      columns: columnsOf(e.columns),
      audience: e.audience,
      screens: strings(e.screens),
      available: e.available,
      phase: e.phase,
    };
  }

  /** Datasets the caller may export and whose owner runs; every row with all=true */
  async listDatasets(q: { screen?: string; all?: boolean }, by: Caller): Promise<ExportDataset[]> {
    const cfg = await this.core.cfg();
    const out: ExportDataset[] = [];
    for (const s of cfg.exportDatasets) {
      const e = (await this.entry(s.key))!;
      if (q.screen && !strings(e.screens).includes(q.screen)) continue;
      if (!q.all) {
        if (!e.available || e.audience !== 'staff') continue;
        if (!(await this.mayExport(e, by))) continue;
      }
      out.push(this.datasetView(e));
    }
    return out;
  }

  /** The dataset permission: a report result needs the permission of at least one report group */
  private async mayExport(e: DatasetRow, by: Caller): Promise<boolean> {
    if (e.key === REPORT_DATASET) {
      for (const r of await this.core.repo.listReports({ audience: 'staff', active: true })) if (await this.core.principalCan(by.principal, r.permission, by.can)) return true;
      return false;
    }
    return this.core.principalCan(by.principal, e.permission, by.can);
  }

  /* ---------------------------------------------------------------- requesting */

  async request(input: ExportRequest, by: Caller, via: Via): Promise<ExportJob> {
    const p = by.principal;
    const dataset = input.dataset ?? (input.reportKey ? REPORT_DATASET : null);
    if (!dataset) throw invalid([{ path: 'dataset', message: 'Choose a dataset or a report to export' }]);
    const e = await this.entry(dataset);
    if (!e) throw this.core.ctx.error('DATASET_UNAVAILABLE', `${dataset} is not in the export dataset registry`, { dataset });
    if (!e.available) throw this.core.ctx.error('DATASET_UNAVAILABLE', `${e.title} can't be exported while ${e.owner_module} is switched off`, { dataset, owner: e.owner_module });
    const format: ExportFormat = input.format ?? 'csv';
    if (format === 'jsonl' && dataset !== AUDIT_DATASET) throw invalid([{ path: 'format', message: 'JSON lines are only for the action history export; choose CSV or XLSX' }]);
    if (via === 'seller' && format !== 'csv') throw invalid([{ path: 'format', message: 'Seller exports are CSV files' }]);

    // audience: staff datasets for staff, seller datasets for the seller the session acts for
    if (e.audience !== (p.kind === 'seller' ? 'seller' : p.kind === 'staff' ? 'staff' : 'none') && dataset !== REPORT_DATASET) throw new AppError('FORBIDDEN', `${e.title} is not exported from this app`);
    if (!p.accountId) throw new AppError('FORBIDDEN', 'Sign in to export');
    let sellerId: string | null = null;
    if (p.kind === 'seller') {
      sellerId = input.sellerId ?? p.sellerId ?? null;
      if (!sellerId || (p.sellerId && sellerId !== p.sellerId)) throw new AppError('FORBIDDEN', 'You can only export your own seller account');
    }

    let filters: unknown = input.filters ?? {};
    let reportKey: string | null = null;
    if (dataset === REPORT_DATASET) {
      if (!input.reportKey) throw invalid([{ path: 'reportKey', message: 'Choose the report to export' }]);
      const report = p.kind === 'seller' ? await this.defs.sellerReport(input.reportKey) : await this.defs.staffReport(input.reportKey, by);
      await this.queries.resolve(input.query, { seller: p.kind === 'seller' });
      reportKey = report.key;
      filters = { reportKey: report.key, query: input.query ?? {} };
    } else if (via !== 'api' && !(await this.core.principalCan(p, e.permission, by.can))) {
      // module export endpoints carry the dataset permission themselves; here the dataset is chosen in the body
      throw new AppError('FORBIDDEN', `Exporting ${e.title} needs ${e.permission}`, { permission: e.permission, dataset });
    }

    // columns guarded by a permission the caller lacks are removed
    const excluded: string[] = [];
    for (const c of columnsOf(e.columns)) {
      if (!c.permission || c.permission === e.permission) continue;
      if (!(await this.core.principalCan(p, c.permission, by.can))) excluded.push(c.key);
    }

    if ((await this.core.repo.countActiveJobs(p.accountId)) >= MAX_ACTIVE_PER_REQUESTER) throw new AppError('RATE_LIMITED', `You have ${MAX_ACTIVE_PER_REQUESTER} exports running; wait for one to finish`, { maxActive: MAX_ACTIVE_PER_REQUESTER });

    const ref = await this.core.ctx.refs.next('EX', { digits: 4 });
    const row = await this.core.repo.insertJob({
      id: newId(),
      ref,
      dataset,
      report_key: reportKey,
      format,
      filters: filters as never,
      requested_by_kind: p.kind,
      requested_by_id: p.accountId,
      seller_id: sellerId,
      state: exportJobMachine.initial,
      row_count: null,
      columns_excluded: excluded as never,
      file_media_id: null,
      sha256: null,
      expires_at: null,
      error: null,
      created_at: this.core.now(),
      finished_at: null,
    });
    const view = this.view(row);
    this.core.ctx.events.publish('reports.export.requested', { exportId: row.id, dataset, requestedBy: view.requestedBy, ...(sellerId ? { sellerId } : {}) }, { actor: by.actor, requestId: by.requestId });
    await this.core.audit(
      {
        action: 'reports.export.create',
        actionLabel: `Requested an export (${format.toUpperCase()})`,
        category: 'security',
        target: { type: 'export', id: row.id, ref, label: reportKey ? `${e.title}: ${reportKey}` : e.title, screen: p.kind === 'seller' ? 'seller/reports' : 'admin/reports' },
        after: { dataset, reportKey, filters, format, columnsExcluded: excluded, sellerId },
        visibleToSeller: Boolean(sellerId),
      },
      by,
    );
    return view;
  }

  /* ---------------------------------------------------------------- reading jobs */

  view(r: JobRow, downloadUrl?: string | null): ExportJob {
    const done = r.state === 'ready' || r.state === 'expired';
    return {
      id: r.id,
      ref: r.ref,
      dataset: r.dataset,
      reportKey: r.report_key,
      format: r.format as ExportJob['format'],
      filters: r.filters ?? {},
      requestedBy: { kind: r.requested_by_kind as ExportJob['requestedBy']['kind'], id: r.requested_by_id },
      sellerId: r.seller_id,
      state: r.state as ExportJob['state'],
      rowCount: r.row_count,
      columnsExcluded: strings(r.columns_excluded),
      fileName: done ? fileNameOf(r) : null,
      sha256: r.sha256,
      downloadUrl: downloadUrl ?? null,
      expiresAt: r.expires_at?.toISOString() ?? null,
      error: r.error,
      createdAt: r.created_at.toISOString(),
      finishedAt: r.finished_at?.toISOString() ?? null,
    };
  }

  private isRequester(r: JobRow, p: identity.Principal): boolean {
    if (!p.accountId || r.requested_by_id !== p.accountId) return false;
    if (r.seller_id && p.kind === 'seller' && p.sellerId !== r.seller_id) return false;
    return r.requested_by_kind === p.kind;
  }

  /** One job for its requester (NOT_FOUND for anyone else); while ready each call signs a fresh link and records it */
  async get(id: string, p: identity.Principal, by?: Caller): Promise<ExportJob> {
    let row = await this.core.repo.getJob(id);
    if (!row || !this.isRequester(row, p)) throw notFound('Export');
    if (row.state === 'ready' && row.expires_at && row.expires_at <= this.core.now()) row = (await this.expireOne(row.id)) ?? row;
    if (row.state !== 'ready' || !row.file_media_id) return this.view(row);
    const media = this.core.api('media');
    if (!media) return this.view(row);
    const link = await media.signedDownload(row.file_media_id, p, `Export ${row.ref}`);
    if (row.dataset !== AUDIT_DATASET) {
      // the action history export records its own link issue in audit
      await this.core.audit(
        {
          action: 'reports.export.link_issued',
          actionLabel: 'Opened an export download link',
          category: 'security',
          target: { type: 'export', id: row.id, ref: row.ref, label: fileNameOf(row), screen: p.kind === 'seller' ? 'seller/reports' : 'admin/reports' },
          after: { exportId: row.id, dataset: row.dataset, rowCount: row.row_count, sha256: row.sha256, linkExpiresAt: link.expiresAt },
          visibleToSeller: Boolean(row.seller_id),
        },
        by ?? { actor: { kind: p.kind, id: p.accountId ?? null } },
      );
    }
    return this.view(row, link.url);
  }

  /** Jobs for one dataset, newest first: the principal's own, or everyone's with allRequesters */
  async list(filter: { dataset: string; state?: string; allRequesters?: boolean }, p: identity.Principal, cursor?: string): Promise<{ items: ExportJob[]; nextCursor?: string }> {
    const page = await this.core.repo.listJobs({ dataset: filter.dataset, ...(filter.state ? { state: filter.state } : {}), ...(filter.allRequesters ? {} : { requesterId: p.accountId ?? '-' }) }, { mode: 'cursor', cursor: cursor ?? null, limit: 25 });
    return { items: page.items.map((r) => this.view(r)), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  /** The caller's own exports (seller: for the seller the session acts for) */
  async listMine(page: PageRequest, p: identity.Principal): Promise<Page<ExportJob>> {
    const res = await this.core.repo.listJobs({ requesterId: p.accountId ?? '-', ...(p.kind === 'seller' && p.sellerId ? { sellerId: p.sellerId } : {}) }, page);
    return { ...res, items: res.items.filter((r) => r.requested_by_kind === p.kind).map((r) => this.view(r)) };
  }

  /* ---------------------------------------------------------------- the job */

  /** Job reports.run-exports: queued jobs in order, a few per run */
  async runQueued(limit = 5) {
    for (const j of await this.core.repo.queuedJobs(limit)) await this.runOne(j.id);
  }

  async runOne(id: string) {
    const started = await this.core.repo.transaction(async (tx) => {
      const row = await tx.getJob(id, { forUpdate: true });
      if (!row || row.state !== 'queued') return undefined;
      return tx.updateJob(id, { state: exportJobMachine.next(row.state as never, 'start'), error: null });
    });
    if (!started) return;
    try {
      const cfg = await this.core.cfg();
      const { columns, rows } = await this.produce(started, cfg.maxExportRows);
      const excluded = strings(started.columns_excluded);
      const kept = columns.filter((c) => !excluded.includes(c.key));
      const body = renderFile(started.format as ExportFormat, kept, rows);
      const media = this.core.api('media');
      if (!media) throw new AppError('SERVICE_UNAVAILABLE', 'File storage is switched off; the export could not be saved');
      const fileName = fileNameOf(started);
      const asset = await media.storeGeneratedFile({
        owner: started.seller_id ? { kind: 'seller', id: started.seller_id } : { kind: 'staff', id: started.requested_by_id },
        fileName,
        contentType: CONTENT_TYPES[started.format as ExportFormat],
        body: new Blob([new Uint8Array(body)]).stream(),
        ttlHours: cfg.exportLinkHours,
        purpose: 'export',
      });
      const now = this.core.now();
      const expiresAt = new Date(now.getTime() + cfg.exportLinkHours * 3_600_000);
      const done = await this.core.repo.transaction(async (tx) => {
        const row = await tx.getJob(id, { forUpdate: true });
        if (!row || row.state !== 'running') return undefined;
        return tx.updateJob(id, { state: exportJobMachine.next(row.state as never, 'finish'), row_count: rows.length, file_media_id: asset.id, sha256: createHash('sha256').update(body).digest('hex'), expires_at: expiresAt, finished_at: now });
      });
      if (!done) return;
      const view = this.view(done);
      this.core.ctx.events.publish('reports.export.ready', { exportId: id, requestedBy: view.requestedBy, expiresAt: expiresAt.toISOString() });
      await this.core.audit(
        {
          action: 'reports.export.ready',
          actionLabel: `Export ready (${rows.length} row${rows.length === 1 ? '' : 's'})`,
          category: 'security',
          target: { type: 'export', id, ref: done.ref, label: fileName, screen: done.seller_id ? 'seller/reports' : 'admin/reports' },
          after: { dataset: done.dataset, filters: done.filters, rowCount: rows.length, columnsExcluded: excluded, sha256: done.sha256, requestedBy: view.requestedBy },
          visibleToSeller: Boolean(done.seller_id),
        },
        { actor: SYSTEM },
      );
    } catch (err) {
      const message = isAppError(err) && err.status < 500 ? err.message : isAppError(err) && err.code === 'SERVICE_UNAVAILABLE' ? err.message : 'The export could not be produced; try again';
      if (!isAppError(err) || err.status >= 500) this.core.ctx.log.error({ err, exportId: id }, 'reports: export failed');
      await this.core.repo.transaction(async (tx) => {
        const row = await tx.getJob(id, { forUpdate: true });
        if (row?.state === 'running') await tx.updateJob(id, { state: exportJobMachine.next(row.state as never, 'fail'), error: message, finished_at: this.core.now() });
      });
    }
  }

  /** Rows and columns of a job: the report itself, or the owner module page by page */
  private async produce(job: JobRow, maxRows: number): Promise<{ columns: ExportColumn[]; rows: unknown[] }> {
    if (job.dataset === REPORT_DATASET) {
      const f = (job.filters ?? {}) as { reportKey?: string; query?: ReportQuery };
      const report = await this.core.repo.getReport(f.reportKey ?? job.report_key ?? '');
      if (!report || !report.active) throw new AppError('NOT_FOUND', 'The report no longer exists');
      const seller = job.seller_id ? { kind: 'seller' as const, sellerId: job.seller_id } : { kind: 'platform' as const };
      const rq = await this.queries.resolve(f.query, { seller: Boolean(job.seller_id) });
      const result = await this.queries.run(report, rq, seller);
      const out = this.queries.exportRowsOf(result);
      if (out.rows.length > maxRows) throw this.tooLarge(maxRows);
      return out;
    }
    const e = await this.entry(job.dataset);
    if (!e || !e.available) throw this.core.ctx.error('DATASET_UNAVAILABLE', `${job.dataset} can't be exported right now`);
    const api = (this.core.ctx.tryUse as (m: string) => unknown)(e.owner_module) as Partial<ExportRowsApi> | undefined;
    if (!api?.exportRows) throw this.core.ctx.error('DATASET_UNAVAILABLE', `${e.owner_module} does not provide export rows`);
    const principal: identity.Principal = { kind: job.requested_by_kind as identity.Principal['kind'], accountId: job.requested_by_id, ...(job.seller_id ? { sellerId: job.seller_id } : {}) };
    const rows: unknown[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await api.exportRows(job.dataset, job.filters ?? {}, principal, cursor);
      rows.push(...(res.rows ?? []));
      if (rows.length > maxRows) throw this.tooLarge(maxRows);
      cursor = res.nextCursor ?? undefined;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    const registered = columnsOf(e.columns);
    return { columns: registered.length ? registered : columnsFromRows(rows), rows };
  }

  private tooLarge(maxRows: number) {
    return this.core.ctx.error('EXPORT_TOO_LARGE', `More than ${maxRows.toLocaleString('en-US')} rows; narrow the filters`, { maxRows });
  }

  /** Job reports.expire-exports: ready exports past their link lifetime (media deletes the file at the same time) */
  async expireDue() {
    for (const j of await this.core.repo.readyJobsExpiring(this.core.now(), 200)) await this.expireOne(j.id);
  }

  private async expireOne(id: string): Promise<JobRow | undefined> {
    return this.core.repo.transaction(async (tx) => {
      const row = await tx.getJob(id, { forUpdate: true });
      if (!row || row.state !== 'ready') return row;
      return tx.updateJob(id, { state: exportJobMachine.next(row.state as never, 'expire') });
    });
  }
}

function fileNameOf(r: JobRow): string {
  const base = (r.report_key ?? r.dataset).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return `${base}-${r.ref}.${EXT[r.format as ExportFormat] ?? 'csv'}`;
}
