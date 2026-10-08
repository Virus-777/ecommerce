import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/trust.js';
import type { TrustService } from '../service.js';

/**
 * Admin API: /api/admin/trust/…  (docs/api/modules/trust.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: TrustService) =>
  routes(endpoints, 'admin', {
    /** GET /overview: Open reports by type, high risk, appeals waiting */
    getTrustOverview: notImplemented,
    /** GET /reports: Trust queue, highest risk first */
    listReports: notImplemented,
    /** GET /reports/{id}: Report with evidence, linked records, recommendations, enforcement and timeline */
    getReport: notImplemented,
    /** POST /reports: Open a report as staff */
    createReportStaff: notImplemented,
    /** POST /reports/{id}/assign: Assign an investigator (moves to under review) */
    assignReport: notImplemented,
    /** POST /reports/{id}/escalate: Escalate to the Trust and Risk Manager or Business Owner */
    escalateReport: notImplemented,
    /** POST /reports/{id}/evidence: Add evidence (check result, document, photo, note, linked record) */
    addEvidence: notImplemented,
    /** POST /reports/{id}/evidence-requests: Ask the seller or customer for proof with a deadline */
    requestEvidence: notImplemented,
    /** POST /reports/{id}/links: Link more subjects or a support case */
    linkRecords: notImplemented,
    /** POST /reports/{id}/risk-score: Override the risk score with a reason */
    overrideRiskScore: notImplemented,
    /** POST /reports/{id}/notes: Internal note */
    addReportNote: notImplemented,
    /** POST /reports/{id}/assessment: Record the risk assessment for a seller application or account */
    recordAssessment: notImplemented,
    /** POST /reports/{id}/recommendations: Draft an enforcement recommendation for an owner team */
    addRecommendation: notImplemented,
    /** POST /recommendations/{id}/route: Send a recommendation to its owner team */
    routeRecommendation: notImplemented,
    /** GET /recommendations: Recommendations waiting for my team */
    listOwnerRecommendations: notImplemented,
    /** POST /recommendations/{id}/decide: Owner team accepts (records enforcement) or declines with a reason */
    decideRecommendation: notImplemented,
    /** POST /recommendations/{id}/withdraw: Withdraw a recommendation */
    withdrawRecommendation: notImplemented,
    /** POST /reports/{id}/resolve: Resolve with an outcome and what the reporter is told */
    resolveReport: notImplemented,
    /** POST /reports/{id}/dismiss: Dismiss with a reason */
    dismissReport: notImplemented,
    /** POST /reports/{id}/reopen: Reopen with a reason (new evidence) */
    reopenReport: notImplemented,
    /** POST /reports/{id}/merge: Merge a duplicate report into another */
    mergeReport: notImplemented,
    /** GET /enforcements: Recorded enforcement with execution state */
    listEnforcements: notImplemented,
    /** POST /enforcements/{id}/reverse: Reverse an enforcement (overturned appeal or error) */
    reverseEnforcement: notImplemented,
    /** GET /appeals: Appeals on trust enforcement plus linked seller restriction appeals */
    listAppeals: notImplemented,
    /** POST /appeals/{id}/assign: Assign a reviewer who did not make the decision */
    assignAppealReviewer: notImplemented,
    /** POST /appeals/{id}/decide: Uphold, overturn or partly overturn */
    decideTrustAppeal: notImplemented,
    /** POST /reports/exports: Export the filtered trust queue */
    exportReports: notImplemented,
    /** GET /detection-rules: Automated detection rules with recent hits */
    listDetectionRules: notImplemented,
    /** PATCH /detection-rules/{key}: Turn a rule on or off or change its thresholds */
    updateDetectionRule: notImplemented,
  });
