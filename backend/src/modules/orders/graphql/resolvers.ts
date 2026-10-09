import { AppError } from '../../../kernel/errors/index.js';
import type { GraphQLContext, ModuleResolvers } from '../../../kernel/graphql/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import { format as formatMoney } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import type { AdminOrderDetail, CancellationRequest, OrderDetail, OrderItem, OrderSummary, SellerGroup, SellerOrderDetail } from '../../../spec/orders.js';
import { SHIPPED_OR_LATER, is } from '../domain/rules.js';
import type { Agg } from '../service/core.js';
import type { StoreViewer } from '../service/reads.js';
import type { OrdersService } from '../service.js';

/* ---------------------------------------------------------------- REST shapes → GraphQL shapes (enums in capitals, Money.formatted) */

const upper = (s: string | null | undefined) => (s ? s.toUpperCase().replace(/-/g, '_') : (s ?? null));
const lower = (s: string | null | undefined) => (s ? s.toLowerCase() : undefined);
const money = (m: common.Money | null | undefined) => (m ? { ...m, formatted: formatMoney(m) } : null);
const ACTOR_KIND: Record<string, string> = { customer: 'CUSTOMER', visitor: 'GUEST', seller: 'SELLER', staff: 'STAFF' };
const actor = (a: common.Actor | null | undefined) => (a ? { kind: ACTOR_KIND[a.kind] ?? 'SYSTEM', id: a.id ?? null, name: a.name ?? null } : null);
const timeline = (list: readonly common.TimelineEvent[]) => list.map((t) => ({ ...t, actor: actor(t.actor) }));
const deadline = (d: common.Deadline | null | undefined) => (d ? { dueAt: d.dueAt, state: upper(d.state) } : null);
const pageInput = (p: common.PageInput | null | undefined): common.PageInput => ({ ...(p?.cursor ? { cursor: p.cursor } : {}), ...(p?.page ? { page: p.page } : {}), ...(p?.limit ? { limit: p.limit } : {}) });
const lazy = <T,>(f: () => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= f());
};

const sellerLabel = (s: SellerGroup['seller']) => ({ id: s.id ?? null, name: s.name, slug: s.slug, official: s.ownerType === 'official', verified: s.verified, logo: s.logo ?? null });

const cancellation = (c: CancellationRequest) => ({
  id: c.id,
  groupId: c.groupId,
  initiatedBy: upper(c.initiatedBy),
  reasonCode: c.reasonCode,
  reason: c.reason ?? null,
  items: c.items,
  status: upper(c.status),
  respondBy: deadline(c.respondBy),
  decidedBy: actor(c.decidedBy),
  decidedAt: c.decidedAt ?? null,
  declineReason: c.declineReason ?? null,
  refundPreview: {
    ...c.refundPreview,
    lines: c.refundPreview.lines.map((l) => ({ ...l, itemAmount: money(l.itemAmount), discountShare: money(l.discountShare), shippingRefund: money(l.shippingRefund), taxRefund: money(l.taxRefund), refund: money(l.refund) })),
    itemAmount: money(c.refundPreview.itemAmount),
    discountShare: money(c.refundPreview.discountShare),
    shippingRefund: money(c.refundPreview.shippingRefund),
    taxRefund: money(c.refundPreview.taxRefund),
    total: money(c.refundPreview.total),
  },
  refundStatus: upper(c.refundStatus),
  createdAt: c.createdAt,
  timeline: timeline(c.timeline),
});

