import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/reports.js';
import type { ReportsService } from '../service.js';

/**
 * Store API: /api/store/reports/…  (docs/api/modules/reports.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: ReportsService) =>
  routes(endpoints, 'store', {
    /** POST /signals: Batched anonymous discovery signals from the website and app (product views) */
    recordStoreSignals: async (i) => {
      const customerId = i.scope.kind === 'customer' ? i.scope.customerId : null;
      await service.readModels.recordStoreSignals(i.body.signals, i.principal, customerId);
    },
  });
