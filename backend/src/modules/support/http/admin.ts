import type { Principal } from '../../../kernel/auth/index.js';
import { routes } from '../../../kernel/http/index.js';
import type * as common from '../../../spec/common.js';
import { endpoints } from '../../../spec/support.js';
import type { By } from '../service/core.js';
import type { SupportService } from '../service.js';

/**
 * Admin API: /api/admin/support/…  (docs/api/modules/support.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: SupportService) => {
  const any = (id: string) => service.core.visible(id, { area: 'admin' });
  const detail = async (id: string) => service.views.adminDetail((await service.core.load(id))!);
  const by = (i: { actor: common.Actor; requestId: string; principal: Principal; can: (p: string) => Promise<boolean> }): By => ({ actor: i.actor, requestId: i.requestId, principal: i.principal, can: i.can });

  return routes(endpoints, 'admin', {
    /** GET /cases/stats: Queue KPIs: open, past target, unassigned, disputes, median first reply */
    caseStats: async () => service.reads.stats(),
    /** GET /cases: Cases and disputes queue, overdue first */
    listAdminCases: async ({ query, page, principal }) => service.reads.listAdmin(query, principal.accountId ?? null, page),
    /** GET /cases/{id}: Dispute review: parties, purchase terms at order time, shipment evidence, photos, conversation with internal notes, deadlines, holds */
    getAdminCase: async ({ params }) => service.views.adminDetail(await any(params.id)),
    /** POST /cases: Open a case on behalf of a customer or seller */
    createStaffCase: async (i) => {
      const agg = await service.cases.createForStaff(i.body, by(i));
      await service.core.audit({ action: 'support.case.create', actionLabel: `Opened case ${agg.c.ref} for the ${agg.c.kind === 'seller_request' ? 'seller' : 'customer'}`, target: service.cases.target(agg), after: { kind: agg.c.kind, category: agg.c.category_key, customerId: agg.c.customer_id, sellerId: agg.c.seller_id, orderId: agg.c.order_id } }, by(i));
      return service.views.adminDetail(agg);
    },
    /** POST /cases/assign: Assign several cases to one owner */
    bulkAssignCases: async (i) => service.cases.bulkAssign(i.body, by(i)),
    /** POST /cases/priority: Change the priority of several cases with one reason */
    bulkSetPriority: async (i) => service.cases.bulkSetPriority(i.body, by(i)),
    /** GET /assignees: Staff who can own cases, with team and current open case count */
    listAssignees: async ({ query }) => service.reads.assignees(query),
    /** POST /cases/{id}/assign: Assign or reassign the owner */
    assignCase: async (i) => {
      const agg = await any(i.params.id);
      return service.views.adminDetail(await service.cases.assign(agg.c.id, i.body.ownerId, { reason: i.body.reason ?? null }, by(i)));
    },
    /** PATCH /cases/{id}: Change category or priority with a reason */
    updateCase: async (i) => service.views.adminDetail(await service.cases.updateCase(await any(i.params.id), i.body, by(i))),
    /** POST /cases/{id}/messages: Reply to both parties, one party, or add an internal note */
    staffMessage: async (i) => {
      const agg = await any(i.params.id);
      await service.cases.staffMessage(agg, i.body, by(i));
      return detail(agg.c.id);
    },
    /** POST /cases/{id}/request-info: Ask the customer or the seller for information or evidence by a deadline */
    staffRequestInfo: async (i) => {
      const agg = await any(i.params.id);
      await service.cases.requestInfo(agg, i.body, by(i));
      return detail(agg.c.id);
    },
    /** POST /cases/{id}/escalate: Escalate to another team (Returns, Finance, Trust and Risk, Seller Manager, support lead) */
    staffEscalate: async (i) => {
      const agg = await any(i.params.id);
      await service.cases.staffEscalate(agg, i.body, by(i));
      return detail(agg.c.id);
    },
    /** POST /cases/{id}/evidence: Attach evidence gathered by staff (carrier records, screenshots) */
    addStaffEvidence: async (i) => service.cases.addEvidence(await any(i.params.id), i.body, 'staff', by(i)),
    /** POST /cases/{id}/decide: Record the decision and remedy, publish the appeal deadline to both parties */
    decideCase: async (i) => {
      const agg = await any(i.params.id);
      await service.decisions.decide(agg, i.body, by(i));
      return detail(agg.c.id);
    },
    /** PUT /cases/{id}/decision-draft: Save an unpublished decision draft (staff only) */
    saveDecisionDraft: async (i) => service.decisions.saveDraft(await any(i.params.id), i.body, by(i)),
    /** DELETE /cases/{id}/decision-draft: Discard the decision draft */
    deleteDecisionDraft: async (i) => {
      const agg = await any(i.params.id);
      await service.decisions.deleteDraft(agg, by(i));
    },
    /** POST /cases/{id}/resolve: Resolve a case */
    resolveCase: async (i) => {
      const agg = await any(i.params.id);
      await service.decisions.resolve(agg, i.body, by(i));
      return detail(agg.c.id);
    },
    /** POST /cases/{id}/reopen: Reopen a resolved or closed case */
    staffReopen: async (i) => {
      const agg = await any(i.params.id);
      await service.decisions.reopen(agg, i.body, 'staff', by(i));
      return detail(agg.c.id);
    },
    /** POST /cases/{id}/appeal/decide: Decide an appeal (reviewer must differ from the original decider) */
    decideAppeal: async (i) => {
      const agg = await any(i.params.id);
      await service.decisions.decideAppeal(agg, i.body, by(i));
      return detail(agg.c.id);
    },
    /** GET /categories: Case categories with priority, team and SLA targets */
    listCategories: async () => [...(await service.core.categories()).values()].map((c) => service.core.categoryView(c)),
    /** PUT /categories/{key}: Create or change a category and its targets */
    updateCategory: async (i) => service.cases.updateCategory(i.params.key, i.body, by(i)),
    /** POST /cases/{id}/remedies/{remedyId}/settle: Record that a remedy was completed or cancelled outside the system */
    settleRemedy: async (i) => {
      const agg = await any(i.params.id);
      await service.decisions.settleRemedy(agg, i.params.remedyId, i.body, by(i));
      return detail(agg.c.id);
    },
  });
};
