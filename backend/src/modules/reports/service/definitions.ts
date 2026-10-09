/**
 * Stated meanings: metric definitions (owner, versions, suggestions), the report catalogue by business
 * group, saved views and (phase 2) scheduled report emails.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { MetricDefinition, MetricInput, MetricSuggestion, ReportDefinition, ReportGroup, ReportQuery, ReportSchedule, SavedView, StaffRef } from '../../../spec/reports.js';
import { GROUPS, METRICS, REPORTS, SELLER_GROUP, UNASSIGNED_OWNER, groupOf } from '../domain/catalogue.js';
import { TIME_OF_DAY, metricIssues, nextRun } from '../domain/rules.js';
import { metricDefinitionMachine, metricSuggestionMachine } from '../domain/state-machines.js';
import type { MetricRow, ReportRow, SavedViewRow, ScheduleRow, SuggestionRow, VersionRow } from '../ports.js';
import { invalid, notFound, type Caller, type ReportsCore } from './core.js';

/** Seeded definitions take effect from the start of the launch year */
const SEED_EFFECTIVE_FROM = '2026-01-01';

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** What a published version records (owner as id, resolved when shown) */
type Snapshot = Omit<MetricDefinition, 'owner'> & { ownerId: string };

export class Definitions {
  constructor(private readonly core: ReportsCore) {}

  /* ---------------------------------------------------------------- seeding (afterBoot, idempotent) */

  async seed() {
    const cfg = await this.core.cfg();
    const now = this.core.now();
    for (const g of GROUPS) await this.core.repo.seedGroup({ key: g.key, label: g.label, owner_staff_id: UNASSIGNED_OWNER, position: g.position });
    for (const m of METRICS) {
      const row: MetricRow = {
        key: m.key,
        name: m.name,
        group_key: m.group,
        definition: m.definition,
        formula: m.formula,
        unit: m.unit,
        includes: m.includes,
        excludes: m.excludes,
        date_basis_options: m.dateBasisOptions,
        default_date_basis: m.defaultDateBasis,
        currency_rule: currencyRule(cfg.currency),
        time_zone: cfg.timeZone,
        related_keys: m.relatedKeys,
        audience: m.audience,
        launch_measure: cfg.launchMetrics.includes(m.key),
        owner_staff_id: UNASSIGNED_OWNER,
        status: 'published',
        version: 1,
        effective_from: SEED_EFFECTIVE_FROM,
        reviewed_at: null,
      };
      await this.core.repo.seedMetric(row, { id: newId(), metric_key: m.key, version: 1, snapshot: snapshotOf(row, 'First published definition (launch set)') as never, change_note: 'First published definition (launch set)', changed_by: 'system', effective_from: SEED_EFFECTIVE_FROM, created_at: now });
    }
    for (const r of REPORTS) {
      await this.core.repo.upsertReport({
        key: r.key,
        group_key: r.group,
        title: r.title,
        description: r.description,
        metrics: r.metrics,
        dimensions: r.dimensions,
        filters: r.filters as never,
        permission: r.permission,
        audience: r.audience,
        layout: r.layout,
        phase: r.phase ?? 1,
        active: true,
      });
    }
  }

  /* ---------------------------------------------------------------- views */

  async metricViews(rows: MetricRow[]): Promise<MetricDefinition[]> {
    const refs = await this.core.staffRefs(
      rows.map((r) => r.owner_staff_id),
      (id) => this.core.groupRole(rows.find((r) => r.owner_staff_id === id)?.group_key ?? ''),
    );
    const notes = new Map<string, string>();
    for (const r of rows.filter((x) => x.status === 'published')) {
      const v = (await this.core.repo.listVersions(r.key)).find((x) => x.version === r.version);
      if (v) notes.set(r.key, v.change_note);
    }
    return rows.map((r) => ({ ...rowView(r), owner: refs.get(r.owner_staff_id)!, changeNote: notes.get(r.key) ?? null }));
  }

