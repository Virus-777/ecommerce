import { AppError, isNotImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import { toPageRequest } from '../../kernel/lib/pagination.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { WorkqueuesPublicApi, WorkItem, RaiseInput, MyQueues, WorkSummary } from '../../spec/workqueues.js';
import { Core, SYSTEM, type Viewer } from './app/core.js';
import { DayEnd } from './app/dayend.js';
import { Filters } from './app/filters.js';
import { Intake } from './app/intake.js';
import { Items, type FilterInput } from './app/items.js';
import { Queues } from './app/queues.js';
import { Routines } from './app/routines.js';
import { Sweep } from './app/sweep.js';
import { AREAS, type Priority } from './domain/catalog.js';
import { addDays, ageLabel } from './domain/rules.js';
import type { ArchiveStore, WorkqueuesRepository } from './ports.js';

export interface WorkqueuesServiceDeps {
  repo: WorkqueuesRepository;
  ctx: ModuleContext<'workqueues'>;
  archive: ArchiveStore;
}

const DISPATCH_KINDS = ['overdue_dispatch', 'missing_tracking', 'seller_cannot_fulfill'];

/** Columns of the reports dataset workqueues.admin.items (rows from exportRows) */
const EXPORT_COLUMNS = [
  { key: 'ref', label: 'Item' },
  { key: 'queue', label: 'Queue' },
  { key: 'area', label: 'Area' },
  { key: 'kind', label: 'Kind' },
  { key: 'title', label: 'Title' },
  { key: 'subjectType', label: 'Subject type' },
  { key: 'subjectRef', label: 'Subject' },
  { key: 'sellerId', label: 'Seller id' },
  { key: 'amount', label: 'Amount' },
  { key: 'currency', label: 'Currency' },
  { key: 'priority', label: 'Priority' },
  { key: 'state', label: 'State' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'lead', label: 'Lead' },
  { key: 'dueAt', label: 'Due' },
  { key: 'deadlineState', label: 'Deadline' },
  { key: 'escalationLevel', label: 'Escalation step' },
  { key: 'openedAt', label: 'Opened' },
  { key: 'resolvedAt', label: 'Resolved' },
  { key: 'outcome', label: 'Outcome' },
];

/**
 * Work queues use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/workqueues.json.
 * The work is done by the collaborators in app/: items (raise, close, people actions, lists), intake
 * (the event table), queues (definitions, counts, coverage, dashboard), sweep (deadlines, escalation,
 * archive), day-end review, routines and saved filters.
 */
export class WorkqueuesService implements WorkqueuesPublicApi {
  readonly core: Core;
  readonly items: Items;
  readonly intake: Intake;
  readonly queues: Queues;
  readonly sweep: Sweep;
  readonly dayEnd: DayEnd;
  readonly routines: Routines;
  readonly filters: Filters;

  constructor(protected readonly deps: WorkqueuesServiceDeps) {
    this.core = new Core(deps);
    this.items = new Items(this.core);
    this.intake = new Intake(this.core, this.items);
    this.queues = new Queues(this.core);
    this.sweep = new Sweep(this.core, this.items);
    this.dayEnd = new DayEnd(this.core);
    this.routines = new Routines(this.core);
    this.filters = new Filters(this.core, this.items);
  }

  /** After every module registered: install seed and the export dataset */
  async boot(): Promise<void> {
    await this.core.ensureSeeded().catch((err) => this.core.log.warn({ err }, 'workqueues: seeding failed; retrying on first use'));
    const reports = this.core.ctx.tryUse('reports');
    if (!reports) return;
    try {
      await reports.registerDataset({ key: 'workqueues.admin.items', owner: 'workqueues', title: 'Work items', permission: 'workqueues.items.export', columns: EXPORT_COLUMNS, audience: 'staff', screens: ['ops/queues'], available: true, phase: 1 });
    } catch (err) {
      if (!isNotImplemented(err)) this.core.log.warn({ err }, 'workqueues: could not register the export dataset');
    }
  }

  /** The caller as a viewer of queues (HTTP passes the request's permission check) */
  viewer(principal: identity.Principal, can?: (permission: string) => Promise<boolean>): Promise<Viewer> {
    return this.core.viewer(principal, can);
  }

  /* ---------------- public API (in-process) */

  /** Create or refresh a work item. Idempotent on dedupeKey: a second call updates title, deadline and amount instead of creating a duplicate. For checks that are not events (e.g. finance's daily reconciliation, returns' deadline job). */
  async raise(input: RaiseInput): Promise<WorkItem> {
    const module = input.queueKey?.split('.')[0] || 'unknown';
    const { row } = await this.items.raise({
      queueKey: input.queueKey,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      subject: input.subject,
      related: input.relatedSubjects,
      sellerId: input.sellerId,
      sellerName: input.sellerName,
      customerId: input.customerId,
      amount: input.amount,
      dueAt: input.dueAt,
      priority: input.priority as Priority | null | undefined,
      dedupeKey: input.dedupeKey,
      links: input.links,
      visibleToSeller: input.visibleToSeller,
      source: { module, event: null, by: { kind: 'system', name: module } },
    });
    return this.core.workItem(row);
  }

  /** Close open items for a fixed source; returns how many closed */
  async resolveBySource(dedupeKey: string, outcome: { note: string; by: common.Actor }): Promise<number> {
    return this.items.resolveBySource(dedupeKey, outcome);
  }

  /** Open items about one order, seller, case or payout, for detail pages */
  async listForSubject(subjectType: string, subjectId: string): Promise<WorkItem[]> {
    return this.items.forSubject(subjectType, subjectId);
  }

  /** Counts for other dashboards */
  async openCounts(queueKeys: string[]): Promise<Record<string, { open: number; overdue: number }>> {
    return this.queues.openCounts(queueKeys ?? []);
  }

  /** Open seller-visible tasks by kind for the seller dashboard */
  async sellerTaskCounts(sellerId: string): Promise<Record<string, number>> {
    return Object.fromEntries((await this.core.repo.sellerTaskCounts(sellerId)).map((r) => [r.kind, r.n]));
  }

  /** The My work queues screen for the calling staff member (same as GET /api/admin/workqueues/me) */
  async getMyQueues(principal: identity.Principal): Promise<MyQueues> {
    return this.myQueues(await this.viewer(principal), false);
  }

  /** Needs-attention tiles, overdue dispatch items and team on shift for the admin dashboard (same as GET /summary), limited to the queues the caller may see */
  async getWorkSummary(principal: identity.Principal): Promise<WorkSummary> {
    return this.workSummary(await this.viewer(principal));
  }

  /** Work items in the queues the caller may see (same as GET /items) */
  async listItems(filter: { queueKeys?: string[]; areas?: string[]; kinds?: string[]; states?: string[]; assignedToMe?: boolean; overdueOnly?: boolean; overdueOver?: string; sellerId?: string; sellerKind?: string; search?: string }, page: common.PageInput, principal: identity.Principal): Promise<common.Page<WorkItem>> {
    return this.items.list(await this.viewer(principal), (filter ?? {}) as FilterInput, toPageRequest(page));
  }

  /** One work item with notes and history, if the caller may see its queue */
  async getItem(itemId: string, principal: identity.Principal): Promise<WorkItem | null> {
    const v = await this.viewer(principal);
    try {
      return await this.items.get(v, itemId);
    } catch (err) {
      if ((err as { code?: string }).code === 'NOT_FOUND') return null;
      throw err;
    }
  }

  /** Export rows for reports dataset workqueues.admin.items (limited to the principal's queue areas) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    if (dataset !== 'workqueues.admin.items') {
      throw new AppError('VALIDATION_FAILED', `Unknown dataset ${dataset}`, { issues: [{ path: 'dataset', message: 'workqueues supplies workqueues.admin.items only' }] });
    }
    return this.items.exportRows(await this.viewer(principal), filters, cursor);
  }

  /* ---------------- screens */

  async myQueues(v: Viewer, all: boolean): Promise<MyQueues> {
    const core = this.core;
    await core.ensureSeeded();
    const queueRows = (await core.repo.listQueues()).filter((q) => q.active);
    const assigned = new Map((await core.repo.assignedCounts(v.staffId)).map((a) => [a.queue_key, a.n]));
    const scope = all && v.viewAll ? queueRows : queueRows.filter((q) => v.roles.includes(q.owner_role) || q.lead_staff_id === v.staffId || q.backup_staff_id === v.staffId || assigned.has(q.key));
    const [summaries, routine, dayEnd, savedFilters, meRef, yesterday, canExport] = await Promise.all([
      this.queues.summaries(scope, v),
      this.routines.today(v, { mine: true }),
      this.dayEnd.todayIfBuilt(),
      this.filters.list(v),
      core.staffInfo([v.staffId]),
      core.repo.dailyCounts(addDays(core.today(), -1)),
      v.can('workqueues.items.export'),
    ]);
    const keys = new Set(scope.map((q) => q.key));
    const overdue = summaries.reduce((s, q) => s + q.overdue, 0);
    const overdueYesterday = yesterday.filter((d) => keys.has(d.queue_key)).reduce((s, d) => s + d.overdue, 0);
    const oldest = summaries
      .map((s) => s.oldest)
      .filter((o): o is NonNullable<typeof o> => Boolean(o))
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt))[0];
    const me = meRef.get(v.staffId)!;
    const visibleAreas = [...new Set((v.viewAll ? queueRows : queueRows.filter((q) => core.queueVisible(v, q))).map((q) => q.area))];
    const exportScope = canExport ? AREAS.filter((a) => visibleAreas.includes(a)) : [];
    const led = scope.filter((q) => q.lead_staff_id === v.staffId);
    const reminders: string[] = [];
    if (overdue) reminders.push(`${overdue} overdue item${overdue === 1 ? '' : 's'} in your queues; overdue work escalates along each queue's route`);
    for (const q of led.slice(0, 3)) reminders.push(`${q.name} escalates to ${q.escalation_label}`);
    reminders.push(exportScope.length ? `Exports are limited to your areas: ${exportScope.join(', ')}` : 'You cannot export work items');
    return {
      me: { staffId: v.staffId, name: me.known ? me.name : (v.name ?? 'Staff member'), roles: v.roles },
      date: core.today(),
      stats: {
        assignedToMe: [...assigned.values()].reduce((s, n) => s + n, 0),
        queuesILead: led.length,
        overdue,
        overdueChangeVsYesterday: overdue - overdueYesterday,
        oldestOpen: oldest ? { itemId: oldest.itemId, ref: oldest.ref, subjectRef: oldest.subjectRef, openedAt: oldest.openedAt, ageLabel: ageLabel(new Date(oldest.openedAt), core.now()) } : null,
      },
      queues: summaries,
      routine,
      dayEnd,
      savedFilters,
      reminders,
      exportScope,
    };
  }

  async workSummary(v: Viewer, opts: { dispatchLimit?: number } = {}): Promise<WorkSummary> {
    const core = this.core;
    await core.ensureSeeded();
    const all = (await core.repo.listQueues()).filter((q) => q.active);
    const visible = all.filter((q) => core.queueVisible(v, q));
    const summaries = await this.queues.summaries(visible, v);
    const dispatch = await this.items.list(v, { kinds: DISPATCH_KINDS, deadline: ['overdue', 'due_soon'], sort: 'deadline' }, { mode: 'cursor', cursor: null, limit: Math.min(Math.max(opts.dispatchLimit ?? 5, 1), 50) });
    return {
      needsAttention: this.queues.tiles(summaries, new Map(all.map((q) => [q.key, q]))),
      overdueDispatch: dispatch.items,
      team: await this.queues.team(visible),
      generatedAt: core.now().toISOString(),
    };
  }

  /* ---------------- events consumed */

  /** shipping.dispatch.overdue: Open an overdue_dispatch item about the order (seller-visible for marketplace sellers) with the payload exceptionId as a related delivery_exception subject, so Remind seller can call shipping; resolves on shipping.shipment.dispatched or orders.item.cancelled */
  async onDispatchOverdueFromShipping(event: EventPayload<'shipping.dispatch.overdue'>): Promise<void> {
    await this.intake.handle('shipping.dispatch.overdue', event);
  }

  /** shipping.shipment.dispatched: Resolve overdue dispatch and missing tracking items for that order item */
  async onShipmentDispatchedFromShipping(event: EventPayload<'shipping.shipment.dispatched'>): Promise<void> {
    await this.intake.handle('shipping.shipment.dispatched', event);
  }

  /** shipping.shipment.exception: Open a delivery_exception item (lost, damaged, failed delivery, missing tracking) */
  async onShipmentExceptionFromShipping(event: EventPayload<'shipping.shipment.exception'>): Promise<void> {
    await this.intake.handle('shipping.shipment.exception', event);
  }

  /** shipping.shipment.delivered: Resolve delivery exception items for the shipment */
  async onShipmentDeliveredFromShipping(event: EventPayload<'shipping.shipment.delivered'>): Promise<void> {
    await this.intake.handle('shipping.shipment.delivered', event);
  }

  /** orders.item.cancelled: Resolve dispatch items for the cancelled item */
  async onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>): Promise<void> {
    await this.intake.handle('orders.item.cancelled', event);
  }

  /** inventory.stock.low: Open a low_stock item for Official Store stock */
  async onStockLowFromInventory(event: EventPayload<'inventory.stock.low'>): Promise<void> {
    await this.intake.handle('inventory.stock.low', event);
  }

  /** inventory.stock.changed: Resolve low_stock when available is back above the reorder point */
  async onStockChangedFromInventory(event: EventPayload<'inventory.stock.changed'>): Promise<void> {
    await this.intake.handle('inventory.stock.changed', event);
  }

  /** access.approval.requested: Open an approval_waiting item for the approvers' role */
  async onApprovalRequestedFromAccess(event: EventPayload<'access.approval.requested'>): Promise<void> {
    await this.intake.handle('access.approval.requested', event);
  }

  /** access.approval.decided: Resolve the approval item */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>): Promise<void> {
    await this.intake.handle('access.approval.decided', event);
  }

  /** access.away.started: Route new and escalating items of queues led by the absent person to the backup (access.resolveRecipients) */
  async onAwayStartedFromAccess(event: EventPayload<'access.away.started'>): Promise<void> {
    await this.intake.handle('access.away.started', event);
  }

  /** access.away.ended: Return routing to the lead; items stay with whoever holds them */
  async onAwayEndedFromAccess(event: EventPayload<'access.away.ended'>): Promise<void> {
    await this.intake.handle('access.away.ended', event);
  }

  /** access.coverage.changed: Refresh lead and backup on queues whose owner role coverage changed; re-run coverage gaps */
  async onCoverageChangedFromAccess(event: EventPayload<'access.coverage.changed'>): Promise<void> {
    await this.intake.handle('access.coverage.changed', event);
  }

  /** support.case.overdue: Open a case_past_target item */
  async onCaseOverdueFromSupport(event: EventPayload<'support.case.overdue'>): Promise<void> {
    await this.intake.handle('support.case.overdue', event);
  }

  /** support.case.escalated: Open or raise priority of a case_escalated item */
  async onCaseEscalatedFromSupport(event: EventPayload<'support.case.escalated'>): Promise<void> {
    await this.intake.handle('support.case.escalated', event);
  }

  /** support.case.resolved: Resolve case items */
  async onCaseResolvedFromSupport(event: EventPayload<'support.case.resolved'>): Promise<void> {
    await this.intake.handle('support.case.resolved', event);
  }

  /** returns.return.escalated: Open a return_decision item when a seller missed the response deadline */
  async onReturnEscalatedFromReturns(event: EventPayload<'returns.return.escalated'>): Promise<void> {
    await this.intake.handle('returns.return.escalated', event);
  }

  /** returns.refund.approved: Resolve return decision items for that return */
  async onRefundApprovedFromReturns(event: EventPayload<'returns.refund.approved'>): Promise<void> {
    await this.intake.handle('returns.refund.approved', event);
  }

  /** finance.payout.failed: Open a payout_failed item (also listed in the day-end review) */
  async onPayoutFailedFromFinance(event: EventPayload<'finance.payout.failed'>): Promise<void> {
    await this.intake.handle('finance.payout.failed', event);
  }

  /** finance.payout.paid: Resolve payout_failed items for that payout */
  async onPayoutPaidFromFinance(event: EventPayload<'finance.payout.paid'>): Promise<void> {
    await this.intake.handle('finance.payout.paid', event);
  }

  /** finance.reconciliation.mismatch_found: Open a payment_mismatch item in Daily finance checks */
  async onReconciliationMismatchFoundFromFinance(event: EventPayload<'finance.reconciliation.mismatch_found'>): Promise<void> {
    await this.intake.handle('finance.reconciliation.mismatch_found', event);
  }

  /** payments.payment.pending_check: Open a payment_check item */
  async onPaymentPendingCheckFromPayments(event: EventPayload<'payments.payment.pending_check'>): Promise<void> {
    await this.intake.handle('payments.payment.pending_check', event);
  }

  /** payments.payment.captured: Resolve payment_check items */
  async onPaymentCapturedFromPayments(event: EventPayload<'payments.payment.captured'>): Promise<void> {
    await this.intake.handle('payments.payment.captured', event);
  }

  /** payments.payment.failed: Resolve payment_check items (the customer is told by payments) */
  async onPaymentFailedFromPayments(event: EventPayload<'payments.payment.failed'>): Promise<void> {
    await this.intake.handle('payments.payment.failed', event);
  }

  /** payments.chargeback.opened: Open a chargeback item for Finance */
  async onChargebackOpenedFromPayments(event: EventPayload<'payments.chargeback.opened'>): Promise<void> {
    await this.intake.handle('payments.chargeback.opened', event);
  }

  /** catalog.product.submitted: Open a product_review item */
  async onProductSubmittedFromCatalog(event: EventPayload<'catalog.product.submitted'>): Promise<void> {
    await this.intake.handle('catalog.product.submitted', event);
  }

  /** catalog.product.approved: Resolve product review items */
  async onProductApprovedFromCatalog(event: EventPayload<'catalog.product.approved'>): Promise<void> {
    await this.intake.handle('catalog.product.approved', event);
  }

  /** catalog.product.changes_requested: Resolve product review items */
  async onProductChangesRequestedFromCatalog(event: EventPayload<'catalog.product.changes_requested'>): Promise<void> {
    await this.intake.handle('catalog.product.changes_requested', event);
  }

  /** catalog.product.rejected: Resolve product review items */
  async onProductRejectedFromCatalog(event: EventPayload<'catalog.product.rejected'>): Promise<void> {
    await this.intake.handle('catalog.product.rejected', event);
  }

  /** sellers.application.submitted: Open an application_waiting item with the decision target as deadline */
  async onApplicationSubmittedFromSellers(event: EventPayload<'sellers.application.submitted'>): Promise<void> {
    await this.intake.handle('sellers.application.submitted', event);
  }

  /** sellers.application.information_provided: Reopen the application item for review */
  async onApplicationInformationProvidedFromSellers(event: EventPayload<'sellers.application.information_provided'>): Promise<void> {
    await this.intake.handle('sellers.application.information_provided', event);
  }

  /** sellers.application.decided: Resolve application items */
  async onApplicationDecidedFromSellers(event: EventPayload<'sellers.application.decided'>): Promise<void> {
    await this.intake.handle('sellers.application.decided', event);
  }

  /** sellers.launch_review.requested: Open a launch_review item */
  async onLaunchReviewRequestedFromSellers(event: EventPayload<'sellers.launch_review.requested'>): Promise<void> {
    await this.intake.handle('sellers.launch_review.requested', event);
  }

  /** sellers.launch_review.decided: Resolve the launch review item */
  async onLaunchReviewDecidedFromSellers(event: EventPayload<'sellers.launch_review.decided'>): Promise<void> {
    await this.intake.handle('sellers.launch_review.decided', event);
  }

  /** sellers.appeal.submitted: Open an appeal_due item with decideBy as deadline */
  async onAppealSubmittedFromSellers(event: EventPayload<'sellers.appeal.submitted'>): Promise<void> {
    await this.intake.handle('sellers.appeal.submitted', event);
  }

  /** sellers.appeal.decided: Resolve appeal items */
  async onAppealDecidedFromSellers(event: EventPayload<'sellers.appeal.decided'>): Promise<void> {
    await this.intake.handle('sellers.appeal.decided', event);
  }

  /** sellers.restriction.evidence_submitted: Open a restriction_evidence item for the Seller Manager */
  async onRestrictionEvidenceSubmittedFromSellers(event: EventPayload<'sellers.restriction.evidence_submitted'>): Promise<void> {
    await this.intake.handle('sellers.restriction.evidence_submitted', event);
  }

  /** sellers.performance.below_target: Open a seller_performance item */
  async onPerformanceBelowTargetFromSellers(event: EventPayload<'sellers.performance.below_target'>): Promise<void> {
    await this.intake.handle('sellers.performance.below_target', event);
  }

  /** sellers.change_request.submitted: Open a storefront_review item */
  async onChangeRequestSubmittedFromSellers(event: EventPayload<'sellers.change_request.submitted'>): Promise<void> {
    await this.intake.handle('sellers.change_request.submitted', event);
  }

  /** sellers.change_request.decided: Resolve storefront review items */
  async onChangeRequestDecidedFromSellers(event: EventPayload<'sellers.change_request.decided'>): Promise<void> {
    await this.intake.handle('sellers.change_request.decided', event);
  }

  /** trust.report.created: Open a trust_report item (priority from risk score) */
  async onReportCreatedFromTrust(event: EventPayload<'trust.report.created'>): Promise<void> {
    await this.intake.handle('trust.report.created', event);
  }

  /** trust.report.resolved: Resolve trust report items */
  async onReportResolvedFromTrust(event: EventPayload<'trust.report.resolved'>): Promise<void> {
    await this.intake.handle('trust.report.resolved', event);
  }

  /** trust.recommendation.routed: Open a trust_recommendation item in the owning team's queue (Catalog, Seller Manager, Support, Finance) */
  async onRecommendationRoutedFromTrust(event: EventPayload<'trust.recommendation.routed'>): Promise<void> {
    await this.intake.handle('trust.recommendation.routed', event);
  }

  /** trust.recommendation.decided: Resolve the recommendation item */
  async onRecommendationDecidedFromTrust(event: EventPayload<'trust.recommendation.decided'>): Promise<void> {
    await this.intake.handle('trust.recommendation.decided', event);
  }

  /** messaging.reply.overdue: Open a seller-visible seller_reply_overdue task */
  async onReplyOverdueFromMessaging(event: EventPayload<'messaging.reply.overdue'>): Promise<void> {
    await this.intake.handle('messaging.reply.overdue', event);
  }

  /** messaging.message.sent: Resolve seller_reply_overdue when the seller replies */
  async onMessageSentFromMessaging(event: EventPayload<'messaging.message.sent'>): Promise<void> {
    await this.intake.handle('messaging.message.sent', event);
  }

  /** customers.data_export.requested: Open a data_request item with the promised delivery time */
  async onDataExportRequestedFromCustomers(event: EventPayload<'customers.data_export.requested'>): Promise<void> {
    await this.intake.handle('customers.data_export.requested', event);
  }

  /** customers.data_export.ready: Resolve the data request item */
  async onDataExportReadyFromCustomers(event: EventPayload<'customers.data_export.ready'>): Promise<void> {
    await this.intake.handle('customers.data_export.ready', event);
  }

  /** finance.reconciliation.item_closed: Resolve the payment_mismatch item for that reconciliation item */
  async onReconciliationItemClosedFromFinance(event: EventPayload<'finance.reconciliation.item_closed'>): Promise<void> {
    await this.intake.handle('finance.reconciliation.item_closed', event);
  }

  /** payments.payment.authorized: Resolve the payment_check item when the pending check ends authorized */
  async onPaymentAuthorizedFromPayments(event: EventPayload<'payments.payment.authorized'>): Promise<void> {
    await this.intake.handle('payments.payment.authorized', event);
  }

  /** payments.chargeback.decided: Resolve the chargeback item (won or lost) */
  async onChargebackDecidedFromPayments(event: EventPayload<'payments.chargeback.decided'>): Promise<void> {
    await this.intake.handle('payments.chargeback.decided', event);
  }

  /** sellers.restriction.lifted: Resolve restriction_evidence and restriction_review items for that restriction */
  async onRestrictionLiftedFromSellers(event: EventPayload<'sellers.restriction.lifted'>): Promise<void> {
    await this.intake.handle('sellers.restriction.lifted', event);
  }

  /** sellers.restriction.updated: Resolve the restriction_evidence item (the restriction was changed instead of lifted) */
  async onRestrictionUpdatedFromSellers(event: EventPayload<'sellers.restriction.updated'>): Promise<void> {
    await this.intake.handle('sellers.restriction.updated', event);
  }

  /** warehouse.return_parcel.received: Resolve the return_parcel_overdue item for that parcel */
  async onReturnParcelReceivedFromWarehouse(event: EventPayload<'warehouse.return_parcel.received'>): Promise<void> {
    await this.intake.handle('warehouse.return_parcel.received', event);
  }

  /* ---------------- jobs */

  /** Job workqueues.deadline-sweep (every 1 min): Move items to due_soon and overdue; publish workqueues.item.overdue once; escalate along each queue's route; route to the backup when the lead is away (access absences) */
  async deadlineSweep(): Promise<void> {
    await this.sweep.run();
  }

  /** Job workqueues.routine-generate (daily 00:05 market time): Create today's routine checks from templates; mark yesterday's unfinished checks late */
  async routineGenerate(): Promise<void> {
    await this.routines.generate();
  }

  /** Job workqueues.routine-late (every 15 min): Mark routine checks past their due time as late */
  async routineLate(): Promise<void> {
    await this.routines.late();
  }

  /** Job workqueues.day-end-prepare (daily 15:00 market time): Build today's day-end review and publish workqueues.day_end.prepared (once per date) */
  async dayEndPrepare(): Promise<void> {
    await this.dayEnd.prepareAndAnnounce();
  }

  /** Job workqueues.day-end-close (daily 23:59 market time): Mark an uncompleted review missed; snapshot daily_counts */
  async dayEndClose(): Promise<void> {
    await this.dayEnd.close();
  }

  /** Job workqueues.archive (monthly): Move resolved items older than itemRetentionDays to cold storage */
  async archive(): Promise<void> {
    await this.sweep.archive();
  }
}

export { SYSTEM };
