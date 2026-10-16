/**
 * Wave 3: the promotions dashboard reads the Official Store margin before and during its range and the store-wide
 * return rate from reports (reports.officialMargin, storeReturnRate).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as common from '../../../spec/common.js';
import { ADMIN, boot, USD, type Kit } from './helpers.js';

let k: Kit;
const marginCalls: common.DateRange[] = [];
const returnCalls: common.DateRange[] = [];
beforeAll(async () => {
  k = await boot({
    reports: {
      // the range asked for has 28.4%, the days before it 31.2%
      officialMargin: async (range) => {
        marginCalls.push(range);
        const during = range.from === '2026-10-01';
        return { sales: USD(100_000), costedSales: USD(100_000), cost: USD(during ? 71_600 : 68_800), marginPct: during ? 28.4 : 31.2 };
      },
      storeReturnRate: async (range) => {
        returnCalls.push(range);
        return { returnedUnits: 6, soldUnits: 100, returnRatePct: 6 };
      },
    },
  });
});
afterAll(() => k?.close());

describe('promotions dashboard figures from reports', () => {
  it('fills the Official Store margin before and after and the store return rate', async () => {
    const res = await k.call('GET', `${ADMIN}/dashboard?from=2026-10-01&to=2026-10-10`, k.staff);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.officialMargin).toEqual({ before: 31.2, after: 28.4, changePts: -2.8 });
    expect(res.body.storeReturnsPct).toBe(6);
    // before: the same number of days just before the range
    expect(marginCalls).toEqual(expect.arrayContaining([{ from: '2026-09-21', to: '2026-09-30' }, { from: '2026-10-01', to: '2026-10-10' }]));
    expect(returnCalls).toEqual([{ from: '2026-10-01', to: '2026-10-10' }]);
  });
});
