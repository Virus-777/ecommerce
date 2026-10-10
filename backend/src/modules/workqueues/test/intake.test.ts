/**
 * The intake table: every consumed event is covered, each opening event raises one item per dedupe
 * key (twice = refreshed, not duplicated) and each resolving event closes it (fixed_at_source).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allSpecs } from '../../../kernel/module-system/loader.js';
import { validSample } from '../../../testing/samples.js';
import { spec } from '../../../spec/workqueues.js';
import { INTAKE, intakeRuleDocs, resolvesOnByKind } from '../domain/intake.js';
import { QUEUE_SEEDS } from '../domain/catalog.js';
import { Core } from '../app/core.js';
import { as, boot, capture, money, newId, publish } from './harness.js';

type Booted = Awaited<ReturnType<typeof boot>>;
let t: Booted;

beforeAll(async () => {
  t = await boot();
});
afterAll(async () => {
  await t?.app.close();
});

/** A valid payload of another module's event (from its spec), with overrides */
function ev(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const mod = name.split('.')[0]!;
  const def = allSpecs[mod]!.events.publishes[name]!;
  return { ...(validSample(def.payload()).value as Record<string, unknown>), ...over };
}

const active = async (dedupeKey: string) => (await t.service.core.repo.activeByDedupe(dedupeKey)) ?? null;
const anyByDedupe = async (dedupeKey: string) => (await t.service.core.repo.activeByDedupe(dedupeKey)) ?? (await t.service.core.repo.latestClosedByDedupe(dedupeKey));

describe('intake table', () => {
  it('covers every event the spec consumes, and nothing else', () => {
    expect(Object.keys(INTAKE).sort()).toEqual(Object.keys(spec.events.consumes).sort());
    expect(Object.keys(INTAKE)).toHaveLength(54);
  });

  it('every entry opens, closes or routes something', () => {
    for (const [name, e] of Object.entries(INTAKE)) expect(Boolean(e.opens?.length || e.closes?.length || e.effect), name).toBe(true);
  });

  it('opens items only in installable queues, and every closing kind is a kind some event opens or raise() is documented for', () => {
    const opened = new Set(intakeRuleDocs().map((r) => r.kind));
    for (const r of intakeRuleDocs()) expect(QUEUE_SEEDS[r.queueKey], r.queueKey).toBeDefined();
    // kinds other modules raise through raise() and an event closes (spec notes)
    const raised = new Set(['restriction_review', 'return_parcel_overdue', 'review_moderation_overdue']);
    for (const [kind] of resolvesOnByKind()) expect(opened.has(kind) || raised.has(kind), kind).toBe(true);
  });

  it('derives resolvesOn from the closing events', () => {
    const r = resolvesOnByKind();
    expect(r.get('overdue_dispatch')).toEqual(expect.arrayContaining(['shipping.shipment.dispatched', 'orders.item.cancelled']));
    expect(r.get('product_review')).toEqual(expect.arrayContaining(['catalog.product.approved', 'catalog.product.changes_requested', 'catalog.product.rejected']));
    expect(r.get('payment_check')).toEqual(expect.arrayContaining(['payments.payment.captured', 'payments.payment.failed']));
  });

  it('GET /intake-rules lists the seeded rules with resolvesOn', async () => {
    const admin = t.world.person('Admin');
    const res = await t.app.inject({ method: 'GET', url: '/api/admin/workqueues/intake-rules', headers: as.staff(admin) });
    expect(res.statusCode, res.body).toBe(200);
    const rules = res.json() as { event: string; kind: string; queueKey: string; resolvesOn: string[] }[];
    const od = rules.find((x) => x.event === 'shipping.dispatch.overdue')!;
    expect(od).toMatchObject({ queueKey: 'shipping.overdue_dispatch', kind: 'overdue_dispatch' });
    expect(od.resolvesOn).toContain('shipping.shipment.dispatched');
    expect(new Set(rules.map((x) => x.event)).size).toBeGreaterThan(20);
  });
});

