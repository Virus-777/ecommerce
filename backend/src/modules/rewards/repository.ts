import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import { escapeRegExp } from '../../kernel/lib/text.js';
import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { AccountRow, EntryRow, ProgramRow, ProgressRow, RedemptionRow, RewardRow, TaskRow } from './ports.js';

export type Lock = { forUpdate?: boolean };

/**
 * The rewards module's collections (rewards.<table>): the program row, tasks, accounts (balance and streak), the
 * points ledger, task progress per day, the reward catalogue and redemptions.
 */
export class RewardsRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
      program: store.table<ProgramRow>('program'),
      tasks: store.table<TaskRow>('tasks'),
      accounts: store.table<AccountRow>('accounts'),
      entries: store.table<EntryRow>('entries'),
      progress: store.table<ProgressRow>('progress'),
      rewards: store.table<RewardRow>('rewards'),
      redemptions: store.table<RedemptionRow>('redemptions'),
    };
  }

  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: RewardsRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new RewardsRepository(tx)));
  }

  /** Inbox for event consumers: true the first time this key is claimed (commits with the transaction's effects) */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /* ---------------------------------------------------------------- program */

  getProgram(): Promise<ProgramRow | undefined> {
    return this.#t.program.get('main');
  }
  saveProgram(row: ProgramRow): Promise<ProgramRow> {
    return this.#t.program.upsert(row);
  }

  /* ---------------------------------------------------------------- tasks */

  listTasks(f: { visibleOnly?: boolean; kind?: string } = {}): Promise<TaskRow[]> {
    return this.#t.tasks.find({ ...(f.visibleOnly ? { visible: true } : {}), ...(f.kind ? { kind: f.kind } : {}) }, { sort: { position: 1, key: 1 } });
  }
  getTask(key: string): Promise<TaskRow | undefined> {
    return this.#t.tasks.get(key);
  }
  insertTask(row: TaskRow): Promise<TaskRow | undefined> {
    return this.#t.tasks.insertIfAbsent(row);
  }
  updateTask(key: string, patch: Partial<TaskRow>): Promise<TaskRow | undefined> {
    return this.#t.tasks.update(key, patch);
  }
  deleteTask(key: string): Promise<boolean> {
    return this.#t.tasks.delete(key);
  }
  async maxTaskPosition(): Promise<number> {
    const rows = await this.#t.tasks.find({}, { sort: { position: -1 }, limit: 1 });
    return rows[0]?.position ?? 0;
  }

  /* ---------------------------------------------------------------- accounts and the ledger */

  getAccount(customerId: string, lock?: Lock): Promise<AccountRow | undefined> {
    return this.#t.accounts.get(customerId, lock);
  }
  accountsByIds(ids: string[]): Promise<AccountRow[]> {
    return this.#t.accounts.getMany(ids);
  }
  /** The customer's account, created at 0 points the first time (locked inside a transaction) */
  async account(customerId: string, now: Date): Promise<AccountRow> {
    await this.#t.accounts.insertIfAbsent({ customer_id: customerId, balance: 0, streak: 0, last_check_in: null, updated_at: now });
    return (await this.#t.accounts.get(customerId, { forUpdate: true }))!;
  }
  /** Adds `points` to the balance (an atomic $inc) and sets the other fields; the account after */
  async addPoints(customerId: string, points: number, set: Partial<AccountRow>): Promise<AccountRow> {
    return (await this.#t.accounts.update(customerId, { $inc: { balance: points }, $set: set }))!;
  }
  pageAccounts(f: { customerIds?: string[] }, page: PageRequest): Promise<Page<AccountRow>> {
    return this.#t.accounts.page(f.customerIds ? { customer_id: { $in: f.customerIds } } : {}, page, { column: 'balance', direction: 'desc' });
  }

  entryByDedupe(key: string): Promise<EntryRow | undefined> {
    return this.#t.entries.findOne({ dedupe_key: key });
  }
  insertEntry(row: EntryRow): Promise<EntryRow> {
    return this.#t.entries.insert(row);
  }
  deleteEntry(id: string): Promise<boolean> {
    return this.#t.entries.delete(id);
  }
  pageEntries(customerId: string, page: PageRequest): Promise<Page<EntryRow>> {
    return this.#t.entries.page({ customer_id: customerId }, page, { column: 'at', direction: 'desc' });
  }
  latestEntries(customerId: string, limit: number): Promise<EntryRow[]> {
    return this.#t.entries.find({ customer_id: customerId }, { sort: { at: -1, id: -1 }, limit });
  }
  allEntries(customerId: string): Promise<EntryRow[]> {
    return this.#t.entries.find({ customer_id: customerId }, { sort: { at: 1, id: 1 } });
  }

  /* ---------------------------------------------------------------- task progress */

  progressOn(customerId: string, day: string): Promise<ProgressRow[]> {
    return this.#t.progress.find({ customer_id: customerId, day });
  }
  /** The customer's progress row on a task and day, created at 0 the first time (locked inside a transaction) */
  async progressRow(customerId: string, taskKey: string, day: string, id: string, now: Date): Promise<ProgressRow> {
    await this.#t.progress.insertIfAbsent({ id, customer_id: customerId, task_key: taskKey, day, count: 0, refs: [], claimed: false, updated_at: now });
    return (await this.#t.progress.findOne({ customer_id: customerId, task_key: taskKey, day }, { forUpdate: true }))!;
  }
  updateProgress(id: string, patch: Partial<ProgressRow>): Promise<ProgressRow | undefined> {
    return this.#t.progress.update(id, patch);
  }
  /** Claimed rows per task key on a day */
  async claimedOn(day: string): Promise<Map<string, number>> {
    const rows = await this.#t.progress.aggregate<{ _id: string; n: number }>([{ $match: { day, claimed: true } }, { $group: { _id: '$task_key', n: { $sum: 1 } } }]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
  }

  /* ---------------------------------------------------------------- rewards */

  listRewards(f: { visibleOnly?: boolean } = {}): Promise<RewardRow[]> {
    return this.#t.rewards.find(f.visibleOnly ? { visible: true } : {}, { sort: { position: 1, created_at: 1 } });
  }
  getReward(id: string, lock?: Lock): Promise<RewardRow | undefined> {
    return this.#t.rewards.get(id, lock);
  }
  rewardsByIds(ids: string[]): Promise<RewardRow[]> {
    return this.#t.rewards.getMany(ids);
  }
  insertReward(row: RewardRow): Promise<RewardRow> {
    return this.#t.rewards.insert(row);
  }
  updateReward(id: string, patch: Record<string, unknown>): Promise<RewardRow | undefined> {
    return this.#t.rewards.update(id, patch);
  }
  deleteReward(id: string): Promise<boolean> {
    return this.#t.rewards.delete(id);
  }
  async maxRewardPosition(): Promise<number> {
    const rows = await this.#t.rewards.find({}, { sort: { position: -1 }, limit: 1 });
    return rows[0]?.position ?? 0;
  }

  /* ---------------------------------------------------------------- redemptions */

  redemptionByKey(key: string): Promise<RedemptionRow | undefined> {
    return this.#t.redemptions.findOne({ idempotency_key: key });
  }
  insertRedemption(row: RedemptionRow): Promise<RedemptionRow | undefined> {
    return this.#t.redemptions.insertIfAbsent(row);
  }
  pageCustomerRedemptions(customerId: string, page: PageRequest): Promise<Page<RedemptionRow>> {
    return this.#t.redemptions.page({ customer_id: customerId }, page, { column: 'at', direction: 'desc' });
  }
  allRedemptions(customerId: string): Promise<RedemptionRow[]> {
    return this.#t.redemptions.find({ customer_id: customerId }, { sort: { at: 1 } });
  }
  pageAdminRedemptions(f: { rewardId?: string; q?: string; customerIds?: string[] }, page: PageRequest): Promise<Page<RedemptionRow>> {
    const filter: Record<string, unknown> = {};
    if (f.rewardId) filter.reward_id = f.rewardId;
    const q = f.q?.trim();
    if (q) {
      const byCode = { code: { $regex: escapeRegExp(q), $options: 'i' } };
      filter.$or = f.customerIds?.length ? [byCode, { customer_id: { $in: f.customerIds } }] : [byCode];
    }
    return this.#t.redemptions.page(filter, page, { column: 'at', direction: 'desc' });
  }
}
