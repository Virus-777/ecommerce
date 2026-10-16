import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { harness, sellerOrder, tokens, ups, type Harness } from './helpers.js';

/**
 * The detection jobs walk every candidate in batches (BUILDING-MODULES §9). Each test lowers the batch size to 2 and
 * puts three candidates the job skips (already handled) before the one it must act on: ids grow with time, so the
 * skipped ones fill the first batch and part of the second, and only a walk past them reaches the last one.
 */
let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterEach(() => {
  h.service.core.jobBatchSize = 200;
});
afterAll(async () => {
  await h.app.close();
});

const SELLER = '/api/seller/shipping';
const STORE = '/api/store/shipping';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A seller order with its lamp shipped by UPS now (no carrier scan yet) */
async function shipped() {
  const o = await sellerOrder(h);
  const tn = ups();
  const res = await h.call('POST', `${SELLER}/shipments`, tokens.seller(o.sellerId), { groupId: o.groupId, carrierCode: 'ups', trackingNumber: tn, shippedAt: h.clock.now().toISOString(), items: [{ orderItemId: o.lamp.id, quantity: 1 }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { ...o, shipmentId: res.body.id as string, tn };
}

const exceptionsOf = (shipmentIds: string[], kind: string) => h.service.core.repo.find('exceptions', { shipment_id: shipmentIds, kind });

describe('detection jobs walk every candidate, not only a first page', () => {
  it('detect-missing-tracking reaches a package behind packages that already have the exception', async () => {
    const handled = [await shipped(), await shipped(), await shipped()].map((s) => s.shipmentId);
    h.clock.advance(37 * HOUR);
    await h.runJob('shipping.detect-missing-tracking');
    expect(await exceptionsOf(handled, 'missing_tracking')).toHaveLength(3);

    const late = await shipped();
    h.clock.advance(37 * HOUR);
    h.service.core.jobBatchSize = 2;
    await h.runJob('shipping.detect-missing-tracking');
    expect(await exceptionsOf([late.shipmentId], 'missing_tracking')).toHaveLength(1);
    // the handled ones are not raised twice
    expect(await exceptionsOf(handled, 'missing_tracking')).toHaveLength(3);
  });

  it('detect-stalled reaches a package behind packages already under review', async () => {
    const reviewed = [await shipped(), await shipped(), await shipped()].map((s) => s.shipmentId);
    h.clock.advance(8 * DAY);
    await h.runJob('shipping.detect-stalled');
    expect(await exceptionsOf(reviewed, 'lost_or_damaged')).toHaveLength(3);

    const stalled = await shipped();
    h.clock.advance(8 * DAY);
    h.service.core.jobBatchSize = 2;
    await h.runJob('shipping.detect-stalled');
    expect(await exceptionsOf([stalled.shipmentId], 'lost_or_damaged')).toHaveLength(1);
    expect(await exceptionsOf(reviewed, 'lost_or_damaged')).toHaveLength(3);
  });

  it('failed-delivery-default reaches a package behind failed deliveries the customer already decided', async () => {
    /** A shipped package whose delivery attempt failed now */
    const failed = async () => {
      const s = await shipped();
      await h.webhook('ups', { events: [{ id: `fail-${s.tn}`, trackingNumber: s.tn, code: 'attempt_failed', at: h.clock.now().toISOString() }] });
      return s;
    };
    const decided = [await failed(), await failed(), await failed()];
    for (const s of decided) {
      const chose = await h.call('POST', `${STORE}/shipments/${s.shipmentId}/delivery-choice`, tokens.customer(s.customerId), { choice: 'pickup' });
      expect(chose.status, JSON.stringify(chose.body)).toBe(200);
    }
    const undecided = await failed();
    h.clock.advance(15 * DAY);
    h.service.core.jobBatchSize = 2;
    await h.runJob('shipping.failed-delivery-default');
    const after = await h.service.core.repo.get('shipments', undecided.shipmentId);
    expect(after).toMatchObject({ status: 'returning', failed_delivery: { chosen: { choice: 'return_to_seller' } } });
    // the decided ones keep the customer's choice
    for (const s of decided) expect((await h.service.core.repo.get('shipments', s.shipmentId))!.failed_delivery!.chosen).toMatchObject({ choice: 'pickup' });
  });
});