describe('overdue dispatch (scenario 5)', () => {
  it('opens one seller-visible item per order item, with the delivery exception as a related subject; twice does not duplicate', async () => {
    const sellerId = newId();
    const [a, b] = [newId(), newId()];
    const exceptionId = newId();
    const seen = capture(t.app, 'workqueues.item.created', 'workqueues.item.resolved');
    const payload = ev('shipping.dispatch.overdue', { orderId: newId(), orderRef: 'MK-261007-10433', ownerType: 'seller', sellerId, orderItemIds: [a, b], exceptionId, dueAt: new Date(Date.now() - 3_600_000).toISOString() });
    await publish(t.app, 'shipping.dispatch.overdue', payload);
    await publish(t.app, 'shipping.dispatch.overdue', payload);
    const item = await active(`overdue_dispatch:${a}`);
    expect(item).toMatchObject({ kind: 'overdue_dispatch', queue_key: 'shipping.overdue_dispatch', visible_to_seller: true, seller_id: sellerId, subject_type: 'order', subject_ref: 'MK-261007-10433', state: 'open' });
    expect(item!.related_subjects).toEqual(expect.arrayContaining([{ type: 'delivery_exception', id: exceptionId, label: 'Late dispatch' }]));
    const itemB = await active(`overdue_dispatch:${b}`);
    expect(itemB).not.toBeNull();
    const ids = [item!.id, itemB!.id];
    expect(seen.filter((e) => e.name === 'workqueues.item.created' && ids.includes(e.payload.itemId))).toHaveLength(2);
    // a refresh is in the history, not a second item
    const events = await t.service.core.repo.eventsOf(item!.id);
    expect(events.map((e) => e.kind)).toEqual(['raised', 'refreshed']);

    // the seller sees the same task
    const tasks = await t.app.inject({ method: 'GET', url: '/api/seller/workqueues/tasks', headers: as.seller(sellerId) });
    expect(tasks.statusCode, tasks.body).toBe(200);
    expect(tasks.json().items.map((x: { kind: string }) => x.kind)).toEqual(['overdue_dispatch', 'overdue_dispatch']);
    expect(tasks.json().items[0]).toMatchObject({ screen: 'seller/order', state: 'open' });
    expect(tasks.json().items[0]).not.toHaveProperty('notes');
    // another seller sees nothing
    const other = await t.app.inject({ method: 'GET', url: '/api/seller/workqueues/tasks', headers: as.seller(newId()) });
    expect(other.json().items).toEqual([]);

    // dispatch of item a closes it at source; cancelling item b closes the other
    await publish(t.app, 'shipping.shipment.dispatched', ev('shipping.shipment.dispatched', { lines: [{ orderItemId: a, title: 'Lamp', variantLabel: 'Blue', quantity: 1 }], trackingValid: true, onTime: false }));
    const closed = await t.service.core.repo.getItem(item!.id);
    expect(closed).toMatchObject({ state: 'resolved', resolution: { outcome: 'fixed_at_source' } });
    await publish(t.app, 'orders.item.cancelled', ev('orders.item.cancelled', { itemId: b }));
    expect(await active(`overdue_dispatch:${b}`)).toBeNull();
    expect(seen.filter((e) => e.name === 'workqueues.item.resolved').map((e) => e.payload.outcome)).toEqual(['fixed_at_source', 'fixed_at_source']);

    // resolved tasks are listed for the seller with state=resolved
    const done = await t.app.inject({ method: 'GET', url: '/api/seller/workqueues/tasks?state=resolved', headers: as.seller(sellerId) });
    expect(done.json().items).toHaveLength(2);
  });

  it('the Official Store items are not seller-visible', async () => {
    const itemId = newId();
    await publish(t.app, 'shipping.dispatch.overdue', ev('shipping.dispatch.overdue', { ownerType: 'official', sellerId: null, orderItemIds: [itemId] }));
    expect(await active(`overdue_dispatch:${itemId}`)).toMatchObject({ visible_to_seller: false, seller_id: null });
  });
});

/* ------------------------------------------------------------------ every opening event and its closing event */

interface Scenario {
  name: string;
  open: [string, Record<string, unknown>];
  kind: string;
  queue: string;
  dedupe: string;
  close: [string, Record<string, unknown>] | { resolveBySource: true };
}

