import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/reports.js';
import type { ReportsService } from '../service.js';

/**
 * Seller API: /api/seller/reports/…  (docs/api/modules/reports.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * The seller always comes from the session: sellers only ever see their own figures and exports.
 */
export const sellerRoutes = (service: ReportsService) =>
  routes(endpoints, 'seller', {
    /** GET /dashboard: Today at this seller: work tiles, dispatch deadlines, sales, payouts, performance, announcements */
    getSellerDashboard: async (i) => service.getSellerDashboard(i.sellerId, 'last_14_days', { canViewFinance: await i.can('finance.balances.view') }),
    /** GET /catalogue: Reports available to sellers */
    getSellerCatalogue: async () => service.defs.sellerCatalogue(),
    /** POST /reports/{key}/query: Run a seller report (product sales, order trend, returns by reason, service performance) */
    runSellerReport: async (i) => service.runSellerReport(i.params.key, i.body, i.sellerId),
    /** POST /exports: Export a seller report as CSV */
    createSellerExport: async (i) => service.exports.request({ ...i.body, sellerId: i.sellerId }, { principal: { ...i.principal, sellerId: i.sellerId }, actor: i.actor, requestId: i.requestId, can: i.can }, 'seller'),
    /** GET /exports: My seller exports */
    listSellerExports: async (i) => service.exports.listMine(i.page, { ...i.principal, sellerId: i.sellerId }),
    /** GET /exports/{id}: Seller export status and link (requester only) */
    getSellerExport: async (i) => service.exports.get(i.params.id, { ...i.principal, sellerId: i.sellerId }, { principal: i.principal, actor: i.actor, requestId: i.requestId, can: i.can }),
  });
