/** Performance: raw facts from other modules' events, daily metrics against targets, warnings and automatic controls. */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { PerformanceMetric, PerformanceSummary, PerformanceTarget } from '../../../spec/sellers.js';
import { METRIC_INFO, METRICS, targetDisplay, type MetricKey } from '../domain/catalogue.js';
import { computeMetrics, emptyCounts, isMiss, overallOf, type PerformanceCounts } from '../domain/metrics.js';
import { addDays, HOUR, isoDate } from '../domain/rules.js';
import * as map from '../mappers.js';
import type { PerfEventRec, SellerRec, SnapshotRec } from '../ports.js';
import { invalid, Part, SYSTEM, type By } from './core.js';

const SELLING = ['approved', 'restricted', 'suspended'];
const DEFAULT_FROM = '2026-01-01';

export class PerformancePart extends Part {
  /* ---------------------------------------------------------------- facts from events */

  private async fact(sellerId: string | null | undefined, kind: PerfEventRec['kind'], subjectId: string | null | undefined, at?: string | Date | null, value?: number | null) {
    if (!sellerId || !isUuid(sellerId) || !subjectId) return false;
    if (!(await this.repo.get('sellers', sellerId))) return false; // unknown sellers are ignored
    return this.repo.insertPerformanceEvent({
      id: newId(),
      seller_id: sellerId,
      kind,
      subject_id: isUuid(subjectId) ? subjectId : null,
      value: value === undefined || value === null ? null : String(value),
      occurred_at: at ? new Date(at) : this.now(),
      category_id: null,
    });
  }

  async onOrderAccepted(e: EventPayload<'orders.order.accepted'>) {
    for (const g of e.groups) {
      if (g.ownerType !== 'seller') continue;
      await this.fact(g.sellerId, 'order_accepted', g.groupId, e.acceptedAt);
      await this.fact(g.sellerId, 'units_sold', g.groupId, e.acceptedAt, g.itemIds.length);
    }
  }

  async onItemCancelled(e: EventPayload<'orders.item.cancelled'>) {
    if (e.ownerType !== 'seller' || !e.countsAgainstSeller) return;
    await this.fact(e.sellerId, 'seller_cancelled', e.groupId);
  }

  async onShipmentDispatched(e: EventPayload<'shipping.shipment.dispatched'>) {
    if (e.ownerType !== 'seller' || e.kind !== 'outbound') return;
    await this.fact(e.sellerId, e.onTime === false ? 'dispatched_late' : 'dispatched', e.groupId, e.shippedAt);
    await this.fact(e.sellerId, e.trackingValid ? 'tracking_valid' : 'tracking_missing', e.shipmentId, e.shippedAt);
  }

  async onDispatchOverdue(e: EventPayload<'shipping.dispatch.overdue'>) {
    if (e.ownerType !== 'seller') return;
    await this.fact(e.sellerId, 'dispatched_late', e.groupId, e.dueAt);
  }

  async onShipmentDelivered(e: EventPayload<'shipping.shipment.delivered'>) {
    if (e.kind !== 'outbound') return;
    await this.fact(e.sellerId, 'tracking_valid', e.shipmentId, e.deliveredAt);
  }

  async onReturnRequested(e: EventPayload<'returns.return.requested'>) {
    if (e.ownerType !== 'seller') return;
    await this.fact(e.sellerId, 'return_requested', e.returnId);
  }

  async onCaseOpened(e: EventPayload<'support.case.opened'>) {
    await this.fact(e.sellerId, 'case_opened', e.caseId, null, e.nextResponseDueAt ? new Date(e.nextResponseDueAt).getTime() : null);
  }

  async onCaseResolved(e: EventPayload<'support.case.resolved'>) {
    await this.fact(e.sellerId, 'case_resolved', e.caseId, e.resolvedAt);
  }

  /**
   * Buyer message → one open "received" fact per conversation; the seller's first reply closes it with the
   * reply time in hours (the received fact is then re-keyed so the next buyer message opens a new round).
   */
  async onMessageSent(e: EventPayload<'messaging.message.sent'>) {
    if (!e.sellerId || !isUuid(e.conversationId)) return;
    if (e.authorKind === 'customer') {
      await this.fact(e.sellerId, 'message_received', e.conversationId);
      return;
    }
    if (e.authorKind !== 'seller') return;
    const open = await this.repo.findOne('performance_events', { kind: 'message_received', subject_id: e.conversationId, seller_id: e.sellerId });
    if (!open) return;
    const hours = Math.round(((this.now().getTime() - open.occurred_at.getTime()) / HOUR) * 10) / 10;
    if (await this.fact(e.sellerId, 'first_reply', e.messageId, null, Math.max(0, hours))) {
      await this.repo.update('performance_events', open.id, { subject_id: newId() });
    }
  }

