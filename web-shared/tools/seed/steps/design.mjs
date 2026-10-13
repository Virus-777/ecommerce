// Step 11: the states the Customer Store design shows, on live records, plus web-shared/.seed/design-samples.json
// for /design/check (which record and which session each screen view is checked against).
//
// Everything goes through the API as the people who would do it: Jordan orders, asks for returns, cancels,
// reports problems and messages sellers; sellers and the Official Store (Olivia, Morgan) answer, ship and decide;
// the carrier reports scans by signed webhook. Re-runnable: finished stages are remembered in state.json
// (`design`), records are looked up before they are made. Checkout sessions expire (60 min idle, 30 min after a
// declined payment), so the checkout and payment samples are made again on every run.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ApiError, poll, sleep } from '../lib/http.mjs';
import { productPng } from '../lib/files.mjs';
import { clearCart, itemOf, money, place, runGroupPlan, sellerShip } from './orders.mjs';
import { platformCampaign } from './promotions.mjs';
import { CUSTOMERS, TZ, usd } from '../data.mjs';

/** Who the design check signs in as for customer samples (dev Google sign-in; no secret) */
const designCustomer = () => {
  const c = CUSTOMERS.find((x) => x.key === 'jordan');
  return { email: c.email, first: c.first, last: c.last };
};

const RETURN_URL = 'http://127.0.0.1:3000/checkout/confirmation';
const DAY = 86_400_000;
const conflict = (err) => err instanceof ApiError && err.status === 409;

/** The design's cart (store-cart.html): Official Store package, Northwind Audio, Casa Verde Home */
const CART = [
  ['aurora.sage', 1], // the design shows Midnight black; Jordan has bought 3 (the Official Store's purchase limit) on other orders
  ['pourover.slate', 1], // Cream is at its purchase limit (3 per customer in 30 days) for Jordan
  ['lamp.white', 1],
  ['speaker.teal', 1],
  ['duvet.sage', 1],
];

/** Orders this step adds for Jordan (keys live next to the orders step's in state.orders) */
const ORDERS = {
  confirmation: { key: 'design-confirmation', customer: 'jordan', address: 'home', lines: [['aurora.black', 1], ['pourover.cream', 1], ['speaker.teal', 1], ['duvet.sage', 1]] },
  cancelRequested: { key: 'design-cancel-requested', customer: 'jordan', address: 'home', lines: [['duvet.oat', 1]] },
  deliveryFailed: { key: 'design-delivery-failed', customer: 'jordan', address: 'home', lines: [['ssd1tb.gray', 2]] },
  keyboard: { key: 'design-keyboard', customer: 'jordan', address: 'home', lines: [['keyboard.gray', 1]] },
  replacement: { key: 'design-replacement', customer: 'jordan', address: 'home', lines: [['kettle.matte', 1]] },
  caseDecided: { key: 'design-case-decided', customer: 'jordan', address: 'home', lines: [['sheets.white', 1]] },
};

/** The guest order of auth-guest-orders--found.html */
const GUEST = {
  key: 'design-guest',
  email: 'taylor.brooks@example.com',
  address: { name: 'Taylor Brooks', line1: '77 NE Fremont St', city: 'Portland', region: 'OR', postalCode: '97212', country: 'US', phone: '+15035550177' },
  lines: [['skillet.26', 1], ['bottle.slate', 1]],
};

