/**
 * Flow 6, after the sale:
 *   - a customer cancels an order before it ships (the seller confirms when the request needs it);
 *   - a customer returns a delivered item for a refund: seller approval, receipt, inspection, full refund (Finance
 *     approves when the refund waits for review);
 *   - a customer and a seller exchange messages about an order;
 *   - a customer reviews a delivered item and the seller replies;
 *   - a customer asks support about a refund; the support agent answers and resolves the case;
 *   - a customer reports a listing to Trust and Risk, who look at it and record a low risk.
 * Refunds are sent by the payments job (flow 7 runs it again and plays the card processor's webhooks).
 */
import { QUESTIONS_TO_SELLER, REVIEW_TEXTS, SELLER_ANSWERS, SELLER_REPLIES } from '../data.js';
import type { OrderWorld, SellerWorld, Sim } from '../sim.js';

const sellerOf = (sim: Sim, id: string | null) => sim.world.sellers.find((s) => s.sellerId === id);

/** Delivered orders of registered customers with a seller-shipped package */
const deliveredSellerOrders = (sim: Sim): (OrderWorld & { seller: SellerWorld })[] =>
  sim.world.orders
    .filter((o) => o.delivered && o.customer && o.groups.some((g) => g.fulfilledBy === 'seller'))
    .map((o) => ({ ...o, seller: sellerOf(sim, o.groups.find((g) => g.fulfilledBy === 'seller')!.sellerId)! }))
    .filter((o) => o.seller);

export async function cancellationFlow(sim: Sim): Promise<void> {
  const { api, run, world: w } = sim;
  const o = w.orders.find((x) => x.keep === 'cancel');
  if (!o?.customer) return run.fail({ step: 'an order to cancel', message: 'no order was kept back for a cancellation' });
  const s = o.customer.session;
  const g = o.groups[0]!;
  const items = g.items.map((i) => ({ itemId: i.id, quantity: i.quantity }));
  const preview = await api.call(s, 'POST', `/api/store/orders/orders/${o.orderId}/cancellation-preview`, { items });
  run.check('the preview refunds what was paid for the items', preview.total?.amount > 0, preview);
  const res = await api.call(s, 'POST', `/api/store/orders/orders/${o.orderId}/cancellations`, { items, reasonCode: 'ordered_by_mistake', note: 'Ordered the wrong colour' });
  for (const req of res.requests as { id: string; status: string; groupId: string }[]) {
    if (req.status === 'requested') {
      // the seller confirms the request (it has not shipped)
      const seller = sellerOf(sim, g.sellerId)!;
      const accepted = await api.call(seller.session, 'POST', `/api/seller/orders/orders/${req.groupId}/cancellation-requests/${req.id}/accept`);
      run.check('the seller accepted the cancellation', accepted.status === 'accepted', accepted);
    } else run.check('cancelled at once', req.status === 'accepted', req);
  }
  const after = await api.call(s, 'GET', `/api/store/orders/orders/${o.orderId}`);
  const states = (after.groups as { items: { state: string }[] }[]).flatMap((x) => x.items.map((i) => i.state));
  run.check('every item is cancelled', states.every((x) => x === 'cancelled'), states);
  o.cancelled = true;
}