function item(i: OrderItem, extra?: { shippedQuantity: number; cancelledQuantity: number }) {
  return {
    id: i.id,
    productId: i.product.productId,
    variantId: i.product.variantId,
    offerId: i.offer.offerId,
    title: i.title,
    variantLabel: i.variantLabel,
    image: i.image ?? null,
    quantity: i.quantity,
    unitPrice: money(i.unitPrice),
    lineSubtotal: money(i.lineSubtotal),
    state: upper(i.state),
    stateLabel: i.stateLabel,
    product: { ...i.product, options: Object.entries(i.product.options ?? {}).map(([name, value]) => ({ name, value })) },
    offerTerms: { ...i.offer, condition: upper(i.offer.condition), compareAtPrice: money(i.offer.compareAtPrice) },
    returnTerms: { ...i.returnTerms, returnShippingPaidBy: upper(i.returnTerms.returnShippingPaidBy), policyVersionId: i.returnTerms.policyVersionId ?? null },
    shipmentId: i.shipmentId ?? null,
    deliveredAt: i.deliveredAt ?? null,
    returnWindowEndsAt: i.returnWindowEndsAt ?? null,
    splitFromItemId: i.splitFromItemId ?? null,
    replacementOfItemId: i.replacementOfItemId ?? null,
    afterSales: { ...i.afterSales, refundStatus: upper(i.afterSales.refundStatus), refundedAmount: money(i.afterSales.refundedAmount) },
    discounts: i.discounts.map((d) => ({ ...d, amount: money(d.amount), fundedBy: upper(d.fundedBy) })),
    shippingShare: money(i.shippingShare),
    taxShare: money(i.taxShare),
    paidAmount: money(i.paidAmount),
    stateNote: i.stateNote ?? null,
    actions: i.actions.map(upper),
    shippedQuantity: extra?.shippedQuantity ?? (is(SHIPPED_OR_LATER, i.state) ? i.quantity : 0),
    cancelledQuantity: extra?.cancelledQuantity ?? (i.state === 'cancelled' ? i.quantity : 0),
  };
}

function group(g: SellerGroup, s: SellerOrderDetail | undefined, cancellations: CancellationRequest[]) {
  const d = g.delivery;
  return {
    id: g.id,
    packageLabel: g.packageLabel,
    seller: sellerLabel(g.seller),
    shipsFrom: g.shipsFrom,
    fulfilledBy: upper(g.fulfilledBy),
    delivery: { methodName: d.methodName, carrier: d.carrier ?? null, service: d.service ?? null, price: money(d.price), free: d.free, fundedBy: upper(d.fundedBy), arrivalFrom: d.arrival.from, arrivalTo: d.arrival.to, dispatchBy: d.dispatchBy },
    dispatchDeadline: deadline(g.dispatchDeadline),
    status: upper(g.status),
    statusLabel: g.statusLabel,
    items: g.items.map((i) => {
      const si = s?.items.find((x) => x.itemId === i.id);
      return item(i, si ? { shippedQuantity: si.shippedQuantity, cancelledQuantity: si.cancelledQuantity } : undefined);
    }),
    totals: { items: money(g.totals.items), discounts: money(g.totals.discounts), shipping: money(g.totals.shipping), tax: money(g.totals.tax), total: money(g.totals.total) },
    cancellations: cancellations.filter((c) => c.groupId === g.id).map(cancellation),
    estimateLabel: g.estimateLabel,
    returnTermsSummary: g.returnTermsSummary,
    handlingNote: g.handlingNote,
    alert: g.alert ? { ...g.alert, tone: upper(g.alert.tone), caseRef: g.alert.caseRef ?? null } : null,
    deadlineLabel: s ? (s as SellerOrderDetail & { deadlineLabel?: string }).deadlineLabel ?? '' : '',
    dispatchResult: s?.dispatchResult ?? null,
    shipTo: s?.shipTo ?? null,
    giftNote: s?.giftNote ?? null,
    hidePricesOnSlip: s?.hidePricesOnSlip ?? false,
    itemsSummary: s ? (s as SellerOrderDetail & { itemsSummary?: string }).itemsSummary ?? '' : '',
    units: s ? s.items.reduce((n, i) => n + (i.cancelledQuantity ? 0 : i.quantity), 0) : 0,
    money: s
      ? {
          itemSubtotal: money(s.money.itemSubtotal),
          sellerDiscounts: money(s.money.sellerDiscounts),
          shippingCharged: money(s.money.shippingCharged),
          shippingLabel: s.money.shippingLabel,
          platformFeeEstimate: money(s.money.platformFeeEstimate),
          earningsEstimate: money(s.money.earningsEstimate),
          earningsNote: s.money.earningsNote,
        }
      : null,
    timeline: timeline(s?.timeline ?? []),
    nextAction: upper((s as SellerOrderDetail & { nextAction?: string } | undefined)?.nextAction ?? 'view'),
    allowedActions: (s?.allowedActions ?? []).map(upper),
  };
}