export async function designStep(ctx) {
  const { state, log } = ctx;
  const progress = state.section('design');
  const samples = {};
  const sample = (screen, view, s) => (samples[`${screen}@${view}`] = s);
  const failures = [];

  /** One stage: runs once (unless `always`), failures are warnings so the other states still get made */
  const stage = async (key, title, fn, { always = false } = {}) => {
    if (!always && progress[key]?.done) return progress[key];
    try {
      const out = (await fn(progress[key] ?? {})) ?? {};
      progress[key] = { ...out, done: true };
      state.save();
      log.info(`✓ ${title}`);
      return progress[key];
    } catch (err) {
      failures.push(key);
      log.warn(`design ${key} (${title}) failed: ${err.message}`);
      return null;
    }
  };

  const orders = state.section('orders');
  const multi = orders['jordan-multi'];
  if (!multi?.orderId) throw new Error('run the orders step first (jordan-multi is missing)');
  const jordan = () => ctx.customerToken('jordan');
  const productOf = (key) => state.get(`product.${key}`);
  const offer = (key) => state.get(`offer.${key}`);

  /* ------------------------------------------------ returns on existing orders */

  // RT for the pour-over (jordan-multi): approved by the Official Store, drop off with the QR code
  const pourover = await stage('pouroverApproved', 'pour-over return approved by the Official Store (send it back)', async () => {
    const list = await ctx.api.get(`/api/store/returns/requests?limit=50`, jordan());
    const ret = (list.items ?? []).find((r) => r.orderId === multi.orderId && /Pour-over/.test(r.item?.title ?? ''));
    if (!ret) throw new Error('no pour-over return on jordan-multi');
    await ctx.api.post(`/api/admin/returns/requests/${ret.id}/approve`, ctx.staff, { labelMethod: 'prepaid_qr', reason: 'Chipped cup matches the photos. Free return for damage.' }).catch((err) => {
      if (!conflict(err)) throw err;
    });
    return { id: ret.id, ref: ret.ref };
  });

  // RT for the backpack (jordan-backpack): refunded by the orders step
  const backpack = await stage('backpackRefund', 'backpack return with its refund sent', async () => {
    const rec = orders['jordan-backpack'];
    if (!rec?.done?.returnId) throw new Error('jordan-backpack has no return');
    const r = await ctx.api.get(`/api/store/returns/requests/${rec.done.returnId}`, jordan());
    return { id: r.id, ref: r.ref, refundSent: Boolean(rec.done.refundSent) };
  });

  // RT for the speaker (jordan-speaker): requested, Northwind has not answered yet
  await stage('speakerReturn', 'speaker return requested from Northwind Audio', async () => {
    const rec = orders['jordan-speaker'];
    const it = itemOf(rec, 'speaker.teal');
    if (!it) throw new Error('jordan-speaker has no speaker item');
    const list = await ctx.api.get(`/api/store/returns/requests?limit=50`, jordan());
    const found = (list.items ?? []).find((r) => r.orderId === rec.orderId);
    if (found) return { id: found.id, ref: found.ref };
    const created = await ctx.api.post('/api/store/returns/requests', jordan(), { orderId: rec.orderId, items: [{ orderItemId: it.id, quantity: 1 }], reason: 'defective', details: 'The right channel crackles at any volume above half. Photos of the settings screen attached.', remedy: 'refund' }, { idem: randomUUID() });
    const ret = created.returns[0];
    return { id: ret.id, ref: ret.ref };
  });

  /* ------------------------------------------------ new orders */

  /** place() + a fulfilment plan, remembered per order key */
  const order = async (o, plan = {}) => {
    const rec = await place(ctx, o);
    for (const [seller, p] of Object.entries(plan)) await runGroupPlan(ctx, rec, seller, p);
    return rec;
  };

  // A placed order the confirmation page shows (4 items, 3 packages)
  const confirmation = await stage('confirmation', 'order placed for the confirmation page', async () => {
    const rec = await order(ORDERS.confirmation);
    const sessionId = await checkoutSessionOf(ctx, rec);
    return { ref: rec.ref, sessionId };
  });

  // Cancellation requested (Casa Verde has not confirmed)
  const cancelRequested = await stage('cancelRequested', 'cancellation requested on a delayed duvet cover', async () => {
    const rec = await order(ORDERS.cancelRequested, { casaverde: 'delay' });
    const detail = await ctx.api.get(`/api/store/orders/orders/${rec.orderId}`, jordan());
    if (!JSON.stringify(detail).includes('cancellation_requested')) {
      const items = rec.groups.flatMap((g) => g.items.map((i) => ({ itemId: i.id, quantity: i.quantity })));
      await ctx.api.post(`/api/store/orders/orders/${rec.orderId}/cancellations`, jordan(), { items, reasonCode: 'delivery_too_slow', note: 'It was due last week and still has no ship date.' }, { idem: randomUUID() });
    }
    return { ref: rec.ref };
  });

  // Delivery failed: the carrier could not deliver (signature required) and holds the parcel
  const deliveryFailed = await stage('deliveryFailed', 'delivery attempt failed on the SSD package (carrier webhook)', async (prev) => {
    const rec = await order(ORDERS.deliveryFailed, { pixelport: { do: 'ship', carrier: 'usps', service: 'USPS Priority Mail' } });
    const parcel = rec.done['parcel.pixelport'];
    if (!prev.attempted) {
      await carrierEvent(ctx, parcel, 'out_for_delivery', { description: 'Out for delivery', location: 'Portland, OR 97205' });
      await carrierEvent(ctx, parcel, 'attempt_failed', { description: 'Delivery attempted. Signature required, no one available', location: 'Portland, OR 97205' });
    }
    return { ref: rec.ref, attempted: true };
  });

  // Keyboard: delivered, returned, received by Pixel & Port (refund follows the inspection)
  await stage('keyboardReturn', 'keyboard return received by Pixel & Port', async (prev) => {
    const rec = await order(ORDERS.keyboard, { pixelport: { do: 'deliver', carrier: 'ups', service: 'UPS Ground' } });
    const it = itemOf(rec, 'keyboard.gray');
    const id = prev.id ?? (await requestReturn(ctx, rec, it, { reason: 'defective', details: 'Two keys on the left side repeat when pressed once.', remedy: 'refund' })).id;
    const t = ctx.sellerToken('pixelport');
    await sellerStep(ctx, t, id, 'approve', { labelMethod: 'prepaid_label', note: 'Sorry about that. The prepaid label is ready.' });
    await sellerStep(ctx, t, id, 'receive', { note: 'Parcel arrived at our Austin shop' });
    const r = await ctx.api.get(`/api/store/returns/requests/${id}`, jordan());
    return { id, ref: r.ref };
  });

  // Replacement on the way: kettle arrived damaged; Casa Verde inspects the return and ships a new one
  const replacement = await stage('replacement', 'replacement shipped for a damaged kettle', async (prev) => {
    const rec = await order(ORDERS.replacement, { casaverde: { do: 'deliver', carrier: 'ups', service: 'UPS Ground' } });
    const it = itemOf(rec, 'kettle.matte');
    const t = ctx.sellerToken('casaverde');
    await ensureRemedy(ctx, 'casaverde', 'replacement');
    let id = prev.id;
    if (!id) {
      const photo = await ctx.upload('store', jordan(), { purpose: 'return_evidence', fileName: 'kettle-dent.png', contentType: 'image/png', body: productPng({ width: 800, height: 800, color: '#2f3135', shape: 'circle' }), alt: 'Dent on the kettle lid' }, 'store:design:kettle-dent');
      id = (await requestReturn(ctx, rec, it, { reason: 'damaged', details: 'The lid arrived dented and does not close. The box was crushed on one corner.', remedy: 'replacement', mediaIds: [photo.id] })).id;
      progress.replacement = { id };
      state.save();
    }
    await sellerStep(ctx, t, id, 'approve', { labelMethod: 'prepaid_qr', note: 'Sorry it arrived dented. A new one ships as soon as we have the old one back.' });
    await sellerStep(ctx, t, id, 'receive', { note: 'Returned kettle received' });
    await sellerStep(ctx, t, id, 'inspection', { conditionOutcome: 'as_described', grade: 'damaged', proposedStockOutcome: 'damaged_stock', checks: [{ label: 'Damage matches the photos', passed: true }], notes: 'Dented lid, carrier damage' });
    await sellerStep(ctx, t, id, 'remedy', { kind: 'replacement', explanation: 'A new kettle ships today, no charge.' }, { idem: `design-replacement-${id}` });
    // the replacement line joins the Casa Verde package; ship it and let the carrier scan it
    if (!prev.shipped) {
      const g = rec.groups.find((x) => x.seller === 'casaverde');
      await poll('the replacement line on the order', async () => {
        const d = await ctx.api.get(`/api/seller/orders/orders/${g.id}`, t);
        return (d.items ?? []).some((i) => i.quantity - (i.cancelledQuantity ?? 0) - (i.shippedQuantity ?? 0) > 0) ? d : null;
      }, { timeoutMs: 30_000 });
      const parcel = await sellerShip(ctx, { ...rec, ref: `${rec.ref}-R` }, g, { carrier: 'ups', service: 'UPS Ground' });
      await carrierEvent(ctx, parcel, 'accepted', { location: 'Sacramento, CA' });
      await carrierEvent(ctx, parcel, 'in_transit', { location: 'Medford, OR' });
    }
    const r = await ctx.api.get(`/api/store/returns/requests/${id}`, jordan());
    if (!r.replacement) log.warn(`replacement: return ${r.ref} shows no replacement yet (status ${r.status})`);
    return { id, ref: r.ref, shipped: true };
  });

  /* ------------------------------------------------ support cases */

  // Open: the duvet cover of jordan-multi hasn't arrived; Casa Verde answers
  const caseOpen = await stage('caseOpen', 'support case open: duvet cover hasn’t arrived', async (prev) => {
    const duvet = itemOf(multi, 'duvet.sage');
    const c = prev.id ? { id: prev.id } : await openCase(ctx, multi, [duvet.id], { category: 'delivery_late', problemType: 'not_arrived', desiredRemedy: 'keep_waiting', message: 'My duvet cover was due Sep 22 and still hasn’t shipped. There’s no tracking number on the order. Can you tell me when it will arrive?' });
    progress.caseOpen = { id: c.id };
    state.save();
    if (!prev.sellerReplied) {
      await ctx.api.post(`/api/seller/support/cases/${c.id}/messages`, ctx.sellerToken('casaverde'), { body: 'Sorry for the wait, Jordan. Our sage linen restock arrives this week. We’ll ship the day it lands and add tracking as soon as it leaves.' });
    }
    const v = await ctx.api.get(`/api/store/support/cases/${c.id}`, jordan());
    return { id: c.id, ref: v.ref, sellerReplied: true };
  });

  // Decision made: sheets that never shipped; Marketly decides a full refund
  const caseDecided = await stage('caseDecided', 'support case decided: full refund for sheets that never shipped', async (prev) => {
    const rec = await order(ORDERS.caseDecided, { casaverde: 'delay' });
    const sheets = itemOf(rec, 'sheets.white');
    const c = prev.id ? { id: prev.id } : await openCase(ctx, rec, [sheets.id], { category: 'delivery_late', problemType: 'not_arrived', desiredRemedy: 'refund', message: 'The sheet set is long past its delivery estimate and the seller can’t give me a ship date. I’d like a refund.' });
    progress.caseDecided = { id: c.id };
    state.save();
    const v0 = await ctx.api.get(`/api/store/support/cases/${c.id}`, jordan());
    if (!v0.decision) {
      await ctx.api.post(`/api/admin/support/cases/${c.id}/assign`, ctx.staff, { ownerId: ctx.owner('olivia').accountId, reason: 'Taking this one' }).catch(() => {});
      await ctx.api.post(
        `/api/admin/support/cases/${c.id}/decide`,
        ctx.staff,
        {
          outcome: 'customer_favored',
          remedies: [{ kind: 'refund', amount: usd(sheets.unitPrice ?? 7900), chargedTo: 'seller', orderItemIds: [sheets.id], note: 'Item price; shipping was free' }],
          reason: 'Casa Verde Home couldn’t give a ship date for an item well past its delivery estimate. Under the purchase terms, items that don’t ship within 14 days of the estimate qualify for a full refund. The sheet set is cancelled; nothing else changes.',
          notifyParties: true,
        },
        { idem: `design-case-decided-${c.id}` },
      );
    }
    const v = await ctx.api.get(`/api/store/support/cases/${c.id}`, jordan());
    return { id: c.id, ref: v.ref };
  });

  // Closed: two resolved cases (backpack refund, shoes cancelled)
  await stage('casesClosed', 'two resolved support cases', async (prev) => {
    const done = prev.ids ?? {};
    for (const [key, o] of [
      ['jordan-backpack', { category: 'other_help', subject: 'Refund for returned backpack', message: 'I returned the backpack last week. When will the refund arrive?', summary: 'Refund sent to the card on file.' }],
      ['jordan-shoes', { category: 'order_change', subject: 'Cancel running shoes before shipping', message: 'I ordered the wrong size. Can you make sure the shoes are cancelled?', summary: 'Item cancelled, refund sent.' }],
    ]) {
      if (done[key]) continue;
      const rec = orders[key];
      if (!rec) continue;
      const c = await ctx.api.post('/api/store/support/cases', jordan(), { kind: 'customer_help', category: o.category, orderId: rec.orderId, subject: o.subject, message: o.message }, { idem: `design-case-${key}` }).catch(async (err) => {
        // the category list is configurable: fall back to the first customer category
        if (!(err instanceof ApiError) || err.status !== 422 && err.code !== 'VALIDATION_FAILED') throw err;
        const opts = await ctx.api.get('/api/store/support/contact-options', jordan());
        const cat = (opts.topics ?? opts.categories ?? [])[0]?.key ?? 'other_help';
        return ctx.api.post('/api/store/support/cases', jordan(), { kind: 'customer_help', category: cat, orderId: rec.orderId, subject: o.subject, message: o.message }, { idem: `design-case-${key}-2` });
      });
      await ctx.api.post(`/api/admin/support/cases/${c.id}/resolve`, ctx.staff, { summary: o.summary }).catch((err) => {
        if (!conflict(err)) throw err;
      });
      done[key] = c.id;
      progress.casesClosed = { ids: done };
      state.save();
    }
    return { ids: done };
  });

  /* ------------------------------------------------ messages */

  await stage('messages', 'conversations with sellers, the Official Store and Marketly support', async (prev) => {
    const done = prev.keys ?? {};
    const speakerRet = progress.speakerReturn;
    const threads = [
      { key: 'pixelport', start: { with: 'seller', orderId: multi.orderId, sellerId: state.section('sellers').pixelport.sellerId, orderItemId: itemOf(multi, 'ssd1tb.gray')?.id, body: 'Hi, has the SSD pack shipped yet?' }, reply: { as: 'pixelport', body: 'Shipped today with USPS Priority. Tracking is on your order page.' } },
      { key: 'official', start: { with: 'official_store', orderId: multi.orderId, returnId: pourover?.id, body: 'One of the cups in my pour-over set arrived chipped. I’ve asked for a return.' }, reply: { as: 'staff', body: 'Sorry about the chipped cup. Your return is approved; drop it off at any UPS location with the QR code.' } },
      ...(speakerRet?.id ? [{ key: 'northwind', start: { with: 'seller', orderId: orders['jordan-speaker'].orderId, sellerId: state.section('sellers').northwind.sellerId, returnId: speakerRet.id, body: 'I sent photos of the crackling right channel with the return request.' }, reply: { as: 'northwind', body: 'Thanks, we’re checking the photos and will reply by Friday.' } }] : []),
      ...(caseOpen?.id ? [{ key: 'support', start: { with: 'marketplace_support', orderId: multi.orderId, caseId: caseOpen.id, body: 'Is there any news on my duvet cover case?' }, reply: { as: 'staff', body: 'We asked Casa Verde to ship by Friday and will check back then.' } }] : []),
      { key: 'casaverde', start: { with: 'seller', orderId: multi.orderId, sellerId: state.section('sellers').casaverde.sellerId, orderItemId: itemOf(multi, 'duvet.sage')?.id, body: 'Hi, my duvet cover was due last week and still hasn’t shipped. Can you tell me when it will?' }, reply: { as: 'casaverde', body: 'The Sage color restock arrives tomorrow. We’ll ship Saturday and you’ll get tracking right away.' } },
    ];
    for (const th of threads) {
      if (done[th.key]) continue;
      const started = await ctx.api.post('/api/store/messaging/conversations', jordan(), { ...th.start, clientMessageId: `design-${th.key}` });
      const id = started.conversation.id;
      await sleep(400);
      const r = th.reply;
      if (r.as === 'staff') await ctx.api.post(`/api/admin/messaging/conversations/${id}/messages`, ctx.staff, { body: r.body, ...(th.start.caseId ? { caseId: th.start.caseId } : {}) });
      else await ctx.api.post(`/api/seller/messaging/conversations/${id}/messages`, ctx.sellerToken(r.as), { body: r.body, clientMessageId: `design-${th.key}-reply` });
      done[th.key] = id;
      progress.messages = { keys: done };
      state.save();
    }
    return { keys: done };
  });

  /* ------------------------------------------------ catalog and coupons */

  // Product unavailable: the Official Store is out of Aurora Stone (other sellers still have it)
  await stage('stoneOutOfStock', 'Official Store out of Halden Aurora in Stone', async () => {
    const o = offer('aurora.stone');
    const item = await ctx.api.get(`/api/admin/inventory/stock-items/${o.stockItemId}`, ctx.staff);
    const q = item.quantities ?? item.stockItem?.quantities ?? item.item?.quantities ?? {};
    const available = q.available ?? 0;
    if (available > 0) {
      const adj = await ctx.api.post('/api/admin/inventory/adjustments', ctx.staff, { stockItemId: o.stockItemId, locationId: state.get('official.locationId'), fromGroup: 'available', toGroup: 'outside', quantity: available, reasonCode: 'supplier_return', note: 'Stone batch sent back to the supplier (colour mismatch); next delivery in two weeks' });
      if (adj.state !== 'applied') log.warn(`Aurora Stone stock adjustment is ${adj.state}`);
    }
    return { moved: available };
  });

  // More coupons: Home Week 15% (Official Store + Casa Verde, Home & Kitchen) and $10 off Northwind Audio (clipped)
  await stage('coupons', 'coupons to clip on the Coupons page', async () => {
    const now = Date.now();
    const base = { timeZone: TZ, eligibility: { audience: 'signed_in' }, limits: { perCustomer: 1 }, funding: { owner: 'platform', costCenter: 'MKT-HOMEWEEK' }, stacking: { withSellerMarkdowns: true, withOtherCoupons: false, withFreeShipping: true, withFlashSalePrices: false }, deals: { show: true, section: 'coupons' }, autoApply: false, startsAt: new Date(now - 60_000).toISOString() };
    const home = state.get('category.home');
    const homeWeek = await platformCampaign(ctx, 'homeWeek15', {
      ...base,
      name: 'Home Week: 15% off Home & Kitchen',
      description: 'Min. spend $75 on eligible Home & Kitchen items',
      discount: { kind: 'percent_coupon', percentOffBps: 1500, minSpend: usd(7500), minSpendScope: 'eligible_items' },
      code: 'HOMEWEEK15',
      endsAt: new Date(now + 6 * DAY).toISOString(),
      scope: { mode: 'categories', include: home ? [{ kind: 'category', id: typeof home === 'string' ? home : home.id, label: 'Home & Kitchen' }] : [], exclude: [] },
      terms: 'Min. spend $75 on eligible Home & Kitchen items from the Official Store and Casa Verde Home.',
    });
    const nw = state.section('sellers').northwind;
    const nwa = await platformCampaign(ctx, 'northwind10', {
      ...base,
      name: '$10 off Northwind Audio',
      description: 'Orders of $80 or more from Northwind Audio',
      discount: { kind: 'fixed_coupon', amountOff: usd(1000), minSpend: usd(8000), minSpendScope: 'eligible_items' },
      code: 'NWA10',
      endsAt: new Date(now + 18 * DAY).toISOString(),
      scope: { mode: 'sellers', include: [{ kind: 'seller', id: nw.sellerId, label: 'Northwind Audio' }], exclude: [] },
      terms: 'Orders of $80 or more from Northwind Audio. Headphones, speakers and cables.',
    });
    await ctx.api.post(`/api/store/promotions/coupons/${nwa.id}/clip`, jordan(), undefined).catch((err) => {
      if (!conflict(err)) throw err;
    });
    return { homeWeek: homeWeek.id, northwind: nwa.id };
  });

  // Reports you made: Jordan reports a review that is about a different product
  await stage('reports', 'a review report by Jordan', async () => {
    const id = state.get('review.priya-aurora.aurora-black-northwind')?.id ?? state.get('review.ines-aurora.aurora.black')?.id;
    if (!id) throw new Error('no seeded review to report');
    await ctx.api.post('/api/store/reviews/reports', jordan(), { targetType: 'product_review', targetId: id, reason: 'off_topic', note: 'This review is about the seller’s shipping, not the headphones.' }).catch((err) => {
      if (!conflict(err)) throw err;
    });
    return { reviewId: id };
  });

  /* ------------------------------------------------ guest order (visitor) */

  const guest = await stage('guestOrder', 'guest order for the order look-up page', async (prev) => {
    let rec = orders[GUEST.key];
    if (!rec?.orderId) rec = await guestOrder(ctx);
    if (!prev.planned) {
      await runGroupPlan(ctx, rec, 'official', 'deliver');
      await runGroupPlan(ctx, rec, 'trailhead', { do: 'ship', carrier: 'usps', service: 'USPS Ground Advantage' });
    }
    return { ref: rec.ref, planned: true };
  });

  /* ------------------------------------------------ Jordan's cart and the checkout sessions (every run) */

  const cart = await stage('cart', 'Jordan’s cart holds the design cart', async () => {
    await fillCart(ctx, jordan(), CART);
    return {};
  }, { always: true });

  // Payment failed (bank declined): a checkout from the cart, kept while it is still in its retry window.
  const sessionIn = async (id, statuses) => (id ? ctx.api.get(`/api/store/checkout/sessions/${id}`, jordan()).then((s) => (statuses.includes(s.status) ? s : null)).catch(() => null) : null);
  const declined = await stage('paymentFailed', 'checkout with a declined payment', async (prev) => ((await sessionIn(prev.sessionId, ['payment_failed'])) ? prev : placeFromCart(ctx, jordan(), { providerToken: 'tok_declined' })), { always: true });
  if (cart) await fillCart(ctx, jordan(), CART);
  // Payment being checked: made once only. The dev processor's uncertain answers are settled by the
  // payments.check-uncertain job (every 30 s), so the payment stays "pending" for about a minute; after that the
  // order is cancelled and the page shows the declined result. Every new attempt is another (cancelled) order that
  // counts against the Official Store's purchase limit (3 per offer per customer in 30 days).
  const pending = await stage('paymentPending', 'checkout whose payment is being checked (settles within a minute)', async () => placeFromCart(ctx, jordan(), { providerToken: 'tok_timeout_lost' }));
  if (cart) await fillCart(ctx, jordan(), CART);
  // Coupon rejected: a code that can't be used (WELCOME20 was used on Jordan's first order), kept on the session
  const couponRejected = await stage('couponRejected', 'checkout with a rejected coupon code', async (prev) => {
    if (await sessionIn(prev.sessionId, ['open'])) return prev;
    const t = jordan();
    let s = await ctx.api.post('/api/store/checkout/sessions', t, { source: 'cart' });
    s = await ctx.api.put(`/api/store/checkout/sessions/${s.id}/address`, t, { addressId: state.section('customers').jordan.addresses.home });
    let status;
    for (const code of ['WELCOME20', 'AUTUMN15']) {
      const r = await ctx.api.post(`/api/store/checkout/sessions/${s.id}/coupons`, t, { code }).catch((err) => ({ result: { status: `error ${err.code}` } }));
      status = r.result?.status;
      if (status === 'rejected') break;
      if (status === 'applied') await ctx.api.del(`/api/store/checkout/sessions/${s.id}/coupons/${code}`, t).catch(() => {});
    }
    if (status !== 'rejected') log.warn(`coupon-rejected: no code was rejected (last: ${status})`);
    await ctx.api.put(`/api/store/checkout/sessions/${s.id}/payment-method`, t, { kind: 'new_card', providerToken: 'tok_visa', label: 'Visa' });
    return { sessionId: s.id, couponStatus: status };
  }, { always: true });
  if (cart) await fillCart(ctx, jordan(), CART);

  /* ------------------------------------------------ the samples */

  const sellers = state.section('sellers');
  const aurora = productOf('aurora');
  const lamp = productOf('lamp');
  const lampSlug = await ctx.api.get(`/api/store/catalog/products/${lamp.id}`, ctx.visitor).then((p) => p.slug).catch(() => 'brightline-desk-lamp');
  const auroraSlug = await ctx.api.get(`/api/store/catalog/products/${aurora.id}`, ctx.visitor).then((p) => p.slug).catch(() => 'halden-aurora');
  const helpSlug = await helpArticleSlug(ctx, state.get('help.article.return-seller-item'));
  const duvetItem = itemOf(multi, 'duvet.sage');
  const visitor = { session: 'visitor' };
  const customer = { session: 'customer' };
  const cartLines = CART.filter(([k]) => k !== 'lamp.white').map(([k, quantity]) => ({ offerId: offer(k)?.id, quantity })).filter((l) => l.offerId);

  // browsing (any session; customer like the rest of the store)
  const auroraParams = { slug: auroraSlug, id: aurora.id };
  sample('store/product', '', { ...customer, params: auroraParams });
  sample('store/product', 'seller-offer-selected', { ...customer, params: auroraParams });
  sample('store/product', 'no-reviews-yet', { ...customer, params: { slug: lampSlug, id: lamp.id } });
  sample('store/offers', '', { ...customer, params: auroraParams });
  sample('store/offers', 'fastest-delivery', { ...customer, params: auroraParams });
  sample('store/seller', '', { ...customer, params: { slug: sellers.northwind.slug } });
  sample('store/brand', '', { ...customer, params: { slug: 'halden' } });
  sample('store/category', '', { ...customer, params: { slug: 'headphones' } });
  sample('store/category', 'filters-phone-sheet', { ...customer, params: { slug: 'headphones' } });
  sample('store/search', '', { ...customer, query: { q: 'wireless headphones' } });
  sample('store/search', 'suggestions-open', { ...customer, query: { q: 'wireless headphones' } });
  sample('store/search-empty', '', { ...visitor, query: { q: 'halden aurora', condition: 'used', priceMax: '10000', delivery: 'free' } });
  sample('store/search-empty', 'product-unavailable', { ...customer, query: { id: aurora.id, variantId: aurora.variants.stone } });
  sample('help/article', '', { ...customer, params: { slug: helpSlug } });

  // cart and checkout
  sample('store/cart', '', customer);
  sample('store/cart', 'empty', { ...visitor, note: 'a new visitor has an empty cart' });
  sample('store/checkout', '', customer);
  sample('store/checkout', 'guest-checkout', { ...visitor, before: cartLines.map((l) => ({ method: 'POST', path: '/api/store/cart/cart/items', body: { ...l, source: 'product_page' } })) });
  if (couponRejected?.sessionId) sample('store/checkout', 'coupon-rejected', { ...customer, query: { session: couponRejected.sessionId } });
  if (declined?.sessionId) sample('store/payment-result', '', { ...customer, query: { session: declined.sessionId } });
  if (pending?.sessionId) sample('store/payment-result', 'checking-payment', { ...customer, query: { session: pending.sessionId } });
  if (confirmation?.sessionId) sample('store/confirmation', '', { ...customer, query: { session: confirmation.sessionId } });

  // signed out
  for (const v of ['', 'wrong-password', 'two-step-code']) sample('auth/sign-in', v, visitor);
  for (const v of ['', 'verify-email']) sample('auth/register', v, visitor);
  for (const v of ['', 'check-your-email', 'set-new-password']) sample('auth/recover', v, visitor);
  sample('auth/guest-orders', '', visitor);
  if (guest?.ref) sample('auth/guest-orders', 'found', { ...visitor, query: { ref: guest.ref }, before: [{ method: 'POST', path: '/api/store/customers/guest-orders/lookup', body: { orderRef: guest.ref, email: GUEST.email } }] });

  // account: orders, tracking, cancellations, returns
  const ref = { ref: multi.ref };
  sample('account/order', '', { ...customer, params: ref });
  sample('account/tracking', '', { ...customer, params: ref });
  if (deliveryFailed?.ref) sample('account/tracking', 'delivery-failed', { ...customer, params: { ref: deliveryFailed.ref } });
  sample('account/cancel', '', { ...customer, params: ref });
  if (cancelRequested?.ref) sample('account/cancel', 'cancellation-requested', { ...customer, params: { ref: cancelRequested.ref } });
  for (const v of ['', 'reason-and-remedy', 'review']) sample('account/return-new', v, { ...customer, params: ref });
  if (pourover?.ref) sample('account/return', '', { ...customer, params: { ref: pourover.ref } });
  if (backpack?.ref) sample('account/return', 'refund-sent', { ...customer, params: { ref: backpack.ref } });
  if (replacement?.ref) sample('account/return', 'replacement-on-the-way', { ...customer, params: { ref: replacement.ref } });
  if (duvetItem) sample('help/order-problem', '', { ...customer, query: { order: multi.ref, item: duvetItem.id } });
  if (caseOpen?.ref) sample('help/case', '', { ...customer, params: { ref: caseOpen.ref } });
  if (caseDecided?.ref) sample('help/case', 'decision-made', { ...customer, params: { ref: caseDecided.ref } });

  // every other store row: Jordan, the screen's own URL
  for (const id of ['store/home', 'store/categories', 'store/official', 'store/deals', 'store/not-found', 'store/checkout-review-changes', 'account/overview', 'account/orders', 'account/returns', 'account/messages', 'account/notifications', 'account/addresses', 'account/profile', 'account/security', 'account/payment-methods', 'account/review', 'account/reviews', 'account/wishlist', 'account/coupons', 'help/center', 'help/contact', 'help/cases', 'info/policy', 'info/about', 'sell/landing', 'sell/apply', 'sell/status', 'ads/opening', 'ads/popup', 'ads/formats', 'store/collection', 'theme/foundations', 'theme/components', 'theme/patterns']) {
    for (const v of VIEWS[id] ?? ['']) samples[`${id}@${v}`] ??= customer;
  }

  const file = join(dirname(ctx.opts.stateFile), 'design-samples.json');
  writeFileSync(file, `${JSON.stringify({ generatedAt: new Date().toISOString(), note: 'Written by npm run seed -- --only design. Checkout and payment sessions expire: run the step again before a design check.', customer: designCustomer(), samples }, null, 2)}\n`);
  log.info(`${Object.keys(samples).length} samples → ${file}`);
  if (failures.length) throw new Error(`design stages failed: ${failures.join(', ')} (the samples of the others were written)`);
}

