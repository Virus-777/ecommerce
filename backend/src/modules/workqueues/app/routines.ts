/**
 * The daily operating routine: templates (what to check, by which roles, by when, on which weekdays),
 * today's checks generated for the owner roles on shift, check-ins for shared checks, late marking.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { RoutineCheck, RoutineDay, RoutineTemplate } from '../../../spec/workqueues.js';
import { PLACEHOLDER_LEAD } from '../domain/catalog.js';
import { isHhMm, runsOn } from '../domain/rules.js';
import { routineCheckMachine } from '../domain/state-machines.js';
import type { RoutineCheckRow, RoutineTemplateRow } from '../ports.js';
import type { By, Core, Viewer } from './core.js';

interface CheckIns {
  required: string[];
  done: string[];
}

const checkInsOf = (r: RoutineCheckRow): CheckIns => {
  const c = (r.check_ins ?? {}) as Partial<CheckIns>;
  return { required: Array.isArray(c.required) ? c.required : [], done: Array.isArray(c.done) ? c.done : [] };
};

export class Routines {
  constructor(private readonly core: Core) {}

  get repo() {
    return this.core.repo;
  }

  template(r: RoutineTemplateRow): RoutineTemplate {
    return { id: r.id, title: r.title, areaLabel: r.area_label, ownerRoles: (r.owner_roles ?? []) as string[], dueTime: r.due_time, weekdays: (r.weekdays ?? []) as number[], active: r.active };
  }

  async templates(): Promise<RoutineTemplate[]> {
    await this.core.ensureSeeded();
    return (await this.repo.listTemplates()).map((t) => this.template(t));
  }

  async replace(templates: RoutineTemplate[], reason: string, by: By): Promise<RoutineTemplate[]> {
    await this.core.ensureSeeded();
    if (!reason?.trim()) throw new AppError('VALIDATION_FAILED', 'A reason is required', { issues: [{ path: 'reason', message: 'required' }] });
    const issues: { path: string; message: string }[] = [];
    const ids = new Set<string>();
    templates.forEach((t, i) => {
      if (!isUuid(t.id)) issues.push({ path: `templates.${i}.id`, message: 'not an id' });
      if (ids.has(t.id)) issues.push({ path: `templates.${i}.id`, message: 'used twice' });
      ids.add(t.id);
      if (!t.title?.trim()) issues.push({ path: `templates.${i}.title`, message: 'a title is required' });
      if (!t.ownerRoles?.length || t.ownerRoles.some((r) => !r?.trim())) issues.push({ path: `templates.${i}.ownerRoles`, message: 'at least one role' });
      if (!isHhMm(t.dueTime)) issues.push({ path: `templates.${i}.dueTime`, message: 'use HH:MM market time' });
      if (!t.weekdays?.length || t.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 7)) issues.push({ path: `templates.${i}.weekdays`, message: 'weekdays 1 (Monday) to 7 (Sunday)' });
    });
    if (issues.length) throw new AppError('VALIDATION_FAILED', `Routine template: ${issues[0]!.message}`, { issues });
    const before = await this.templates();
    await this.repo.transaction(async (tx) => {
      for (const t of templates) {
        await tx.upsertTemplate({ id: t.id, title: t.title.trim(), area_label: t.areaLabel?.trim() || 'Operations', owner_roles: t.ownerRoles as never, due_time: t.dueTime, weekdays: [...new Set(t.weekdays)].sort() as never, active: t.active ?? true });
      }
      await tx.deactivateTemplatesExcept(templates.map((t) => t.id));
    });
    const after = await this.templates();
    await this.core.audit({ action: 'workqueues.routine.replace', actionLabel: 'Replaced the daily routine', category: 'settings', target: { type: 'routine', id: 'daily', label: 'Daily operating routine' }, reason: reason.trim(), before, after }, by);
    return after;
  }

  /** Job routine-generate (and first read of a day): today's checks; earlier unfinished checks become late */
  async generate(date = this.core.today()): Promise<number> {
    const core = this.core;
    await core.ensureSeeded();
    await this.repo.markChecksLate({ beforeDate: date });
    const templates = (await this.repo.listTemplates({ activeOnly: true })).filter((t) => runsOn((t.weekdays ?? []) as number[], date));
    const existing = new Set((await this.repo.checksOn(date)).map((c) => c.template_id));
    let created = 0;
    for (const t of templates) {
      if (existing.has(t.id)) continue;
      const roles = (t.owner_roles ?? []) as string[];
      const receivers: string[] = [];
      for (const role of roles) {
        const r = await core.access.resolveRecipients(role);
        const who = r.accountIds[0];
        if (who && !receivers.includes(who)) receivers.push(who);
      }
      await this.repo.insertCheck({
        id: newId(),
        template_id: t.id,
        date,
        owner_staff_id: receivers[0] ?? PLACEHOLDER_LEAD,
        due_at: zonedTimeToUtc(date, t.due_time, core.timeZone),
        state: routineCheckMachine.initial,
        done_at: null,
        done_by: null,
        note: null,
        check_ins: { required: roles.length > 1 ? receivers : [], done: [] } as never,
      });
      created++;
    }
    return created;
  }

  /** Job routine-late: checks past their due time */
  async late(): Promise<number> {
    await this.core.ensureSeeded();
    return this.repo.markChecksLate({ dueBefore: this.core.now() });
  }

  async #views(rows: RoutineCheckRow[]): Promise<RoutineCheck[]> {
    const templates = new Map((await this.repo.listTemplates()).map((t) => [t.id, t]));
    const refs = await this.core.staffRefs(rows.flatMap((r) => [r.owner_staff_id, r.done_by]));
    return rows.map((r) => {
      const t = templates.get(r.template_id);
      const ci = checkInsOf(r);
      return {
        id: r.id,
        title: t?.title ?? 'Routine check',
        areaLabel: t?.area_label ?? 'Operations',
        owner: refs.get(r.owner_staff_id)!,
        dueAt: r.due_at.toISOString(),
        state: r.state as RoutineCheck['state'],
        doneAt: r.done_at ? r.done_at.toISOString() : null,
        doneBy: r.done_by ? (refs.get(r.done_by) ?? null) : null,
        note: r.note,
        checkedIn: ci.required.length > 1 ? { done: ci.done.filter((d) => ci.required.includes(d)).length, total: ci.required.length } : null,
      };
    });
  }

  /** Today's checks (generated on first read); `mine` keeps the caller's own and their roles' checks */
  async today(v?: Viewer, opts: { mine?: boolean } = {}): Promise<RoutineDay> {
    const date = this.core.today();
    let rows = await this.repo.checksOn(date);
    if (!rows.length) {
      await this.generate(date);
      rows = await this.repo.checksOn(date);
    }
    if (v && opts.mine) {
      const templates = new Map((await this.repo.listTemplates()).map((t) => [t.id, t]));
      rows = rows.filter((r) => r.owner_staff_id === v.staffId || checkInsOf(r).required.includes(v.staffId) || ((templates.get(r.template_id)?.owner_roles ?? []) as string[]).some((role) => v.roles.includes(role)));
    }
    const checks = await this.#views(rows);
    return { date, checks, done: checks.filter((c) => c.state === 'done').length, total: checks.length };
  }

  async complete(v: Viewer, id: string, note: string | null | undefined, by: By): Promise<RoutineCheck> {
    await this.core.ensureSeeded();
    const text = note?.trim() || null;
    const row = await this.repo.transaction(async (tx) => {
      const r = await tx.getCheck(id, { forUpdate: true });
      if (!r) throw new AppError('NOT_FOUND', 'Routine check not found');
      const ci = checkInsOf(r);
      const now = this.core.now();
      const notes = text ? [r.note, `${by.actor.name ?? 'Staff'}: ${text}`].filter(Boolean).join('\n') : r.note;
      if (ci.required.length > 1) {
        // shared check: each manager checks in; done when everyone has
        routineCheckMachine.next(r.state as never, 'complete');
        const done = ci.done.includes(v.staffId) ? ci.done : [...ci.done, v.staffId];
        const all = ci.required.every((x) => done.includes(x));
        const state = all ? routineCheckMachine.next(r.state as never, 'complete') : r.state === 'not_done' ? routineCheckMachine.next('not_done', 'start') : r.state;
        return tx.updateCheck(r.id, { check_ins: { ...ci, done } as never, state, note: notes, ...(all ? { done_at: now, done_by: v.staffId } : {}) });
      }
      const state = routineCheckMachine.next(r.state as never, 'complete');
      return tx.updateCheck(r.id, { state, done_at: now, done_by: v.staffId, note: notes });
    });
    return (await this.#views([row]))[0]!;
  }
}