  async versionViews(rows: VersionRow[]): Promise<MetricDefinition[]> {
    const snaps = rows.map((v) => ({ v, s: v.snapshot as unknown as Snapshot }));
    const refs = await this.core.staffRefs(
      snaps.map((x) => x.s.ownerId),
      (id) => this.core.groupRole(snaps.find((x) => x.s.ownerId === id)?.s.group ?? ''),
    );
    return snaps.map(({ v, s }) => {
      const { ownerId, ...rest } = s;
      return { ...rest, status: 'published', version: v.version, effectiveFrom: v.effective_from, changeNote: v.change_note, owner: refs.get(ownerId)! } as MetricDefinition;
    });
  }

  /** The published definitions in use today for these metrics (a new version applies from its effective date) */
  async inUse(keys: string[]): Promise<MetricDefinition[]> {
    if (!keys.length) return [];
    const today = await this.core.today();
    const versions = await this.core.repo.versionsInEffect(keys, today);
    const views = await this.versionViews(versions);
    return keys.map((k) => views.find((v) => v.key === k)).filter((x): x is MetricDefinition => Boolean(x));
  }

  /** Published definition text for tooltips in other modules' screens */
  async metric(key: string): Promise<MetricDefinition | null> {
    return (await this.inUse([key]))[0] ?? null;
  }

  async listMetrics(q: { group?: string; status?: string; launchOnly?: boolean }): Promise<MetricDefinition[]> {
    let rows = await this.core.repo.listMetrics({ group: q.group, status: q.status });
    if (q.launchOnly) rows = rows.filter((r) => r.launch_measure);
    return this.metricViews(rows);
  }

  async getMetric(key: string): Promise<{ metric: MetricDefinition; versions: MetricDefinition[]; suggestions: MetricSuggestion[] }> {
    const row = await this.core.repo.getMetric(key);
    if (!row) throw notFound('Metric');
    const [metric] = await this.metricViews([row]);
    const versions = await this.versionViews(await this.core.repo.listVersions(key));
    const suggestions = await this.suggestionViews(await this.core.repo.listSuggestions(key));
    return { metric: metric!, versions, suggestions };
  }

  async suggestionViews(rows: SuggestionRow[]): Promise<MetricSuggestion[]> {
    const refs = await this.core.staffRefs(rows.flatMap((r) => [r.suggested_by, r.decided_by]).filter(isUuidLike));
    const ref = (id: string | null): StaffRef | null => (id ? (refs.get(id) ?? { staffId: id, name: id === 'system' ? 'System' : 'Staff member', role: 'Staff' }) : null);
    return rows.map((r) => ({
      id: r.id,
      metricKey: r.metric_key,
      proposed: r.proposed,
      reason: r.reason,
      suggestedBy: ref(r.suggested_by)!,
      state: r.state as MetricSuggestion['state'],
      decisionNote: r.decision_note,
      decidedBy: ref(r.decided_by),
      createdAt: r.created_at.toISOString(),
    }));
  }

  /* ---------------------------------------------------------------- metric changes */

  private async ownerKnown(ownerId: string): Promise<boolean> {
    if (ownerId === UNASSIGNED_OWNER) return false;
    const access = this.core.api('access');
    if (!access) return true; // nobody to ask: the id is kept as given
    const ref = await this.core.soft('access.getStaffRef', () => access.getStaffRef(ownerId));
    return ref === undefined ? true : ref !== null;
  }

