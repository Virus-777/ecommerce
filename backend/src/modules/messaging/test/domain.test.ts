import { describe, expect, it } from 'vitest';
import { buyerName, deadline, duration, maskContent, promotionalPhrase, replyRounds, responseTimeLabel } from '../domain/rules.js';

describe('content filter', () => {
  it('masks emails, phone numbers and outside links but keeps references, prices and Marketly links', () => {
    const r = maskContent('Order MK-261009-00012 ($89.00): text +1 503-555-0142 or mail a.b@shop.io, see www.mystore.com or https://marketly.com/help', ['marketly.com']);
    expect(r.body).toBe('Order MK-261009-00012 ($89.00): text [contact details hidden] or mail [contact details hidden], see [link hidden] or https://marketly.com/help');
    expect(r.redactions).toEqual(['contact_details', 'link']);
    expect(maskContent('Tracking 1Z999AA10123456784 arrives Friday', []).redactions).toEqual([]);
    expect(maskContent('Call 5035550142', []).body).toBe('Call [contact details hidden]');
    expect(maskContent('visit casa-verde.shop/sale', []).body).toBe('visit [link hidden]');
  });

  it('spots promotional phrases', () => {
    expect(promotionalPhrase('Use code FALL10 next time')).toBeTruthy();
    expect(promotionalPhrase('Enjoy 20% off our new range')).toBeTruthy();
    expect(promotionalPhrase('Sorry for the delay, I refunded 20% of the price')).toBeNull();
    expect(promotionalPhrase('Your order ships tomorrow')).toBeNull();
  });
});

describe('reply rounds and labels', () => {
  it('pairs the first unanswered customer message with the next seller reply', () => {
    const at = (h: number) => new Date(Date.UTC(2026, 9, 9, h));
    const rounds = replyRounds([
      { conversation_id: 'a', author_kind: 'customer', at: at(1) },
      { conversation_id: 'a', author_kind: 'customer', at: at(2) },
      { conversation_id: 'a', author_kind: 'seller', at: at(5) },
      { conversation_id: 'a', author_kind: 'seller', at: at(6) },
      { conversation_id: 'b', author_kind: 'customer', at: at(7) },
      { conversation_id: 'a', author_kind: 'staff', at: at(8) },
    ]);
    expect(rounds).toEqual([
      { conversationId: 'a', start: at(1), reply: at(5) },
      { conversationId: 'b', start: at(7), reply: null },
    ]);
  });

  it('formats durations, deadlines and labels', () => {
    expect(duration(30 * 60_000)).toBe('30 min');
    expect(duration(95 * 60_000)).toBe('1 h 35 min');
    expect(duration(26 * 3_600_000)).toBe('1 d 2 h');
    const now = new Date('2026-10-09T10:00:00Z');
    expect(deadline(new Date('2026-10-09T11:00:00Z'), now)?.state).toBe('due_soon');
    expect(deadline(new Date('2026-10-10T11:00:00Z'), now)?.state).toBe('on_time');
    expect(deadline(new Date('2026-10-09T09:00:00Z'), now)?.state).toBe('overdue');
    expect(responseTimeLabel(240)).toBe('Usually replies within 4 hours');
    expect(responseTimeLabel(null)).toBeNull();
    expect(buyerName('Sam Rivera')).toBe('Sam R.');
    expect(buyerName('')).toBe('Buyer');
  });
});
