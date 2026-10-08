import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/offers.js';
import type { OffersService } from '../service.js';

/**
 * Seller API: /api/seller/offers/…  (docs/api/modules/offers.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: OffersService) =>
  routes(endpoints, 'seller', {
    /** GET /offers: This seller's offers with review state, publication and stock as separate columns */
    listOwnOffers: notImplemented,
    /** GET /offers/counts: Counts for the list tabs and the page heading */
    countOwnOffers: notImplemented,
    /** GET /offers/{id}: One own offer with product, stock, price history, status log and featured eligibility */
    getOwnOffer: notImplemented,
    /** POST /offers/preview: Check an offer before saving: delivery a customer would see, price context, was-price check, return baseline */
    previewOffer: notImplemented,
    /** POST /offers: Create an offer on a catalog product (draft or published) */
    createOffer: notImplemented,
    /** PATCH /offers/{id}: Edit offer terms or price */
    updateOffer: notImplemented,
    /** POST /offers/{id}/publish: Publish a draft offer */
    publishOffer: notImplemented,
    /** POST /offers/{id}/pause: Hide an offer from customers (stock is kept) */
    pauseOffer: notImplemented,
    /** POST /offers/bulk-pause: Hide several own offers at once (up to 100) */
    bulkPauseOffers: notImplemented,
    /** POST /offers/{id}/resume: Show a paused offer again */
    resumeOffer: notImplemented,
    /** POST /offers/{id}/end: End an offer permanently (Removed, reason ended_by_seller) */
    endOffer: notImplemented,
    /** DELETE /offers/{id}: Delete a draft offer that was never published */
    deleteDraftOffer: notImplemented,
    /** POST /price-changes: Change prices of selected offers (up to 100) */
    changeOwnPrices: notImplemented,
    /** POST /offers/exports: Export own offers (selected rows or the current filters) as CSV */
    exportOwnOffers: notImplemented,
    /** GET /offers/exports/{id}: Offer export status and download link (requesting member only) */
    getOwnOffersExport: notImplemented,
    /** GET /bulk-updates/template: Download a CSV template prefilled with this seller's SKUs, prices and quantities */
    getBulkTemplate: notImplemented,
    /** POST /bulk-updates: Upload a price and quantity file for preview */
    createBulkUpdate: notImplemented,
    /** GET /bulk-updates: Upload history */
    listBulkUpdates: notImplemented,
    /** GET /bulk-updates/{id}: Job state and totals (rows, ready, errors, unchanged) */
    getBulkUpdate: notImplemented,
    /** GET /bulk-updates/{id}/rows: Row-by-row preview with before → after and the error for each failed row */
    listBulkUpdateRows: notImplemented,
    /** POST /bulk-updates/{id}/apply: Apply the valid rows */
    applyBulkUpdate: notImplemented,
    /** GET /bulk-updates/{id}/correction-report: CSV of skipped rows with what to fix */
    getCorrectionReport: notImplemented,
  });
