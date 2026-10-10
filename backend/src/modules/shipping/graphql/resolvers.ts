import { AppError } from '../../../kernel/errors/index.js';
import type { GraphQLContext, ModuleResolvers } from '../../../kernel/graphql/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import { format as formatMoney, money as makeMoney } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import type { CustomerNotice, DeliveryException, OfferEstimate, Shipment } from '../../../spec/shipping.js';
import { businessDaysLabel, rangeLabel } from '../domain/calendar.js';
import { destinationOf, locationLabel } from '../domain/geo.js';
import { STEPS, stepOf } from '../domain/tracking.js';
import { parcelLabel } from '../service/profiles.js';
import { estimateNoteOf, headlineOf, HELP_NOTE } from '../service/shipments.js';
import type { ShippingService } from '../service.js';

/* ---------------------------------------------------------------- REST shapes → GraphQL shapes (enums in capitals, Money.formatted) */

const upper = (s: string | null | undefined) => (s ? s.toUpperCase().replace(/-/g, '_') : null);
const lower = (s: string | null | undefined) => (s ? s.toLowerCase() : undefined);
const money = (m: common.Money | null | undefined) => (m ? { ...m, formatted: formatMoney(m) } : null);
const ACTOR_KIND: Record<string, string> = { customer: 'CUSTOMER', visitor: 'GUEST', seller: 'SELLER', staff: 'STAFF' };
const actor = (a: common.Actor | null | undefined) => (a ? { kind: ACTOR_KIND[a.kind] ?? 'SYSTEM', id: a.id ?? null, name: a.name ?? null } : null);
const pageInput = (p: common.PageInput | null | undefined): common.PageInput => ({ ...(p?.cursor ? { cursor: p.cursor } : {}), ...(p?.page ? { page: p.page } : {}), ...(p?.limit ? { limit: p.limit } : {}) });
const notice = (n: CustomerNotice) => ({ id: n.id, kind: n.kind, title: n.title, message: n.message, from: n.from, to: n.to });

function exception(e: DeliveryException) {
  return {
    ...e,
    kind: upper(e.kind),
    deadline: { dueAt: e.deadline.dueAt, state: upper(e.deadline.state) },
    status: upper(e.status),
    escalatedTo: upper(e.escalatedTo),
    sellerResponse: e.sellerResponse ? { ...e.sellerResponse, action: upper(e.sellerResponse.action), note: e.sellerResponse.note ?? null, shipBy: e.sellerResponse.shipBy ?? null, by: actor(e.sellerResponse.by) } : null,
    resolution: e.resolution ? { ...e.resolution, kind: upper(e.resolution.kind), by: actor(e.resolution.by) } : null,
    owner: e.owner ? { staffId: e.owner.staffId ?? null, name: e.owner.name, role: e.owner.role ?? null } : null,
    history: e.history.map((h) => ({ ...h, detail: h.detail ?? null, actor: actor(h.actor) })),
    openedBy: actor(e.openedBy),
    caseRef: e.caseRef ?? null,
    claimId: e.claimId ?? null,
    shipmentId: e.shipmentId ?? null,
  };
}

