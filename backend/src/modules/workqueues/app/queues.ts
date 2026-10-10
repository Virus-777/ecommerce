/**
 * Queue definitions (lead, backup, escalation route, deadline), live counts, intake rules, coverage
 * gaps, the dashboard's needs-attention tiles and team on shift.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type { CoverageGap, EscalationStep, IntakeRule, QueueDefinition, QueueInput, QueueSummary, StaffRef, TeamOnShift } from '../../../spec/workqueues.js';
import { AREA_LABELS, isArea, type Area } from '../domain/catalog.js';
import { ageLabel, coverageGaps, escalationLabel, oldestLabel, routeIssues, slug } from '../domain/rules.js';
import type { QueueRow } from '../ports.js';
import { actorJson, type By, type Core, type Viewer } from './core.js';

export interface Oldest {
  itemId: string;
  ref: string;
  subjectRef: string | null;
  openedAt: string;
  ageLabel: string;
}

export interface Tile {
  queueKey: string;
  name: string;
  areaLabel: string;
  count: number;
  overdue: number;
  tone: 'danger' | 'warning' | 'neutral';
  oldestLabel: string | null;
  screen: string;
  screenFilter: string | null;
}

export class Queues {
  constructor(private readonly core: Core) {}

  get repo() {
    return this.core.repo;
  }

  /* ---------------------------------------------------------------- reading */

  async summaries(queues: QueueRow[], v: Viewer | null): Promise<(QueueSummary & { oldest: Oldest | null })[]> {
    const core = this.core;
    const now = core.now();
    const [counts, oldest, assigned, refs] = await Promise.all([
      this.repo.queueCounts(now, await core.dueSoonMinutes()),
      this.repo.oldestOpen(),
      v ? this.repo.assignedCounts(v.staffId) : Promise.resolve([]),
      core.staffRefs(queues.flatMap((q) => [q.lead_staff_id, q.backup_staff_id])),
    ]);
    const c = new Map(counts.map((x) => [x.queue_key, x]));
    const o = new Map(oldest.map((x) => [x.queue_key, x]));
    const mineByItems = new Set(assigned.filter((a) => a.n > 0).map((a) => a.queue_key));
    return queues.map((q) => {
      const count = c.get(q.key);
      const old = o.get(q.key);
      return {
        key: q.key,
        name: q.name,
        area: q.area,
        lead: refs.get(q.lead_staff_id)!,
        backup: refs.get(q.backup_staff_id)!,
        escalationLabel: q.escalation_label,
        open: count?.open ?? 0,
        overdue: count?.overdue ?? 0,
        dueSoon: count?.due_soon ?? 0,
        oldest: old ? { itemId: old.id, ref: old.ref, subjectRef: old.subject_ref, openedAt: old.opened_at.toISOString(), ageLabel: `${old.subject_ref ?? old.ref} · ${ageLabel(old.opened_at, now)}` } : null,
        mine: Boolean(v && (q.lead_staff_id === v.staffId || q.backup_staff_id === v.staffId || mineByItems.has(q.key))),
        screen: q.screen,
        screenFilter: q.screen_filter,
      };
    });
  }

  /** Queues the caller sees, optionally of one area or only mine */
  async list(v: Viewer, filter: { area?: string; mine?: boolean }): Promise<QueueSummary[]> {
    await this.core.ensureSeeded();
    if (filter.area && !isArea(filter.area)) throw new AppError('VALIDATION_FAILED', `Unknown area ${filter.area}`, { issues: [{ path: 'area', message: 'unknown area' }] });
    const queues = (await this.repo.listQueues()).filter((q) => this.core.queueVisible(v, q) && (!filter.area || q.area === filter.area));
    const out = await this.summaries(queues, v);
    return filter.mine ? out.filter((q) => q.mine || v.roles.includes(queues.find((x) => x.key === q.key)!.owner_role)) : out;
  }

  async definitions(queues: QueueRow[]): Promise<QueueDefinition[]> {
    const refs = await this.core.staffRefs(queues.flatMap((q) => [q.lead_staff_id, q.backup_staff_id]));
    return queues.map((q) => this.core.queueDefinition(q, refs));
  }

  async get(v: Viewer, key: string): Promise<{ queue: QueueDefinition; intakeRules: IntakeRule[]; counts: QueueSummary }> {
    await this.core.ensureSeeded();
    const q = await this.repo.getQueue(key);
    if (!q || !this.core.queueVisible(v, q)) throw new AppError('NOT_FOUND', 'Queue not found');
    const [[queue], intakeRules, [counts]] = await Promise.all([this.definitions([q]), this.intakeRules(key), this.summaries([q], v)]);
    return { queue: queue!, intakeRules, counts: counts! };
  }

  async intakeRules(queueKey?: string): Promise<IntakeRule[]> {
    await this.core.ensureSeeded();
    const rows = await this.repo.listIntakeRules(queueKey ? { queueKey } : undefined);
    return rows.map((r) => ({
      event: r.event,
      queueKey: r.queue_key,
      kind: r.kind,
      titleTemplate: r.title_template,
      dedupeKeyTemplate: r.dedupe_key_template,
      deadline: r.deadline_rule,
      priority: r.priority,
      resolvesOn: (r.resolves_on ?? []) as string[],
      active: r.active,
    }));
  }

  async coverageGaps(): Promise<CoverageGap[]> {
    await this.core.ensureSeeded();
    const queues = await this.repo.listQueues();
    const info = await this.core.staffInfo(queues.flatMap((q) => [q.lead_staff_id, q.backup_staff_id]));
    return coverageGaps(
      queues.map((q) => ({ key: q.key, name: q.name, leadId: q.lead_staff_id, backupId: q.backup_staff_id, active: q.active })),
      info,
    );
  }

  /** Counts for other dashboards */
  async openCounts(keys: string[]): Promise<Record<string, { open: number; overdue: number }>> {
    await this.core.ensureSeeded();
    const counts = new Map((await this.repo.queueCounts(this.core.now(), await this.core.dueSoonMinutes())).map((c) => [c.queue_key, c]));
    const wanted = keys.length ? keys : (await this.repo.listQueues()).map((q) => q.key);
    return Object.fromEntries(wanted.map((k) => [k, { open: counts.get(k)?.open ?? 0, overdue: counts.get(k)?.overdue ?? 0 }]));
  }

  /* ---------------------------------------------------------------- changing queues */

  async #validate(input: QueueInput): Promise<void> {
    const issues: { path: string; message: string }[] = [];
    if (!input.name?.trim()) issues.push({ path: 'name', message: 'A name is required' });
    if (!isArea(input.area)) issues.push({ path: 'area', message: 'Unknown area' });
    if (!input.ownerRole?.trim()) issues.push({ path: 'ownerRole', message: 'An owner role is required' });
    if (!Number.isInteger(input.defaultDeadlineMinutes) || input.defaultDeadlineMinutes <= 0) issues.push({ path: 'defaultDeadlineMinutes', message: 'Must be at least one minute' });
    if (!input.screen?.trim()) issues.push({ path: 'screen', message: 'The screen where the work is done is required' });
    if (!input.reason?.trim()) issues.push({ path: 'reason', message: 'A reason is required' });
    issues.push(...routeIssues(input.escalationRoute));
    if (issues.length) throw new AppError('VALIDATION_FAILED', issues[0]!.message, { issues });
    if (input.leadId === input.backupId) throw new AppError('LEAD_EQUALS_BACKUP', 'The backup must be a different person from the lead');
    const roles = (await this.core.coverage()).map((c) => c.role.key);
    if (roles.length && !roles.includes(input.ownerRole)) throw new AppError('VALIDATION_FAILED', `Unknown role ${input.ownerRole}`, { issues: [{ path: 'ownerRole', message: 'not an access role' }] });
    const info = await this.core.staffInfo([input.leadId, input.backupId]);
    const people: { path: string; message: string }[] = [];
    if (!info.get(input.leadId)?.known) people.push({ path: 'leadId', message: 'not a known staff member' });
    if (!info.get(input.backupId)?.known) people.push({ path: 'backupId', message: 'not a known staff member' });
    for (const [i, s] of input.escalationRoute.entries()) {
      const to = s.to as { kind?: string; staffId?: string };
      if (to?.kind === 'staff' && to.staffId && !isUuid(to.staffId)) people.push({ path: `escalationRoute.${i}.to.staffId`, message: 'not a staff id' });
    }
    if (people.length) throw new AppError('VALIDATION_FAILED', 'The lead and backup must be known staff members', { issues: people });
  }

  #row(input: QueueInput, by: By, before?: QueueRow): Omit<QueueRow, 'key'> {
    return {
      name: input.name.trim(),
      area: input.area,
      owner_role: input.ownerRole.trim(),
      lead_staff_id: input.leadId,
      backup_staff_id: input.backupId,
      escalation_route: input.escalationRoute as never,
      escalation_label: escalationLabel(input.escalationRoute),
      default_deadline_minutes: input.defaultDeadlineMinutes,
      business_hours_only: input.businessHoursOnly ?? false,
      pause_while_waiting: input.pauseWhileWaiting ?? before?.pause_while_waiting ?? false,
      screen: input.screen.trim(),
      screen_filter: input.screenFilter ?? null,
      visible_to_seller: input.visibleToSeller ?? false,
      active: input.active ?? true,
      updated_by: actorJson(by.actor),
      updated_at: this.core.now(),
    };
  }

  async create(input: QueueInput, by: By): Promise<QueueDefinition> {
    await this.core.ensureSeeded();
    await this.#validate(input);
    const base = `${slug(input.area)}.${slug(input.name)}`;
    const row = this.#row(input, by);
    let key = base;
    for (let n = 2; !(await this.repo.insertQueue({ key, ...row })); n++) key = `${base}_${n}`;
    const [def] = await this.definitions([{ key, ...row }]);
    await this.core.audit({ action: 'workqueues.queue.create', actionLabel: 'Created work queue', category: 'access', target: { type: 'work_queue', id: key, label: row.name }, reason: input.reason, after: def }, by);
    return def!;
  }

  async update(key: string, input: QueueInput, by: By): Promise<QueueDefinition> {
    await this.core.ensureSeeded();
    const existing = await this.repo.getQueue(key);
    if (!existing) throw new AppError('NOT_FOUND', 'Queue not found');
    await this.#validate(input);
    const { before, after } = await this.repo.transaction(async (tx) => {
      const before = (await tx.getQueue(key, { forUpdate: true }))!;
      const after = await tx.updateQueue(key, this.#row(input, by, before));
      return { before, after };
    });
    const [beforeDef, afterDef] = await this.definitions([before, after]);
    const routeChanged = JSON.stringify(before.escalation_route) !== JSON.stringify(after.escalation_route);
    if (before.lead_staff_id !== after.lead_staff_id || before.backup_staff_id !== after.backup_staff_id || routeChanged) {
      this.core.ctx.events.publish('workqueues.queue.changed', { queueKey: key, leadId: after.lead_staff_id, backupId: after.backup_staff_id }, by);
    }
    await this.core.audit({ action: 'workqueues.queue.update', actionLabel: 'Changed work queue', category: 'access', target: { type: 'work_queue', id: key, label: after.name }, reason: input.reason, before: beforeDef, after: afterDef }, by);
    return afterDef!;
  }

  /* ---------------------------------------------------------------- dashboard */

  tiles(summaries: (QueueSummary & { oldest: Oldest | null })[], queues: Map<string, QueueRow>): Tile[] {
    const now = this.core.now();
    const rank = { danger: 0, warning: 1, neutral: 2 } as const;
    return summaries
      .filter((s) => s.open > 0)
      .map((s): Tile => {
        const q = queues.get(s.key)!;
        return {
          queueKey: s.key,
          name: s.name,
          areaLabel: AREA_LABELS[q.area as Area] ?? q.area,
          count: s.open,
          overdue: s.overdue,
          tone: s.overdue > 0 ? 'danger' : s.dueSoon > 0 ? 'warning' : 'neutral',
          oldestLabel: s.oldest ? oldestLabel(new Date(s.oldest.openedAt), now) : null,
          screen: s.screen,
          screenFilter: s.screenFilter ?? null,
        };
      })
      .sort((a, b) => rank[a.tone] - rank[b.tone] || b.overdue - a.overdue || b.count - a.count);
  }

  /** Leads and backups of the visible queues' owner roles, with away state and who covers for whom */
  async team(queues: QueueRow[]): Promise<TeamOnShift[]> {
    const core = this.core;
    const roleKeys = new Set(queues.map((q) => q.owner_role));
    const coverage = (await core.coverage()).filter((c) => roleKeys.has(c.role.key));
    const out: TeamOnShift[] = [];
    const seen = new Set<string>();
    const ref = (s: { accountId: string; name: string }, role: string): StaffRef => ({ staffId: s.accountId, name: s.name, role });
    if (coverage.length) {
      for (const c of coverage) {
        if (c.lead && !seen.has(`${c.lead.accountId}|lead|${c.workArea}`)) {
          seen.add(`${c.lead.accountId}|lead|${c.workArea}`);
          out.push({ staff: ref(c.lead, c.role.name), area: c.workArea, role: 'lead', coveringFor: null, status: c.lead.away ? 'away' : 'on_shift' });
        }
        for (const b of c.backups) {
          if (seen.has(`${b.accountId}|backup|${c.workArea}`)) continue;
          seen.add(`${b.accountId}|backup|${c.workArea}`);
          const covering = c.viaBackup && c.receivingNow.some((r) => r.accountId === b.accountId);
          out.push({ staff: ref(b, c.role.name), area: c.workArea, role: 'backup', coveringFor: covering && c.lead ? ref(c.lead, c.role.name) : null, status: b.away ? 'away' : covering ? 'on_shift' : 'off' });
        }
      }
      return out;
    }
    // access has no coverage yet: the queues' own leads and backups
    const info = await core.staffInfo(queues.flatMap((q) => [q.lead_staff_id, q.backup_staff_id]));
    for (const q of queues) {
      const area = AREA_LABELS[q.area as Area] ?? q.area;
      for (const [id, role] of [[q.lead_staff_id, 'lead'], [q.backup_staff_id, 'backup']] as const) {
        const i = info.get(id)!;
        if (!i.known || seen.has(`${id}|${role}|${area}`)) continue;
        seen.add(`${id}|${role}|${area}`);
        const leadAway = info.get(q.lead_staff_id)?.away ?? false;
        out.push({ staff: { staffId: id, name: i.name, role: i.roleLabel }, area, role, coveringFor: role === 'backup' && leadAway ? { staffId: q.lead_staff_id, name: info.get(q.lead_staff_id)!.name, role: null } : null, status: i.away ? 'away' : role === 'backup' && !leadAway ? 'off' : 'on_shift' });
      }
    }
    return out;
  }

  /** Readable route of each visible queue, for reminders */
  static route(q: QueueRow): EscalationStep[] {
    return (q.escalation_route ?? []) as unknown as EscalationStep[];
  }
}