  /** A confirmed policy violation (revoked false claim, trust finding) */
  async recordViolation(sellerId: string, subjectId: string) {
    await this.fact(sellerId, 'policy_violation', subjectId);
  }

  /* ---------------------------------------------------------------- targets */

  private async defaultTargets(): Promise<Record<MetricKey, PerformanceTarget>> {
    const d = (await this.core.setting('defaultTargets')) as Record<string, number>;
    const windowDays = await this.core.setting('performanceWindowDays');
    const violationDays = await this.core.setting('violationWindowDays');
    const out = {} as Record<MetricKey, PerformanceTarget>;
    for (const metric of METRICS) {
      const info = METRIC_INFO[metric];
      const base = { metric, comparator: info.comparator, threshold: Number(d[info.defaultKey] ?? 0), unit: info.unit };
      out[metric] = { ...base, windowDays: metric === 'policy_violations' ? violationDays : windowDays, categoryId: null, display: targetDisplay(base), isExample: true, effectiveFrom: DEFAULT_FROM };
    }
    return out;
  }

  /** Account-wide targets in force on a date (category rows are listed, not used for the account summary) */
  async targetsInForce(day: string = this.core.today()): Promise<Record<MetricKey, PerformanceTarget>> {
    const out = await this.defaultTargets();
    const rows = await this.repo.find('performance_targets', { category_id: null, effective_from: { op: '<=', value: day } }, { orderBy: [['effective_from', 'asc']] });
    for (const r of rows) if ((METRICS as readonly string[]).includes(r.metric)) out[r.metric as MetricKey] = map.target(r);
    return out;
  }

  async listPerformanceTargets(): Promise<PerformanceTarget[]> {
    const today = this.core.today();
    const current = Object.values(await this.targetsInForce(today));
    const rows = await this.repo.find('performance_targets', {}, { orderBy: [['effective_from', 'asc']] });
    const scheduled = rows.filter((r) => r.effective_from > today || r.category_id !== null).map(map.target);
    return [...current, ...scheduled];
  }