  async createMetric(body: { key: string; metric: MetricInput }, by: Caller): Promise<MetricDefinition> {
    const key = body.key.trim();
    const m = body.metric;
    const issues = metricIssues(m, key);
    if (!issues.length && !(await this.ownerKnown(m.ownerId))) issues.push({ path: 'metric.ownerId', message: 'The owner must be a staff member' });
    if (issues.length) throw invalid(issues);
    const cfg = await this.core.cfg();
    const today = await this.core.today();
    const row: MetricRow = {
      key,
      ...inputColumns(m),
      currency_rule: currencyRule(cfg.currency),
      time_zone: cfg.timeZone,
      launch_measure: m.launchMeasure ?? cfg.launchMetrics.includes(key),
      status: 'draft',
      version: 1,
      effective_from: m.effectiveFrom ?? today,
      reviewed_at: null,
    };
    const created = await this.core.repo.transaction(async (tx) => {
      if (await tx.getMetric(key, { forUpdate: true })) throw new AppError('CONFLICT', `A metric with the key ${key} already exists`, { key });
      return tx.insertMetric(row);
    });
    await this.core.audit({ action: 'reports.metric.create', actionLabel: 'Created metric definition', category: 'other', target: { type: 'metric', id: key, label: m.name, screen: 'admin/reports' }, after: rowView(created), reason: m.changeNote }, by);
    return (await this.metricViews([created]))[0]!;
  }

  async reviseMetric(key: string, m: MetricInput, by: Caller): Promise<MetricDefinition> {
    const issues = metricIssues(m);
    if (!issues.length && !(await this.ownerKnown(m.ownerId))) issues.push({ path: 'metric.ownerId', message: 'The owner must be a staff member' });
    if (issues.length) throw invalid(issues);
    const today = await this.core.today();
    const { before, after } = await this.core.repo.transaction(async (tx) => {
      const before = await tx.getMetric(key, { forUpdate: true });
      if (!before) throw notFound('Metric');
      // a published metric gets a new draft version; a draft is edited in place; retired cannot change
      const status = before.status === 'draft' ? 'draft' : metricDefinitionMachine.next(before.status as never, 'revise');
      const version = before.status === 'published' ? before.version + 1 : before.version;
      const after = await tx.updateMetric(key, { ...inputColumns(m), launch_measure: m.launchMeasure ?? before.launch_measure, status, version, effective_from: m.effectiveFrom ?? (before.status === 'published' ? today : before.effective_from) });
      return { before, after };
    });
    await this.core.audit({ action: 'reports.metric.revise', actionLabel: `Revised metric definition (draft v${after.version})`, category: 'other', target: { type: 'metric', id: key, label: after.name, screen: 'admin/reports' }, before: rowView(before), after: rowView(after), reason: m.changeNote }, by);
    return (await this.metricViews([after]))[0]!;
  }

  async publishMetric(key: string, body: { effectiveFrom: string; changeNote: string }, by: Caller): Promise<MetricDefinition> {
    const changeNote = body.changeNote.trim();
    if (!changeNote) throw invalid([{ path: 'changeNote', message: 'Say what changed in this version' }]);
    const current = await this.core.repo.getMetric(key);
    if (!current) throw notFound('Metric');
    metricDefinitionMachine.next(current.status as never, 'publish');
    if (!(await this.ownerKnown(current.owner_staff_id))) throw this.core.ctx.error('OWNER_REQUIRED', 'Name a staff member who owns this metric before publishing it', { metricKey: key });
    const previous = (await this.core.repo.listVersions(key))[0];
    if (previous && body.effectiveFrom < previous.effective_from) throw invalid([{ path: 'effectiveFrom', message: `The new version can't take effect before version ${previous.version} (${previous.effective_from})` }]);
    const today = await this.core.today();
    const { before, after } = await this.core.repo.transaction(async (tx) => {
      const before = await tx.getMetric(key, { forUpdate: true });
      if (!before) throw notFound('Metric');
      const status = metricDefinitionMachine.next(before.status as never, 'publish');
      const after = await tx.updateMetric(key, { status, effective_from: body.effectiveFrom, reviewed_at: today });
      await tx.insertVersion({ id: newId(), metric_key: key, version: after.version, snapshot: snapshotOf(after, changeNote) as never, change_note: changeNote, changed_by: by.actor.id ?? by.actor.kind, effective_from: body.effectiveFrom, created_at: this.core.now() });
      return { before, after };
    });
    this.core.ctx.events.publish('reports.metric.published', { metricKey: key, version: after.version, effectiveFrom: body.effectiveFrom }, { actor: by.actor, requestId: by.requestId });
    await this.core.audit({ action: 'reports.metric.publish', actionLabel: `Published metric definition v${after.version}`, category: 'other', target: { type: 'metric', id: key, label: after.name, screen: 'admin/reports' }, before: rowView(before), after: rowView(after), reason: changeNote, afterText: `v${after.version} from ${body.effectiveFrom}` }, by);
    return (await this.metricViews([after]))[0]!;
  }

