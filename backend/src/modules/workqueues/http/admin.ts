import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import type { Actor } from '../../../spec/common.js';
import type { Principal } from '../../../spec/identity.js';
import { endpoints } from '../../../spec/workqueues.js';
import type { WorkqueuesService } from '../service.js';

/**
 * Admin API: /api/admin/workqueues/…  (docs/api/modules/workqueues.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: WorkqueuesService) => {
  const viewer = (i: { principal: Principal; can(p: string): Promise<boolean> }) => service.viewer(i.principal, (p) => i.can(p));
  const by = (i: { actor: Actor; requestId: string }) => ({ actor: i.actor, requestId: i.requestId });

  return routes(endpoints, 'admin', {
    /** GET /me: My work queues: stats, queues with lead, backup and escalation, routine, day-end review, saved filters */
    getMyQueues: async (i) => service.myQueues(await viewer(i), Boolean(i.query.all)),
    /** GET /queues: Queue definitions with live counts */
    listQueues: async (i) => service.queues.list(await viewer(i), { area: i.query.area, mine: i.query.mine }),
    /** GET /queues/{key}: One queue definition with its intake rules */
    getQueue: async (i) => service.queues.get(await viewer(i), i.params.key),
    /** POST /queues: Create a queue (lead, backup and escalation route required) */
    createQueue: async (i) => service.queues.create(i.body, by(i)),
    /** PATCH /queues/{key}: Change lead, backup, escalation route or deadline */
    updateQueue: async (i) => service.queues.update(i.params.key, i.body, by(i)),
    /** GET /intake-rules: Which events open and close items in which queue */
    listIntakeRules: async () => service.queues.intakeRules(),
    /** GET /coverage-gaps: Queues without a lead or backup, leads who are away without cover, one backup covering many queues */
    listCoverageGaps: async () => service.queues.coverageGaps(),
    /** GET /items: Work items with filters (also used by saved filters) */
    listItems: async (i) => service.items.list(await viewer(i), { ...i.query }, i.page),
    /** GET /items/{id}: One work item with notes and history */
    getItem: async (i) => service.items.get(await viewer(i), i.params.id),
    /** POST /items: Create a task by hand (managers assigning daily tasks) */
    createManualTask: async (i) => service.items.createManual(await viewer(i), i.body, by(i)),
    /** POST /items/{id}/assign: Assign to a person (owner and next action) */
    assignItem: async (i) => service.items.assign(await viewer(i), i.params.id, i.body, by(i)),
    /** POST /items/{id}/claim: Assign to myself and start */
    claimItem: async (i) => service.items.claim(await viewer(i), i.params.id, by(i)),
    /** POST /items/{id}/start: Mark in progress */
    startItem: async (i) => service.items.start(await viewer(i), i.params.id, by(i)),
    /** POST /items/{id}/wait: Waiting on someone else */
    waitItem: async (i) => service.items.wait(await viewer(i), i.params.id, i.body, by(i)),
    /** POST /items/{id}/resume: Back in progress */
    resumeItem: async (i) => service.items.resume(await viewer(i), i.params.id, by(i)),
    /** POST /items/{id}/resolve: Resolve by hand with a note */
    resolveItem: async (i) => service.items.resolve(await viewer(i), i.params.id, i.body.note, by(i), 'resolved'),
    /** POST /items/{id}/dismiss: Dismiss with a reason (false alarm, duplicate) */
    dismissItem: async (i) => service.items.resolve(await viewer(i), i.params.id, i.body.reason, by(i), 'dismissed'),
    /** POST /items/{id}/reopen: Reopen a resolved or dismissed item */
    reopenItem: async (i) => service.items.reopen(await viewer(i), i.params.id, i.body.reason, by(i)),
    /** POST /items/{id}/escalate: Escalate now to the next step of the route */
    escalateItem: async (i) => service.items.escalateNow(await viewer(i), i.params.id, i.body.reason, by(i)),
    /** POST /items/{id}/notes: Add a note */
    addItemNote: async (i) => service.items.addNote(await viewer(i), i.params.id, i.body.body, by(i)),
    /** POST /items/bulk-assign: Assign many items at once */
    bulkAssign: async (i) => {
      const v = await viewer(i);
      const res = await service.items.bulkAssign(v, i.body, by(i));
      await service.core.audit({ action: 'workqueues.item.bulk_assign', actionLabel: 'Assigned work items in bulk', target: { type: 'work_item', id: i.body.assigneeId, label: `${res.assigned} items` }, after: { assigneeId: i.body.assigneeId, assigned: res.assigned, skipped: res.skipped } }, by(i));
      return res;
    },
    /** POST /items/exports: Export the filtered items (authorized export) */
    exportItems: async (i) => {
      const v = await viewer(i);
      const reports = service.core.ctx.tryUse('reports');
      if (!reports) throw new AppError('SERVICE_UNAVAILABLE', 'Exports are not available: the reports module is off');
      const filters = i.body.filters && typeof i.body.filters === 'object' ? i.body.filters : {};
      // validate the filters the same way the list does; rows are limited to the caller's queues by exportRows
      await service.items.toQuery(v, filters as Record<string, unknown>, await service.core.repo.listQueues());
      const job = await reports.requestExport({ dataset: 'workqueues.admin.items', filters, format: i.body.format ?? 'csv', principal: i.principal });
      await service.core.audit({ action: 'workqueues.items.export', actionLabel: 'Exported work items', target: { type: 'export', id: job.id, ref: job.ref, label: 'Work items' }, after: { filters, format: i.body.format ?? 'csv' } }, by(i));
      return job;
    },
    /** GET /summary: Dashboard: queues past or near target, overdue dispatch, team on shift */
    getWorkSummary: async (i) => service.workSummary(await viewer(i)),
    /** GET /day-end-reviews/current: Today's day-end review */
    getDayEndReview: async () => service.dayEnd.current(),
    /** POST /day-end-reviews/{id}/items/{itemKey}/check: Mark one day-end item reviewed */
    checkDayEndItem: async (i) => service.dayEnd.check(await viewer(i), i.params.id, i.params.itemKey, i.body.note, by(i)),
    /** POST /day-end-reviews/{id}/complete: Complete the review and send the summary to managers */
    completeDayEndReview: async (i) => service.dayEnd.complete(await viewer(i), i.params.id, i.body.note, by(i)),
    /** GET /day-end-reviews: Past day-end reviews */
    listDayEndReviews: async (i) => service.dayEnd.list({ from: i.query.from, to: i.query.to, state: i.query.state }, i.page),
    /** GET /routines/today: Today's routine checks across areas */
    getRoutineToday: async () => service.routines.today(),
    /** POST /routine-checks/{id}/complete: Mark a routine check done (or check in for a shared one) */
    completeRoutineCheck: async (i) => service.routines.complete(await viewer(i), i.params.id, i.body.note, by(i)),
    /** GET /routine-templates: Daily routine definitions */
    listRoutineTemplates: async () => service.routines.templates(),
    /** PUT /routine-templates: Replace the daily routine */
    replaceRoutineTemplates: async (i) => service.routines.replace(i.body.templates, i.body.reason, by(i)),
    /** GET /saved-filters: My saved filters plus filters shared with me */
    listSavedFilters: async (i) => service.filters.list(await viewer(i), i.query.screen),
    /** POST /saved-filters: Save the current filter */
    createSavedFilter: async (i) => service.filters.create(await viewer(i), i.body),
    /** PATCH /saved-filters/{id}: Rename, share or change a saved filter (owner only) */
    updateSavedFilter: async (i) => service.filters.update(await viewer(i), i.params.id, i.body),
    /** DELETE /saved-filters/{id}: Delete a saved filter (owner only) */
    deleteSavedFilter: async (i) => {
      await service.filters.remove(await viewer(i), i.params.id);
    },
  });
};
