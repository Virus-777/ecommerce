/**
 * Wave 3: cases per day, seller and category with first-reply figures (caseStatsByDay), for reports'
 * Complaint patterns and Response time and case backlog.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { harness, reportProblem, sellerOrder, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const today = () => dateInZone(h.service.core.now(), h.service.core.tz);
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('caseStatsByDay', () => {
  it('counts cases by day, seller and category with the seller reply', async () => {
    const o = await sellerOrder(h);
    const opened = await reportProblem(h, { customerId: o.customerId!, orderId: o.order.id, itemIds: [o.itemId] });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const reply = await h.call('POST', `/api/seller/support/cases/${opened.body.id}/messages`, tokens.seller(o.sellerId), { body: 'Sorry, a new one is on its way' });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);

    const range = { from: shift(today(), -1), to: shift(today(), 1) };
    const rows = await h.service.caseStatsByDay(range, o.sellerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sellerId: o.sellerId, categoryKey: 'item_damaged', audience: 'customer', opened: 1, sellerReplied: 1 });
    expect(rows[0]!.categoryLabel).not.toBe('item_damaged');
    expect(rows[0]!.sellerReplyMinutesTotal).toBeGreaterThanOrEqual(0);
    expect(rows[0]!.firstReplied).toBeLessThanOrEqual(1);
    // every seller: this seller's row is among them
    expect((await h.service.caseStatsByDay(range)).some((r) => r.sellerId === o.sellerId)).toBe(true);
    // a range before the case has none
    expect(await h.service.caseStatsByDay({ from: shift(today(), -10), to: shift(today(), -5) }, o.sellerId)).toEqual([]);
    await expect(h.service.caseStatsByDay({ from: today(), to: shift(today(), -1) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
