/**
 * Department notices (Phase 3, 2026-10-23): customers hear about their food orders, paid software purchases and the
 * coupons they got for Daily rewards points, in-app. These events name the customers-module customer (not the account).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../../../testing/app.js';
import { as, MODULES, money, newId, publish, World } from './harness.js';

let app: FastifyInstance;
let world: World;

beforeAll(async () => {
  world = new World();
  app = await buildTestApp({ modules: MODULES, config: { launchPhase: 4, rateLimits: false }, apiStubs: world.stubs() });
});
afterAll(async () => {
  await app?.close();
});

const inbox = async (headers: Record<string, string>) => {
  const res = await app.inject({ method: 'GET', url: '/api/store/notifications/inbox', headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as any[];
};

describe('food orders', () => {
  it('tells the customer what the restaurant and the courier did, not what they did themselves', async () => {
    const c = world.customer();
    const orderId = newId();
    const order = (status: string, note: string | null = null) => ({ orderId, ref: 'FD-9QX3M', customerId: c.customerId, restaurantName: 'Napoli Corner', status, note });
    for (const s of ['payment_pending', 'placed', 'preparing']) await publish(app, 'food.order.status_changed', order(s));
    expect(await inbox(as.customer(c))).toHaveLength(0);

    await publish(app, 'food.order.status_changed', order('accepted'));
    await publish(app, 'food.order.status_changed', order('accepted')); // the same move twice: one notice
    await publish(app, 'food.order.status_changed', order('on_the_way'));
    await publish(app, 'food.order.status_changed', order('delivered'));
    const notices = await inbox(as.customer(c));
    expect(notices.map((n) => n.title)).toEqual(['Your order FD-9QX3M was delivered', 'Your order FD-9QX3M is on the way', 'Napoli Corner accepted your order FD-9QX3M']);
    expect(notices[2]).toMatchObject({ topicKey: 'customer.food.order', body: "Napoli Corner accepted your order FD-9QX3M. We'll let you know when it's on the way." });
    expect(notices[0].link).toMatchObject({ kind: 'food_order', id: orderId, screen: 'store/food-order', ref: 'FD-9QX3M' });
  });

  it('says why an order was declined or cancelled, and when the payment failed', async () => {
    const c = world.customer();
    const order = (status: string, note: string | null = null) => ({ orderId: newId(), ref: `FD-${status.slice(0, 4).toUpperCase()}`, customerId: c.customerId, restaurantName: 'Napoli Corner', status, note });
    await publish(app, 'food.order.status_changed', order('declined', 'The kitchen is closing early.'));
    await publish(app, 'food.order.status_changed', order('cancelled'));
    await publish(app, 'food.order.status_changed', order('payment_failed'));
    const [failed, cancelled, declined] = await inbox(as.customer(c));
    expect(declined).toMatchObject({ title: 'Your order FD-DECL was declined', body: "Your order FD-DECL was declined. Napoli Corner couldn't take it: The kitchen is closing early. You won't be charged." });
    expect(cancelled.title).toBe('Your order FD-CANC was cancelled');
    expect(failed.title).toBe("The payment for your order FD-PAYM didn't go through");
  });
});

describe('software purchases and Daily rewards', () => {
  it('tells the customer a paid purchase is theirs and where the licence key is', async () => {
    const c = world.customer();
    const purchaseId = newId();
    await publish(app, 'software.purchase.paid', { purchaseId, ref: 'SW-4K7Q2', customerId: c.customerId, title: 'PixelCraft Studio', amount: money(2499), appIds: [newId()] });
    await publish(app, 'software.purchase.paid', { purchaseId: newId(), ref: 'SW-PACK1', customerId: c.customerId, title: 'Creator Pack', amount: money(4999), appIds: [newId(), newId()] });
    const [pack, notice] = await inbox(as.customer(c));
    expect(notice).toMatchObject({ topicKey: 'customer.software.purchase', title: 'PixelCraft Studio is yours', body: 'PixelCraft Studio is yours. Your licence key is in Softwares › My apps.' });
    expect(notice.link).toMatchObject({ kind: 'software_purchase', id: purchaseId, screen: 'store/software-purchase', ref: 'SW-4K7Q2' });
    expect(pack.body).toBe('Creator Pack is yours. Its apps and their licence keys are in Softwares › My apps.');
  });

  it('gives the customer the code of the coupon they got for points', async () => {
    const c = world.customer();
    const redemptionId = newId();
    await publish(app, 'rewards.reward.redeemed', { redemptionId, customerId: c.customerId, title: '$5 off', code: 'K7QM2XRP', cost: 1500 });
    const [notice] = await inbox(as.customer(c));
    expect(notice).toMatchObject({ topicKey: 'customer.rewards.coupon', title: 'Your $5 off coupon is ready: K7QM2XRP', body: 'You swapped 1,500 points for a $5 off coupon. Use code K7QM2XRP at checkout; it is in My coupons.' });
    expect(notice.link).toMatchObject({ kind: 'reward', id: redemptionId, screen: 'account/coupons' });
  });
});
