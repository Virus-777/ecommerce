/** Daily rewards' part of the integrated search (search calls searchRewards): the reward catalogue. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as common from '../../../spec/common.js';
import type { RewardsService } from '../service.js';
import { boot, newId, type Kit } from './helpers.js';

let k: Kit;
let svc: RewardsService;
beforeAll(async () => {
  k = await boot();
  svc = k.app.kernel.boot.apis.get('rewards') as RewardsService;
  const campaign = await k.couponCampaign();
  const add = (payload: Record<string, unknown>) => k.admin('POST', '/rewards', { campaignId: campaign.id, ...payload });
  expect((await add({ title: 'Free delivery', condition: 'On your next order', cost: 300, tint: 'brand' })).status).toBe(201);
  expect((await add({ title: '$5 off', condition: 'On orders over $50', cost: 500, tint: 'deal' })).status).toBe(201);
  expect((await add({ title: 'Hidden treat', condition: 'Any order', cost: 100, visible: false })).status).toBe(201);
});
afterAll(async () => {
  await k?.app.close();
});

const ask = (q: string, over: Partial<common.DeptSearchRequest> = {}) => svc.searchRewards({ q, limit: 10, ...over });

describe('searchRewards', () => {
  it('finds a reward by title, priced in points, opening the Daily rewards department', async () => {
    const res = await ask('free delivery');
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]).toMatchObject({ kind: 'reward', title: 'Rewards', total: 1 });
    expect(res.groups[0]!.items[0]).toMatchObject({ kind: 'reward', title: 'Free delivery', priceLabel: '300 points', path: '/rewards', score: 100 });
  });

  it('finds a reward by its condition, and never one staff hid', async () => {
    expect(titles(await ask('orders over'))).toEqual(['$5 off']);
    expect(titles(await ask('hidden treat'))).toEqual([]);
  });

  it('tells a signed-in customer how many points are still missing', async () => {
    const accountId = newId();
    const customerId = k.customerOf(accountId);
    expect((await k.admin('POST', '/adjustments', { customerId, points: 120, reason: 'Test points' })).status).toBe(201);
    const mine = await ask('free delivery', { customerId });
    expect(mine.groups[0]!.items[0]!.meta).toBe('On your next order · 180 points to go');
    // a visitor only sees what the reward costs
    expect((await ask('free delivery')).groups[0]!.items[0]!.meta).toBe('On your next order');
  });

  it('answers nothing for another kind or an empty query', async () => {
    expect((await ask('free delivery', { kinds: ['app'] })).groups).toEqual([]);
    expect((await ask('   ')).groups).toEqual([]);
  });
});

const titles = (r: common.DeptSearchResult) => r.groups.flatMap((g) => g.items.map((i) => i.title));
