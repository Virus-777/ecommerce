// Step 9: orders through the real checkout (dev payment adapter, providerToken tok_visa), then fulfilment:
// sellers prepare, report delays and record shipments (tracking in the carrier's format); the Official Store
// warehouse waves, picks, packs and buys labels; the carrier reports scans and deliveries by signed webhook.
// After-sales: customer cancellation (seller accepts), seller item cancellation, return requested, and a full
// return → refund (sent by the payments.process-refunds job).
import { randomUUID } from 'node:crypto';
import { ApiError, poll, sleep } from '../lib/http.mjs';
import { trackingNumber } from '../lib/codes.mjs';
import { ORDERS, SELLERS } from '../data.mjs';

const RETURN_URL = 'http://127.0.0.1:3000/checkout/confirmation';
const SPECIAL = new Set([2, 3, 4, 5, 6, 7, 12, 13, 14, 15, 22, 23]);
const money = (m) => `$${(m.amount / 100).toFixed(2)}`;

const sellerKeyOf = (ctx, sellerId) => (sellerId ? (SELLERS.find((s) => ctx.state.section('sellers')[s.key]?.sellerId === sellerId)?.key ?? null) : 'official');

/** Cart line ids anywhere in a CartView */
function cartLineIds(cart) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (typeof v.id === 'string' && typeof v.offerId === 'string' && typeof v.quantity === 'number') out.push(v.id);
    else Object.values(v).forEach(walk);
  };
  walk(cart);
  return [...new Set(out)];
}

async function clearCart(ctx, t) {
  const cart = await ctx.api.get('/api/store/cart/cart', t);
  for (const id of cartLineIds(cart)) await ctx.api.del(`/api/store/cart/cart/items/${id}`, t).catch(() => {});
}

/** Places one order; returns the stored record { orderId, ref, groups } */
async function place(ctx, o) {
  const { api, state, log } = ctx;
  const orders = state.section('orders');
  if (orders[o.key]?.orderId) return orders[o.key];
  const c = state.section('customers')[o.customer];
  const t = ctx.customerToken(o.customer);
  await clearCart(ctx, t);
  for (const [offerKey, quantity] of o.lines) {
    const offer = state.get(`offer.${offerKey}`);
    if (!offer) throw new Error(`${o.key}: offer ${offerKey} not created`);
    await api.post('/api/store/cart/cart/items', t, { offerId: offer.id, quantity, source: 'product_page' });
  }
  let session = await api.post('/api/store/checkout/sessions', t, { source: 'cart' });
  session = await api.put(`/api/store/checkout/sessions/${session.id}/address`, t, { addressId: c.addresses[o.address] });
  if (o.coupon) {
    const r = await api.post(`/api/store/checkout/sessions/${session.id}/coupons`, t, { code: o.coupon });
    if (r.result?.status !== 'applied') log.warn(`${o.key}: coupon ${o.coupon} ${r.result?.status}: ${r.result?.reason ?? r.result?.rejectionCode ?? ''}`);
  }
  session = await api.put(`/api/store/checkout/sessions/${session.id}/payment-method`, t, { kind: 'new_card', providerToken: 'tok_visa', label: 'Visa' });
  if (!session.readyToPlace) throw new Error(`${o.key}: checkout not ready: ${JSON.stringify(session.blockers)}`);
  const amounts = [session.totals.total, ...(session.totals.perPackage ?? []).map((p) => p.total)];
  const special = amounts.filter((m) => SPECIAL.has(m.amount % 100));
  if (special.length) log.warn(`${o.key}: total ${special.map(money).join(', ')} ends in cents the dev card processor treats specially; the payment may fail`);
  const placed = await api.post(`/api/store/checkout/sessions/${session.id}/place`, t, { quoteVersion: session.quoteVersion, expectedTotal: session.totals.total, acceptTerms: true, channel: 'web', returnUrl: RETURN_URL }, { idem: randomUUID() });
  if (placed.outcome !== 'accepted' || !placed.orderId) throw new Error(`${o.key}: order not accepted (${placed.outcome}): ${JSON.stringify(placed).slice(0, 300)}`);
  const order = await poll(`${placed.orderRef} to open`, async () => {
    const d = await api.get(`/api/store/orders/orders/${placed.orderId}`, t);
    return d.lifecycle === 'open' && d.groups?.length ? d : null;
  }, { timeoutMs: 20_000 });
  const offerKeyById = Object.fromEntries(Object.entries(state.data.ids).filter(([k, v]) => k.startsWith('offer.') && v?.id).map(([k, v]) => [v.id, k.slice(6)]));
  const rec = {
    orderId: order.id,
    ref: order.ref,
    customer: o.customer,
    total: order.totals.total.amount,
    groups: order.groups.map((g) => ({
      id: g.id,
      seller: sellerKeyOf(ctx, g.seller.ownerType === 'official' ? null : g.seller.id),
      sellerId: g.seller.id ?? null,
      fulfilledBy: g.fulfilledBy,
      items: g.items.map((i) => ({ id: i.id, offerKey: offerKeyById[i.offer.offerId] ?? null, productId: i.product.productId, quantity: i.quantity })),
    })),
    done: {},
  };
  orders[o.key] = rec;
  state.save();
  log.created('order', `${order.ref} for ${o.customer}: ${o.lines.map(([k, q]) => `${q}× ${k}`).join(', ')} · ${money(order.totals.total)}${o.coupon ? ` (${o.coupon})` : ''}`);
  return rec;
}