function order(o: OrderDetail, x: { summary?: OrderSummary; seller?: SellerOrderDetail[]; admin?: AdminOrderDetail; cancellations: CancellationRequest[]; buyerName?: string }) {
  const seller = (id: string) => x.seller?.find((s) => s.id === id);
  const t = o.totals;
  const pr = o.progress;
  const a = x.admin;
  return {
    id: o.id,
    ref: o.ref,
    placedAt: o.placedAt,
    acceptedAt: o.acceptedAt ?? null,
    groups: o.groups.map((g) => group(g, seller(g.id), x.cancellations)),
    paymentAccepted: o.lifecycle !== 'payment_pending' && pr.payment.state !== 'failed',
    buyerName: x.buyerName ?? null,
    mixedOrderNote: x.seller?.[0]?.mixedOrderNote ?? null,
    contact: { ...o.contact, kind: upper(o.contact.kind), customerId: o.contact.customerId ?? null, phone: o.contact.phone ?? null },
    lifecycle: upper(o.lifecycle),
    status: upper(o.status.value),
    statusFlags: o.status.flags.map(upper),
    statusLabel: o.statusLabel,
    summaryLine: o.summaryLine,
    itemCount: x.summary?.itemCount ?? o.totals.itemCount,
    sellerCount: x.summary?.sellerCount ?? o.groups.length,
    packageCount: x.summary?.packageCount ?? o.groups.length,
    thumbnails: x.summary?.thumbnails ?? [],
    note: x.summary?.note ?? null,
    progress: {
      payment: { ...pr.payment, state: upper(pr.payment.state), amountCharged: money(pr.payment.amountCharged), chargedAt: pr.payment.chargedAt ?? null },
      delivery: { ...pr.delivery, state: upper(pr.delivery.state) },
      returns: { ...pr.returns, state: upper(pr.returns.state), note: pr.returns.note ?? null },
    },
    totals: {
      ...t,
      items: money(t.items),
      discounts: t.discounts.map((d) => ({ ...d, amount: money(d.amount), fundedBy: upper(d.fundedBy) })),
      discountTotal: money(t.discountTotal),
      shippingTotal: money(t.shippingTotal),
      tax: money(t.tax),
      total: money(t.total),
      refundedSoFar: money(t.refundedSoFar),
      expectedRefunds: t.expectedRefunds.map((e) => ({ ...e, ref: e.ref ?? null, amount: money(e.amount) })),
    },
    deliveryAddress: o.deliveryAddress,
    addressNote: o.addressNote,
    policyVersions: o.policyVersions.map((p) => ({ ...p, policyKey: upper(p.policyKey) })),
    documents: o.documents.map((d) => ({ ...d, kind: upper(d.kind), groupId: d.groupId ?? null })),
    timeline: timeline(o.timeline),
    canCancelSomething: o.canCancelSomething,
    actions: (x.summary?.actions ?? []).map(upper),
    channel: upper(o.channel),
    customer: a ? { ...a.customer, customerId: a.customer.customerId ?? null, phone: a.customer.phone ?? null } : null,
    flags: (a?.flags ?? []).map((f) => ({ ...f, kind: upper(f.kind), tone: upper(f.tone) })),
    alerts: (a?.alerts ?? []).map((al) => ({ ...al, tone: upper(al.tone), caseRef: al.caseRef ?? null })),
    afterSales: (a?.afterSales ?? []).map((s) => ({ ...s, amount: money(s.amount), owner: s.owner ?? null })),
    moneyBySeller: (a?.moneyBySeller ?? []).map((m) => ({
      ...m,
      seller: sellerLabel(m.seller),
      items: money(m.items),
      platformFunded: money(m.platformFunded),
      sellerFunded: money(m.sellerFunded),
      customerPaid: money(m.customerPaid),
      marketplaceFee: money(m.marketplaceFee),
      sellerEarnings: money(m.sellerEarnings),
    })),
    couponFundingNote: a?.couponFundingNote ?? null,
    notes: (a?.notes ?? []).map((n) => ({ ...n, author: actor(n.author) })),
    history: timeline(a?.history ?? []),
    allowedActions: (a?.allowedActions ?? []).map(upper),
  };
}

