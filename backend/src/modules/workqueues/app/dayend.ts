/**
 * The day-end review: built before dayEndReviewTime from open items and other modules' forecasts,
 * checked item by item (a note is required where overdue work is still open), completed (the summary
 * goes to the shared roles on completion: workqueues.day_end.completed; the prepare job only sends
 * workqueues.day_end.prepared as a reminder while the review is still open), or marked missed at the end
 * of the market day (then listed on the next day's review). The close job also snapshots daily_counts.
 */
import { format as formatMoney, money as moneyOf } from '../../../kernel/lib/money.js';
import { AppError } from '../../../kernel/errors/index.js';
import { zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { Page } from '../../../spec/common.js';
import type { DayEndItem, DayEndReview } from '../../../spec/workqueues.js';
import { ACTIVE_STATES } from '../domain/catalog.js';
import { addDays, median } from '../domain/rules.js';
import { dayEndReviewMachine } from '../domain/state-machines.js';
import type { DayEndReviewRow } from '../ports.js';
import { SYSTEM, type By, type Core, type Viewer } from './core.js';

type Key = DayEndItem['key'];

const ACTIVE = [...ACTIVE_STATES];
const DISPATCH_KINDS = ['overdue_dispatch', 'missing_tracking', 'seller_cannot_fulfill'];

export class DayEnd {
  constructor(private readonly core: Core) {}

  get repo() {
    return this.core.repo;
  }

  /* ---------------------------------------------------------------- building */

  async #optional<T>(what: string, fn: () => Promise<T> | undefined): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      this.core.log.debug({ err, what }, 'workqueues: day-end source unavailable');
      return undefined;
    }
  }

  async #items(date: string): Promise<DayEndItem[]> {
    const core = this.core;
    const now = core.now();
    const base = { checked: false, checkedBy: null, checkedAt: null, note: null };
    const queues = await core.queueMap();
    const leadOf = async (key: string) => {
      const q = queues.get(key);
      return q ? core.staffRef(q.lead_staff_id) : null;
    };

    const [open, overdue, payouts, payoutsOverdue, dispatchOverdue] = await Promise.all([
      this.repo.countItems({ states: ACTIVE }),
      this.repo.countItems({ states: ACTIVE, deadlineStates: ['overdue'], now }),
      this.repo.scanItems({ states: ACTIVE, kinds: ['payout_failed'] }, null, 500),
      this.repo.countItems({ states: ACTIVE, kinds: ['payout_failed'], deadlineStates: ['overdue'], now }),
      this.repo.countItems({ states: ACTIVE, kinds: DISPATCH_KINDS, now }),
    ]);
    const items: DayEndItem[] = [
      {
        key: 'unresolved_commitments',
        title: 'Unresolved commitments',
        summary: `${overdue} overdue work item${overdue === 1 ? '' : 's'}, ${open} open in total`,
        owner: null,
        link: { screen: 'ops/queues', state: 'overdue' },
        source: 'workqueues',
        ...base,
      },
    ];

    const finance = core.ctx.tryUse('finance');
    const payoutTotal = payouts.reduce((s, r) => s + (r.amount_minor ?? 0), 0);
    items.push({
      key: 'failed_payouts',
      title: 'Failed payouts',
      summary: finance ? `${payouts.length} failed payout${payouts.length === 1 ? '' : 's'} open${payouts.length ? ` (${formatMoney(moneyOf(payoutTotal, core.ctx.config.market.currency))})` : ''}${payoutsOverdue ? `, ${payoutsOverdue} overdue` : ''}` : 'Finance is not running',
      owner: await leadOf('finance.payout_failures'),
      link: { screen: 'admin/payouts', state: 'failed' },
      source: finance ? 'finance' : 'unavailable',
      ...base,
    });

    const ads = core.ctx.tryUse('advertising');
    const promos = core.ctx.tryUse('promotions');
    const adSummary = ads ? await this.#optional('advertising.dashboardSummary', () => ads.dashboardSummary({ listLimit: 3 })) : undefined;
    const deals = promos ? await this.#optional('promotions.getDealsPage', () => promos.getDealsPage({ at: now.toISOString() })) : undefined;
    const campaignParts: string[] = [];
    if (adSummary) campaignParts.push(`${adSummary.startingIn7Days} ad campaign${adSummary.startingIn7Days === 1 ? '' : 's'} starting in 7 days, ${adSummary.waitingApproval} waiting approval`);
    if (deals) campaignParts.push(`${deals.upcomingEvents.length} upcoming promotion event${deals.upcomingEvents.length === 1 ? '' : 's'}`);
    items.push({
      key: 'upcoming_campaigns',
      title: 'Upcoming campaigns',
      summary: campaignParts.length ? campaignParts.join('; ') : 'Advertising and promotions are not available',
      owner: null,
      link: { screen: 'admin/promotions' },
      source: campaignParts.length ? 'advertising/promotions' : 'unavailable',
      ...base,
    });

    const warehouse = core.ctx.tryUse('warehouse');
    const shipping = core.ctx.tryUse('shipping');
    const wh = warehouse ? await this.#optional('warehouse.getTodaySummary', () => warehouse.getTodaySummary()) : undefined;
    const ex = shipping ? await this.#optional('shipping.countOpenExceptions', () => shipping.countOpenExceptions()) : undefined;
    const shipParts: string[] = [];
    if (wh) shipParts.push(`${wh.toShip} Official Store packages to ship, ${wh.late} late, next pickup ${wh.shipByCutoff ?? 'not scheduled'}`);
    if (ex) shipParts.push(`${ex.lateDispatch} late dispatches and ${ex.missingTracking} missing tracking`);
    shipParts.push(`${dispatchOverdue} open dispatch item${dispatchOverdue === 1 ? '' : 's'} in work queues`);
    items.push({
      key: 'next_day_shipping',
      title: 'Next-day shipping',
      summary: shipParts.join('; '),
      owner: await leadOf('shipping.overdue_dispatch'),
      link: { screen: 'ops/dispatch' },
      source: wh || ex ? 'warehouse/shipping' : 'unavailable',
      ...base,
    });

    const yesterday = await this.repo.reviewByDate(addDays(date, -1));
    if (yesterday?.state === 'missed') {
      items.push({ key: 'custom', title: "Yesterday's review was missed", summary: `The review of ${yesterday.date} was not completed; check what it listed`, owner: null, link: { screen: 'ops/queues', state: 'day-end' }, source: 'workqueues', ...base });
    }
    return items;
  }

  /** Today's review, built when missing (job day-end-prepare, or on first read) */
  async prepare(date = this.core.today()): Promise<DayEndReviewRow> {
    const core = this.core;
    await core.ensureSeeded();
    const existing = await this.repo.reviewByDate(date);
    if (existing) return existing;
    const time = (await core.ctx.settings.get('dayEndReviewTime')) as string;
    const roles = [...((await core.ctx.settings.get('dayEndSharedRoles')) as readonly string[])];
    return this.repo.insertReview({
      id: newId(),
      date,
      due_at: zonedTimeToUtc(date, /^\d{2}:\d{2}$/.test(time) ? time : '17:30', core.timeZone),
      state: dayEndReviewMachine.initial,
      shared_with_roles: roles as never,
      items: (await this.#items(date)) as never,
      completed_by: null,
      completed_at: null,
      summary_sent_to: [] as never,
    });
  }

  /**
   * Job day-end-prepare: build today's review, or refresh the items of one staff opened earlier (checks
   * and notes already made are kept), and publish workqueues.day_end.prepared, the reminder, once per date
   * and only while the review is still open. The summary itself goes out on completion.
   */
  async prepareAndAnnounce(date = this.core.today()): Promise<DayEndReviewRow> {
    const core = this.core;
    const existing = await this.repo.reviewByDate(date);
    let built = existing ?? (await this.prepare(date));
    if (existing?.state === 'open') {
      const fresh = await this.#items(date);
      built = await this.repo.transaction(async (tx) => {
        const r = (await tx.getReview(existing.id, { forUpdate: true }))!;
        if (r.state !== 'open') return r;
        const before = new Map(((r.items ?? []) as unknown as DayEndItem[]).map((i) => [i.key === 'custom' ? `custom:${i.title}` : i.key, i]));
        const items = fresh.map((i) => {
          const old = before.get(i.key === 'custom' ? `custom:${i.title}` : i.key);
          return old ? { ...i, checked: old.checked, checkedBy: old.checkedBy, checkedAt: old.checkedAt, note: old.note } : i;
        });
        return tx.updateReview(r.id, { items: items as never });
      });
    }
    if (built.state !== 'open') return built;
    const roles = (built.shared_with_roles ?? []) as string[];
    const now = core.now();
    const [openItems, overdueItems] = await Promise.all([this.repo.countItems({ states: ACTIVE }), this.repo.countItems({ states: ACTIVE, deadlineStates: ['overdue'], now })]);
    const claimed = await this.repo.claim(`day-end-prepared:${date}`); // one atomic upsert: no transaction needed
    if (!claimed) return built;
    core.ctx.events.publish('workqueues.day_end.prepared', { reviewId: built.id, date: built.date, dueAt: built.due_at.toISOString(), openItems, overdueItems, roleKeys: roles }, { actor: SYSTEM });
    return built;
  }

  /* ---------------------------------------------------------------- reading */

  async view(row: DayEndReviewRow): Promise<DayEndReview> {
    return {
      id: row.id,
      date: row.date,
      dueAt: row.due_at.toISOString(),
      state: row.state as DayEndReview['state'],
      sharedWithRoles: (row.shared_with_roles ?? []) as string[],
      items: (row.items ?? []) as unknown as DayEndItem[],
      completedBy: row.completed_by ? await this.core.staffRef(row.completed_by) : null,
      completedAt: row.completed_at ? row.completed_at.toISOString() : null,
      summarySentTo: (row.summary_sent_to ?? []) as string[],
    };
  }

  async current(): Promise<DayEndReview> {
    return this.view(await this.prepare());
  }

  /** Today's review if it exists (My work queues shows null before it is built) */
  async todayIfBuilt(): Promise<DayEndReview | null> {
    const row = await this.repo.reviewByDate(this.core.today());
    return row ? this.view(row) : null;
  }

  async list(filter: { from?: string; to?: string; state?: string }, page: PageRequest): Promise<Page<DayEndReview>> {
    const res = await this.repo.listReviews(filter, page);
    return { ...res, items: await Promise.all(res.items.map((r) => this.view(r))) };
  }

  /* ---------------------------------------------------------------- checking and completing */

  async #noteRequired(key: Key): Promise<boolean> {
    const now = this.core.now();
    const q = { states: [...ACTIVE], deadlineStates: ['overdue'], now };
    if (key === 'unresolved_commitments') return (await this.repo.countItems(q)) > 0;
    if (key === 'failed_payouts') return (await this.repo.countItems({ ...q, kinds: ['payout_failed'] })) > 0;
    if (key === 'next_day_shipping') return (await this.repo.countItems({ ...q, kinds: DISPATCH_KINDS })) > 0;
    return false;
  }

  async check(v: Viewer, id: string, itemKey: string, note: string | null | undefined, _by: By): Promise<DayEndReview> {
    const existing = await this.repo.getReview(id);
    if (!existing) throw new AppError('NOT_FOUND', 'Day-end review not found');
    const items = (existing.items ?? []) as unknown as DayEndItem[];
    if (!items.some((i) => i.key === itemKey)) throw new AppError('NOT_FOUND', 'This review has no such item');
    if (existing.state !== 'open') throw new AppError('ILLEGAL_TRANSITION', `The review is ${existing.state}`, { machine: 'Day-end review', from: existing.state, event: 'check' });
    const text = note?.trim() || null;
    if (!text && (await this.#noteRequired(itemKey as Key))) throw new AppError('NOTE_REQUIRED', 'This item has overdue work; add a note explaining the plan');
    const me = await this.core.staffRef(v.staffId);
    const row = await this.repo.transaction(async (tx) => {
      const r = (await tx.getReview(id, { forUpdate: true }))!;
      if (r.state !== 'open') throw new AppError('ILLEGAL_TRANSITION', `The review is ${r.state}`, { machine: 'Day-end review', from: r.state, event: 'check' });
      const next = ((r.items ?? []) as unknown as DayEndItem[]).map((i) => (i.key === itemKey ? { ...i, checked: true, checkedBy: me, checkedAt: this.core.now().toISOString(), note: text ?? i.note ?? null } : i));
      return tx.updateReview(id, { items: next as never });
    });
    return this.view(row);
  }

  async complete(v: Viewer, id: string, note: string | null | undefined, by: By): Promise<DayEndReview> {
    const core = this.core;
    const existing = await this.repo.getReview(id);
    if (!existing) throw new AppError('NOT_FOUND', 'Day-end review not found');
    const state = dayEndReviewMachine.next(existing.state as never, 'complete');
    const unchecked = ((existing.items ?? []) as unknown as DayEndItem[]).filter((i) => !i.checked).map((i) => i.key);
    if (unchecked.length) throw new AppError('DAY_END_INCOMPLETE', `${unchecked.length} item${unchecked.length === 1 ? ' is' : 's are'} not checked yet`, { items: unchecked });
    const now = core.now();
    const [openItems, overdueItems] = await Promise.all([this.repo.countItems({ states: [...ACTIVE] }), this.repo.countItems({ states: [...ACTIVE], deadlineStates: ['overdue'], now })]);
    // the summary goes to the shared roles now (workqueues.day_end.completed, sent by notifications)
    const roles = (existing.shared_with_roles ?? []) as string[];
    const notifying = (core.ctx.modules as readonly string[]).includes('notifications');
    const sentTo = notifying ? roles : [];
    const text = note?.trim() || null;
    const row = await this.repo.transaction(async (tx) => {
      const r = (await tx.getReview(id, { forUpdate: true }))!;
      dayEndReviewMachine.next(r.state as never, 'complete');
      return tx.updateReview(id, { state, completed_by: v.staffId, completed_at: now, summary_sent_to: sentTo as never });
    });
    const items = ((row.items ?? []) as unknown as DayEndItem[]).map((i) => ({ key: i.key, title: i.title, summary: i.summary, ...(i.note ? { note: i.note } : {}) }));
    core.ctx.events.publish(
      'workqueues.day_end.completed',
      { reviewId: id, date: row.date, completedBy: by.actor, completedAt: now.toISOString(), openItems, overdueItems, note: text, items, roleKeys: roles },
      by,
    );
    await core.audit({ action: 'workqueues.day_end.complete', actionLabel: 'Completed the day-end review', target: { type: 'day_end_review', id, ref: row.date, label: `Day-end review ${row.date}` }, reason: text, after: { state: row.state, openItems, overdueItems, summarySentTo: sentTo } }, by);
    return this.view(row);
  }

  /* ---------------------------------------------------------------- end of day */

  /** Job day-end-close: an uncompleted review is missed; snapshot daily_counts */
  async close(): Promise<void> {
    const core = this.core;
    await core.ensureSeeded();
    const date = core.today();
    const review = await this.repo.reviewByDate(date);
    if (review?.state === 'open') await this.repo.updateReview(review.id, { state: dayEndReviewMachine.next('open', 'miss') });
    await this.snapshot(date);
  }

  async snapshot(date: string): Promise<void> {
    const core = this.core;
    const from = zonedTimeToUtc(date, '00:00', core.timeZone);
    const to = zonedTimeToUtc(addDays(date, 1), '00:00', core.timeZone);
    const [queues, counts, opened, resolved] = await Promise.all([
      this.repo.listQueues(),
      this.repo.queueCounts(core.now(), await core.dueSoonMinutes()),
      this.repo.openedBetween(from, to),
      this.repo.resolvedBetween(from, to),
    ]);
    const c = new Map(counts.map((x) => [x.queue_key, x]));
    const o = new Map(opened.map((x) => [x.queue_key, x.n]));
    await this.repo.upsertDailyCounts(
      queues.map((q) => {
        const done = resolved.filter((r) => r.queue_key === q.key);
        return {
          queue_key: q.key,
          date,
          open: c.get(q.key)?.open ?? 0,
          overdue: c.get(q.key)?.overdue ?? 0,
          opened: o.get(q.key) ?? 0,
          resolved: done.length,
          median_resolve_minutes: median(done.map((r) => Math.round((r.resolved_at.getTime() - r.opened_at.getTime()) / 60_000))),
        };
      }),
    );
  }
}
