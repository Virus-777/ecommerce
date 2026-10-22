/**
 * Department notices of Phase 4 (2026-10-24): farm orders, registered devices, replaced licence keys, new posts by
 * followed blog authors and Play center prizes reach the customer in-app. These events name the customers-module
 * customer (not the account), like food.
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

const farmOrder = (customerId: string, o: Record<string, unknown> = {}) => ({
  orderId: newId(),
  ref: 'FM-7K2QD',
  customerId,
  dealerName: 'Willamette Farm Supply',
  machineName: 'John Deere 5075E',
  status: 'confirmed',
  paymentOption: 'pay_in_full',
  total: money(4_850_000),
  cardAmount: money(4_850_000),
  deliveryDate: '2026-11-03',
  rescheduled: false,
  note: null,
  ...o,
});

describe('farm orders', () => {
  it('tells the customer the order was placed and what the dealer did with it', async () => {
    const c = world.customer();
    const orderId = newId();
    await publish(app, 'farm.order.placed', { orderId, ref: 'FM-7K2QD', customerId: c.customerId, dealerId: newId(), dealerName: 'Willamette Farm Supply', machineName: 'John Deere 5075E', paymentOption: 'installments', total: money(4_850_000), cardAmount: money(0), deliveryDate: '2026-11-03' });
    const o = (status: string, extra: Record<string, unknown> = {}) => farmOrder(c.customerId, { orderId, status, paymentOption: 'installments', cardAmount: money(0), ...extra });
    await publish(app, 'farm.order.status_changed', o('payment_pending')); // nothing to tell
    await publish(app, 'farm.order.status_changed', o('confirmed'));
    await publish(app, 'farm.order.status_changed', o('confirmed')); // the same move twice: one notice
    await publish(app, 'farm.order.status_changed', o('confirmed', { rescheduled: true, deliveryDate: '2026-11-05' }));
    await publish(app, 'farm.order.status_changed', o('out_for_delivery', { deliveryDate: '2026-11-05' }));
    await publish(app, 'farm.order.status_changed', o('delivered', { deliveryDate: '2026-11-05' }));
    const notices = await inbox(as.customer(c));
    expect(notices.map((n) => n.body)).toEqual([
      'John Deere 5075E delivered',
      'Your John Deere 5075E is on its way',
      'Delivery of FM-7K2QD moved to Thu, Nov 5',
      'Willamette Farm Supply confirmed your John Deere 5075E · delivery Tue, Nov 3.', // installments: no payment sentence
      'Order FM-7K2QD placed — Willamette Farm Supply will confirm your delivery date',
    ]);
    expect(notices[4]).toMatchObject({ topicKey: 'customer.farm.order', title: 'Order FM-7K2QD placed' });
    for (const n of notices) expect(n.link).toMatchObject({ kind: 'farm_order', id: orderId, screen: 'store/farm-order-detail', ref: 'FM-7K2QD' });
  });

  it('says what was charged when the dealer confirms', async () => {
    const c = world.customer();
    await publish(app, 'farm.order.status_changed', farmOrder(c.customerId, { ref: 'FM-FULL1' }));
    await publish(app, 'farm.order.status_changed', farmOrder(c.customerId, { ref: 'FM-DEPO1', paymentOption: 'pay_on_delivery', total: money(2_210_000), cardAmount: money(221_000) }));
    const [deposit, full] = await inbox(as.customer(c));
    expect(full.body).toBe('Willamette Farm Supply confirmed your John Deere 5075E · delivery Tue, Nov 3. Your card was charged.');
    expect(deposit.body).toBe('Willamette Farm Supply confirmed your John Deere 5075E · delivery Tue, Nov 3. Your $2,210.00 deposit was charged; pay the rest ($19,890.00) when it arrives.');
  });

  it('says why an order was rejected or cancelled, and when the payment failed', async () => {
    const c = world.customer();
    await publish(app, 'farm.order.status_changed', farmOrder(c.customerId, { ref: 'FM-REJ01', status: 'rejected', note: 'Out of stock until spring.' }));
    await publish(app, 'farm.order.status_changed', farmOrder(c.customerId, { ref: 'FM-EXP01', status: 'cancelled', note: "The dealer didn't confirm the order in time" }));
    await publish(app, 'farm.order.status_changed', farmOrder(c.customerId, { ref: 'FM-CAN01', status: 'cancelled' }));
    await publish(app, 'farm.order.status_changed', farmOrder(c.customerId, { ref: 'FM-PAY01', status: 'payment_failed' }));
    const [failed, cancelled, expired, rejected] = await inbox(as.customer(c));
    expect(rejected.body).toBe("Willamette Farm Supply couldn't take order FM-REJ01: Out of stock until spring. Nothing was charged.");
    expect(expired.body).toBe("Order FM-EXP01 was cancelled: The dealer didn't confirm the order in time");
    expect(cancelled.body).toBe('Order FM-CAN01 was cancelled');
    expect(failed.body).toBe("Payment for FM-PAY01 didn't go through — try again");
  });
});

describe('registered devices and licence keys', () => {
  it('tells the customer their device was verified or why it was not', async () => {
    const c = world.customer();
    const deviceId = newId();
    await publish(app, 'services.device.verified', { deviceId, customerId: c.customerId, label: 'Pixel 9 Pro', coveredUntil: '2027-10-21' });
    await publish(app, 'services.device.rejected', { deviceId: newId(), customerId: c.customerId, label: 'Galaxy S24', reason: 'The IMEI belongs to another model.' });
    const [rejected, verified] = await inbox(as.customer(c));
    expect(verified).toMatchObject({ topicKey: 'customer.services.device', title: 'Your Pixel 9 Pro is verified', body: 'Your Pixel 9 Pro is verified. Post-sale cover runs to Oct 2027.' });
    expect(verified.link).toMatchObject({ kind: 'device', id: deviceId, screen: 'store/devices' });
    expect(rejected.body).toBe("We couldn't verify your Galaxy S24: The IMEI belongs to another model. Check it in Phones › Your devices.");
  });

  it('tells the owner their licence key was replaced', async () => {
    const c = world.customer();
    await publish(app, 'software.licence.reissued', { entitlementId: newId(), customerId: c.customerId, appId: newId(), slug: 'pixelcraft-studio', title: 'PixelCraft Studio' });
    const [notice] = await inbox(as.customer(c));
    expect(notice).toMatchObject({ topicKey: 'customer.software.licence', body: 'Your licence key for PixelCraft Studio was replaced. Find the new key in Softwares › My apps; the old key no longer works.' });
    expect(notice.link).toMatchObject({ kind: 'software_licence', id: 'pixelcraft-studio', screen: 'store/software-library' });
  });
});

describe('blogs and Play center', () => {
  it('tells a follower about a new post once', async () => {
    const c = world.customer();
    const post = { customerId: c.customerId, postId: newId(), postSlug: 'five-budget-phones', postTitle: 'Five budget phones worth buying this fall', authorId: newId(), authorName: 'Maya Chen' };
    await publish(app, 'departments.blog.followed_author_posted', post);
    await publish(app, 'departments.blog.followed_author_posted', post);
    const notices = await inbox(as.customer(c));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ topicKey: 'customer.blogs.followed_author', body: 'Maya Chen posted: Five budget phones worth buying this fall' });
    expect(notices[0].link).toMatchObject({ kind: 'blog_post', id: 'five-budget-phones', screen: 'store/blog-post' });
  });

  it('tells a winner where their prize coupon is, once per game and week', async () => {
    const c = world.customer();
    const prize = { customerId: c.customerId, gameId: newId(), gameSlug: 'block-drop', gameTitle: 'Block Drop', week: '2026-10-19', rank: 3, reward: '$10 coupon', code: 'PLAY-K7QM2', codeEndsAt: null };
    await publish(app, 'departments.play.prize_awarded', prize);
    await publish(app, 'departments.play.prize_awarded', prize);
    await publish(app, 'departments.play.prize_awarded', { ...prize, gameId: newId(), gameSlug: 'fruit-match', gameTitle: 'Fruit Match', rank: 1, reward: 'Free delivery for a month' });
    const notices = await inbox(as.customer(c));
    expect(notices).toHaveLength(2);
    expect(notices[1]).toMatchObject({ topicKey: 'customer.play.prize', title: 'You won a $10 coupon in Block Drop', body: 'You won a $10 coupon in Block Drop (rank #3). Coupons land in Account › Coupons.' });
    expect(notices[1].link).toMatchObject({ kind: 'play_prize', id: 'block-drop', screen: 'account/coupons', ref: 'PLAY-K7QM2' });
    expect(notices[0].body).toBe('You won free delivery for a month in Fruit Match (rank #1). Coupons land in Account › Coupons.');
  });
});
