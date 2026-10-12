/**
 * Staff work on cases: the queue and KPIs, assignment and priority, escalation, evidence, decisions with
 * remedies (and the support.remedies.approve limit), drafts, appeals by a different staff member, seller
 * support requests and categories.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import type { ReturnsPublicApi } from '../../../spec/returns.js';
import { spec } from '../../../spec/support.js';
import { schemas } from '../infra/mongo/schema.js';
import { DAY, harness, idem, reportProblem, sellerOrder, tokens, USD, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const DECIDER = newId();
const returnsApi = () => h.app.kernel.boot.apis.get('returns') as ReturnsPublicApi;
const REVIEWER = newId();

async function disputeCase(o: { price?: number } = {}) {
  const order = await sellerOrder(h, { price: o.price ?? 4900 });
  const opened = await reportProblem(h, { customerId: order.customerId, orderId: order.order.id, itemIds: [order.itemId] });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const esc = await h.call('POST', `/api/admin/support/cases/${opened.body.id}/escalate`, tokens.staff(), { to: 'support_lead', reason: 'Seller unresponsive by phone', convertToDispute: true });
  expect(esc.status, JSON.stringify(esc.body)).toBe(200);
  return { ...order, caseId: opened.body.id as string, ref: opened.body.ref as string };
}

describe('queue, assignment and priority', () => {
  it('a staff member opens a case for a customer; it shows in the queue', async () => {
    const o = await sellerOrder(h, { deliver: false });
    const owner = newId();
    const res = await h.call('POST', '/api/admin/support/cases', tokens.staff(), { kind: 'customer_help', category: 'delivery_late', customerId: o.customerId, orderId: o.order.id, orderItemIds: [o.itemId], subject: 'Called about a late order', message: 'Customer called: the order is late', priority: 'high', ownerId: owner });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.case).toMatchObject({ kind: 'customer_help', priority: 'high', status: 'open' });
    expect(res.body.owner).toMatchObject({ kind: 'staff', id: owner, name: 'Isabel Cruz' });
    expect(res.body.customer).toMatchObject({ id: o.customerId, name: 'Sam Rivera' });
    expect(res.body.purchaseTerms).toMatchObject({ item: 'Linen Throw · Teal × 1', returns: '30-day returns.', payment: 'Visa •••• 4417' });
    expect(h.audits.some((a) => a.action === 'support.case.create' && a.target.id === res.body.case.id)).toBe(true);
    const queue = await h.call('GET', `/api/admin/support/cases?tab=all_open&q=${encodeURIComponent(o.order.ref)}`, tokens.staff());
    expect(queue.status).toBe(200);
    expect(queue.body.items.map((r: { id: string }) => r.id)).toEqual([res.body.case.id]);
    expect(queue.body.items[0]).toMatchObject({ customerName: 'Sam Rivera', sellerName: 'Casa Verde Home', priority: 'high', owner: { id: owner } });
    const mine = await h.call('GET', '/api/admin/support/cases?tab=mine', tokens.staff(undefined, owner));
    expect(mine.body.items.map((r: { id: string }) => r.id)).toContain(res.body.case.id);
  });

  it('assigns, bulk-assigns and changes priority with a reason (audited, events)', async () => {
    const a = await disputeCase();
    const b = await disputeCase();
    const owner = newId();
    const one = await h.call('POST', `/api/admin/support/cases/${a.caseId}/assign`, tokens.staff(), { ownerId: owner, reason: 'Knows the seller' });
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.owner.id).toBe(owner);
    expect(h.named('support.case.assigned').some((e) => e.caseId === a.caseId && e.ownerId === owner)).toBe(true);
    const ghost = newId();
    h.unknownStaff.add(ghost);
    expect((await h.call('POST', `/api/admin/support/cases/${a.caseId}/assign`, tokens.staff(), { ownerId: ghost })).status).toBe(400);
    const bulk = await h.call('POST', '/api/admin/support/cases/assign', tokens.staff(), { caseIds: [a.caseId, b.caseId, newId()], ownerId: owner, priority: 'urgent' });
    expect(bulk.status).toBe(200);
    expect(bulk.body.assigned).toBe(2);
    expect(bulk.body.failed).toHaveLength(1);
    const prio = await h.call('POST', '/api/admin/support/cases/priority', tokens.staff(), { caseIds: [a.caseId, b.caseId], priority: 'low', reason: 'Customer agreed to wait' });
    expect(prio.body).toEqual({ updated: 2, failed: [] });
    const detail = await h.call('GET', `/api/admin/support/cases/${a.caseId}`, tokens.staff());
    expect(detail.body.case.priority).toBe('low');
    expect(detail.body.history.some((e: { label: string; detail: string }) => /Priority/.test(e.label) && /wait/.test(e.detail))).toBe(true);
    const patch = await h.call('PATCH', `/api/admin/support/cases/${a.caseId}`, tokens.staff(), { category: 'delivery_late', reason: 'It is about the delay' });
    expect(patch.status).toBe(200);
    expect(patch.body.case.category.key).toBe('delivery_late');
    expect((await h.call('PATCH', `/api/admin/support/cases/${a.caseId}`, tokens.staff(), { category: 'fees_payouts', reason: 'x' })).status).toBe(400);
    expect(h.audits.filter((x) => x.action === 'support.case.update').length).toBeGreaterThanOrEqual(3);
  });

  it('lists assignees with their open cases', async () => {
    const agent = { accountId: newId(), name: 'Ava Agent', away: false, roleLabel: 'Support Agent' };
    const finance = { accountId: newId(), name: 'Finn Finance', away: false, roleLabel: 'Finance Staff' };
    h.members.support_agent = [agent];
    h.members.finance_staff = [finance];
    // handlers come from access.staffWithPermission (support.cases.handle), not a fixed list of roles
    h.handlers.push(agent, finance);
    const o = await disputeCase();
    await h.call('POST', `/api/admin/support/cases/${o.caseId}/assign`, tokens.staff(), { ownerId: agent.accountId });
    const res = await h.call('GET', '/api/admin/support/assignees?team=customer_support', tokens.staff());
    expect(res.status).toBe(200);
    expect(res.body.find((x: { staffId: string }) => x.staffId === agent.accountId)).toMatchObject({ name: 'Ava Agent', team: 'customer_support', openCases: 1 });
    expect(res.body.some((x: { staffId: string }) => x.staffId === finance.accountId)).toBe(false);
    expect(h.calls.permissionLookups).toContain('support.cases.handle');
    const all = await h.call('GET', '/api/admin/support/assignees', tokens.staff());
    expect(all.body.find((x: { staffId: string }) => x.staffId === finance.accountId)).toMatchObject({ team: 'finance' });
    h.handlers.length = 0;
  });

  it('shows queue KPIs', async () => {
    const res = await h.call('GET', '/api/admin/support/cases/stats', tokens.staff());
    expect(res.status).toBe(200);
    expect(res.body.open).toBeGreaterThan(0);
    expect(res.body.openDisputes).toBeGreaterThan(0);
    expect(res.body.queueOwner.lead).toBe('Lena Lead');
    expect(res.body.targets).toMatch(/First reply within \d+ business hours/);
  });
});

describe('escalation and evidence', () => {
  it('escalating to another team makes it a dispute owned by that team (event, audit, internal note)', async () => {
    const o = await sellerOrder(h);
    const id = (await reportProblem(h, { customerId: o.customerId, orderId: o.order.id, itemIds: [o.itemId] })).body.id;
    const res = await h.call('POST', `/api/admin/support/cases/${id}/escalate`, tokens.staff(), { to: 'trust', reason: 'Possible counterfeit', convertToDispute: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.case).toMatchObject({ kind: 'dispute', status: 'escalated', handledBy: { kind: 'marketplace_support' } });
    expect(res.body.team).toBe('Trust and Risk');
    expect(h.named('support.case.escalated').find((e) => e.caseId === id)).toMatchObject({ to: 'trust', sellerId: o.sellerId, orderId: o.order.id });
    expect(res.body.case.messages.at(-1)).toMatchObject({ role: 'internal_note', audience: 'internal' });
    expect(h.audits.some((a) => a.action === 'support.case.escalate' && a.target.id === id)).toBe(true);
  });

  it('the seller and staff add evidence; closed cases refuse seller evidence', async () => {
    const d = await disputeCase();
    const file = newId();
    const seller = await h.call('POST', `/api/seller/support/cases/${d.caseId}/evidence`, tokens.seller(d.sellerId), { kind: 'tracking', mediaIds: [file], note: 'Carrier scan shows delivered intact' });
    expect(seller.status, JSON.stringify(seller.body)).toBe(201);
    expect(seller.body).toMatchObject({ party: 'seller', kind: 'tracking', note: 'Carrier scan shows delivered intact', media: [{ id: file }] });
    expect(h.calls.attached.at(-1)).toEqual({ assetId: file, kind: 'case_evidence', refId: d.caseId, owner: 'seller' });
    const missing = newId();
    h.missingFiles.add(missing);
    expect((await h.call('POST', `/api/seller/support/cases/${d.caseId}/evidence`, tokens.seller(d.sellerId), { kind: 'photo', mediaIds: [missing] })).status).toBe(404);
    const staff = await h.call('POST', `/api/admin/support/cases/${d.caseId}/evidence`, tokens.staff(), { kind: 'document', mediaIds: [newId()] });
    expect(staff.status).toBe(201);
    const detail = await h.call('GET', `/api/admin/support/cases/${d.caseId}`, tokens.staff());
    expect(detail.body.evidence.map((e: { party: string }) => e.party)).toEqual(['seller', 'staff']);
    expect((await h.call('POST', `/api/seller/support/cases/${d.caseId}/evidence`, tokens.seller(newId()), { kind: 'photo', mediaIds: [file] })).status).toBe(404);
  });
});

describe('decisions, drafts and appeals', () => {
  it('saves and discards a decision draft that the parties never see', async () => {
    const d = await disputeCase();
    const draft = { outcome: 'customer_favored', remedies: [{ kind: 'refund' }], reason: 'Item damaged in transit', notifyParties: true };
    const saved = await h.call('PUT', `/api/admin/support/cases/${d.caseId}/decision-draft`, tokens.staff(), draft);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.draft).toMatchObject({ outcome: 'customer_favored' });
    const detail = await h.call('GET', `/api/admin/support/cases/${d.caseId}`, tokens.staff());
    expect(detail.body.decisionDraft.draft.reason).toBe('Item damaged in transit');
    const store = await h.call('GET', `/api/store/support/cases/${d.caseId}`, tokens.customer(d.customerId));
    expect(JSON.stringify(store.body)).not.toContain('Item damaged in transit');
    const del = await h.app.inject({ method: 'DELETE', url: `/api/admin/support/cases/${d.caseId}/decision-draft`, headers: { authorization: `Bearer ${tokens.staff()}` } });
    expect(del.statusCode).toBe(204);
    expect((await h.call('GET', `/api/admin/support/cases/${d.caseId}`, tokens.staff())).body.decisionDraft).toBeNull();
  });

  let d: Awaited<ReturnType<typeof disputeCase>>;

  it('decides with a seller-funded refund: refund request in returns, appeal deadline to both parties', async () => {
    d = await disputeCase({ price: 6000 });
    const res = await h.call('POST', `/api/admin/support/cases/${d.caseId}/decide`, tokens.staff(undefined, DECIDER), { outcome: 'customer_favored', remedies: [{ kind: 'refund' }], reason: 'The photos show transit damage; purchase terms cover it', notifyParties: true }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const c = res.body.case;
    expect(c.status).toBe('decision_made');
    expect(c.decision).toMatchObject({ outcome: 'customer_favored', final: false, decidedBy: { kind: 'staff', id: DECIDER } });
    expect(c.decision.appealDeadline).toBeTruthy();
    expect(c.remedies[0]).toMatchObject({ kind: 'refund', amount: USD(6000), chargedTo: 'seller', status: 'pending_approval' });
    expect(c.remedies[0].refundRequestId).toBeTruthy();
    const ev = h.named('support.case.decided').find((e) => e.caseId === d.caseId);
    expect(ev).toMatchObject({ ref: d.ref, outcome: 'customer_favored', orderId: d.order.id, customerId: d.customerId, contactEmail: 'sam@example.com', sellerId: d.sellerId, final: false });
    expect(ev.remedies[0]).toMatchObject({ kind: 'refund', status: 'pending_approval' });
    expect(h.audits.find((a) => a.action === 'support.case.decide' && a.target.id === d.caseId)).toMatchObject({ category: 'financial' });
    const store = await h.call('GET', `/api/store/support/cases/${d.caseId}`, tokens.customer(d.customerId));
    expect(store.body.can.appeal).toBe(true);
    expect(store.body.messages.at(-1)).toMatchObject({ role: 'system', audience: 'all' });
    const again = await h.call('POST', `/api/admin/support/cases/${d.caseId}/decide`, tokens.staff(), { outcome: 'seller_favored', remedies: [], reason: 'x', notifyParties: false }, idem());
    expect(again.status).toBe(409);
  });

  it('the seller appeals; the original decider cannot decide the appeal (SAME_DECIDER)', async () => {
    const appeal = await h.call('POST', `/api/seller/support/cases/${d.caseId}/appeal`, tokens.seller(d.sellerId), { reason: 'The carrier damaged it, not us' });
    expect(appeal.status, JSON.stringify(appeal.body)).toBe(200);
    expect(appeal.body).toMatchObject({ status: 'appealed', appeal: { status: 'submitted', reason: 'The carrier damaged it, not us' } });
    expect(h.named('support.case.appealed').find((e) => e.caseId === d.caseId)).toMatchObject({ by: { kind: 'seller' } });
    const twice = await h.call('POST', `/api/store/support/cases/${d.caseId}/appeal`, tokens.customer(d.customerId), { reason: 'Me too' });
    expect(twice.status).toBe(409);
    const same = await h.call('POST', `/api/admin/support/cases/${d.caseId}/appeal/decide`, tokens.staff(undefined, DECIDER), { overturn: false, reason: 'Stands' }, idem());
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe('SAME_DECIDER');
  });

  it('a different reviewer overturns: earlier remedies cancelled, the decision is final', async () => {
    const res = await h.call('POST', `/api/admin/support/cases/${d.caseId}/appeal/decide`, tokens.staff(undefined, REVIEWER), { overturn: true, reason: 'Carrier records confirm transit damage; Marketly covers it', remedies: [] }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const c = res.body.case;
    expect(c.status).toBe('decision_made');
    expect(c.decision).toMatchObject({ outcome: 'seller_favored', final: true });
    expect(c.appeal).toMatchObject({ status: 'overturned', reviewer: { id: REVIEWER } });
    expect(c.remedies[0].status).toBe('cancelled');
    // the earlier decision's refund request (still under review) is cancelled in returns
    const refunds = await returnsApi().listRefundRequestsForCase(d.caseId);
    expect(refunds.map((r) => r.status)).toEqual(['cancelled']);
    const detail = await h.call('GET', `/api/admin/support/cases/${d.caseId}`, tokens.staff());
    expect(detail.body.history.find((e: { kind?: string; label: string }) => /Cancelled refund request/.test(e.label))).toBeTruthy();
    expect(h.named('support.case.appeal_decided').find((e) => e.caseId === d.caseId)).toEqual({ caseId: d.caseId, overturned: true });
    expect(h.named('support.case.decided').filter((e) => e.caseId === d.caseId).at(-1)).toMatchObject({ final: true, appealDeadline: null });
    const appealAgain = await h.call('POST', `/api/store/support/cases/${d.caseId}/appeal`, tokens.customer(d.customerId), { reason: 'No' });
    expect(appealAgain.status).toBe(409);
    const resolved = await h.call('POST', `/api/admin/support/cases/${d.caseId}/resolve`, tokens.staff(), { summary: 'Closed after appeal' });
    expect(resolved.status).toBe(200);
  });

  it('an overturn keeps refunds whose money is already moving and reports them on the case', async () => {
    const x = await disputeCase({ price: 5000 });
    const decided = await h.call('POST', `/api/admin/support/cases/${x.caseId}/decide`, tokens.staff(undefined, DECIDER), { outcome: 'customer_favored', remedies: [{ kind: 'refund' }], reason: 'Damaged in transit', notifyParties: true }, idem());
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const refundRequestId = decided.body.case.remedies[0].refundRequestId as string;
    const approved = await h.call('POST', `/api/admin/returns/refunds/${refundRequestId}/approve`, tokens.staff(), {}, idem());
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('processing');
    expect((await h.call('POST', `/api/seller/support/cases/${x.caseId}/appeal`, tokens.seller(x.sellerId), { reason: 'Not our fault' })).status).toBe(200);
    const res = await h.call('POST', `/api/admin/support/cases/${x.caseId}/appeal/decide`, tokens.staff(undefined, REVIEWER), { overturn: true, reason: 'The carrier is at fault', remedies: [] }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // the refund is not cancelled and its remedy stays in progress
    expect((await returnsApi().listRefundRequestsForCase(x.caseId)).map((r) => r.status)).toEqual(['processing']);
    expect(res.body.case.remedies[0]).toMatchObject({ kind: 'refund', status: 'in_progress' });
    const detail = await h.call('GET', `/api/admin/support/cases/${x.caseId}`, tokens.staff());
    const note = detail.body.history.find((e: { label: string }) => /could not be cancelled/.test(e.label));
    expect(note).toBeTruthy();
    expect(note.detail).toContain(approved.body.ref);
    expect(h.audits.filter((a) => a.action === 'support.appeal.decide' && a.target.id === x.caseId).at(-1)!.after).toMatchObject({ refundsCancelled: [], refundsNotCancellable: [{ ref: approved.body.ref, status: 'processing' }] });
  });

  it('an appeal after the deadline is refused (APPEAL_WINDOW_CLOSED)', async () => {
    const x = await disputeCase();
    const decided = await h.call('POST', `/api/admin/support/cases/${x.caseId}/decide`, tokens.staff(), { outcome: 'seller_favored', remedies: [], reason: 'Delivered as described', notifyParties: true, appealDeadline: new Date(h.clock.now().getTime() + DAY).toISOString() }, idem());
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    h.clock.advance(2 * DAY);
    const res = await h.call('POST', `/api/store/support/cases/${x.caseId}/appeal`, tokens.customer(x.customerId), { reason: 'I disagree' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'APPEAL_WINDOW_CLOSED', details: { appealDeadline: expect.any(String) } });
  });

  it('a platform-funded remedy above the limit is saved pending (200 with pendingApproval) and published once approved', async () => {
    const x = await disputeCase({ price: 9000 });
    h.authority['support.remedies.approve'] = 'approval_required';
    const res = await h.call('POST', `/api/admin/support/cases/${x.caseId}/decide`, tokens.staff(undefined, DECIDER), { outcome: 'customer_favored', remedies: [{ kind: 'partial_refund', amount: USD(7000), chargedTo: 'platform' }], reason: 'Goodwill for a lost parcel', notifyParties: true }, idem());
    h.authority['support.remedies.approve'] = 'allowed';
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const requestId = res.body.pendingApproval.approvalRequestId;
    expect(res.body.pendingApproval).toMatchObject({ required: true, approvalRequestId: expect.any(String) });
    expect(res.body.case.status).toBe('escalated');
    expect(res.body.case.decision).toBeNull();
    const request = h.calls.approvals.at(-1)!;
    expect(request).toMatchObject({ action: 'support.remedies.approve', amount: USD(7000), target: { type: 'case', id: x.caseId } });
    const row = (await h.app.kernel.mongo.module('support', spec.collections, schemas).table<any>('cases').get(x.caseId)) as any;
    expect(row).toMatchObject({ approval_request_id: requestId, pending_decision: { kind: 'decision', decision: { outcome: 'customer_favored' } } });
    // another decision while this one waits: nothing is saved (409)
    const again = await h.call('POST', `/api/admin/support/cases/${x.caseId}/decide`, tokens.staff(), { outcome: 'seller_favored', remedies: [], reason: 'Changed my mind', notifyParties: true }, idem());
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'APPROVAL_REQUIRED', details: { approvalRequestId: requestId } });
    let detail = await h.call('GET', `/api/admin/support/cases/${x.caseId}`, tokens.staff());
    expect(detail.body.case.status).toBe('escalated');
    expect(detail.body.pendingApproval).toMatchObject({ approvalRequestId: requestId });
    await h.publish('access', 'access.approval.decided', { requestId, ref: 'AP-9', actionKey: 'support.remedies.approve', module: 'support', target: { type: 'case', id: x.caseId }, outcome: 'approved', decidedBy: { kind: 'staff', id: newId() }, reason: 'OK', amount: USD(7000), approverIds: [], requestedById: DECIDER });
    detail = await h.call('GET', `/api/admin/support/cases/${x.caseId}`, tokens.staff());
    expect(detail.body.case.status).toBe('decision_made');
    expect(detail.body.case.decision.decidedBy.id).toBe(DECIDER);
    expect(detail.body.case.remedies[0]).toMatchObject({ kind: 'partial_refund', chargedTo: 'platform', amount: USD(7000) });
    expect(detail.body.decisionDraft).toBeNull();
    expect(detail.body.pendingApproval).toBeNull();
  });

  it('a rejected approval keeps the decision as a draft', async () => {
    const x = await disputeCase({ price: 9000 });
    h.authority['support.remedies.approve'] = 'approval_required';
    const res = await h.call('POST', `/api/admin/support/cases/${x.caseId}/decide`, tokens.staff(), { outcome: 'customer_favored', remedies: [{ kind: 'refund', chargedTo: 'platform' }], reason: 'Platform pays', notifyParties: true }, idem());
    h.authority['support.remedies.approve'] = 'allowed';
    expect(res.status).toBe(200);
    expect(res.body.decisionDraft).toBeNull();
    await h.publish('access', 'access.approval.decided', { requestId: res.body.pendingApproval.approvalRequestId, ref: 'AP-10', actionKey: 'support.remedies.approve', module: 'support', target: { type: 'case', id: x.caseId }, outcome: 'rejected', decidedBy: { kind: 'staff', id: newId() }, reason: 'Seller should pay', amount: USD(9000), approverIds: [], requestedById: newId() });
    const detail = await h.call('GET', `/api/admin/support/cases/${x.caseId}`, tokens.staff());
    expect(detail.body.case.status).toBe('escalated');
    expect(detail.body.decisionDraft.draft.reason).toBe('Platform pays');
    expect(detail.body.pendingApproval).toBeNull();
    expect(detail.body.history.some((e: { label: string }) => /rejected/.test(e.label))).toBe(true);
  });

  it('denied authority answers FORBIDDEN', async () => {
    const x = await disputeCase();
    h.authority['support.remedies.approve'] = 'denied';
    const res = await h.call('POST', `/api/admin/support/cases/${x.caseId}/decide`, tokens.staff(), { outcome: 'customer_favored', remedies: [{ kind: 'refund', chargedTo: 'platform' }], reason: 'x', notifyParties: false }, idem());
    h.authority['support.remedies.approve'] = 'allowed';
    expect(res.status).toBe(403);
  });
});

describe('seller support requests and categories', () => {
  it('a seller contacts seller support; staff answer; the seller sees it in its requests', async () => {
    const sellerId = newId();
    const opts = await h.call('GET', '/api/seller/support/categories', tokens.seller(sellerId));
    expect(opts.status).toBe(200);
    expect(opts.body.categories.map((c: { key: string }) => c.key)).toContain('fees_payouts');
    expect(opts.body.hoursLabel).toBeTruthy();
    const bad = await h.call('POST', '/api/seller/support/requests', tokens.seller(sellerId), { category: 'item_damaged', subject: 'x', message: 'y', replyChannel: 'seller_center_only' }, idem());
    expect(bad.status).toBe(400);
    const res = await h.call('POST', '/api/seller/support/requests', tokens.seller(sellerId), { category: 'fees_payouts', subject: 'Payout missing', message: 'My payout PO-1 did not arrive', reference: 'PO-1', replyChannel: 'seller_center_and_email' }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ kind: 'seller_request', status: 'open', handledBy: { kind: 'marketplace_support', team: 'Seller Manager' } });
    const list = await h.call('GET', '/api/seller/support/cases?scope=support_requests', tokens.seller(sellerId));
    expect(list.body.items.map((r: { id: string }) => r.id)).toEqual([res.body.id]);
    const answer = await h.call('POST', `/api/admin/support/cases/${res.body.id}/messages`, tokens.staff(), { body: 'It was sent today', audience: 'seller' });
    expect(answer.status).toBe(200);
    const seen = await h.call('GET', `/api/seller/support/cases/${res.body.id}`, tokens.seller(sellerId));
    expect(seen.body.messages.at(-1)).toMatchObject({ body: 'It was sent today', role: 'marketly_staff' });
    expect((await h.call('GET', `/api/store/support/cases/${res.body.id}`, tokens.customer(newId()))).status).toBe(404);
    expect(h.named('support.case.opened').find((e) => e.caseId === res.body.id)).toMatchObject({ kind: 'seller_request', sellerId, customerId: null });
  });

  it('staff list and change categories (audited); new targets apply to new cases', async () => {
    const list = await h.call('GET', '/api/admin/support/categories', tokens.staff());
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThanOrEqual(15);
    const res = await h.call('PUT', '/api/admin/support/categories/item_damaged', tokens.staff(), { label: 'Item arrived damaged', defaultPriority: 'urgent', team: 'customer_support', sellerHandlesFirst: true, firstResponseBusinessHours: 2, nextResponseBusinessHours: 4, resolutionBusinessDays: 3, active: true, reason: 'Damage cases are urgent' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ key: 'item_damaged', defaultPriority: 'urgent', firstResponseBusinessHours: 2, audience: 'customer' });
    expect(h.audits.some((a) => a.action === 'support.category.update')).toBe(true);
    const o = await sellerOrder(h);
    const opened = await reportProblem(h, { customerId: o.customerId, orderId: o.order.id, itemIds: [o.itemId] });
    expect(opened.body.priority).toBe('urgent');
    const warranty = { label: 'Warranty claim', defaultPriority: 'medium', team: 'customer_support', sellerHandlesFirst: false, firstResponseBusinessHours: 8, nextResponseBusinessHours: 8, resolutionBusinessDays: 10, active: true, reason: 'New topic' };
    // a new key needs its audience and group
    const missing = await h.call('PUT', '/api/admin/support/categories/warranty_claim', tokens.staff(), warranty);
    expect(missing.status).toBe(400);
    expect(missing.body.error.details.issues.map((i: { path: string }) => i.path).sort()).toEqual(['audience', 'group']);
    const created = await h.call('PUT', '/api/admin/support/categories/warranty_claim', tokens.staff(), { ...warranty, audience: 'customer', group: 'damaged_or_wrong' });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ audience: 'customer', group: 'damaged_or_wrong' });
    // an existing one keeps them when left out
    expect((await h.call('PUT', '/api/admin/support/categories/warranty_claim', tokens.staff(), { ...warranty, label: 'Warranty' })).body).toMatchObject({ label: 'Warranty', audience: 'customer', group: 'damaged_or_wrong' });
    expect((await h.call('PUT', '/api/admin/support/categories/Bad Key', tokens.staff(), { label: 'x', defaultPriority: 'low', team: 'customer_support', sellerHandlesFirst: false, firstResponseBusinessHours: 1, nextResponseBusinessHours: 1, resolutionBusinessDays: 1, active: true, reason: 'x' })).status).toBe(400);
  });
});