function scenarios(): Scenario[] {
  const id = () => newId();
  const out: Scenario[] = [];
  {
    const item = id();
    const ex = id();
    out.push({ name: 'missing tracking', open: ['shipping.shipment.exception', ev('shipping.shipment.exception', { kind: 'missing_tracking', exceptionId: ex, orderItemIds: [item] })], kind: 'missing_tracking', queue: 'shipping.missing_tracking', dedupe: `missing_tracking:${item}`, close: ['shipping.shipment.dispatched', ev('shipping.shipment.dispatched', { trackingValid: true, lines: [{ orderItemId: item, title: 'x', variantLabel: 'y', quantity: 1 }] })] });
  }
  {
    const item = id();
    const ex = id();
    out.push({ name: 'seller cannot fulfill', open: ['shipping.shipment.exception', ev('shipping.shipment.exception', { kind: 'seller_cannot_fulfill', exceptionId: ex, orderItemIds: [item] })], kind: 'seller_cannot_fulfill', queue: 'orders.seller_cannot_fulfill', dedupe: `exception:${ex}`, close: ['orders.item.cancelled', ev('orders.item.cancelled', { itemId: item })] });
  }
  {
    const ex = id();
    const shipmentId = id();
    out.push({ name: 'failed delivery', open: ['shipping.shipment.exception', ev('shipping.shipment.exception', { kind: 'failed_delivery', exceptionId: ex, shipmentId })], kind: 'delivery_exception', queue: 'shipping.delivery_exceptions', dedupe: `exception:${ex}`, close: ['shipping.shipment.delivered', ev('shipping.shipment.delivered', { shipmentId })] });
  }
  {
    const s = id();
    out.push({ name: 'low stock', open: ['inventory.stock.low', ev('inventory.stock.low', { stockItemId: s, ownerType: 'official', available: 0, threshold: 5 })], kind: 'low_stock', queue: 'inventory.low_stock', dedupe: `low_stock:${s}`, close: ['inventory.stock.changed', ev('inventory.stock.changed', { stockItemId: s, state: 'in_stock', available: 40 })] });
  }
  {
    const r = id();
    out.push({ name: 'approval', open: ['access.approval.requested', ev('access.approval.requested', { requestId: r, ref: 'AP-1', eligibleRoleKeys: ['finance_manager'], dueAt: new Date(Date.now() + 86_400_000).toISOString() })], kind: 'approval_waiting', queue: 'access.approvals', dedupe: `approval:${r}`, close: ['access.approval.decided', ev('access.approval.decided', { requestId: r, outcome: 'approved' })] });
  }
  {
    const c = id();
    out.push({ name: 'case past target', open: ['support.case.overdue', ev('support.case.overdue', { caseId: c, whoMustAct: 'marketplace' })], kind: 'case_past_target', queue: 'support.cases_waiting', dedupe: `case_past_target:${c}`, close: ['support.case.resolved', ev('support.case.resolved', { caseId: c })] });
  }
  {
    const c = id();
    out.push({ name: 'case escalated', open: ['support.case.escalated', ev('support.case.escalated', { caseId: c, to: 'finance' })], kind: 'case_escalated', queue: 'support.cases_waiting', dedupe: `case_escalated:${c}`, close: ['support.case.resolved', ev('support.case.resolved', { caseId: c })] });
  }
  {
    const r = id();
    out.push({ name: 'return decision', open: ['returns.return.escalated', ev('returns.return.escalated', { returnId: r, reason: 'seller_no_response' })], kind: 'return_decision', queue: 'returns.decisions', dedupe: `return_decision:${r}`, close: ['returns.refund.approved', ev('returns.refund.approved', { returnId: r })] });
  }
  {
    const p = id();
    out.push({ name: 'payout failed', open: ['finance.payout.failed', ev('finance.payout.failed', { payoutId: p, ref: 'PO-261005-3381', amount: money(125_000) })], kind: 'payout_failed', queue: 'finance.payout_failures', dedupe: `payout_failed:${p}`, close: ['finance.payout.paid', ev('finance.payout.paid', { payoutId: p })] });
  }
  {
    const i = id();
    out.push({ name: 'reconciliation mismatch', open: ['finance.reconciliation.mismatch_found', ev('finance.reconciliation.mismatch_found', { itemId: i, difference: money(-4_200) })], kind: 'payment_mismatch', queue: 'finance.payment_checks', dedupe: `payment_mismatch:${i}`, close: ['finance.reconciliation.item_closed', ev('finance.reconciliation.item_closed', { itemId: i, outcome: 'explained' })] });
  }
  {
    const i = id();
    out.push({ name: 'payment check (captured)', open: ['payments.payment.pending_check', ev('payments.payment.pending_check', { intentId: i })], kind: 'payment_check', queue: 'finance.payment_checks', dedupe: `payment_check:${i}`, close: ['payments.payment.captured', ev('payments.payment.captured', { intentId: i })] });
  }
  {
    const i = id();
    out.push({ name: 'payment check (failed)', open: ['payments.payment.pending_check', ev('payments.payment.pending_check', { intentId: i })], kind: 'payment_check', queue: 'finance.payment_checks', dedupe: `payment_check:${i}`, close: ['payments.payment.failed', ev('payments.payment.failed', { intentId: i })] });
  }
  {
    const i = id();
    out.push({ name: 'payment check (authorized)', open: ['payments.payment.pending_check', ev('payments.payment.pending_check', { intentId: i })], kind: 'payment_check', queue: 'finance.payment_checks', dedupe: `payment_check:${i}`, close: ['payments.payment.authorized', ev('payments.payment.authorized', { intentId: i })] });
  }
  {
    const d = id();
    out.push({ name: 'chargeback', open: ['payments.chargeback.opened', ev('payments.chargeback.opened', { disputeId: d, evidenceDueAt: new Date(Date.now() + 5 * 86_400_000).toISOString() })], kind: 'chargeback', queue: 'finance.chargebacks', dedupe: `chargeback:${d}`, close: ['payments.chargeback.decided', ev('payments.chargeback.decided', { disputeId: d, outcome: 'won' })] });
  }
  for (const closing of ['catalog.product.approved', 'catalog.product.changes_requested', 'catalog.product.rejected']) {
    const p = id();
    out.push({ name: `product review (${closing})`, open: ['catalog.product.submitted', ev('catalog.product.submitted', { productId: p })], kind: 'product_review', queue: 'catalog.product_review', dedupe: `product_review:${p}`, close: [closing, ev(closing, { productId: p })] });
  }
  {
    const a = id();
    out.push({ name: 'application', open: ['sellers.application.submitted', ev('sellers.application.submitted', { applicationId: a })], kind: 'application_waiting', queue: 'sellers.applications', dedupe: `application:${a}`, close: ['sellers.application.decided', ev('sellers.application.decided', { applicationId: a })] });
  }
  {
    const s = id();
    out.push({ name: 'launch review', open: ['sellers.launch_review.requested', ev('sellers.launch_review.requested', { sellerId: s })], kind: 'launch_review', queue: 'sellers.launch_reviews', dedupe: `launch_review:${s}`, close: ['sellers.launch_review.decided', ev('sellers.launch_review.decided', { sellerId: s })] });
  }
  {
    const a = id();
    out.push({ name: 'appeal', open: ['sellers.appeal.submitted', ev('sellers.appeal.submitted', { appealId: a, decideBy: new Date(Date.now() + 3 * 86_400_000).toISOString() })], kind: 'appeal_due', queue: 'sellers.appeals', dedupe: `appeal:${a}`, close: ['sellers.appeal.decided', ev('sellers.appeal.decided', { appealId: a })] });
  }
  {
    const r = id();
    out.push({ name: 'restriction evidence', open: ['sellers.restriction.evidence_submitted', ev('sellers.restriction.evidence_submitted', { restrictionId: r })], kind: 'restriction_evidence', queue: 'sellers.restrictions', dedupe: `restriction_evidence:${r}`, close: ['sellers.restriction.lifted', ev('sellers.restriction.lifted', { restrictionId: r })] });
  }
  {
    const r = id();
    out.push({ name: 'restriction evidence (restriction changed)', open: ['sellers.restriction.evidence_submitted', ev('sellers.restriction.evidence_submitted', { restrictionId: r })], kind: 'restriction_evidence', queue: 'sellers.restrictions', dedupe: `restriction_evidence:${r}`, close: ['sellers.restriction.updated', ev('sellers.restriction.updated', { restrictionId: r })] });
  }
  {
    const s = id();
    out.push({ name: 'seller performance', open: ['sellers.performance.below_target', ev('sellers.performance.below_target', { sellerId: s, metrics: ['late_dispatch_rate'], overall: 'at_risk' })], kind: 'seller_performance', queue: 'sellers.performance', dedupe: `seller_performance:${s}`, close: { resolveBySource: true } });
  }
  {
    const c = id();
    out.push({ name: 'store change', open: ['sellers.change_request.submitted', ev('sellers.change_request.submitted', { changeRequestId: c, kind: 'store_name' })], kind: 'storefront_review', queue: 'sellers.launch_reviews', dedupe: `change_request:${c}`, close: ['sellers.change_request.decided', ev('sellers.change_request.decided', { changeRequestId: c, approved: true })] });
  }
  {
    const r = id();
    out.push({ name: 'trust report', open: ['trust.report.created', ev('trust.report.created', { reportId: r, riskScore: 85 })], kind: 'trust_report', queue: 'trust.reports', dedupe: `trust_report:${r}`, close: ['trust.report.resolved', ev('trust.report.resolved', { reportId: r })] });
  }
  {
    const r = id();
    out.push({ name: 'trust recommendation', open: ['trust.recommendation.routed', ev('trust.recommendation.routed', { recommendationId: r, ownerTeam: 'catalog', ownerRole: 'catalog_manager' })], kind: 'trust_recommendation', queue: 'catalog.product_review', dedupe: `trust_recommendation:${r}`, close: ['trust.recommendation.decided', ev('trust.recommendation.decided', { recommendationId: r })] });
  }
  {
    const c = id();
    out.push({ name: 'reply overdue', open: ['messaging.reply.overdue', ev('messaging.reply.overdue', { conversationId: c, officialStore: false })], kind: 'seller_reply_overdue', queue: 'sellers.performance', dedupe: `reply_overdue:${c}`, close: ['messaging.message.sent', ev('messaging.message.sent', { conversationId: c, authorKind: 'seller' })] });
  }
  {
    const r = id();
    out.push({ name: 'data request', open: ['customers.data_export.requested', ev('customers.data_export.requested', { requestId: r })], kind: 'data_request', queue: 'customers.data_requests', dedupe: `data_request:${r}`, close: ['customers.data_export.ready', ev('customers.data_export.ready', { requestId: r })] });
  }
  return out;
}

