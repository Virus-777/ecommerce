import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/trust.js';
import type { TrustService } from '../service.js';
import { appellantOf, byOf, customerOf } from './who.js';

/**
 * Store API: /api/store/trust/…  (docs/api/modules/trust.md)
 * A customer reaches only the reports they made and the enforcement on their own account.
 */
export const storeRoutes = (service: TrustService) =>
  routes(endpoints, 'store', {
    /** POST /reports: Report a listing, seller, order or message */
    createStoreReport: async (i) => service.reports.file(i.body, await customerOf(service, i), byOf(i)),
    /** GET /reports: Reports I made, with status and outcome */
    listMyReports: async (i) => service.reports.listMine(await customerOf(service, i), i.page),
    /** GET /reports/{id}: One report I made */
    getMyReport: async (i) => service.reports.mine(i.params.id, await customerOf(service, i)),
    /** POST /reports/{id}/evidence: Add photos or details to a report I made */
    addMyReportDetails: async (i) => service.reports.addMine(i.params.id, i.body, await customerOf(service, i), byOf(i)),
    /** GET /enforcements: Trust actions that affect my account, with appeal route */
    listMyEnforcements: async (i) => {
      const me = await customerOf(service, i);
      return service.actions.myEnforcements('customer', me.ids, me.ids);
    },
    /** POST /appeals: Appeal a trust action on my account before the deadline */
    submitCustomerAppeal: async (i) => service.appeals.submit(i.body, appellantOf(await customerOf(service, i)), byOf(i)),
    /** GET /appeals: My appeals */
    listCustomerAppeals: async (i) => service.appeals.listMine('customer', (await customerOf(service, i)).ids),
  });
