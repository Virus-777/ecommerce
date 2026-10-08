import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/trust.js';
import type { TrustService } from '../service.js';

/**
 * Public API: /api/public/trust/…  (docs/api/modules/trust.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const publicRoutes = (service: TrustService) => {
  void service;
  return routes(endpoints, 'public', {
    /** POST /reports: Brand or rights owner reports counterfeit listings */
    submitRightsOwnerReport: notImplemented,
  });
};
