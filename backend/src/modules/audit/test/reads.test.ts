/**
 * Reading the history: filters and paging, one entry, summary, per-record history (REST, historyOf,
 * trailOf, GraphQL), the seller's own history, and the approval column kept current from access events.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { auth, buildTestApp, callers } from '../../../testing/app.js';
import type { AuditService } from '../service.js';
import { auditApi, entry, staffActor, waitForEvents } from './helpers.js';

let app: FastifyInstance;
const staff = auth(callers.staff());
const get = (url: string, headers = staff) => app.inject({ method: 'GET', url, headers });
const admin = (url: string) => get(`/api/admin/audit${url}`);

const morgan = staffActor('Morgan Hale');
const grace = staffActor('Grace Kim');
const sellerA = newId();
const sellerB = newId();
const orderId = newId();
const itemId = newId();
const approvalId = newId();
const ids: Record<string, string> = {};

beforeAll(async () => {
  app = await buildTestApp({ only: ['audit'] });
  const api = auditApi(app);
  ids.orderEdit = await api.record(
    entry({ actor: morgan, actorRoles: [{ key: 'order_manager', name: 'Order Manager' }], action: 'orders.item.ship_by_changed', actionLabel: 'Changed ship-by date', module: 'orders', category: 'orders', target: { type: 'order', id: orderId, ref: 'MK-261002-55410', label: 'Order MK-261002-55410' }, reason: 'Carrier delay', beforeText: 'Ships by Sep 22', afterText: 'Ships by Oct 12', at: '2026-10-01T10:00:00Z' }),
  );
  ids.itemRefund = await api.record(
    entry({ actor: grace, actorRoles: [{ key: 'returns_manager', name: 'Returns Manager' }], action: 'returns.refund.approved', actionLabel: 'Approved refund', module: 'returns', category: 'returns', target: { type: 'order_item', id: itemId, ref: 'MK-261002-55410-1', sellerId: sellerA }, relatedTargets: [{ type: 'order', id: orderId }], reason: 'Arrived damaged', approvalRequestId: approvalId, at: '2026-10-02T10:00:00Z' }),
  );
  ids.restrict = await api.record(
    entry({ actor: grace, action: 'sellers.seller.restricted', actionLabel: 'Restricted seller', module: 'sellers', category: 'seller_enforcement', target: { type: 'seller', id: sellerA, label: 'Casa Verde Home', screen: 'admin/seller' }, reason: 'Late shipments over 8%', visibleToSeller: true, at: '2026-10-03T10:00:00Z' }),
  );
  ids.sellerMember = await api.record(
    entry({ actor: { kind: 'seller', id: newId(), name: 'Ana Ruiz' }, action: 'sellers.member.invited', actionLabel: 'Invited a staff member', module: 'sellers', category: 'access', target: { type: 'seller_member', id: newId(), label: 'Leo Park', sellerId: sellerA }, visibleToSeller: true, at: '2026-10-04T10:00:00Z' }),
  );
  ids.otherSeller = await api.record(
    entry({ actor: morgan, action: 'sellers.seller.restricted', actionLabel: 'Restricted seller', module: 'sellers', category: 'seller_enforcement', target: { type: 'seller', id: sellerB, label: 'Other Store' }, visibleToSeller: true, at: '2026-10-05T10:00:00Z' }),
  );
  ids.hidden = await api.record(
    entry({ actor: morgan, action: 'finance.hold.placed', actionLabel: 'Placed payout hold', module: 'finance', category: 'financial', target: { type: 'hold', id: newId(), sellerId: sellerA }, reason: 'Chargeback investigation', at: '2026-10-06T10:00:00Z' }),
  );
  ids.setting = await api.record(
    entry({ actor: morgan, action: 'settings.change.applied', actionLabel: 'Changed return window', module: 'settings', category: 'settings', target: { type: 'setting', id: 'returns.window' }, at: '2026-10-07T10:00:00Z' }),
  );
});
afterAll(async () => {
  await app?.close();
});

const list = async (qs: string) => {
  const res = await admin(`/entries?${qs}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { items: { id: string }[]; nextCursor: string | null; total?: number };
};
const idsOf = (p: { items: { id: string }[] }) => p.items.map((i) => i.id);

describe('GET /entries', () => {
  it('lists newest first', async () => {
    const p = await list('from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z');
    expect(idsOf(p)).toEqual([ids.setting, ids.hidden, ids.otherSeller, ids.sellerMember, ids.restrict, ids.itemRefund, ids.orderEdit]);
  });

  it.each([
    ['category=seller_enforcement', ['otherSeller', 'restrict']],
    [`actorId=${'GRACE'}`, ['restrict', 'itemRefund']],
    ['roleKey=order_manager', ['orderEdit']],
    ['module=settings', ['setting']],
    ['action=returns.refund.approved', ['itemRefund']],
    [`sellerId=${'SELLER_A'}`, ['hidden', 'sellerMember', 'restrict', 'itemRefund']],
    [`targetType=order&targetId=${'ORDER'}`, ['itemRefund', 'orderEdit']],
    ['targetType=setting', ['setting']],
    ['q=MK-261002-55410', ['itemRefund', 'orderEdit']],
    ['q=damaged', ['itemRefund']],
    ['q=Morgan', ['setting', 'hidden', 'otherSeller', 'orderEdit']],
    ['approvalState=pending', ['itemRefund']],
    ['from=2026-10-03T00:00:00Z&to=2026-10-04T23:59:59Z', ['sellerMember', 'restrict']],
  ])('filters by %s', async (qs, expected) => {
    const q = qs.replace('GRACE', grace.id).replace('SELLER_A', sellerA).replace('ORDER', orderId);
    const p = await list(q.includes('from=') ? q : `${q}&from=2026-10-01T00:00:00Z`);
    expect(idsOf(p)).toEqual(expected.map((k) => ids[k]));
  });

  it('pages with a cursor and with page numbers', async () => {
    const range = 'from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z';
    const first = await list(`${range}&limit=3`);
    expect(idsOf(first)).toEqual([ids.setting, ids.hidden, ids.otherSeller]);
    const second = await list(`${range}&limit=3&cursor=${first.nextCursor}`);
    expect(idsOf(second)).toEqual([ids.sellerMember, ids.restrict, ids.itemRefund]);
    const numbered = await list(`${range}&limit=3&page=3`);
    expect(idsOf(numbered)).toEqual([ids.orderEdit]);
    expect(numbered.total).toBe(7);
  });

  it('GET /entries/{id} answers 404 for an unknown entry', async () => {
    const res = await admin(`/entries/${newId()}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('summary', () => {
  it('counts the filter chips for whole market days', async () => {
    const res = await admin('/summary?from=2026-10-01&to=2026-10-07');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      range: { from: '2026-10-01', to: '2026-10-07' },
      total: 7,
      pendingSecondReview: 1,
      financial: 1,
      sellerEnforcement: 2,
      settings: 1,
      byActor: { 'Morgan Hale': 4, 'Grace Kim': 2 },
    });
  });

  it('refuses a range that ends before it starts', async () => {
    const res = await admin('/summary?from=2026-10-07&to=2026-10-01');
    expect(res.statusCode).toBe(400);
  });
});

describe('history of one record', () => {
  it('GET /targets/{type}/{id} includes entries where the record is a related target', async () => {
    const res = await admin(`/targets/order/${orderId}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(idsOf(res.json())).toEqual([ids.itemRefund, ids.orderEdit]);
  });

  it('historyOf and trailOf (batched, per record, with category)', async () => {
    const api = auditApi(app);
    expect((await api.historyOf('seller', sellerA)).map((e) => e.id)).toEqual([ids.restrict]);
    expect((await api.historyOf('order', orderId, 1)).map((e) => e.id)).toEqual([ids.itemRefund]);
    const trails = await api.trailOf('order', [orderId, newId()], { includeRelated: true });
    expect(trails.get(orderId)!.items.map((e) => e.id)).toEqual([ids.itemRefund, ids.orderEdit]);
    const own = await api.trailOf('order', [orderId], { includeRelated: false });
    expect(own.get(orderId)!.items.map((e) => e.id)).toEqual([ids.orderEdit]);
    const returns = await api.trailOf('order', [orderId], { category: 'returns' });
    expect(returns.get(orderId)!.items.map((e) => e.id)).toEqual([ids.itemRefund]);
  });

  it('searchEntries and getEntry (in-process)', async () => {
    const api = auditApi(app);
    const p = await api.searchEntries({ category: 'settings', from: '2026-10-01T00:00:00Z' }, { limit: 5 });
    expect(p.items.map((e) => e.id)).toEqual([ids.setting]);
    expect((await api.getEntry(ids.restrict!))?.target.label).toBe('Casa Verde Home');
    expect(await api.getEntry(newId())).toBeNull();
    expect(await api.getEntry('not-a-uuid')).toBeNull();
  });
});

describe('GraphQL', () => {
  const gql = (query: string, variables: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/graphql/admin', headers: staff, payload: { query, variables } });

  it('auditEntries and auditEntry resolve with GraphQL enum values', async () => {
    const res = await gql(
      `query($f: AuditFilterInput) { auditEntries(filter: $f, paging: { limit: 5 }) { items { id category actor { kind name } approval { state } relatedTargets { type id } } nextCursor } }`,
      { f: { category: 'RETURNS', from: '2026-10-01T00:00:00Z' } },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().errors).toBeUndefined();
    expect(res.json().data.auditEntries.items).toEqual([
      { id: ids.itemRefund, category: 'RETURNS', actor: { kind: 'STAFF', name: 'Grace Kim' }, approval: { state: 'PENDING' }, relatedTargets: [{ type: 'order', id: orderId }] },
    ]);
    const one = await gql(`query($id: UUID!) { auditEntry(id: $id) { id action change { before after } } }`, { id: ids.orderEdit });
    expect(one.json().data.auditEntry).toEqual({ id: ids.orderEdit, action: 'orders.item.ship_by_changed', change: { before: 'Ships by Sep 22', after: 'Ships by Oct 12' } });
  });

  it('the auditTrail resolver batches the records of a list into one trailOf call', async () => {
    const { resolvers } = await import('../graphql/resolvers.js');
    const service = app.kernel.boot.apis.get('audit') as AuditService;
    const calls: string[][] = [];
    const spy = { trailOf: async (t: string, idsIn: string[], o: any) => (calls.push(idsIn), service.trailOf(t, idsIn, o)) } as unknown as AuditService;
    const r = resolvers(spy);
    const ctx = {} as never;
    const [a, b] = (await Promise.all([r.Order!.auditTrail!({ id: orderId }, {}, ctx, {} as never), r.Order!.auditTrail!({ id: newId() }, {}, ctx, {} as never)])) as any[];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    expect(a.items.map((e: { id: string }) => e.id)).toEqual([ids.itemRefund, ids.orderEdit]);
    expect(a.items[0].category).toBe('RETURNS');
    expect(b.items).toEqual([]);
  });
});

describe('seller history', () => {
  const sellerGet = (sellerId: string, qs = '') => get(`/api/seller/audit/entries${qs}`, auth(callers.seller({ sellerId })));

  it('shows only entries marked visible to the seller, on its own account, without staff names', async () => {
    const res = await sellerGet(sellerA);
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items;
    expect(items.map((i: { id: string }) => i.id)).toEqual([ids.sellerMember, ids.restrict]);
    expect(items[0].actor).toEqual({ kind: 'seller', id: expect.any(String), name: 'Ana Ruiz' });
    expect(items[1]).toMatchObject({ actor: { kind: 'staff', id: null, name: 'Marketly' }, actionLabel: 'Restricted seller', reason: 'Late shipments over 8%' });
    expect(items[1].target.screen).toBeUndefined();
    expect(JSON.stringify(items)).not.toMatch(/Grace Kim|Morgan Hale/);
  });

  it('another seller never sees these entries', async () => {
    const res = await sellerGet(sellerB);
    expect(res.json().items.map((i: { id: string }) => i.id)).toEqual([ids.otherSeller]);
    const none = await sellerGet(newId());
    expect(none.json().items).toEqual([]);
  });

  it('filters by market dates and target type', async () => {
    expect((await sellerGet(sellerA, '?from=2026-10-04&to=2026-10-04')).json().items.map((i: { id: string }) => i.id)).toEqual([ids.sellerMember]);
    expect((await sellerGet(sellerA, '?targetType=seller')).json().items.map((i: { id: string }) => i.id)).toEqual([ids.restrict]);
  });
});

describe('approval column (projection of access events)', () => {
  const approval = async () => (await admin(`/entries/${ids.itemRefund}`)).json().approval;
  const target = { type: 'refund', id: newId() };
  const publish = (name: string, payload: unknown) => app.kernel.events.publish('access', name, payload);

  it('pending before access says anything, then follows requested → partially approved → approved', async () => {
    expect(await approval()).toMatchObject({ state: 'pending', approvalRequestId: approvalId });

    publish('access.approval.requested', {
      requestId: approvalId, ref: 'AP-261002-0001', actionKey: 'returns.refunds.approve', module: 'returns', target, summary: 'Refund of $189.00',
      requestedBy: grace, eligibleRoleKeys: ['business_owner'], eligibleAccountIds: [newId()],
    });
    await waitForEvents(app);
    expect(await approval()).toMatchObject({ state: 'pending', note: 'Waiting for Business Owner', steps: [{ label: 'Requested', detail: 'Refund of $189.00' }] });

    publish('access.approval.partially_approved', { requestId: approvalId, actionKey: 'returns.refunds.approve', module: 'returns', target, approvedBy: morgan, remainingApprovals: 1, eligibleAccountIds: [] });
    await waitForEvents(app);
    expect(await approval()).toMatchObject({ state: 'partially_approved', approvers: ['Morgan Hale'] });
    expect((await list('approvalState=partially_approved&from=2026-10-01T00:00:00Z')).items.map((i) => i.id)).toEqual([ids.itemRefund]);

    const decider = staffActor('Dana Ortiz');
    publish('access.approval.decided', {
      requestId: approvalId, ref: 'AP-261002-0001', actionKey: 'returns.refunds.approve', module: 'returns', target, outcome: 'approved',
      decidedBy: decider, approverIds: [morgan.id, decider.id], requestedById: grace.id,
    });
    await waitForEvents(app);
    const a = await approval();
    expect(a).toMatchObject({ state: 'approved', approvers: ['Morgan Hale', 'Dana Ortiz'], note: null });
    expect(a.decidedAt).toEqual(expect.any(String));
    expect(a.steps.map((s: { label: string }) => s.label)).toEqual(['Requested', 'Approved', 'Approved']);
    expect((await admin('/summary?from=2026-10-01&to=2026-10-07')).json().pendingSecondReview).toBe(0);
  });

  it('consumers are idempotent and ignore requests they never saw', async () => {
    const service = app.kernel.boot.apis.get('audit') as AuditService;
    const id = newId();
    const payload = { requestId: id, actionKey: 'x.y', module: 'x', target, by: morgan, comment: 'Add the invoice', requestedById: grace.id };
    await service.onApprovalReturnedFromAccess(payload, { at: '2026-10-02T11:00:00.000Z' });
    await service.onApprovalReturnedFromAccess(payload, { at: '2026-10-02T11:00:00.000Z' });
    const requested = { requestId: id, ref: 'AP-1', actionKey: 'x.y', module: 'x', target, summary: 's', requestedBy: grace, eligibleRoleKeys: [], eligibleAccountIds: [] };
    await service.onApprovalRequestedFromAccess(requested, { at: '2026-10-02T12:00:00.000Z' });
    await service.onApprovalRequestedFromAccess(requested, { at: '2026-10-02T12:00:00.000Z' });
    const e = await auditApi(app).record(entry({ approvalRequestId: id, at: '2025-01-01T00:00:00Z' }));
    const a = (await admin(`/entries/${e}`)).json().approval;
    expect(a.state).toBe('pending');
    expect(a.steps.map((s: { label: string }) => s.label)).toEqual(['Returned', 'Resubmitted']);
  });
});