/** Views of the screens listed without records (from web-shared/src/routes/catalogue.ts) */
const VIEWS = {
  'store/not-found': ['', 'something-went-wrong'],
  'store/collection': ['', 'best-sellers', 'seasonal', 'curated-collection'],
  'account/orders': ['', 'no-matches'],
  'account/addresses': ['', 'edit-address'],
  'account/reviews': ['', 'seller-feedback', 'reports-you-made'],
  'info/policy': ['', 'shipping', 'seller-rules', 'privacy', 'purchase-terms'],
  'sell/apply': ['', 'business-details', 'verification', 'payout-and-return-address', 'agreement'],
  'sell/status': ['', 'approved', 'rejected'],
  'ads/opening': ['', 'sponsored-brand'],
  'ads/popup': ['', 'announcement'],
  'ads/formats': ['', 'sticky-ad', 'interstitial'],
};

/* ------------------------------------------------ helpers */

/** One signed carrier scan for a parcel */
async function carrierEvent(ctx, parcel, code, { description, location } = {}) {
  const body = { id: `evt-${parcel.tracking}-${code}`, trackingNumber: parcel.tracking, code, at: new Date().toISOString(), description: description ?? code.replace(/_/g, ' '), location: location ?? 'Portland, OR' };
  await ctx.api.webhook(`/webhooks/shipping/carriers/${parcel.carrier}/events`, body, body.id);
  await sleep(400);
}