describe('every opening event raises its item and its resolving event closes it', () => {
  const list = scenarios();

  it('the scenarios exercise every consumed event except the access routing events', () => {
    const used = new Set(list.flatMap((s) => [s.open[0], ...(Array.isArray(s.close) ? [s.close[0]] : [])]));
    used.add('shipping.dispatch.overdue'); // tested above
    used.add('warehouse.return_parcel.received'); // closes items raised through raise(): tested below
    used.add('reviews.moderation.decided'); // closes items reviews raises through raise(): test/pass3.test.ts
    const routing = ['access.away.started', 'access.away.ended', 'access.coverage.changed', 'sellers.application.information_provided'];
    expect(Object.keys(spec.events.consumes).filter((e) => !used.has(e) && !routing.includes(e))).toEqual([]);
  });

  it.each(list.map((s) => [s.name, s] as const))('%s', async (_n, s) => {
    await publish(t.app, s.open[0], s.open[1]);
    await publish(t.app, s.open[0], s.open[1]);
    const item = await active(s.dedupe);
    expect(item, `${s.open[0]} raised ${s.dedupe}`).toMatchObject({ kind: s.kind, queue_key: s.queue, state: 'open', source_event: s.open[0] });
    expect(await t.service.core.repo.countItems({ queueKeys: [s.queue], kinds: [s.kind], states: ['open'], search: item!.ref })).toBe(1);
    if (Array.isArray(s.close)) {
      const resolved = capture(t.app, 'workqueues.item.resolved');
      await publish(t.app, s.close[0], s.close[1]);
      await publish(t.app, s.close[0], s.close[1]); // delivered twice: closed once
      expect(resolved.filter((e) => e.payload.itemId === item!.id)).toHaveLength(1);
      expect((await t.service.core.repo.eventsOf(item!.id)).filter((e) => e.kind === 'fixed_at_source')).toHaveLength(1);
    } else expect(await t.service.resolveBySource(s.dedupe, { note: 'fixed by the owner', by: { kind: 'system', name: 'test' } })).toBe(1);
    const after = await anyByDedupe(s.dedupe);
    expect(after).toMatchObject({ id: item!.id, state: 'resolved', resolution: { outcome: 'fixed_at_source' } });
  });
});