  async retireMetric(key: string, body: { reason: string }, by: Caller): Promise<MetricDefinition> {
    const reason = body.reason.trim();
    if (!reason) throw invalid([{ path: 'reason', message: 'Say why the metric is retired' }]);
    const users = (await this.core.repo.listReports({ active: true })).filter((r) => strings(r.metrics).includes(key));
    const { before, after } = await this.core.repo.transaction(async (tx) => {
      const before = await tx.getMetric(key, { forUpdate: true });
      if (!before) throw notFound('Metric');
      const status = metricDefinitionMachine.next(before.status as never, 'retire');
      if (users.length) throw this.core.ctx.error('METRIC_IN_USE', `${users.map((r) => r.title).join(', ')} still use${users.length === 1 ? 's' : ''} this metric`, { reports: users.map((r) => r.key) });
      return { before, after: await tx.updateMetric(key, { status }) };
    });
    await this.core.audit({ action: 'reports.metric.retire', actionLabel: 'Retired metric definition', category: 'other', target: { type: 'metric', id: key, label: after.name, screen: 'admin/reports' }, before: rowView(before), after: rowView(after), reason }, by);
    return (await this.metricViews([after]))[0]!;
  }

  async suggestChange(key: string, body: { proposed: string; reason: string }, by: Caller): Promise<MetricSuggestion> {
    const issues = [
      ...(body.proposed.trim() ? [] : [{ path: 'proposed', message: 'Describe the change you suggest' }]),
      ...(body.reason.trim() ? [] : [{ path: 'reason', message: 'Say why the change is needed' }]),
    ];
    if (issues.length) throw invalid(issues);
    if (!(await this.core.repo.getMetric(key))) throw notFound('Metric');
    const row = await this.core.repo.insertSuggestion({ id: newId(), metric_key: key, proposed: body.proposed.trim(), reason: body.reason.trim(), suggested_by: by.actor.id ?? 'unknown', state: 'open', decision_note: null, decided_by: null, created_at: this.core.now() });
    return (await this.suggestionViews([row]))[0]!;
  }

  async decideSuggestion(id: string, body: { accept: boolean; note: string }, by: Caller): Promise<MetricSuggestion> {
    const today = await this.core.today();
    const { before, after, opened } = await this.core.repo.transaction(async (tx) => {
      const before = await tx.getSuggestion(id, { forUpdate: true });
      if (!before) throw notFound('Suggestion');
      const state = metricSuggestionMachine.next(before.state as never, body.accept ? 'accept' : 'decline');
      const after = await tx.updateSuggestion(id, { state, decision_note: body.note.trim() || null, decided_by: by.actor.id ?? 'unknown' });
      // accepting opens a new draft version of the metric for its owner
      let opened: MetricRow | undefined;
      if (body.accept) {
        const metric = await tx.getMetric(before.metric_key, { forUpdate: true });
        if (metric?.status === 'published') opened = await tx.updateMetric(metric.key, { status: metricDefinitionMachine.next(metric.status as never, 'revise'), version: metric.version + 1, effective_from: today });
      }
      return { before, after, opened };
    });
    await this.core.audit(
      {
        action: body.accept ? 'reports.metric_suggestion.accept' : 'reports.metric_suggestion.decline',
        actionLabel: body.accept ? 'Accepted a metric change suggestion' : 'Declined a metric change suggestion',
        category: 'other',
        target: { type: 'metric_suggestion', id, label: before.metric_key, screen: 'admin/reports' },
        relatedTargets: [{ type: 'metric', id: before.metric_key, label: before.metric_key }],
        before: { state: before.state },
        after: { state: after.state, ...(opened ? { draftVersion: opened.version } : {}) },
        reason: body.note || null,
      },
      by,
    );
    return (await this.suggestionViews([after]))[0]!;
  }

