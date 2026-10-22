/** The reward catalogue (coupons of promotions campaigns), redemptions, customers' points and adjustments, the export. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PromotionsPublicApi } from '../../../spec/promotions.js';
import type { RewardsService } from '../service.js';
import { boot, newId, type Kit } from './helpers.js';

let k: Kit;
let campaign: { id: string; period: { endsAt: string } };
let reward: any;
beforeAll(async () => {
  k = await boot();
  campaign = await k.couponCampaign();
  const res = await k.admin('POST', '/rewards', { title: '$5 off', condition: 'On orders over $50', cost: 500, tint: 'deal', campaignId: campaign.id });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  reward = res.body;
});
afterAll(async () => {
  await k?.app.close();
});

const promotions = () => k.app.kernel.boot.apis.get('promotions') as PromotionsPublicApi;
const give = async (accountId: string, points: number) => {
  const res = await k.admin('POST', '/adjustments', { customerId: k.customerOf(accountId), points, reason: 'Test points' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};

describe('the reward catalogue', () => {
  it('adds coupons of running coupon campaigns, with the campaign name and state', async () => {
    expect(reward).toMatchObject({ title: '$5 off', condition: 'On orders over $50', cost: 500, tint: 'deal', campaignId: campaign.id, campaignName: expect.stringContaining('Daily rewards'), campaignActive: true, stock: null, redeemed: 0, visible: true });
    const notActive = await k.admin('POST', '/rewards', { title: '$9 off', condition: 'Any order', cost: 900, campaignId: newId() });
    expect(notActive.status).toBe(409);
    expect(notActive.body.error.code).toBe('CAMPAIGN_NOT_ACTIVE');
    const bad = await k.admin('POST', '/rewards', { title: '$9 off', condition: 'Any order', cost: 0, campaignId: campaign.id });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues[0].path).toBe('cost');
    expect((await k.admin('POST', '/rewards', { title: '$9 off', condition: 'Any order', cost: 900, campaignId: campaign.id }, k.staff(['rewards.view']))).status).toBe(403);
    const list = await k.admin('GET', '/rewards', undefined, k.staff(['rewards.view']));
    expect(list.body.map((r: any) => r.id)).toContain(reward.id);
    expect(k.audits.find((a) => a.action === 'rewards.reward.create')).toMatchObject({ target: { type: 'rewards_reward', id: reward.id } });
  });

  it('shows the rewards with what the customer can swap and how many points are missing', async () => {
    const me = newId();
    await give(me, 200);
    const summary = (await k.store(me, 'GET', '/summary')).body;
    expect(summary.rewards.find((r: any) => r.id === reward.id)).toEqual({ id: reward.id, title: '$5 off', condition: 'On orders over $50', cost: 500, tint: 'deal', canRedeem: false, missing: 300, available: true });
  });
});

describe('redeeming', () => {
  it('swaps points for the customer’s own code, once per Idempotency-Key, shown in My coupons', async () => {
    const me = newId();
    const customerId = k.customerOf(me);
    const poor = await k.store(me, 'POST', `/rewards/${reward.id}/redeem`);
    expect(poor.status).toBe(409);
    expect(poor.body.error).toMatchObject({ code: 'NOT_ENOUGH_POINTS', details: { missing: 500 } });

    await give(me, 600);
    const key = newId();
    const res = await k.store(me, 'POST', `/rewards/${reward.id}/redeem`, undefined, { 'idempotency-key': key });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ rewardId: reward.id, title: '$5 off', condition: 'On orders over $50', cost: 500, code: expect.stringMatching(/^[A-Z2-9]{8}$/), endsAt: campaign.period.endsAt });
    const again = await k.store(me, 'POST', `/rewards/${reward.id}/redeem`, undefined, { 'idempotency-key': key });
    expect(again.body).toEqual(res.body);
    expect((await k.store(me, 'GET', '/summary')).body.balance).toBe(100);
    expect(k.events.filter((e) => e.payload.redemptionId === res.body.id)).toEqual([{ name: 'rewards.reward.redeemed', payload: { redemptionId: res.body.id, customerId, title: '$5 off', code: res.body.code, cost: 500 } }]);

    // the code is the customer's (customers-module id) coupon
    const coupons = await promotions().couponsForCustomer(customerId);
    expect(coupons.available.find((c) => c.campaignId === campaign.id)).toMatchObject({ code: res.body.code });
    const history = (await k.store(me, 'GET', '/history')).body.items;
    expect(history[0]).toMatchObject({ kind: 'redeem', title: '$5 off coupon', points: -500, balanceAfter: 100 });
    const mine = await k.store(me, 'GET', '/redemptions');
    expect(mine.body.items).toEqual([res.body]);
    expect((await k.admin('GET', '/rewards')).body.find((r: any) => r.id === reward.id).redeemed).toBe(1);
  });

  it('runs out of stock, refuses hidden rewards and gives the points back when the campaign ended', async () => {
    const limited = (await k.admin('POST', '/rewards', { title: 'Free delivery', condition: 'One order, any store', cost: 300, tint: 'brand', campaignId: campaign.id, stock: 1 })).body;
    const a = newId();
    const b = newId();
    await give(a, 300);
    await give(b, 300);
    expect((await k.store(a, 'POST', `/rewards/${limited.id}/redeem`)).status).toBe(201);
    const sold = await k.store(b, 'POST', `/rewards/${limited.id}/redeem`);
    expect(sold.status).toBe(409);
    expect(sold.body.error.code).toBe('SOLD_OUT');
    expect((await k.store(b, 'GET', '/summary')).body.rewards.find((r: any) => r.id === limited.id)).toMatchObject({ available: false, canRedeem: false, missing: 0 });

    await k.admin('PATCH', `/rewards/${limited.id}`, { title: 'Free delivery', condition: 'One order, any store', cost: 300, campaignId: campaign.id, visible: false });
    expect((await k.store(b, 'POST', `/rewards/${limited.id}/redeem`)).status).toBe(404);

    const ending = await k.couponCampaign({ name: 'Daily rewards: 10% off' });
    const tenOff = (await k.admin('POST', '/rewards', { title: '10% off', condition: 'Electronics, up to $30', cost: 200, tint: 'info', campaignId: ending.id })).body;
    expect((await k.call('POST', `/api/admin/promotions/campaigns/${ending.id}/end`, { reason: 'Budget moved' })).status).toBe(200);
    const ended = await k.store(b, 'POST', `/rewards/${tenOff.id}/redeem`);
    expect(ended.status).toBe(409);
    expect(ended.body.error.code).toBe('CAMPAIGN_NOT_ACTIVE');
    const after = (await k.store(b, 'GET', '/summary')).body;
    expect(after.balance).toBe(300);
    expect(after.rewards.find((r: any) => r.id === tenOff.id)).toMatchObject({ available: false });
    expect((await k.store(b, 'GET', '/history')).body.items.map((e: any) => e.kind)).toEqual(['adjust']);
    expect((await k.store(b, 'GET', '/redemptions')).body.items).toEqual([]);
    const admin = (await k.admin('GET', '/rewards')).body.find((r: any) => r.id === tenOff.id);
    expect(admin).toMatchObject({ campaignActive: false, redeemed: 0 });

    // a reward nobody redeemed can be deleted; a redeemed one only hidden
    expect((await k.admin('DELETE', `/rewards/${tenOff.id}`)).status).toBe(204);
    const inUse = await k.admin('DELETE', `/rewards/${limited.id}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe('IN_USE');
  });
});

describe('admin: redemptions and customers', () => {
  it('lists redemptions by code or customer email, and customers by balance', async () => {
    const me = newId();
    const customerId = k.customerOf(me);
    await give(me, 1000);
    const r = (await k.store(me, 'POST', `/rewards/${reward.id}/redeem`)).body;
    const all = await k.admin('GET', '/redemptions', undefined, k.staff(['rewards.view']));
    expect(all.status).toBe(200);
    expect(all.body.items[0]).toMatchObject({ id: r.id, reward: { id: reward.id, title: '$5 off' }, customer: { id: customerId, name: expect.stringMatching(/^Customer /), email: expect.stringContaining('@example.com') }, cost: 500, code: r.code });
    expect((await k.admin('GET', `/redemptions?q=${r.code.toLowerCase()}`)).body.items.map((x: any) => x.id)).toEqual([r.id]);
    const email = all.body.items[0].customer.email;
    expect((await k.admin('GET', `/redemptions?q=${encodeURIComponent(email)}`)).body.items.map((x: any) => x.id)).toEqual([r.id]);
    expect((await k.admin('GET', `/redemptions?rewardId=${newId()}`)).body.items).toEqual([]);

    const top = (await k.admin('GET', '/customers?limit=50')).body.items;
    expect(top.map((c: any) => c.balance)).toEqual([...top.map((c: any) => c.balance)].sort((x: number, y: number) => y - x));
    expect((await k.admin('GET', `/customers?q=${encodeURIComponent(email)}`)).body.items).toEqual([expect.objectContaining({ customerId, balance: 500, email })]);
    const one = await k.admin('GET', `/customers/${customerId}`);
    expect(one.body).toMatchObject({ customerId, balance: 500, streak: 0, lastCheckIn: null, email });
    expect(one.body.entries.map((e: any) => e.kind)).toEqual(['redeem', 'adjust']);
    expect((await k.admin('GET', `/customers/${newId()}`)).status).toBe(404);
  });

  it('adjusts points with a reason, never below 0, audited', async () => {
    const me = newId();
    const customerId = k.customerOf(me);
    const added = await give(me, 40);
    expect(added).toMatchObject({ customerId, balance: 40 });
    const removed = await k.admin('POST', '/adjustments', { customerId, points: -100, reason: 'Points given by mistake' });
    expect(removed.status).toBe(201);
    expect(removed.body.balance).toBe(0);
    expect(removed.body.entries[0]).toMatchObject({ kind: 'adjust', points: -40, balanceAfter: 0, title: 'Points removed by Marketly' });
    const none = await k.admin('POST', '/adjustments', { customerId, points: -5, reason: 'Again' });
    expect(none.status).toBe(400);
    expect((await k.admin('POST', '/adjustments', { customerId, points: 5, reason: ' ' })).status).toBe(400);
    expect((await k.admin('POST', '/adjustments', { customerId: newId(), points: 5, reason: 'Unknown' })).status).toBe(404);
    expect((await k.admin('POST', '/adjustments', { customerId, points: 5, reason: 'View only' }, k.staff(['rewards.view']))).status).toBe(403);
    expect(k.audits.filter((a) => a.action === 'rewards.points.adjust' && a.target.id === customerId).map((a) => [a.actionLabel, a.reason])).toEqual([
      ['Added 40 Daily rewards points', 'Test points'],
      ['Removed 40 Daily rewards points', 'Points given by mistake'],
    ]);
  });

  it('exports a customer’s points, check-ins and redemptions', async () => {
    const me = newId();
    const customerId = k.customerOf(me);
    const service = k.app.kernel.boot.apis.get('rewards') as RewardsService;
    expect(await service.exportCustomerData({ customerId, accountId: me })).toEqual([]);
    await k.store(me, 'POST', '/check-ins');
    await give(me, 500);
    const r = (await k.store(me, 'POST', `/rewards/${reward.id}/redeem`)).body;
    const [section] = await service.exportCustomerData({ customerId, accountId: me });
    expect(section).toMatchObject({ key: 'daily_rewards', title: 'Daily rewards', module: 'rewards' });
    expect(section!.records).toEqual([
      expect.objectContaining({ type: 'balance', balance: 10, streak: 1 }),
      expect.objectContaining({ type: 'check_in', title: 'Day 1 check-in', points: 10 }),
      expect.objectContaining({ type: 'points', title: 'Points added by Marketly', points: 500 }),
      expect.objectContaining({ type: 'points', title: '$5 off coupon', points: -500 }),
      expect.objectContaining({ type: 'redemption', title: '$5 off', code: r.code, cost: 500 }),
    ]);
  });
});
