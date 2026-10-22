import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REWARDS, TASKS, seedRewards } from '../../../../tools/simulate/rewards-data.js';
import { auth, callers } from '../../../testing/app.js';
import { boot, newId, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

describe('sample Daily rewards (tools/simulate/rewards-data.ts)', () => {
  it('passes the admin API as it is, waits for another staff member to confirm funding, and adds nothing the second time', async () => {
    const as = (headers: Record<string, string>) => async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown) => {
      const res = await k.call(method, `/api${path}`, body, headers);
      if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    };
    const admin = as(k.staff());
    // alone, the staff member can't confirm the funding of their own campaigns
    const alone = await seedRewards(admin, { now: () => k.clock.now() });
    expect(alone).toEqual({ program: 1, tasks: TASKS.length, campaigns: REWARDS.length, rewards: 0, waitingForFunding: REWARDS.map((r) => r.campaign.name) });
    const reviewer = as(auth(callers.staff(undefined, { sub: newId() } as never)));
    expect(await seedRewards(admin, { reviewer, now: () => k.clock.now() })).toEqual({ program: 0, tasks: 0, campaigns: 0, rewards: REWARDS.length, waitingForFunding: [] });
    expect(await seedRewards(admin, { reviewer, now: () => k.clock.now() })).toEqual({ program: 0, tasks: 0, campaigns: 0, rewards: 0, waitingForFunding: [] });

    const summary = (await k.store(newId(), 'GET', '/summary')).body;
    expect(summary.week.map((d: any) => d.points)).toEqual([10, 10, 15, 15, 20, 20, 100]);
    expect(summary.tasks.map((t: any) => `${t.title} ${t.points}`)).toEqual(['Visit a store page 5', 'Write a review 30', 'Share a product 10']);
    expect(summary.rewards.map((r: any) => [r.title, r.condition, r.cost, r.tint, r.available])).toEqual([
      ['$5 off', 'On orders over $50', 500, 'deal', true],
      ['Free delivery', 'One order, any store', 300, 'brand', true],
      ['10% off', 'Electronics, up to $30', 800, 'info', true],
      ['$15 off', 'On orders over $120', 1400, 'neutral', true],
    ]);
    const admins = (await k.admin('GET', '/rewards')).body;
    expect(admins.map((r: any) => r.campaignName)).toEqual(REWARDS.map((r) => r.campaign.name));
  });
});