  /* ---------------------------------------------------------------- catalogue */

  reportView(r: ReportRow): ReportDefinition {
    return {
      key: r.key,
      title: r.title,
      group: r.group_key,
      description: r.description,
      metrics: strings(r.metrics),
      dimensions: strings(r.dimensions),
      filters: (Array.isArray(r.filters) ? r.filters : []) as never,
      permission: r.permission,
      audience: r.audience as ReportDefinition['audience'],
      layout: strings(r.layout),
      phase: r.phase,
    };
  }

  /** A report a staff member may open (404 for unknown or seller reports, 403 without the group permission) */
  async staffReport(key: string, by: Caller): Promise<ReportRow> {
    const r = await this.core.repo.getReport(key);
    if (!r || !r.active || r.audience !== 'staff') throw notFound('Report');
    if (!(await this.core.principalCan(by.principal, r.permission, by.can))) throw new AppError('FORBIDDEN', `Opening ${r.title} needs ${r.permission}`, { permission: r.permission });
    return r;
  }

  async sellerReport(key: string): Promise<ReportRow> {
    const r = await this.core.repo.getReport(key);
    if (!r || !r.active || r.audience !== 'seller') throw notFound('Report');
    return r;
  }

  async catalogue(by: Caller): Promise<ReportGroup[]> {
    const [groups, reports] = await Promise.all([this.core.repo.listGroups(), this.core.repo.listReports({ audience: 'staff', active: true })]);
    const refs = await this.core.staffRefs(
      groups.map((g) => g.owner_staff_id),
      (id) => groupOf(groups.find((g) => g.owner_staff_id === id)?.key ?? '')?.ownerRole ?? 'Reports Analyst',
    );
    const out: ReportGroup[] = [];
    for (const g of groups) {
      const visible: ReportDefinition[] = [];
      for (const r of reports.filter((x) => x.group_key === g.key)) if (await this.core.principalCan(by.principal, r.permission, by.can)) visible.push(this.reportView(r));
      if (!visible.length) continue;
      const owner = g.owner_staff_id === UNASSIGNED_OWNER ? { staffId: UNASSIGNED_OWNER, name: `${groupOf(g.key)?.ownerRole ?? 'Reports Analyst'} (no person named yet)`, role: groupOf(g.key)?.ownerRole ?? 'Reports Analyst' } : refs.get(g.owner_staff_id)!;
      out.push({ key: g.key, label: g.label, owner, reports: visible });
    }
    return out;
  }

  async sellerCatalogue(): Promise<ReportDefinition[]> {
    return (await this.core.repo.listReports({ audience: 'seller', active: true })).filter((r) => r.group_key === SELLER_GROUP).map((r) => this.reportView(r));
  }

  async reportDefinition(key: string, by: Caller): Promise<{ report: ReportDefinition; definitions: MetricDefinition[] }> {
    const r = await this.staffReport(key, by);
    return { report: this.reportView(r), definitions: await this.inUse(strings(r.metrics)) };
  }

  /* ---------------------------------------------------------------- saved views */

  private async savedViewViews(rows: SavedViewRow[]): Promise<SavedView[]> {
    const refs = await this.core.staffRefs(rows.map((r) => r.owner_staff_id));
    return rows.map((r) => ({ id: r.id, reportKey: r.report_key, name: r.name, query: (r.query ?? {}) as ReportQuery, owner: refs.get(r.owner_staff_id)!, shared: r.shared, createdAt: r.created_at.toISOString() }));
  }