const groupOf = (rec, seller) => rec.groups.find((g) => g.seller === seller);
const itemOf = (rec, offerKey) => rec.groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g }))).find((i) => i.offerKey === offerKey);

/** The carrier's scans for one parcel, signed like the carrier would */
async function carrierEvents(ctx, carrier, tracking, codes) {
  const where = { accepted: 'Origin facility', in_transit: 'In transit', out_for_delivery: 'Portland, OR', delivered: 'Portland, OR' };
  for (const code of codes) {
    const body = { id: `evt-${tracking}-${code}`, trackingNumber: tracking, code, at: new Date().toISOString(), description: code.replace(/_/g, ' '), location: where[code] ?? 'Portland, OR' };
    await ctx.api.webhook(`/webhooks/shipping/carriers/${carrier}/events`, body, body.id);
    await sleep(300);
  }
}

async function sellerToken(ctx, g) {
  if (!g.seller || g.seller === 'official') throw new Error('not a seller package');
  return ctx.sellerToken(g.seller);
}

async function prepare(ctx, g) {
  const t = await sellerToken(ctx, g);
  await ctx.api.post(`/api/seller/orders/orders/${g.id}/start-preparing`, t, undefined).catch((err) => {
    if (!(err instanceof ApiError) || err.status !== 409) throw err;
  });
}

async function sellerShip(ctx, rec, g, { carrier = 'ups', service = 'UPS Ground' } = {}) {
  const t = await sellerToken(ctx, g);
  await prepare(ctx, g);
  const detail = await ctx.api.get(`/api/seller/orders/orders/${g.id}`, t);
  const items = (detail.items ?? [])
    .map((i) => ({ orderItemId: i.itemId ?? i.id, quantity: i.quantity - (i.cancelledQuantity ?? 0) - (i.shippedQuantity ?? 0) }))
    .filter((i) => i.quantity > 0);
  if (!items.length) throw new Error(`${rec.ref}: nothing left to ship in the ${g.seller} package`);
  const tracking = trackingNumber(carrier, `${rec.ref}:${g.id}`);
  await ctx.api.post('/api/seller/shipping/shipments', t, { groupId: g.id, carrierCode: carrier, serviceName: service, trackingNumber: tracking, shippedAt: new Date().toISOString(), items });
  ctx.log.info(`${rec.ref}: ${g.seller} shipped with ${service} ${tracking}`);
  return { carrier, tracking };
}

