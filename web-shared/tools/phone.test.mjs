// Tests of the phone number input mask (src/lib/phone.ts), the same cases as the Android app's PhoneMaskTest.
// Node runs the TypeScript file directly (type stripping, Node 23.6+).
//   npm test -w @marketly/web-shared        (or: node --test web-shared/tools/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPhone, phoneEdit, phoneExample } from '../src/lib/phone.ts';

const US = '(###) ###-####';
const PLUS1 = '+1 ###-###-####';

test('formats as the digits come, literals only once a digit follows', () => {
  assert.equal(formatPhone('', US), '');
  assert.equal(formatPhone('5', US), '(5');
  assert.equal(formatPhone('503', US), '(503');
  assert.equal(formatPhone('5035', US), '(503) 5');
  assert.equal(formatPhone('5035550142', US), '(503) 555-0142');
  assert.equal(formatPhone('(503) 555-0142', US), '(503) 555-0142');
  assert.equal(formatPhone('503.555.0142', US), '(503) 555-0142');
});

test('international and over-long numbers stay as typed', () => {
  assert.equal(formatPhone('+44 20 7946 0958', US), '+44 20 7946 0958');
  assert.equal(formatPhone('15035550142', US), '15035550142');
  assert.equal(formatPhone('+15035550142', US), '+15035550142');
});

test('a pattern with a prefix does not count its own digits', () => {
  assert.equal(formatPhone('5035550142', PLUS1), '+1 503-555-0142');
  assert.equal(formatPhone('+1 50', PLUS1), '+1 50');
  assert.equal(formatPhone('+1 503-555-0142', PLUS1), '+1 503-555-0142');
});

test('the placeholder example follows the pattern and is itself a formatted number', () => {
  assert.equal(phoneExample(US), '(201) 555-0123');
  assert.equal(phoneExample(PLUS1), '+1 201-555-0123');
  assert.equal(formatPhone(phoneExample(US), US), phoneExample(US));
});

test('a pattern without # leaves the text alone', () => {
  assert.equal(formatPhone('5035550142', 'phone'), '5035550142');
});

test('typing keeps the caret after the same digit', () => {
  // "(503) 5|" + "5" typed at the end
  assert.deepEqual(phoneEdit('(503) 5', '(503) 55', 8, US), { value: '(503) 55', caret: 8 });
  // "9" typed after "(50" in "(503) 5": the digits shift, the caret follows the 9
  assert.deepEqual(phoneEdit('(503) 5', '(5093) 5', 4, US), { value: '(509) 35', caret: 4 });
});

test('backspace over a literal removes the digit before it', () => {
  // caret after ") " in "(503) 5": backspace removes the space; the 3 goes with it
  assert.deepEqual(phoneEdit('(503) 5', '(503)5', 5, US), { value: '(505', caret: 3 });
  // a plain digit backspace
  assert.deepEqual(phoneEdit('(503) 55', '(503) 5', 7, US), { value: '(503) 5', caret: 7 });
});