  async listSavedViews(reportKey: string | undefined, by: Caller): Promise<SavedView[]> {
    return this.savedViewViews(await this.core.repo.listSavedViews(staffId(by), reportKey));
  }

  async createSavedView(body: { reportKey: string; name: string; query: ReportQuery; shared?: boolean | null }, by: Caller, checkQuery: (q: ReportQuery) => Promise<unknown>): Promise<SavedView> {
    const name = body.name.trim();
    if (!name) throw invalid([{ path: 'name', message: 'Name the view' }]);
    await this.staffReport(body.reportKey, by);
    await checkQuery(body.query);
    const row = await this.core.repo.insertSavedView({ id: newId(), report_key: body.reportKey, name, query: body.query as never, owner_staff_id: staffId(by), shared: Boolean(body.shared), created_at: this.core.now() });
    return (await this.savedViewViews([row]))[0]!;
  }

  async deleteSavedView(id: string, by: Caller): Promise<void> {
    const row = await this.core.repo.getSavedView(id);
    const me = staffId(by);
    if (!row || (row.owner_staff_id !== me && !row.shared)) throw notFound('Saved view');
    if (row.owner_staff_id !== me) throw new AppError('FORBIDDEN', 'Only the person who saved this view can delete it');
    await this.core.repo.deleteSavedView(id);
  }

  /* ---------------------------------------------------------------- schedules (phase 2) */

  private async scheduleViews(rows: ScheduleRow[]): Promise<ReportSchedule[]> {
    const refs = await this.core.staffRefs(rows.map((r) => r.owner_staff_id));
    return rows.map((r) => ({
      id: r.id,
      reportKey: r.report_key,
      savedViewId: r.saved_view_id,
      recipients: strings(r.recipients),
      frequency: r.frequency as ReportSchedule['frequency'],
      dayOfWeek: r.day_of_week,
      time: r.time,
      format: r.format as ReportSchedule['format'],
      nextRunAt: r.next_run_at.toISOString(),
      owner: refs.get(r.owner_staff_id)!,
      active: r.active,
    }));
  }

  async createSchedule(
    body: { reportKey: string; savedViewId?: string | null; recipients: string[]; frequency: 'daily' | 'weekly' | 'monthly'; dayOfWeek?: number | null; time: string; format: 'pdf' | 'csv' },
    by: Caller,
  ): Promise<ReportSchedule> {
    const issues: { path: string; message: string }[] = [];
    const report = await this.core.repo.getReport(body.reportKey);
    if (!report || !report.active || report.audience !== 'staff') issues.push({ path: 'reportKey', message: 'Choose a report from the library' });
    if (body.savedViewId) {
      const v = await this.core.repo.getSavedView(body.savedViewId);
      if (!v || v.report_key !== body.reportKey || (v.owner_staff_id !== staffId(by) && !v.shared)) issues.push({ path: 'savedViewId', message: 'Choose one of your saved views of this report' });
    }
    const recipients = [...new Set(body.recipients.map((e) => e.trim().toLowerCase()))];
    if (!recipients.length) issues.push({ path: 'recipients', message: 'Add at least one recipient' });
    if (body.frequency === 'weekly' && (body.dayOfWeek == null || body.dayOfWeek < 0 || body.dayOfWeek > 6)) issues.push({ path: 'dayOfWeek', message: 'Weekly schedules need a day of the week (0 = Sunday … 6 = Saturday)' });
    if (!TIME_OF_DAY.test(body.time)) issues.push({ path: 'time', message: 'Time is HH:MM market time, e.g. 07:30' });
    if (report && !(await this.core.principalCan(by.principal, report.permission, by.can))) issues.push({ path: 'reportKey', message: `You may not see this report (${report.permission})` });
    const bad = recipients.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (bad.length) issues.push({ path: 'recipients', message: `Not an email address: ${bad.join(', ')}` });
    if (issues.length) throw invalid(issues);
    const cfg = await this.core.cfg();
    const row = await this.core.repo.insertSchedule({
      id: newId(),
      report_key: body.reportKey,
      saved_view_id: body.savedViewId ?? null,
      recipients: recipients as never,
      frequency: body.frequency,
      day_of_week: body.frequency === 'weekly' ? body.dayOfWeek! : null,
      time: body.time,
      format: body.format,
      next_run_at: nextRun({ frequency: body.frequency, dayOfWeek: body.dayOfWeek, time: body.time }, this.core.now(), cfg.timeZone),
      owner_staff_id: staffId(by),
      active: true,
    });
    const [view] = await this.scheduleViews([row]);
    await this.core.audit({ action: 'reports.schedule.create', actionLabel: 'Scheduled a report email', category: 'other', target: { type: 'report_schedule', id: row.id, label: report!.title, screen: 'admin/reports' }, after: view }, by);
    return view!;
  }