/** Official Store package through the warehouse: wave → pick → package → label → pack */
async function officialShip(ctx, rec) {
  const { api, state } = ctx;
  const t = ctx.staff;
  const row = await poll(`${rec.ref} in the warehouse queue`, async () => {
    const list = await api.get(`/api/admin/warehouse/fulfillments?q=${encodeURIComponent(rec.ref)}&limit=20`, t);
    return (list.items ?? []).find((r) => r.orderRef === rec.ref) ?? null;
  }, { timeoutMs: 20_000 });
  if (['awaiting_pick'].includes(row.status)) {
    const wave = await api.post('/api/admin/warehouse/waves', t, { locationId: state.get('official.locationId'), fulfillmentIds: [row.id] });
    await api.post(`/api/admin/warehouse/waves/${wave.id}/start`, t, undefined);
  }
  let ful = await api.get(`/api/admin/warehouse/fulfillments/${row.id}`, t);
  const bins = state.get('official.bins') ?? [];
  for (const l of ful.lines ?? []) {
    for (let n = l.picked; n < l.quantity; n++) ful = await api.post(`/api/admin/warehouse/pick-lines/${l.id}/pick`, t, { binCode: l.binCode ?? bins[0]?.code, itemCode: l.sku, quantity: 1 });
  }
  let pkg = (ful.packages ?? []).find((p) => p.status !== 'voided');
  if (!pkg) pkg = await api.post(`/api/admin/warehouse/fulfillments/${row.id}/packages`, t, { station: 'PACK-1' });
  if (pkg.status === 'open') {
    for (const it of pkg.items ?? []) {
      const need = (it.quantity ?? 1) - (it.scanned ?? 0);
      for (let n = 0; n < need; n++) await api.post(`/api/admin/warehouse/packages/${pkg.id}/scan`, t, { code: it.sku });
    }
    const boxes = await api.get('/api/admin/warehouse/box-types', t);
    const box = (Array.isArray(boxes) ? boxes : (boxes.items ?? [])).find((b) => b.name === 'M box');
    await api.patch(`/api/admin/warehouse/packages/${pkg.id}`, t, { ...(box ? { boxTypeId: box.id } : {}), weight: { value: 3, unit: 'lb', fromScale: true } });
  }
  let label;
  if (pkg.status === 'open') label = await api.post(`/api/admin/warehouse/packages/${pkg.id}/label`, t, { format: 'pdf' }, { idem: randomUUID() });
  const tracking = label?.trackingNumber ?? pkg.trackingNumber;
  const carrierName = String(label?.carrier ?? pkg.carrier ?? 'ups').toLowerCase();
  const carrier = ['ups', 'usps', 'fedex', 'ontrac'].find((c) => carrierName.includes(c)) ?? 'ups';
  await api.post(`/api/admin/warehouse/packages/${pkg.id}/pack`, t, undefined).catch((err) => {
    if (!(err instanceof ApiError) || err.status !== 409) throw err;
  });
  ctx.log.info(`${rec.ref}: Official Store package packed, ${label?.service ?? carrier} ${tracking}`);
  return { carrier, tracking };
}

async function runGroupPlan(ctx, rec, seller, plan) {
  const g = groupOf(rec, seller);
  if (!g) return ctx.log.warn(`${rec.ref}: no ${seller} package`);
  const what = typeof plan === 'string' ? plan : plan.do;
  const doneKey = `plan.${seller}`;
  if (rec.done[doneKey] === what) return;
  if (seller === 'official') {
    if (what === 'deliver' || what === 'ship') {
      const parcel = rec.done[`parcel.${seller}`] ?? (await officialShip(ctx, rec));
      rec.done[`parcel.${seller}`] = parcel;
      ctx.state.save();
      await carrierEvents(ctx, parcel.carrier, parcel.tracking, what === 'deliver' ? ['accepted', 'in_transit', 'out_for_delivery', 'delivered'] : ['accepted', 'in_transit']);
    }
  } else if (what === 'prepare') await prepare(ctx, g);
  else if (what === 'delay') {
    await prepare(ctx, g);
    await ctx.api.post(`/api/seller/orders/orders/${g.id}/report-delay`, ctx.sellerToken(seller), { reason: 'supplier_delay', expectedDispatchBy: new Date(Date.now() + 6 * 86_400_000).toISOString(), note: 'Our linen supplier is a week late with this colour.' });
    ctx.log.info(`${rec.ref}: ${seller} reported a delay`);
  } else if (what === 'ship' || what === 'deliver') {
    const parcel = rec.done[`parcel.${seller}`] ?? (await sellerShip(ctx, rec, g, typeof plan === 'object' ? plan : {}));
    rec.done[`parcel.${seller}`] = parcel;
    ctx.state.save();
    await carrierEvents(ctx, parcel.carrier, parcel.tracking, what === 'deliver' ? ['accepted', 'in_transit', 'out_for_delivery', 'delivered'] : ['accepted', 'in_transit']);
  }
  rec.done[doneKey] = what;
  ctx.state.save();
}

