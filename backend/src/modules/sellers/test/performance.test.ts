import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { auth } from '../../../testing/app.js';
import { ADMIN, approvedSeller, boot, customer, restrictionInput, SELLER, staff, STORE, submitted, type Kit } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(async () => kit?.close());

const money = { amount: 5000, currency: 'USD' };
const zero = { amount: 0, currency: 'USD' };

async function orders(kit: Kit, sellerId: string, n: number) {
  const groups: string[] = [];
  for (let i = 0; i < n; i++) {
    const groupId = newId();
    groups.push(groupId);
    await kit.emit('orders', 'orders.order.accepted', {
      orderId: newId(),
      ref: `MK-${i}`,
      contactEmail: 'a@example.com',
      total: money,
      groups: [{ groupId, ownerType: 'seller', sellerId, fulfilledBy: 'seller', dispatchBy: kit.clock.now().toISOString(), itemIds: [newId(), newId()], total: money }],
      acceptedAt: kit.clock.now().toISOString(),
    });
  }
  return groups;
}

describe('performance', () => {
  it('counts facts from other modules once, computes metrics against targets and flags new misses', async () => {
    const s = await approvedSeller(kit);
    const groups = await orders(kit, s.sellerId, 10);
    for (const [i, groupId] of groups.entries()) {
      const shipment = { shipmentId: newId(), kind: 'outbound', orderId: newId(), groupId, ownerType: 'seller', sellerId: s.sellerId, lines: [], shippedAt: kit.clock.now().toISOString(), onTime: i >= 3, trackingValid: i !== 0 };
      await kit.emit('shipping', 'shipping.shipment.dispatched', shipment);
      await kit.emit('shipping', 'shipping.shipment.dispatched', shipment); // same fact twice
    }
    await kit.emit('orders', 'orders.item.cancelled', {
      orderId: newId(), ref: 'MK-1', groupId: groups[0], ownerType: 'seller', sellerId: s.sellerId, itemId: newId(), offerId: newId(), stockItemId: newId(), quantity: 1, cancellationId: newId(),
      initiatedBy: 'seller', reasonCode: 'out_of_stock', beforeDispatch: true, countsAgainstSeller: true,
      refund: { itemAmount: money, discountShare: zero, shippingRefund: zero, taxRefund: zero, total: money }, paymentIntentId: newId(),
    });
    await kit.emit('returns', 'returns.return.requested', { returnId: newId(), ref: 'RT-1', orderId: newId(), ownerType: 'seller', sellerId: s.sellerId, orderItemIds: [newId()], reason: 'damaged', responseDueAt: kit.clock.now().toISOString() });
    const conversationId = newId();
    await kit.emit('messaging', 'messaging.message.sent', { messageId: newId(), conversationId, authorKind: 'customer', recipientKinds: ['seller'], sellerId: s.sellerId });
    kit.clock.advance(3 * 3_600_000);
    await kit.emit('messaging', 'messaging.message.sent', { messageId: newId(), conversationId, authorKind: 'seller', recipientKinds: ['customer'], sellerId: s.sellerId });
    await kit.emit('support', 'support.case.opened', { caseId: newId(), ref: 'CS-1', kind: 'order', category: 'not_received', priority: 'normal', sellerId: s.sellerId, orderItemIds: [], handler: 'seller', nextResponseDueAt: new Date(kit.clock.now().getTime() - 3_600_000).toISOString() });
    // facts for unknown sellers are ignored
    await kit.emit('returns', 'returns.return.requested', { returnId: newId(), ref: 'RT-2', orderId: newId(), ownerType: 'seller', sellerId: newId(), orderItemIds: [], reason: 'x', responseDueAt: kit.clock.now().toISOString() });

    await kit.svc.computePerformance();
    await kit.app.kernel.events.drain();
    const perf = await kit.call('GET', `${SELLER}/performance`, s.sellerToken);
    expect(perf.status).toBe(200);
    const m = Object.fromEntries(perf.body.metrics.map((x: any) => [x.key, x]));
    expect(perf.body.orderCount).toBe(10);
    expect(m.dispatch_reliability).toMatchObject({ value: 70, numerator: 7, denominator: 10, status: 'action_needed', detail: '7 of 10 orders on time' });
    expect(m.valid_tracking).toMatchObject({ value: 90, status: 'below' });
    expect(m.return_rate).toMatchObject({ value: 10, numerator: 1 });
    expect(m.cancellation_rate).toMatchObject({ value: 10, numerator: 1, denominator: 10, status: 'action_needed' });
    expect(m.response_time).toMatchObject({ value: 3, status: 'meets' });
    expect(m.unresolved_cases).toMatchObject({ value: 1, status: 'below' });
    expect(perf.body.overall).toBe('action_needed');
    const miss = kit.last('sellers.performance.below_target');
    expect(miss).toMatchObject({ sellerId: s.sellerId, overall: 'action_needed' });
    expect(miss.metrics).toEqual(expect.arrayContaining(['dispatch_reliability', 'valid_tracking', 'unresolved_cases']));
    const count = kit.of('sellers.performance.below_target').length;
    await kit.svc.computePerformance();
    expect(kit.of('sellers.performance.below_target').length).toBe(count); // not a new miss
    expect(await kit.svc.getPerformance(s.sellerId)).toMatchObject({ overall: 'action_needed' });

    const list = await kit.call('GET', `${ADMIN}/sellers?onTimeBelow=95&limit=100`, staff());
    expect(list.body.items.some((r: any) => r.id === s.sellerId && r.onTimeDispatchPct === 70)).toBe(true);
    kit.clock.advance(-3 * 3_600_000);
  });

  it('automatic warnings for repeated misses and restriction proposals, never restrictions', async () => {
    const s = await approvedSeller(kit);
    const groups = await orders(kit, s.sellerId, 4);
    for (const groupId of groups) await kit.emit('shipping', 'shipping.dispatch.overdue', { orderId: newId(), orderRef: 'MK-1', groupId, ownerType: 'seller', sellerId: s.sellerId, orderItemIds: [], dueAt: kit.clock.now().toISOString(), exceptionId: newId() });
    for (let i = 0; i < 3; i++) {
      await kit.svc.computePerformance();
      kit.clock.advance(1000);
    }
    const restrictionsBefore = (await kit.svc.core.repo.find('restrictions', { seller_id: s.sellerId })).length;
    await kit.svc.autoWarnings();
    await kit.app.kernel.events.drain();
    expect(kit.of('sellers.warning.issued').some((w) => w.sellerId === s.sellerId && w.title === 'Dispatch reliability below target')).toBe(true);
    expect(kit.work.some((w) => w.kind === 'restriction_proposal' && w.dedupeKey.includes(s.sellerId))).toBe(true);
    expect((await kit.svc.core.repo.find('restrictions', { seller_id: s.sellerId })).length).toBe(restrictionsBefore);
    await kit.svc.autoWarnings(); // the open warning is not repeated
    expect(kit.of('sellers.warning.issued').filter((w) => w.sellerId === s.sellerId)).toHaveLength(1);
  });

  it('targets: change with an effective date, approval when above authority', async () => {
    const today = kit.svc.core.today(); // market date
    const t = { metric: 'dispatch_reliability', comparator: 'gte', threshold: 96, unit: 'percent', windowDays: 30, display: 'At least 96%', isExample: false, effectiveFrom: today };
    const past = await kit.call('PUT', `${ADMIN}/performance-targets`, staff(), { targets: [{ ...t, effectiveFrom: '2020-01-01' }], reason: 'x' });
    expect(past.body.error.code).toBe('VALIDATION_FAILED');
    const ok = await kit.call('PUT', `${ADMIN}/performance-targets`, staff(), { targets: [t], reason: 'Business confirmed targets' });
    expect(ok.status).toBe(200);
    const list = await kit.call('GET', `${ADMIN}/performance-targets`, staff());
    expect(list.body.find((x: any) => x.metric === 'dispatch_reliability')).toMatchObject({ threshold: 96, isExample: false });

    kit.authority.set('sellers.performance.targets', 'approval_required');
    try {
      const pending = await kit.call('PUT', `${ADMIN}/performance-targets`, staff(), { targets: [{ ...t, threshold: 97 }], reason: 'Tighter' });
      expect(pending.body.error.code).toBe('APPROVAL_REQUIRED');
      await kit.decide(pending.body.error.details.approvalRequestId, 'approved');
      const after = await kit.call('GET', `${ADMIN}/performance-targets`, staff());
      expect(after.body.find((x: any) => x.metric === 'dispatch_reliability').threshold).toBe(97);
    } finally {
      kit.authority.delete('sellers.performance.targets');
    }
  });
});

