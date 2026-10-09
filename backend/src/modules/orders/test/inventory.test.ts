import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import type { InventoryPublicApi } from '../../../spec/inventory.js';
import { checkout, group, harness, idem, line, product, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

describe('stock through the real inventory module', () => {
  it('inventory allocates on orders.order.accepted and releases on orders.item.cancelled', async () => {
    const inv = h.app.kernel.boot.apis.get('inventory') as InventoryPublicApi;
    const sellerId = newId();
    const p = product(h, { title: 'Speaker', price: 5000, sellerId });
    const stock = await inv.createStockItem({ ownerType: 'seller', sellerId, offerId: p.offerId, sku: 'PP-SPK-1', productId: p.productId, variantId: p.variantId, condition: 'new', label: 'Speaker', initialAvailable: 5 });
    p.stockItemId = stock.id;
    h.offers.get(p.offerId)!.stockItemId = stock.id;

    const input = checkout([group(h, [line(p, 2)], { sellerId })], { customerId: newId(), paymentState: 'pending_check' });
    const hold = await inv.hold(input.checkoutSessionId, [{ stockItemId: stock.id, quantity: 2 }]);
    const order = await h.service.createOrder(input);
    const item = order.groups[0]!.items[0]!;
    expect(item.offer.sellerSku).toBe('PP-SPK-1'); // seller SKU frozen from inventory
    await inv.attachOrder(hold.id, order.id, [{ stockItemId: stock.id, orderItemId: item.id }]);
    expect((await inv.getAvailability([stock.id]))[stock.id]!.available).toBe(3);

    await h.service.acceptOrder(order.id, input.paymentIntentId);
    await h.app.kernel.events.drain();
    expect(h.named('inventory.reservation.allocated').some((e) => e.orderId === order.id)).toBe(true);

    const res = await h.call('POST', `/api/seller/orders/orders/${order.groups[0]!.id}/cancel-items`, tokens.seller(sellerId), { items: [{ itemId: item.id, quantity: 1 }], reasonCode: 'damaged_in_storage' }, idem());
    expect(res.status).toBe(201);
    expect(h.named('inventory.reservation.released').some((e) => e.orderId === order.id)).toBe(true);
    expect((await inv.getAvailability([stock.id]))[stock.id]!.available).toBe(4);
  });

  it('inventory allocates from the hold on orders.order.accepted without attachOrder, mapping its lines to the order items', async () => {
    const inv = h.app.kernel.boot.apis.get('inventory') as InventoryPublicApi;
    const sellerId = newId();
    const p = product(h, { title: 'Lamp', price: 3000, sellerId });
    const stock = await inv.createStockItem({ ownerType: 'seller', sellerId, offerId: p.offerId, sku: 'PP-LMP-1', productId: p.productId, variantId: p.variantId, condition: 'new', label: 'Lamp', initialAvailable: 5 });
    p.stockItemId = stock.id;
    h.offers.get(p.offerId)!.stockItemId = stock.id;

    const input = checkout([group(h, [line(p, 2)], { sellerId })], { customerId: newId() });
    const hold = await inv.hold(input.checkoutSessionId, [{ stockItemId: stock.id, quantity: 2 }]);
    const order = await h.service.createOrder({ ...input, reservationId: hold.id });
    await h.app.kernel.events.drain();
    const item = order.groups[0]!.items[0]!;
    expect(h.named('inventory.reservation.allocated').find((e) => e.orderId === order.id)).toMatchObject({ reservationId: hold.id, lines: [expect.objectContaining({ orderItemId: item.id, quantity: 2, state: 'allocated' })] });

    // checkout's attachOrder arriving afterwards is harmless
    const attached = await inv.attachOrder(hold.id, order.id, [{ stockItemId: stock.id, orderItemId: item.id }]);
    expect(attached).toMatchObject({ state: 'allocated', lines: [expect.objectContaining({ orderItemId: item.id })] });
    expect((await inv.getAvailability([stock.id]))[stock.id]!.available).toBe(3);
  });
});