describe('special intake rules', () => {
  it('events that do not concern work are ignored (customer to act, seller stock, late dispatch exception)', async () => {
    const c = newId();
    await publish(t.app, 'support.case.overdue', ev('support.case.overdue', { caseId: c, whoMustAct: 'none' }));
    expect(await active(`case_past_target:${c}`)).toBeNull();
    const s = newId();
    await publish(t.app, 'inventory.stock.low', ev('inventory.stock.low', { stockItemId: s, ownerType: 'seller' }));
    expect(await active(`low_stock:${s}`)).toBeNull();
    const ex = newId();
    await publish(t.app, 'shipping.shipment.exception', ev('shipping.shipment.exception', { kind: 'late_dispatch', exceptionId: ex }));
    expect(await active(`exception:${ex}`)).toBeNull();
    const r = newId();
    await publish(t.app, 'returns.return.escalated', ev('returns.return.escalated', { returnId: r, reason: 'customer_disagrees', by: { kind: 'customer', id: newId() } }));
    expect(await active(`return_decision:${r}`)).toBeNull();
  });

  it('a stock change that is still low does not close the low-stock item', async () => {
    const s = newId();
    await publish(t.app, 'inventory.stock.low', ev('inventory.stock.low', { stockItemId: s, ownerType: 'official' }));
    await publish(t.app, 'inventory.stock.changed', ev('inventory.stock.changed', { stockItemId: s, state: 'low_stock' }));
    expect(await active(`low_stock:${s}`)).not.toBeNull();
  });

  it('a customer message does not close a seller reply task', async () => {
    const c = newId();
    await publish(t.app, 'messaging.reply.overdue', ev('messaging.reply.overdue', { conversationId: c, officialStore: false }));
    await publish(t.app, 'messaging.message.sent', ev('messaging.message.sent', { conversationId: c, authorKind: 'customer' }));
    expect(await active(`reply_overdue:${c}`)).toMatchObject({ visible_to_seller: true });
  });

  it('a second case escalation raises the priority', async () => {
    const c = newId();
    const p = ev('support.case.escalated', { caseId: c, to: 'trust' });
    await publish(t.app, 'support.case.escalated', p);
    expect(await active(`case_escalated:${c}`)).toMatchObject({ priority: 'high', owner_role: 'trust_and_risk_manager' });
    await publish(t.app, 'support.case.escalated', p);
    expect(await active(`case_escalated:${c}`)).toMatchObject({ priority: 'urgent' });
  });

  it('trust report priority comes from the risk score; approvals belong to the approvers role with the request deadline', async () => {
    const low = newId();
    await publish(t.app, 'trust.report.created', ev('trust.report.created', { reportId: low, riskScore: 10 }));
    expect(await active(`trust_report:${low}`)).toMatchObject({ priority: 'low' });
    const r = newId();
    const dueAt = new Date(Date.now() + 2 * 86_400_000);
    await publish(t.app, 'access.approval.requested', ev('access.approval.requested', { requestId: r, eligibleRoleKeys: ['finance_manager'], dueAt: dueAt.toISOString(), amount: money(250_000) }));
    const item = await active(`approval:${r}`);
    expect(item).toMatchObject({ owner_role: 'finance_manager', amount_minor: 250_000 });
    expect(item!.due_at.toISOString()).toBe(dueAt.toISOString());
  });

  it('information provided puts a waiting application back to work with a fresh deadline', async () => {
    const reviewer = t.world.person('Reviewer', ['seller_manager']);
    const a = newId();
    const sellerId = newId();
    await publish(t.app, 'sellers.application.submitted', ev('sellers.application.submitted', { applicationId: a, sellerId }));
    const item = (await active(`application:${a}`))!;
    const h = as.staff(reviewer);
    expect((await t.app.inject({ method: 'POST', url: `/api/admin/workqueues/items/${item.id}/claim`, headers: h })).statusCode).toBe(200);
    const w = await t.app.inject({ method: 'POST', url: `/api/admin/workqueues/items/${item.id}/wait`, headers: h, payload: { waitingOn: 'seller', note: 'Asked for the business registration' } });
    expect(w.json()).toMatchObject({ state: 'waiting', waitingOn: 'seller' });
    await publish(t.app, 'sellers.application.information_provided', ev('sellers.application.information_provided', { applicationId: a, sellerId }));
    const after = (await active(`application:${a}`))!;
    expect(after).toMatchObject({ id: item.id, state: 'in_progress', waiting_on: null });
  });

  it('a raise after a dismissal reopens the dismissed item (the source fired again)', async () => {
    const s = newId();
    const admin = t.world.person('Inventory', ['inventory_manager']);
    await publish(t.app, 'inventory.stock.low', ev('inventory.stock.low', { stockItemId: s, ownerType: 'official' }));
    const item = (await active(`low_stock:${s}`))!;
    const d = await t.app.inject({ method: 'POST', url: `/api/admin/workqueues/items/${item.id}/dismiss`, headers: as.staff(admin), payload: { reason: 'False alarm: count was wrong' } });
    expect(d.json()).toMatchObject({ state: 'dismissed', resolution: { outcome: 'dismissed' } });
    await publish(t.app, 'inventory.stock.low', ev('inventory.stock.low', { stockItemId: s, ownerType: 'official' }));
    expect(await active(`low_stock:${s}`)).toMatchObject({ id: item.id, state: 'open', resolution: null });
  });

  it('a consumer never fails for something it cannot place', async () => {
    // unknown subjects close nothing and do not throw
    await publish(t.app, 'finance.payout.paid', ev('finance.payout.paid', { payoutId: newId() }));
    await publish(t.app, 'access.approval.decided', ev('access.approval.decided', { requestId: newId() }));
  });
});

