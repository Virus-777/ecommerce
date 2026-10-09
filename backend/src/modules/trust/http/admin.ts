import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/trust.js';
import type { TrustService } from '../service.js';
import { byOf } from './who.js';

/**
 * Admin API: /api/admin/trust/…  (docs/api/modules/trust.md)
 * Thin: map the request to the use case. Endpoint permissions are checked by the middleware; the owner team's
 * own permission, separate duties and authority are checked in the service.
 */
export const adminRoutes = (service: TrustService) =>
  routes(endpoints, 'admin', {
    /** GET /overview: Open reports by type, high risk, appeals waiting */
    getTrustOverview: async () => service.reports.overview(),
    /** GET /reports: Trust queue, highest risk first */
    listReports: async ({ query, page }) => service.reports.list(query, page),
    /** GET /reports/{id}: Report with evidence, linked records, recommendations, enforcement and timeline */
    getReport: async ({ params }) => service.reports.get(params.id),
    /** POST /reports: Open a report as staff */
    createReportStaff: async (i) => service.reports.createStaff(i.body, byOf(i)),
    /** POST /reports/{id}/assign: Assign an investigator (moves to under review) */
    assignReport: async (i) => service.reports.assign(i.params.id, i.body, byOf(i)),
    /** POST /reports/{id}/escalate: Escalate to the Trust and Risk Manager or Business Owner */
    escalateReport: async (i) => service.reports.escalate(i.params.id, i.body, byOf(i)),
    /** POST /reports/{id}/evidence: Add evidence (check result, document, photo, note, linked record) */
    addEvidence: async (i) => service.reports.addEvidence(i.params.id, i.body, byOf(i)),
    /** POST /reports/{id}/evidence-requests: Ask the seller or customer for proof with a deadline */
    requestEvidence: async (i) => service.reports.requestEvidence(i.params.id, i.body, byOf(i)),
    /** POST /reports/{id}/links: Link more subjects or a support case */
    linkRecords: async (i) => service.reports.link(i.params.id, i.body, byOf(i)),
    /** POST /reports/{id}/risk-score: Override the risk score with a reason */
    overrideRiskScore: async (i) => service.reports.overrideRisk(i.params.id, i.body, byOf(i)),
    /** POST /reports/{id}/notes: Internal note */
    addReportNote: async (i) => service.reports.note(i.params.id, i.body, byOf(i)),
    /** POST /reports/{id}/assessment: Record the risk assessment for a seller application or account */
    recordAssessment: async (i) => service.reports.assess(i.params.id, i.body, byOf(i)),
    /** POST /reports/{id}/recommendations: Draft an enforcement recommendation for an owner team */
    addRecommendation: async (i) => service.actions.add(i.params.id, i.body, byOf(i)),
    /** POST /recommendations/{id}/route: Send a recommendation to its owner team */
    routeRecommendation: async (i) => service.actions.route(i.params.id, byOf(i)),
    /** GET /recommendations: Recommendations waiting for my team */
    listOwnerRecommendations: async (i) => service.actions.listForOwner(i.query, i.page, byOf(i)),
    /** POST /recommendations/{id}/decide: Owner team accepts (records enforcement) or declines with a reason */
    decideRecommendation: async (i) => service.actions.decide(i.params.id, i.body, byOf(i)),
    /** POST /recommendations/{id}/withdraw: Withdraw a recommendation */
    withdrawRecommendation: async (i) => service.actions.withdraw(i.params.id, i.body, byOf(i)),
    /** POST /reports/{id}/resolve: Resolve with an outcome and what the reporter is told */
    resolveReport: async (i) => service.reports.resolve(i.params.id, i.body, byOf(i)),
    /** POST /reports/{id}/dismiss: Dismiss with a reason */
    dismissReport: async (i) => service.reports.dismiss(i.params.id, i.body, byOf(i)),
    /** POST /reports/{id}/reopen: Reopen with a reason (new evidence) */
    reopenReport: async (i) => service.reports.reopen(i.params.id, i.body, byOf(i)),
    /** POST /reports/{id}/merge: Merge a duplicate report into another */
    mergeReport: async (i) => service.reports.merge(i.params.id, i.body, byOf(i)),
    /** GET /enforcements: Recorded enforcement with execution state */
    listEnforcements: async ({ query, page }) => service.actions.list(query, page),
    /** POST /enforcements/{id}/reverse: Reverse an enforcement (overturned appeal or error) */
    reverseEnforcement: async (i) => service.actions.reverse(i.params.id, i.body, byOf(i)),
    /** GET /appeals: Appeals on trust enforcement plus linked seller restriction appeals */
    listAppeals: async ({ query, page }) => service.appeals.list(query, page),
    /** POST /appeals/{id}/assign: Assign a reviewer who did not make the decision */
    assignAppealReviewer: async (i) => service.appeals.assign(i.params.id, i.body, byOf(i)),
    /** POST /appeals/{id}/decide: Uphold, overturn or partly overturn */
    decideTrustAppeal: async (i) => service.appeals.decide(i.params.id, i.body, byOf(i)),
    /** POST /reports/exports: Export the filtered trust queue */
    exportReports: async (i) => service.reports.requestExport(i.body, i.principal, byOf(i)),
    /** GET /detection-rules: Automated detection rules with recent hits */
    listDetectionRules: async () => service.detection.listRules(),
    /** PATCH /detection-rules/{key}: Turn a rule on or off or change its thresholds */
    updateDetectionRule: async (i) => service.detection.updateRule(i.params.key, i.body, byOf(i)),
  });
