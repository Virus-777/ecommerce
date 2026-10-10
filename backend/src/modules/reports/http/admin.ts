import { routes, notImplemented } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/reports.js';
import type { Caller, ReportsService } from '../service.js';

const by = (i: { principal: Caller['principal']; actor: Caller['actor']; requestId: string; can: (p: string) => Promise<boolean> }): Caller => ({ principal: i.principal, actor: i.actor, requestId: i.requestId, can: i.can });

/**
 * Admin API: /api/admin/reports/…  (docs/api/modules/reports.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: ReportsService) =>
  routes(endpoints, 'admin', {
    /** GET /catalogue: Report library by group with owners */
    getCatalogue: async (i) => service.defs.catalogue(by(i)),
    /** GET /reports/{key}: One report: metrics, filters, layout and definitions */
    getReportDefinition: async (i) => service.defs.reportDefinition(i.params.key, by(i)),
    /** POST /reports/{key}/query: Run a report with filters */
    runReport: async (i) => service.runReport(i.params.key, i.body, by(i)),
    /** GET /dashboard: Admin dashboard figures: gross sales, orders, fee income, refunds and the sales split */
    getAdminDashboard: async (i) => service.getAdminDashboard(i.query.period ?? 'last_7_days', i.principal),
    /** GET /metrics: Metric definitions */
    listMetrics: async (i) => service.defs.listMetrics(i.query),
    /** GET /metrics/{key}: A metric with its version history */
    getMetric: async (i) => service.defs.getMetric(i.params.key),
    /** POST /metrics: Create a metric definition (draft) */
    createMetric: async (i) => service.defs.createMetric(i.body, by(i)),
    /** PATCH /metrics/{key}: Revise a definition (new draft version) */
    reviseMetric: async (i) => service.defs.reviseMetric(i.params.key, i.body, by(i)),
    /** POST /metrics/{key}/publish: Publish the draft version with an effective date */
    publishMetric: async (i) => service.defs.publishMetric(i.params.key, i.body, by(i)),
    /** POST /metrics/{key}/retire: Retire a metric */
    retireMetric: async (i) => service.defs.retireMetric(i.params.key, i.body, by(i)),
    /** POST /metrics/{key}/suggestions: Suggest a change to a definition */
    suggestMetricChange: async (i) => service.defs.suggestChange(i.params.key, i.body, by(i)),
    /** POST /metric-suggestions/{id}/decide: Accept or decline a suggestion */
    decideMetricSuggestion: async (i) => service.defs.decideSuggestion(i.params.id, i.body, by(i)),
    /** GET /saved-views: My saved report views plus shared ones */
    listSavedViews: async (i) => service.defs.listSavedViews(i.query.reportKey, by(i)),
    /** POST /saved-views: Save the current filters as a view */
    createSavedView: async (i) => service.createSavedView(i.body, by(i)),
    /** DELETE /saved-views/{id}: Delete a saved view (owner only) */
    deleteSavedView: async (i) => service.defs.deleteSavedView(i.params.id, by(i)),
    /** POST /exports: Export a report or a registered dataset */
    createExport: async (i) => service.exports.request(i.body, by(i), 'admin'),
    /** GET /export-datasets: Export dataset registry: what each screen can export, its owner and permission */
    listExportDatasets: async (i) => service.exports.listDatasets({ ...(i.query.screen ? { screen: i.query.screen } : {}), all: Boolean(i.query.all) }, by(i)),
    /** GET /exports: My exports */
    listExports: async (i) => service.exports.listMine(i.page, i.principal),
    /** GET /exports/{id}: Export status and download link (requester only) */
    getExport: async (i) => service.exports.get(i.params.id, i.principal, by(i)),
    /** POST /schedules: Email a report on a schedule */
    createSchedule: async (i) => service.defs.createSchedule(i.body, by(i)),
    /** GET /schedules: Report email schedules */
    listSchedules: async () => service.defs.listSchedules(),
    /** DELETE /schedules/{id}: Stop a schedule */
    deleteSchedule: async (i) => service.defs.deleteSchedule(i.params.id, by(i)),
    /** GET /read-models: Read model health: lag, last event, rebuild state */
    listReadModels: async () => service.readModels.status(),
    /** POST /read-models/{key}/rebuild: Rebuild a read model from the event log or source snapshots */
    rebuildReadModel: async (i) => service.readModels.requestRebuild(i.params.key, i.body.reason, by(i)),
    /** PUT /metrics/{key}/owner: Name (or change) the staff member who owns a metric (TODO pass 3: implement) */
    setMetricOwner: notImplemented,
    /** PUT /groups/{key}/owner: Name (or change) the staff member who owns a report group (TODO pass 3: implement) */
    setGroupOwner: notImplemented,
  });