describe('kinds raised by other modules and the queue of each kind', () => {
  const by = { kind: 'system' as const, name: 'test' };

  it('restriction reviews raised by sellers land in sellers.restrictions and close when the restriction is lifted (not when it changes)', async () => {
    const restrictionId = newId();
    const sellerId = newId();
    // sellers names its old queue: the kind's own queue wins
    const review = await t.service.raise({ sourceModule: 'test', queueKey: 'sellers.performance', kind: 'restriction_review', title: 'Review restriction RS-1', subject: { type: 'restriction', id: restrictionId, ref: 'RS-1' }, sellerId, dedupeKey: `restriction_review:${restrictionId}:2026-10-10` });
    expect(review.queueKey).toBe('sellers.restrictions');
    await publish(t.app, 'sellers.restriction.evidence_submitted', ev('sellers.restriction.evidence_submitted', { restrictionId, sellerId }));
    await publish(t.app, 'sellers.restriction.updated', ev('sellers.restriction.updated', { restrictionId, sellerId }));
    expect(await active(`restriction_evidence:${restrictionId}`)).toBeNull();
    expect(await active(`restriction_review:${restrictionId}:2026-10-10`)).toMatchObject({ id: review.id, state: 'open' });
    const lifted = ev('sellers.restriction.lifted', { restrictionId, sellerId, reason: 'Documents verified' });
    await publish(t.app, 'sellers.restriction.lifted', lifted);
    await publish(t.app, 'sellers.restriction.lifted', lifted);
    expect(await t.service.core.repo.getItem(review.id)).toMatchObject({ state: 'resolved', resolution: { outcome: 'fixed_at_source', note: 'Restriction lifted: Documents verified' } });
  });

  it('return parcels: overdue items close when the parcel is received, unexpected parcels stay for a person', async () => {
    const parcelId = newId();
    const returnId = newId();
    const overdue = await t.service.raise({ sourceModule: 'test', queueKey: 'returns.decisions', kind: 'return_parcel_overdue', title: 'Return parcel not received: RT-1', subject: { type: 'other', id: parcelId, label: 'Return parcel' }, relatedSubjects: [{ type: 'return', id: returnId }], dedupeKey: `return_parcel_overdue:${parcelId}` });
    expect(overdue).toMatchObject({ queueKey: 'warehouse.return_parcels', kind: 'return_parcel_overdue' });
    const strayId = newId();
    const stray = await t.service.raise({ sourceModule: 'test', queueKey: 'warehouse.return_parcels', kind: 'unexpected_return_parcel', title: 'Unexpected return parcel 1Z', subject: { type: 'other', id: strayId, label: 'Return parcel' }, dedupeKey: `return_parcel:${strayId}` });
    const received = (id: string, unexpected: boolean) => ev('warehouse.return_parcel.received', { parcelId: id, returnId: unexpected ? null : returnId, unexpected, parcelCondition: 'intact', receivedAt: new Date().toISOString() });
    await publish(t.app, 'warehouse.return_parcel.received', received(parcelId, false));
    await publish(t.app, 'warehouse.return_parcel.received', received(parcelId, false));
    await publish(t.app, 'warehouse.return_parcel.received', received(strayId, true));
    expect(await t.service.core.repo.getItem(overdue.id)).toMatchObject({ state: 'resolved', resolution: { outcome: 'fixed_at_source' } });
    expect(await t.service.core.repo.getItem(stray.id)).toMatchObject({ state: 'open' });
    // an overdue item raised before parcels were the subject (the return was) closes too
    const oldStyle = newId();
    const before = await t.service.raise({ sourceModule: 'test', queueKey: 'warehouse.return_parcels', kind: 'return_parcel_overdue', title: 'Return parcel not received', subject: { type: 'return', id: oldStyle }, dedupeKey: `return_parcel_overdue:${newId()}` });
    await publish(t.app, 'warehouse.return_parcel.received', ev('warehouse.return_parcel.received', { parcelId: newId(), returnId: oldStyle, unexpected: false }));
    expect(await t.service.core.repo.getItem(before.id)).toMatchObject({ state: 'resolved' });
  });

  it('seller performance items are closed by hand; a payment authorized without a check closes nothing', async () => {
    const sellerId = newId();
    await publish(t.app, 'sellers.performance.below_target', ev('sellers.performance.below_target', { sellerId, metrics: ['late_dispatch_rate'], overall: 'at_risk' }));
    expect(await active(`seller_performance:${sellerId}`)).toMatchObject({ queue_key: 'sellers.performance', state: 'open' });
    const resolved = capture(t.app, 'workqueues.item.resolved');
    await publish(t.app, 'payments.payment.authorized', ev('payments.payment.authorized', { intentId: newId() }));
    expect(resolved).toEqual([]);
    expect(await t.service.raise({ sourceModule: 'test', queueKey: 'finance.daily_checks', kind: 'chargeback', title: 'Chargeback DP-1', subject: { type: 'other', id: newId() }, dedupeKey: `chargeback:${newId()}`, amount: money(5_000) })).toMatchObject({ queueKey: 'finance.chargebacks' });
  });
});

