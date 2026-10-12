/**
 * Work items: raise (create, refresh or reopen on the dedupe key), close from the source, the
 * people actions (assign, claim, start, wait, resume, resolve, dismiss, reopen, escalate, notes),
 * lists and filters, seller tasks and export rows. Escalation steps are applied here for both the
 * sweep job and the manual escalate action.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { Actor, Money, Page } from '../../../spec/common.js';
import type { EscalationStep, SellerTask, WorkItem, WorkItemNote, WorkSubject } from '../../../spec/workqueues.js';
import { ACTIVE_STATES, bump, CLOSED_STATES, DEDUPE_PREFIX_QUEUES, isActive, isArea, KIND_QUEUES, KINDS as ALL_KINDS, priorityRank, PRIORITIES, sellerScreen, type Kind, type Priority } from '../domain/catalog.js';
import type { Link } from '../domain/intake.js';
import { deadlineState, durationLabel, nextStep, parseDuration, stepTarget } from '../domain/rules.js';
import { workItemMachine } from '../domain/state-machines.js';
import type { ItemQuery, ItemRow, ItemSort, Match, QueueRow, WorkqueuesRepository } from '../ports.js';
import { SYSTEM, type By, type Core, type Viewer } from './core.js';

const KINDS = new Set<string>(ALL_KINDS);
const STATES = new Set<string>(['open', 'assigned', 'in_progress', 'waiting', 'resolved', 'dismissed']);
const DEADLINES = new Set<string>(['on_time', 'due_soon', 'overdue']);
const SORTS = new Set<string>(['deadline', 'oldest', 'priority', 'amount']);

const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });
const notFound = () => new AppError('NOT_FOUND', 'Work item not found');
/** Thrown inside a raise transaction when a new item needs a reference after all (taken outside it) */
const NEED_REF = new Error('workqueues: reference needed');

/** What a raise needs (RaiseInput, intake openings and manual tasks) */
export interface RaiseSpec {
  queueKey: string;
  kind: string;
  ownerRole?: string | null;
  title: string;
  summary?: string | null;
  subject: WorkSubject;
  related?: WorkSubject[] | null;
  sellerId?: string | null;
  sellerName?: string | null;
  customerId?: string | null;
  amount?: Money | null;
  dueAt?: string | null;
  priority?: Priority | null;
  dedupeKey: string;
  links?: unknown[] | null;
  visibleToSeller?: boolean | null;
  bumpPriority?: boolean;
  wake?: boolean;
  assigneeId?: string | null;
  source: { module: string; event: string | null; by: Actor };
}

type Receiver = Awaited<ReturnType<Core['receiverOf']>>;

export interface EscalatedEvent {
  itemId: string;
  queueKey: string;
  level: number;
  toKind: 'role' | 'staff';
  to: string;
  reason: string;
}

/** Filters as REST query, saved filter or public listItems filter */
export type FilterInput = Record<string, unknown>;

const arr = (v: unknown): string[] | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x !== '').map((x) => x.toLowerCase());
  if (typeof v === 'string') return v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return undefined;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const bool = (v: unknown): boolean => v === true || v === 'true';

export class Items {
  constructor(private readonly core: Core) {}

  get repo() {
    return this.core.repo;
  }

  /* ================================================================ raise and close */

