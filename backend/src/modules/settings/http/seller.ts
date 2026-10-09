import { routes } from '../../../kernel/http/index.js';
import { pageOf } from '../../../kernel/lib/pagination.js';
import { endpoints } from '../../../spec/settings.js';
import type { SettingsService } from '../service.js';

/**
 * Seller API: /api/seller/settings/…  (docs/api/modules/settings.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: SettingsService) =>
  routes(endpoints, 'seller', {
    /** GET /upcoming-changes: Scheduled platform changes that affect sellers (a bounded list, paged in memory) */
    listUpcomingChanges: async ({ principal, page }) => pageOf(await service.upcomingChangesForSellers(principal), page),
  });
