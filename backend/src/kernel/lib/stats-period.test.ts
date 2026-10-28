import { describe, expect, it } from 'vitest';
import { isAppError } from '../errors/index.js';
import {
  average,
  bucketOf,
  buckets,
  daysBetween,
  grainFor,
  pointLabel,
  previousPeriod,
  shares,
  statPeriod,
  statPrevious,
  tallyInto,
  weekdayOf,
  weekdayRows,
  type StatTally,
} from './stats-period.js';

const TODAY = '2026-10-22'; // a Thursday

describe('the period a range asks for', () => {
  it('reads every preset from today', () => {
    const range = (r: Parameters<typeof statPeriod>[0]['range']) => {
      const p = statPeriod({ range: r }, TODAY);
      return [p.from, p.to, p.days, p.grain, p.all];
    };
    expect(range('last_30_days')).toEqual(['2026-09-23', TODAY, 30, 'day', false]);
    expect(range('last_3_months')).toEqual(['2026-07-24', TODAY, 91, 'week', false]);
    expect(range('last_6_months')).toEqual(['2026-04-24', TODAY, 182, 'month', false]);
    expect(range('last_12_months')).toEqual(['2025-10-23', TODAY, 365, 'month', false]);
    expect(range('this_year')).toEqual(['2026-01-01', TODAY, 295, 'month', false]);
    expect(range('last_year')).toEqual(['2025-01-01', '2025-12-31', 365, 'month', false]);
    // no range is last_12_months
    expect(statPeriod({}, TODAY).from).toBe('2025-10-23');
  });

  it('starts range=all at the first record, and never after today', () => {
    expect(statPeriod({ range: 'all' }, TODAY, '2024-03-04')).toMatchObject({ from: '2024-03-04', to: TODAY, all: true });
    // no records: the period is today alone
    expect(statPeriod({ range: 'all' }, TODAY, null)).toMatchObject({ from: TODAY, to: TODAY, days: 1 });
    // a record dated in the future cannot start a period after today
    expect(statPeriod({ range: 'all' }, TODAY, '2030-01-01').from).toBe(TODAY);
  });

  it('takes a custom period and refuses a half-given, backwards or over-long one', () => {
    expect(statPeriod({ from: '2026-10-01', to: '2026-10-07' }, TODAY)).toMatchObject({ from: '2026-10-01', to: '2026-10-07', days: 7, grain: 'day' });
    const bad = (q: Record<string, string>) => {
      try {
        statPeriod(q, TODAY);
        return null;
      } catch (e) {
        return isAppError(e) ? [e.code, (e.details as { issues: { path: string }[] }).issues[0]!.path] : e;
      }
    };
    expect(bad({ from: '2026-10-01' })).toEqual(['VALIDATION_FAILED', 'to']);
    expect(bad({ to: '2026-10-01' })).toEqual(['VALIDATION_FAILED', 'from']);
    expect(bad({ from: '2026-10-08', to: '2026-10-01' })).toEqual(['VALIDATION_FAILED', 'to']);
    expect(bad({ from: '2016-10-01', to: '2026-10-01' })).toEqual(['VALIDATION_FAILED', 'from']);
    // exactly three years is still allowed
    expect(statPeriod({ from: '2023-10-24', to: '2026-10-22' }, TODAY).days).toBe(1095);
  });

  it('keeps the grain asked for unless it would draw more than 400 points', () => {
    expect(grainFor(10)).toBe('day');
    expect(grainFor(60)).toBe('week');
    expect(grainFor(400)).toBe('month');
    expect(grainFor(365, 'week')).toBe('week');
    // a year by day is 365 points, three years is 1095 → back to the automatic grain
    expect(grainFor(365, 'day')).toBe('day');
    expect(grainFor(1095, 'day')).toBe('month');
    expect(grainFor(10, 'month')).toBe('month');
  });

  it('counts the days of a period with both ends included', () => {
    expect(daysBetween('2026-10-22', '2026-10-22')).toBe(1);
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(31);
    // across a daylight-saving change
    expect(daysBetween('2026-10-25', '2026-11-05')).toBe(12);
  });

  it('puts the period before a period right before it, the same length', () => {
    expect(previousPeriod(statPeriod({ range: 'last_30_days' }, TODAY))).toEqual({ from: '2026-08-24', to: '2026-09-22' });
    expect(previousPeriod(statPeriod({ from: '2026-10-01', to: '2026-10-07' }, TODAY))).toEqual({ from: '2026-09-24', to: '2026-09-30' });
  });
});

