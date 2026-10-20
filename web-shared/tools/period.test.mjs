// Tests of the report period helpers (src/lib/period.ts) behind PeriodControl / usePeriod: preset ranges, URL
// reading with its fallbacks, the grain limit, comparison ranges and the query sent to the reports API.
//   npm test -w @marketly/web-shared
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, autoGrain, compareRange, presetRange, rangeLabel, readPeriod, writePeriod } from '../src/lib/period.ts';

const TODAY = '2026-10-21';
const read = (qs, defaults) => readPeriod(new URLSearchParams(qs), TODAY, defaults);

test('preset ranges end today', () => {
  assert.deepEqual(presetRange('last_7_days', TODAY), { from: '2026-10-15', to: TODAY });
  assert.deepEqual(presetRange('month_to_date', TODAY), { from: '2026-10-01', to: TODAY });
  assert.deepEqual(presetRange('quarter_to_date', TODAY), { from: '2026-10-01', to: TODAY });
  assert.deepEqual(presetRange('quarter_to_date', '2026-05-09'), { from: '2026-04-01', to: '2026-05-09' });
  assert.deepEqual(presetRange('year_to_date', TODAY), { from: '2026-01-01', to: TODAY });
  assert.deepEqual(presetRange('last_12_months', TODAY), { from: '2025-10-22', to: TODAY });
});

test('addMonths keeps the day or uses the month end; 29 Feb becomes 28 Feb a year earlier', () => {
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonths('2028-02-29', -12), '2027-02-28');
});

test('defaults: 30 days, auto grain, previous period; query has no range or grain', () => {
  const p = read('');
  assert.equal(p.preset, 'last_30_days');
  assert.equal(p.days, 30);
  assert.equal(p.grain, 'day');
  assert.equal(p.grainChosen, false);
  assert.deepEqual(p.query, { preset: 'last_30_days', compare: 'previous_period' });
  assert.deepEqual(p.compareRange, { from: '2026-08-23', to: '2026-09-21' });
});

test('custom range is sent with its dates; an invalid one falls back to the default preset', () => {
  const ok = read('preset=custom&from=2026-09-01&to=2026-09-30&grain=week&compare=same_period_last_year');
  assert.deepEqual(ok.query, { preset: 'custom', range: { from: '2026-09-01', to: '2026-09-30' }, granularity: 'week', compare: 'same_period_last_year' });
  assert.deepEqual(ok.compareRange, { from: '2025-09-01', to: '2025-09-30' });
  assert.equal(read('preset=custom&from=2026-09-30&to=2026-09-01').preset, 'last_30_days');
  assert.equal(read('preset=custom&from=2026-10-01&to=2026-10-22').preset, 'last_30_days', 'future end');
  assert.equal(read('preset=custom&from=2025-01-01&to=2026-10-01').preset, 'last_30_days', 'more than 400 days');
  assert.equal(read('preset=nonsense', { preset: 'last_14_days' }).preset, 'last_14_days');
});

test('no day grain past 92 days; the automatic grain follows the backend', () => {
  const p = read('preset=last_12_months&grain=day');
  assert.equal(p.grainChosen, false);
  assert.equal(p.grain, 'month');
  assert.equal(p.query.granularity, undefined);
  assert.equal(autoGrain(31), 'day');
  assert.equal(autoGrain(32), 'week');
  assert.equal(autoGrain(93), 'month');
});

test('writePeriod leaves defaults out of the URL and keeps other parameters', () => {
  const params = new URLSearchParams('tab=earnings');
  const cur = readPeriod(params, TODAY);
  assert.equal(writePeriod(params, cur, { preset: 'last_7_days' }).toString(), 'tab=earnings&preset=last_7_days');
  assert.equal(writePeriod(params, cur, { preset: 'custom', range: { from: '2026-10-01', to: '2026-10-10' }, grain: 'week' }).toString(), 'tab=earnings&preset=custom&from=2026-10-01&to=2026-10-10&grain=week');
  assert.equal(writePeriod(params, cur, { compare: 'none' }).toString(), 'tab=earnings&compare=none');
});

test('range labels', () => {
  assert.equal(rangeLabel({ from: '2026-10-01', to: '2026-10-21' }), 'Oct 1 – Oct 21, 2026');
  assert.equal(rangeLabel({ from: '2025-12-01', to: '2026-01-05' }), 'Dec 1, 2025 – Jan 5, 2026');
  assert.equal(rangeLabel({ from: TODAY, to: TODAY }), 'Oct 21, 2026');
  assert.deepEqual(compareRange({ from: TODAY, to: TODAY }, 'none'), null);
});