/* ---------------------------------------------------------------- batching per request (one call per field and tick) */

type Batch<V> = { ids: Set<string>; promise: Promise<Map<string, V>> };
const batches = new WeakMap<object, Map<string, Batch<unknown>>>();

function load<V>(ctx: GraphQLContext, key: string, id: string, fetch: (ids: string[]) => Promise<Map<string, V>>): Promise<V | undefined> {
  let perCtx = batches.get(ctx);
  if (!perCtx) batches.set(ctx, (perCtx = new Map()));
  let batch = perCtx.get(key) as Batch<V> | undefined;
  if (!batch) {
    const ids = new Set<string>();
    const promise = new Promise<Map<string, V>>((resolve, reject) => {
      setImmediate(() => {
        perCtx!.delete(key);
        fetch([...ids]).then(resolve, reject);
      });
    });
    batch = { ids, promise };
    perCtx.set(key, batch as Batch<unknown>);
  }
  batch.ids.add(id);
  return batch.promise.then((m) => m.get(id));
}

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "orders", …)` in graphql/schema.ts).
 * Every area keeps REST's record scope: the store sees the customer's or guest's own orders, the seller area
 * only the caller's own groups and seller-safe fields, the admin area everything (contact masked without
 * orders.customers.view-contact).
 */
export const resolvers = (service: OrdersService): ModuleResolvers => {
  const { core, views, reads } = service;

  const customerIdOf = (ctx: GraphQLContext) =>
    lazy(async () => {
      const accountId = ctx.principal?.kind === 'customer' ? ctx.principal.accountId : null;
      if (!accountId) return null;
      return (await core.soft('customers', 'customer of account', (c) => c.getCustomerByUserId(accountId)))?.id ?? null;
    });
  const viewers = new WeakMap<object, () => Promise<string | null>>();
  const customerId = (ctx: GraphQLContext) => {
    let f = viewers.get(ctx);
    if (!f) viewers.set(ctx, (f = customerIdOf(ctx)));
    return f();
  };
  const storeViewer = async (ctx: GraphQLContext): Promise<StoreViewer> => ({
    customerId: await customerId(ctx),
    guestSessionId: ctx.principal?.kind === 'visitor' ? (ctx.principal.guestSessionId ?? ctx.principal.sessionId) : null,
  });
  const canContact = (ctx: GraphQLContext) => ctx.can('orders.customers.view-contact');
  const cancellationsOf = (agg: Agg, groupIds?: Set<string>) => agg.cancellations.filter((c) => !groupIds || groupIds.has(c.group_id)).map((c) => views.cancellation(agg, c));

  async function storeOrder(agg: Agg) {
    const detail = await reads.storeDetail(agg);
    return order(detail, { summary: views.summary(agg), cancellations: cancellationsOf(agg) });
  }

  async function sellerOrder(agg: Agg, sellerId: string) {
    const v = await reads.sellerOrder(agg, sellerId, await core.cfg());
    if (!v) return null;
    const ids = new Set(v.groups.map((g) => g.id));
    const cfg = await core.cfg();
    const rows = new Map(agg.groups.filter((g) => ids.has(g.id)).map((g) => [g.id, views.sellerRow(agg, g, cfg)]));
    const groups = v.groups.map((g) => ({ ...g, deadlineLabel: rows.get(g.id)?.deadlineLabel, itemsSummary: rows.get(g.id)?.itemsSummary, nextAction: rows.get(g.id)?.nextAction }));
    return order(v.order, { seller: groups, cancellations: cancellationsOf(agg, ids), buyerName: v.groups[0]?.buyerName });
  }

  async function adminOrder(agg: Agg, ctx: GraphQLContext) {
    const cfg = await core.cfg();
    const a = await reads.adminDetail(agg, await canContact(ctx), cfg);
    const timelineRows = await core.timelineOf(agg.order.id);
    const fees = await reads.fees(agg, agg.groups);
    const groups = agg.groups.map((g) => {
      const d = views.sellerDetail(agg, g, timelineRows, { ...cfg, sellerAddressVisibleDays: 100_000 }, fees);
      const row = views.sellerRow(agg, g, cfg);
      return { ...d, deadlineLabel: row.deadlineLabel, itemsSummary: row.itemsSummary, nextAction: row.nextAction };
    });
    return order(a.order, { summary: views.summary(agg), admin: a, seller: groups, cancellations: cancellationsOf(agg) });
  }

  const byRef = async (ref: string) => {
    const o = (await core.repo.find('orders', { ref: String(ref ?? '').trim().toUpperCase() }))[0];
    return o ? core.load(o.id) : undefined;
  };

  const ordersById = (ctx: GraphQLContext, id: string) => load(ctx, 'orders', id, async (ids) => core.loadMany(ids.filter(isUuid)));

  /** Case.order, Return.order, RefundRequest.order: same visibility as order / sellerOrder / orderAdmin */
  const orderField = async (root: { orderId?: string | null; order?: { id?: string } | null }, _args: unknown, ctx: GraphQLContext) => {
    const id = root?.orderId ?? root?.order?.id;
    if (!id || !isUuid(id)) return null;
    const agg = await ordersById(ctx, id);
    if (!agg) return null;
    if (ctx.area === 'store') return (await reads.visibleToShopper(agg, await storeViewer(ctx))) ? storeOrder(agg) : null;
    if (ctx.area === 'seller') return ctx.principal?.sellerId ? sellerOrder(agg, ctx.principal.sellerId) : null;
    return adminOrder(agg, ctx);
  };

  const sellerIdOf = (ctx: GraphQLContext) => {
    const id = ctx.principal?.sellerId;
    if (!id) throw new AppError('UNAUTHORIZED', 'Choose the seller account to act for');
    return id;
  };

  return {
    Query: {
      order: async (_root, args: { ref: string }, ctx) => {
        const agg = await byRef(args.ref);
        if (!agg || !(await reads.visibleToShopper(agg, await storeViewer(ctx)))) return null;
        return storeOrder(agg);
      },
      orders: async (_root, args: { filter?: { q?: string | null; range?: string | null; from?: string | null; to?: string | null; tab?: string | null } | null; paging?: common.PageInput | null }, ctx) => {
        const id = await customerId(ctx);
        if (!id) return { items: [], nextCursor: null, total: 0 };
        const f = args.filter ?? {};
        const filter = { ...(f.q ? { q: f.q } : {}), ...(f.range ? { range: lower(f.range) } : {}), ...(f.from ? { from: f.from } : {}), ...(f.to ? { to: f.to } : {}), ...(f.tab ? { tab: lower(f.tab) } : {}) };
        const { f: rf } = reads.customerFilter(id, filter);
        const rows = await core.repo.customerOrders(id, rf, reads.page(pageInput(args.paging)));
        const aggs = await core.loadMany(rows.items.map((r) => r.id));
        const items = [];
        for (const r of rows.items) items.push(await storeOrder(aggs.get(r.id)!));
        return { ...rows, items };
      },
      sellerOrder: async (_root, args: { ref: string }, ctx) => {
        const agg = await byRef(args.ref);
        return agg ? sellerOrder(agg, sellerIdOf(ctx)) : null;
      },
      sellerOrders: async (_root, args: { filter?: { tab?: string | null; tabs?: string[] | null; q?: string | null; placedFrom?: string | null; placedTo?: string | null; overdueOnly?: boolean | null; sort?: string | null } | null; paging?: common.PageInput | null }, ctx) => {
        const sellerId = sellerIdOf(ctx);
        const f = args.filter ?? {};
        const q = {
          ...(f.tab ? { tab: lower(f.tab) } : {}),
          ...(f.tabs?.length ? { tabs: f.tabs.map((t) => t.toLowerCase()) } : {}),
          ...(f.q ? { q: f.q } : {}),
          ...(f.placedFrom ? { placedFrom: f.placedFrom } : {}),
          ...(f.placedTo ? { placedTo: f.placedTo } : {}),
          ...(f.overdueOnly ? { overdueOnly: true } : {}),
          ...(f.sort ? { sort: lower(f.sort) } : {}),
        };
        const rows = await core.repo.sellerGroups(sellerId, reads.sellerFilter(q), reads.page(pageInput(args.paging)), core.now());
        const aggs = await core.loadMany(rows.items.map((g) => g.order_id));
        const seen = new Set<string>();
        const items = [];
        for (const g of rows.items) {
          if (seen.has(g.order_id)) continue;
          seen.add(g.order_id);
          const o = await sellerOrder(aggs.get(g.order_id)!, sellerId);
          if (o) items.push(o);
        }
        return { ...rows, items };
      },
      sellerOrderCounts: async (_root, _args, ctx) => reads.sellerCounts(sellerIdOf(ctx)),
      orderAdmin: async (_root, args: { ref: string }, ctx) => {
        const agg = await byRef(args.ref);
        return agg ? adminOrder(agg, ctx) : null;
      },
      ordersAdmin: async (_root, args: { filter?: Record<string, string | null | undefined> | null; paging?: common.PageInput | null }, ctx) => {
        const f = args.filter ?? {};
        const q = Object.fromEntries(
          Object.entries(f)
            .filter(([, v]) => v !== null && v !== undefined && v !== '')
            .map(([k, v]) => [k, ['sellerType', 'fulfillmentStatus', 'paymentState', 'flag'].includes(k) ? lower(v as string) : v]),
        );
        const staffId = ctx.principal?.accountId ?? null;
        const rows = await core.repo.adminOrders(await reads.adminFilter(q, staffId), reads.page(pageInput(args.paging)), core.now());
        const aggs = await core.loadMany(rows.items.map((r) => r.id));
        const items = [];
        for (const r of rows.items) items.push(await adminOrder(aggs.get(r.id)!, ctx));
        return { ...rows, items };
      },
    },
    Customer: {
      orderCounts: async (root: { id: string }, args: { range?: string | null }) => service.countOrdersByTab(root.id, lower(args?.range ?? undefined)),
      delayedItems: async (root: { id: string }) =>
        (await service.listDelayedItemsForCustomer(root.id)).map((d) => ({ ...d, newDispatchBy: d.newDispatchBy ?? null, newArrivalFrom: d.newArrival?.from ?? null, newArrivalTo: d.newArrival?.to ?? null, options: d.options.map(upper), caseRef: d.caseRef ?? null })),
    },
    Seller: {
      orderCounts: async (root: { id: string }, _args: unknown, ctx: GraphQLContext) =>
        (await load(ctx, 'sellerCounts', root.id, async (ids) => new Map(Object.entries(await service.countOrdersForSellers(ids))))) ?? null,
    },
    Case: { order: orderField },
    Return: { order: orderField },
    RefundRequest: { order: orderField },
  };
};
