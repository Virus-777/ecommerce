/**
 * Wave 3: seller reply rounds per day and seller (replyStatsByDay), for reports' Response time and case backlog.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import { harness, SELLER, STORE, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

const shift = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('replyStatsByDay', () => {
  it('counts customer messages waiting for a reply and the seller replies, per day and seller', async () => {
    const sellerId = newId();
    h.sellers.set(sellerId, { storeName: 'Casa Verde Home' });
    const offerId = newId();
    h.liveOffers.set(offerId, { id: offerId, ownerType: 'seller', sellerId, sellerName: 'Casa Verde Home', productId: newId(), title: 'Linen duvet cover', status: 'active' });
    const me = tokens.customer(newId());
    const res = await h.call('POST', `${STORE}/product-conversations`, me, { offerId, body: 'Does it come in king size?' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    h.clock.advance(90 * 60_000); // the seller answers 90 minutes later
    const reply = await h.call('POST', `${SELLER}/conversations/${res.body.conversation.id}/messages`, tokens.seller(sellerId), { body: 'Yes, king size is in stock.' });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    // a second question waits for a reply
    await h.call('POST', `${STORE}/conversations/${res.body.conversation.id}/messages`, me, { body: 'And in teal?' });

    const day = dateInZone(h.clock.now(), h.service.core.tz);
    const rows = await h.service.replyStatsByDay({ from: shift(day, -1), to: shift(day, 1) }, sellerId);
    const total = rows.reduce((s, r) => ({ waiting: s.waiting + r.waiting, replied: s.replied + r.replied, minutes: s.minutes + r.replyMinutesTotal }), { waiting: 0, replied: 0, minutes: 0 });
    expect(total).toEqual({ waiting: 2, replied: 1, minutes: 90 });
    expect(rows.every((r) => r.sellerId === sellerId && r.targetHours > 0)).toBe(true);
    expect(rows.reduce((n, r) => n + r.repliedWithinTarget, 0)).toBe(1);
    expect((await h.service.replyStatsByDay({ from: shift(day, -1), to: shift(day, 1) })).some((r) => r.sellerId === sellerId)).toBe(true);
    await expect(h.service.replyStatsByDay({ from: day, to: shift(day, -1) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
