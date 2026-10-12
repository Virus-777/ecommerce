/**
 * Coupon attempts are counted in the kernel's shared rate limits (kernel.rate_limits): two cart
 * instances given one MongoDB database share the hourly limit.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { MongoStore } from '../../../kernel/mongo/index.js';
import { movingClock, tokenClock } from '../../../testing/app.js';
import { testMongo } from '../../../testing/mongo.js';
import { boot, STORE, type Kit } from './helpers.js';

let mongo: MongoStore;
const kits: Kit[] = [];
// windows are clock hours: both instances run at half past an hour, so the 31 attempts never straddle two windows,
// and test tokens are signed at that time too (signed at the real time they would not be valid yet)
const clock = movingClock();
clock.set(new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 + 30 * 60_000));

beforeAll(async () => {
  tokenClock.now = () => clock.now();
  mongo = await testMongo();
  for (let i = 0; i < 2; i++) {
    kits.push(await boot({ mongo, clock, config: { rateLimitStore: 'mongo' } }));
  }
});

afterAll(async () => {
  for (const k of kits) await k.app.close();
  await mongo?.close();
  tokenClock.now = undefined;
});

it('two instances share the coupon attempts per hour', async () => {
  const v = kits[0]!.visitor();
  const limit = 30; // couponPreviewRateLimitPerHour (spec default)
  const statuses: number[] = [];
  for (let i = 0; i <= limit; i++) statuses.push((await kits[i % 2]!.call('POST', `${STORE}/cart/coupons`, { token: v.token, body: { code: `TRY${i}` } })).status);
  expect(statuses.slice(0, limit).every((s) => s === 200)).toBe(true);
  const refused = await kits[1]!.call('POST', `${STORE}/cart/coupons`, { token: v.token, body: { code: 'ONE-MORE' } });
  expect(refused).toMatchObject({ status: 429, body: { error: { code: 'RATE_LIMITED', details: { retryAfterSeconds: expect.any(Number) } } } });
  expect(statuses.at(-1)).toBe(429);
  // another shopper is not affected
  expect((await kits[1]!.call('POST', `${STORE}/cart/coupons`, { token: kits[1]!.visitor().token, body: { code: 'TRY' } })).status).toBe(200);
});