/** A seller step on a return; 409 = already done */
async function sellerStep(ctx, token, id, path, body, o) {
  await ctx.api.post(`/api/seller/returns/requests/${id}/${path}`, token, body, o).catch((err) => {
    if (!conflict(err)) throw err;
  });
}

async function requestReturn(ctx, rec, it, { reason, details, remedy, mediaIds }) {
  const t = ctx.customerToken(rec.customer);
  const list = await ctx.api.get('/api/store/returns/requests?limit=50', t);
  const found = (list.items ?? []).find((r) => r.orderId === rec.orderId && r.item?.orderItemId === it.id);
  if (found) return found;
  const created = await ctx.api.post('/api/store/returns/requests', t, { orderId: rec.orderId, items: [{ orderItemId: it.id, quantity: 1 }], reason, details, remedy, ...(mediaIds ? { mediaIds } : {}) }, { idem: randomUUID() });
  return created.returns[0];
}

/** Adds a remedy (replacement) to a seller's return terms when it isn't offered yet */
async function ensureRemedy(ctx, sellerKey, remedy) {
  const t = ctx.sellerToken(sellerKey);
  const terms = await ctx.api.get('/api/seller/returns/terms', t);
  const cur = terms.terms ?? terms;
  const remedies = cur.remedies ?? [];
  if (remedies.includes(remedy)) return;
  const input = { ...pick(cur, ['windowDays', 'changeOfMindPaidBy', 'freeReturns', 'returnAddress', 'returnContactEmail', 'receivingHours', 'responseTargetBusinessDays', 'refundTargetDays']), remedies: [...new Set([...remedies, remedy])] };
  await ctx.api.put('/api/seller/returns/terms', t, input);
  ctx.log.info(`${sellerKey}: return terms now offer ${input.remedies.join(', ')}`);
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]));

