import { describe, expect, it } from 'vitest';
import { isPoBoxLine } from './address.js';

describe('address', () => {
  it('recognises mailbox lines the same way in every module', () => {
    for (const box of ['P.O. Box 12', 'PO Box 12', 'p o box 12', 'Post Office Box 9', 'POB 12', 'PMB 12', '410 Pine St PMB 7', 'Box 44']) expect(isPoBoxLine(box)).toBe(true);
    for (const street of ['410 Pine St', '12 Boxwood Ln', 'Suite 300', '', null]) expect(isPoBoxLine(street)).toBe(false);
  });
});