  async setPerformanceTargets(targets: PerformanceTarget[], reason: string, by: By): Promise<PerformanceTarget[]> {
    const today = this.core.today();
    const issues: { path: string; message: string }[] = [];
    if (!reason?.trim()) issues.push({ path: 'reason', message: 'Say why the targets change' });
    if (!targets?.length) issues.push({ path: 'targets', message: 'Send at least one target' });
    targets.forEach((t, i) => {
      if (t.effectiveFrom < today) issues.push({ path: `targets.${i}.effectiveFrom`, message: 'Targets take effect today or later; computed metrics are not re-graded' });
      if (t.threshold < 0 || (t.unit === 'percent' && t.threshold > 100)) issues.push({ path: `targets.${i}.threshold`, message: 'Out of range' });
      if (t.windowDays < 1 || t.windowDays > 365) issues.push({ path: `targets.${i}.windowDays`, message: 'Between 1 and 365 days' });
      if (t.unit !== METRIC_INFO[t.metric].unit) issues.push({ path: `targets.${i}.unit`, message: `${METRIC_INFO[t.metric].label} is measured in ${METRIC_INFO[t.metric].unit}` });
    });
    if (issues.length) throw invalid(issues);
    const access = this.ctx.use('access');
    const check = await access.check(this.core.principalOf(by), 'sellers.performance.targets');
    if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason, { action: 'sellers.performance.targets' });
    if (check.decision === 'approval_required') {
      const req = await access.requestApproval({
        action: 'sellers.performance.targets',
        target: { type: 'performance_targets', id: newId(), label: 'Seller performance targets', screen: 'admin/seller-targets' },
        summary: `Change ${targets.length} seller performance target${targets.length === 1 ? '' : 's'}`,
        details: { targets, reason: reason.trim(), setBy: by.actor },
        reason: reason.trim(),
        requestedBy: this.core.principalOf(by),
      });
      throw new AppError('APPROVAL_REQUIRED', check.reason, { approvalRequestId: req.id });
    }
    return this.applyTargets(targets, reason.trim(), by);
  }

  async applyTargets(targets: PerformanceTarget[], reason: string, by: By, approvalRequestId?: string): Promise<PerformanceTarget[]> {
    const rows = [];
    for (const t of targets) {
      rows.push(
        await this.repo.insert('performance_targets', {
          id: newId(),
          metric: t.metric,
          category_id: t.categoryId ?? null,
          comparator: t.comparator,
          threshold: String(t.threshold),
          unit: t.unit,
          window_days: t.windowDays,
          is_example: false,
          effective_from: t.effectiveFrom,
          set_by: map.actorText(by.actor),
          reason,
        }),
      );
    }
    await this.core.audit(
      {
        action: 'sellers.performance_targets.set',
        actionLabel: 'Changed seller performance targets',
        category: 'settings',
        target: { type: 'performance_targets', id: rows[0]?.id ?? newId(), label: 'Seller performance targets', screen: 'admin/seller-targets' },
        reason,
        after: targets,
        approvalRequestId: approvalRequestId ?? null,
      },
      by,
    );
    return rows.map(map.target);
  }

  /* ---------------------------------------------------------------- computation */

  async countsFor(sellerId: string, now: Date = this.now()): Promise<PerformanceCounts> {
    const window = await this.core.setting('performanceWindowDays');
    const vWindow = await this.core.setting('violationWindowDays');
    const c = emptyCounts();
    for (const f of await this.repo.performanceFacts(sellerId, addDays(now, -window))) {
      if (f.kind === 'order_accepted') c.orders = f.n;
      else if (f.kind === 'units_sold') c.units = f.total;
      else if (f.kind === 'dispatched') c.dispatchedOnTime = f.n;
      else if (f.kind === 'dispatched_late') c.dispatchedLate = f.n;
      else if (f.kind === 'tracking_valid') c.trackingValid = f.n;
      else if (f.kind === 'tracking_missing') c.trackingMissing = f.n;
      else if (f.kind === 'seller_cancelled') c.sellerCancelled = f.n;
      else if (f.kind === 'return_requested') c.returns = f.n;
      else if (f.kind === 'first_reply') {
        c.replies = f.n;
        c.replyHoursTotal = f.total;
      }
    }
    c.violations = (await this.repo.performanceFacts(sellerId, addDays(now, -vWindow))).find((f) => f.kind === 'policy_violation')?.n ?? 0;
    c.unresolvedPastDeadline = await this.repo.unresolvedCasesPastDeadline(sellerId, now.getTime());
    return c;
  }

  async liveMetrics(sellerId: string, now: Date = this.now()) {
    const counts = await this.countsFor(sellerId, now);
    const metrics = computeMetrics(counts, await this.targetsInForce(this.core.today(now)));
    return { counts, metrics, overall: overallOf(metrics.map((m) => m.status)) };
  }

  private snapshotMetrics(s: SnapshotRec): PerformanceMetric[] {
    const m = (s.metrics ?? {}) as unknown as Record<string, PerformanceMetric>;
    return METRICS.map((k) => m[k]).filter((x): x is PerformanceMetric => Boolean(x));
  }

  /** sellers.compute-performance: snapshot every selling seller; publish below_target for new misses */
  async computePerformance() {
    const now = this.now();
    const window = await this.core.setting('performanceWindowDays');
    const sellers = await this.repo.find('sellers', { status: SELLING }, { orderBy: [['id', 'asc']], limit: 5000 });
    const previous = new Map<string, SnapshotRec>();
    for (const s of await this.repo.latestSnapshots(sellers.map((x) => x.id), 1)) previous.set(s.seller_id, s);
    for (const seller of sellers) {
      const { counts, metrics, overall } = await this.liveMetrics(seller.id, now);
      await this.repo.insert('performance_snapshots', {
        id: newId(),
        seller_id: seller.id,
        computed_at: now,
        window_from: isoDate(addDays(now, -window)),
        window_to: this.core.today(now),
        order_count: counts.orders,
        metrics: Object.fromEntries(metrics.map((m) => [m.key, m])) as never,
        overall,
      });
      const before = previous.get(seller.id);
      const missedBefore = new Set(before ? this.snapshotMetrics(before).filter((m) => isMiss(m.status)).map((m) => m.key) : []);
      const newMisses = metrics.filter((m) => isMiss(m.status) && !missedBefore.has(m.key)).map((m) => m.key);
      if (newMisses.length) this.core.publish('sellers.performance.below_target', { sellerId: seller.id, metrics: newMisses, overall });
    }
  }

  /** Latest on-time dispatch per seller (lists, filters) */
  async dispatchPct(sellerIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const s of await this.repo.latestSnapshots(sellerIds, 1)) {
      const v = ((s.metrics ?? {}) as unknown as Record<string, PerformanceMetric>).dispatch_reliability?.value;
      if (typeof v === 'number') out.set(s.seller_id, v);
    }
    return out;
  }

  async getPerformance(sellerId: string): Promise<PerformanceSummary> {
    const seller = await this.core.seller(sellerId);
    const [latest] = await this.repo.latestSnapshots([sellerId], 1);
    let metrics: PerformanceMetric[];
    let overall: PerformanceSummary['overall'];
    let orderCount: number;
    let period: common.DateRange;
    let updatedAt: string;
    if (latest) {
      metrics = this.snapshotMetrics(latest);
      overall = latest.overall as PerformanceSummary['overall'];
      orderCount = latest.order_count;
      period = { from: latest.window_from, to: latest.window_to };
      updatedAt = latest.computed_at.toISOString();
    } else {
      const now = this.now();
      const live = await this.liveMetrics(sellerId, now);
      metrics = live.metrics;
      overall = live.overall;
      orderCount = live.counts.orders;
      period = { from: isoDate(addDays(now, -(await this.core.setting('performanceWindowDays')))), to: this.core.today(now) };
      updatedAt = now.toISOString();
    }
    return { period, orderCount, overall, metrics, feedback: await this.feedback(seller), warnings: await this.warnings(sellerId), history: await this.history(sellerId), updatedAt };
  }

  private async feedback(seller: SellerRec) {
    const f = await this.core.optional('reviews', 'feedback', null, (r) => r.getSellerFeedbackSummary(seller.id));
    return f ? { positivePct: f.positivePct ?? null, ratingCount: f.count } : null;
  }

  /** Open warnings and those resolved in the last 12 months */
  async warnings(sellerId: string) {
    const since = addDays(this.now(), -365);
    const rows = await this.repo.find('warnings', { seller_id: sellerId }, { orderBy: [['issued_at', 'desc']] });
    return rows.filter((w) => w.state === 'open' || (w.resolved_at && w.resolved_at >= since)).map(map.warning);
  }

  /** Warnings and actions in the last 12 months (seller-visible timeline) */
  async history(sellerId: string, staff = false) {
    const rows = await this.repo.find(
      'account_events',
      { seller_id: sellerId, at: { op: '>=', value: addDays(this.now(), -365) }, ...(staff ? {} : { visibility: 'seller' as const }) },
      { orderBy: [['at', 'desc']], limit: 200 },
    );
    return rows.map(map.timelineEvent);
  }

  /* ---------------------------------------------------------------- automatic controls (phase 2) */

  /** sellers.auto-warnings: warn on repeated misses, propose restrictions to the Seller Manager (never restrict automatically) */
  async autoWarnings() {
    if (this.ctx.config.launchPhase < 2) return;
    const sellers = await this.repo.find('sellers', { status: ['approved', 'restricted'] }, { limit: 5000 });
    const snaps = await this.repo.latestSnapshots(sellers.map((s) => s.id), 3);
    const bySeller = new Map<string, SnapshotRec[]>();
    for (const s of snaps) bySeller.set(s.seller_id, [...(bySeller.get(s.seller_id) ?? []), s]);
    for (const seller of sellers) {
      const list = bySeller.get(seller.id) ?? [];
      if (list.length < 2) continue;
      const perSnap = list.map((s) => new Map(this.snapshotMetrics(s).map((m) => [m.key, m])));
      const open = await this.repo.find('warnings', { seller_id: seller.id, state: 'open', kind: 'performance' });
      for (const key of METRICS) {
        const recent = perSnap.slice(0, 2).map((m) => m.get(key));
        if (!recent.every((m) => m && isMiss(m.status))) continue;
        const m = recent[0]!;
        const title = `${m.label} below target`;
        if (!open.some((w) => w.title === title)) {
          await this.parts.enforcement.issueWarning(seller.id, { kind: 'performance', title, detail: `${m.detail}. Target: ${m.target.display}. Two daily checks in a row missed it.` }, { actor: SYSTEM });
        }
        if (perSnap.length >= 3 && perSnap.every((s) => s.get(key)?.status === 'action_needed')) {
          await this.core.raise({
            queueKey: 'sellers.performance',
            kind: 'restriction_proposal',
            title: `Consider restricting ${seller.store_name}: ${m.label}`,
            summary: `${m.detail}; action needed on three daily checks in a row. Restrictions are never applied automatically.`,
            subject: { type: 'seller', id: seller.id, ref: seller.ref, label: seller.store_name },
            sellerId: seller.id,
            sellerName: seller.store_name,
            priority: 'high',
            dedupeKey: `restriction_proposal:${seller.id}:${key}:${this.core.today()}`,
          });
        }
      }
    }
  }
}
