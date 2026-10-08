import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/reports.js';
import type { ReportsService } from '../service.js';

/**
 * Seller API: /api/seller/reports/…  (docs/api/modules/reports.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: ReportsService) =>
  routes(endpoints, 'seller', {
    /** GET /dashboard: Today at this seller: work tiles, dispatch deadlines, sales, payouts, performance, announcements */
    getSellerDashboard: notImplemented,
    /** GET /catalogue: Reports available to sellers */
    getSellerCatalogue: notImplemented,
    /** POST /reports/{key}/query: Run a seller report (product sales, order trend, returns by reason, service performance) */
    runSellerReport: notImplemented,
    /** POST /exports: Export a seller report as CSV */
    createSellerExport: notImplemented,
    /** GET /exports: My seller exports */
    listSellerExports: notImplemented,
    /** GET /exports/{id}: Seller export status and link (requester only) */
    getSellerExport: notImplemented,
  });