async function cancelItem(ctx, rec, a) {
  const it = itemOf(rec, a.item);
  if (!it) return ctx.log.warn(`${rec.ref}: no item ${a.item} to cancel`);
  await ctx.api.post(`/api/seller/orders/orders/${it.group.id}/cancel-items`, ctx.sellerToken(it.group.seller), { items: [{ itemId: it.id, quantity: it.quantity }], reasonCode: a.reason, note: a.note }, { idem: randomUUID() });
  ctx.log.info(`${rec.ref}: ${it.group.seller} cancelled ${a.item}`);
}

async function cancelAll(ctx, rec, a) {
  const t = ctx.customerToken(rec.customer);
  const items = rec.groups.flatMap((g) => g.items.map((i) => ({ itemId: i.id, quantity: i.quantity })));
  const res = await ctx.api.post(`/api/store/orders/orders/${rec.orderId}/cancellations`, t, { items, reasonCode: a.reason, note: a.note }, { idem: randomUUID() });
  for (const r of res.requests ?? []) {
    if (r.status === 'requested') {
      const g = rec.groups.find((x) => x.id === r.groupId);
      if (g?.seller && g.seller !== 'official') await ctx.api.post(`/api/seller/orders/orders/${r.groupId}/cancellation-requests/${r.id}/accept`, ctx.sellerToken(g.seller), undefined, { idem: randomUUID() });
    }
  }
  ctx.log.info(`${rec.ref}: cancelled by the customer`);
}

async function returnRequest(ctx, rec, a) {
  const it = itemOf(rec, a.item);
  const t = ctx.customerToken(rec.customer);
  const created = await ctx.api.post('/api/store/returns/requests', t, { orderId: rec.orderId, items: [{ orderItemId: it.id, quantity: 1 }], reason: a.reason, details: a.details, remedy: 'refund' }, { idem: randomUUID() });
  const ret = created.returns[0];
  ctx.log.info(`${rec.ref}: return ${ret.ref} requested for ${a.item}`);
  return ret;
}

async function returnRefund(ctx, rec, a) {
  const ret = rec.done.returnId ? { id: rec.done.returnId } : await returnRequest(ctx, rec, a);
  rec.done.returnId = ret.id;
  ctx.state.save();
  const it = itemOf(rec, a.item);
  const t = ctx.sellerToken(it.group.seller);
  const step = (path, body, o) => ctx.api.post(`/api/seller/returns/requests/${ret.id}/${path}`, t, body, o).catch((err) => {
    if (!(err instanceof ApiError) || err.status !== 409) throw err;
  });
  await step('approve', { labelMethod: 'prepaid_qr', note: 'Sorry it didn’t fit. Show the QR code at any UPS Store.' });
  await step('receive', { note: 'Parcel arrived at our shop' });
  await step('inspection', { conditionOutcome: 'as_described', grade: 'like_new', proposedStockOutcome: 'restock', checks: [{ label: 'Tags attached, unused', passed: true }], notes: 'Unused with tags' });
  await step('remedy', { kind: 'full_refund', explanation: 'Full refund for the returned pack' }, { idem: randomUUID() });
  // a refund waiting for review is approved by a Business Owner (dev step-up code)
  const refunds = await ctx.api.get(`/api/admin/returns/refunds?orderId=${rec.orderId}&limit=20`, ctx.staff).catch(() => ({ items: [] }));
  for (const r of refunds.items ?? []) {
    if (!['under_review', 'pending_approval', 'requested'].includes(r.status)) continue;
    await ctx.api.post(`/api/admin/returns/refunds/${r.id}/approve`, ctx.approver, { note: 'Returned unused, seller confirmed', stepUpCode: '000000' }, { idem: randomUUID() }).catch((err) => ctx.log.warn(`${rec.ref}: refund ${r.ref} not approved (${err.message})`));
  }
  ctx.log.info(`${rec.ref}: return refunded by the seller; payments.process-refunds sends the money`);
}