async function openCase(ctx, rec, orderItemIds, { category, problemType, desiredRemedy, message }) {
  const t = ctx.customerToken(rec.customer);
  return ctx.api.post('/api/store/support/cases', t, { kind: 'order_problem', category, orderId: rec.orderId, orderItemIds, problemType, message, desiredRemedy }, { idem: `design-case-${rec.ref}` });
}

/** The checkout session an order came from (support view of checkouts, by order ref) */
async function checkoutSessionOf(ctx, rec) {
  if (rec.checkoutSessionId) return rec.checkoutSessionId;
  const list = await ctx.api.get(`/api/admin/checkout/sessions?q=${encodeURIComponent(rec.ref)}&limit=20`, ctx.staff).catch(() => ({ items: [] }));
  const row = (list.items ?? []).find((r) => r.orderId === rec.orderId || r.orderRef === rec.ref);
  if (row) return row.id ?? row.sessionId;
  throw new Error(`no checkout session found for ${rec.ref}`);
}

async function helpArticleSlug(ctx, articleId) {
  if (articleId) {
    const a = await ctx.api.get(`/api/admin/content/help/articles/${articleId}`, ctx.staff).catch(() => null);
    const slug = a?.slug ?? a?.article?.slug;
    if (slug) return slug;
  }
  return 'returning-an-item-bought-from-a-marketplace-seller';
}