describe('jobs', () => {
  it('application deadlines raise work items; appeal deadlines too; documents are purged after retention', async () => {
    const s = await submitted(kit);
    kit.clock.advance(10 * 86_400_000);
    await kit.svc.applicationDeadlines();
    kit.clock.advance(-10 * 86_400_000);
    expect(kit.work.some((w) => w.dedupeKey === `application_overdue:${s.id}`)).toBe(true);

    const a = await approvedSeller(kit);
    const r = (await kit.call('POST', `${ADMIN}/sellers/${a.sellerId}/restrictions`, staff(), restrictionInput())).body;
    const ap = (await kit.call('POST', `${SELLER}/restrictions/${r.id}/appeals`, a.sellerToken, { argument: 'Please' })).body;
    kit.clock.advance(8 * 86_400_000);
    await kit.svc.appealDeadlines();
    expect(kit.work.some((w) => w.queueKey === 'sellers.appeals' && w.dedupeKey.startsWith(`appeal_deadline:${ap.id}`))).toBe(true);

    kit.clock.advance(100 * 86_400_000);
    const detachedBefore = kit.callsOf('media.detach').length;
    await kit.svc.purgeDocuments();
    kit.clock.advance(-108 * 86_400_000);
    expect(kit.callsOf('media.detach').length).toBeGreaterThan(detachedBefore);
    const left = await kit.svc.core.repo.find('application_documents', { application_id: a.id, kind: 'owner_id' });
    expect(left).toEqual([]);
  });
});

