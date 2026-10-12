/**
 * returns.fulfilled_by (Fulfilled by Marketly): the order group's fulfilledBy, copied at request, and only
 * official_warehouse, seller or marketly_service in the collection.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { group, harness, idem, line, placeOrder, product, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

describe('returns.fulfilled_by (Fulfilled by Marketly)', () => {
  it('copies fulfilledBy on new returns; the collection only takes the three values', async () => {
    const official = product(h, { title: 'Kettle', price: 5000, ownerType: 'official' });
    const o = await placeOrder(h, [group(h, [line(official, 1)], { ownerType: 'official' })]);
    const a = await h.call('POST', '/api/store/returns/requests', tokens.customer(o.customerId), { orderId: o.order.id, items: [{ orderItemId: o.items[0]![0]!, quantity: 1 }], reason: 'defective', details: 'Cold', remedy: 'refund' }, idem());
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const sellerId = newId();
    const own = product(h, { title: 'Vase', price: 4000, sellerId });
    const s = await placeOrder(h, [group(h, [line(own, 1)], { sellerId })]);
    const b = await h.call('POST', '/api/store/returns/requests', tokens.customer(s.customerId), { orderId: s.order.id, items: [{ orderItemId: s.items[0]![0]!, quantity: 1 }], reason: 'damaged', details: 'Cracked', remedy: 'refund' }, idem());
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const officialId = a.body.returns[0].id;
    const sellerReturnId = b.body.returns[0].id;
    const repo = h.service.core.repo;
    const returns = h.app.kernel.mongo.db.collection('returns.returns');

    // filled at request; the database validator refuses other values and null
    expect((await repo.get('returns', officialId))!.fulfilled_by).toBe('official_warehouse');
    expect((await repo.get('returns', sellerReturnId))!.fulfilled_by).toBe('seller');
    await expect(returns.updateOne({ _id: sellerReturnId }, { $set: { fulfilled_by: 'drone' } })).rejects.toThrow();
    await expect(returns.updateOne({ _id: sellerReturnId }, { $set: { fulfilled_by: null } })).rejects.toThrow();

    const view = await h.call('GET', `/api/admin/returns/requests/${sellerReturnId}`, tokens.staff());
    expect(view.body.fulfilledBy).toBe('seller');
  });
});
