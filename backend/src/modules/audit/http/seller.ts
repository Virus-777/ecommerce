import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/audit.js';
import type { AuditService } from '../service.js';

/**
 * Seller API: /api/seller/audit/…  (docs/api/modules/audit.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: AuditService) =>
  routes(endpoints, 'seller', {
    /** GET /entries: Changes made on this seller account */
    listOwnSellerEntries: notImplemented,
  });
