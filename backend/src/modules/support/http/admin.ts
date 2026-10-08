import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/support.js';
import type { SupportService } from '../service.js';

/**
 * Admin API: /api/admin/support/…  (docs/api/modules/support.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: SupportService) =>
  routes(endpoints, 'admin', {
    /** GET /cases/stats: Queue KPIs: open, past target, unassigned, disputes, median first reply */
    caseStats: notImplemented,
    /** GET /cases: Cases and disputes queue, overdue first */
    listAdminCases: notImplemented,
    /** GET /cases/{id}: Dispute review: parties, purchase terms at order time, shipment evidence, photos, conversation with internal notes, deadlines, holds */
    getAdminCase: notImplemented,
    /** POST /cases: Open a case on behalf of a customer or seller */
    createStaffCase: notImplemented,
    /** POST /cases/assign: Assign several cases to one owner */
    bulkAssignCases: notImplemented,
    /** POST /cases/priority: Change the priority of several cases with one reason */
    bulkSetPriority: notImplemented,
    /** GET /assignees: Staff who can own cases, with team and current open case count */
    listAssignees: notImplemented,
    /** POST /cases/{id}/assign: Assign or reassign the owner */
    assignCase: notImplemented,
    /** PATCH /cases/{id}: Change category or priority with a reason */
    updateCase: notImplemented,
    /** POST /cases/{id}/messages: Reply to both parties, one party, or add an internal note */
    staffMessage: notImplemented,
    /** POST /cases/{id}/request-info: Ask the customer or the seller for information or evidence by a deadline */
    staffRequestInfo: notImplemented,
    /** POST /cases/{id}/escalate: Escalate to another team (Returns, Finance, Trust and Risk, Seller Manager, support lead) */
    staffEscalate: notImplemented,
    /** POST /cases/{id}/evidence: Attach evidence gathered by staff (carrier records, screenshots) */
    addStaffEvidence: notImplemented,
    /** POST /cases/{id}/decide: Record the decision and remedy, publish the appeal deadline to both parties */
    decideCase: notImplemented,
    /** PUT /cases/{id}/decision-draft: Save an unpublished decision draft (staff only) */
    saveDecisionDraft: notImplemented,
    /** DELETE /cases/{id}/decision-draft: Discard the decision draft */
    deleteDecisionDraft: notImplemented,
    /** POST /cases/{id}/resolve: Resolve a case */
    resolveCase: notImplemented,
    /** POST /cases/{id}/reopen: Reopen a resolved or closed case */
    staffReopen: notImplemented,
    /** POST /cases/{id}/appeal/decide: Decide an appeal (reviewer must differ from the original decider) */
    decideAppeal: notImplemented,
    /** GET /categories: Case categories with priority, team and SLA targets */
    listCategories: notImplemented,
    /** PUT /categories/{key}: Create or change a category and its targets */
    updateCategory: notImplemented,
  });
