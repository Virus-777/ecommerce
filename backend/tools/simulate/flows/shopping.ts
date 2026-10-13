/**
 * Flow 4, shopping:
 *   - promotions: the Marketing Manager sets up a coupon campaign (create → submit → funding → schedule);
 *   - customers register and verify their email, save an address, browse products and offers, fill the cart
 *     (add, change a quantity, remove a line), and check out: some with the coupon, one whose card is declined
 *     first and who retries with another card, some placing a second order later;
 *   - a visitor checks out as a guest.
 * Totals are checked before placing: amounts ending in 02–07 or 22–23 cents make the development card processor
 * decline, time out or fail the capture (payments/providers/card-processor.ts), so a customer who would hit one
 * adds one more unit and checks out again instead.
 */
import type { Session } from '../http.js';
import type { CustomerWorld, OfferWorld, OrderWorld, Sim } from '../sim.js';

const usd = (amount: number) => ({ amount, currency: 'USD' });
const SPECIAL_ENDINGS = new Set([2, 3, 4, 5, 6, 7, 22, 23]);
const RETURN_URL = 'http://localhost:3000/checkout/return';

export async function promotionFlow(sim: Sim): Promise<void> {
  const { api, world: w, run } = sim;
  const mk = w.staff.marketing!.session;
  const code = `PDXFALL${sim.runId.toUpperCase()}`;
  const now = Date.now();
  const campaign = await api.call(mk, 'POST', '/api/admin/promotions/campaigns', {
    name: `Portland fall savings ${sim.runId}`,
    description: '10% off your order, up to $25',
    discount: { kind: 'percent_coupon', percentOffBps: 1000, maxDiscountPerOrder: usd(2500) },
    code,
    autoApply: false,
    startsAt: new Date(now - 60_000).toISOString(),
    endsAt: new Date(now + 14 * 86_400_000).toISOString(),
    timeZone: 'America/Los_Angeles',
    scope: { mode: 'sitewide', include: [], exclude: [] },
    eligibility: { audience: 'everyone' },
    limits: { budget: usd(50_000), perCustomer: 1 },
    funding: { owner: 'platform', costCenter: 'MKT-PDX' },
    stacking: { withSellerMarkdowns: true, withOtherCoupons: false, withFreeShipping: true, withFlashSalePrices: false },
    terms: 'One use per customer. Marketly pays the discount, so sellers receive their full price.',
  });
  await api.call(mk, 'POST', `/api/admin/promotions/campaigns/${campaign.id}/submit`, { note: 'Fall campaign, platform funded' });
  await api.call(mk, 'POST', `/api/admin/promotions/campaigns/${campaign.id}/confirm-funding`, { comment: 'Within the Q4 budget', costCenter: 'MKT-PDX' });
  const scheduled = await api.call(mk, 'POST', `/api/admin/promotions/campaigns/${campaign.id}/schedule`);
  run.check('the campaign is live', scheduled.status === 'live', scheduled);
  w.couponCode = code;
  w.campaignId = campaign.id;
}

/** Everything on sale, sellers' and Official Store */
const catalogue = (sim: Sim): OfferWorld[] => [...sim.world.sellers.flatMap((s) => s.offers), ...sim.world.official];

async function browse(sim: Sim, s: Session, offer: OfferWorld): Promise<void> {
  const { api } = sim;
  await api.call(s, 'GET', `/api/store/catalog/products/${offer.productId}`);
  await api.call(s, 'GET', `/api/store/offers/products/${offer.productId}/offers?postalCode=97205`);
  await api.call(s, 'GET', `/api/store/offers/products/${offer.productId}/purchase-box?postalCode=97205`);
  await api.call(s, 'POST', '/api/store/customers/recently-viewed', { productId: offer.productId, variantId: offer.variantId });
}

interface Checkout {
  card?: string;
  coupon?: string;
  guestEmail?: string;
  address: Record<string, string>;
  addressId?: string;
  channel: 'web' | 'android';
}

/**
 * The checkout screens: start from the cart, address (and contact for guests), coupon, card, then Place order.
 * Returns the placed order, or the result when the payment did not go through.
 */
