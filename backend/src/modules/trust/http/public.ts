import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/trust.js';
import type { TrustService } from '../service.js';
import { byOf } from './who.js';

/**
 * Public API: /api/public/trust/…  (docs/api/modules/trust.md)
 */
export const publicRoutes = (service: TrustService) =>
  routes(endpoints, 'public', {
    /** POST /reports: Brand or rights owner reports counterfeit listings */
    submitRightsOwnerReport: async (i) => service.reports.rightsOwner(i.body, { ...byOf(i), sessionId: i.principal?.guestSessionId ?? i.principal?.sessionId ?? null }),
  });
