/** Fee schedules with approval and notice, posting to finance, reversals, storage fees and the stock jobs. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { EXAMPLE_SCHEDULE } from '../domain/rules.js';
import { A, arrivedInbound, boot, receiveAll, S, type Kit } from './helpers.js';

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
    await k.publish('shipping', 'shipping.shipment.dispatched', { shipmentId: newId(), kind: 'outbound', orderId, groupId, returnId: null, ownerType: 'seller', sellerId: s.sellerId, lines: [], shippedAt: new Date().toISOString(), dispatchDueAt: null, onTime: true, trackingValid: true, estimatedArrival: null });
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
    expect(k.events('fulfillment-service.fee.reversed').at(-1)).toEqual({ chargeId: receiving.id, sellerId: s.sellerId, amount: receiving.amount, reason: 'Receiving waived for the launch' });
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

    // reconciled: the ledger matches inventory; a change made outside the service shows up
    let rec = await k.api.parts.stock.reconcile();
    expect(rec.differences.filter((d: any) => d.sellerId === s.sellerId)).toEqual([]);
    await k.inventory.applyBulkQuantities(s.sellerId, [{ stockItemId: s.stockItemId, newAvailable: 7 }], newId(), { kind: 'seller', id: s.sellerId });
    rec = await k.api.parts.stock.reconcile();
    expect(rec.differences.filter((d: any) => d.sellerId === s.sellerId)).toEqual([{ skuEnrollmentId: s.skuId, sellerId: s.sellerId, ledger: 10, inventory: 7 }]);
    await k.app.kernel.jobs.runNow('fulfillment-service.reconcile');

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
    await k.app.kernel.jobs.runNow('fulfillment-service.aged-stock-notice');
    expect((await k.call('GET', S('/removals'), { token: s.token })).body.items).toHaveLength(0);
    k.clock.advance(61 * 86_400_000);
    await k.app.kernel.jobs.runNow('fulfillment-service.aged-stock-notice');
    await k.app.kernel.jobs.runNow('fulfillment-service.aged-stock-notice');
    const removals = (await k.call('GET', S('/removals'), { token: s.token })).body.items;
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatchObject({ kind: 'dispose', state: 'requested', lines: [{ expected: 2, damaged: 2 }] });
  });
});
