/**
 * Fulfilled by Marketly: lines take who ships them, their profile and dispatch from the offer's effective
 * Offer.shipping; packages are keyed by owner + seller + fulfilledBy + ships-from, so one seller's Marketly-fulfilled
 * and self-shipped items are two packages, each quoted by shipping with its fulfilledBy. Migration 0004 backfills
 * cart_items.fulfilled_by.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { money } from '../../../kernel/lib/money.js';
import type * as shipping from '../../../spec/shipping.js';
import { m0004ItemFulfilledBy } from '../infra/postgres/migrations/0004_item_fulfilled_by.js';
import { boot, lineOf, STORE, type Kit } from './helpers.js';

let k: Kit;
const quoteCalls: shipping.PackageQuoteInput[] = [];

beforeAll(async () => {
  k = await boot({
    only: ['shipping'],
    apiStubs: {
      shipping: {
        quoteOptions: async (input) => {
          quoteCalls.push(input);
          const option: shipping.DeliveryOption = {
            id: `std:${input.fulfilledBy}`,
            methodCode: 'standard',
            methodName: 'Standard',
            price: money(input.fulfilledBy === 'marketly_service' ? 0 : 599),
            free: input.fulfilledBy === 'marketly_service',
            fundedBy: input.fulfilledBy === 'marketly_service' ? 'platform' : 'customer',
            freeReason: null,
            arrival: { from: '2026-10-14', to: '2026-10-15' },
            arrivalLabel: 'Arrives Wed, Oct 14 – Thu, Oct 15',
            dispatchBy: '2026-10-12T00:00:00Z',
            dispatchLabel: `Ships from ${input.shipsFrom}`,
            notices: [],
            isDefault: true,
          };
          return { shipsToLocation: true, notShippableLineIds: [], options: [option], default: option };
        },
      },
    },
  });
});
afterAll(async () => {
  await k?.app.close();
});

const repo = () => (k.service as any).deps.repo;
const itemsOf = async (sid: string) => {
  const cart = await k.service.activeCart({ owner: { kind: 'guest', guestSessionId: sid }, kind: 'guest', customerId: null, guestSessionId: sid, accountId: null });
  return (await repo().listItems(cart!.id)) as { id: string; offer_id: string; owner_type: string; fulfilled_by: string | null; ships_from: string }[];
};
const add = async (token: string, offerId: string) => {
  const r = await k.call('POST', `${STORE}/cart/items`, { token, body: { offerId, quantity: 1 } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
};

/** One seller selling a Marketly-fulfilled offer and a self-shipped one */
async function sellerWithBoth() {
  const p = await k.product({ variants: 2 });
  const sellerId = newId();
  const service = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 3000, sellerId, sellerName: 'Northwind Audio', service: true });
  const own = await k.offer({ productId: p.productId, variantId: p.variantIds[1]!, price: 2000, sellerId, sellerName: 'Northwind Audio', shipsFrom: 'Austin, TX' });
  return { sellerId, service, own };
}

