/**
 * Database checks after the flows: small named, read-only queries over the collections the generated schemas
 * define (src/modules/<module>/schema.ts; collection `<module>.<table>`, a single-column primary key in `_id`,
 * money in integer cents). Each check prints one pass/fail line with what it looked at or what is wrong.
 *
 * The checks cover every document in the database, not only this run's: the data of earlier runs must stay
 * consistent too. Where a check needs what the API answered (the balances sellers saw), it uses what the flows
 * kept in sim.world.
 */
import { readdirSync, readFileSync } from 'node:fs';
import type { MongoStore } from '../../src/kernel/mongo/index.js';
import type { Sim } from './sim.js';

type Db = MongoStore['db'];
type Doc = Record<string, any>;

export interface CheckResult {
  name: string;
  ok: boolean;
  /** What was looked at, or what is wrong */
  detail: string;
}

/** Up to n examples of what failed, for the report */
const examples = (xs: unknown[], n = 3) => `${xs.length} found, e.g. ${JSON.stringify(xs.slice(0, n))}`;

const SPEC_DIR = new URL('../../../docs/api/spec/modules/', import.meta.url);

export async function runChecks(db: Db, sim: Sim): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const check = async (name: string, fn: () => Promise<string | string[] | null>) => {
    try {
      const problem = await fn();
      const problems = Array.isArray(problem) ? problem : problem ? [problem] : [];
      out.push(problems.length ? { name, ok: false, detail: problems.join('; ') } : { name, ok: true, detail: '' });
    } catch (err) {
      out.push({ name, ok: false, detail: `the check itself failed: ${(err as Error).message}` });
    }
  };
  const all = (c: string, filter: Doc = {}) => db.collection(c).find(filter).toArray() as Promise<Doc[]>;

  /* ---------------------------------------------------------------- orders */

  const orders = await all('orders.orders');
  const groups = await all('orders.seller_groups');
  const items = await all('orders.order_items');
  const groupsOf = new Map<string, Doc[]>();
  for (const g of groups) groupsOf.set(g.order_id, [...(groupsOf.get(g.order_id) ?? []), g]);
  const itemsOf = new Map<string, Doc[]>();
  for (const i of items) itemsOf.set(i.order_id, [...(itemsOf.get(i.order_id) ?? []), i]);
  const placed = orders.filter((o) => o.lifecycle !== 'payment_pending');
  const intents = new Map((await all('payments.intents')).map((i) => [i._id, i]));

  await check(`every placed order has its groups, items and payment intent (${placed.length} orders)`, async () => {
    const bad = placed.filter((o) => !(groupsOf.get(o._id)?.length && itemsOf.get(o._id)?.length && intents.has(o.payment_intent_id)));
    const strayItems = items.filter((i) => !(groupsOf.get(i.order_id) ?? []).some((g) => g._id === i.group_id));
    return [bad.length ? `orders missing groups, items or intent: ${examples(bad.map((o) => o.ref))}` : '', strayItems.length ? `items whose group is not in their order: ${examples(strayItems.map((i) => i._id))}` : ''].filter(Boolean);
  });

  await check('order totals = items − discounts + shipping + tax, and items = Σ unit price × quantity; groups add up to the order', async () => {
    const problems: string[] = [];
    for (const o of placed) {
      const its = itemsOf.get(o._id) ?? [];
      const sumItems = its.reduce((s, i) => s + i.unit_price * i.quantity, 0);
      const gs = groupsOf.get(o._id) ?? [];
      const sum = (k: string) => gs.reduce((s, g) => s + (g[k] ?? 0), 0);
      if (o.total !== o.items_total - o.discount_total + o.shipping_total + o.tax_total) problems.push(`${o.ref}: total ${o.total} ≠ ${o.items_total} − ${o.discount_total} + ${o.shipping_total} + ${o.tax_total}`);
      if (sumItems !== o.items_total) problems.push(`${o.ref}: items_total ${o.items_total} ≠ Σ lines ${sumItems}`);
      for (const k of ['items_total', 'discount_total', 'shipping_total', 'tax_total', 'total']) if (sum(k) !== o[k]) problems.push(`${o.ref}: Σ groups ${k} ${sum(k)} ≠ ${o[k]}`);
      const paid = its.reduce((s, i) => s + i.paid_amount, 0);
      if (paid !== o.total) problems.push(`${o.ref}: Σ items paid ${paid} ≠ total ${o.total}`);
    }
    return problems.length ? examples(problems, 4) : null;
  });

  /* ---------------------------------------------------------------- payments */

  const refunds = await all('payments.refunds');
  const captures = await all('payments.captures');
  await check('captured per order = order total, less cancelled items never captured; the order and the intent agree', async () => {
    const problems: string[] = [];
    for (const o of placed) {
      const intent = intents.get(o.payment_intent_id);
      if (!intent) continue;
      const cancelledPaid = (itemsOf.get(o._id) ?? []).filter((i) => i.state === 'cancelled').reduce((s, i) => s + i.paid_amount, 0);
      const succeeded = captures.filter((c) => c.intent_id === intent._id && c.status === 'succeeded').reduce((s, c) => s + c.amount, 0);
      if (intent.captured_amount !== succeeded) problems.push(`${o.ref}: intent captured ${intent.captured_amount} ≠ Σ succeeded captures ${succeeded}`);
      if (intent.captured_amount !== o.total && intent.captured_amount !== o.total - cancelledPaid) problems.push(`${o.ref}: captured ${intent.captured_amount}, total ${o.total}, cancelled ${cancelledPaid}`);
      if (o.captured_total !== intent.captured_amount) problems.push(`${o.ref}: order captured_total ${o.captured_total} ≠ intent ${intent.captured_amount}`);
    }
    return problems.length ? examples(problems, 4) : null;
  });

  await check('refunds ≤ captures per payment; sent refunds = refunded on the intent and the order', async () => {
    const problems: string[] = [];
    for (const intent of intents.values()) {
      const rs = refunds.filter((r) => r.intent_id === intent._id);
      if (!rs.length) continue;
      const live = rs.filter((r) => r.status !== 'cancelled' && r.status !== 'failed').reduce((s, r) => s + r.amount, 0);
      const sent = rs.filter((r) => r.status === 'sent').reduce((s, r) => s + r.amount, 0);
      if (live > intent.captured_amount) problems.push(`${intent.ref}: refunds ${live} > captured ${intent.captured_amount}`);
      if (sent !== intent.refunded_amount) problems.push(`${intent.ref}: sent refunds ${sent} ≠ intent refunded ${intent.refunded_amount}`);
      const order = orders.find((o) => o._id === intent.order_id);
      if (order && order.refunded_total !== sent) problems.push(`${order.ref}: order refunded_total ${order.refunded_total} ≠ sent refunds ${sent}`);
    }
    return problems.length ? examples(problems, 4) : null;
  });

  /* ---------------------------------------------------------------- inventory and offers */

  const levels = await all('inventory.stock_levels');
  const lines = await all('inventory.reservation_lines');
  const itemById = new Map(items.map((i) => [i._id, i]));
  await check('stock is never negative', async () => {
    const neg = levels.filter((l) => ['available', 'reserved', 'incoming', 'damaged_held', 'returned'].some((k) => (l[k] ?? 0) < 0));
    return neg.length ? examples(neg.map((l) => ({ stockItem: l.stock_item_id, available: l.available, reserved: l.reserved }))) : null;
  });

  await check('reserved stock = what open order items still hold (reservation lines minus fulfilled and released)', async () => {
    const OPEN_ITEM = new Set(['pending_payment', 'confirmed', 'preparing', 'delayed', 'cancellation_requested']);
    const held = new Map<string, number>();
    const problems: string[] = [];
    for (const l of lines) {
      const left = l.quantity - (l.fulfilled_qty ?? 0) - (l.released_qty ?? 0);
      if (left < 0) problems.push(`line ${l._id}: fulfilled + released > quantity`);
      if (left > 0) held.set(`${l.stock_item_id}|${l.location_id}`, (held.get(`${l.stock_item_id}|${l.location_id}`) ?? 0) + left);
      const item = l.order_item_id ? itemById.get(l.order_item_id) : undefined;
      if (item && left > 0 && !OPEN_ITEM.has(item.state)) problems.push(`order item ${item._id} is ${item.state} but still holds ${left}`);
      if (item?.state === 'cancelled' && left > 0) problems.push(`cancelled item ${item._id} did not release its stock`);
    }
    for (const lv of levels) {
      const h = held.get(`${lv.stock_item_id}|${lv.location_id}`) ?? 0;
      if ((lv.reserved ?? 0) !== h) problems.push(`stock item ${lv.stock_item_id}: reserved ${lv.reserved} ≠ held by reservation lines ${h}`);
    }
    return problems.length ? examples(problems, 4) : null;
  });

  await check("every cancelled order item released its stock (its reservation line's released quantity covers it)", async () => {
    const cancelled = items.filter((i) => i.state === 'cancelled');
    const bad = cancelled.filter((i) => {
      const ls = lines.filter((l) => l.order_item_id === i._id);
      return ls.length && ls.reduce((s, l) => s + l.quantity - (l.fulfilled_qty ?? 0) - (l.released_qty ?? 0), 0) > 0;
    });
    return bad.length ? examples(bad.map((i) => i._id)) : null;
  });

  await check('offers on sale have stock behind them (active offers point to a stock item)', async () => {
    const stockIds = new Set((await all('inventory.stock_items')).map((s) => s._id));
    const offers = await all('offers.offers', { status: 'active' });
    const bad = offers.filter((o) => o.stock_item_id && !stockIds.has(o.stock_item_id));
    return bad.length ? examples(bad.map((o) => o._id)) : null;
  });

  /* ---------------------------------------------------------------- finance */

  const ledger = await all('finance.ledger_entries');
  const accounts = await all('finance.seller_accounts');
  // An entry's bucket is where it was booked. A sale's lot later moves pending → available (release, or reversal
  // after a full refund) by its state, without a new entry, so a bucket is not the sum of the entries booked in it:
  // the total is, and pending is what the lots still pending hold (plus pending entries outside any lot).
  const lotsBySeller = new Map<string, any[]>();
  for (const l of await all('finance.earnings_lots')) lotsBySeller.set(l.seller_id, [...(lotsBySeller.get(l.seller_id) ?? []), l]);
  await check('ledger entries per seller add up to the seller account (total, and pending = lots still pending)', async () => {
    const problems: string[] = [];
    for (const a of accounts) {
      const es = ledger.filter((e) => e.seller_id === a._id);
      const total = es.reduce((s, e) => s + e.amount, 0);
      if (total !== a.pending + a.available + a.held) problems.push(`seller ${a._id}: Σ entries ${total} ≠ account total ${a.pending + a.available + a.held}`);
      const pendingLots = (lotsBySeller.get(a._id) ?? []).filter((l) => l.state === 'pending').reduce((s, l) => s + l.net, 0);
      const pendingLoose = es.filter((e) => e.bucket === 'pending' && !e.lot_id).reduce((s, e) => s + e.amount, 0);
      if (pendingLots + pendingLoose !== a.pending) problems.push(`seller ${a._id}: pending lots ${pendingLots} + entries outside lots ${pendingLoose} ≠ account pending ${a.pending}`);
    }
    return problems.length ? examples(problems, 4) : null;
  });

  await check('the balances sellers saw through the API equal their stored account', async () => {
    const problems: string[] = [];
    const byId = new Map(accounts.map((a) => [a._id, a]));
    for (const [sellerId, b] of sim.world.balances) {
      const a = byId.get(sellerId);
      if (!a) problems.push(`seller ${sellerId}: no account`);
      else for (const bucket of ['pending', 'available', 'held'] as const) if (a[bucket] !== b[bucket]) problems.push(`seller ${sellerId}: API ${bucket} ${b[bucket]} ≠ account ${a[bucket]}`);
    }
    return sim.world.balances.size === 0 ? 'no balances were read (finance flow did not run)' : problems.length ? examples(problems, 4) : null;
  });

  await check("every delivered seller item produced the seller's earning and the platform's fee", async () => {
    const lots = new Set((await all('finance.earnings_lots')).map((l) => l.order_item_id));
    const fees = new Map((await all('finance.fee_charges')).map((f) => [f.order_item_id, f]));
    const sellerGroup = new Set(groups.filter((g) => g.owner_type === 'seller').map((g) => g._id));
    const delivered = items.filter((i) => i.delivered_at && sellerGroup.has(i.group_id));
    const problems: string[] = [];
    for (const i of delivered) {
      if (!lots.has(i._id)) problems.push(`item ${i._id}: no earnings lot`);
      const fee = fees.get(i._id);
      if (!fee) problems.push(`item ${i._id}: no fee charge`);
      else if (!(fee.fee > 0)) problems.push(`item ${i._id}: fee ${fee.fee}`);
      const sale = ledger.some((e) => e.type === 'sale' && (e.ref_id === i._id || e.ref_id === i.order_id));
      if (!sale) problems.push(`item ${i._id}: no sale entry on the ledger`);
    }
    return problems.length ? examples(problems, 4) : null;
  });

  /* ---------------------------------------------------------------- after-sales links */

  const orderIds = new Set(orders.map((o) => o._id));
  await check('returns, refund requests, cancellations and payment refunds point to existing orders and items', async () => {
    const problems: string[] = [];
    for (const r of await all('returns.returns')) if (!orderIds.has(r.order_id)) problems.push(`return ${r.ref}: order ${r.order_id} missing`);
    const returnsById = new Map((await all('returns.returns')).map((r) => [r._id, r]));
    for (const ri of await all('returns.return_items')) {
      const item = itemById.get(ri.order_item_id);
      const ret = returnsById.get(ri.return_id);
      if (!item) problems.push(`return item ${ri._id}: order item ${ri.order_item_id} missing`);
      else if (ret && item.order_id !== ret.order_id) problems.push(`return item ${ri._id}: item of another order`);
    }
    for (const rr of await all('returns.refund_requests')) if (!orderIds.has(rr.order_id)) problems.push(`refund request ${rr.ref}: order missing`);
    for (const c of await all('orders.cancellations')) {
      if (!orderIds.has(c.order_id)) problems.push(`cancellation ${c._id}: order missing`);
      for (const l of (c.items ?? []) as { itemId?: string; item_id?: string }[]) {
        const id = l.itemId ?? l.item_id;
        if (id && !itemById.has(id)) problems.push(`cancellation ${c._id}: item ${id} missing`);
      }
    }
    for (const r of refunds) if (r.order_id && !orderIds.has(r.order_id)) problems.push(`payment refund ${r.ref}: order missing`);
    return problems.length ? examples(problems, 4) : null;
  });

  await check('reviews are only on delivered items of the reviewer', async () => {
    const problems: string[] = [];
    for (const r of await all('reviews.product_reviews')) {
      const item = itemById.get(r.order_item_id);
      if (!item) problems.push(`review ${r._id}: order item missing`);
      else if (!item.delivered_at) problems.push(`review ${r._id}: item ${item._id} was not delivered`);
      else if (r.customer_id && orders.find((o) => o._id === item.order_id)?.customer_id !== r.customer_id) problems.push(`review ${r._id}: not the buyer`);
    }
    return problems.length ? examples(problems) : null;
  });

  /* ---------------------------------------------------------------- references and links inside each module */

  await check('order references are unique and look like MK-YYMMDD-NNNNN', async () => {
    const refs = orders.map((o) => o.ref);
    const dup = refs.filter((r, i) => refs.indexOf(r) !== i);
    const odd = refs.filter((r) => !/^MK-\d{6}-\d{5}$/.test(r));
    return [dup.length ? `duplicates: ${examples(dup)}` : '', odd.length ? `odd format: ${examples(odd)}` : ''].filter(Boolean);
  });

  const specs = readdirSync(SPEC_DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(new URL(f, SPEC_DIR), 'utf8')) as SpecFile);
  await check('every unique ref column holds unique values (all modules)', async () => {
    const problems: string[] = [];
    for (const s of specs) {
      for (const t of s.tables ?? []) {
        const ref = t.columns.ref;
        if (!ref || !/unique/.test(typeof ref === 'string' ? ref : ref.type)) continue;
        const dup = await db.collection(`${s.name}.${t.name}`).aggregate([{ $match: { ref: { $ne: null } } }, { $group: { _id: '$ref', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 3 }]).toArray();
        if (dup.length) problems.push(`${s.name}.${t.name}: ${dup.map((d) => d._id).join(', ')}`);
      }
    }
    return problems;
  });

  await check('no document references a missing id of its own module (every "→ table" column of the spec)', async () => {
    const problems: string[] = [];
    let columns = 0;
    for (const s of specs) {
      const pkOf = new Map<string, boolean>();
      for (const t of s.tables ?? []) pkOf.set(t.name, Object.values(t.columns).filter((v) => /\bpk\b/.test(typeof v === 'string' ? v : v.type)).length === 1);
      for (const t of s.tables ?? []) {
        for (const [col, v] of Object.entries(t.columns)) {
          const type = typeof v === 'string' ? v : v.type;
          const m = type.match(/^(\w+)\??(?: pk)?\s*→\s*(\w+)$/);
          if (!m || type.includes('[]')) continue;
          const target = m[2]!;
          if (!pkOf.get(target)) continue; // composite key: not one _id to look up
          const field = col === 'id' ? '_id' : col;
          columns++;
          const missing = await db
            .collection(`${s.name}.${t.name}`)
            .aggregate([
              { $match: { [field]: { $ne: null } } },
              { $group: { _id: `$${field}` } },
              { $lookup: { from: `${s.name}.${target}`, localField: '_id', foreignField: '_id', as: 'hit' } },
              { $match: { hit: { $size: 0 } } },
              { $limit: 3 },
            ])
            .toArray();
          if (missing.length) problems.push(`${s.name}.${t.name}.${col} → ${target}: ${missing.map((x) => x._id).join(', ')}`);
        }
      }
    }
    return problems.length ? problems : columns ? null : 'no reference columns found in the spec';
  });

  /* ---------------------------------------------------------------- audit and events */

  await check('audited staff actions of this run left audit entries (per module whose audited endpoints the run called)', async () => {
    const since = sim.startedAt;
    const entries = await db.collection('audit.entries').aggregate([{ $match: { at: { $gte: since } } }, { $group: { _id: '$module', n: { $sum: 1 } } }]).toArray();
    const byModule = new Map(entries.map((e) => [e._id as string, e.n as number]));
    const missing = [...sim.api.auditedModules].filter((m) => !byModule.has(m));
    return missing.length ? `no audit entry since the run started for: ${missing.join(', ')}` : null;
  });

  await check("search documents exist for this run's products", async () => {
    const productIds = [...new Set([...sim.world.sellers.flatMap((s) => s.offers), ...sim.world.official].map((o) => o.productId))];
    const docs = new Set((await db.collection('search.search_documents').find({ _id: { $in: productIds as never[] } }, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)));
    const missing = productIds.filter((p) => !docs.has(p));
    return productIds.length === 0 ? 'no products in this run' : missing.length ? examples(missing) : null;
  });

  await check("notifications were made for this run's placed orders (a notice or an email linked to the order)", async () => {
    const refs = sim.world.orders.map((o) => o.ref);
    const linked = new Set<string>();
    for (const c of ['notifications.notices', 'notifications.deliveries']) for (const d of await all(c, { linked_ref: { $in: refs } })) linked.add(d.linked_ref);
    const missing = refs.filter((r) => !linked.has(r));
    return refs.length === 0 ? 'no orders in this run' : missing.length ? examples(missing) : null;
  });

  await check("order snapshots keep their product images (media usage by orders for each order's images)", async () => {
    const usages = new Set((await all('media.usages', { module: 'orders', detached_at: null })).map((u) => `${u.ref_id}|${u.asset_id}`));
    const missing: string[] = [];
    for (const o of sim.world.orders) {
      for (const i of itemsOf.get(o.orderId) ?? []) {
        const img = i.product_snapshot?.imageId ?? i.product_snapshot?.image?.id;
        if (img && !usages.has(`${o.orderId}|${img}`)) missing.push(`${o.ref}: ${img}`);
      }
    }
    return missing.length ? examples([...new Set(missing)]) : null;
  });

  return out;
}

interface SpecFile {
  name: string;
  tables?: { name: string; columns: Record<string, string | { type: string }> }[];
}