describe('seeding an existing install', () => {
  it('adds the new queues, keeps edited queues, retires re-routed rules and changes nothing the second time', async () => {
    const repo = t.service.core.repo;
    // an install from before: a staff-edited queue and the old rule sending chargebacks to Daily finance checks
    const editor = newId();
    await repo.updateQueue('sellers.applications', { name: 'Applications (Ana)', updated_by: editor });
    const oldRule = (await repo.listIntakeRules({ queueKey: 'finance.chargebacks' })).find((r) => r.event === 'payments.chargeback.opened')!;
    const oldId = newId();
    await repo.upsertIntakeRules([{ ...oldRule, id: oldId, queue_key: 'finance.daily_checks', active: true }]);

    const restart = () => new Core({ repo, ctx: t.service.core.ctx }).ensureSeeded();
    await restart();
    const queues = await repo.listQueues();
    for (const key of ['warehouse.return_parcels', 'inventory.low_stock', 'finance.payment_checks', 'finance.chargebacks', 'sellers.launch_reviews', 'sellers.restrictions']) expect(queues.map((q) => q.key)).toContain(key);
    expect(queues.find((q) => q.key === 'sellers.applications')).toMatchObject({ name: 'Applications (Ana)', updated_by: editor });
    const rules = await repo.listIntakeRules();
    expect(rules.find((r) => r.id === oldId)).toMatchObject({ active: false });
    expect(rules.filter((r) => r.event === 'payments.chargeback.opened' && r.active).map((r) => r.queue_key)).toEqual(['finance.chargebacks']);

    await restart();
    expect((await repo.listQueues()).length).toBe(queues.length);
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect((await repo.listIntakeRules()).sort(byId)).toEqual(rules.sort(byId));
  });
});

