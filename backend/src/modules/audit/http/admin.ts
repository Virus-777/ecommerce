import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/audit.js';
import type { AuditService, Caller } from '../service.js';

const caller = (i: { principal: Caller['principal']; actor: Caller['actor']; requestId: string; request: { ip?: string } }): Caller => ({
  principal: i.principal,
  actor: i.actor,
  requestId: i.requestId,
  ip: i.request.ip ?? null,
});

/**
 * Admin API: /api/admin/audit/…  (docs/api/modules/audit.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: AuditService) =>
  routes(endpoints, 'admin', {
    /** GET /entries: Action history with filters */
    listEntries: async ({ query, page }) => service.search(query, page),
    /** GET /entries/{id}: One entry with evidence and approval history */
    getEntry: async ({ params }) => service.entryOrThrow(params.id),
    /** GET /summary: Counts for the filter chips (pending second review, financial, enforcement, settings) */
    getSummary: async ({ query }) => service.summary(query),
    /** GET /targets/{type}/{id}: History of one record (order, seller, payout, product, setting…) */
    listTargetHistory: async ({ params, page }) => service.targetHistory(params.type, params.id, page),
    /** POST /exports: Export filtered history (authorized, recorded) */
    createExport: async (input) => service.createExport(input.body, caller(input)),
    /** GET /exports: My exports (all exports with audit.retention.manage) */
    listExports: async (input) => service.listExports(input.query.status, input.page, caller(input), await input.can('audit.retention.manage')),
    /** GET /exports/{id}: Export status and a fresh download link */
    getExport: async (input) => service.getExport(input.params.id, caller(input)),
    /** GET /retention: Retention setting and last purge */
    getRetention: async () => service.getRetention(),
    /** PUT /retention: Change how long history is kept */
    updateRetention: async (input) => {
      const { policy, status } = await service.updateRetention(input.body, caller(input));
      // shortening waits for approval: 202 with pendingChange (the spec's default status is 200)
      if (status === 202) input.reply.code(202).send(policy);
      return policy;
    },
    /** GET /integrity: Hash-chain check result */
    getIntegrity: async () => service.integrity(),
  });
