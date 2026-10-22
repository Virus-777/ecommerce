import { AppError, isAppError } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import { dateInZone } from '../../kernel/lib/clock.js';
import { isUuid, newId } from '../../kernel/lib/ids.js';
import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as audit from '../../spec/audit.js';
import type * as common from '../../spec/common.js';
import type * as customers from '../../spec/customers.js';
import type * as promotions from '../../spec/promotions.js';
import type {
  AdjustmentInput,
  CheckInResult,
  CustomerPoints,
  PointsEntry,
  ProgramAdmin,
  ProgramInput,
  Redemption,
  RedemptionAdmin,
  RewardAdmin,
  RewardInput,
  RewardOffer,
  RewardsPublicApi,
  RewardsSummary,
  RewardTask,
  TaskAdmin,
  TaskInput,
  TaskProgressInput,
} from '../../spec/rewards.js';
import { bonusLabel, checkInTitle, currentStreak, cycleDay, DEFAULT_SCHEDULE, isValidKey, keyOf, MAX_DAY_POINTS, REPORTABLE, scheduleOf, TASK_KINDS, taskState, TINTS, WEEK, weekOf } from './domain/rules.js';
import type { AccountRow, EntryRow, ProgressRow, RedemptionRow, RewardRow, TaskRow } from './ports.js';
import type { RewardsRepository } from './repository.js';

export interface RewardsServiceDeps {
  repo: RewardsRepository;
  ctx: ModuleContext<'rewards'>;
}

/** Who acts: for audit entries, the ledger and events */
export interface By {
  actor: common.Actor;
  requestId?: string;
}

const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });
const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
const iso = (d: Date | string) => new Date(d).toISOString();
/** "staff:<id>": how the ledger records who changed points */
const actorKey = (a: common.Actor) => `${a.kind}:${a.id ?? ''}`;
const refsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const tintOf = (t: string): RewardOffer['tint'] => ((TINTS as readonly string[]).includes(t) ? (t as RewardOffer['tint']) : 'neutral');
const text = (v: string | null | undefined, path: string, max: number) => {
  const t = v?.trim();
  if (!t) throw invalid(path, 'This field is required');
  if (t.length > max) throw invalid(path, `Use at most ${max} characters`);
  return t;
};
const wholeIn = (v: unknown, path: string, min: number, max: number, message: string) => {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw invalid(path, message);
  return v as number;
};

/** The program as the service uses it: the schedule falls back to the default */
interface Program {
  schedule: number[];
  enabled: boolean;
  updatedAt: Date | null;
}

/** Whether a coupon campaign can give codes now (running, or scheduled to start), with its name */
interface CampaignState {
  active: boolean;
  name: string | null;
}

/**
 * Daily rewards use cases: the check-in schedule and streaks, daily tasks, the points ledger, the reward catalogue
 * and redemptions (codes from promotions.issueCode). Customers are customers-module ids (the store principal's
 * customerId, as promotions keeps them). Days are market days (the market time zone).
 */
export class RewardsService implements RewardsPublicApi {
  constructor(protected readonly deps: RewardsServiceDeps) {}

  protected get repo() {
    return this.deps.repo;
  }
  protected get ctx() {
    return this.deps.ctx;
  }
  protected now() {
    return this.ctx.clock.now();
  }
  /** Today's market day (YYYY-MM-DD in the market time zone) */
  protected today(): string {
    return dateInZone(this.now(), this.ctx.config.market.timeZone || 'America/Los_Angeles');
  }

