import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/workqueues.js';
import type { WorkqueuesService } from '../service.js';

/**
 * Admin API: /api/admin/workqueues/…  (docs/api/modules/workqueues.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: WorkqueuesService) => {
  void service;
  return routes(endpoints, 'admin', {
    /** GET /me: My work queues: stats, queues with lead, backup and escalation, routine, day-end review, saved filters */
    getMyQueues: notImplemented,
    /** GET /queues: Queue definitions with live counts */
    listQueues: notImplemented,
    /** GET /queues/{key}: One queue definition with its intake rules */
    getQueue: notImplemented,
    /** POST /queues: Create a queue (lead, backup and escalation route required) */
    createQueue: notImplemented,
    /** PATCH /queues/{key}: Change lead, backup, escalation route or deadline */
    updateQueue: notImplemented,
    /** GET /intake-rules: Which events open and close items in which queue */
    listIntakeRules: notImplemented,
    /** GET /coverage-gaps: Queues without a lead or backup, leads who are away without cover, one backup covering many queues */
    listCoverageGaps: notImplemented,
    /** GET /items: Work items with filters (also used by saved filters) */
    listItems: notImplemented,
    /** GET /items/{id}: One work item with notes and history */
    getItem: notImplemented,
    /** POST /items: Create a task by hand (managers assigning daily tasks) */
    createManualTask: notImplemented,
    /** POST /items/{id}/assign: Assign to a person (owner and next action) */
    assignItem: notImplemented,
    /** POST /items/{id}/claim: Assign to myself and start */
    claimItem: notImplemented,
    /** POST /items/{id}/start: Mark in progress */
    startItem: notImplemented,
    /** POST /items/{id}/wait: Waiting on someone else */
    waitItem: notImplemented,
    /** POST /items/{id}/resume: Back in progress */
    resumeItem: notImplemented,
    /** POST /items/{id}/resolve: Resolve by hand with a note */
    resolveItem: notImplemented,
    /** POST /items/{id}/dismiss: Dismiss with a reason (false alarm, duplicate) */
    dismissItem: notImplemented,
    /** POST /items/{id}/reopen: Reopen a resolved or dismissed item */
    reopenItem: notImplemented,
    /** POST /items/{id}/escalate: Escalate now to the next step of the route */
    escalateItem: notImplemented,
    /** POST /items/{id}/notes: Add a note */
    addItemNote: notImplemented,
    /** POST /items/bulk-assign: Assign many items at once */
    bulkAssign: notImplemented,
    /** POST /items/exports: Export the filtered items (authorized export) */
    exportItems: notImplemented,
    /** GET /summary: Dashboard: queues past or near target, overdue dispatch, team on shift */
    getWorkSummary: notImplemented,
    /** GET /day-end-reviews/current: Today's day-end review */
    getDayEndReview: notImplemented,
    /** POST /day-end-reviews/{id}/items/{itemKey}/check: Mark one day-end item reviewed */
    checkDayEndItem: notImplemented,
    /** POST /day-end-reviews/{id}/complete: Complete the review and send the summary to managers */
    completeDayEndReview: notImplemented,
    /** GET /day-end-reviews: Past day-end reviews */
    listDayEndReviews: notImplemented,
    /** GET /routines/today: Today's routine checks across areas */
    getRoutineToday: notImplemented,
    /** POST /routine-checks/{id}/complete: Mark a routine check done (or check in for a shared one) */
    completeRoutineCheck: notImplemented,
    /** GET /routine-templates: Daily routine definitions */
    listRoutineTemplates: notImplemented,
    /** PUT /routine-templates: Replace the daily routine */
    replaceRoutineTemplates: notImplemented,
    /** GET /saved-filters: My saved filters plus filters shared with me */
    listSavedFilters: notImplemented,
    /** POST /saved-filters: Save the current filter */
    createSavedFilter: notImplemented,
    /** PATCH /saved-filters/{id}: Rename, share or change a saved filter (owner only) */
    updateSavedFilter: notImplemented,
    /** DELETE /saved-filters/{id}: Delete a saved filter (owner only) */
    deleteSavedFilter: notImplemented,
  });
};
