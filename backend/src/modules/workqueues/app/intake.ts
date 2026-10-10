/**
 * Runs the intake table (domain/intake.ts) for consumed events: closes the items the event fixes,
 * raises the items it opens (idempotent on the dedupe key) and performs the routing effects of
 * access events. Consumers never fail for records they don't know: problems are logged.
 */
import { isAppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import type { Actor } from '../../../spec/common.js';
import { SYSTEM_UPDATED_BY } from '../domain/catalog.js';
import { INTAKE, type Consumed, type IntakeEntry, type Match } from '../domain/intake.js';
import { coverageGaps } from '../domain/rules.js';
import type { ItemRow, QueueRow } from '../ports.js';
import { SYSTEM, type Core } from './core.js';
import type { Items } from './items.js';

export class Intake {
  constructor(
    private readonly core: Core,
    private readonly items: Items,
  ) {}

  /** Run the table for one event. `eventId` (the envelope id) makes the closing idempotent through ctx.inbox. */
  async handle<N extends Consumed>(name: N, payload: EventPayload<N>, eventId?: string): Promise<void> {
    const core = this.core;
    await core.ensureSeeded();
    const entry = INTAKE[name] as unknown as IntakeEntry<EventPayload<N>>;
    const module = name.split('.')[0]!;
    const by: Actor = { kind: 'system', name: module };

    for (const c of entry.closes ?? []) {
      const matches = c.subjects(payload).filter((m): m is Match => Boolean(m));
      const dedupeKeys = (c.dedupeKeys?.(payload) ?? []).filter((k): k is string => Boolean(k));
      if (!matches.length && !dedupeKeys.length) continue;
      const n = await this.items.closeMatching(c.kinds, matches, c.note(payload), by, name, { dedupeKeys, ...(eventId ? { claimKey: `${name}:${eventId}:${c.kinds.join(',')}` } : {}) });
      if (n) core.log.debug({ event: name, closed: n }, 'workqueues: items fixed at source');
    }

    for (const o of entry.opens ?? []) {
      for (const spec of o.build(payload)) {
        if (!spec) continue;
        try {
          await this.items.raise({ ...spec, kind: o.kind, source: { module, event: name, by } });
        } catch (err) {
          if (!isAppError(err) || err.status >= 500) throw err;
          core.log.warn({ err, event: name, dedupeKey: spec.dedupeKey }, 'workqueues: could not raise a work item from an event; skipped');
        }
      }
    }

    switch (entry.effect) {
      case 'awayStarted':
        return this.#awayStarted(payload as EventPayload<'access.away.started'>);
      case 'awayEnded':
        return this.#awayEnded(payload as EventPayload<'access.away.ended'>);
      case 'coverageChanged':
        return this.#coverageChanged(payload as EventPayload<'access.coverage.changed'>);
    }
  }

  /** Open, unassigned items of the queues someone leads (routing notes on away start and end) */
  async #unassignedOfQueues(queues: QueueRow[]): Promise<ItemRow[]> {
    if (!queues.length) return [];
    return this.core.repo.scanItems({ queueKeys: queues.map((q) => q.key), states: ['open'], assignee: { kind: 'unassigned' } }, null, 500);
  }

  /** New and escalating items of the absent lead's queues go to the backup (receiverOf reads the away state live) */
  async #awayStarted(p: EventPayload<'access.away.started'>) {
    const core = this.core;
    core.invalidateStaff();
    const led = (await core.repo.listQueues()).filter((q) => q.active && q.lead_staff_id === p.accountId);
    for (const q of led) {
      const r = await core.receiverOf(q);
      const label = r.viaBackup ? `${r.leadName} is away until ${p.until}; new and escalating work goes to the backup ${r.backupName}` : `${r.leadName} is away until ${p.until}; no backup is available to cover`;
      for (const item of await this.#unassignedOfQueues([q])) await core.history(item.id, 'routed_to_backup', label, SYSTEM);
      if (!r.viaBackup) core.log.warn({ queueKey: q.key }, 'workqueues: the lead is away and the backup cannot cover');
    }
  }

  /** Routing returns to the lead; items stay with whoever holds them */
  async #awayEnded(p: EventPayload<'access.away.ended'>) {
    const core = this.core;
    core.invalidateStaff();
    const led = (await core.repo.listQueues()).filter((q) => q.active && q.lead_staff_id === p.accountId);
    if (!led.length) return;
    const name = (await core.staffRef(p.accountId)).name;
    for (const item of await this.#unassignedOfQueues(led)) await core.history(item.id, 'lead_returned', `${name} is back; new work goes to the lead again`, SYSTEM);
  }

  /** Queues whose lead and backup follow access (never set by hand) take the role's new lead and backup */
  async #coverageChanged(p: EventPayload<'access.coverage.changed'>) {
    const core = this.core;
    core.invalidateStaff();
    const queues = (await core.repo.listQueues()).filter((q) => q.owner_role === p.roleKey && q.updated_by === SYSTEM_UPDATED_BY);
    if (queues.length) {
      const cov = (await core.coverage()).find((c) => c.role.key === p.roleKey);
      const lead = cov?.lead?.accountId ?? p.leadAccountId ?? null;
      const backup = cov?.backups.find((b) => b.accountId !== lead)?.accountId ?? null;
      for (const q of queues) {
        const patch: Partial<QueueRow> = {};
        if (lead && lead !== q.lead_staff_id && lead !== (backup ?? q.backup_staff_id)) patch.lead_staff_id = lead;
        if (backup && backup !== q.backup_staff_id && backup !== (patch.lead_staff_id ?? q.lead_staff_id)) patch.backup_staff_id = backup;
        if (!Object.keys(patch).length) continue;
        const after = await core.repo.updateQueue(q.key, { ...patch, updated_at: core.now() });
        core.ctx.events.publish('workqueues.queue.changed', { queueKey: q.key, leadId: after.lead_staff_id, backupId: after.backup_staff_id }, { actor: SYSTEM });
      }
    }
    // re-run coverage gaps: log what still needs people
    const all = await core.repo.listQueues();
    const info = await core.staffInfo(all.flatMap((q) => [q.lead_staff_id, q.backup_staff_id]));
    const gaps = coverageGaps(
      all.map((q) => ({ key: q.key, name: q.name, leadId: q.lead_staff_id, backupId: q.backup_staff_id, active: q.active })),
      info,
    );
    if (gaps.length) core.log.info({ roleKey: p.roleKey, gaps: gaps.length }, 'workqueues: queues with coverage gaps');
  }
}
