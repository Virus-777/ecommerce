import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/warehouse.js';
import type { WarehouseService } from '../service.js';

/**
 * Admin API: /api/admin/warehouse/…  (docs/api/modules/warehouse.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: WarehouseService) =>
  routes(endpoints, 'admin', {
    /** GET /summary: Today's work: to pick, to pack, on hold, at risk, put-away and return parcels */
    getWarehouseSummary: async ({ query }) => service.summary.summary(query.locationId),
    /** GET /scan: Resolve a scanned barcode (bin, item, order, package or return label) */
    scanCode: async ({ query, actor }) => service.summary.scan(query, actor),
    /** GET /bins: Bins with their kind and assigned items */
    listBins: async ({ query, page }) => service.bins.list(query, page),
    /** POST /bins: Create bins (one or a list of codes) */
    createBins: async ({ body, actor, requestId, principal }) => service.bins.create(body, { actor, requestId, principal }),
    /** PATCH /bins/{id}: Change kind or deactivate a bin */
    updateBin: async ({ params, body, actor, requestId, principal }) => service.bins.update(params.id, body, { actor, requestId, principal }),
    /** GET /stock-items/{stockItemId}/bins: The bins a company stock item is stored in, primary first */
    listStockItemBins: async ({ params }) => service.bins.listStockItemBins(params.stockItemId),
    /** PUT /stock-items/{stockItemId}/bins: Set the bins a company stock item is stored in (one primary) */
    setStockItemBins: async ({ params, body, actor, requestId, principal }) => service.bins.setStockItemBins(params.stockItemId, body, { actor, requestId, principal }),
    /** GET /fulfillments: Official Store orders to pick and pack, most urgent first */
    listFulfillments: async ({ query, page }) => service.fulfillments.list(query, page),
    /** GET /fulfillments/{id}: One fulfillment with lines, bins, packages, hold reason and mixed-order note */
    getFulfillment: async ({ params }) => service.fulfillments.get(params.id, { detail: true }),
    /** POST /waves: Create a pick wave (given orders, or all awaiting pick due before the carrier pickup) */
    createWave: async ({ body, actor, requestId, principal }) => service.fulfillments.createWave(body, { actor, requestId, principal }),
    /** GET /waves: Pick waves */
    listWaves: async ({ query, page }) => service.fulfillments.listWaves(query, page),
    /** GET /waves/{id}: Pick list grouped by order with bins in walking order, progress and next bin */
    getWave: async ({ params }) => service.fulfillments.getWave(params.id),
    /** POST /waves/{id}/start: Start picking a wave */
    startWave: async ({ params, actor, requestId, principal }) => service.fulfillments.startWave(params.id, { actor, requestId, principal }),
    /** POST /pick-lines/{id}/pick: Confirm a pick by scanning the bin and the item */
    pickLine: async ({ params, body, actor, requestId, principal }) => service.fulfillments.pickLine(params.id, body, { actor, requestId, principal }),
    /** POST /pick-lines/{id}/report-shortage: Report a bin shortage; the order is held (not packed partly) and Inventory is asked to resolve it */
    reportShortage: async ({ params, body, actor, requestId, principal }) => service.fulfillments.reportShortage(params.id, body, { actor, requestId, principal }),
    /** POST /fulfillments/{id}/report-damage: Report a damaged item at pick or pack (photos required) */
    reportDamage: async ({ params, body, actor, requestId, principal }) => service.fulfillments.reportDamage(params.id, body, { actor, requestId, principal }),
    /** POST /fulfillments/{id}/resume: Resume a held fulfillment after the shortage or damage is resolved */
    resumeFulfillment: async ({ params, body, actor, requestId, principal }) => service.fulfillments.resume(params.id, body ?? {}, { actor, requestId, principal }),
    /** GET /box-types: Box and mailer sizes for packing */
    listBoxTypes: async () => service.bins.boxTypes(),
    /** PUT /box-types: Replace the list of box and mailer sizes */
    putBoxTypes: async ({ body, actor, requestId, principal }) => service.bins.putBoxTypes(body, { actor, requestId, principal }),
    /** POST /fulfillments/{id}/packages: Open a package at a packing station (defaults to all picked items) */
    startPackage: async ({ params, body, actor, requestId, principal }) => service.packing.start(params.id, body ?? {}, { actor, requestId, principal }),
    /** POST /packages/{id}/scan: Scan an item into the package checklist */
    scanPackageItem: async ({ params, body, actor, requestId, principal }) => service.packing.scan(params.id, body, { actor, requestId, principal }),
    /** PATCH /packages/{id}: Set box, dimensions, weight (from scale), fragile note and service */
    updatePackage: async ({ params, body, actor, requestId, principal }) => service.packing.update(params.id, body, { actor, requestId, principal }),
    /** POST /packages/{id}/label: Buy the carrier label through shipping (service matching the customer's delivery choice) */
    createPackageLabel: async ({ params, body, actor, requestId, principal, idempotencyKey }) => service.packing.label(params.id, body ?? {}, idempotencyKey, { actor, requestId, principal }),
    /** POST /packages/{id}/void-label: Void the label (e.g. wrong service) before the package is packed */
    voidPackageLabel: async ({ params, body, actor, requestId, principal }) => service.packing.voidLabel(params.id, body, { actor, requestId, principal }),
    /** GET /packages/{id}/label: Reprint the current label */
    getPackageLabel: async ({ params }) => service.packing.labelFile(params.id),
    /** GET /packages/{id}/service-options: Carrier services for this package with arrival dates and whether each keeps the customer's promise */
    listPackageServiceOptions: async ({ params }) => service.packing.serviceOptions(params.id),
    /** GET /packages/{id}/packing-slip: Packing slip listing only this seller group's items, package n of N, returns note */
    getPackingSlip: async ({ params, principal }) => service.packing.packingSlip(params.id, principal),
    /** POST /packages/{id}/pack: Mark the package packed and hand it to shipping for carrier pickup */
    packPackage: async ({ params, actor, requestId, principal }) => service.packing.pack(params.id, { actor, requestId, principal }),
    /** GET /putaway-tasks: Received units to put away, with suggested bins */
    listPutawayTasks: async ({ query, page }) => service.putaway.list(query, page),
    /** GET /putaway-tasks/labels: Printable item and put-away labels for a receipt's units (SKU barcode, label, suggested bin, quantity) */
    getPutawayLabels: async ({ query, principal }) => service.putaway.labels(query, principal),
    /** POST /putaway-tasks/{id}/complete: Confirm put-away by scanning the bin */
    completePutaway: async ({ params, body, actor, requestId, principal }) => service.putaway.complete(params.id, body, { actor, requestId, principal }),
    /** GET /return-parcels: Return parcels expected, received and handed over */
    listReturnParcels: async ({ query, page }) => service.parcels.list(query, page),
    /** POST /return-parcels: Receive a return parcel at the warehouse (scan the return label or reference) */
    receiveReturnParcel: async ({ body, actor, requestId, principal }) => service.parcels.receive(body, { actor, requestId, principal }),
    /** POST /return-parcels/{id}/hand-over: Hand a received parcel to returns inspection */
    handOverReturnParcel: async ({ params, body, actor, requestId, principal }) => service.parcels.handOver(params.id, body ?? {}, { actor, requestId, principal }),
  });
