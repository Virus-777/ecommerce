import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/workqueues.js';
import type { WorkqueuesService } from '../service.js';

/**
 * Seller API: /api/seller/workqueues/…  (docs/api/modules/workqueues.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: WorkqueuesService) => {
  void service;
  return routes(endpoints, 'seller', {
    /** GET /tasks: Tasks Marketly is tracking for this seller (e.g. overdue dispatch, missing tracking, reply overdue) */
    listSellerTasks: notImplemented,
  });
};