/** Empties the cart and adds the lines again (quantities exactly as given) */
async function fillCart(ctx, token, lines) {
  await clearCart(ctx, token);
  for (const [key, quantity] of lines) {
    const o = ctx.state.get(`offer.${key}`);
    if (!o) continue;
    await ctx.api.post('/api/store/cart/cart/items', token, { offerId: o.id, quantity, source: 'product_page' }).catch((err) => ctx.log.warn(`cart: ${key} not added (${err.message})`));
  }
}

/** A checkout from the cart up to Place order with a dev card token; returns { sessionId, outcome, orderRef } */
async function placeFromCart(ctx, token, { providerToken }) {
  const { api, state } = ctx;
  let s = await api.post('/api/store/checkout/sessions', token, { source: 'cart' });
  s = await api.put(`/api/store/checkout/sessions/${s.id}/address`, token, { addressId: state.section('customers').jordan.addresses.home });
  s = await api.put(`/api/store/checkout/sessions/${s.id}/payment-method`, token, { kind: 'new_card', providerToken, label: 'Visa' });
  if (!s.readyToPlace) throw new Error(`checkout not ready: ${JSON.stringify(s.blockers)}`);
  const placed = await api.post(`/api/store/checkout/sessions/${s.id}/place`, token, { quoteVersion: s.quoteVersion, expectedTotal: s.totals.total, acceptTerms: true, channel: 'web', returnUrl: RETURN_URL }, { idem: randomUUID() });
  ctx.log.info(`checkout ${s.id.slice(0, 8)} with ${providerToken}: ${placed.outcome}${placed.orderRef ? ` (${placed.orderRef})` : ''} · ${money(s.totals.total)}`);
  return { sessionId: s.id, outcome: placed.outcome, orderRef: placed.orderRef ?? null };
}

