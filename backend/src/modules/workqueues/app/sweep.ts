/**
 * The deadline engine (job workqueues.deadline-sweep) and the archive job. The sweep moves items to
 * due_soon and overdue, publishes workqueues.item.overdue once per item, escalates along each queue's
 * route and sends new and escalating work to the backup while the lead is away (Core.receiverOf).
 */
import { deadlineState } from '../domain/rules.js';
import type { ItemRow } from '../ports.js';
import { SYSTEM, type Core } from './core.js';
import type { EscalatedEvent, Items } from './items.js';

const BATCH = 200;

export class Sweep {
  constructor(
    private readonly core: Core,
    private readonly items: Items,
  ) {}

  async run(): Promise<{ checked: number; overdue: number; escalated: number }> {
    const core = this.core;
    await core.ensureSeeded();
    const now = core.now();
    const dueSoon = await core.dueSoonMinutes();
    const until = new Date(now.getTime() + dueSoon * 60_000);
    const queues = await core.queueMap();
    let checked = 0;
    let overdue = 0;
    let escalated = 0;

    // deadlines moved later by a refresh: back to on_time
    for (const r of await core.repo.staleDeadlineStates(until)) await core.repo.updateItem(r.id, { deadline_state: 'on_time' });

    let after: { dueAt: Date; id: string } | null = null;
    for (;;) {
      const batch: ItemRow[] = await core.repo.sweepBatch(until, after, BATCH);
      if (!batch.length) break;
      for (const row of batch) {
        checked++;
        const queue = queues.get(row.queue_key);
        // the deadline clock stops while waiting on someone outside the team (resume moves dueAt later)
        if (row.state === 'waiting' && queue?.pause_while_waiting) continue;
        const state = deadlineState(row.due_at, now, dueSoon);
        if (state !== row.deadline_state) {
          await core.repo.updateItem(row.id, { deadline_state: state });
          if (state === 'due_soon') await core.history(row.id, 'due_soon', 'Due soon', SYSTEM);
        }
        if (state !== 'overdue' || !queue) continue;
        // once per item (items can be raised already overdue, so the history is the marker, not the stored state)
        if (!(await core.repo.hasEvent(row.id, 'overdue'))) {
          overdue++;
          await core.history(row.id, 'overdue', 'Passed its deadline', SYSTEM);
          const receiver = await core.receiverOf(queue);
          core.ctx.events.publish(
            'workqueues.item.overdue',
            {
              itemId: row.id,
              queueKey: row.queue_key,
              kind: row.kind,
              subjectRef: row.subject_ref ?? row.ref,
              dueAt: row.due_at.toISOString(),
              leadId: receiver.id,
              backupId: queue.backup_staff_id,
              assigneeId: row.assignee_staff_id,
              sellerId: row.seller_id,
            },
            { actor: SYSTEM },
          );
        }
        const events: EscalatedEvent[] = await this.items.escalateOverdue(row, queue);
        for (const e of events) core.ctx.events.publish('workqueues.item.escalated', e, { actor: SYSTEM });
        escalated += events.length;
      }
      const last = batch.at(-1)!;
      after = { dueAt: last.due_at, id: last.id };
      if (batch.length < BATCH) break;
    }
    return { checked, overdue, escalated };
  }

  /**
   * Resolved and dismissed items older than itemRetentionDays are marked archived (archived_at). Rows,
   * notes and history stay in Postgres: archived items leave the default lists and stay reachable by id
   * and with archived=true. Nothing is deleted.
   */
  async archive(): Promise<number> {
    const core = this.core;
    const days = Number(await core.ctx.settings.get('itemRetentionDays')) || 400;
    const now = core.now();
    const before = new Date(now.getTime() - days * 86_400_000);
    let archived = 0;
    for (let i = 0; i < 1000; i++) {
      const n = await core.repo.archiveClosedBefore(before, now, 500);
      archived += n;
      if (n < 500) break;
    }
    if (archived) core.log.info({ archived }, 'workqueues: archived resolved items');
    return archived;
  }
}
