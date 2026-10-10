/** Fee schedules with approval and notice, posting to finance, reversals, storage fees and the stock jobs. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { EXAMPLE_SCHEDULE } from '../domain/rules.js';
import { A, arrivedInbound, boot, receiveAll, S, stocked, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const key = () => ({ 'idempotency-key': newId() });
const decided = (req: any, requestId: string, outcome = 'approved') => ({ requestId, ref: 'AP-1', actionKey: req.action, module: 'fulfillment-service', target: req.target, outcome, decidedBy: { kind: 'staff', id: newId(), name: 'Owner' }, reason: null, amount: req.amount ?? null, approverIds: [], requestedById: newId() });

describe('fee schedules', () => {
  it('proposes a schedule with notice and Business Owner approval; it becomes current on its date', async () => {
    const s = await k.enrolledSeller();
    const rates = EXAMPLE_SCHEDULE.rates.map((r) => (r.type === 'order_handling' ? { ...r, rate: { amount: 150, currency: 'USD' } } : r));
    const soon = await k.call('POST', A('/fee-schedules'), { body: { version: 'FS-2027-1', effectiveAt: new Date(k.clock.now().getTime() + 5 * 86_400_000).toISOString(), rates, reason: 'Carrier costs' } });
    expect(soon.status).toBe(400);
    expect(soon.body.error.details.issues[0].message).toContain('30 days notice');
    const missing = await k.call('POST', A('/fee-schedules'), { body: { version: 'FS-2027-1', effectiveAt: new Date(k.clock.now().getTime() + 40 * 86_400_000).toISOString(), rates: rates.slice(1), reason: 'x' } });
    expect(missing.status).toBe(400);

    k.authority.set('fulfillment-service.fees.change', 'denied');
    expect((await k.call('POST', A('/fee-schedules'), { body: { version: 'FS-2027-0', effectiveAt: new Date(k.clock.now().getTime() + 40 * 86_400_000).toISOString(), rates, reason: 'x' } })).status).toBe(403);
    k.authority.set('fulfillment-service.fees.change', 'approval_required');
    const effectiveAt = new Date(k.clock.now().getTime() + 40 * 86_400_000).toISOString();
    const proposed = await k.call('POST', A('/fee-schedules'), { body: { version: 'FS-2027-1', effectiveAt, rates, reason: 'Carrier costs' } });
    k.authority.delete('fulfillment-service.fees.change');
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(202);
    expect(proposed.body).toMatchObject({ version: 'FS-2027-1', state: 'draft', isExample: false });
    const req = k.approvals.at(-1)!;
    expect(req).toMatchObject({ action: 'fulfillment-service.fees.change', target: { type: 'fulfillment_fee_schedule', id: proposed.body.id } });
    expect((await k.call('GET', S('/fee-schedule'), { token: s.token })).body.upcoming).toBeNull();

    const scheduleRequestId = newId();
    await k.publish('access', 'access.approval.decided', decided(req, scheduleRequestId));
    await k.publish('access', 'access.approval.decided', decided(req, scheduleRequestId)); // delivered twice: applied once
    const list = await k.call('GET', A('/fee-schedules'));
    expect(list.body.map((x: any) => [x.version, x.state])).toEqual([
      ['FS-2027-1', 'scheduled'],
      [EXAMPLE_SCHEDULE.version, 'current'],
    ]);
    const seller = await k.call('GET', S('/fee-schedule'), { token: s.token });
    expect(seller.body).toMatchObject({ current: { version: EXAMPLE_SCHEDULE.version }, upcoming: { version: 'FS-2027-1' } });
    expect((await k.call('POST', A('/fee-schedules'), { body: { version: 'FS-2027-1', effectiveAt, rates, reason: 'again' } })).status).toBe(400);

    // a new seller must accept the schedule in force or the upcoming one
    const other = await k.seller();
    expect((await k.call('POST', S('/enrollment'), { token: other.token, body: { expectedSkus: 1, expectedMonthlyUnits: 1, categories: [], termsVersion: 'T1', feeScheduleVersion: 'FS-2027-1', acceptTerms: true } })).status).toBe(201);

    k.clock.advance(41 * 86_400_000);
    const later = await k.call('GET', S('/fee-schedule'), { token: s.token });
    expect(later.body).toMatchObject({ current: { version: 'FS-2027-1', state: 'current' }, upcoming: null });
    expect((await k.call('GET', A('/fee-schedules'))).body.find((x: any) => x.version === EXAMPLE_SCHEDULE.version).state).toBe('superseded');
    // fees accrue at the new rates
    const orderId = newId();
    const groupId = newId();
    const id = await arrivedInbound(k, s, 2);
    await receiveAll(k, id, s.skuId, 2);
    await k.api.createFulfillmentRequest(orderId, groupId, [{ orderItemId: newId(), offerId: s.offerId, quantity: 1 }]);
    await k.publish('shipping', 'shipping.shipment.dispatched', { shipmentId: newId(), kind: 'outbound', orderId, customerId: null, contactEmail: null, groupId, returnId: null, ownerType: 'seller', sellerId: s.sellerId, fulfilledBy: 'marketly_service', lines: [], shippedAt: new Date().toISOString(), dispatchDueAt: null, onTime: true, trackingValid: true, estimatedArrival: null });
    // the seller heard of the schedule (K13 topic)
    expect(k.notices.find((n) => n.dedupeKey === `fs:schedule:${proposed.body.id}` && n.recipients[0].sellerId === s.sellerId)).toMatchObject({ topic: 'seller.fulfillment.fee_schedule_changed', context: { version: 'FS-2027-1' } });
    expect(k.audits.find((x) => x.action === 'fulfillment-service.fee_schedule.create' && x.target.id === proposed.body.id)).toMatchObject({ approvalRequestId: expect.any(String) });
    expect((await k.call('GET', S('/fees?type=order_handling'), { token: s.token })).body.items[0].amount.amount).toBe(150);
  });
});

describe('fee charges', () => {
  it('posts accrued fees to the seller ledger once, and reverses within or above the limit', async () => {
    const s = await k.enrolledSeller();
    const id = await arrivedInbound(k, s, 4);
    await receiveAll(k, id, s.skuId, 4);
    const accrued = (await k.call('GET', S('/fees'), { token: s.token })).body.items;
    expect(accrued.map((f: any) => [f.type, f.state])).toEqual([
      ['labelling', 'accrued'],
      ['receiving', 'accrued'],
    ]);
    await k.app.kernel.jobs.runNow('fulfillment-service.post-fees');
    await k.app.kernel.events.drain();
    await k.app.kernel.jobs.runNow('fulfillment-service.post-fees');
    await k.app.kernel.events.drain();
    const posted = (await k.call('GET', S('/fees'), { token: s.token })).body.items;
    expect(posted.every((f: any) => f.state === 'posted' && f.postedAt)).toBe(true);
    const charged = k.events('fulfillment-service.fee.charged').filter((e) => e.sellerId === s.sellerId);
    expect(charged.map((e) => [e.type, e.amount.amount, e.reference])).toEqual(expect.arrayContaining([['receiving', posted.find((f: any) => f.type === 'receiving').amount.amount, posted[0].reference]]));
    expect(charged).toHaveLength(2);
    // the seller's ledger in finance: one service_fee entry per charge (finance.recordServiceFee, keyed per charge)
    const fees = k.financeLedger.filter((e) => e.sellerId === s.sellerId && e.type === 'service_fee');
    expect(fees).toHaveLength(2);
    for (const f of posted) {
      expect(fees.find((e) => e.reference?.id === f.id)).toMatchObject({ kind: f.type, amount: f.amount, reference: { kind: 'fulfillment_service', id: f.id, ref: f.reference }, idempotencyKey: `fulfillment-service:fee:${f.id}`, description: expect.stringMatching(/^Fulfillment service/) });
    }
    const entryOf = (chargeId: string) => fees.find((e) => e.reference?.id === chargeId)!.id;

    // reverse within the limit
    const receiving = posted.find((f: any) => f.type === 'receiving');
    expect((await k.call('POST', A(`/fees/${receiving.id}/reverse`), { body: { reason: '' }, headers: key() })).status).toBe(400);
    const reversed = await k.call('POST', A(`/fees/${receiving.id}/reverse`), { body: { reason: 'Receiving waived for the launch' }, headers: key() });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(reversed.body).toMatchObject({ state: 'reversed', reason: 'Receiving waived for the launch' });
    expect(k.events('fulfillment-service.fee.reversed').at(-1)).toEqual({ chargeId: receiving.id, sellerId: s.sellerId, amount: receiving.amount, reason: 'Receiving waived for the launch', period: receiving.period });
    // the posted fee is credited back on the seller ledger against its entry
    const credits = () => k.financeLedger.filter((e) => e.sellerId === s.sellerId && e.type === 'charge_credit');
    expect(credits()).toEqual([expect.objectContaining({ amount: receiving.amount, originalEntryId: entryOf(receiving.id), reason: 'Receiving waived for the launch', idempotencyKey: `fulfillment-service:fee-reversal:${receiving.id}` })]);
    expect((await k.call('POST', A(`/fees/${receiving.id}/reverse`), { body: { reason: 'again' }, headers: key() })).status).toBe(409);

    // above the limit: approval first
    const labelling = posted.find((f: any) => f.type === 'labelling');
    k.authority.set('fulfillment-service.charges.reverse', 'approval_required');
    const pending = await k.call('POST', A(`/fees/${labelling.id}/reverse`), { body: { reason: 'Barcode was on the units' }, headers: key() });
    k.authority.delete('fulfillment-service.charges.reverse');
    expect(pending.status).toBe(409);
    expect(pending.body.error.code).toBe('APPROVAL_REQUIRED');
    const req = k.approvals.at(-1)!;
    expect(req).toMatchObject({ action: 'fulfillment-service.charges.reverse', target: { type: 'fulfillment_fee_charge', id: labelling.id, sellerId: s.sellerId } });
    await k.publish('access', 'access.approval.decided', decided(req, pending.body.error.details.approvalRequestId));
    await k.publish('access', 'access.approval.decided', decided(req, pending.body.error.details.approvalRequestId)); // twice: one reversal
    expect(k.events('fulfillment-service.fee.reversed').filter((e) => e.chargeId === labelling.id)).toHaveLength(1);
    expect(credits().filter((e) => e.originalEntryId === entryOf(labelling.id))).toEqual([expect.objectContaining({ amount: labelling.amount, reason: 'Approved by Finance' })]);
    const after = (await k.call('GET', A(`/fees?sellerId=${s.sellerId}&state=reversed`))).body.items;
    expect(after.map((f: any) => [f.id, f.reason])).toEqual(
      expect.arrayContaining([
        [labelling.id, 'Approved by Finance'],
        [receiving.id, 'Receiving waived for the launch'],
      ]),
    );
    // denied
    const other = await k.enrolledSeller();
    const id2 = await arrivedInbound(k, other, 1);
    await receiveAll(k, id2, other.skuId, 1);
    const charge = (await k.call('GET', S('/fees'), { token: other.token })).body.items[0];
    k.authority.set('fulfillment-service.charges.reverse', 'denied');
    expect((await k.call('POST', A(`/fees/${charge.id}/reverse`), { body: { reason: 'x' }, headers: key() })).status).toBe(403);
    k.authority.delete('fulfillment-service.charges.reverse');
    // another seller's fees are not listed
    expect((await k.call('GET', S('/fees'), { token: other.token })).body.items.every((f: any) => f.sellerId === other.sellerId)).toBe(true);
  });
});

describe('stock jobs', () => {
  it('snapshots storage daily, charges monthly storage and long-term storage, warns about aged stock and reconciles with inventory', async () => {
    const s = await k.enrolledSeller();
    const id = await arrivedInbound(k, s, 10);
    await receiveAll(k, id, s.skuId, 10);
    // the overview: stock, open inbound and this month's fees
    const overview = await k.call('GET', S('/overview'), { token: s.token });
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    expect(overview.body).toMatchObject({ enrollment: { state: 'active' }, stockTotals: { available: 10 }, openInbound: [], feesLastMonth: { amount: 0 } });
    expect(overview.body.feesThisMonth.amount).toBe(250 + 550);
    expect(overview.body.stockTotals.volumeCubicFeet).toBeCloseTo(10 * 0.2119, 3);


    await k.app.kernel.jobs.runNow('fulfillment-service.storage-snapshot');
    await k.app.kernel.jobs.runNow('fulfillment-service.storage-snapshot');
    // next month: the month's storage from the snapshot (one day of 10 units)
    const month = (await k.call('GET', S('/fees'), { token: s.token })).body.items[0].period as string;
    const [y, m] = month.split('-').map(Number) as [number, number];
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    k.clock.advance(days * 86_400_000);
    await k.app.kernel.jobs.runNow('fulfillment-service.monthly-storage-fees');
    await k.app.kernel.jobs.runNow('fulfillment-service.monthly-storage-fees');
    const storage = (await k.call('GET', S(`/fees?type=storage`), { token: s.token })).body.items;
    expect(storage).toHaveLength(1);
    const cubic = Math.round(((10 * (30 * 20 * 10)) / 28_316.846_592) * 10_000) / 10_000;
    expect(storage[0]).toMatchObject({ period: month, units: Math.round((cubic / days) * 10_000) / 10_000, rate: { amount: 87 } });
    expect(storage[0].amount.amount).toBe(Math.round(storage[0].units * 87));
    expect((await k.call('GET', S('/fees?type=long_term_storage'), { token: s.token })).body.items).toHaveLength(0);

    // 11 months on: the units approach long-term storage; the overview and the weekly notice warn
    k.clock.advance(310 * 86_400_000);
    const aged = await k.call('GET', S('/overview'), { token: s.token });
    expect(aged.body.alerts.some((a: string) => a.includes('aged over 365 days'))).toBe(true);
    expect(aged.body.stockTotals.agedDays['181-365']).toBe(10);
    await k.app.kernel.jobs.runNow('fulfillment-service.aged-stock-notice');

    // past a year: long-term storage on the month's snapshots
    k.clock.advance(40 * 86_400_000);
    await k.app.kernel.jobs.runNow('fulfillment-service.storage-snapshot');
    const snapshotMonth = new Date(k.clock.now()).toISOString().slice(0, 7);
    const [sy, sm] = snapshotMonth.split('-').map(Number) as [number, number];
    k.clock.advance(new Date(Date.UTC(sy, sm, 0)).getUTCDate() * 86_400_000);
    await k.app.kernel.jobs.runNow('fulfillment-service.monthly-storage-fees');
    const longTerm = (await k.call('GET', S('/fees?type=long_term_storage'), { token: s.token })).body.items;
    expect(longTerm).toHaveLength(1);
    expect(longTerm[0].rate.amount).toBe(690);
    expect(longTerm[0].amount.amount).toBeGreaterThan(0);
  });

  it('disposes of unsellable units left longer than unsellableDisposalDays (a disposal order the staff approve)', async () => {
    const s = await k.enrolledSeller();
    const id = await arrivedInbound(k, s, 3);
    await k.call('POST', A(`/inbound/${id}/receive`), { body: { lines: [{ skuEnrollmentId: s.skuId, received: 3, damaged: 2 }], complete: true }, headers: key() });
    await k.inv.confirmAll(id);
    await k.app.kernel.jobs.runNow('fulfillment-service.aged-stock-notice');
    expect((await k.call('GET', S('/removals'), { token: s.token })).body.items).toHaveLength(0);
    k.clock.advance(61 * 86_400_000);
    await k.app.kernel.jobs.runNow('fulfillment-service.aged-stock-notice');
    await k.app.kernel.jobs.runNow('fulfillment-service.aged-stock-notice');
    const removals = (await k.call('GET', S('/removals'), { token: s.token })).body.items;
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatchObject({ kind: 'dispose', state: 'requested', lines: [{ expected: 2, damaged: 2 }] });
    expect(k.notices.find((n) => n.dedupeKey === `fs:dispose:${removals[0].id}`)).toMatchObject({ topic: 'seller.fulfillment.disposal_scheduled', context: { units: 2, days: 60, removal: { ref: removals[0].ref } } });
  });
});

describe('reconciliation with inventory', () => {
  it('finds differences per SKU, raises a work item, and resolves them by adjusting the ledger, reimbursing (with approval) or leaving them', async () => {
    const s = await stocked(k, 6);
    const other = await stocked(k, 2);
    const mine = async () => (await k.call('GET', A(`/stock-differences?sellerId=${s.sellerId}`))).body.items;
    await k.app.kernel.jobs.runNow('fulfillment-service.reconcile');
    expect(await mine()).toEqual([]);

    // two units go missing in inventory (a staff count elsewhere), one returned unit appears
    k.inv.level(s.stockItemId).available -= 2;
    k.inv.level(s.stockItemId).returned += 1;
    await k.app.kernel.jobs.runNow('fulfillment-service.reconcile');
    await k.app.kernel.jobs.runNow('fulfillment-service.reconcile'); // same day: one row
    let list = await mine();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ skuEnrollmentId: s.skuId, sku: s.sku, sellerId: s.sellerId, state: 'open', ledger: { incoming: 0, available: 6, reserved: 0, damagedHeld: 0, returned: 0 }, inventory: { incoming: 0, available: 4, reserved: 0, damagedHeld: 0, returned: 1 }, decision: null, approval: null });
    expect(k.work.filter((w) => w.dedupeKey === `fs_stock_difference:${s.skuId}`).at(-1)).toMatchObject({ queueKey: 'fulfillment.reconciliation', kind: 'manual_task', subject: { type: 'stock_item', id: s.stockItemId } });
    expect((await k.call('GET', A(`/stock-differences?sellerId=${other.sellerId}`))).body.items).toEqual([]);
    expect((await k.call('GET', A('/stock-differences?state=resolved'))).body.items.some((d: any) => d.id === list[0].id)).toBe(false);

    // reimbursing above the limit waits for approval; a second decision meanwhile is refused
    expect((await k.call('POST', A(`/stock-differences/${list[0].id}/resolve`), { body: { decision: 'reimburse', reason: 'Lost' }, headers: key() })).status).toBe(400);
    k.authority.set('fulfillment-service.reimbursements.approve', 'approval_required');
    const pending = await k.call('POST', A(`/stock-differences/${list[0].id}/resolve`), { body: { decision: 'reimburse', amount: { amount: 4_000, currency: 'USD' }, reason: 'Two units lost in a re-slot' }, headers: key() });
    k.authority.delete('fulfillment-service.reimbursements.approve');
    expect(pending.status, JSON.stringify(pending.body)).toBe(200);
    expect(pending.body).toMatchObject({ state: 'open', decision: 'reimburse', amount: { amount: 4_000 }, approval: { required: true, approvalRequestId: expect.any(String) } });
    const req = k.approvals.at(-1)!;
    expect(req).toMatchObject({ action: 'fulfillment-service.reimbursements.approve', target: { type: 'stock_difference', id: list[0].id, sellerId: s.sellerId }, amount: { amount: 4_000 } });
    expect((await k.call('POST', A(`/stock-differences/${list[0].id}/resolve`), { body: { decision: 'no_change', reason: 'x' }, headers: key() })).status).toBe(409);
    await k.publish('access', 'access.approval.decided', decided(req, pending.body.approval.approvalRequestId));
    await k.publish('access', 'access.approval.decided', decided(req, pending.body.approval.approvalRequestId));
    list = await mine();
    expect(list[0]).toMatchObject({ state: 'resolved', decision: 'reimburse', amount: { amount: 4_000 }, approval: null, decidedBy: { kind: 'staff' } });
    expect((await k.call('GET', S('/fees?type=reimbursement'), { token: s.token })).body.items.map((f: any) => [f.amount.amount, f.reference])).toEqual([[-4_000, s.sku]]);
    expect(k.resolved).toContain(`fs_stock_difference:${s.skuId}`);
    expect((await k.call('POST', A(`/stock-differences/${list[0].id}/resolve`), { body: { decision: 'no_change', reason: 'again' }, headers: key() })).status).toBe(409);

    // the next day it still differs: adjust the ledger to inventory
    k.clock.advance(86_400_000);
    await k.app.kernel.jobs.runNow('fulfillment-service.reconcile');
    const open = (await mine()).find((d: any) => d.state === 'open');
    const adjusted = await k.call('POST', A(`/stock-differences/${open.id}/resolve`), { body: { decision: 'adjust_ledger', reason: 'Counted twice' }, headers: key() });
    expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(200);
    expect(adjusted.body).toMatchObject({ state: 'resolved', decision: 'adjust_ledger', reason: 'Counted twice' });
    expect((await k.call('GET', S('/skus'), { token: s.token })).body.items[0].stock).toMatchObject({ available: 4, returned: 1 });
    expect(k.audits.filter((x) => x.action === 'fulfillment-service.stock_difference.resolve').length).toBeGreaterThanOrEqual(2);
    k.clock.advance(86_400_000);
    await k.app.kernel.jobs.runNow('fulfillment-service.reconcile');
    expect((await mine()).filter((d: any) => d.state === 'open')).toEqual([]);
  });

  it("follows inventory's own adjustments of Marketly-held units and tells the seller of low stock", async () => {
    const s = await stocked(k, 5);
    const adjustment = { adjustmentId: null, movementId: newId(), stockItemId: s.stockItemId, locationId: k.locationId, ownerType: 'seller', sellerId: s.sellerId, serviceManaged: true, fromGroup: 'available', toGroup: 'damaged_held', quantity: 2, reasonCode: 'damage_found', actor: { kind: 'staff', id: newId(), name: 'Packer' } };
    await k.publish('inventory', 'inventory.adjustment.recorded', adjustment);
    await k.publish('inventory', 'inventory.adjustment.recorded', adjustment); // once per movement
    await k.publish('inventory', 'inventory.adjustment.recorded', { ...adjustment, movementId: newId(), serviceManaged: false });
    expect((await k.call('GET', S('/skus'), { token: s.token })).body.items[0].stock).toMatchObject({ available: 3, unsellable: 2 });
    const moves = (await k.call('GET', S(`/skus/${s.skuId}/movements`), { token: s.token })).body.items;
    expect(moves[0]).toMatchObject({ movement: 'adjusted', quantity: 2, fromGroup: 'available', toGroup: 'unsellable', reference: adjustment.movementId, reason: 'damage_found' });

    const low = { stockItemId: s.stockItemId, offerId: s.offerId, ownerType: 'seller', sellerId: s.sellerId, productId: newId(), variantId: newId(), sku: s.sku, label: 'Linen throw', available: 3, threshold: 5, serviceManaged: true };
    await k.publish('inventory', 'inventory.stock.low', low);
    await k.publish('inventory', 'inventory.stock.low', { ...low, serviceManaged: false, sellerId: (await k.seller()).sellerId });
    expect(k.notices.filter((n) => n.topic === 'seller.fulfillment.stock_low' && n.recipients[0].sellerId === s.sellerId)).toEqual([expect.objectContaining({ context: { stock: { label: 'Linen throw', sku: s.sku }, available: 3 }, dedupeKey: expect.stringMatching(new RegExp(`^fs:low:${s.skuId}:`)) })]);
  });
});

describe('report datasets', () => {
  it('registers the four datasets at boot and serves own rows to sellers and permitted staff', async () => {
    expect(k.datasets.filter((d) => d.owner === 'fulfillment-service').map((d) => [d.key, d.audience, d.permission, d.owner]).sort()).toEqual([
      ['fulfillment-service.admin.fees', 'staff', 'fulfillment-service.fees.manage', 'fulfillment-service'],
      ['fulfillment-service.admin.stock_by_owner', 'staff', 'fulfillment-service.operations.view', 'fulfillment-service'],
      ['fulfillment-service.seller.fees', 'seller', 'fulfillment-service.fees.view', 'fulfillment-service'],
      ['fulfillment-service.seller.stock', 'seller', 'fulfillment-service.inbound.manage', 'fulfillment-service'],
    ]);
    const s = await stocked(k, 3);
    const other = await stocked(k, 1);
    const seller = { kind: 'seller' as const, accountId: newId(), sellerId: s.sellerId };
    const fees = await k.api.exportRows('fulfillment-service.seller.fees', {}, seller);
    expect(fees.rows.map((r: any) => r.type).sort()).toEqual(['Labelling', 'Receiving']);
    const stock = await k.api.exportRows('fulfillment-service.seller.stock', {}, seller);
    expect(stock.rows).toEqual([expect.objectContaining({ sku: s.sku, available: 3, state: 'active' })]);
    await expect(k.api.exportRows('fulfillment-service.admin.fees', {}, seller)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(k.api.exportRows('fulfillment-service.nope', {}, seller)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const staff = { kind: 'staff' as const, accountId: newId() };
    const byOwner = await k.api.exportRows('fulfillment-service.admin.stock_by_owner', { sellerId: other.sellerId }, staff);
    expect(byOwner.rows).toEqual([expect.objectContaining({ sellerId: other.sellerId, sku: other.sku, available: 1 })]);
    const all = await k.api.exportRows('fulfillment-service.admin.fees', { sellerId: s.sellerId, type: 'receiving' }, staff);
    expect(all.rows).toEqual([expect.objectContaining({ sellerId: s.sellerId, type: 'Receiving', units: 3, amount: '0.75' })]);
  });
});