describe('series points', () => {
  it('puts a day in its own point, its week’s Monday or its month’s 1st, never before the period', () => {
    expect(bucketOf('2026-10-22', 'day', '2026-10-01')).toBe('2026-10-22');
    expect(bucketOf('2026-10-22', 'week', '2026-10-01')).toBe('2026-10-19'); // the Monday
    expect(bucketOf('2026-10-22', 'month', '2026-10-01')).toBe('2026-10-01');
    // the first point starts at the period, not before it
    expect(bucketOf('2026-10-07', 'week', '2026-10-05')).toBe('2026-10-05');
    expect(bucketOf('2026-10-07', 'month', '2026-10-05')).toBe('2026-10-05');
  });

  it('lays out every point of a period, zeros included', () => {
    expect(buckets('2026-10-01', '2026-10-05', 'day')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
    // weeks run to the next Monday; the first is short
    expect(buckets('2026-10-01', '2026-10-20', 'week')).toEqual(['2026-10-01', '2026-10-05', '2026-10-12', '2026-10-19']);
    expect(buckets('2026-09-15', '2026-12-01', 'month')).toEqual(['2026-09-15', '2026-10-01', '2026-11-01', '2026-12-01']);
    expect(buckets('2026-10-22', '2026-10-22', 'day')).toEqual(['2026-10-22']);
  });

  it('names a point the way the app shows it', () => {
    expect(pointLabel('2026-10-14', 'day', false)).toBe('Oct 14');
    expect(pointLabel('2026-10-14', 'day', true)).toBe('Oct 14, 2026');
    expect(pointLabel('2026-10-19', 'week', false)).toBe('Week of Oct 19');
    expect(pointLabel('2026-10-01', 'month', false)).toBe('Oct 2026');
  });

  it('numbers weekdays from Monday and names all seven, zeros included', () => {
    expect(weekdayOf('2026-10-19')).toBe(0); // Monday
    expect(weekdayOf('2026-10-22')).toBe(3);
    expect(weekdayOf('2026-10-25')).toBe(6); // Sunday
    const rows = weekdayRows([{ amount: 100, count: 1 }], 'USD');
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual({ weekday: 'mon', label: 'Mon', amount: { amount: 100, currency: 'USD' }, count: 1 });
    expect(rows[6]).toEqual({ weekday: 'sun', label: 'Sun', amount: { amount: 0, currency: 'USD' }, count: 0 });
  });
});

describe('breakdown rows', () => {
  const tally = (rows: [string, string, number, string[]][]) => {
    const map = new Map<string, StatTally>();
    for (const [key, label, amount, records] of rows) for (const r of records) tallyInto(map, key, label, r, amount / records.length, 1);
    return map;
  };

  it('ranks by amount, counts each record once and works out each share', () => {
    const map = new Map<string, StatTally>();
    tallyInto(map, 'a', 'Alpha', 'o1', 600, 2);
    tallyInto(map, 'a', 'Alpha', 'o1', 400, 1); // the same order, two items
    tallyInto(map, 'b', 'Beta', 'o2', 300, 1);
    const rows = shares(map, { total: 1300, currency: 'USD' });
    expect(rows.map((r) => [r.key, r.label, r.amount.amount, r.sharePct, r.count, r.units])).toEqual([
      ['a', 'Alpha', 1000, 76.9, 1, 3],
      ['b', 'Beta', 300, 23.1, 1, 1],
    ]);
  });

  it('folds everything past the top rows into one Other row', () => {
    const map = tally([
      ['a', 'A', 700, ['1']],
      ['b', 'B', 600, ['2']],
      ['c', 'C', 500, ['3']],
      ['d', 'D', 400, ['4']],
      ['e', 'E', 300, ['5']],
      ['f', 'F', 200, ['6']],
      ['g', 'G', 100, ['7']],
    ]);
    const rows = shares(map, { total: 2800, currency: 'USD' });
    expect(rows.map((r) => [r.key, r.amount.amount, r.count])).toEqual([
      ['a', 700, 1],
      ['b', 600, 1],
      ['c', 500, 1],
      ['d', 400, 1],
      ['e', 300, 1],
      ['other', 300, 2],
    ]);
    expect(rows.at(-1)!.label).toBe('Other');
    // six rows or fewer are kept as they are
    expect(shares(tally([['a', 'A', 1, ['1']]]), { total: 1, currency: 'USD' })).toHaveLength(1);
  });

  it('ranks by record count for reports that count records, not money', () => {
    const map = new Map<string, StatTally>();
    tallyInto(map, 'few', 'Few', 'r1', 9999, 0);
    tallyInto(map, 'many', 'Many', 'r2', 0, 0);
    tallyInto(map, 'many', 'Many', 'r3', 0, 0);
    const rows = shares(map, { total: 3, currency: 'USD', by: 'count' });
    expect(rows.map((r) => [r.key, r.count, r.sharePct])).toEqual([
      ['many', 2, 66.7],
      ['few', 1, 33.3],
    ]);
  });

  it('leaves out rows with nothing in them, and gives zero shares when the total is zero', () => {
    const map = new Map<string, StatTally>();
    tallyInto(map, 'empty', 'Empty', 'r1', 0, 0);
    expect(shares(map, { total: 0, currency: 'USD' })).toEqual([]);
    expect(shares(map, { total: 0, currency: 'USD', by: 'count' })).toEqual([
      { key: 'empty', label: 'Empty', amount: { amount: 0, currency: 'USD' }, sharePct: 0, count: 1, units: 0 },
    ]);
  });
});

describe('comparing with the period before', () => {
  it('works the change out to one decimal, and leaves it out when there is nothing to compare with', () => {
    expect(statPrevious('2026-09-01', '2026-09-30', 10_000, 4, 12_500, 'USD')).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
      amount: { amount: 10_000, currency: 'USD' },
      count: 4,
      changePct: 25,
    });
    expect(statPrevious('2026-09-01', '2026-09-30', 12_000, 4, 9000, 'USD').changePct).toBe(-25);
    expect(statPrevious('2026-09-01', '2026-09-30', 3000, 1, 3100, 'USD').changePct).toBe(3.3);
    // nothing before: no percentage to show
    expect(statPrevious('2026-09-01', '2026-09-30', 0, 0, 5000, 'USD').changePct).toBeNull();
    expect(statPrevious('2026-09-01', '2026-09-30', 0, 0, 0, 'USD').changePct).toBeNull();
  });

  it('averages to one decimal, or nothing at all', () => {
    expect(average(10, 4)).toBe(2.5);
    expect(average(10, 3)).toBe(3.3);
    expect(average(0, 0)).toBeNull();
  });
});