export async function returnFlow(sim: Sim): Promise<void> {
  const { api, run, world: w, people } = sim;
  const o = deliveredSellerOrders(sim)[0];
  if (!o) return run.fail({ step: 'a delivered order to return', message: 'no delivered seller order' });
  const s = o.customer!.session;
  const g = o.groups.find((x) => x.fulfilledBy === 'seller')!;
  const item = g.items[0]!;
  const eligible = await api.call(s, 'POST', '/api/store/returns/eligibility', { orderId: o.orderId, items: [{ orderItemId: item.id, quantity: 1 }], reason: 'damaged' });
  run.check('the item can be returned', JSON.stringify(eligible).includes('true') || JSON.stringify(eligible).includes('eligible'), eligible);
  const created = await api.call(s, 'POST', '/api/store/returns/requests', { orderId: o.orderId, items: [{ orderItemId: item.id, quantity: 1 }], reason: 'damaged', details: 'The box was crushed and the item arrived with a cracked corner.', remedy: 'refund' });
  const ret = created.returns[0];
  const seller = o.seller.session;
  await api.call(seller, 'POST', `/api/seller/returns/requests/${ret.id}/approve`, { labelMethod: 'prepaid_qr', note: 'Sorry about that! Drop it at any UPS store.' });
  await api.call(seller, 'POST', `/api/seller/returns/requests/${ret.id}/receive`, { note: 'Parcel arrived at our shop' });
  await api.call(seller, 'POST', `/api/seller/returns/requests/${ret.id}/inspection`, { conditionOutcome: 'as_described', grade: 'damaged', proposedStockOutcome: 'damaged_stock', checks: [{ label: 'Damage matches the photos', passed: true }], notes: 'Cracked corner, carrier damage' });
  const remedy = await api.call(seller, 'POST', `/api/seller/returns/requests/${ret.id}/remedy`, { kind: 'full_refund', explanation: 'Full refund for the damaged item' });
  // a refund that waits for review is approved by Finance. Finance opens it from the approval link (the refund
  // request id): its role may approve refunds but not list return requests (returns.requests.view), see the report
  const fin = w.staff.finance!;
  const request = remedy.refundRequest as { id: string; status: string } | null;
  run.check('the remedy opened a refund request', Boolean(request), remedy);
  if (request!.status === 'under_review' || request!.status === 'requested') {
    const approved = await api.call(fin.session, 'POST', `/api/admin/returns/refunds/${request!.id}/approve`, { note: 'Damaged in transit, seller agreed', stepUpCode: await people.code(fin) });
    run.check('Finance approved the refund', ['approved', 'processing', 'sent'].includes(approved.status), approved.status);
  }
  await sim.job('payments.process-refunds');
  const view = await api.call(s, 'GET', `/api/store/returns/requests/${ret.id}`);
  run.check('the return is completed with a refund', ['completed', 'refunded'].includes(view.status) || /refund/i.test(String(view.status)), { status: view.status });
  const paid = await api.call(fin.session, 'GET', `/api/admin/payments/refunds?orderId=${o.orderId}`);
  run.check('payments holds the refund of the return', (paid.items as { origin: string }[]).some((r) => r.origin === 'return'), paid.items);
  o.returned = true;
  const original = w.orders.find((x) => x.orderId === o.orderId);
  if (original) original.returned = true;
}

export async function messagesFlow(sim: Sim): Promise<void> {
  const { api, run } = sim;
  const o = deliveredSellerOrders(sim)[1] ?? deliveredSellerOrders(sim)[0];
  if (!o) return run.fail({ step: 'an order to ask about', message: 'no delivered seller order' });
  const s = o.customer!.session;
  const started = await api.call(s, 'POST', '/api/store/messaging/conversations', { with: 'seller', orderId: o.orderId, sellerId: o.seller.sellerId, body: sim.pick(QUESTIONS_TO_SELLER), clientMessageId: crypto.randomUUID() });
  const conversationId = started.conversation.id as string;
  const inbox = await api.call(o.seller.session, 'GET', '/api/seller/messaging/conversations?limit=20');
  run.check('the seller sees the conversation', JSON.stringify(inbox.items).includes(conversationId), undefined);
  const reply = await api.call(o.seller.session, 'POST', `/api/seller/messaging/conversations/${conversationId}/messages`, { body: sim.pick(SELLER_ANSWERS), clientMessageId: crypto.randomUUID() });
  const thread = await api.call(s, 'GET', `/api/store/messaging/conversations/${conversationId}/messages`);
  run.check('the customer sees the reply', JSON.stringify(thread).includes(reply.id), undefined);
  await api.call(s, 'POST', `/api/store/messaging/conversations/${conversationId}/read`, { upToMessageId: reply.id });
  const unread = await api.call(s, 'GET', '/api/store/messaging/unread-count');
  run.check('nothing unread after reading', unread.messages === 0, unread);
}

