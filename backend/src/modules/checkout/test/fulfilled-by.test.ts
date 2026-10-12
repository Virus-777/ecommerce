/**
 * Fulfilled by Marketly: every line takes fulfilledBy, its profile and dispatch from the offer's effective
 * Offer.shipping; packages are keyed owner + seller + fulfilledBy + ships-from (like the cart), so one seller's
 * Marketly-fulfilled and self-shipped items are two packages with their own options; shipping.quoteOptions gets the
 * package's fulfilledBy; createOrder gets each group's fulfilledBy and shipsFrom from the package; revalidation turns a
 * fulfilment flip into a terms_changed change.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STORE, fillCart, key, placeBody, readyCheckout, world, type World } from './helpers.js';

let w: World;

beforeAll(async () => {
  // orders checks marketly_service groups with fulfillment-service.isServiceOffer
  w = await world({ fulfillment: true });
  // the seller's black headphones are stored and shipped by Marketly; the white ones the seller ships
  await w.marketly.enroll(w.offers.black);
}, 180_000);
afterAll(async () => {
  await w?.app.close();
});

const MARKETLY = 'Reno, NV (Marketly warehouse)';
const rows = async (sessionId: string) => {
  const repo = w.service.core.repo;
  const [lines, packages] = await Promise.all([repo.listLines(sessionId), repo.listPackages(sessionId)]);
  return { lines, packages };
};
const groupsOf = async (orderId: string) => (await w.api('orders').getOrder(orderId))!.groups as { fulfilledBy: string; shipsFrom: string; items: { offer: { offerId: string } }[] }[];

describe('packages and quotes', () => {
  it("one seller's Marketly-fulfilled and self-shipped items are two packages with their own options, and two order groups", async () => {
    const ana = await w.customer('ana-fbm@example.com');
    await fillCart(w, ana.token, [
      { offerId: w.offers.black, quantity: 1 },
      { offerId: w.offers.white, quantity: 2 },
    ]);
    w.ship.knobs.quotes.length = 0;
    const v = await readyCheckout(w, ana.token, { source: 'cart' });

    expect(v.packages).toHaveLength(2);
    const service = v.packages.find((p: any) => p.fulfilledBy === 'marketly_service');
    const own = v.packages.find((p: any) => p.fulfilledBy === 'seller');
    expect(service).toMatchObject({ key: `seller:${w.sellerId}:marketly_service:${MARKETLY}`, soldAndShippedBy: 'Sold by Northwind Audio · Shipped by Marketly', shipsFrom: MARKETLY, seller: { name: 'Northwind Audio' } });
    expect(service.lines.map((l: any) => l.offerId)).toEqual([w.offers.black]);
    expect(service.options.map((o: any) => o.methodCode)).toEqual(['standard', 'express']);
    expect(own).toMatchObject({ fulfilledBy: 'seller', soldAndShippedBy: 'Sold and shipped by Northwind Audio' });
    expect(own.lines.map((l: any) => l.offerId)).toEqual([w.offers.white]);
    expect(own.shipsFrom).not.toBe(MARKETLY);

    // each package is quoted with its fulfilledBy, and Marketly's profile and dispatch for the service package
    const serviceQuote = w.ship.knobs.quotes.findLast((q) => q.fulfilledBy === 'marketly_service')!;
    expect(serviceQuote).toMatchObject({ ownerType: 'seller', sellerId: w.sellerId, shipsFrom: MARKETLY });
    expect(serviceQuote.items).toEqual([expect.objectContaining({ profileId: w.marketly.terms.profileId, dispatch: { businessDays: 0, sameDayCutoff: '14:00', shipsFrom: MARKETLY } })]);
    const ownQuote = w.ship.knobs.quotes.findLast((q) => q.fulfilledBy === 'seller')!;
    expect(ownQuote.items[0]!.profileId).not.toBe(w.marketly.terms.profileId);

    const stored = await rows(v.id);
    expect(Object.fromEntries(stored.lines.map((l) => [l.offer_id, [l.fulfilled_by, l.profile_id]]))).toEqual({
      [w.offers.black]: ['marketly_service', w.marketly.terms.profileId],
      [w.offers.white]: ['seller', ownQuote.items[0]!.profileId],
    });
    expect(stored.packages.map((p) => p.fulfilled_by).sort()).toEqual(['marketly_service', 'seller']);

    // the placed order has a marketly_service group and a seller group
    const placed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, ana.token, placeBody(v), { 'idempotency-key': key() });
    expect(placed.body.outcome, JSON.stringify(placed.body)).toBe('accepted');
    const groups = await groupsOf(placed.body.orderId);
    expect(groups.map((g) => [g.fulfilledBy, g.shipsFrom, g.items.map((i) => i.offer.offerId)]).sort()).toEqual(
      [
        ['marketly_service', MARKETLY, [w.offers.black]],
        ['seller', own.shipsFrom, [w.offers.white]],
      ].sort(),
    );
    const event = w.named('orders.order.placed').find((e) => e.orderId === placed.body.orderId);
    expect(event.groups.map((g: any) => g.fulfilledBy).sort()).toEqual(['marketly_service', 'seller']);

    // the confirmation names Marketly as the shipper of that package
    const conf = await w.call('GET', `${STORE}/sessions/${v.id}/confirmation`, ana.token);
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    const confPkg = conf.body.packages.find((p: any) => p.shipsFrom === MARKETLY);
    expect(confPkg.shippingLabel).toContain('Sold by Northwind Audio · Shipped by Marketly');
    expect(conf.body.packages.find((p: any) => p.shipsFrom !== MARKETLY).shippingLabel).not.toContain('Marketly');
  });

  it('Buy now of a Marketly-fulfilled offer is one marketly_service package; Official Store items stay official_warehouse', async () => {
    const ben = await w.customer('ben-fbm@example.com');
    const v = await readyCheckout(w, ben.token, { source: 'buy_now', offerId: w.offers.black, quantity: 1 });
    expect(v.packages.map((p: any) => [p.fulfilledBy, p.shipsFrom])).toEqual([['marketly_service', MARKETLY]]);

    const official = await readyCheckout(w, ben.token, { source: 'buy_now', offerId: w.offers.officialWhite, quantity: 1 });
    expect(official.packages[0]).toMatchObject({ fulfilledBy: 'official_warehouse', key: expect.stringMatching(/^official:official:official_warehouse:/) });
    expect(w.ship.knobs.quotes.at(-1)).toMatchObject({ ownerType: 'official', fulfilledBy: 'official_warehouse' });
  });
});

describe('revalidation', () => {
  it('a fulfilment flip between quote and place is a terms_changed change; accepting moves the line to the Marketly package', async () => {
    const cy = await w.customer('cy-fbm@example.com');
    const v = await readyCheckout(w, cy.token, { source: 'buy_now', offerId: w.offers.white, quantity: 1 });
    expect(v.packages.map((p: any) => p.fulfilledBy)).toEqual(['seller']);

    // Marketly starts fulfilling the white headphones
    await w.marketly.enroll(w.offers.white);
    try {
      const placed = await w.call('POST', `${STORE}/sessions/${v.id}/place`, cy.token, placeBody(v), { 'idempotency-key': key() });
      expect(placed.body.outcome, JSON.stringify(placed.body)).toBe('changes_required');
      const cs = placed.body.changeSet;
      expect(cs.changes).toEqual([
        expect.objectContaining({ kind: 'terms_changed', previous: 'Shipped by the seller', current: 'Shipped by Marketly', defaultChoice: 'accept', detail: expect.stringContaining('Marketly now ships this item') }),
      ]);

      const ok = await w.call('POST', `${STORE}/sessions/${v.id}/changes/${cs.id}/accept`, cy.token, { decisions: cs.changes.map((c: any) => ({ changeId: c.id, choice: 'accept' })), acceptPartialOrder: false });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.packages).toEqual([expect.objectContaining({ fulfilledBy: 'marketly_service', shipsFrom: MARKETLY, soldAndShippedBy: 'Sold by Northwind Audio · Shipped by Marketly', selectedOptionId: expect.any(String) })]);
      const stored = await rows(v.id);
      expect(stored.lines.find((l) => l.status === 'included')).toMatchObject({ fulfilled_by: 'marketly_service', profile_id: w.marketly.terms.profileId, package_key: `seller:${w.sellerId}:marketly_service:${MARKETLY}` });
      expect(stored.packages).toEqual([expect.objectContaining({ fulfilled_by: 'marketly_service', ships_from: MARKETLY })]);

      const again = await w.call('POST', `${STORE}/sessions/${v.id}/place`, cy.token, placeBody(ok.body), { 'idempotency-key': key() });
      expect(again.body.outcome, JSON.stringify(again.body)).toBe('accepted');
      expect((await groupsOf(again.body.orderId)).map((g) => g.fulfilledBy)).toEqual(['marketly_service']);
    } finally {
      await w.marketly.leave(w.offers.white);
    }
  });

  it('removing the flipped line instead leaves the rest of the order with its own packages', async () => {
    const dee = await w.customer('dee-fbm@example.com');
    await fillCart(w, dee.token, [
      { offerId: w.offers.white, quantity: 1 },
      { offerId: w.offers.officialWhite, quantity: 1 },
    ]);
    const v = await readyCheckout(w, dee.token, { source: 'cart' });
    await w.marketly.enroll(w.offers.white);
    try {
      const found = await w.call('POST', `${STORE}/sessions/${v.id}/revalidate`, dee.token);
      expect(found.body.outcome, JSON.stringify(found.body)).toBe('changes_found');
      const cs = found.body.changeSet;
      const change = cs.changes.find((c: any) => c.kind === 'terms_changed');
      expect(change.choices).toContain('remove');
      const ok = await w.call('POST', `${STORE}/sessions/${v.id}/changes/${cs.id}/accept`, dee.token, { decisions: cs.changes.map((c: any) => ({ changeId: c.id, choice: c.id === change.id ? 'remove' : c.defaultChoice })), acceptPartialOrder: true });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.packages.map((p: any) => p.fulfilledBy)).toEqual(['official_warehouse']);
    } finally {
      await w.marketly.leave(w.offers.white);
    }
  });
});