async function checkout(sim: Sim, s: Session, o: Checkout): Promise<{ result: any; view: any }> {
  const { api, run } = sim;
  for (let attempt = 0; ; attempt++) {
    const started = await api.call(s, 'POST', '/api/store/checkout/sessions', { source: 'cart' });
    const id = started.id as string;
    if (o.guestEmail) await api.call(s, 'PUT', `/api/store/checkout/sessions/${id}/contact`, { email: o.guestEmail, phone: o.address.phone, createAccountAfter: false, marketingOptIn: false });
    await api.call(s, 'PUT', `/api/store/checkout/sessions/${id}/address`, o.addressId ? { addressId: o.addressId } : { address: o.address });
    if (o.coupon) {
      const c = await api.call(s, 'POST', `/api/store/checkout/sessions/${id}/coupons`, { code: o.coupon });
      run.check(`coupon ${o.coupon} applied`, c.result?.status === 'applied', c.result);
    }
    const view = await api.call(s, 'PUT', `/api/store/checkout/sessions/${id}/payment-method`, { kind: 'new_card', providerToken: o.card ?? 'tok_visa', label: 'Card' });
    run.check('ready to place', view.readyToPlace === true, view.blockers);
    const amounts = [view.totals.total.amount as number, ...((view.totals.perPackage ?? []) as { total: { amount: number } }[]).map((p) => p.total.amount)];
    if (o.card !== 'tok_declined' && amounts.some((a) => SPECIAL_ENDINGS.has(a % 100)) && attempt < 4) {
      // the processor would treat this total specially: one more unit of the cheapest line, then start again
      await api.call(s, 'DELETE', `/api/store/checkout/sessions/${id}`);
      const cart = await api.call(s, 'GET', '/api/store/cart/cart');
      const lines = cartLines(cart);
      const cheapest = lines.sort((a, b) => a.price - b.price)[0]!;
      await api.call(s, 'PATCH', `/api/store/cart/cart/items/${cheapest.id}`, { quantity: cheapest.quantity + 1 });
      continue;
    }
    const result = await api.call(s, 'POST', `/api/store/checkout/sessions/${id}/place`, { quoteVersion: view.quoteVersion, expectedTotal: view.totals.total, acceptTerms: true, channel: o.channel, returnUrl: RETURN_URL });
    return { result, view };
  }
}

/** Cart lines with their ids, quantities and unit prices (CartView groups lines by seller package) */
function cartLines(cart: any): { id: string; offerId: string; quantity: number; price: number }[] {
  const out: { id: string; offerId: string; quantity: number; price: number }[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, any>;
    if (typeof o.id === 'string' && typeof o.offerId === 'string' && typeof o.quantity === 'number') out.push({ id: o.id, offerId: o.offerId, quantity: o.quantity, price: o.unitPrice?.amount ?? o.price?.amount ?? 0 });
    else Object.values(o).forEach(walk);
  };
  walk(cart);
  return out;
}

/** The placed order as the customer sees it, kept for the later flows */
async function remember(sim: Sim, s: Session, orderId: string, customer: CustomerWorld | null, guestEmail?: string): Promise<OrderWorld> {
  const order = await sim.api.call(s, 'GET', `/api/store/orders/orders/${orderId}`);
  const ow: OrderWorld = {
    orderId,
    ref: order.ref,
    customer,
    guest: guestEmail ? { email: guestEmail, session: s } : undefined,
    total: order.totals.total.amount,
    groups: (order.groups as any[]).map((g) => ({
      id: g.id,
      sellerId: g.seller?.id ?? null,
      fulfilledBy: g.fulfilledBy,
      items: (g.items as any[]).map((i) => ({ id: i.id, offerId: i.offer.offerId, quantity: i.quantity, unitPrice: i.unitPrice.amount })),
    })),
    tracking: [],
    delivered: false,
  };
  sim.world.orders.push(ow);
  return ow;
}

/** Fills a cart: a few offers, one quantity changed, one line removed again */
async function fillCart(sim: Sim, s: Session, picks: OfferWorld[]): Promise<void> {
  const { api, run } = sim;
  const added: string[] = [];
  for (const o of picks) {
    const r = await api.call(s, 'POST', '/api/store/cart/cart/items', { offerId: o.offerId, quantity: 1, source: 'product_page' });
    added.push(r.itemId);
  }
  if (added.length >= 2) {
    const cart = await api.call(s, 'PATCH', `/api/store/cart/cart/items/${added[0]}`, { quantity: 2 });
    run.check('quantity changed', cartLines(cart).find((l) => l.id === added[0])?.quantity === 2, cartLines(cart));
  }
  if (added.length >= 3) {
    const cart = await api.call(s, 'DELETE', `/api/store/cart/cart/items/${added.at(-1)}`);
    run.check('line removed', !cartLines(cart).some((l) => l.id === added.at(-1)), cartLines(cart));
  }
  const badge = await api.call(s, 'GET', '/api/store/cart/cart/badge');
  run.check('cart badge counts the items', JSON.stringify(badge).match(/\d/) !== null, badge);
}

