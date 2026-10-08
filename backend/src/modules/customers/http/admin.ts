import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/customers.js';
import type { CustomersService } from '../service.js';

/**
 * Admin API: /api/admin/customers/…  (docs/api/modules/customers.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: CustomersService) =>
  routes(endpoints, 'admin', {
    /** GET /guest-buyers: Guest buyers (orders without an account) with order count and spend */
    listGuestBuyers: notImplemented,
    /** GET /customers: Customer accounts with orders, spend, open cases, status and verification */
    listCustomers: notImplemented,
    /** GET /customers/{id}: Customer detail: profile, orders, cases, messages, notes, abuse reports, restrictions */
    getCustomerAdmin: notImplemented,
    /** POST /customers/{id}/notes: Add an internal note */
    addCustomerNote: notImplemented,
    /** POST /customers/{id}/actions: Apply an account action with a recorded reason */
    applyAccountAction: notImplemented,
    /** POST /customers/{id}/restrictions/{restrictionId}/lift: Lift a restriction early */
    liftRestriction: notImplemented,
    /** GET /customers/{id}/actions: Account action history for one customer */
    listAccountActions: notImplemented,
    /** POST /customers/exports: Export the filtered customer list */
    exportCustomers: notImplemented,
    /** GET /data-requests: Export and closure requests across customers (privacy queue) */
    listDataRequestsAdmin: notImplemented,
    /** POST /data-requests/{id}/retry: Retry a failed export */
    retryDataRequest: notImplemented,
  });