describe('packages', () => {
  it("one seller's Marketly-fulfilled and self-shipped items are two packages, each quoted with its own fulfilledBy, profile and dispatch", async () => {
    const { sellerId, service, own } = await sellerWithBoth();
    const v = k.visitor();
    await add(v.token, service.id);
    await add(v.token, own.id);
    quoteCalls.length = 0;
    const view = (await k.call('GET', `${STORE}/cart?postalCode=97205`, { token: v.token })).body;

    expect(view.packageCount).toBe(2);
    const byFulfilment = Object.fromEntries(view.packages.map((p: any) => [p.fulfilledBy, p]));
    expect(byFulfilment.marketly_service).toMatchObject({
      key: `seller:${sellerId}:marketly_service:Reno, NV (Marketly warehouse)`,
      fulfilledBy: 'marketly_service',
      shipsFrom: 'Reno, NV (Marketly warehouse)',
      seller: { name: 'Northwind Audio', id: sellerId },
      delivery: { free: true },
    });
    expect(byFulfilment.marketly_service.items.map((i: any) => i.offerId)).toEqual([service.id]);
    expect(byFulfilment.seller).toMatchObject({ key: `seller:${sellerId}:seller:Austin, TX`, fulfilledBy: 'seller', shipsFrom: 'Austin, TX', seller: { name: 'Northwind Audio' } });
    expect(byFulfilment.seller.items.map((i: any) => i.offerId)).toEqual([own.id]);

    const serviceQuote = quoteCalls.find((q) => q.fulfilledBy === 'marketly_service')!;
    expect(serviceQuote).toMatchObject({ ownerType: 'seller', sellerId, shipsFrom: 'Reno, NV (Marketly warehouse)' });
    expect(serviceQuote.items).toEqual([expect.objectContaining({ profileId: k.serviceTerms.profileId, dispatch: { businessDays: 0, sameDayCutoff: '14:00', shipsFrom: 'Reno, NV (Marketly warehouse)' } })]);
    const ownQuote = quoteCalls.find((q) => q.fulfilledBy === 'seller')!;
    expect(ownQuote.items).toEqual([expect.objectContaining({ profileId: own.shippingProfileId, dispatch: { businessDays: 1, sameDayCutoff: null, shipsFrom: 'Austin, TX' } })]);

    // kept on the line
    const items = await itemsOf(v.sid);
    expect(Object.fromEntries(items.map((i) => [i.offer_id, [i.fulfilled_by, i.ships_from]]))).toEqual({ [service.id]: ['marketly_service', 'Reno, NV (Marketly warehouse)'], [own.id]: ['seller', 'Austin, TX'] });
  });

  it('Official Store lines are official_warehouse packages', async () => {
    const p = await k.product();
    const official = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 2500, official: true });
    const v = k.visitor();
    await add(v.token, official.id);
    const view = (await k.call('GET', `${STORE}/cart`, { token: v.token })).body;
    expect(view.packages[0]).toMatchObject({ key: 'official:official:official_warehouse:Reno, NV', fulfilledBy: 'official_warehouse' });
    expect((await itemsOf(v.sid))[0]!.fulfilled_by).toBe('official_warehouse');
  });

  it('checkout gets each line with its fulfilledBy and package key', async () => {
    const { service, own } = await sellerWithBoth();
    const v = k.visitor();
    await add(v.token, service.id);
    await add(v.token, own.id);
    const snap = await k.service.getCartForCheckout({ kind: 'guest', guestSessionId: v.sid });
    const byOffer = Object.fromEntries(snap.eligible.map((l) => [l.offerId, l]));
    expect(byOffer[service.id]).toMatchObject({ fulfilledBy: 'marketly_service', packageKey: expect.stringContaining(':marketly_service:') });
    expect(byOffer[own.id]).toMatchObject({ fulfilledBy: 'seller', packageKey: expect.stringContaining(':seller:Austin, TX') });
    expect(byOffer[service.id]!.packageKey).not.toBe(byOffer[own.id]!.packageKey);
  });

  it('an offer that moves onto the service moves to the Marketly package on the next check, and back when it leaves', async () => {
    const { service, own } = await sellerWithBoth();
    const v = k.visitor();
    await add(v.token, service.id);
    await add(v.token, own.id);
    // the seller's own offer is enrolled: offers flips fulfilledBy and bumps termsVersion
    k.change(own.id, k.shipping(k.world.offers.get(own.id)!, true));
    let view = (await k.call('GET', `${STORE}/cart`, { token: v.token })).body;
    expect(view.packageCount).toBe(1);
    expect(view.packages[0]).toMatchObject({ fulfilledBy: 'marketly_service' });
    expect(lineOf(view, own.id).notices.map((n: any) => n.kind)).toEqual(['terms_changed']);
    expect((await itemsOf(v.sid)).find((i) => i.offer_id === own.id)).toMatchObject({ fulfilled_by: 'marketly_service', ships_from: 'Reno, NV (Marketly warehouse)' });

    // the SKU leaves the service: the seller ships it again
    k.change(own.id, k.shipping(k.world.offers.get(own.id)!, false));
    view = (await k.call('GET', `${STORE}/cart`, { token: v.token })).body;
    expect(view.packages.map((p: any) => p.fulfilledBy).sort()).toEqual(['marketly_service', 'seller']);
    expect((await itemsOf(v.sid)).find((i) => i.offer_id === own.id)).toMatchObject({ fulfilled_by: 'seller', ships_from: 'Austin, TX' });
  });
});

describe('migration 0004', () => {
  it('adds fulfilled_by, backfilled from the owner (official_warehouse or seller), with its check', async () => {
    const p = await k.product({ variants: 2 });
    const official = await k.offer({ productId: p.productId, variantId: p.variantIds[0]!, price: 1000, official: true });
    const seller = await k.offer({ productId: p.productId, variantId: p.variantIds[1]!, price: 1000 });
    const v = k.visitor();
    await add(v.token, official.id);
    await add(v.token, seller.id);
    // old data: the column did not exist
    await k.app.kernel.database.exec('alter table cart.cart_items drop column fulfilled_by');
    await k.app.kernel.database.exec(m0004ItemFulfilledBy.sql);
    const items = await itemsOf(v.sid);
    expect(Object.fromEntries(items.map((i) => [i.offer_id, i.fulfilled_by]))).toEqual({ [official.id]: 'official_warehouse', [seller.id]: 'seller' });
    await expect(repo().updateItem(items[0]!.id, { fulfilled_by: 'drone' })).rejects.toThrow();
  });
});
