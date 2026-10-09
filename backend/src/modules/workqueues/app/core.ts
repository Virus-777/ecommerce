/**
 * Shared context of the workqueues use cases: ports, settings, the install seed, lookups into
 * access (staff names, roles, away state; cached briefly and dropped on access events), the caller's
 * view (which queues and items they reach), row â†’ API mapping, events and audit.
 */
import { createHash } from 'node:crypto';
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import type { Actor, TimelineEvent } from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type { EscalationStep, QueueDefinition, StaffRef, WorkItem, WorkItemNote, WorkSubject } from '../../../spec/workqueues.js';
import { isActive, isPlaceholder, PLACEHOLDER_BACKUP, PLACEHOLDER_LEAD, QUEUE_SEEDS, roleLabel, SYSTEM_UPDATED_BY, type Area } from '../domain/catalog.js';
import { intakeQueueKeys, intakeRuleDocs } from '../domain/intake.js';
import { deadlineState, escalationLabel } from '../domain/rules.js';
import { DEFAULT_TEMPLATES } from '../domain/routine-defaults.js';
import type { ArchiveStore, ItemEventRow, ItemNoteRow, ItemRow, ItemVisibility, QueueRow, WorkqueuesRepository } from '../ports.js';

export const SYSTEM: Actor = { kind: 'system', name: 'Work queues' };

export interface By {
  actor: Actor;
  requestId?: string;
}

/** The staff member looking at queues and items */
export interface Viewer {
  principal: identity.Principal;
  staffId: string;
  name: string | null;
  roles: string[];
  viewAll: boolean;
  can(permission: string): Promise<boolean>;
}

export interface StaffInfo {
  known: boolean;
  away: boolean;
  name: string;
  roleLabel: string | null;
}

const TTL_MS = 30_000;