  protected async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'> & { category?: audit.RecordInput['category'] }, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ category: 'other', ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      this.ctx.log.warn({ err, action: entry.action }, 'rewards: audit entry not recorded');
    }
  }

  /* ---------------------------------------------------------------- program */

  protected async program(): Promise<Program> {
    const row = await this.repo.getProgram();
    return { schedule: scheduleOf(row?.check_in_points) ?? [...DEFAULT_SCHEDULE], enabled: row?.enabled ?? true, updatedAt: row?.updated_at ?? null };
  }

  async getProgram(): Promise<ProgramAdmin> {
    const p = await this.program();
    return { checkInPoints: p.schedule, enabled: p.enabled, updatedAt: p.updatedAt ? iso(p.updatedAt) : null };
  }

  async setProgram(body: ProgramInput, by: By): Promise<ProgramAdmin> {
    const schedule = scheduleOf(body.checkInPoints);
    if (!schedule) throw invalid('checkInPoints', `Set ${WEEK} whole numbers of points from 0 to ${MAX_DAY_POINTS.toLocaleString('en-US')}, day 1 to day ${WEEK}`);
    const before = await this.getProgram();
    await this.repo.saveProgram({ id: 'main', check_in_points: schedule, enabled: Boolean(body.enabled), updated_at: this.now(), updated_by: actorKey(by.actor) });
    const after = await this.getProgram();
    const actionLabel = before.enabled !== after.enabled ? (after.enabled ? 'Turned Daily rewards on' : 'Turned Daily rewards off') : 'Changed the check-in schedule';
    await this.audit({ action: 'rewards.program.set', actionLabel, target: { type: 'rewards_program', id: 'main', label: 'Daily rewards' }, before, after }, by);
    return after;
  }

  /* ---------------------------------------------------------------- customer: summary and check-in */

  async getSummary(customerId: string): Promise<RewardsSummary> {
    const [program, account, tasks, rewards] = await Promise.all([this.program(), this.repo.getAccount(customerId), this.customerTasks(customerId), this.repo.listRewards({ visibleOnly: true })]);
    const today = this.today();
    const a = { streak: account?.streak ?? 0, lastCheckIn: account?.last_check_in ?? null };
    const checkedInToday = a.lastCheckIn === today;
    const position = cycleDay(a, today);
    const balance = account?.balance ?? 0;
    return {
      balance,
      streak: currentStreak(a, today),
      checkedInToday,
      todayPoints: program.schedule[position - 1] ?? 0,
      week: weekOf(program.schedule, position, checkedInToday),
      bonusLabel: program.enabled ? bonusLabel(program.schedule, position, checkedInToday) : null,
      tasks,
      rewards: await this.offers(rewards, balance),
    };
  }

  async checkIn(customerId: string, by: By): Promise<CheckInResult> {
    const program = await this.program();
    if (!program.enabled) throw this.ctx.error('PROGRAM_OFF', 'Daily rewards is turned off.');
    const today = this.today();
    const now = this.now();
    const points = await this.repo.transaction(async (tx) => {
      const account = await tx.account(customerId, now);
      if (account.last_check_in === today) throw this.ctx.error('ALREADY_CHECKED_IN', 'You already checked in today. Come back tomorrow.');
      const day = cycleDay({ streak: account.streak, lastCheckIn: account.last_check_in }, today);
      const pts = program.schedule[day - 1] ?? 0;
      await this.post(tx, account, { points: pts, kind: 'check_in', title: checkInTitle(day), ref: today, dedupeKey: `check_in:${customerId}:${today}`, by }, { streak: day, last_check_in: today });
      return pts;
    });
    return { points, summary: await this.getSummary(customerId) };
  }

  /** Adds points to an account (an atomic $inc) and writes the ledger entry with the balance after, in the caller's transaction */
  protected async post(tx: RewardsRepository, account: AccountRow, e: { points: number; kind: EntryRow['kind']; title: string; ref: string | null; dedupeKey: string; by: By | null }, set: Partial<AccountRow> = {}): Promise<{ entry: EntryRow; account: AccountRow }> {
    const now = this.now();
    const after = await tx.addPoints(account.customer_id, e.points, { ...set, updated_at: now });
    const entry = await tx.insertEntry({ id: newId(), customer_id: account.customer_id, points: e.points, kind: e.kind, title: e.title, ref: e.ref, dedupe_key: e.dedupeKey, balance_after: after.balance, by: e.by ? actorKey(e.by.actor) : null, at: now });
    return { entry, account: after };
  }

  /* ---------------------------------------------------------------- customer: tasks */

  protected toTask(t: TaskRow, p: ProgressRow | undefined): RewardTask {
    const count = p?.count ?? 0;
    return { key: t.key, kind: t.kind, title: t.title, points: t.points, target: t.target, progress: Math.min(count, t.target), state: taskState(count, t.target, p?.claimed ?? false), path: t.path };
  }

  protected async customerTasks(customerId: string): Promise<RewardTask[]> {
    const [tasks, progress] = await Promise.all([this.repo.listTasks({ visibleOnly: true }), this.repo.progressOn(customerId, this.today())]);
    const byKey = new Map(progress.map((p) => [p.task_key, p]));
    return tasks.map((t) => this.toTask(t, byKey.get(t.key)));
  }

  /** A visible task, or NOT_FOUND */
  protected async visibleTask(key: string): Promise<TaskRow> {
    const t = await this.repo.getTask(key);
    if (!t || !t.visible) throw notFound('Task');
    return t;
  }

  async reportTask(customerId: string, key: string, body: TaskProgressInput | undefined): Promise<RewardTask> {
    const task = await this.visibleTask(key);
    if (!REPORTABLE.includes(task.kind)) throw this.ctx.error('NOT_REPORTABLE', "This task counts by itself; it can't be reported from the app.");
    const refId = body?.refId?.trim().slice(0, 200) || null;
    const row = await this.count(customerId, task, refId);
    return this.toTask(task, row);
  }

  /**
   * One more done on a task today (the same refId once a day, never past the target); the progress after. With
   * `claimKey` (event consumers), only the first time that key is claimed counts.
   */
  protected count(customerId: string, task: TaskRow, refId: string | null, claimKey?: string): Promise<ProgressRow | undefined> {
    const day = this.today();
    const now = this.now();
    return this.repo.transaction(async (tx) => {
      if (claimKey && !(await tx.claim(claimKey))) return undefined;
      const row = await tx.progressRow(customerId, task.key, day, newId(), now);
      const refs = refsOf(row.refs);
      if (row.count >= task.target || (refId && refs.includes(refId))) return row;
      return tx.updateProgress(row.id, { count: row.count + 1, refs: refId ? [...refs, refId] : refs, updated_at: now });
    });
  }

  async claimTask(customerId: string, key: string, by: By): Promise<RewardsSummary> {
    const program = await this.program();
    if (!program.enabled) throw this.ctx.error('PROGRAM_OFF', 'Daily rewards is turned off.');
    const task = await this.visibleTask(key);
    const day = this.today();
    const now = this.now();
    await this.repo.transaction(async (tx) => {
      const account = await tx.account(customerId, now);
      const row = await tx.progressRow(customerId, task.key, day, newId(), now);
      if (row.claimed) throw this.ctx.error('ALREADY_CLAIMED', 'You already claimed these points today.');
      if (row.count < task.target) throw this.ctx.error('TASK_NOT_DONE', 'Finish the task first.', { progress: row.count, target: task.target });
      await tx.updateProgress(row.id, { claimed: true, updated_at: now });
      await this.post(tx, account, { points: task.points, kind: 'task', title: task.title, ref: task.key, dedupeKey: `task:${customerId}:${task.key}:${day}`, by });
    });
    return this.getSummary(customerId);
  }

  /* ---------------------------------------------------------------- customer: rewards */

  /** Whether each campaign can give codes now (running, or scheduled to start: issueCode accepts both), with its name */
  protected async campaigns(ids: string[]): Promise<Map<string, CampaignState>> {
    const api = this.ctx.use('promotions');
    const out = new Map<string, CampaignState>();
    await Promise.all(
      [...new Set(ids)].map(async (id) => {
        const [state, pub] = await Promise.all([api.isCampaignActive(id), api.getPublicCampaign(id)]);
        out.set(id, { active: state.active || state.reason === 'not_started', name: pub?.name ?? null });
      }),
    );
    return out;
  }

  protected async offers(rewards: RewardRow[], balance: number): Promise<RewardOffer[]> {
    const states = await this.campaigns(rewards.map((r) => r.campaign_id));
    return rewards.map((r) => {
      const available = (r.stock === null || r.stock > 0) && Boolean(states.get(r.campaign_id)?.active);
      const missing = Math.max(0, r.cost - balance);
      return { id: r.id, title: r.title, condition: r.condition, cost: r.cost, tint: tintOf(r.tint), canRedeem: available && missing === 0, missing, available };
    });
  }

  protected toRedemption(r: RedemptionRow): Redemption {
    return { id: r.id, rewardId: r.reward_id, title: r.title, condition: r.condition, cost: r.cost, code: r.code, endsAt: r.ends_at ? iso(r.ends_at) : null, at: iso(r.at) };
  }

  /**
   * Swaps points for a coupon: the points come off (and the stock), promotions.issueCode gives the customer their own
   * code (the redemption id is its key), then the redemption is recorded. When issueCode fails the points and the
   * stock are given back and nothing is recorded. The same Idempotency-Key answers the same redemption.
   */
  async redeemReward(customerId: string, rewardId: string, idempotencyKey: string, by: By): Promise<Redemption> {
    const key = `${customerId}:${idempotencyKey}`;
    const done = await this.repo.redemptionByKey(key);
    if (done) return this.toRedemption(done);
    const reward = isUuid(rewardId) ? await this.repo.getReward(rewardId) : undefined;
    if (!reward || !reward.visible) throw notFound('Reward');
    const id = newId();
    const now = this.now();
    const { entry } = await this.repo.transaction(async (tx) => {
      const account = await tx.account(customerId, now);
      if (account.balance < reward.cost) throw this.ctx.error('NOT_ENOUGH_POINTS', 'Not enough points.', { missing: reward.cost - account.balance, balance: account.balance, cost: reward.cost });
      const r = await tx.getReward(reward.id, { forUpdate: true });
      if (!r || !r.visible) throw notFound('Reward');
      if (r.stock !== null && r.stock <= 0) throw this.ctx.error('SOLD_OUT', 'This reward is no longer available.');
      await tx.updateReward(r.id, { $inc: { redeemed: 1, ...(r.stock !== null ? { stock: -1 } : {}) }, $set: { updated_at: now } });
      return this.post(tx, account, { points: -r.cost, kind: 'redeem', title: `${r.title} coupon`, ref: id, dedupeKey: `redeem:${id}`, by });
    });
    let issued: promotions.IssuedCoupon;
    try {
      issued = await this.ctx.use('promotions').issueCode(reward.campaign_id, customerId, id);
    } catch (err) {
      // give the points and the stock back; nothing is recorded
      await this.repo.transaction(async (tx) => {
        await tx.account(customerId, now);
        const r = await tx.getReward(reward.id, { forUpdate: true });
        if (r) await tx.updateReward(r.id, { $inc: { redeemed: -1, ...(r.stock !== null ? { stock: 1 } : {}) }, $set: { updated_at: this.now() } });
        await tx.addPoints(customerId, reward.cost, { updated_at: this.now() });
        await tx.deleteEntry(entry.id);
      });
      if (isAppError(err) && err.code === 'CAMPAIGN_NOT_ACTIVE') throw this.ctx.error('CAMPAIGN_NOT_ACTIVE', "The coupon campaign behind this reward isn't running.");
      throw err;
    }
    const row: RedemptionRow = { id, customer_id: customerId, reward_id: reward.id, title: reward.title, condition: reward.condition, cost: reward.cost, code_id: issued.codeId, code: issued.code, ends_at: issued.endsAt ? new Date(issued.endsAt) : null, idempotency_key: key, at: now };
    await this.repo.insertRedemption(row);
    this.ctx.events.publish('rewards.reward.redeemed', { redemptionId: id, customerId, title: reward.title, code: issued.code, cost: reward.cost }, by);
    return this.toRedemption(row);
  }

  protected toEntry(e: EntryRow): PointsEntry {
    return { id: e.id, points: e.points, kind: e.kind, title: e.title, at: iso(e.at), balanceAfter: e.balance_after };
  }

  async listHistory(customerId: string, page: PageRequest): Promise<Page<PointsEntry>> {
    const p = await this.repo.pageEntries(customerId, page);
    return { ...p, items: p.items.map((e) => this.toEntry(e)) };
  }

  async listMyRedemptions(customerId: string, page: PageRequest): Promise<Page<Redemption>> {
    const p = await this.repo.pageCustomerRedemptions(customerId, page);
    return { ...p, items: p.items.map((r) => this.toRedemption(r)) };
  }

  /* ---------------------------------------------------------------- admin: tasks */

  async listTasksAdmin(): Promise<TaskAdmin[]> {
    const [tasks, claimed] = await Promise.all([this.repo.listTasks(), this.repo.claimedOn(this.today())]);
    return tasks.map((t) => this.toTaskAdmin(t, claimed.get(t.key) ?? 0));
  }

  protected toTaskAdmin(t: TaskRow, claimedToday: number): TaskAdmin {
    return { key: t.key, kind: t.kind, title: t.title, points: t.points, target: t.target, path: t.path, visible: t.visible, position: t.position, claimedToday };
  }

  protected taskFields(body: TaskInput): Pick<TaskRow, 'kind' | 'title' | 'points' | 'target' | 'path'> {
    if (!(TASK_KINDS as readonly string[]).includes(body.kind)) throw invalid('kind', 'Choose a task kind');
    const path = body.path?.trim() || null;
    if (path && (!path.startsWith('/') || path.length > 200)) throw invalid('path', 'Use an app path such as /account/orders');
    return {
      kind: body.kind,
      title: text(body.title, 'title', 80),
      points: wholeIn(body.points, 'points', 1, 1000, 'Points are 1 to 1,000'),
      target: wholeIn(body.target, 'target', 1, 20, 'The target is 1 to 20'),
      path,
    };
  }

  async createTask(body: TaskInput, by: By): Promise<TaskAdmin> {
    const fields = this.taskFields(body);
    const key = keyOf(body.key, fields.title);
    if (!key || !isValidKey(key)) throw invalid('key', 'Use lowercase letters, digits and hyphens');
    const position = body.position ?? (await this.repo.maxTaskPosition()) + 1;
    const row = await this.repo.insertTask({ key, ...fields, visible: body.visible ?? true, position, updated_at: this.now() });
    if (!row) throw this.ctx.error('SLUG_TAKEN', `Another task already uses the key ${key}`, { key });
    await this.audit({ action: 'rewards.task.create', actionLabel: `Added the daily task ${row.title}`, target: { type: 'rewards_task', id: key, label: row.title }, after: row }, by);
    return this.toTaskAdmin(row, 0);
  }

  async updateTask(key: string, body: TaskInput, by: By): Promise<TaskAdmin> {
    const before = await this.repo.getTask(key);
    if (!before) throw notFound('Task');
    const fields = this.taskFields(body);
    const after = (await this.repo.updateTask(key, { ...fields, ...(body.visible != null ? { visible: body.visible } : {}), ...(body.position != null ? { position: body.position } : {}), updated_at: this.now() }))!;
    await this.audit({ action: 'rewards.task.update', actionLabel: `Changed the daily task ${after.title}`, target: { type: 'rewards_task', id: key, label: after.title }, before, after }, by);
    return this.toTaskAdmin(after, (await this.repo.claimedOn(this.today())).get(key) ?? 0);
  }

  async deleteTask(key: string, by: By): Promise<void> {
    const before = await this.repo.getTask(key);
    if (!before) throw notFound('Task');
    await this.repo.deleteTask(key);
    await this.audit({ action: 'rewards.task.delete', actionLabel: `Deleted the daily task ${before.title}`, target: { type: 'rewards_task', id: key, label: before.title }, before }, by);
  }

  /* ---------------------------------------------------------------- admin: rewards */

  async listRewardsAdmin(): Promise<RewardAdmin[]> {
    const rows = await this.repo.listRewards();
    const states = await this.campaigns(rows.map((r) => r.campaign_id));
    return rows.map((r) => this.toRewardAdmin(r, states.get(r.campaign_id)));
  }

  protected toRewardAdmin(r: RewardRow, c: CampaignState | undefined): RewardAdmin {
    return { id: r.id, title: r.title, condition: r.condition, cost: r.cost, tint: tintOf(r.tint), campaignId: r.campaign_id, campaignName: c?.name ?? null, campaignActive: c?.active ?? false, stock: r.stock, redeemed: r.redeemed, visible: r.visible, position: r.position, updatedAt: iso(r.updated_at) };
  }

  protected rewardFields(body: RewardInput) {
    if (body.tint != null && !(TINTS as readonly string[]).includes(body.tint)) throw invalid('tint', 'Choose a colour');
    if (body.stock != null) wholeIn(body.stock, 'stock', 0, 1_000_000, 'Stock is a whole number from 0, or empty for no limit');
    if (!isUuid(body.campaignId)) throw invalid('campaignId', 'Choose a coupon campaign');
    return {
      title: text(body.title, 'title', 40),
      condition: text(body.condition, 'condition', 80),
      cost: wholeIn(body.cost, 'cost', 1, 100_000, 'The cost is 1 to 100,000 points'),
    };
  }

  /** CAMPAIGN_NOT_ACTIVE unless the campaign can give codes (running, or scheduled to start); its state */
  protected async activeCampaign(id: string): Promise<CampaignState> {
    const state = (await this.campaigns([id])).get(id)!;
    if (!state.active) throw this.ctx.error('CAMPAIGN_NOT_ACTIVE', "The coupon campaign behind this reward isn't running.", { campaignId: id });
    return state;
  }

  async createReward(body: RewardInput, by: By): Promise<RewardAdmin> {
    const fields = this.rewardFields(body);
    const state = await this.activeCampaign(body.campaignId);
    const now = this.now();
    const position = body.position ?? (await this.repo.maxRewardPosition()) + 1;
    const row = await this.repo.insertReward({ id: newId(), ...fields, tint: body.tint ?? 'deal', campaign_id: body.campaignId, stock: body.stock ?? null, redeemed: 0, visible: body.visible ?? true, position, created_at: now, updated_at: now });
    await this.audit({ action: 'rewards.reward.create', actionLabel: `Added the reward ${row.title}`, target: { type: 'rewards_reward', id: row.id, label: row.title }, relatedTargets: [{ type: 'promotion_campaign', id: row.campaign_id }], after: row }, by);
    return this.toRewardAdmin(row, state);
  }

  async updateReward(id: string, body: RewardInput, by: By): Promise<RewardAdmin> {
    const before = isUuid(id) ? await this.repo.getReward(id) : undefined;
    if (!before) throw notFound('Reward');
    const fields = this.rewardFields(body);
    const state = body.campaignId !== before.campaign_id ? await this.activeCampaign(body.campaignId) : (await this.campaigns([before.campaign_id])).get(before.campaign_id);
    const after = (await this.repo.updateReward(id, {
      ...fields,
      campaign_id: body.campaignId,
      ...(body.tint != null ? { tint: body.tint } : {}),
      ...(body.stock !== undefined ? { stock: body.stock } : {}),
      ...(body.visible != null ? { visible: body.visible } : {}),
      ...(body.position != null ? { position: body.position } : {}),
      updated_at: this.now(),
    }))!;
    await this.audit({ action: 'rewards.reward.update', actionLabel: `Changed the reward ${after.title}`, target: { type: 'rewards_reward', id, label: after.title }, before, after }, by);
    return this.toRewardAdmin(after, state);
  }

  async deleteReward(id: string, by: By): Promise<void> {
    const before = isUuid(id) ? await this.repo.getReward(id) : undefined;
    if (!before) throw notFound('Reward');
    if (before.redeemed > 0) throw this.ctx.error('IN_USE', 'Customers already redeemed it; hide it instead.', { redeemed: before.redeemed });
    await this.repo.deleteReward(id);
    await this.audit({ action: 'rewards.reward.delete', actionLabel: `Deleted the reward ${before.title}`, target: { type: 'rewards_reward', id, label: before.title }, before }, by);
  }

  /* ---------------------------------------------------------------- admin: redemptions and customers */

  /** Customers by id (customers.getCustomer); empty when customers is off */
  protected async customersById(ids: string[]): Promise<Map<string, customers.CustomerSnapshot>> {
    const api = this.ctx.tryUse('customers');
    const out = new Map<string, customers.CustomerSnapshot>();
    if (!api) return out;
    await Promise.all(
      [...new Set(ids)].map(async (id) => {
        try {
          const c = await api.getCustomer(id);
          if (c) out.set(id, c);
        } catch (err) {
          this.ctx.log.debug({ err, customerId: id }, 'rewards: customer unavailable');
        }
      }),
    );
    return out;
  }

  /** Customer ids whose email or name matches (customers.searchCustomers, first 200) */
  protected async customersMatching(q: string): Promise<string[]> {
    const api = this.ctx.tryUse('customers');
    if (!api) return [];
    const found = await api.searchCustomers({ search: q }, { limit: 200 });
    return found.items.map((c) => c.id);
  }

  async listRedemptionsAdmin(query: { rewardId?: string | null; q?: string | null }, page: PageRequest): Promise<Page<RedemptionAdmin>> {
    const q = query.q?.trim() || undefined;
    const p = await this.repo.pageAdminRedemptions({ rewardId: query.rewardId ?? undefined, q, customerIds: q ? await this.customersMatching(q) : undefined }, page);
    const names = await this.customersById(p.items.map((r) => r.customer_id));
    return {
      ...p,
      items: p.items.map((r) => {
        const c = names.get(r.customer_id);
        return { id: r.id, reward: { id: r.reward_id, title: r.title }, customer: { id: r.customer_id, name: c?.displayName ?? null, email: c?.email ?? null }, cost: r.cost, code: r.code, at: iso(r.at) };
      }),
    };
  }

  protected points(customerId: string, a: AccountRow | undefined, c: customers.CustomerSnapshot | undefined, entries: EntryRow[]): CustomerPoints {
    return {
      customerId,
      name: c?.displayName ?? null,
      email: c?.email ?? null,
      balance: a?.balance ?? 0,
      streak: a ? currentStreak({ streak: a.streak, lastCheckIn: a.last_check_in }, this.today()) : 0,
      lastCheckIn: a?.last_check_in ?? null,
      entries: entries.map((e) => this.toEntry(e)),
    };
  }

  async getCustomerPoints(customerId: string): Promise<CustomerPoints> {
    if (!isUuid(customerId)) throw notFound('Customer');
    const [account, names, entries] = await Promise.all([this.repo.getAccount(customerId), this.customersById([customerId]), this.repo.latestEntries(customerId, 50)]);
    if (!account && !names.has(customerId)) throw notFound('Customer');
    return this.points(customerId, account, names.get(customerId), entries);
  }

  /** Customers with points, highest balance first (the list leaves entries out: getCustomerPoints has them) */
  async searchCustomerPoints(query: { q?: string | null }, page: PageRequest): Promise<Page<CustomerPoints>> {
    const q = query.q?.trim();
    const p = await this.repo.pageAccounts(q ? { customerIds: await this.customersMatching(q) } : {}, page);
    const names = await this.customersById(p.items.map((a) => a.customer_id));
    return { ...p, items: p.items.map((a) => this.points(a.customer_id, a, names.get(a.customer_id), [])) };
  }

  async adjustPoints(body: AdjustmentInput, by: By): Promise<CustomerPoints> {
    if (!isUuid(body.customerId)) throw notFound('Customer');
    const points = wholeIn(body.points, 'points', -100_000, 100_000, 'Points are a whole number from -100,000 to 100,000');
    if (points === 0) throw invalid('points', 'Add or remove at least 1 point');
    const reason = text(body.reason, 'reason', 500);
    const known = Boolean(await this.repo.getAccount(body.customerId)) || (await this.customersById([body.customerId])).has(body.customerId);
    if (!known) throw notFound('Customer');
    const now = this.now();
    const { before, entry } = await this.repo.transaction(async (tx) => {
      const account = await tx.account(body.customerId, now);
      // the balance never goes below 0: removing more than the customer has removes what there is
      const change = Math.max(points, -account.balance);
      if (change === 0) throw invalid('points', 'The customer has no points to remove');
      const id = newId();
      const r = await this.post(tx, account, { points: change, kind: 'adjust', title: change > 0 ? 'Points added by Marketly' : 'Points removed by Marketly', ref: null, dedupeKey: `adjust:${id}`, by });
      return { before: account, entry: r.entry };
    });
    await this.audit(
      {
        action: 'rewards.points.adjust',
        actionLabel: entry.points > 0 ? `Added ${entry.points} Daily rewards points` : `Removed ${-entry.points} Daily rewards points`,
        category: 'customers',
        target: { type: 'customer', id: body.customerId },
        before: { balance: before.balance },
        after: { balance: entry.balance_after, points: entry.points },
        reason,
      },
      by,
    );
    return this.getCustomerPoints(body.customerId);
  }

  /* ---------------------------------------------------------------- public API (in-process) */

  /** The customer's points history, check-ins and redemptions for the personal data export */
  async exportCustomerData(input: { customerId: string; accountId: string }): Promise<common.CustomerDataSection[]> {
    const [account, entries, redemptions] = await Promise.all([this.repo.getAccount(input.customerId), this.repo.allEntries(input.customerId), this.repo.allRedemptions(input.customerId)]);
    if (!account && !entries.length && !redemptions.length) return [];
    return [
      {
        key: 'daily_rewards',
        title: 'Daily rewards',
        module: this.ctx.name,
        records: [
          { type: 'balance', balance: account?.balance ?? 0, streak: account?.streak ?? 0, lastCheckIn: account?.last_check_in ?? null },
          ...entries.map((e) => ({ type: e.kind === 'check_in' ? 'check_in' : 'points', title: e.title, points: e.points, balanceAfter: e.balance_after, at: iso(e.at) })),
          ...redemptions.map((r) => ({ type: 'redemption', title: r.title, condition: r.condition, cost: r.cost, code: r.code, at: iso(r.at) })),
        ],
      },
    ];
  }

  /* ---------------------------------------------------------------- events consumed */

  /** reviews.review.published: Count a write_review task for the author (customerId) on the market day, once per review */
  async onReviewPublishedFromReviews(event: EventPayload<'reviews.review.published'>): Promise<void> {
    if (!event.customerId) return;
    await this.countFromEvent(event.customerId, 'write_review', event.reviewId, 'review');
  }

  /** orders.order.placed: Count a place_order task for the customer on the market day, once per order */
  async onOrderPlacedFromOrders(event: EventPayload<'orders.order.placed'>): Promise<void> {
    if (!event.customerId) return; // guest orders
    await this.countFromEvent(event.customerId, 'place_order', event.orderId, 'order');
  }

  /** Counts the record for every visible task of the kind, once per record and task (a redelivered event changes nothing) */
  protected async countFromEvent(customerId: string, kind: TaskRow['kind'], recordId: string, what: string): Promise<void> {
    const tasks = await this.repo.listTasks({ visibleOnly: true, kind });
    for (const task of tasks) await this.count(customerId, task, recordId, `${what}:${recordId}:${task.key}`);
  }
}
