// Step 10: reviews on delivered items, seller feedback, public responses (seller and Official Store), product
// questions with answers labelled Seller, Marketly staff or Customer. Anything the automatic checks hold is
// published from the moderation queue (Morgan, reason legitimate_experience).
import { ApiError } from '../lib/http.mjs';
import { FEEDBACK, PRODUCTS, QUESTIONS, REVIEWS } from '../data.mjs';

const itemOf = (rec, offerKey) => rec?.groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g }))).find((i) => i.offerKey === offerKey);
const already = (err) => err instanceof ApiError && (err.status === 409 || /ALREADY|DUPLICATE/.test(err.code));

async function respond(ctx, sellerKey, targetType, targetId, text) {
  if (sellerKey === 'official') return ctx.api.post('/api/admin/reviews/official-store/responses', ctx.staff, { targetType, targetId, text });
  return ctx.api.post('/api/seller/reviews/responses', ctx.sellerToken(sellerKey), { targetType, targetId, text });
}

async function reviews(ctx) {
  const { api, state, log } = ctx;
  const orders = state.section('orders');
  const created = [];
  for (const r of REVIEWS) {
    const key = `review.${r.order}.${r.item}`;
    const rec = orders[r.order];
    const item = itemOf(rec, r.item);
    if (!item) {
      log.warn(`review ${r.order}/${r.item} skipped: order not placed`);
      continue;
    }
    let saved = state.get(key);
    if (!saved) {
      try {
        const res = await api.post('/api/store/reviews/me/reviews', ctx.customerToken(rec.customer), { orderItemId: item.id, rating: r.rating, headline: r.headline, text: r.text, showName: true });
        saved = state.set(key, { id: res.review.id, status: res.status ?? res.review.status, seller: item.group.seller, productId: item.productId });
        created.push(res.review.id);
        log.created('review', `${'★'.repeat(r.rating)} "${r.headline}" by ${rec.customer} [${saved.status}]`);
      } catch (err) {
        if (already(err)) {
          log.reused('review', `${r.order}/${r.item}`);
          continue;
        }
        log.warn(`review ${r.order}/${r.item} not written (${err.message}); is the item delivered?`);
        continue;
      }
    }
    const text = r.reply ?? r.official;
    if (text && !saved.responded) {
      try {
        await respond(ctx, r.official ? 'official' : saved.seller, 'product_review', saved.id, text);
        saved.responded = true;
        state.set(key, saved);
        log.created('review response', `${r.official ? 'Marketly Official Store' : saved.seller} → "${r.headline}"`);
      } catch (err) {
        if (!already(err)) log.warn(`response to "${r.headline}" failed: ${err.message}`);
      }
    }
  }
  return created;
}

async function feedback(ctx) {
  const { api, state, log } = ctx;
  const orders = state.section('orders');
  for (const f of FEEDBACK) {
    const key = `feedback.${f.order}.${f.seller}`;
    const rec = orders[f.order];
    const sellerId = ctx.state.section('sellers')[f.seller]?.sellerId;
    if (!rec || !sellerId) continue;
    let saved = state.get(key);
    if (!saved) {
      try {
        const res = await api.post('/api/store/reviews/me/feedback', ctx.customerToken(rec.customer), { orderId: rec.orderId, sellerId, asDescribed: f.asDescribed, dispatchRating: f.dispatchRating, communicationRating: f.communicationRating, comment: f.comment });
        saved = state.set(key, { id: res.feedback.id });
        log.created('seller feedback', `${rec.customer} → ${f.seller} (${f.dispatchRating}/5)`);
      } catch (err) {
        if (!already(err)) log.warn(`feedback ${f.order} → ${f.seller} failed: ${err.message}`);
        continue;
      }
    }
    if (f.reply && !saved.responded) {
      try {
        await respond(ctx, f.seller, 'seller_feedback', saved.id, f.reply);
        saved.responded = true;
        state.set(key, saved);
      } catch (err) {
        if (!already(err)) log.warn(`reply to feedback ${f.order} failed: ${err.message}`);
      }
    }
  }
}

async function questions(ctx) {
  const { api, state, log } = ctx;
  for (const q of QUESTIONS) {
    const key = `question.${q.key}`;
    const productId = state.get(`product.${q.product}`)?.id;
    if (!productId) continue;
    let saved = state.get(key);
    if (!saved) {
      const res = await api.post(`/api/store/reviews/products/${productId}/questions`, ctx.customerToken(q.asker), { text: q.text });
      saved = state.set(key, { id: res.id, answers: [] });
      log.created('question', `"${q.text}" (${PRODUCTS.find((p) => p.key === q.product).title.split(' ').slice(0, 3).join(' ')})`);
    }
    for (const [i, a] of q.answers.entries()) {
      if (saved.answers.includes(i)) continue;
      try {
        if (a.by === 'staff') await api.post(`/api/admin/reviews/questions/${saved.id}/answers`, ctx.staff, { text: a.text, secondCheck: false });
        else if (a.by.startsWith('seller:')) await api.post(`/api/seller/reviews/questions/${saved.id}/answers`, ctx.sellerToken(a.by.slice(7)), { text: a.text });
        else if (a.by.startsWith('customer:')) await api.post(`/api/store/reviews/questions/${saved.id}/answers`, ctx.customerToken(a.by.slice(9)), { text: a.text });
        saved.answers.push(i);
        state.set(key, saved);
        log.created('answer', `${a.by.split(':')[0]} → "${q.text.slice(0, 40)}…"`);
      } catch (err) {
        if (!already(err)) log.warn(`answer by ${a.by} to "${q.text}" failed: ${err.message}`);
      }
    }
  }
}

/** Publishes held content the seed wrote (reviews, questions, answers, responses) */
async function moderation(ctx) {
  const ours = new Set(Object.entries(ctx.state.data.ids).filter(([k]) => /^(review|question|feedback)\./.test(k)).map(([, v]) => v?.id));
  let items = [];
  try {
    items = await ctx.api.all('/api/admin/reviews/moderation-items?status=open', ctx.approver);
  } catch (err) {
    return ctx.log.warn(`moderation queue not read: ${err.message}`);
  }
  for (const m of items) {
    if (!['auto_held', 'qa_check', 'response_check'].includes(m.queue) && !ours.has(m.contentId)) continue;
    try {
      await ctx.api.post(`/api/admin/reviews/moderation-items/${m.id}/decide`, ctx.approver, { decision: m.contentType === 'seller_response' ? 'publish' : 'publish', reasonCode: 'legitimate_experience' });
      ctx.log.info(`moderation: published held ${m.contentType} "${(m.title ?? '').slice(0, 50)}"`);
    } catch (err) {
      ctx.log.warn(`moderation item ${m.id} (${m.contentType}) not published: ${err.message}`);
    }
  }
}

export async function reviewsStep(ctx) {
  await reviews(ctx);
  await feedback(ctx);
  await questions(ctx);
  await moderation(ctx);
}
