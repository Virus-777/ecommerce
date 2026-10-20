import { createBatchLoader, gqlActor, gqlDeadline, gqlEnum, type GraphQLContext, type ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { Fulfillment } from '../../../spec/warehouse.js';
import type { WarehouseService } from '../service.js';

/* ---------------------------------------------------------------- REST shapes → GraphQL shapes (enums in capitals) */

const actor = gqlActor;

interface Lookups {
  waveRefs: Map<string, string>;
  boxNames: Map<string, string>;
}

function task(f: Fulfillment, l: Lookups) {
  return {
    id: f.id,
    orderRef: f.orderRef,
    status: gqlEnum(f.status),
    shipBy: f.shipBy,
    deadline: gqlDeadline(f.deadline),
    deliveryChoice: f.deliveryChoice,
    waveRef: f.waveId ? (l.waveRefs.get(f.waveId) ?? null) : null,
    lines: f.lines.map((x) => ({
      id: x.id,
      orderItemId: x.orderItemId,
      sku: x.sku,
      label: x.label,
      image: x.image ?? null,
      quantity: x.quantity,
      binCode: x.binCode ?? null,
      picked: x.picked,
      short: x.short,
      state: gqlEnum(x.state),
      pickedBy: actor(x.pickedBy),
      pickedAt: x.pickedAt ?? null,
    })),
    packages: f.packages.map((p) => ({
      id: p.id,
      index: p.index,
      of: p.of,
      status: gqlEnum(p.status),
      itemCount: p.items.reduce((n, i) => n + i.quantity, 0),
      allScanned: p.allScanned,
      boxName: p.boxTypeId ? (l.boxNames.get(p.boxTypeId) ?? null) : null,
      fragile: p.fragile,
      carrier: p.carrier ?? null,
      service: p.service ?? null,
      trackingNumber: p.trackingNumber ?? null,
      packedBy: actor(p.packedBy),
      packedAt: p.packedAt ?? null,
      shipmentId: p.shipmentId ?? null,
    })),
    holdReason: f.holdReason ?? null,
    dispatchOverdueAt: f.dispatchOverdueAt ?? null,
    mixedOrderNote: f.mixedOrderNote ?? null,
    totalPackagesInOrder: f.totalPackagesInOrder,
    createdAt: f.createdAt,
  };
}

/* ---------------------------------------------------------------- batching per request (one call per field and tick) */

const load = createBatchLoader();

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "warehouse", …)` in graphql/schema.ts).
 * Staff only (the schema's @auth checks warehouse.view): the admin order view and OpsQueues.
 *
 *   OrderGroup.warehouseTask → service.getTasksForOrderGroups (batched per request)
 *   Query.warehouseToday → service.getTodaySummary
 */
export const resolvers = (service: WarehouseService): ModuleResolvers => {
  async function lookups(list: Fulfillment[]): Promise<Lookups> {
    const waveIds = [...new Set(list.map((f) => f.waveId).filter((x): x is string => Boolean(x)))];
    const boxIds = [...new Set(list.flatMap((f) => f.packages.map((p) => p.boxTypeId)).filter((x): x is string => Boolean(x)))];
    const [waves, boxes] = await Promise.all([waveIds.length ? service.core.repo.find('waves', { id: waveIds }) : [], boxIds.length ? service.core.repo.find('box_types', { id: boxIds }) : []]);
    return { waveRefs: new Map(waves.map((w) => [w.id, w.ref])), boxNames: new Map(boxes.map((b) => [b.id, b.name])) };
  }

  return {
    OrderGroup: {
      warehouseTask: async (root: { id: string }, _args: unknown, ctx: GraphQLContext) =>
        (await load(ctx, 'warehouse.tasks', root.id, async (ids) => {
          const found = await service.getTasksForOrderGroups(ids);
          const list = Object.values(found).filter((f): f is Fulfillment => Boolean(f));
          const l = await lookups(list);
          return new Map(list.map((f) => [f.sellerGroupId, task(f, l)]));
        })) ?? null,
    },
    Query: {
      warehouseToday: async (_root: unknown, args: { locationId?: string | null }) => {
        const t = await service.getTodaySummary(args.locationId ?? undefined);
        const l = await lookups(t.urgent);
        const urgent = t.urgent.map((f) => task(f, l));
        return {
          locationId: t.locationId,
          date: t.date,
          toPick: t.toPick,
          picking: t.picking,
          toPack: t.toPack,
          toShip: t.toShip,
          shipToday: t.shipToday,
          packedToday: t.packedToday,
          dispatchedToday: t.dispatchedToday,
          onHold: t.onHold,
          atRisk: t.atRisk,
          late: t.late,
          shipByCutoff: t.shipByCutoff,
          pickupsToday: t.pickupsToday,
          openShortages: t.openShortages,
          putawayOpen: t.putawayOpen,
          returnParcelsExpected: t.returnParcelsExpected,
          returnParcelsToHandOver: t.returnParcelsToHandOver,
          urgentTasks: (a: { limit?: number | null }) => urgent.slice(0, Math.max(0, Math.min(a?.limit ?? 10, 50))),
        };
      },
    },
  };
};
