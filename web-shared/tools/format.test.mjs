// Tests of the money format (src/lib/format.ts): report tables, tiles and charts all show a negative amount as
// "−$213.30" (minus sign first), never "$-213.30".
//   npm test -w @marketly/web-shared
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, money } from '../src/lib/format.ts';

test('money: dollars with two decimals and thousands separators', () => {
  assert.equal(money(1234.5), '$1,234.50');
  assert.equal(money(0), '$0.00');
});

test('money: a negative amount gets the minus sign before the dollar', () => {
  assert.equal(money(-213.3), '−$213.30');
  assert.equal(money(-1111.17), '−$1,111.17');
  assert.equal(formatMoney({ amount: -21330, currency: 'USD' }), '−$213.30');
});

test('money: an amount that rounds to zero has no sign', () => {
  assert.equal(money(-0.001), '$0.00');
  assert.equal(money(-0), '$0.00');
});
