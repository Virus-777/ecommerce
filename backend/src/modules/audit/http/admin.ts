import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/audit.js';
import type { AuditService } from '../service.js';

/**
 * Admin API: /api/admin/audit/…  (docs/api/modules/audit.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: AuditService) => {
  void service;
  return routes(endpoints, 'admin', {
    /** GET /entries: Action history with filters */
    listEntries: notImplemented,
    /** GET /entries/{id}: One entry with evidence and approval history */
    getEntry: notImplemented,
    /** GET /summary: Counts for the filter chips (pending second review, financial, enforcement, settings) */
    getSummary: notImplemented,
    /** GET /targets/{type}/{id}: History of one record (order, seller, payout, product, setting…) */
    listTargetHistory: notImplemented,
    /** POST /exports: Export filtered history (authorized, recorded) */
    createExport: notImplemented,
    /** GET /exports: My exports (all exports with audit.retention.manage) */
    listExports: notImplemented,
    /** GET /exports/{id}: Export status and a fresh download link */
    getExport: notImplemented,
    /** GET /retention: Retention setting and last purge */
    getRetention: notImplemented,
    /** PUT /retention: Change how long history is kept */
    updateRetention: notImplemented,
    /** GET /integrity: Hash-chain check result */
    getIntegrity: notImplemented,
  });
};