  /** Create, refresh or reopen the item for a dedupe key. Events are published after the commit. */
  async raise(spec: RaiseSpec): Promise<{ row: ItemRow; created: boolean; queue: QueueRow }> {
    const core = this.core;
    await core.ensureSeeded();
    if (!spec.queueKey) throw invalid('queueKey', 'A queue is required');
    if (!KINDS.has(spec.kind)) throw invalid('kind', `Unknown work item kind ${spec.kind}`);
    if (!spec.dedupeKey?.trim()) throw invalid('dedupeKey', 'A dedupe key is required');
    if (!spec.title?.trim()) throw invalid('title', 'A title is required');
    if (!spec.source.module?.trim()) throw invalid('sourceModule', 'The calling module is required');
    if (spec.priority && !PRIORITIES.includes(spec.priority)) throw invalid('priority', 'Unknown priority');
    if (spec.sellerId && !isUuid(spec.sellerId)) throw invalid('sellerId', 'Not a seller id');
    if (spec.customerId && !isUuid(spec.customerId)) throw invalid('customerId', 'Not a customer id');
    const queue = await this.#queueFor(spec);
    const dueAt = spec.dueAt ? new Date(spec.dueAt) : null;
    if (dueAt && Number.isNaN(dueAt.getTime())) throw invalid('dueAt', 'Not a date-time');
    const now = core.now();
    const dueSoon = await core.dueSoonMinutes();
    const defaultDue = await core.defaultDue(queue, now);
    const receiver = await core.receiverOf(queue);
    const assigneeName = spec.assigneeId ? (await core.staffRef(spec.assigneeId)).name : null;
    // lookups outside the transaction: refs and access use their own connection
    const fresh = !(await this.repo.activeByDedupe(spec.dedupeKey)) && (await this.repo.latestClosedByDedupe(spec.dedupeKey))?.state !== 'dismissed';
    let ref: string | null = fresh ? await core.ctx.refs.next('WQ', { digits: 4 }) : null;

    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.repo.transaction(async (tx) => {
          const existing = await tx.activeByDedupe(spec.dedupeKey, { forUpdate: true });
          if (existing) return { row: await this.#refresh(tx, existing, spec, dueAt, defaultDue, dueSoon), created: false };
          const closed = await tx.latestClosedByDedupe(spec.dedupeKey);
          if (closed?.state === 'dismissed') {
            const due = dueAt ?? defaultDue;
            const row = await tx.updateItem(closed.id, {
              ...this.#content(spec),
              state: workItemMachine.next('dismissed', 'reopen'),
              assignee_staff_id: null,
              waiting_on: null,
              waiting_since: null,
              escalation_level: 0,
              escalated_to: null,
              due_at: due,
              deadline_state: deadlineState(due, now, dueSoon),
              resolved_at: null,
              resolution: null,
              archived_at: null,
              updated_at: now,
            });
            await core.history(row.id, 'reopened_by_source', 'Reopened: the source fired again after it was dismissed', spec.source.by, {}, tx);
            return { row, created: false };
          }
          if (!ref) throw NEED_REF;
          const due = dueAt ?? defaultDue;
          const id = newId();
          const assignee = spec.assigneeId ?? null;
          const row = await tx.insertItem({
            id,
            ref,
            queue_key: queue.key,
            kind: spec.kind,
            ...this.#content(spec),
            subject_type: spec.subject.type,
            subject_id: spec.subject.id,
            subject_ref: spec.subject.ref ?? null,
            subject_label: spec.subject.label ?? null,
            owner_role: spec.ownerRole || queue.owner_role,
            assignee_staff_id: assignee,
            due_at: due,
            deadline_state: deadlineState(due, now, dueSoon),
            priority: spec.priority ?? 'normal',
            state: assignee ? workItemMachine.next('open', 'assign') : workItemMachine.initial,
            waiting_on: null,
            waiting_since: null,
            escalation_level: 0,
            escalated_to: null,
            dedupe_key: spec.dedupeKey,
            source_module: spec.source.module,
            source_event: spec.source.event,
            visible_to_seller: spec.visibleToSeller ?? false,
            opened_at: now,
            updated_at: now,
            resolved_at: null,
            resolution: null,
            archived_at: null,
          } as ItemRow);
          await core.history(id, 'raised', spec.source.event ? `Raised from ${spec.source.event}` : spec.kind === 'manual_task' ? 'Created by hand' : `Raised by ${spec.source.module}`, spec.source.by, {}, tx);
          if (receiver.viaBackup) await core.history(id, 'routed_to_backup', `Routed to the backup ${receiver.backupName} while ${receiver.leadName} is away`, SYSTEM, {}, tx);
          if (assignee) await core.history(id, 'assigned', `Assigned to ${assigneeName}`, spec.source.by, { assigneeId: assignee }, tx);
          return { row, created: true };
        });
        if (res.created) {
          core.ctx.events.publish(
            'workqueues.item.created',
            { itemId: res.row.id, queueKey: queue.key, kind: res.row.kind, subjectType: res.row.subject_type, subjectId: res.row.subject_id, dueAt: res.row.due_at.toISOString(), leadId: receiver.id, sellerId: res.row.seller_id },
            { actor: spec.source.by },
          );
        }
        return { ...res, queue };
      } catch (err) {
        if (err === NEED_REF && attempt < 3) {
          ref = await core.ctx.refs.next('WQ', { digits: 4 });
          continue;
        }
        // two raises of the same key at once: the unique index refuses the second insert (MongoDB duplicate key,
        // which aborts that transaction); run it again and refresh instead
        if (attempt < 3 && (err as { code?: unknown })?.code === 11000) continue;
        throw err;
      }
    }
  }

  /** The queue of a raise: the kind's own queue when it is installed and active (KIND_QUEUES), else the one named */
  async #queueFor(spec: RaiseSpec): Promise<QueueRow> {
    const home = KIND_QUEUES[spec.kind as Kind] ?? DEDUPE_PREFIX_QUEUES.find(([prefix]) => spec.dedupeKey.startsWith(prefix))?.[1];
    if (home && home !== spec.queueKey) {
      const q = await this.repo.getQueue(home);
      if (q?.active) return q;
    }
    const queue = await this.repo.getQueue(spec.queueKey);
    if (!queue) throw invalid('queueKey', `Unknown queue ${spec.queueKey}`);
    return queue;
  }

  #content(spec: RaiseSpec): Partial<ItemRow> {
    const out: Partial<ItemRow> = { title: spec.title.trim() };
    if (spec.summary !== undefined) out.summary = spec.summary ?? null;
    if (spec.related !== undefined) out.related_subjects = (spec.related ?? []) as never;
    else out.related_subjects = [] as never;
    if (spec.sellerId !== undefined) out.seller_id = spec.sellerId ?? null;
    if (spec.sellerName !== undefined) out.seller_name = spec.sellerName ?? null;
    if (spec.customerId !== undefined) out.customer_id = spec.customerId ?? null;
    if (spec.amount !== undefined) {
      out.amount_minor = spec.amount ? spec.amount.amount : null;
      out.currency = spec.amount ? spec.amount.currency : null;
    }
    out.links = (spec.links ?? []) as never;
    return out;
  }

  async #refresh(tx: WorkqueuesRepository, existing: ItemRow, spec: RaiseSpec, dueAt: Date | null, defaultDue: Date, dueSoon: number): Promise<ItemRow> {
    const core = this.core;
    const now = core.now();
    const patch: Partial<ItemRow> = { ...this.#content(spec), updated_at: now };
    if (spec.related === undefined) delete patch.related_subjects;
    if (spec.links === undefined || spec.links === null) delete patch.links;
    let priority = (existing.priority as Priority) ?? 'normal';
    if (spec.priority && priorityRank(spec.priority) > priorityRank(priority)) priority = spec.priority;
    if (spec.bumpPriority) priority = bump(priority);
    patch.priority = priority;
    let label = 'Refreshed by the source';
    if (spec.wake) {
      patch.due_at = defaultDue;
      if (existing.state === 'waiting') {
        patch.state = workItemMachine.next('waiting', 'resume');
        patch.waiting_on = null;
        patch.waiting_since = null;
      }
      label = 'Back for review: the source fired again';
    } else if (dueAt) patch.due_at = dueAt;
    if (patch.due_at) {
      patch.deadline_state = deadlineState(patch.due_at, now, dueSoon);
      // a later deadline restarts the escalation route
      if (patch.due_at.getTime() > existing.due_at.getTime() && patch.deadline_state !== 'overdue') {
        patch.escalation_level = 0;
        patch.escalated_to = null;
      }
    }
    const row = await tx.updateItem(existing.id, patch);
    await core.history(existing.id, 'refreshed', priority !== existing.priority ? `${label}; priority ${priority}` : label, spec.source.by, {}, tx);
    return row;
  }

  /**
   * Close the active items of these kinds about these subjects, or with these dedupe keys (resolvesOn
   * events). With a claim key (ctx.mongo.claim) the claim commits with the closing: a redelivered event changes nothing.
   */
  async closeMatching(kinds: Kind[], matches: Match[], note: string, by: Actor, event: string | null, opts: { dedupeKeys?: string[]; claimKey?: string } = {}): Promise<number> {
    const core = this.core;
    const closed = await this.repo.transaction(async (tx) => {
      if (opts.claimKey && !(await tx.claim(opts.claimKey))) return [];
      const rows = matches.length ? await tx.activeMatching(kinds, matches) : [];
      for (const key of opts.dedupeKeys ?? []) {
        const r = await tx.activeByDedupe(key, { forUpdate: true });
        if (r && (kinds as string[]).includes(r.kind) && !rows.some((x) => x.id === r.id)) rows.push(r);
      }
      for (const r of rows) await this.#close(tx, r, 'fixed_at_source', note, by, event);
      return rows;
    });
    for (const r of closed) core.ctx.events.publish('workqueues.item.resolved', { itemId: r.id, queueKey: r.queue_key, outcome: 'fixed_at_source' }, { actor: by });
    return closed.length;
  }

  async #close(tx: WorkqueuesRepository, r: ItemRow, outcome: 'fixed_at_source' | 'resolved' | 'dismissed', note: string, by: Actor, event: string | null) {
    const now = this.core.now();
    const state = workItemMachine.next(r.state as never, outcome === 'dismissed' ? 'dismiss' : 'resolve');
    const row = await tx.updateItem(r.id, { state, resolved_at: now, resolution: { outcome, note, by } as never, waiting_on: null, waiting_since: null, updated_at: now });
    const label = outcome === 'fixed_at_source' ? (event ? `Fixed at source (${event})` : 'Fixed at source') : outcome === 'dismissed' ? 'Dismissed' : 'Resolved';
    await this.core.history(r.id, outcome, label, by, { text: note }, tx);
    return row;
  }

  /** Public resolveBySource: close the active item of a dedupe key */
  async resolveBySource(dedupeKey: string, outcome: { note: string; by: Actor }): Promise<number> {
    const core = this.core;
    const closed = await this.repo.transaction(async (tx) => {
      const row = await tx.activeByDedupe(dedupeKey, { forUpdate: true });
      if (!row) return null;
      await this.#close(tx, row, 'fixed_at_source', outcome.note, outcome.by, null);
      return row;
    });
    if (!closed) return 0;
    core.ctx.events.publish('workqueues.item.resolved', { itemId: closed.id, queueKey: closed.queue_key, outcome: 'fixed_at_source' }, { actor: outcome.by });
    return 1;
  }

  /* ================================================================ reading */

  /** The item if the caller may see it, else NOT_FOUND */
  async visibleRow(v: Viewer, id: string): Promise<{ row: ItemRow; queue: QueueRow | undefined }> {
    await this.core.ensureSeeded();
    const row = await this.repo.getItem(id);
    if (!row) throw notFound();
    const queue = (await this.repo.getQueue(row.queue_key)) ?? undefined;
    if (!this.core.itemVisible(v, row, queue)) throw notFound();
    return { row, queue };
  }

  async get(v: Viewer, id: string): Promise<WorkItem> {
    const { row } = await this.visibleRow(v, id);
    return this.core.workItem(row);
  }

  /** Filters (REST query, saved filter or public filter) → repository query */
  async toQuery(v: Viewer | null, f: FilterInput, queues: QueueRow[]): Promise<{ query: ItemQuery; sort: ItemSort }> {
    const core = this.core;
    const now = core.now();
    const query: ItemQuery = { now, visibility: v ? core.visibility(v, queues) : null };
    const queueKeys = arr(f.queueKeys) ?? arr(f.queueKey);
    const areas = arr(f.areas) ?? arr(f.area);
    if (areas) for (const a of areas) if (!isArea(a)) throw invalid('area', `Unknown area ${a}`);
    if (queueKeys || areas) {
      let keys = queues.map((q) => q.key);
      if (queueKeys) keys = keys.filter((k) => queueKeys.includes(k.toLowerCase()));
      if (areas) keys = keys.filter((k) => areas.includes(queues.find((q) => q.key === k)!.area));
      query.queueKeys = keys;
    }
    const kinds = arr(f.kinds) ?? arr(f.kind);
    if (kinds) {
      for (const k of kinds) if (!KINDS.has(k)) throw invalid('kind', `Unknown kind ${k}`);
      query.kinds = kinds;
    }
    const states = arr(f.states) ?? arr(f.state);
    if (states) {
      const out = new Set<string>();
      for (const s of states) {
        if (s === 'active') ACTIVE_STATES.forEach((x) => out.add(x));
        else if (STATES.has(s)) out.add(s);
        else throw invalid('state', `Unknown state ${s}`);
      }
      query.states = [...out];
    } else query.states = [...ACTIVE_STATES];
    const deadline = arr(f.deadline);
    if (deadline) {
      for (const d of deadline) if (!DEADLINES.has(d)) throw invalid('deadline', `Unknown deadline state ${d}`);
      query.deadlineStates = deadline;
    }
    if (bool(f.overdueOnly)) query.deadlineStates = ['overdue'];
    const over = f.overdueOverMinutes !== undefined && f.overdueOverMinutes !== null ? parseDuration(f.overdueOverMinutes as number) : parseDuration(f.overdueOver as string);
    if ((f.overdueOverMinutes !== undefined && f.overdueOverMinutes !== null) || f.overdueOver) {
      if (over === null) throw invalid('overdueOver', 'Use minutes or a duration like 24h');
      query.overdueOverMinutes = over;
    }
    const assignee = str(f.assignee);
    if (bool(f.assignedToMe) || assignee === 'me') {
      if (!v) throw invalid('assignee', 'assignee=me needs a staff caller');
      query.assignee = { kind: 'staff', id: v.staffId };
    } else if (assignee === 'unassigned') query.assignee = { kind: 'unassigned' };
    else if (assignee) {
      if (!isUuid(assignee)) throw invalid('assignee', 'Use me, unassigned or a staff id');
      query.assignee = { kind: 'staff', id: assignee };
    }
    const sellerId = str(f.sellerId);
    if (sellerId) {
      if (!isUuid(sellerId)) throw invalid('sellerId', 'Not a seller id');
      query.sellerId = sellerId;
    }
    const sellerKind = str(f.sellerKind)?.toLowerCase();
    if (sellerKind) {
      if (sellerKind !== 'official' && sellerKind !== 'marketplace') throw invalid('sellerKind', 'Use official or marketplace');
      query.sellerKind = sellerKind;
    }
    const subjectRef = str(f.subjectRef);
    if (subjectRef) query.subjectRef = subjectRef;
    const search = str(f.q) ?? str(f.search);
    if (search) query.search = search;
    // archived items (resolved more than itemRetentionDays ago) only with archived=true
    if (bool(f.archived)) {
      query.archived = true;
      if (!states) query.states = [...CLOSED_STATES];
    } else query.archived = false;
    const sort = str(f.sort)?.toLowerCase() ?? 'deadline';
    if (!SORTS.has(sort)) throw invalid('sort', 'Use deadline, oldest, priority or amount');
    return { query, sort: sort as ItemSort };
  }

  async list(v: Viewer, f: FilterInput, page: PageRequest): Promise<Page<WorkItem>> {
    const core = this.core;
    await core.ensureSeeded();
    let filters = f;
    const savedId = str(f.savedFilterId);
    if (savedId) {
      const saved = await this.repo.getSavedFilter(savedId);
      if (!saved || (saved.owner_staff_id !== v.staffId && !saved.shared)) throw new AppError('NOT_FOUND', 'Saved filter not found');
      if (saved.target !== 'work_items') throw invalid('savedFilterId', 'This saved filter belongs to another screen');
      const explicit = Object.fromEntries(Object.entries(f).filter(([k, val]) => k !== 'savedFilterId' && val !== undefined));
      filters = { ...((saved.filters ?? {}) as FilterInput), ...explicit };
    }
    const queues = await this.repo.listQueues();
    const { query, sort } = await this.toQuery(v, filters, queues);
    const res = await this.repo.listItems(query, page, sort);
    return { ...res, items: await core.workItems(res.items, new Map(queues.map((q) => [q.key, q]))) };
  }

  async count(v: Viewer, f: FilterInput): Promise<number | null> {
    try {
      const queues = await this.repo.listQueues();
      const { query } = await this.toQuery(v, f, queues);
      return this.repo.countItems(query);
    } catch (err) {
      if (isAppError(err) && err.code === 'VALIDATION_FAILED') return null;
      throw err;
    }
  }

  /** Open items about a subject (detail pages, seller 360) */
  async forSubject(subjectType: string, subjectId: string): Promise<WorkItem[]> {
    await this.core.ensureSeeded();
    return this.core.workItems(await this.repo.itemsAbout(subjectType, subjectId, { activeOnly: true }));
  }

  /* ================================================================ seller tasks */

  async sellerTasks(sellerId: string, state: 'open' | 'resolved' | undefined, page: PageRequest): Promise<Page<SellerTask>> {
    const res = await this.repo.listItems(
      { sellerId, visibleToSeller: true, archived: false, states: state === 'resolved' ? ['resolved'] : state === 'open' ? [...ACTIVE_STATES] : [...ACTIVE_STATES, 'resolved'], now: this.core.now() },
      page,
      'deadline',
    );
    const dueSoon = await this.core.dueSoonMinutes();
    const now = this.core.now();
    return {
      ...res,
      items: res.items.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        summary: r.summary,
        subject: { type: r.subject_type as WorkSubject['type'], id: r.subject_id, ref: r.subject_ref, label: r.subject_label },
        deadline: { dueAt: r.due_at.toISOString(), state: isActive(r.state) ? deadlineState(r.due_at, now, dueSoon) : (r.deadline_state as 'on_time') },
        screen: sellerScreen(r.kind),
        state: r.state === 'in_progress' ? 'in_progress' : r.state === 'waiting' ? 'waiting' : r.state === 'resolved' || r.state === 'dismissed' ? 'resolved' : 'open',
      })),
    };
  }

  /* ================================================================ people actions */

  async #mutate(v: Viewer, id: string, fn: (tx: WorkqueuesRepository, row: ItemRow, queue: QueueRow | undefined) => Promise<ItemRow>): Promise<{ before: ItemRow; after: ItemRow; queue: QueueRow | undefined }> {
    const { queue } = await this.visibleRow(v, id);
    return this.repo.transaction(async (tx) => {
      const before = await tx.getItem(id, { forUpdate: true });
      if (!before) throw notFound();
      const after = await fn(tx, before, queue);
      return { before, after, queue };
    });
  }

  /** The assignee holds the queue's or the item's owner role, or leads or backs up the queue */
  async #eligible(assigneeId: string, row: ItemRow, queue: QueueRow | undefined): Promise<boolean> {
    if (queue && (queue.lead_staff_id === assigneeId || queue.backup_staff_id === assigneeId)) return true;
    const roles = await this.core.rolesOf(assigneeId);
    return roles.includes(row.owner_role) || Boolean(queue && roles.includes(queue.owner_role));
  }

  async assign(v: Viewer, id: string, body: { assigneeId: string; nextAction?: string | null }, by: By): Promise<WorkItem> {
    if (body.assigneeId !== v.staffId && !(await v.can('workqueues.items.assign-others'))) {
      throw new AppError('FORBIDDEN', 'Assigning work to someone else needs workqueues.items.assign-others', { permission: 'workqueues.items.assign-others' });
    }
    const { row: current, queue } = await this.visibleRow(v, id);
    workItemMachine.next(current.state as never, 'assign');
    if (!(await this.#eligible(body.assigneeId, current, queue))) throw new AppError('ASSIGNEE_NOT_ELIGIBLE', 'This person does not hold the queue role and is not its lead or backup');
    const who = await this.core.staffRef(body.assigneeId);
    const { before, after } = await this.#mutate(v, id, async (tx, row) => {
      const state = workItemMachine.next(row.state as never, 'assign');
      const next = await tx.updateItem(row.id, { state, assignee_staff_id: body.assigneeId, updated_at: this.core.now() });
      await this.core.history(row.id, 'assigned', `Assigned to ${who.name}`, by.actor, { text: body.nextAction ?? null, assigneeId: body.assigneeId }, tx);
      return next;
    });
    this.core.ctx.events.publish('workqueues.item.assigned', { itemId: id, assigneeId: body.assigneeId, queueKey: after.queue_key }, by);
    await this.core.audit({ action: 'workqueues.item.assign', actionLabel: 'Assigned work item', target: { type: 'work_item', id, ref: after.ref, label: after.title }, before: { assigneeId: before.assignee_staff_id, state: before.state }, after: { assigneeId: after.assignee_staff_id, state: after.state, nextAction: body.nextAction ?? null } }, by);
    return this.core.workItem(after);
  }

  bulkAssign = async (v: Viewer, body: { itemIds: string[]; assigneeId: string; nextAction?: string | null }, by: By): Promise<{ assigned: number; skipped: unknown[] }> => {
    const skipped: { itemId: string; reason: string; code: string }[] = [];
    let assigned = 0;
    for (const itemId of [...new Set(body.itemIds)]) {
      try {
        await this.assign(v, itemId, { assigneeId: body.assigneeId, nextAction: body.nextAction }, { ...by, requestId: by.requestId });
        assigned++;
      } catch (err) {
        if (!isAppError(err) || err.status >= 500) throw err;
        skipped.push({ itemId, code: err.code, reason: err.message });
      }
    }
    return { assigned, skipped };
  };

  async claim(v: Viewer, id: string, by: By): Promise<WorkItem> {
    const { row: current } = await this.visibleRow(v, id);
    const holder = current.assignee_staff_id ? await this.core.staffRef(current.assignee_staff_id) : null;
    const me = by.actor.name ?? (await this.core.staffRef(v.staffId)).name;
    const { after } = await this.#mutate(v, id, async (tx, row) => {
      if (row.assignee_staff_id && row.assignee_staff_id !== v.staffId && row.state !== 'open') {
        throw new AppError('CONFLICT', `Already assigned to ${holder?.staffId === row.assignee_staff_id ? holder.name : 'someone else'}`, { assigneeId: row.assignee_staff_id });
      }
      const assignedState = workItemMachine.next(row.state as never, 'assign');
      // open and assigned items start; in-progress and waiting items keep their state with the new holder
      const state = assignedState === 'assigned' ? workItemMachine.next(assignedState, 'start') : assignedState;
      const next = await tx.updateItem(row.id, { state, assignee_staff_id: v.staffId, updated_at: this.core.now() });
      await this.core.history(row.id, 'claimed', `Claimed by ${me} and started`, by.actor, { assigneeId: v.staffId }, tx);
      return next;
    });
    this.core.ctx.events.publish('workqueues.item.assigned', { itemId: id, assigneeId: v.staffId, queueKey: after.queue_key }, by);
    return this.core.workItem(after);
  }

  async start(v: Viewer, id: string, by: By): Promise<WorkItem> {
    const { before, after } = await this.#mutate(v, id, async (tx, row) => {
      const state = workItemMachine.next(row.state as never, 'start');
      const next = await tx.updateItem(row.id, { state, assignee_staff_id: row.assignee_staff_id ?? v.staffId, updated_at: this.core.now() });
      await this.core.history(row.id, 'started', 'Work started', by.actor, {}, tx);
      return next;
    });
    if (!before.assignee_staff_id) this.core.ctx.events.publish('workqueues.item.assigned', { itemId: id, assigneeId: v.staffId, queueKey: after.queue_key }, by);
    return this.core.workItem(after);
  }

  async wait(v: Viewer, id: string, body: { waitingOn: NonNullable<WorkItem['waitingOn']>; note: string; followUpAt?: string | null }, by: By): Promise<WorkItem> {
    if (!body.note?.trim()) throw invalid('note', 'Say what you are waiting for');
    if (body.followUpAt && Number.isNaN(new Date(body.followUpAt).getTime())) throw invalid('followUpAt', 'Not a date-time');
    const author = await this.#authorName(by.actor);
    const { after } = await this.#mutate(v, id, async (tx, row) => {
      const state = workItemMachine.next(row.state as never, 'wait');
      const next = await tx.updateItem(row.id, { state, waiting_on: body.waitingOn, waiting_since: this.core.now(), updated_at: this.core.now() });
      await this.#note(tx, row.id, body.note.trim(), by.actor, author);
      await this.core.history(row.id, 'waiting', `Waiting on ${body.waitingOn}`, by.actor, { text: body.followUpAt ? `${body.note.trim()} (follow up ${body.followUpAt})` : body.note.trim(), followUpAt: body.followUpAt ?? null }, tx);
      return next;
    });
    return this.core.workItem(after);
  }

  async resume(v: Viewer, id: string, by: By): Promise<WorkItem> {
    const now = this.core.now();
    const dueSoon = await this.core.dueSoonMinutes();
    const { after } = await this.#mutate(v, id, async (tx, row, queue) => {
      const state = workItemMachine.next(row.state as never, 'resume');
      const patch: Partial<ItemRow> = { state, waiting_on: null, waiting_since: null, updated_at: now };
      let label = 'Back in progress';
      // the queue pauses the deadline clock while waiting: the deadline moves later by the time spent waiting
      const waited = row.waiting_since ? now.getTime() - new Date(row.waiting_since).getTime() : 0;
      if (queue?.pause_while_waiting && waited > 0) {
        patch.due_at = new Date(row.due_at.getTime() + waited);
        patch.deadline_state = deadlineState(patch.due_at, now, dueSoon);
        label = `Back in progress; deadline moved ${durationLabel(Math.max(1, Math.round(waited / 60_000)))} later (paused while waiting)`;
      }
      const next = await tx.updateItem(row.id, patch);
      await this.core.history(row.id, 'resumed', label, by.actor, patch.due_at ? { dueAt: patch.due_at.toISOString() } : {}, tx);
      return next;
    });
    return this.core.workItem(after);
  }

  async resolve(v: Viewer, id: string, note: string, by: By, outcome: 'resolved' | 'dismissed'): Promise<WorkItem> {
    if (!note?.trim()) throw invalid(outcome === 'resolved' ? 'note' : 'reason', outcome === 'resolved' ? 'A note is required to resolve by hand' : 'A reason is required to dismiss');
    const { before, after } = await this.#mutate(v, id, (tx, row) => this.#close(tx, row, outcome, note.trim(), by.actor, null));
    this.core.ctx.events.publish('workqueues.item.resolved', { itemId: id, queueKey: after.queue_key, outcome }, by);
    await this.core.audit(
      { action: `workqueues.item.${outcome === 'resolved' ? 'resolve' : 'dismiss'}`, actionLabel: outcome === 'resolved' ? 'Resolved work item' : 'Dismissed work item', target: { type: 'work_item', id, ref: after.ref, label: after.title }, reason: note.trim(), before: { state: before.state }, after: { state: after.state } },
      by,
    );
    return this.core.workItem(after);
  }

  async reopen(v: Viewer, id: string, reason: string, by: By): Promise<WorkItem> {
    if (!reason?.trim()) throw invalid('reason', 'A reason is required to reopen');
    const now = this.core.now();
    const dueSoon = await this.core.dueSoonMinutes();
    const { before, after } = await this.#mutate(v, id, async (tx, row) => {
      const state = workItemMachine.next(row.state as never, 'reopen');
      const other = await tx.activeByDedupe(row.dedupe_key);
      if (other && other.id !== row.id) throw new AppError('CONFLICT', `${other.ref} is already open for the same source`, { itemId: other.id });
      const next = await tx.updateItem(row.id, { state, assignee_staff_id: null, waiting_on: null, waiting_since: null, resolved_at: null, resolution: null, archived_at: null, deadline_state: deadlineState(row.due_at, now, dueSoon), updated_at: now });
      await this.core.history(row.id, 'reopened', 'Reopened', by.actor, { text: reason.trim() }, tx);
      return next;
    });
    await this.core.audit({ action: 'workqueues.item.reopen', actionLabel: 'Reopened work item', target: { type: 'work_item', id, ref: after.ref, label: after.title }, reason: reason.trim(), before: { state: before.state, resolution: before.resolution }, after: { state: after.state } }, by);
    return this.core.workItem(after);
  }

  async escalateNow(v: Viewer, id: string, reason: string, by: By): Promise<WorkItem> {
    if (!reason?.trim()) throw invalid('reason', 'A reason is required to escalate');
    let event: EscalatedEvent | null = null;
    const { queue: q } = await this.visibleRow(v, id);
    const receiver = q ? await this.core.receiverOf(q) : null;
    const { before, after } = await this.#mutate(v, id, async (tx, row, queue) => {
      if (!isActive(row.state)) throw new AppError('ILLEGAL_TRANSITION', 'Only open work can be escalated', { from: row.state, event: 'escalate' });
      const route = (queue?.escalation_route ?? []) as unknown as EscalationStep[];
      const next = nextStep(route, row.escalation_level, this.#conditionSubject(row));
      if (!next || !queue || !receiver) throw new AppError('ESCALATION_ROUTE_END', 'This item is already at the last step of its escalation route');
      const res = await this.applyEscalation(tx, row, queue, next, reason.trim(), by.actor, receiver);
      event = res.event;
      return res.row;
    });
    if (event) this.core.ctx.events.publish('workqueues.item.escalated', event, by);
    await this.core.audit({ action: 'workqueues.item.escalate', actionLabel: 'Escalated work item', target: { type: 'work_item', id, ref: after.ref, label: after.title }, reason: reason.trim(), before: { escalationLevel: before.escalation_level, escalatedTo: before.escalated_to }, after: { escalationLevel: after.escalation_level, escalatedTo: after.escalated_to } }, by);
    return this.core.workItem(after);
  }

  #conditionSubject(row: ItemRow) {
    return { sellerId: row.seller_id, amountMinor: row.amount_minor === null ? null : Math.abs(Number(row.amount_minor)), priority: row.priority };
  }

  /** Move an item to a step of its queue's route; the event is returned for publishing after the commit (null when the step does not notify). `receiver` is read before the transaction. */
  async applyEscalation(tx: WorkqueuesRepository, row: ItemRow, queue: QueueRow, next: { step: EscalationStep; level: number }, reason: string, by: Actor, receiver: Receiver): Promise<{ row: ItemRow; event: EscalatedEvent | null }> {
    const target = stepTarget(next.step)!;
    const kind: 'role' | 'staff' = target.kind === 'role' ? 'role' : 'staff';
    let to = target.id;
    let name = target.name;
    // a step to the queue's lead goes to the backup while the lead is away
    if (kind === 'staff' && to === queue.lead_staff_id && receiver.viaBackup) {
      to = receiver.id;
      name = `${receiver.backupName} (covering for ${receiver.leadName})`;
    }
    const updated = await tx.updateItem(row.id, { escalation_level: next.level, escalated_to: `${kind}:${to}`, updated_at: this.core.now() });
    await this.core.history(row.id, 'escalated', `Escalated to ${name} (step ${next.level})`, by, { text: reason, to: `${kind}:${to}` }, tx);
    return { row: updated, event: next.step.notify ? { itemId: row.id, queueKey: queue.key, level: next.level, toKind: kind, to, reason } : null };
  }

  /** Steps reached while overdue (sweep): every step whose time has come, one event each */
  async escalateOverdue(row: ItemRow, queue: QueueRow): Promise<EscalatedEvent[]> {
    const now = this.core.now();
    const overdueMinutes = Math.floor((now.getTime() - row.due_at.getTime()) / 60_000);
    const route = (queue.escalation_route ?? []) as unknown as EscalationStep[];
    if (!nextStep(route, row.escalation_level, this.#conditionSubject(row), overdueMinutes)) return [];
    const receiver = await this.core.receiverOf(queue);
    return this.repo.transaction(async (tx) => {
      let current = await tx.getItem(row.id, { forUpdate: true });
      const events: EscalatedEvent[] = [];
      while (current && isActive(current.state)) {
        const next = nextStep(route, current.escalation_level, this.#conditionSubject(current), overdueMinutes);
        if (!next) break;
        const res = await this.applyEscalation(tx, current, queue, next, `Overdue by ${durationLabel(Math.max(1, overdueMinutes))}`, SYSTEM, receiver);
        current = res.row;
        if (res.event) events.push(res.event);
      }
      return events;
    });
  }

  /** Display name of whoever writes a note (read before a transaction) */
  async #authorName(actor: Actor): Promise<string> {
    return actor.name ?? (actor.id ? (await this.core.staffRef(actor.id)).name : 'Staff member');
  }

  async #note(tx: WorkqueuesRepository, itemId: string, body: string, actor: Actor, authorName: string): Promise<WorkItemNote> {
    const row = { id: newId(), item_id: itemId, body, author_id: actor.kind === 'staff' && actor.id ? actor.id : `system:${actor.name ?? actor.kind}`, author_name: authorName, at: this.core.now() };
    await tx.insertNote(row);
    return this.core.note(row);
  }

  async addNote(v: Viewer, id: string, body: string, by: By): Promise<WorkItemNote> {
    if (!body?.trim()) throw invalid('body', 'The note is empty');
    const { row } = await this.visibleRow(v, id);
    const author = await this.#authorName(by.actor);
    return this.repo.transaction(async (tx) => {
      const note = await this.#note(tx, row.id, body.trim(), by.actor, author);
      await this.core.history(row.id, 'note', 'Note added', by.actor, {}, tx);
      await tx.updateItem(row.id, { updated_at: this.core.now() });
      return note;
    });
  }

  /* ================================================================ manual tasks */

  async createManual(v: Viewer, input: { queueKey: string; title: string; summary?: string | null; subject?: WorkSubject | null; assigneeId?: string | null; dueAt: string; priority?: Priority | null }, by: By): Promise<WorkItem> {
    await this.core.ensureSeeded();
    const queue = await this.repo.getQueue(input.queueKey);
    if (!queue || !queue.active) throw invalid('queueKey', `Unknown queue ${input.queueKey}`);
    if (!this.core.queueVisible(v, queue)) throw new AppError('FORBIDDEN', 'You can only add tasks to queues you work in');
    if (!input.title?.trim()) throw invalid('title', 'A title is required');
    if (input.assigneeId) {
      if (input.assigneeId !== v.staffId && !(await v.can('workqueues.items.assign-others'))) throw new AppError('FORBIDDEN', 'Assigning work to someone else needs workqueues.items.assign-others', { permission: 'workqueues.items.assign-others' });
      const probe = { owner_role: queue.owner_role } as ItemRow;
      if (!(await this.#eligible(input.assigneeId, probe, queue))) throw new AppError('ASSIGNEE_NOT_ELIGIBLE', 'This person does not hold the queue role and is not its lead or backup');
    }
    const id = newId();
    const subject: WorkSubject = input.subject ?? { type: 'other', id, label: 'Task' };
    const { row } = await this.raise({
      queueKey: queue.key,
      kind: 'manual_task',
      title: input.title,
      summary: input.summary ?? null,
      subject,
      dueAt: input.dueAt,
      priority: input.priority ?? 'normal',
      dedupeKey: `manual:${id}`,
      links: [{ label: 'Open queue', screen: queue.screen, ...(queue.screen_filter ? { state: queue.screen_filter } : {}) } satisfies Link],
      assigneeId: input.assigneeId ?? null,
      source: { module: 'workqueues', event: null, by: by.actor },
    });
    if (input.assigneeId) this.core.ctx.events.publish('workqueues.item.assigned', { itemId: row.id, assigneeId: input.assigneeId, queueKey: row.queue_key }, by);
    return this.core.workItem(row);
  }

  /* ================================================================ exports */

  async exportRows(v: Viewer, filters: unknown, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    const queues = await this.repo.listQueues();
    const f = filters && typeof filters === 'object' ? (filters as FilterInput) : {};
    const { query } = await this.toQuery(v, { state: f.state ?? f.states ?? ['open', 'assigned', 'in_progress', 'waiting', 'resolved', 'dismissed'], ...f }, queues);
    let after: { openedAt: string; id: string } | null = null;
    if (cursor) {
      try {
        after = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      } catch {
        throw invalid('cursor', 'Not a cursor from this export');
      }
    }
    const LIMIT = 500;
    const rows = await this.repo.scanItems(query, after, LIMIT);
    const items = await this.core.workItems(rows, new Map(queues.map((q) => [q.key, q])));
    const last = rows.at(-1);
    return {
      rows: items.map((i) => ({
        ref: i.ref,
        queue: i.queueName,
        area: i.area,
        kind: i.kind,
        title: i.title,
        subjectType: i.subject.type,
        subjectRef: i.subject.ref ?? i.subject.id,
        sellerId: i.sellerId ?? null,
        amount: i.amount ? i.amount.amount / 100 : null,
        currency: i.amount?.currency ?? null,
        priority: i.priority,
        state: i.state,
        assignee: i.assignee?.name ?? null,
        lead: i.lead.name,
        dueAt: i.deadline.dueAt,
        deadlineState: i.deadline.state,
        escalationLevel: i.escalationLevel,
        openedAt: i.openedAt,
        resolvedAt: i.resolvedAt ?? null,
        outcome: (i.resolution as { outcome?: string } | null)?.outcome ?? null,
      })),
      ...(rows.length === LIMIT && last ? { nextCursor: Buffer.from(JSON.stringify({ openedAt: last.opened_at.toISOString(), id: last.id })).toString('base64url') } : {}),
    };
  }
}
