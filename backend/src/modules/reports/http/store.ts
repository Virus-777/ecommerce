import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/reports.js';
import type { ReportsService } from '../service.js';

/**
 * Store API: /api/store/reports/…  (docs/api/modules/reports.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: ReportsService) => {
  void service;
  return routes(endpoints, 'store', {
    /** POST /signals: Batched anonymous discovery signals from the website and app (product views) */
    recordStoreSignals: notImplemented,
  });
};