/** The guest order: a visitor session checks out with an email and a new address */
async function guestOrder(ctx) {
  const { api, state, log } = ctx;
  // an earlier run may have placed it before it could be recorded: look it up by the guest's email first
  const known = await api.get(`/api/admin/orders/orders?q=${encodeURIComponent(GUEST.email)}&limit=20`, ctx.staff).catch(() => ({ items: [] }));
  let placed = (known.items ?? []).filter((r) => r.guest).map((r) => ({ orderId: r.id, orderRef: r.ref }))[0];
  let sessionId = null;
  if (!placed) {
    const t = await ctx.storeVisitorSession();
    for (const [key, quantity] of GUEST.lines) await api.post('/api/store/cart/cart/items', t, { offerId: state.get(`offer.${key}`).id, quantity, source: 'product_page' });
    let s = await api.post('/api/store/checkout/sessions', t, { source: 'cart' });
    s = await api.put(`/api/store/checkout/sessions/${s.id}/contact`, t, { email: GUEST.email, phone: GUEST.address.phone, createAccountAfter: false, marketingOptIn: false });
    s = await api.put(`/api/store/checkout/sessions/${s.id}/address`, t, { address: GUEST.address });
    s = await api.put(`/api/store/checkout/sessions/${s.id}/payment-method`, t, { kind: 'new_card', providerToken: 'tok_mastercard', label: 'Mastercard' });
    if (!s.readyToPlace) throw new Error(`guest checkout not ready: ${JSON.stringify(s.blockers)}`);
    placed = await api.post(`/api/store/checkout/sessions/${s.id}/place`, t, { quoteVersion: s.quoteVersion, expectedTotal: s.totals.total, acceptTerms: true, channel: 'web', returnUrl: RETURN_URL }, { idem: randomUUID() });
    if (placed.outcome !== 'accepted') throw new Error(`guest order not accepted (${placed.outcome})`);
    sessionId = s.id;
  }
  const order = await poll(`${placed.orderRef} to open`, async () => {
    const d = await api.get(`/api/admin/orders/orders/${placed.orderId}`, ctx.staff);
    const o = d.order ?? d;
    return o.groups?.length ? o : null;
  }, { timeoutMs: 20_000 });
  const sellerKeys = Object.fromEntries(Object.entries(state.section('sellers')).map(([k, v]) => [v.sellerId, k]));
  const offerKeyById = Object.fromEntries(Object.entries(state.data.ids).filter(([k, v]) => k.startsWith('offer.') && v?.id).map(([k, v]) => [v.id, k.slice(6)]));
  const rec = {
    orderId: placed.orderId,
    ref: placed.orderRef,
    customer: null,
    guestEmail: GUEST.email,
    checkoutSessionId: sessionId,
    groups: (order.groups ?? []).map((g) => {
      const sellerId = g.seller?.id ?? g.sellerId ?? null;
      const official = (g.seller?.ownerType ?? g.ownerType) === 'official' || !sellerId;
      return { id: g.id, seller: official ? 'official' : (sellerKeys[sellerId] ?? null), sellerId: official ? null : sellerId, items: (g.items ?? []).map((i) => ({ id: i.id ?? i.itemId, offerKey: offerKeyById[i.offer?.offerId ?? i.offerId] ?? null, quantity: i.quantity })) };
    }),
    done: {},
  };
  state.section('orders')[GUEST.key] = rec;
  state.save();
  log.created('order', `${rec.ref} for guest ${GUEST.email}: ${GUEST.lines.map(([k, q]) => `${q}× ${k}`).join(', ')}`);
  return rec;
}

