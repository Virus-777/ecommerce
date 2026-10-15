import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { harness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(() => {
  h.settings.clear();
  h.rows.value = [
    { ref: 'WI-1', title: 'Late dispatch', queue: 'dispatch', state: 'open' },
    { ref: 'WI-2', title: 'Refund check', queue: 'finance', state: 'open' },
    { ref: 'WI-3', title: 'Damaged parcel', queue: 'dispatch', state: 'done' },
  ];
});

const DATASET = 'workqueues.admin.items';
const PERMS = ['reports.exports.create', 'workqueues.items.export'];

describe('export dataset registry', () => {
  it('owners register their columns at boot; unknown keys and wrong owners are refused', async () => {
    const all = await h.call('GET', '/api/admin/reports/export-datasets?all=true', h.tokens.staff());
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(30);
    const wq = all.body.find((d: any) => d.key === DATASET);
    expect(wq).toMatchObject({ owner: 'workqueues', permission: 'workqueues.items.export', audience: 'staff', available: true });
    expect(wq.columns.length).toBeGreaterThan(0); // registered by workqueues at its boot
    expect(all.body.find((d: any) => d.key === 'orders.seller.orders').columns.length).toBeGreaterThan(0);
    // trust is not running: its Export button is hidden
    expect(all.body.find((d: any) => d.key === 'trust.admin.reports')).toMatchObject({ available: false });

    await expect(h.service.registerDataset({ key: 'nope.dataset' as never, owner: 'nope', title: 'x', permission: 'x', columns: [], audience: 'staff', screens: [], available: true, phase: 1 })).rejects.toMatchObject({ code: 'DATASET_UNAVAILABLE', status: 409 });
    await expect(h.service.registerDataset({ key: DATASET, owner: 'orders', title: 'x', permission: 'x', columns: [], audience: 'staff', screens: [], available: true, phase: 1 })).rejects.toMatchObject({ code: 'DATASET_UNAVAILABLE' });
  });

  it('without all: only staff datasets the caller may export and whose owner runs; by screen', async () => {
    const mine = await h.call('GET', '/api/admin/reports/export-datasets', h.tokens.staff(PERMS));
    expect(mine.body.map((d: any) => d.key)).toEqual([DATASET]);
    const screen = await h.call('GET', '/api/admin/reports/export-datasets?screen=admin/reports', h.tokens.staff());
    expect(screen.body.map((d: any) => d.key)).toEqual(['reports.report_result']);
  });
});

describe('export jobs', () => {
  it('queued → running → ready: rows page by page from the owner, file in media, link for the requester only, audited', async () => {
    const requested: any[] = [];
    const ready: any[] = [];
    h.app.kernel.events.subscribe('test', 'reports.export.requested', (e) => void requested.push(e.payload));
    h.app.kernel.events.subscribe('test', 'reports.export.ready', (e) => void ready.push(e.payload));
    const me = newId();
    const created = await h.call('POST', '/api/admin/reports/exports', h.tokens.staff(PERMS, me), { dataset: DATASET, filters: { queue: 'dispatch' } });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    expect(created.body).toMatchObject({ dataset: DATASET, format: 'csv', state: 'queued', filters: { queue: 'dispatch' }, requestedBy: { kind: 'staff', id: me }, columnsExcluded: [] });
    expect(created.body.ref).toMatch(/^EX-\d{6}-\d{4}$/);
    expect(h.audits.find((a) => a.action === 'reports.export.create' && a.target.id === created.body.id)?.after).toMatchObject({ dataset: DATASET, filters: { queue: 'dispatch' } });

    await h.app.kernel.jobs.runNow('reports.run-exports');
    await h.drain();
    // two pages through the owner's cursor, with the requester as principal
    const calls = h.exportRowsCalls.filter((c) => (c.principal as any).accountId === me);
    expect(calls.map((c) => c.cursor)).toEqual([undefined, '2']);
    expect(calls[0]).toMatchObject({ dataset: DATASET, filters: { queue: 'dispatch' }, principal: { kind: 'staff', accountId: me } });

    const job = await h.call('GET', `/api/admin/reports/exports/${created.body.id}`, h.tokens.staff(PERMS, me));
    expect(job.body).toMatchObject({ state: 'ready', rowCount: 3 });
    expect(job.body.downloadUrl).toMatch(/^https:\/\/files\.marketly\.test\//);
    expect(job.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(job.body.fileName).toBe(`workqueues-admin-items-${created.body.ref}.csv`);
    const file = h.files.at(-1)!;
    expect(file.contentType).toBe('text/csv');
    expect(file.ttlHours).toBe(24);
    expect(file.body.toString('utf8')).toContain('WI-3');
    expect(requested).toContainEqual(expect.objectContaining({ exportId: created.body.id, dataset: DATASET }));
    expect(ready).toContainEqual(expect.objectContaining({ exportId: created.body.id, requestedBy: { kind: 'staff', id: me } }));
    expect(h.audits.some((a) => a.action === 'reports.export.ready' && a.target.id === created.body.id && (a.after as any).rowCount === 3)).toBe(true);
    expect(h.audits.some((a) => a.action === 'reports.export.link_issued' && a.target.id === created.body.id)).toBe(true);

    // only the requester
    expect((await h.call('GET', `/api/admin/reports/exports/${created.body.id}`, h.tokens.staff(PERMS))).status).toBe(404);
    const list = await h.call('GET', '/api/admin/reports/exports', h.tokens.staff(PERMS, me));
    expect(list.body.items.map((j: any) => j.id)).toEqual([created.body.id]);
    expect(list.body.items[0].downloadUrl).toBeNull();
  });

  it('in-process requests check column permissions of the handed-over principal (ctx.can), not the calling module', async () => {
    const cols = (await h.call('GET', '/api/admin/reports/export-datasets?all=true', h.tokens.staff())).body.find((d: any) => d.key === DATASET).columns;
    await h.service.registerDataset({ key: DATASET, owner: 'workqueues', title: 'Work items', permission: 'workqueues.items.export', columns: [...cols, { key: 'title', label: 'Title', permission: 'workqueues.items.view-all' }], audience: 'staff', screens: ['ops/queues'], available: true, phase: 1 });
    try {
      const limited = newId();
      h.denied.add(`${limited}:workqueues.items.view-all`);
      const without = await h.service.requestExport({ dataset: DATASET, filters: {}, format: 'csv', principal: { kind: 'staff', accountId: limited } });
      expect(without.columnsExcluded).toEqual(['title']);
      const full = await h.service.requestExport({ dataset: DATASET, filters: {}, format: 'csv', principal: { kind: 'staff', accountId: newId() } });
      expect(full.columnsExcluded).toEqual([]);
    } finally {
      await h.service.registerDataset({ key: DATASET, owner: 'workqueues', title: 'Work items', permission: 'workqueues.items.export', columns: cols, audience: 'staff', screens: ['ops/queues'], available: true, phase: 1 });
    }
  });

  it('columns guarded by a permission the caller lacks are removed and listed', async () => {
    const cols = (await h.call('GET', '/api/admin/reports/export-datasets?all=true', h.tokens.staff())).body.find((d: any) => d.key === DATASET).columns;
    await h.service.registerDataset({ key: DATASET, owner: 'workqueues', title: 'Work items', permission: 'workqueues.items.export', columns: [...cols, { key: 'ref', label: 'Reference' }, { key: 'title', label: 'Title', permission: 'workqueues.items.view-all' }], audience: 'staff', screens: ['ops/queues'], available: true, phase: 1 });
    try {
      const me = newId();
      const created = await h.call('POST', '/api/admin/reports/exports', h.tokens.staff(PERMS, me), { dataset: DATASET, format: 'xlsx' });
      expect(created.body.columnsExcluded).toEqual(['title']);
      await h.app.kernel.jobs.runNow('reports.run-exports');
      const file = h.files.at(-1)!;
      expect(file.body.subarray(0, 2).toString()).toBe('PK');
      const text = file.body.toString('utf8');
      expect(text).toContain('WI-1');
      expect(text).not.toContain('Late dispatch');
    } finally {
      await h.service.registerDataset({ key: DATASET, owner: 'workqueues', title: 'Work items', permission: 'workqueues.items.export', columns: cols, audience: 'staff', screens: ['ops/queues'], available: true, phase: 1 });
    }
  });

  it('refuses: dataset permission, seller datasets for staff, jsonl outside audit, unknown or switched-off datasets', async () => {
    const noDataset = await h.call('POST', '/api/admin/reports/exports', h.tokens.staff(['reports.exports.create']), { dataset: DATASET });
    expect(noDataset.status).toBe(403);
    expect(noDataset.body.error.details.permission).toBe('workqueues.items.export');
    expect((await h.call('POST', '/api/admin/reports/exports', h.tokens.staff(), { dataset: 'orders.seller.orders' })).status).toBe(403);
    expect((await h.call('POST', '/api/admin/reports/exports', h.tokens.staff(), { dataset: DATASET, format: 'jsonl' })).status).toBe(400);
    const unknown = await h.call('POST', '/api/admin/reports/exports', h.tokens.staff(), { dataset: 'nope.things' });
    expect(unknown.status).toBe(409);
    expect(unknown.body.error.code).toBe('DATASET_UNAVAILABLE');
    expect((await h.call('POST', '/api/admin/reports/exports', h.tokens.staff(), { dataset: 'trust.admin.reports' })).body.error.code).toBe('DATASET_UNAVAILABLE');
    expect((await h.call('POST', '/api/admin/reports/exports', h.tokens.staff(), {})).status).toBe(400);
  });

  it('more rows than maxExportRows fails the job (EXPORT_TOO_LARGE); five running exports per person', async () => {
    h.settings.set('reports.maxExportRows', 2);
    const me = newId();
    const created = await h.call('POST', '/api/admin/reports/exports', h.tokens.staff(PERMS, me), { dataset: DATASET });
    await h.app.kernel.jobs.runNow('reports.run-exports');
    const job = await h.call('GET', `/api/admin/reports/exports/${created.body.id}`, h.tokens.staff(PERMS, me));
    expect(job.body).toMatchObject({ state: 'failed', downloadUrl: null });
    expect(job.body.error).toBe('More than 2 rows matched; narrow the filters');

    h.settings.clear();
    const other = newId();
    for (let i = 0; i < 5; i++) expect((await h.call('POST', '/api/admin/reports/exports', h.tokens.staff(PERMS, other), { dataset: DATASET })).status).toBe(202);
    const sixth = await h.call('POST', '/api/admin/reports/exports', h.tokens.staff(PERMS, other), { dataset: DATASET });
    expect(sixth.status).toBe(429);
    await h.app.kernel.jobs.runNow('reports.run-exports');
  });

  it('a report result export runs the report itself', async () => {
    const me = newId();
    const created = await h.call('POST', '/api/admin/reports/exports', h.tokens.staff(undefined, me), { reportKey: 'commerce.sales', query: { preset: 'last_7_days' } });
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ dataset: 'reports.report_result', reportKey: 'commerce.sales' });
    await h.app.kernel.jobs.runNow('reports.run-exports');
    const job = await h.call('GET', `/api/admin/reports/exports/${created.body.id}`, h.tokens.staff(undefined, me));
    expect(job.body).toMatchObject({ state: 'ready', rowCount: 8 }); // 7 days and the totals
    expect(h.files.at(-1)!.body.toString('utf8')).toContain('Gross sales');
    const forbidden = await h.call('POST', '/api/admin/reports/exports', h.tokens.staff(['reports.exports.create']), { reportKey: 'trading.margin' });
    expect(forbidden.status).toBe(403);
    expect((await h.call('POST', '/api/admin/reports/exports', h.tokens.staff(), { reportKey: 'commerce.sales', query: { range: { from: '2020-01-01', to: '2026-01-01' } } })).body.error.code).toBe('RANGE_TOO_LARGE');
  });

  it('ready exports expire after exportLinkHours; the link is gone', async () => {
    const me = newId();
    const created = await h.call('POST', '/api/admin/reports/exports', h.tokens.staff(PERMS, me), { dataset: DATASET });
    await h.app.kernel.jobs.runNow('reports.run-exports');
    h.clock.advance(25 * 3_600_000);
    await h.app.kernel.jobs.runNow('reports.expire-exports');
    const job = await h.call('GET', `/api/admin/reports/exports/${created.body.id}`, h.tokens.staff(PERMS, me));
    expect(job.body).toMatchObject({ state: 'expired', downloadUrl: null });
  });

  it('other modules export through requestExport / getExport / listExports with the caller as principal', async () => {
    const me = newId();
    const principal = { kind: 'staff' as const, accountId: me };
    const job = await h.service.requestExport({ dataset: DATASET, filters: {}, format: 'csv', principal });
    expect(job).toMatchObject({ state: 'queued', requestedBy: { kind: 'staff', id: me } });
    await expect(h.service.requestExport({ dataset: 'orders.admin.orders', filters: {}, format: 'jsonl', principal })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(h.service.requestExport({ dataset: 'support.admin.cases', filters: {}, format: 'csv', principal })).rejects.toMatchObject({ code: 'DATASET_UNAVAILABLE' });
    await expect(h.service.getExport(job.id, { kind: 'staff', accountId: newId() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await h.service.listExports({ dataset: DATASET }, principal)).items.map((j) => j.id)).toEqual([job.id]);
    expect((await h.service.listExports({ dataset: DATASET, allRequesters: true }, { kind: 'staff', accountId: newId() })).items.map((j) => j.id)).toContain(job.id);
    expect((await h.service.listExports({ dataset: DATASET, state: 'ready' }, principal)).items).toEqual([]);
    await h.app.kernel.jobs.runNow('reports.run-exports');
    expect((await h.service.getExport(job.id, principal)).downloadUrl).toBeTruthy();
  });

  it('seller exports: the seller session only, CSV, other sellers 404 (phase 2)', async () => {
    const sellerId = newId();
    const token = h.tokens.seller(sellerId);
    const created = await h.call('POST', '/api/seller/reports/exports', token, { reportKey: 'seller.order_trend' });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    expect(created.body).toMatchObject({ sellerId, dataset: 'reports.report_result', reportKey: 'seller.order_trend' });
    expect((await h.call('POST', '/api/seller/reports/exports', token, { reportKey: 'seller.order_trend', format: 'xlsx' })).status).toBe(400);
    expect((await h.call('POST', '/api/seller/reports/exports', token, { reportKey: 'commerce.sales' })).status).toBe(404);
    expect((await h.call('POST', '/api/seller/reports/exports', token, { dataset: DATASET })).status).toBe(403);
    await h.app.kernel.jobs.runNow('reports.run-exports');
    expect(h.files.at(-1)!.owner).toEqual({ kind: 'seller', id: sellerId });
    const list = await h.call('GET', '/api/seller/reports/exports', token);
    expect(list.body.items.map((j: any) => j.id)).toEqual([created.body.id]);
    expect((await h.call('GET', `/api/seller/reports/exports/${created.body.id}`, token)).body.state).toBe('ready');
    expect((await h.call('GET', `/api/seller/reports/exports/${created.body.id}`, h.tokens.seller(newId()))).status).toBe(404);
  });
});
