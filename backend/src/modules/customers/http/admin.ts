import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/customers.js';
import type { CustomersService, StaffBy } from '../service.js';

/** The staff caller of a request, with permission answers for rules beyond the endpoint permission */
const staff = (i: { principal: StaffBy['principal']; actor: StaffBy['actor']; requestId: string; can: StaffBy['can'] }): StaffBy => ({
  principal: i.principal,
  actor: i.actor,
  requestId: i.requestId,
  can: i.can,
});

/**
 * Admin API: /api/admin/customers/…  (docs/api/modules/customers.md)
 */
export const adminRoutes = (service: CustomersService) =>
  routes(endpoints, 'admin', {
    /** GET /guest-buyers: Guest buyers (orders without an account) with order count and spend */
    listGuestBuyers: async ({ query, page }) => service.listGuestBuyers(query, page),
    /** GET /customers: Customer accounts with orders, spend, open cases, status and verification */
    listCustomers: async ({ query, page }) => service.listCustomersAdmin(query, page),
    /** GET /customers/{id}: Customer detail: profile, orders, cases, messages, notes, abuse reports, restrictions */
    getCustomerAdmin: async (i) => service.getCustomerAdmin(i.params.id, staff(i)),
    /** POST /customers/{id}/notes: Add an internal note */
    addCustomerNote: async (i) => service.addNote(i.params.id, i.body, staff(i)),
    /** POST /customers/{id}/actions: Apply an account action with a recorded reason */
    applyAccountAction: async (i) => service.applyAccountAction(i.params.id, i.body, staff(i)),
    /** POST /customers/{id}/restrictions/{restrictionId}/lift: Lift a restriction early */
    liftRestriction: async (i) => service.liftRestriction(i.params.id, i.params.restrictionId, i.body, staff(i)),
    /** GET /customers/{id}/actions: Account action history for one customer */
    listAccountActions: async ({ params, page }) => service.listAccountActions(params.id, page),
    /** POST /customers/exports: Export the filtered customer list */
    exportCustomers: async (i) => service.exportCustomers(i.body, staff(i)),
    /** GET /data-requests: Export and closure requests across customers (privacy queue) */
    listDataRequestsAdmin: async ({ query, page }) => service.listDataRequestsAdmin(query, page),
    /** POST /data-requests/{id}/retry: Retry a failed export */
    retryDataRequest: async (i) => service.retryDataRequest(i.params.id, staff(i)),
  });