export async function customersFlow(sim: Sim): Promise<void> {
  const { api, people, world: w, run } = sim;
  const offers = catalogue(sim);
  const count = sim.n(8);
  for (let i = 0; i < count; i++) {
    await run.attempt(`customer ${i + 1}`, async () => {
      const person = sim.person();
      const client = i % 3 === 2 ? 'android' : 'web';
      const s = await people.registerCustomer(person, client, sim.random() < 0.4);
      const profile = await api.call(s, 'GET', '/api/store/customers/profile');
      run.check('customer record created from the registration', profile.email?.toLowerCase?.() === person.email || JSON.stringify(profile).includes(person.firstName), profile);
      const address = sim.address(`${person.firstName} ${person.lastName}`, person.phone);
      const saved = await api.call(s, 'POST', '/api/store/customers/addresses', { label: 'Home', address, deliveryInstructions: sim.random() < 0.3 ? 'Leave by the side door' : null, makeDefault: true });
      const c: CustomerWorld = { person, session: s, accountId: s.accountId!, address, addressId: saved.id };
      w.customers.push(c);

      // browsing, then a cart; the first customer's card is declined and they use another one
      const picks = Array.from({ length: sim.int(1, 3) }, () => sim.pick(offers)).filter((o, j, a) => a.findIndex((x) => x.offerId === o.offerId) === j);
      for (const o of picks) await browse(sim, s, o);
      // the first and every third customer also buy something from the Official Store
      if ((i === 0 || i % 3 === 0) && w.official.length && !picks.some((p) => p.sellerId === null)) picks.push(sim.pick(w.official));
      await fillCart(sim, s, picks);
      const declineFirst = i === 0;
      const useCoupon = i % 2 === 1 && Boolean(w.couponCode);
      const { result, view } = await checkout(sim, s, { card: declineFirst ? 'tok_declined' : sim.pick(['tok_visa', 'tok_mastercard', 'tok_amex']), coupon: useCoupon ? w.couponCode : undefined, addressId: c.addressId, address, channel: client });
      let placed = result;
      if (declineFirst) {
        run.check('the declined card is reported, no order', result.outcome === 'payment_failed' && !result.orderId, result);
        const mine = await api.call(s, 'GET', '/api/store/orders/orders');
        run.check('no order after a declined card', (mine.items as unknown[]).length === 0, mine.items);
        placed = await api.call(s, 'POST', `/api/store/checkout/sessions/${view.id}/retry-payment`, { method: { kind: 'new_card', providerToken: 'tok_mastercard', label: 'Mastercard' }, quoteVersion: result.checkout?.quoteVersion ?? view.quoteVersion, expectedTotal: view.totals.total, returnUrl: RETURN_URL });
      }
      run.check('order accepted', placed.outcome === 'accepted' && placed.orderId, placed);
      const order = await remember(sim, s, placed.orderId, c);
      if (useCoupon) run.check('the coupon lowered the total', JSON.stringify(view.totals.discounts).includes(w.couponCode!) || view.totals.discountTotal.amount > 0, view.totals);
      const confirmation = await api.call(s, 'GET', `/api/store/checkout/sessions/${view.id}/confirmation`);
      run.check('confirmation names the order', JSON.stringify(confirmation).includes(order.ref), confirmation);
    });
  }

  // some customers come back for a second order
  for (const c of w.customers.slice(0, Math.max(0, w.orders.length > 0 ? sim.n(6) : 0))) {
    await run.attempt(`second order of ${c.person.email}`, async () => {
      await fillCart(sim, c.session, [sim.pick(offers)]);
      const { result } = await checkout(sim, c.session, { card: 'tok_visa', addressId: c.addressId, address: c.address, channel: c.session.client });
      run.check('second order accepted', result.outcome === 'accepted', result);
      await remember(sim, c.session, result.orderId, c);
    });
  }

  // a guest: no account, an email for the order, a card
  await run.attempt('guest checkout', async () => {
    const guest = sim.person('example.org');
    const s = await people.visitor('store', 'web', `guest ${guest.email}`);
    const o = sim.pick(offers);
    await browse(sim, s, o);
    await fillCart(sim, s, [o]);
    const address = sim.address(`${guest.firstName} ${guest.lastName}`, guest.phone);
    const { result } = await checkout(sim, s, { card: 'tok_discover', guestEmail: guest.email, address, channel: 'web' });
    run.check('guest order accepted', result.outcome === 'accepted', result);
    await remember(sim, s, result.orderId, null, guest.email);
  });
  run.check('orders placed', w.orders.length >= Math.min(3, count), w.orders.length);
}