async function waitForRefunds(ctx) {
  const pending = Object.values(ctx.state.section('orders')).filter((r) => r.done?.returnId && !r.done.refundSent);
  for (const rec of pending) {
    const t = ctx.customerToken(rec.customer);
    const view = await poll(`refund of ${rec.ref} (payments.process-refunds job)`, async () => {
      const v = await ctx.api.get(`/api/store/returns/requests/${rec.done.returnId}`, t);
      return /refunded|closed|completed/.test(v.status) || /sent|succeeded/.test(JSON.stringify(v.refund ?? v.refunds ?? '')) ? v : null;
    }, { timeoutMs: 120_000, intervalMs: 5000, quiet: true });
    if (view) {
      rec.done.refundSent = true;
      ctx.state.save();
      ctx.log.info(`${rec.ref}: refund sent (return ${view.ref ?? ''} ${view.status})`);
    } else ctx.log.warn(`${rec.ref}: refund not sent yet after 2 minutes (is JOBS_ENABLED=true?); it will go out when payments.process-refunds runs`);
  }
}

export async function ordersStep(ctx) {
  const failed = [];
  for (const o of ORDERS) {
    try {
      const rec = await place(ctx, o);
      for (const a of o.before ?? []) {
        const k = `before.${a.do}.${a.item ?? ''}`;
        if (rec.done[k]) continue;
        if (a.do === 'cancel_item') await cancelItem(ctx, rec, a);
        rec.done[k] = true;
        ctx.state.save();
      }
      for (const [seller, plan] of Object.entries(o.plan ?? {})) {
        try {
          await runGroupPlan(ctx, rec, seller, plan);
        } catch (err) {
          ctx.log.warn(`${rec.ref}: ${seller} ${typeof plan === 'string' ? plan : plan.do} failed: ${err.message}`);
        }
      }
      for (const a of o.after ?? []) {
        const k = `after.${a.do}.${a.item ?? ''}`;
        if (rec.done[k]) continue;
        try {
          if (a.do === 'cancel_all') await cancelAll(ctx, rec, a);
          else if (a.do === 'return_request') await returnRequest(ctx, rec, a);
          else if (a.do === 'return_refund') await returnRefund(ctx, rec, a);
          rec.done[k] = true;
          ctx.state.save();
        } catch (err) {
          ctx.log.warn(`${rec.ref}: ${a.do} failed: ${err.message}`);
        }
      }
    } catch (err) {
      failed.push(o.key);
      ctx.log.warn(`order ${o.key} failed: ${err.message}`);
    }
  }
  // Jordan clips the Official Store coupon (shown as clipped on the Deals page)
  const clip = ctx.state.get('campaign.officialFive');
  if (clip && !ctx.state.get('clip.jordan')) {
    try {
      await ctx.api.post(`/api/store/promotions/coupons/${clip}/clip`, ctx.customerToken('jordan'), undefined);
      ctx.state.set('clip.jordan', true);
      ctx.log.info('Jordan clipped "$5 off your first Official Store order"');
    } catch (err) {
      ctx.log.warn(`coupon clip failed: ${err.message}`);
    }
  }
  await waitForRefunds(ctx);
  if (failed.length) throw new Error(`orders failed: ${failed.join(', ')}`);
}
