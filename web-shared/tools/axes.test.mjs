// Tests of the chart axis helpers (src/ui/charts/axes.ts): the label column of horizontal bars, middle cuts of
// long names, and the value axis for zeros and small counts.
//   npm test -w @marketly/web-shared
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allZero, cutMiddle, labelColumn, valueAxis } from '../src/ui/charts/axes.ts';

test('cutMiddle keeps the start and the end of a long name', () => {
  assert.equal(cutMiddle('Rose City Audio GZ0O99-2', 18), 'Rose Cit…GZ0O99-2');
  assert.equal(cutMiddle('Short', 18), 'Short');
  assert.equal(cutMiddle('Electronics › Speakers › Bluetooth', 20).length <= 20, true);
  assert.match(cutMiddle('Electronics › Speakers › Bluetooth', 20), /^Electroni….*Bluetooth$/);
});

test('the label column fits short names, takes at most 40% of the chart and cuts the rest', () => {
  const px = (t) => t.length * 6; // a fixed-width stand-in for the canvas measure
  const short = labelColumn(['Food', 'Toys'], 600, px);
  assert.equal(short.width, 40); // the minimum
  assert.equal(short.fit('Food'), 'Food');
  const long = labelColumn(['Rose City Audio Gear Company GZ0O99-2', 'Toys'], 500, px);
  assert.equal(long.width, 200);
  const cut = long.fit('Rose City Audio Gear Company GZ0O99-2');
  assert.ok(px(cut) <= 200 - 16, cut);
  assert.match(cut, /^Rose City.*….*GZ0O99-2$/);
  // not measured yet: assumes a 400 px chart
  assert.equal(labelColumn(['x'.repeat(80)], 0, px).width, 160);
});

test('valueAxis: one 0 tick for zeros, whole and fewer ticks for small counts', () => {
  const fmt = (v) => String(v);
  assert.deepEqual(valueAxis([{ a: 0 }, { a: 0 }], ['a'], fmt), { tickFormatter: fmt, domain: [0, 1], ticks: [0] });
  assert.deepEqual(valueAxis([{ a: 0 }, { a: 1 }], ['a'], fmt, { whole: true }), { tickFormatter: fmt, allowDecimals: false, tickCount: 2 });
  assert.deepEqual(valueAxis([{ a: 2, b: 1 }], ['a', 'b'], fmt, { whole: true, stacked: true }), { tickFormatter: fmt, allowDecimals: false, tickCount: 4 });
  assert.deepEqual(valueAxis([{ a: 40 }], ['a'], fmt, { whole: true }), { tickFormatter: fmt, allowDecimals: false });
  assert.deepEqual(valueAxis([{ a: 0.4 }], ['a'], fmt), { tickFormatter: fmt });
});

test('allZero looks at every key and its comparison twin', () => {
  assert.equal(allZero([{ a: 0 }, { a: null }], ['a']), true);
  assert.equal(allZero([{ a: 0, 'a:compare': 5 }], ['a']), false);
  assert.equal(allZero([{ a: 0, b: -1 }], ['a', 'b']), false);
  assert.equal(allZero([], ['a']), true);
});
