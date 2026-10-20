import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/offers.js';
import type { OffersService } from '../service.js';

/**
 * Seller API: /api/seller/offers/…  (docs/api/modules/offers.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * Every call acts for the session's seller (input.sellerId); other sellers' offers are not found.
 */
export const sellerRoutes = (service: OffersService) => {
  const own = (sellerId: string) => ({ ownerType: 'seller' as const, sellerId });
  const detail = async (id: string) => service.views.sellerDetail(await service.core.offerRow(id));
  return routes(endpoints, 'seller', {
    /** GET /offers: This seller's offers with review state, publication and stock as separate columns */
    listOwnOffers: async ({ sellerId, query, page }) => service.views.listOwn(sellerId, query, page),
    /** GET /offers/counts: Counts for the list tabs and the page heading */
    countOwnOffers: async ({ sellerId }) => service.views.countOwn(sellerId),
    /** GET /offers/{id}: One own offer with product, stock, price history, status log and featured eligibility */
    getOwnOffer: async ({ sellerId, params }) => service.views.sellerDetail(await service.core.ownRow(sellerId, params.id)),
    /** POST /offers/preview: Check an offer before saving */
    previewOffer: async ({ sellerId, body }) => service.views.preview(sellerId, body),
    /** POST /offers: Create an offer on a catalog product (draft or published) */
    createOffer: async ({ sellerId, body, principal, actor, requestId }) => detail((await service.manage.createSellerOffer(sellerId, body, { actor, requestId, principal })).id),
    /** PATCH /offers/{id}: Edit offer terms or price */
    updateOffer: async ({ sellerId, params, body, principal, actor, requestId }) => {
      const row = await service.core.ownRow(sellerId, params.id);
      return detail((await service.manage.update(row, body, { actor, requestId, principal }, { official: false })).id);
    },
    /** POST /offers/{id}/publish: Publish a draft offer */
    publishOffer: async ({ sellerId, params, principal, actor, requestId }) => detail((await service.manage.publishSeller(await service.core.ownRow(sellerId, params.id), { actor, requestId, principal })).id),
    /** POST /offers/{id}/pause: Hide an offer from customers (stock is kept) */
    pauseOffer: async ({ sellerId, params, body, principal, actor, requestId }) => detail((await service.manage.pause(await service.core.ownRow(sellerId, params.id), body?.reason ?? null, { actor, requestId, principal })).id),
    /** POST /offers/bulk-pause: Hide several own offers at once (up to 100) */
    bulkPauseOffers: async ({ sellerId, body, principal, actor, requestId }) => service.manage.bulkPause(sellerId, body.offerIds, body.reason ?? null, { actor, requestId, principal }),
    /** POST /offers/{id}/resume: Show a paused offer again */
    resumeOffer: async ({ sellerId, params, principal, actor, requestId }) => detail((await service.manage.resumeSeller(await service.core.ownRow(sellerId, params.id), { actor, requestId, principal })).id),
    /** POST /offers/{id}/end: End an offer permanently (Removed, reason ended_by_seller) */
    endOffer: async ({ sellerId, params, body, principal, actor, requestId }) => detail((await service.manage.end(await service.core.ownRow(sellerId, params.id), body?.reason ?? null, { actor, requestId, principal })).id),
    /** DELETE /offers/{id}: Delete a draft offer that was never published */
    deleteDraftOffer: async ({ sellerId, params, principal, actor, requestId }) => {
      await service.manage.deleteDraft(sellerId, params.id, { actor, requestId, principal });
      return undefined as never;
    },
    /** POST /price-changes: Change prices of selected offers (up to 100) */
    changeOwnPrices: async ({ sellerId, body, principal, actor, requestId }) => service.pricing.changeOwnPrices(sellerId, body, { actor, requestId, principal }),
    /** GET /offers/{id}/costs: Unit cost history of one own offer, newest first */
    listOfferCosts: async ({ sellerId, params, page }) => service.costs.history(sellerId, params.id, page),
    /** PUT /offers/{id}/cost: Set the unit cost of one own offer from a day on */
    setOfferCost: async ({ sellerId, params, body, principal, actor, requestId }) => service.costs.setOne(sellerId, params.id, body, { actor, requestId, principal }),
    /** POST /costs: Set the unit cost of several own offers (1 to 500) */
    setOfferCosts: async ({ sellerId, body, principal, actor, requestId }) => service.costs.setMany(sellerId, body.items, { actor, requestId, principal }),
    /** POST /offers/exports: Export own offers (selected rows or the current filters) as CSV */
    exportOwnOffers: async ({ sellerId, body, principal, actor, requestId }) => service.views.exportOwn(sellerId, body, { actor, requestId, principal }),
    /** GET /offers/exports/{id}: Offer export status and download link (requesting member only) */
    getOwnOffersExport: async ({ sellerId, params, principal }) => service.views.getOwnExport(sellerId, params.id, principal),
    /** GET /bulk-updates/template: Download a CSV template prefilled with this seller's SKUs, prices and quantities */
    getBulkTemplate: async ({ sellerId, principal, actor, requestId }) => service.bulk.template(sellerId, { actor, requestId, principal }),
    /** POST /bulk-updates: Upload a price and quantity file for preview */
    createBulkUpdate: async ({ sellerId, body, principal, actor, requestId }) => service.bulk.create(own(sellerId), body.fileId, { actor, requestId, principal }),
    /** GET /bulk-updates: Upload history */
    listBulkUpdates: async ({ sellerId, page }) => service.bulk.list(own(sellerId), page),
    /** GET /bulk-updates/{id}: Job state and totals (rows, ready, errors, unchanged) */
    getBulkUpdate: async ({ sellerId, params }) => service.bulk.get(own(sellerId), params.id),
    /** GET /bulk-updates/{id}/rows: Row-by-row preview with before → after and the error for each failed row */
    listBulkUpdateRows: async ({ sellerId, params, query, page }) => service.bulk.rows(own(sellerId), params.id, query.result, page),
    /** POST /bulk-updates/{id}/apply: Apply the valid rows */
    applyBulkUpdate: async ({ sellerId, params, body, principal, actor, requestId }) => service.bulk.apply(own(sellerId), params.id, { actor, requestId, principal }, { confirmLargeChanges: body?.confirmLargeChanges ?? false }),
    /** GET /bulk-updates/{id}/correction-report: CSV of skipped rows with what to fix */
    getCorrectionReport: async ({ sellerId, params, principal, actor, requestId }) => service.bulk.correctionReport(own(sellerId), params.id, { actor, requestId, principal }),
  });
};