describe('GraphQL', () => {
  it('store storefront by slug, the caller’s own seller, and the admin list', async () => {
    const s = await approvedSeller(kit, { launch: true });
    const slug = (await kit.call('GET', `${SELLER}/store-profile`, s.sellerToken)).body.slug;
    const store = await kit.app.inject({
      method: 'POST',
      url: '/graphql/store',
      headers: auth(customer()),
      payload: { query: `query($slug: String!) { sellerStorefront(slug: $slug) { id slug storeName verified sellingNow publicProfile { verification { state notChecked } collections { id } } } }`, variables: { slug } },
    });
    const body = store.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.sellerStorefront).toMatchObject({ id: s.sellerId, slug, verified: true, sellingNow: true, publicProfile: { verification: { state: 'VERIFIED' } } });

    const mine = await kit.app.inject({
      method: 'POST',
      url: '/graphql/seller',
      headers: auth(s.sellerToken),
      payload: { query: `{ mySeller { id status canSellNew launchReady payoutReadiness { state } performance { overall metrics { key status } } restrictions { id } membership { isOwner } business { taxIdLast4 } } }` },
    });
    const m = mine.json();
    expect(m.errors).toBeUndefined();
    expect(m.data.mySeller).toMatchObject({ id: s.sellerId, status: 'APPROVED', canSellNew: true, payoutReadiness: { state: 'VERIFIED' }, membership: { isOwner: true }, business: { taxIdLast4: '6789' } });
    expect(m.data.mySeller.performance.metrics).toHaveLength(7);

    const admin = await kit.app.inject({
      method: 'POST',
      url: '/graphql/admin',
      headers: auth(staff()),
      payload: { query: `query($id: UUID!) { sellerAdmin(id: $id) { id ref notes { body } history { label } owner { name } } sellers(filter: { statuses: [APPROVED] }, paging: { limit: 100 }) { items { id status } } }`, variables: { id: s.sellerId } },
    });
    const a = admin.json();
    expect(a.errors).toBeUndefined();
    expect(a.data.sellerAdmin).toMatchObject({ id: s.sellerId, owner: { name: 'Ana Lopez' } });
    expect(a.data.sellers.items.some((x: any) => x.id === s.sellerId)).toBe(true);
  });

  it('public storefront hides stores that were never approved', async () => {
    const s = await submitted(kit);
    const slug = (await kit.svc.core.repo.get('sellers', s.sellerId))!.slug;
    expect((await kit.call('GET', `${STORE}/stores/${slug}`, customer())).status).toBe(404);
    expect(await kit.svc.getStorefrontBySlug(slug)).toBeNull();
    expect(await kit.svc.getStorefrontCard([s.sellerId])).toEqual([]);
  });
});