describe('public API', () => {
  it('raise is idempotent on dedupeKey and refreshes title, deadline and amount; listForSubject, openCounts, sellerTaskCounts', async () => {
    const sellerId = newId();
    const subjectId = newId();
    const base = { sourceModule: 'warehouse', queueKey: 'warehouse.pick_pack', kind: 'pick_pack' as const, title: 'Pick MK-1', subject: { type: 'order' as const, id: subjectId, ref: 'MK-1' }, sellerId, dedupeKey: `pick_pack:${subjectId}`, amount: money(1000), visibleToSeller: true };
    const first = await t.service.raise(base);
    const due = new Date(Date.now() + 5 * 3_600_000).toISOString();
    const second = await t.service.raise({ ...base, title: 'Pick MK-1 (2 lines)', dueAt: due, amount: money(2000) });
    expect(second).toMatchObject({ id: first.id, title: 'Pick MK-1 (2 lines)', amount: money(2000), deadline: { dueAt: due }, source: { module: 'warehouse', dedupeKey: `pick_pack:${subjectId}` } });
    expect((await t.service.listForSubject('order', subjectId)).map((i) => i.id)).toEqual([first.id]);
    expect((await t.service.listForSubject('seller', sellerId)).map((i) => i.id)).toEqual([first.id]);
    const counts = await t.service.openCounts(['warehouse.pick_pack', 'nope.queue']);
    expect(counts['warehouse.pick_pack']!.open).toBeGreaterThanOrEqual(1);
    expect(counts['nope.queue']).toEqual({ open: 0, overdue: 0 });
    expect(await t.service.sellerTaskCounts(sellerId)).toEqual({ pick_pack: 1 });
    expect(await t.service.resolveBySource(`pick_pack:${subjectId}`, { note: 'Packed', by: { kind: 'system', name: 'warehouse' } })).toBe(1);
    expect(await t.service.resolveBySource(`pick_pack:${subjectId}`, { note: 'Packed', by: { kind: 'system', name: 'warehouse' } })).toBe(0);
    expect(await t.service.listForSubject('order', subjectId)).toEqual([]);
  });

  it('raise refuses unknown queues and kinds', async () => {
    await expect(t.service.raise({ sourceModule: 'test', queueKey: 'nope.queue', kind: 'pick_pack', title: 'x', subject: { type: 'other', id: 'x' }, dedupeKey: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(t.service.raise({ sourceModule: 'test', queueKey: 'warehouse.pick_pack', kind: 'teleport' as never, title: 'x', subject: { type: 'other', id: 'x' }, dedupeKey: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('registers the export dataset with reports at boot', async () => {
    await t.service.boot(); // boot ran before the test stubs were in place
    expect(t.world.datasets.map((d) => d.key)).toContain('workqueues.admin.items');
  });
});
