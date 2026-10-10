/**
 * Retention (lengthen now, shorten through Business Owner approval, never below the minimum) and
 * authorized exports through reports.
 *
 * Stubbed APIs (built in parallel):
 *   access.check → approval_required unless a test says otherwise; requestApproval → a new request id;
 *   access.approvalInfo → "Waiting for Morgan Hale"; access.rolesOf → [].
 *   reports.registerDataset / requestExport / listExports / getExport → recorded calls and ExportJobs.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { ExportJob } from '../../../spec/reports.js';
import { auth, buildTestApp, callers } from '../../../testing/app.js';
import { auditApi, entry, waitForEvents } from './helpers.js';

const access = {
  rolesOf: vi.fn(async () => []),
  check: vi.fn(async (_p: unknown, action: string) => ({ decision: 'approval_required' as 'approval_required' | 'allowed' | 'denied', action, reason: 'Business Owner approval', requiresSecondReviewer: true, approvalsNeeded: 1, eligibleApproverRoles: [], eligibleApprovers: [] })),
  requestApproval: vi.fn(async (_input: unknown) => ({ id: newId() }) as never),
  approvalInfo: vi.fn(async (id: string) => ({ required: true, reason: 'Waiting for Morgan Hale', approvalRequestId: id, approvers: ['Morgan Hale'] })),
};

const job = (over: Partial<ExportJob> = {}): ExportJob => ({
  id: newId(),
  ref: 'EX-261009-0001',
  dataset: 'audit.admin.entries',
  format: 'csv',
  filters: {},
  requestedBy: { kind: 'staff', id: newId(), name: 'Morgan Hale' },
  state: 'queued',
  columnsExcluded: [],
  createdAt: '2026-10-09T10:00:00Z',
  ...over,
});

const reports = {
  registerDataset: vi.fn(async () => {}),
  requestExport: vi.fn(async (input: { format: 'csv' | 'xlsx' | 'jsonl'; filters: unknown }) => job({ format: input.format, filters: input.filters })),
  listExports: vi.fn(async () => ({ items: [job()], nextCursor: undefined })),
  getExport: vi.fn(async (id: string) => job({ id, state: 'ready', downloadUrl: 'https://files.example/ex.csv?sig=1', fileName: 'action-history.csv', sha256: 'ab'.repeat(32) })),
};

let app: FastifyInstance;
const morgan = { accountId: newId() };
const staffToken = callers.staff(undefined, { sub: morgan.accountId, dev: { permissions: ['*'], name: 'Morgan Hale' } });
const staff = auth(staffToken);
const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown, headers = staff) => app.inject({ method, url: `/api/admin/audit${url}`, headers, ...(payload ? { payload } : {}) });
const changed: { retainYears: number; previousYears: number }[] = [];
const history = async (action: string) => (await call('GET', `/entries?action=${action}`)).json().items;

beforeAll(async () => {
  app = await buildTestApp({ only: ['audit', 'access', 'reports'], apiStubs: { access, reports } as never });
  app.kernel.events.subscribe('test', 'audit.retention.changed', (e) => void changed.push(e.payload as never));
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  vi.clearAllMocks();
});

const decide = async (requestId: string, outcome: 'approved' | 'rejected' | 'cancelled' | 'expired') => {
  app.kernel.events.publish('access', 'access.approval.decided', {
    requestId, ref: 'AP-261009-0001', actionKey: 'audit.retention.change', module: 'audit', target: { type: 'setting', id: 'audit.retention' }, outcome,
    decidedBy: { kind: 'staff', id: newId(), name: 'Dana Ortiz' }, approverIds: [], requestedById: morgan.accountId,
  });
  await waitForEvents(app);
};

describe('retention', () => {
  it('starts at the setting value with the legal minimum', async () => {
    const res = await call('GET', '/retention');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ retainYears: 7, minimumYears: 7, pendingChange: null, lastPurge: null });
    expect(res.json().nextPurgeAt).toEqual(expect.any(String));
  });

  it('never goes below the minimum and needs a reason', async () => {
    const low = await call('PUT', '/retention', { retainYears: 5, reason: 'Save space' });
    expect(low.statusCode).toBe(400);
    expect(low.json().error).toMatchObject({ code: 'BELOW_LEGAL_MINIMUM', details: { minimumYears: 7 } });
    const noReason = await call('PUT', '/retention', { retainYears: 10, reason: '  ' });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('lengthening applies at once (200), is published and recorded', async () => {
    const res = await call('PUT', '/retention', { retainYears: 10, reason: 'Tax authority asked for 10 years' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ retainYears: 10, pendingChange: null, updatedBy: { kind: 'staff', id: morgan.accountId, name: 'Morgan Hale' } });
    expect(access.check).not.toHaveBeenCalled();
    await waitForEvents(app);
    expect(changed.at(-1)).toEqual({ retainYears: 10, previousYears: 7, by: { kind: 'staff', id: morgan.accountId, name: 'Morgan Hale' } });
    const [e] = await history('audit.retention.changed');
    expect(e).toMatchObject({ reason: 'Tax authority asked for 10 years', change: { before: '7 years', after: '10 years' }, category: 'settings', target: { type: 'setting', id: 'audit.retention' } });
  });

  it('shortening waits for Business Owner approval (202), then applies on access.approval.decided', async () => {
    const res = await call('PUT', '/retention', { retainYears: 8, reason: 'Storage cost' });
    expect(res.statusCode, res.body).toBe(202);
    const requestId = res.json().pendingChange.approval.approvalRequestId;
    expect(res.json()).toMatchObject({
      retainYears: 10,
      pendingChange: { retainYears: 8, reason: 'Storage cost', requestedBy: { id: morgan.accountId }, approval: { required: true, approvers: ['Morgan Hale'] } },
    });
    expect(access.check).toHaveBeenCalledWith(expect.objectContaining({ kind: 'staff', accountId: morgan.accountId }), 'audit.retention.change');
    expect(access.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ action: 'audit.retention.change', reason: 'Storage cost', requestedBy: expect.objectContaining({ accountId: morgan.accountId }) }));
    const [requested] = await history('audit.retention.change_requested');
    expect(requested).toMatchObject({ approval: { state: 'pending', approvalRequestId: requestId } });

    // nothing else changes while it waits
    const meanwhile = await call('PUT', '/retention', { retainYears: 12, reason: 'More' });
    expect(meanwhile.statusCode).toBe(409);
    expect(meanwhile.json().error.code).toBe('ILLEGAL_TRANSITION');

    await decide(newId(), 'approved'); // someone else's request: ignored
    expect((await call('GET', '/retention')).json().retainYears).toBe(10);

    const before = changed.length;
    await decide(requestId, 'approved');
    const after = (await call('GET', '/retention')).json();
    expect(after).toMatchObject({ retainYears: 8, pendingChange: null });
    expect(changed.slice(before)).toEqual([{ retainYears: 8, previousYears: 10, by: expect.objectContaining({ id: morgan.accountId }) }]);
    const [applied] = await history('audit.retention.changed');
    expect(applied).toMatchObject({ change: { before: '10 years', after: '8 years' }, approval: { state: 'approved', approvalRequestId: requestId } });

    await decide(requestId, 'approved'); // delivered twice: same result
    expect(changed.length).toBe(before + 1);
  });

  it('a rejected shortening is dropped and recorded', async () => {
    const res = await call('PUT', '/retention', { retainYears: 7, reason: 'Minimum is enough' });
    expect(res.statusCode).toBe(202);
    const requestId = res.json().pendingChange.approval.approvalRequestId;
    await decide(requestId, 'rejected');
    expect((await call('GET', '/retention')).json()).toMatchObject({ retainYears: 8, pendingChange: null });
    const [dropped] = await history('audit.retention.change_dropped');
    expect(dropped).toMatchObject({ actionLabel: 'Retention change rejected', actor: { name: 'Dana Ortiz' } });
  });

  it('follows access: denied → 403, allowed → applied at once', async () => {
    access.check.mockResolvedValueOnce({ ...(await access.check(null, 'audit.retention.change')), decision: 'denied', reason: 'Your role cannot change retention' });
    const denied = await call('PUT', '/retention', { retainYears: 7, reason: 'r' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe('Your role cannot change retention');

    access.check.mockResolvedValueOnce({ ...(await access.check(null, 'audit.retention.change')), decision: 'allowed', reason: 'Business Owner authority' });
    const allowed = await call('PUT', '/retention', { retainYears: 7, reason: 'r' });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json()).toMatchObject({ retainYears: 7, pendingChange: null });
  });

  it('only audit.retention.manage may change it', async () => {
    const res = await call('PUT', '/retention', { retainYears: 9, reason: 'r' }, auth(callers.staff(['audit.entries.view'])));
    expect(res.statusCode).toBe(403);
  });
});

describe('exports', () => {
  it('records the reason, registers the dataset and creates the job through reports (202)', async () => {
    const res = await call('POST', '/exports', { filters: { category: 'settings' }, format: 'jsonl', reason: 'Quarterly control review' });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ dataset: 'audit.admin.entries', format: 'jsonl', state: 'queued' });
    expect(reports.registerDataset).toHaveBeenCalledWith(expect.objectContaining({ key: 'audit.admin.entries', owner: 'audit', permission: 'audit.entries.export', audience: 'staff' }));
    expect(reports.requestExport).toHaveBeenCalledWith(
      expect.objectContaining({ dataset: 'audit.admin.entries', format: 'jsonl', filters: { category: 'settings' }, principal: expect.objectContaining({ kind: 'staff', accountId: morgan.accountId }) }),
    );
    const [e] = await history('audit.export.requested');
    expect(e).toMatchObject({ reason: 'Quarterly control review', category: 'security', actor: { id: morgan.accountId }, after: { format: 'jsonl', filters: { category: 'settings' } } });
    expect(e.after.matched).toBeGreaterThan(0);

    reports.registerDataset.mockClear();
    await call('POST', '/exports', { filters: {}, format: 'csv', reason: 'Again' });
    expect(reports.registerDataset).not.toHaveBeenCalled(); // once per process
  });

  it('needs a reason; too many rows → EXPORT_TOO_LARGE (422) with details.matched and details.max', async () => {
    const blank = await call('POST', '/exports', { filters: {}, format: 'csv', reason: '' });
    expect(blank.statusCode).toBe(400);
    reports.requestExport.mockRejectedValueOnce(new AppError('EXPORT_TOO_LARGE', 'too many', undefined, 422));
    const big = await call('POST', '/exports', { filters: {}, format: 'csv', reason: 'Everything' });
    expect(big.statusCode).toBe(422);
    expect(big.json().error).toMatchObject({ code: 'EXPORT_TOO_LARGE', details: { matched: expect.any(Number), max: 500_000 } });
  });

  it('checks reports.maxExportRows (read through settings) before creating the job', async () => {
    await auditApi(app).recordMany([entry(), entry()]);
    // the kernel's cross-module settings reader (ctx.settings.read), answering a lowered limit
    const ctx = (app.kernel.boot.apis.get('audit') as unknown as { deps: { ctx: { settings: Record<string, unknown> } } }).deps.ctx;
    const original = ctx.settings.read;
    const read = vi.fn(async (key: string) => (key === 'reports.maxExportRows' ? 1 : undefined));
    ctx.settings.read = read;
    try {
      const big = await call('POST', '/exports', { filters: {}, format: 'csv', reason: 'Everything' });
      expect(big.statusCode).toBe(422);
      expect(big.json().error).toMatchObject({ code: 'EXPORT_TOO_LARGE', details: { max: 1 } });
      expect(read).toHaveBeenCalledWith('reports.maxExportRows');
      expect(reports.requestExport).not.toHaveBeenCalled();
    } finally {
      ctx.settings.read = original;
    }
  });

  it('lists the caller’s own exports, or everyone’s with audit.retention.manage', async () => {
    const mine = await call('GET', '/exports?status=ready', undefined, auth(callers.staff(['audit.entries.export'])));
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().items).toHaveLength(1);
    expect(reports.listExports).toHaveBeenLastCalledWith({ dataset: 'audit.admin.entries', state: 'ready', allRequesters: false }, expect.objectContaining({ kind: 'staff' }), undefined);
    await call('GET', '/exports');
    expect(reports.listExports).toHaveBeenLastCalledWith({ dataset: 'audit.admin.entries', allRequesters: true }, expect.anything(), undefined);
  });

  it('GET /exports/{id} proxies reports.getExport and records each download link', async () => {
    const id = newId();
    const res = await call('GET', `/exports/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id, state: 'ready', downloadUrl: expect.any(String) });
    expect(reports.getExport).toHaveBeenCalledWith(id, expect.objectContaining({ accountId: morgan.accountId }));
    const [e] = await history('audit.export.link_issued');
    expect(e).toMatchObject({ target: { type: 'export', id }, actor: { id: morgan.accountId } });

    reports.getExport.mockResolvedValueOnce(job({ id, dataset: 'orders.admin.orders' }));
    expect((await call('GET', `/exports/${id}`)).statusCode).toBe(404);
    reports.getExport.mockRejectedValueOnce(new AppError('NOT_FOUND', 'Export not found'));
    expect((await call('GET', `/exports/${newId()}`)).statusCode).toBe(404);
  });

  it('exportRows serves the dataset page by page, oldest first, for staff only', async () => {
    const api = auditApi(app);
    await api.recordMany(Array.from({ length: 1003 }, (_, i) => entry({ module: 'bulkexport', reason: `row ${i}`, before: { password: 'x' } })));
    const principal = { kind: 'staff' as const, accountId: morgan.accountId };
    const first = await api.exportRows('audit.admin.entries', { module: 'bulkexport' }, principal);
    expect(first.rows).toHaveLength(1000);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.rows[0]).toMatchObject({ module: 'bulkexport', reason: 'row 0', before: { password: '[redacted]' }, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const second = await api.exportRows('audit.admin.entries', { module: 'bulkexport' }, principal, first.nextCursor);
    expect(second.rows.map((r: any) => r.reason)).toEqual(['row 1000', 'row 1001', 'row 1002']);
    expect(second.nextCursor).toBeUndefined();
    await expect(api.exportRows('orders.admin.orders', {}, principal)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(api.exportRows('audit.admin.entries', {}, { kind: 'customer', accountId: newId() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.exportRows('audit.admin.entries', { category: 'nope' }, principal)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