export async function reviewFlow(sim: Sim): Promise<void> {
  const { api, run } = sim;
  const o = deliveredSellerOrders(sim).find((x) => !x.returned) ?? deliveredSellerOrders(sim)[0];
  if (!o) return run.fail({ step: 'a delivered item to review', message: 'no delivered seller order' });
  const s = o.customer!.session;
  const item = o.groups.find((g) => g.fulfilledBy === 'seller')!.items[0]!;
  const pending = await api.call(s, 'GET', '/api/store/reviews/me/pending');
  run.check('the delivered item waits for a review', JSON.stringify(pending).includes(item.id), undefined);
  const text = sim.pick(REVIEW_TEXTS);
  const review = await api.call(s, 'POST', '/api/store/reviews/me/reviews', { orderItemId: item.id, rating: sim.pick([4, 5, 5]), headline: text.headline, text: text.text, showName: true });
  run.check('the review is published or waits for moderation', ['published', 'pending'].includes(review.status), review.status);
  await api.call(s, 'POST', '/api/store/reviews/me/feedback', { orderId: o.orderId, sellerId: o.seller.sellerId, asDescribed: true, dispatchRating: 5, communicationRating: 5, comment: 'Fast and friendly, well packed.' });
  if (review.status === 'published') {
    const response = await api.call(o.seller.session, 'POST', '/api/seller/reviews/responses', { targetType: 'product_review', targetId: review.review.id, text: sim.pick(SELLER_REPLIES) });
    run.check('the seller replied', Boolean(response.id), response);
    const listed = await api.call(s, 'GET', `/api/store/reviews/products/${(await api.call(s, 'GET', `/api/store/orders/orders/${o.orderId}`)).groups.flatMap((g: any) => g.items).find((i: any) => i.id === item.id).product.productId}/reviews`);
    run.check('shoppers see the review with the reply', JSON.stringify(listed).includes(review.review.id) && JSON.stringify(listed).includes(response.id), undefined);
  }
}

export async function supportFlow(sim: Sim): Promise<void> {
  const { api, run, world: w } = sim;
  const o = w.orders.find((x) => x.cancelled && x.customer) ?? w.orders.find((x) => x.customer);
  if (!o) return run.fail({ step: 'an order to ask about', message: 'no customer order' });
  const s = o.customer!.session;
  const opened = await api.call(s, 'POST', '/api/store/support/cases', { kind: 'customer_help', category: 'refund_status', orderId: o.orderId, subject: 'When will my refund arrive?', message: 'I cancelled this order yesterday. When will the money be back on my card?', replyChannel: 'email' });
  const agent = w.staff.support!.session;
  const queue = await api.call(agent, 'GET', '/api/admin/support/cases?limit=50');
  run.check('the case is in the support queue', JSON.stringify(queue.items).includes(opened.id), undefined);
  await api.call(agent, 'GET', `/api/admin/support/cases/${opened.id}`);
  await api.call(agent, 'POST', `/api/admin/support/cases/${opened.id}/messages`, { body: 'Hi! Your refund was sent to your card. Banks usually show it within 3–5 business days.', audience: 'customer' });
  const view = await api.call(s, 'GET', `/api/store/support/cases/${opened.id}`);
  run.check('the customer sees the answer', JSON.stringify(view).includes('3–5 business days'), undefined);
  await api.call(s, 'POST', `/api/store/support/cases/${opened.id}/messages`, { body: 'Great, thank you!' });
  const resolved = await api.call(agent, 'POST', `/api/admin/support/cases/${opened.id}/resolve`, { summary: 'Explained the refund timing; customer satisfied.' });
  run.check('the case is resolved', /resolved|closed/.test(resolved.case?.status), resolved.case?.status);
}

export async function trustFlow(sim: Sim): Promise<void> {
  const { api, run, world: w } = sim;
  const c = w.customers.at(-1);
  const offer = w.sellers.at(-1)?.offers[0];
  if (!c || !offer) return run.fail({ step: 'a listing to report', message: 'no customer or offer' });
  const mine = await api.call(c.session, 'POST', '/api/store/trust/reports', { type: 'misleading_listing', subject: { type: 'offer', id: offer.offerId }, reason: 'photos_do_not_match', details: 'The photo shows a different colour from the one in the title.' });
  const tia = w.staff.trust!.session;
  const reports = await api.call(tia, 'GET', '/api/admin/trust/reports?limit=50');
  const report = (reports.items as { id: string; ref: string }[]).find((r) => r.ref === mine.ref || JSON.stringify(r).includes(offer.offerId));
  run.check('Trust and Risk see the report', Boolean(report), reports.items);
  await api.call(tia, 'POST', `/api/admin/trust/reports/${report!.id}/notes`, { body: 'Compared the photos: a lighting difference, not a different product.' });
  // an open report is assigned (here to herself) before it can be resolved
  await api.call(tia, 'POST', `/api/admin/trust/reports/${report!.id}/assign`, { staffId: w.staff.trust!.accountId });
  const resolved = await api.call(tia, 'POST', `/api/admin/trust/reports/${report!.id}/resolve`, { outcome: 'no_violation', summary: 'Same product; the photo was taken in warm light.', reporterOutcome: 'Thanks for reporting. We checked the listing and it matches the product.' });
  run.check('the report is resolved', /resolved|closed/.test(resolved.status), resolved.status);
}