function shipment(s: Shipment, extra: { estimateNote: string | null; notices: CustomerNotice[]; openExceptions: DeliveryException[] }) {
  const f = s.failedDelivery;
  return {
    id: s.id,
    kind: upper(s.kind),
    orderId: s.orderId,
    orderRef: s.orderRef,
    groupId: s.groupId,
    returnId: s.returnId ?? null,
    packageLabel: s.packageLabel,
    sellerName: s.sellerName,
    shipFrom: s.shipFrom,
    carrierCode: s.carrierCode ?? null,
    carrierName: s.carrierName ?? null,
    serviceName: s.serviceName ?? null,
    trackingNumber: s.trackingNumber ?? null,
    trackingUrl: s.trackingUrl ?? null,
    status: upper(s.status),
    statusLabel: s.statusLabel,
    steps: STEPS,
    currentStep: stepOf(s.status),
    contents: s.contents,
    shippedAt: s.shippedAt ?? null,
    estimatedFrom: s.estimatedArrival?.from ?? null,
    estimatedTo: s.estimatedArrival?.to ?? null,
    estimateLabel: s.estimatedArrival ? rangeLabel(s.estimatedArrival) : null,
    deliveredAt: s.deliveredAt ?? null,
    failedDelivery: f
      ? {
          reason: f.reason,
          heldAt: f.heldAt ?? null,
          chooseBy: f.chooseBy,
          options: f.options.map((o) => ({ ...o, choice: upper(o.choice), cost: money(o.cost), costIfNoChoice: money(o.costIfNoChoice), pickupLocation: o.pickupLocation ?? null })),
          chosen: f.chosen ? { choice: upper(f.chosen.choice), redeliveryDate: f.chosen.redeliveryDate ?? null, chosenAt: f.chosen.chosenAt, chosenBy: actor(f.chosen.chosenBy) } : null,
          defaultIfNoChoice: upper(f.defaultIfNoChoice),
        }
      : null,
    events: s.events.map((e) => ({ ...e, code: upper(e.code), source: upper(e.source), detail: e.detail ?? null, location: e.location ?? null })),
    headline: headlineOf(s),
    estimateNote: extra.estimateNote,
    helpNote: HELP_NOTE,
    notices: extra.notices.map(notice),
    trackingState: upper(s.trackingState),
    dispatchedOnTime: s.dispatchedOnTime ?? null,
    label: s.label
      ? { id: s.label.id, carrierName: s.label.carrierName, serviceName: s.label.serviceName, cost: money(s.label.cost), trackingNumber: s.label.trackingNumber, status: upper(s.label.status), purchasedBy: actor(s.label.purchasedBy), purchasedAt: s.label.purchasedAt, voidedAt: s.label.voidedAt ?? null }
      : null,
    corrections: s.corrections.map((c) => ({ ...c, by: actor(c.by) })),
    openExceptions: extra.openExceptions.map(exception),
    recordedBy: actor(s.recordedBy),
    createdAt: s.createdAt,
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
 * Resolvers for the GraphQL fields this module owns (`@source(module: "shipping", …)` in graphql/schema.ts).
 * Same record scope as REST: the store sees the customer's or guest's own packages, the seller area only the
 * caller's own shipments and exceptions, the admin area everything.
 */
export const resolvers = (service: ShippingService): ModuleResolvers => {
  const sellerIdOf = (ctx: GraphQLContext) => {
    const id = ctx.principal?.sellerId;
    if (!id) throw new AppError('UNAUTHORIZED', 'Choose the seller account to act for');
    return id;
  };
  const guestOf = (ctx: GraphQLContext) => (ctx.principal?.kind === 'visitor' ? (ctx.principal.guestSessionId ?? ctx.principal.sessionId ?? undefined) : undefined);

  /** Store-only fields and the open exceptions (seller and admin) for a list of shipments */
  async function enrich(list: Shipment[], ctx: GraphQLContext) {
    const out = new Map<string, ReturnType<typeof shipment>>();
    if (!list.length) return out;
    const rows = await service.core.repo.find('shipments', { id: list.map((s) => s.id) });
    const world = ctx.area === 'store' ? await service.estimates.world() : null;
    const openIds = ctx.area === 'store' ? [] : [...new Set(list.flatMap((s) => s.openExceptionIds))];
    const exceptions = openIds.length ? await service.views.exceptions(await service.core.repo.find('exceptions', { id: openIds })) : [];
    for (const s of list) {
      const row = rows.find((r) => r.id === s.id);
      const notices = world && row ? await service.estimates.activeNotices(row.to_address.postalCode ?? undefined, row.carrier_code ? [row.carrier_code] : undefined, 'tracking', world) : [];
      out.set(s.id, shipment(s, { estimateNote: row ? estimateNoteOf(row) : null, notices, openExceptions: exceptions.filter((e) => s.openExceptionIds.includes(e.id)) }));
    }
    return out;
  }

  const one = async (s: Shipment | null, ctx: GraphQLContext) => (s ? ((await enrich([s], ctx)).get(s.id) ?? null) : null);

  const estimate = (e: OfferEstimate | undefined, postalCode: string | undefined, defaultZip: string, offerPrice: common.Money | null) => {
    const zip = postalCode?.trim() || defaultZip;
    const o = e?.option ?? null;
    return {
      shipsToLocation: e?.shipsToLocation ?? false,
      reason: e?.reason ?? null,
      basis: postalCode?.trim() ? 'POSTAL_CODE' : 'DEFAULT_REGION',
      locationLabel: locationLabel(destinationOf({ postalCode: zip })) || zip,
      methodName: o?.methodName ?? null,
      carrierService: o?.carrierService ?? null,
      price: money(o?.price),
      free: o?.free ?? false,
      freeReason: o?.freeReason ?? null,
      totalWithShipping: o && offerPrice && offerPrice.currency === o.price.currency ? money(makeMoney(offerPrice.amount + o.price.amount, o.price.currency)) : null,
      arrivalFrom: o?.arrival.from ?? null,
      arrivalTo: o?.arrival.to ?? null,
      arrivalLabel: o?.arrivalLabel ?? null,
      dispatchBy: o?.dispatchBy ?? null,
      dispatchLabel: o?.dispatchLabel ?? null,
      cutoffAt: o?.cutoffAt ?? null,
      notices: o?.notices ?? [],
      otherOptions: e?.otherOptions ?? 0,
    };
  };

  return {
    Query: {
      myShippingSetup: async (_root, _args, ctx) => {
        const s = await service.getSellerShippingSetup(sellerIdOf(ctx));
        return {
          carriers: s.carriers.map((c) => ({ code: c.code, name: c.name, trackingConnected: c.trackingConnected, services: c.services.map((x) => ({ id: x.id, code: x.code, name: x.name, transitMinDays: x.transit.min, transitMaxDays: x.transit.max, labelSupported: x.labelSupported, trackingPattern: x.trackingPattern ?? null })) })),
          labelPurchaseAvailable: s.labelPurchaseAvailable,
          labelUnavailableReason: s.labelUnavailableReason ?? null,
          defaultPackage: s.defaultParcel ? { ...s.defaultParcel, lengthCm: s.defaultParcel.lengthCm ?? null, widthCm: s.defaultParcel.widthCm ?? null, heightCm: s.defaultParcel.heightCm ?? null, label: s.defaultParcelLabel ?? parcelLabel(s.defaultParcel) } : null,
          dispatchLabel: s.dispatchLabel,
        };
      },
      shipment: async (_root, args: { id: string }, ctx) => {
        if (!isUuid(args.id)) return null;
        if (ctx.area === 'seller') return one(await service.getShipment({ sellerId: sellerIdOf(ctx) }, args.id), ctx);
        const customerId = (await ctx.customerId()) ?? undefined;
        const guestSessionId = guestOf(ctx);
        if (!customerId && !guestSessionId) return null;
        return one(await service.getShipment({ ...(customerId ? { customerId } : {}), ...(guestSessionId ? { guestSessionId } : {}) }, args.id), ctx);
      },
      shipmentAdmin: async (_root, args: { id: string }, ctx) => (isUuid(args.id) ? one(await service.getShipment({ staff: true }, args.id), ctx) : null),
      deliveryExceptions: async (_root, args: { filter?: Record<string, unknown> | null; paging?: common.PageInput | null }) => {
        const f = args.filter ?? {};
        const str = (k: string) => (typeof f[k] === 'string' && f[k] ? (f[k] as string) : undefined);
        const sellerType = lower(str('sellerType'));
        const page = await service.listExceptions(
          {
            ...(str('kind') ? { kind: lower(str('kind')) } : {}),
            ...(str('status') ? { status: lower(str('status')) } : {}),
            ...(sellerType && sellerType !== 'all' ? { sellerType } : {}),
            ...(str('ownerStaffId') ? { ownerStaffId: str('ownerStaffId') } : {}),
            ...(f.customerNotNotified === true ? { customerNotNotified: true } : {}),
            ...(str('q') ? { q: str('q') } : {}),
          },
          pageInput(args.paging),
        );
        return { ...page, items: page.items.map(exception) };
      },
      deliveryExceptionCounts: async () => service.countOpenExceptions(),
    },
    OrderGroup: {
      shipments: async (root: { id: string }, args: { kinds?: string[] | null }, ctx: GraphQLContext) => {
        const kinds = (args?.kinds?.length ? args.kinds.map((k) => k.toLowerCase()) : ['outbound', 'replacement']) as ('outbound' | 'replacement' | 'return')[];
        const list =
          (await load(ctx, `groupShipments:${kinds.join(',')}`, root.id, async (ids) => {
            const m = await service.listShipmentsForGroups(ids, kinds);
            const all = [...m.values()].flat();
            const enriched = await enrich(all, ctx);
            return new Map([...m].map(([g, l]) => [g, l.map((s) => enriched.get(s.id)!).filter(Boolean)]));
          })) ?? [];
        // the parent group was resolved under the orders record scope (own order, own seller group or staff)
        return list;
      },
      deliveryExceptions: async (root: { id: string }, _args: unknown, ctx: GraphQLContext) => {
        const sellerId = sellerIdOf(ctx);
        const rows = await service.core.repo.find('exceptions', { group_id: root.id, owner_type: 'seller', seller_id: sellerId }, { orderBy: [['opened_at', 'desc']] });
        return (await service.views.exceptions(rows)).map(exception);
      },
    },
    Order: {
      deliveryExceptions: async (root: { id: string }) => (await service.listExceptionsForOrder(root.id)).map(exception),
    },
    Offer: {
      deliveryEstimate: async (root: { id: string; sellerId?: string | null; price?: common.Money | null }, args: { postalCode?: string | null }, ctx: GraphQLContext) => {
        if (ctx.area === 'seller' && root.sellerId && root.sellerId !== ctx.principal?.sellerId) return null;
        const zip = args?.postalCode?.trim() || undefined;
        const cfg = await service.core.cfg();
        const e = await load(ctx, `estimate:${zip ?? ''}`, root.id, async (ids) => new Map((await service.estimateOffers(ids, zip)).map((x) => [x.offerId, x])));
        return estimate(e, zip, cfg.marketDefaultPostalCode, root.price ? { amount: root.price.amount, currency: root.price.currency } : null);
      },
    },
    Seller: {
      shippingSummary: async (root: { id: string }, _args: unknown, ctx: GraphQLContext) => {
        const s = await load(ctx, 'sellerShipping', root.id, async (ids) => new Map(Object.entries(await service.getSellerShippingSummaries(ids))));
        if (!s) return null;
        return {
          shipsFrom: s.shipsFrom,
          coverage: upper(s.coverage.area),
          coverageLabel: s.coverageLabel,
          excluded: s.excluded,
          handlingDays: s.handlingDays,
          sameDayCutoff: s.sameDayCutoff,
          dispatchLabel: s.dispatchLabel,
          businessDaysLabel: businessDaysLabel(s.businessDays),
          closures: s.closures.map((c) => ({ name: c.name, from: c.from, to: c.to })),
          carriers: s.carriers,
          methods: s.methods.map((m) => ({ name: m.name, transitMinDays: m.transit.min, transitMaxDays: m.transit.max, priceLabel: m.priceLabel })),
          freeShippingThreshold: money(s.freeShippingThreshold),
          freeShippingLabel: s.freeShippingLabel,
          notices: s.notices.map(notice),
        };
      },
    },
    ReturnReplacement: {
      shipment: async (root: { id: string; returnId?: string | null; orderItemId?: string | null }, _args: unknown, ctx: GraphQLContext) => {
        // by its return, or by its order item when the replacement was decided on a case (no return)
        if (!root.returnId && !root.orderItemId) return null;
        const key = `${root.id}|${root.returnId ?? ''}|${root.orderItemId ?? ''}`;
        const s = await load(ctx, 'replacementShipment', key, async (keys) => {
          const list = keys.map((k) => {
            const [replacementId, returnId, orderItemId] = k.split('|');
            return { key: k, replacementId: replacementId!, returnId: returnId || null, orderItemIds: orderItemId ? [orderItemId] : [] };
          });
          const found = await service.shipmentsForReplacements(list.map(({ key: _k, ...r }) => r));
          const shipments = Object.values(found).filter((x): x is Shipment => Boolean(x));
          const enriched = await enrich(shipments, ctx);
          return new Map(list.map((r) => [r.key, found[r.replacementId] ? (enriched.get(found[r.replacementId]!.id) ?? null) : null]));
        });
        if (!s) return null;
        // store: only the customer's or guest's own order
        if (ctx.area === 'store') {
          const customerId = (await ctx.customerId()) ?? undefined;
          const guestSessionId = guestOf(ctx);
          if (!(await service.shipments.visibleToShopper(s.orderId, { customerId: customerId ?? null, guestSessionId: guestSessionId ?? null }))) return null;
        }
        if (ctx.area === 'seller' && !(await service.getShipment({ sellerId: sellerIdOf(ctx) }, s.id))) return null;
        return s;
      },
    },
  };
};