  async listSchedules(): Promise<ReportSchedule[]> {
    return this.scheduleViews(await this.core.repo.listSchedules());
  }

  async deleteSchedule(id: string, by: Caller): Promise<void> {
    const row = await this.core.repo.getSchedule(id);
    if (!row || !row.active) throw notFound('Schedule');
    await this.core.repo.updateSchedule(id, { active: false });
    await this.core.audit({ action: 'reports.schedule.stop', actionLabel: 'Stopped a scheduled report email', category: 'other', target: { type: 'report_schedule', id, label: row.report_key, screen: 'admin/reports' }, before: { active: true, recipients: row.recipients }, after: { active: false } }, by);
  }
}

/* ---------------------------------------------------------------- mapping */

export const currencyRule = (currency: string) => `Reporting currency ${currency}; one currency at launch`;

const isUuidLike = (s: string | null): s is string => Boolean(s) && s !== 'system' && s !== 'unknown';

export function staffId(by: Caller): string {
  const id = by.principal.accountId ?? by.actor.id;
  if (!id) throw new AppError('FORBIDDEN', 'Staff sign-in required');
  return id;
}

function inputColumns(m: MetricInput) {
  return {
    name: m.name.trim(),
    group_key: m.group,
    definition: m.definition.trim(),
    formula: m.formula.trim(),
    unit: m.unit,
    includes: m.includes ?? [],
    excludes: m.excludes ?? [],
    date_basis_options: m.dateBasisOptions,
    default_date_basis: m.defaultDateBasis,
    related_keys: m.relatedKeys ?? [],
    audience: m.audience,
    owner_staff_id: m.ownerId,
  };
}

function rowView(r: MetricRow): Omit<MetricDefinition, 'owner' | 'changeNote'> {
  return {
    key: r.key,
    name: r.name,
    group: r.group_key as MetricDefinition['group'],
    definition: r.definition,
    formula: r.formula,
    unit: r.unit as MetricDefinition['unit'],
    includes: strings(r.includes),
    excludes: strings(r.excludes),
    dateBasisOptions: strings(r.date_basis_options),
    defaultDateBasis: r.default_date_basis as MetricDefinition['defaultDateBasis'],
    currencyRule: r.currency_rule,
    timeZone: r.time_zone,
    relatedKeys: strings(r.related_keys),
    audience: r.audience as MetricDefinition['audience'],
    launchMeasure: r.launch_measure,
    status: r.status as MetricDefinition['status'],
    version: r.version,
    effectiveFrom: r.effective_from,
    reviewedAt: r.reviewed_at,
  };
}

function snapshotOf(r: MetricRow, changeNote: string): Snapshot {
  return { ...rowView(r), status: 'published', changeNote, ownerId: r.owner_staff_id };
}
