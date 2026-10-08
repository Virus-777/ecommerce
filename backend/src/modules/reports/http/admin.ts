import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/reports.js';
import type { ReportsService } from '../service.js';

/**
 * Admin API: /api/admin/reports/…  (docs/api/modules/reports.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: ReportsService) => {
  void service;
  return routes(endpoints, 'admin', {
    /** GET /catalogue: Report library by group with owners */
    getCatalogue: notImplemented,
    /** GET /reports/{key}: One report: metrics, filters, layout and definitions */
    getReportDefinition: notImplemented,
    /** POST /reports/{key}/query: Run a report with filters */
    runReport: notImplemented,
    /** GET /dashboard: Admin dashboard figures: gross sales, orders, fee income, refunds and the sales split */
    getAdminDashboard: notImplemented,
    /** GET /metrics: Metric definitions */
    listMetrics: notImplemented,
    /** GET /metrics/{key}: A metric with its version history */
    getMetric: notImplemented,
    /** POST /metrics: Create a metric definition (draft) */
    createMetric: notImplemented,
    /** PATCH /metrics/{key}: Revise a definition (new draft version) */
    reviseMetric: notImplemented,
    /** POST /metrics/{key}/publish: Publish the draft version with an effective date */
    publishMetric: notImplemented,
    /** POST /metrics/{key}/retire: Retire a metric */
    retireMetric: notImplemented,
    /** POST /metrics/{key}/suggestions: Suggest a change to a definition */
    suggestMetricChange: notImplemented,
    /** POST /metric-suggestions/{id}/decide: Accept or decline a suggestion */
    decideMetricSuggestion: notImplemented,
    /** GET /saved-views: My saved report views plus shared ones */
    listSavedViews: notImplemented,
    /** POST /saved-views: Save the current filters as a view */
    createSavedView: notImplemented,
    /** DELETE /saved-views/{id}: Delete a saved view (owner only) */
    deleteSavedView: notImplemented,
    /** POST /exports: Export a report or a registered dataset */
    createExport: notImplemented,
    /** GET /export-datasets: Export dataset registry: what each screen can export, its owner and permission */
    listExportDatasets: notImplemented,
    /** GET /exports: My exports */
    listExports: notImplemented,
    /** GET /exports/{id}: Export status and download link (requester only) */
    getExport: notImplemented,
    /** POST /schedules: Email a report on a schedule */
    createSchedule: notImplemented,
    /** GET /schedules: Report email schedules */
    listSchedules: notImplemented,
    /** DELETE /schedules/{id}: Stop a schedule */
    deleteSchedule: notImplemented,
    /** GET /read-models: Read model health: lag, last event, rebuild state */
    listReadModels: notImplemented,
    /** POST /read-models/{key}/rebuild: Rebuild a read model from the event log or source snapshots */
    rebuildReadModel: notImplemented,
  });
};
