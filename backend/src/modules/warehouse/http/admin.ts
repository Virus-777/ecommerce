import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/warehouse.js';
import type { WarehouseService } from '../service.js';

/**
 * Admin API: /api/admin/warehouse/…  (docs/api/modules/warehouse.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: WarehouseService) =>
  routes(endpoints, 'admin', {
    /** GET /summary: Today's work: to pick, to pack, on hold, at risk, put-away and return parcels */
    getWarehouseSummary: notImplemented,
    /** GET /scan: Resolve a scanned barcode (bin, item, order, package or return label) */
    scanCode: notImplemented,
    /** GET /bins: Bins with their kind and assigned items */
    listBins: notImplemented,
    /** POST /bins: Create bins (one or a list of codes) */
    createBins: notImplemented,
    /** PATCH /bins/{id}: Change kind or deactivate a bin */
    updateBin: notImplemented,
    /** PUT /stock-items/{stockItemId}/bins: Set the bins a company stock item is stored in (one primary) */
    setStockItemBins: notImplemented,
    /** GET /fulfillments: Official Store orders to pick and pack, most urgent first */
    listFulfillments: notImplemented,
    /** GET /fulfillments/{id}: One fulfillment with lines, bins, packages, hold reason and mixed-order note */
    getFulfillment: notImplemented,
    /** POST /waves: Create a pick wave (given orders, or all awaiting pick due before the carrier pickup) */
    createWave: notImplemented,
    /** GET /waves: Pick waves */
    listWaves: notImplemented,
    /** GET /waves/{id}: Pick list grouped by order with bins in walking order, progress and next bin */
    getWave: notImplemented,
    /** POST /waves/{id}/start: Start picking a wave */
    startWave: notImplemented,
    /** POST /pick-lines/{id}/pick: Confirm a pick by scanning the bin and the item */
    pickLine: notImplemented,
    /** POST /pick-lines/{id}/report-shortage: Report a bin shortage; the order is held (not packed partly) and Inventory is asked to resolve it */
    reportShortage: notImplemented,
    /** POST /fulfillments/{id}/report-damage: Report a damaged item at pick or pack (photos required) */
    reportDamage: notImplemented,
    /** POST /fulfillments/{id}/resume: Resume a held fulfillment after the shortage or damage is resolved */
    resumeFulfillment: notImplemented,
    /** GET /box-types: Box and mailer sizes for packing */
    listBoxTypes: notImplemented,
    /** PUT /box-types: Replace the list of box and mailer sizes */
    putBoxTypes: notImplemented,
    /** POST /fulfillments/{id}/packages: Open a package at a packing station (defaults to all picked items) */
    startPackage: notImplemented,
    /** POST /packages/{id}/scan: Scan an item into the package checklist */
    scanPackageItem: notImplemented,
    /** PATCH /packages/{id}: Set box, dimensions, weight (from scale), fragile note and service */
    updatePackage: notImplemented,
    /** POST /packages/{id}/label: Buy the carrier label through shipping (service matching the customer's delivery choice) */
    createPackageLabel: notImplemented,
    /** POST /packages/{id}/void-label: Void the label (e.g. wrong service) before the package is packed */
    voidPackageLabel: notImplemented,
    /** GET /packages/{id}/label: Reprint the current label */
    getPackageLabel: notImplemented,
    /** GET /packages/{id}/service-options: Carrier services for this package with arrival dates and whether each keeps the customer's promise */
    listPackageServiceOptions: notImplemented,
    /** GET /packages/{id}/packing-slip: Packing slip listing only this seller group's items, package n of N, returns note */
    getPackingSlip: notImplemented,
    /** POST /packages/{id}/pack: Mark the package packed and hand it to shipping for carrier pickup */
    packPackage: notImplemented,
    /** GET /putaway-tasks: Received units to put away, with suggested bins */
    listPutawayTasks: notImplemented,
    /** GET /putaway-tasks/labels: Printable item and put-away labels for a receipt's units (SKU barcode, label, suggested bin, quantity) */
    getPutawayLabels: notImplemented,
    /** POST /putaway-tasks/{id}/complete: Confirm put-away by scanning the bin */
    completePutaway: notImplemented,
    /** GET /return-parcels: Return parcels expected, received and handed over */
    listReturnParcels: notImplemented,
    /** POST /return-parcels: Receive a return parcel at the warehouse (scan the return label or reference) */
    receiveReturnParcel: notImplemented,
    /** POST /return-parcels/{id}/hand-over: Hand a received parcel to returns inspection */
    handOverReturnParcel: notImplemented,
  });
