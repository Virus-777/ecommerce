import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/trust.js';
import type { TrustService } from '../service.js';

/**
 * Store API: /api/store/trust/…  (docs/api/modules/trust.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: TrustService) => {
  void service;
  return routes(endpoints, 'store', {
    /** POST /reports: Report a listing, seller, order or message */
    createStoreReport: notImplemented,
    /** GET /reports: Reports I made, with status and outcome */
    listMyReports: notImplemented,
    /** GET /reports/{id}: One report I made */
    getMyReport: notImplemented,
    /** POST /reports/{id}/evidence: Add photos or details to a report I made */
    addMyReportDetails: notImplemented,
    /** GET /enforcements: Trust actions that affect my account, with appeal route */
    listMyEnforcements: notImplemented,
    /** POST /appeals: Appeal a trust action on my account before the deadline */
    submitCustomerAppeal: notImplemented,
    /** GET /appeals: My appeals */
    listCustomerAppeals: notImplemented,
  });
};
