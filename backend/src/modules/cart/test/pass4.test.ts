/**
 * Gap pass 4: cart_items.condition (kept at add, filled on the next check for older lines, used to decide
 * condition-scoped seller restrictions on the line), and the empty view has no cart id.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { boot, STORE, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const repo = () => (k.service as any).deps.repo;
const itemsOf = async (sid: string) => {
  const cart = await k.service.activeCart({ owner: { kind: 'guest', guestSessionId: sid }, kind: 'guest', customerId: null, guestSessionId: sid, accountId: null });
  return (await repo().listItems(cart!.id)) as { id: string; offer_id: string; condition: string | null }[];
};
const add = (token: string, offerId: string) => k.call('POST', `${STORE}/cart/items`, { token, body: { offerId, quantity: 1 } });

describe('cart_items.condition', () => {
  it('keeps the offer condition on the line and fills lines added before it was kept on their next check', async () => {
    const p = await k.product({ variants: 2 });
    const used = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 5000, condition: 'used_good' });
    const fresh = await k.offer({ productId: p.productId, variantId: p.variantIds[1]!, price: 7000 });
    const v = k.visitor();
    expect((await add(v.token, used.id)).status).toBe(201);
    expect((await add(v.token, fresh.id)).status).toBe(201);
    const items = await itemsOf(v.sid);
    expect(Object.fromEntries(items.map((i) => [i.offer_id, i.condition]))).toEqual({ [used.id]: 'used_good', [fresh.id]: 'new' });

    // a line from before the column: null until its next check
    await repo().updateItem(items[0]!.id, { condition: null });
    expect((await k.call('GET', `${STORE}/cart`, { token: v.token })).status).toBe(200);
    expect((await itemsOf(v.sid)).find((i) => i.id === items[0]!.id)!.condition).toBe(items[0]!.condition);
  });

  it('decides a condition-scoped restriction on the line: only matching lines get seller_unavailable', async () => {
    const sellerId = newId();
    const p = await k.product({ variants: 3 });
    const a = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 5000, sellerId, sellerName: 'Harbor Goods', condition: 'used_like_new' });
    const b = await k.offer({ productId: p.productId, variantId: p.variantIds[1]!, price: 9000, sellerId, sellerName: 'Harbor Goods', condition: 'new' });
    const c = await k.offer({ productId: p.productId, variantId: p.variantIds[2]!, price: 8000, sellerId, sellerName: 'Harbor Goods', condition: 'refurbished' });
    const v = k.visitor();
    for (const o of [a, b, c]) expect((await add(v.token, o.id)).status).toBe(201);
    await k.publish('sellers', 'sellers.seller.restricted', { sellerId, restrictionId: newId(), reasonCode: 'performance', reason: 'Used items under review', affectedActivities: ['sales'], scope: { conditions: ['used', 'refurbished'] }, categoryIds: [], appealRoute: 'x', appealDeadline: '2026-11-01T00:00:00Z', reviewDate: '2026-11-01' });
    const items = await itemsOf(v.sid);
    const notices = (await repo().listNotices(items.map((i) => i.id))) as { item_id: string; kind: string; resolved_at: Date | null }[];
    const flagged = notices.filter((n) => !n.resolved_at && n.kind === 'seller_unavailable').map((n) => items.find((i) => i.id === n.item_id)!.offer_id).sort();
    expect(flagged).toEqual([a.id, c.id].sort());
  });

  it('the empty view has no cart id', async () => {
    const res = await k.call('GET', `${STORE}/cart`, { token: k.visitor().token });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeNull();
  });
});

describe('cart_items.condition', () => {
  it('takes only the spec values', async () => {
    const p = await k.product();
    const o = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 1000 });
    const v = k.visitor();
    await add(v.token, o.id);
    const [item] = await itemsOf(v.sid);
    expect(item!.condition).toBe('new');
    await expect(repo().updateItem(item!.id, { condition: 'mint' })).rejects.toThrow();
  });
});