/** Stable uuid-shaped id from a text key (seeded intake rules keep their ids across boots) */
export function stableId(key: string): string {
  const h = createHash('sha1').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const actorJson = (a: Actor) => JSON.stringify({ kind: a.kind, ...(a.id ? { id: a.id } : {}), ...(a.name ? { name: a.name } : {}) });

export interface WorkqueuesCoreDeps {
  repo: WorkqueuesRepository;
  ctx: ModuleContext<'workqueues'>;
  archive: ArchiveStore;
}

export class Core {
  readonly repo: WorkqueuesRepository;
  readonly ctx: ModuleContext<'workqueues'>;
  readonly archive: ArchiveStore;
  #seeding: Promise<void> | undefined;
  #staff = new Map<string, { at: number; info: StaffInfo }>();
  #roles = new Map<string, { at: number; roles: string[] }>();

  constructor(deps: WorkqueuesCoreDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
    this.archive = deps.archive;
  }

  now = () => this.ctx.clock.now();
  get log() {
    return this.ctx.log;
  }
  get timeZone() {
    return this.ctx.config.market.timeZone;
  }
  /** Market date today (YYYY-MM-DD) */
  today = () => dateInZone(this.now(), this.timeZone);
  async dueSoonMinutes(): Promise<number> {
    return Number(await this.ctx.settings.get('dueSoonMinutes')) || 60;
  }

  get access(): access.AccessPublicApi {
    return this.ctx.use('access');
  }

  /* ---------------------------------------------------------------- install seed */

  /** Seed queues, intake rules and the default daily routine (idempotent; staff changes are kept) */
  ensureSeeded(): Promise<void> {
    this.#seeding ??= this.#seed().catch((err) => {
      this.#seeding = undefined;
      throw err;
    });
    return this.#seeding;
  }

  async #seed() {
    const now = this.now();
    const wanted = new Set([...((await this.ctx.settings.get('seedQueues')) as readonly string[]), ...intakeQueueKeys()]);
    const coverage = await this.coverage();
    for (const key of wanted) {
      const s = QUEUE_SEEDS[key];
      if (!s) {
        this.log.warn({ key }, 'workqueues: seedQueues names a queue this module has no definition for; skipped');
        continue;
      }
      const cov = coverage.find((c) => c.role.key === s.ownerRole);
      const lead = cov?.lead?.accountId ?? PLACEHOLDER_LEAD;
      const backup = cov?.backups.find((b) => b.accountId !== lead)?.accountId ?? PLACEHOLDER_BACKUP;
      await this.repo.insertQueue({
        key: s.key,
        name: s.name,
        area: s.area,
        owner_role: s.ownerRole,
        lead_staff_id: lead,
        backup_staff_id: backup === lead ? PLACEHOLDER_BACKUP : backup,
        escalation_route: s.escalationRoute as never,
        escalation_label: escalationLabel(s.escalationRoute),
        default_deadline_minutes: s.defaultDeadlineMinutes,
        business_hours_only: s.businessHoursOnly,
        screen: s.screen,
        screen_filter: s.screenFilter,
        visible_to_seller: s.visibleToSeller,
        active: true,
        updated_by: SYSTEM_UPDATED_BY,
        updated_at: now,
      });
    }
    const existing = new Set((await this.repo.listQueues()).map((q) => q.key));
    const rules = intakeRuleDocs()
      .filter((r) => existing.has(r.queueKey))
      .map((r) => ({
        id: stableId(`${r.event}|${r.kind}|${r.queueKey}`),
        event: r.event,
        queue_key: r.queueKey,
        kind: r.kind,
        title_template: r.titleTemplate,
        dedupe_key_template: r.dedupeKeyTemplate,
        deadline_rule: r.deadline,
        priority: r.priority,
        resolves_on: r.resolvesOn as never,
        active: true,
      }));
    await this.repo.upsertIntakeRules(rules);
    // an event re-routed to another queue (e.g. chargebacks to finance.chargebacks) leaves its old rule inactive
    await this.repo.deactivateIntakeRulesExcept(rules.map((r) => r.id));
    if ((await this.repo.countTemplates()) === 0) {
      for (const t of DEFAULT_TEMPLATES) {
        await this.repo.upsertTemplate({ id: stableId(`routine|${t.title}`), title: t.title, area_label: t.areaLabel, owner_roles: t.ownerRoles as never, due_time: t.dueTime, weekdays: t.weekdays as never, active: true });
      }
    }
  }

  /** Role coverage from access (empty when access cannot answer yet) */
  async coverage(): Promise<access.RoleCoverage[]> {
    try {
      return await this.access.coverageNow({});
    } catch (err) {
      if (!isNotImplemented(err)) throw err;
      return [];
    }
  }

  /* ---------------------------------------------------------------- staff (access) */

  invalidateStaff() {
    this.#staff.clear();
    this.#roles.clear();
  }

  async staffInfo(ids: (string | null | undefined)[]): Promise<Map<string, StaffInfo>> {
    const out = new Map<string, StaffInfo>();
    const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    const at = Date.now();
    await Promise.all(
      unique.map(async (id) => {
        if (isPlaceholder(id)) return out.set(id, { known: false, away: false, name: 'Not set', roleLabel: null });
        const hit = this.#staff.get(id);
        if (hit && at - hit.at < TTL_MS) return out.set(id, hit.info);
        const ref = await this.access.getStaffRef(id);
        const info: StaffInfo = ref ? { known: true, away: ref.away, name: ref.name, roleLabel: ref.roleLabel ?? null } : { known: false, away: false, name: 'Unknown staff member', roleLabel: null };
        this.#staff.set(id, { at, info });
        return out.set(id, info);
      }),
    );
    return out;
  }

  async staffRefs(ids: (string | null | undefined)[]): Promise<Map<string, StaffRef>> {
    const info = await this.staffInfo(ids);
    return new Map([...info].map(([id, i]) => [id, { staffId: id, name: i.name, role: i.roleLabel }]));
  }

  async staffRef(id: string): Promise<StaffRef> {
    return (await this.staffRefs([id])).get(id)!;
  }

  async rolesOf(accountId: string): Promise<string[]> {
    const hit = this.#roles.get(accountId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.roles;
    const roles = (await this.access.rolesOf(accountId)).map((r) => r.key);
    this.#roles.set(accountId, { at: Date.now(), roles });
    return roles;
  }

  /** Who receives a queue's new and escalating work now: the lead, or the backup while the lead is away */
  async receiverOf(queue: QueueRow): Promise<{ id: string; viaBackup: boolean; leadName: string; backupName: string }> {
    const info = await this.staffInfo([queue.lead_staff_id, queue.backup_staff_id]);
    const lead = info.get(queue.lead_staff_id)!;
    const backup = info.get(queue.backup_staff_id)!;
    const viaBackup = lead.known && lead.away && backup.known && !backup.away;
    return { id: viaBackup ? queue.backup_staff_id : queue.lead_staff_id, viaBackup, leadName: lead.name, backupName: backup.name };
  }

  /* ---------------------------------------------------------------- the caller's view */

  async viewer(principal: identity.Principal, can?: (permission: string) => Promise<boolean>): Promise<Viewer> {
    if (principal?.kind !== 'staff' || !principal.accountId) throw new AppError('FORBIDDEN', 'Work queues are for staff members');
    const check = can ?? ((p: string) => this.access.hasPermission(principal, p));
    const [roles, viewAll] = await Promise.all([this.rolesOf(principal.accountId), check('workqueues.items.view-all')]);
    const name = (principal as { name?: string | null }).name ?? null;
    return { principal, staffId: principal.accountId, name, roles, viewAll, can: check };
  }

  /** Queues the caller's roles own, or that the caller leads or backs up (every queue with view-all) */
  queueVisible(v: Viewer, q: QueueRow): boolean {
    return v.viewAll || v.roles.includes(q.owner_role) || q.lead_staff_id === v.staffId || q.backup_staff_id === v.staffId;
  }

  visibility(v: Viewer, queues: QueueRow[]): ItemVisibility | null {
    if (v.viewAll) return null;
    return { queueKeys: queues.filter((q) => this.queueVisible(v, q)).map((q) => q.key), roles: v.roles, staffId: v.staffId };
  }

  itemVisible(v: Viewer, row: ItemRow, queue: QueueRow | undefined): boolean {
    if (v.viewAll) return true;
    if (queue && this.queueVisible(v, queue)) return true;
    if (v.roles.includes(row.owner_role) || row.assignee_staff_id === v.staffId) return true;
    return row.escalated_to === `staff:${v.staffId}` || v.roles.some((r) => row.escalated_to === `role:${r}`);
  }

  async queueMap(): Promise<Map<string, QueueRow>> {
    return new Map((await this.repo.listQueues()).map((q) => [q.key, q]));
  }

  /* ---------------------------------------------------------------- deadlines */

  /** now + the queue's default deadline, in market business hours when the queue says so */
  async defaultDue(queue: QueueRow, from: Date = this.now()): Promise<Date> {
    const minutes = queue.default_deadline_minutes;
    if (queue.business_hours_only) {
      const settings = this.ctx.tryUse('settings');
      if (settings) {
        try {
          const cal = await settings.businessCalendar();
          return new Date(cal.addBusinessMinutes(from.toISOString(), minutes));
        } catch (err) {
          if (!isNotImplemented(err)) throw err;
        }
      }
    }
    return new Date(from.getTime() + minutes * 60_000);
  }

  /* ---------------------------------------------------------------- history */

  /** One history line. Inside a transaction pass its repository (one connection: never call outside it while it is open). */
  async history(itemId: string, kind: string, label: string, by: Actor, extra: Record<string, unknown> = {}, repo: WorkqueuesRepository = this.repo) {
    await repo.insertEvent({
      id: newId(),
      item_id: itemId,
      kind,
      detail: { label, ...(by.name ? { actorName: by.name } : {}), ...extra } as never,
      actor_kind: by.kind,
      actor_id: by.id ?? null,
      at: this.now(),
    });
  }

  /* ---------------------------------------------------------------- mapping */

  queueDefinition(q: QueueRow, refs: Map<string, StaffRef>): QueueDefinition {
    return {
      key: q.key,
      name: q.name,
      area: q.area as Area,
      ownerRole: q.owner_role,
      lead: refs.get(q.lead_staff_id) ?? { staffId: q.lead_staff_id, name: 'Not set', role: null },
      backup: refs.get(q.backup_staff_id) ?? { staffId: q.backup_staff_id, name: 'Not set', role: null },
      escalationRoute: (q.escalation_route ?? []) as unknown as EscalationStep[],
      escalationLabel: q.escalation_label,
      defaultDeadlineMinutes: q.default_deadline_minutes,
      businessHoursOnly: q.business_hours_only,
      screen: q.screen,
      screenFilter: q.screen_filter,
      visibleToSeller: q.visible_to_seller,
      active: q.active,
    };
  }

  /** Rows â†’ WorkItems with lead, backup, assignee, escalation target, notes and history (batched) */
  async workItems(rows: ItemRow[], queues?: Map<string, QueueRow>): Promise<WorkItem[]> {
    if (!rows.length) return [];
    const qmap = queues ?? (await this.queueMap());
    const ids = rows.map((r) => r.id);
    const [events, notes, dueSoon] = await Promise.all([this.repo.eventsOfItems(ids), this.repo.notesOfItems(ids), this.dueSoonMinutes()]);
    const roleTargets = [...new Set(rows.map((r) => r.escalated_to).filter((t): t is string => Boolean(t?.startsWith('role:'))).map((t) => t.slice(5)))];
    const roleReceiver = new Map<string, string | null>();
    await Promise.all(
      roleTargets.map(async (key) => {
        const r = await this.access.resolveRecipients(key);
        roleReceiver.set(key, r.accountIds[0] ?? null);
      }),
    );
    const staffIds = rows.flatMap((r) => {
      const q = qmap.get(r.queue_key);
      const esc = r.escalated_to?.startsWith('staff:') ? r.escalated_to.slice(6) : r.escalated_to?.startsWith('role:') ? roleReceiver.get(r.escalated_to.slice(5)) : null;
      return [q?.lead_staff_id, q?.backup_staff_id, r.assignee_staff_id, esc];
    });
    const refs = await this.staffRefs(staffIds);
    const byItem = <T extends { item_id: string }>(list: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of list) m.set(x.item_id, [...(m.get(x.item_id) ?? []), x]);
      return m;
    };
    const ev = byItem(events);
    const nt = byItem(notes);
    const now = this.now();
    return rows.map((r) => {
      const q = qmap.get(r.queue_key);
      const itemEvents = ev.get(r.id) ?? [];
      let escalatedTo: StaffRef | null = null;
      if (r.escalated_to?.startsWith('staff:')) escalatedTo = refs.get(r.escalated_to.slice(6)) ?? null;
      else if (r.escalated_to?.startsWith('role:')) {
        const key = r.escalated_to.slice(5);
        const who = roleReceiver.get(key);
        escalatedTo = who ? { ...(refs.get(who) ?? { staffId: who, name: 'Staff member' }), role: roleLabel(key) } : null;
      }
      const raised = itemEvents.find((e) => e.kind === 'raised');
      return {
        id: r.id,
        ref: r.ref,
        queueKey: r.queue_key,
        queueName: q?.name ?? r.queue_key,
        area: q?.area ?? 'platform',
        kind: r.kind as WorkItem['kind'],
        title: r.title,
        summary: r.summary,
        subject: { type: r.subject_type as WorkSubject['type'], id: r.subject_id, ref: r.subject_ref, label: r.subject_label },
        relatedSubjects: (r.related_subjects ?? []) as unknown as WorkSubject[],
        sellerId: r.seller_id,
        sellerName: r.seller_name,
        customerId: r.customer_id,
        amount: r.amount_minor !== null && r.amount_minor !== undefined ? { amount: Number(r.amount_minor), currency: r.currency ?? 'USD' } : null,
        ownerRole: r.owner_role,
        lead: q ? refs.get(q.lead_staff_id)! : { staffId: PLACEHOLDER_LEAD, name: 'Not set', role: null },
        backup: q ? refs.get(q.backup_staff_id)! : { staffId: PLACEHOLDER_BACKUP, name: 'Not set', role: null },
        assignee: r.assignee_staff_id ? (refs.get(r.assignee_staff_id) ?? null) : null,
        deadline: { dueAt: r.due_at.toISOString(), state: isActive(r.state) ? deadlineState(r.due_at, now, dueSoon) : (r.deadline_state as WorkItem['deadline']['state']) },
        priority: r.priority as WorkItem['priority'],
        state: r.state as WorkItem['state'],
        waitingOn: (r.waiting_on as WorkItem['waitingOn']) ?? null,
        escalationLevel: r.escalation_level,
        escalatedTo,
        source: { module: r.source_module, event: r.source_event, raisedBy: raised ? this.eventActor(raised) : SYSTEM, dedupeKey: r.dedupe_key },
        links: (r.links ?? []) as unknown[],
        visibleToSeller: r.visible_to_seller,
        notes: (nt.get(r.id) ?? []).map((n) => this.note(n)),
        history: itemEvents.map((e) => this.timeline(e)),
        openedAt: r.opened_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
        resolution: r.resolution ?? null,
      };
    });
  }

  async workItem(row: ItemRow): Promise<WorkItem> {
    return (await this.workItems([row]))[0]!;
  }

  eventActor(e: ItemEventRow): Actor {
    const d = (e.detail ?? {}) as { actorName?: string };
    return { kind: e.actor_kind as Actor['kind'], ...(e.actor_id ? { id: e.actor_id } : {}), ...(d.actorName ? { name: d.actorName } : {}) };
  }

  timeline(e: ItemEventRow): TimelineEvent {
    const d = (e.detail ?? {}) as { label?: string; text?: string | null };
    return { at: e.at.toISOString(), label: d.label ?? e.kind, detail: d.text ?? null, actor: this.eventActor(e) };
  }

  note(n: ItemNoteRow): WorkItemNote {
    const staff = !n.author_id.startsWith('system');
    return { id: n.id, body: n.body, author: staff ? { kind: 'staff', id: n.author_id, name: n.author_name } : { ...SYSTEM, name: n.author_name }, at: n.at.toISOString() };
  }

  /* ---------------------------------------------------------------- audit */

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'> & { category?: audit.RecordInput['category'] }, by: By) {
    await this.ctx.tryUse('audit')?.record({ category: 'other', ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId });
  }
}
