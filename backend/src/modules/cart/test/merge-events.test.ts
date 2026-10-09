import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, boot, lineOf, linesOf, STORE, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const add = async (token: string, offerId: string, quantity = 1) => {
  const r = await k.call('POST', `${STORE}/cart/items`, { token, body: { offerId, quantity } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};

describe('merging the guest cart on sign-in', () => {
  it('combines the same offer up to the limit, keeps another offer for the same variant, drops unavailable lines', async () => {
    const p1 = await k.product();
    const p2 = await k.product({ title: 'Wool Throw' });
    const p3 = await k.product({ title: 'Desk Lamp' });
    const p4 = await k.product({ title: 'Mug' });
    const limited = await k.offer({ productId: p1.productId, variantId: p1.variantIds[0]!, price: 1000, purchaseLimit: 3 });
    const guestOffer = await k.offer({ productId: p2.productId, variantId: p2.variantIds[0]!, price: 2000, sellerName: 'Harbor Goods' });
    const customerOffer = await k.offer({ productId: p2.productId, variantId: p2.variantIds[0]!, price: 2100, sellerName: 'Cedar & Co' });
    const doomed = await k.offer({ productId: p3.productId, variantId: p3.variantIds[0]!, price: 3000 });
    const plain = await k.offer({ productId: p4.productId, variantId: p4.variantIds[0]!, price: 500 });

    const guest = k.visitor();
    await add(guest.token, limited.id, 2);
    await add(guest.token, guestOffer.id);
    await add(guest.token, doomed.id);
    await add(guest.token, plain.id, 2);
    await k.call('PUT', `${STORE}/cart/destination`, { token: guest.token, body: { postalCode: '97205' } });
    const c = k.customer();
    await add(c.token, limited.id, 2);
    await add(c.token, customerOffer.id);
    k.change(doomed.id, { status: 'removed' });

    const res = await k.call('POST', `${STORE}/cart/merge`, { token: c.token, body: { guestSessionId: guest.sid } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byOffer = Object.fromEntries(res.body.report.lines.map((l: any) => [l.offerId, l]));
    expect(byOffer[limited.id]).toMatchObject({ outcome: 'capped_at_limit', title: 'Linen Duvet Cover' });
    expect(byOffer[guestOffer.id]).toMatchObject({ outcome: 'kept_separate_offer', title: 'Wool Throw' });
    expect(byOffer[doomed.id]).toMatchObject({ outcome: 'dropped_unavailable', itemId: null });
    expect(byOffer[plain.id]).toMatchObject({ outcome: 'added' });
    expect(res.body.report.message).toBe('We added 3 items from before you signed in. 1 item is no longer available.');
    const view = res.body.cart;
    expect(lineOf(view, limited.id).quantity).toBe(3);
    expect(lineOf(view, guestOffer.id)).toBeDefined();
    expect(lineOf(view, customerOffer.id)).toBeDefined();
    expect(lineOf(view, plain.id).quantity).toBe(2);
    expect(lineOf(view, doomed.id)).toBeUndefined();
    expect(view.destination).toMatchObject({ postalCode: '97205' });
    expect(k.of('cart.cart.merged').at(-1)).toMatchObject({ intoCartId: view.id, customerId: c.accountId, lines: 3 });

    // idempotent by guest cart; nobody else can take it
    const again = await k.call('POST', `${STORE}/cart/merge`, { token: c.token, body: { guestSessionId: guest.sid } });
    expect(again.body.report).toEqual(res.body.report);
    expect(linesOf(again.body.cart)).toHaveLength(4);
    expect((await k.call('POST', `${STORE}/cart/merge`, { token: k.customer().token, body: { guestSessionId: guest.sid } })).status).toBe(404);
    expect((await k.call('POST', `${STORE}/cart/merge`, { token: c.token, body: { guestSessionId: newId() } })).status).toBe(404);
    // the guest session now has no active cart
    expect((await k.call('GET', `${STORE}/cart`, { token: guest.token })).body.itemCount).toBe(0);
    // support sees the merge history on both carts
    const list = await k.call('GET', `${ADMIN}/carts?guestSessionId=${guest.sid}`, { token: k.staff(['cart.carts.view']) });
    expect(list.body.items).toMatchObject([{ status: 'merged', owner: { kind: 'guest', guestSessionId: guest.sid } }]);
    const detail = await k.call('GET', `${ADMIN}/carts/${view.id}`, { token: k.staff(['cart.carts.view']) });
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.merges).toHaveLength(1);
    expect(detail.body.summary).toMatchObject({ id: view.id, status: 'active', owner: { kind: 'customer', customerId: c.accountId }, itemCount: 7 });
  });

  it('merges on identity.guest_session.claimed (sign-in on any client), once', async () => {
    const p = await k.product();
    const offer = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 1500 });
    const guest = k.visitor();
    await add(guest.token, offer.id, 2);
    const c = k.customer();
    await k.publish('identity', 'identity.guest_session.claimed', { guestSessionId: guest.sid, accountId: c.accountId });
    await k.publish('identity', 'identity.guest_session.claimed', { guestSessionId: guest.sid, accountId: c.accountId });
    const view = (await k.call('GET', `${STORE}/cart`, { token: c.token })).body;
    expect(lineOf(view, offer.id).quantity).toBe(2);
    expect(k.of('cart.cart.merged').filter((e) => e.customerId === c.accountId)).toHaveLength(1);
    // an unknown guest session is ignored
    await k.publish('identity', 'identity.guest_session.claimed', { guestSessionId: newId(), accountId: c.accountId });
  });
});

describe('events from other modules and jobs', () => {
  it('an ended offer is flagged at once and confirmed by the recheck job', async () => {
    const p = await k.product();
    const offer = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 1000 });
    const v = k.visitor();
    await add(v.token, offer.id);
    k.change(offer.id, { status: 'removed' });
    await k.publish('offers', 'offers.offer.status_changed', { offerId: offer.id, productId: p.productId, variantId: p.variantIds[0], sellerId: offer.sellerId, ownerType: 'seller', from: 'active', to: 'removed', reasonCode: 'ended_by_seller', reason: 'Ended' });
    expect((await k.call('GET', `${STORE}/cart/badge`, { token: v.token })).body.attentionCount).toBe(1);
    await k.app.kernel.jobs.runNow('cart.recheck-queued');
    const view = (await k.call('GET', `${STORE}/cart`, { token: v.token })).body;
    expect(lineOf(view, offer.id).notices.map((n: any) => n.kind)).toEqual(['offer_ended']);
  });

  it('stock and price events queue lines; the job refreshes their notices before the next read', async () => {
    const p = await k.product();
    const offer = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 1000 });
    const v = k.visitor();
    await add(v.token, offer.id, 2);
    await k.stock(offer.id, 1); // inventory publishes inventory.stock.changed for real
    expect((await k.call('GET', `${STORE}/cart/badge`, { token: v.token })).body.attentionCount).toBe(0);
    await k.app.kernel.jobs.runNow('cart.recheck-queued');
    expect((await k.call('GET', `${STORE}/cart/badge`, { token: v.token })).body.attentionCount).toBe(1);

    k.change(offer.id, { price: { amount: 1200, currency: 'USD' } });
    await k.publish('offers', 'offers.offer.price_changed', { offerId: offer.id, productId: p.productId, variantId: p.variantIds[0], sellerId: offer.sellerId, ownerType: 'seller', from: { amount: 1000, currency: 'USD' }, to: { amount: 1200, currency: 'USD' }, termsVersion: 3 });
    await k.app.kernel.jobs.runNow('cart.recheck-queued');
    const view = (await k.call('GET', `${STORE}/cart`, { token: v.token })).body;
    expect(lineOf(view, offer.id).notices.map((n: any) => n.kind).sort()).toEqual(['price_increased', 'quantity_reduced']);
  });

  it('seller suspensions and restrictions, and hidden products, flag their lines without switching sellers', async () => {
    const p = await k.product();
    const sellerId = newId();
    const a = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 1000, sellerId });
    const p2 = await k.product();
    const b = await k.offer({ productId: p2.productId, variantId: p2.variantIds[0]!, price: 1000, sellerName: 'Harbor Goods' });
    const v = k.visitor();
    await add(v.token, a.id);
    await add(v.token, b.id);
    await k.publish('sellers', 'sellers.seller.suspended', { sellerId, suspensionId: newId(), reasonCode: 'fraud', reason: 'Under review', reviewDate: '2026-11-01', openOrders: 'seller_keeps_fulfilling', appealDeadline: '2026-11-01T00:00:00Z' });
    await k.publish('catalog', 'catalog.product.publication_changed', { productId: p2.productId, from: 'active', to: 'hidden', reason: 'Report' });
    const notices = async () => {
      const cart = await k.service.activeCart({ owner: { kind: 'guest', guestSessionId: v.sid }, kind: 'guest', customerId: null, guestSessionId: v.sid, accountId: null });
      const items = await (k.service as any).deps.repo.listItems(cart!.id);
      const rows = await (k.service as any).deps.repo.listNotices(items.map((i: any) => i.id));
      return rows.filter((n: any) => !n.resolved_at).map((n: any) => `${items.find((i: any) => i.id === n.item_id).offer_id === a.id ? 'a' : 'b'}:${n.kind}`).sort();
    };
    expect(await notices()).toEqual(['a:seller_unavailable', 'b:product_unavailable']);
    // a restriction that does not stop sales changes nothing
    await k.publish('sellers', 'sellers.seller.restricted', { sellerId: newId(), restrictionId: newId(), reasonCode: 'x', reason: 'x', affectedActivities: ['advertising'], scope: {}, categoryIds: [], appealRoute: 'x', appealDeadline: '2026-11-01T00:00:00Z', reviewDate: '2026-11-01' });
    expect(await notices()).toEqual(['a:seller_unavailable', 'b:product_unavailable']);
  });

  it('expires idle carts and publishes cart.cart.expired', async () => {
    const p = await k.product();
    const offer = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 1000 });
    const v = k.visitor();
    const cart = await add(v.token, offer.id, 2);
    // 29 days idle: kept
    k.clock.advance(29 * 86_400_000);
    await k.service.expireIdle();
    expect(await k.service.getCartView({ kind: 'guest', guestSessionId: v.sid })).not.toBeNull();
    k.clock.advance(-29 * 86_400_000);
    // the read above restarted the idle clock; 31 days after it the cart expires
    k.clock.advance(60 * 86_400_000);
    await k.service.expireIdle();
    await k.drain();
    k.clock.advance(-60 * 86_400_000);
    expect(k.of('cart.cart.expired').find((e) => e.cartId === cart.cart.id)).toEqual({ cartId: cart.cart.id, ownerKind: 'guest', itemCount: 2 });
    expect(await k.service.getCartView({ kind: 'guest', guestSessionId: v.sid })).toBeNull();
    expect((await k.call('GET', `${STORE}/cart`, { token: v.token })).body.itemCount).toBe(0);
    const detail = await k.call('GET', `${ADMIN}/carts/${cart.cart.id}`, { token: k.staff(['cart.carts.view']) });
    expect(detail.body.summary.status).toBe('expired');
  });
});
