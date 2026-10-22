/**
 * Play center scores (2026-10-22 decision): customers get a stable player ID; a game partner's server posts their
 * scores with the game's server key (staff make, rotate and revoke keys; only SHA-256 hashes are kept). Rankings of
 * a game with posted scores are worked out from them (each player's best in the period, ties going to whoever reached
 * it first); prize weeks run Monday–Sunday in the market time zone and the hourly job gives each winner a coupon code
 * (promotions.issueCode, idempotent per game, week and winner).
 */
import { SYSTEM_ACTOR } from '../../../kernel/auth/index.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { dateInZone, zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import { addCalendarDays, HOUR, MINUTE } from '../../../kernel/lib/dates.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { Page, PageRequest } from '../../../kernel/lib/pagination.js';
import type { GameKey, GameKeySecret, PlayerLookup, PlayerStats, PlayPlayer, PrizeAward, PrizeWeek, RankingEntry, RankingYou, ScoreInput, ScoreReceipt } from '../../../spec/departments.js';
import { hashServerKey, keyHint, newPlayerCode, newServerKey, normalizePlayerCode, parseRanks, pointsToTop, rankBests, ranksLabel, tierFor, weekOf, weekStarting, type PrizeTier, type WeekInfo } from '../domain/play.js';
import { replyAuthorName, type Period } from '../domain/rules.js';
import type { GameKeyRow, GameRow, PlayerRow, PrizeAwardRow } from '../ports.js';
import { actorKey, invalid, iso, notFound, type By } from './base.js';
import { DepartmentsCompanies } from './companies.js';

/** Active keys a game may have at once (a partner switches keys without missing scores) */
const MAX_ACTIVE_KEYS = 2;
/** Prize weeks the award job looks back over */
const AWARD_LOOKBACK_WEEKS = 4;
/** How far ahead of the server clock a partner's playedAt may be */
const FUTURE_SLACK_MS = 5 * MINUTE;
const MAX_SCORE = 2_000_000_000;

/** A game's prize tiers as stored (snake_case jsonb), read leniently: old rows only have ranks and reward */
export function tiersOf(v: unknown): PrizeTier[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object' && typeof (p as { reward?: unknown }).reward === 'string')
    .map((p) => {
      const from = typeof p.from_rank === 'number' ? p.from_rank : null;
      const to = typeof p.to_rank === 'number' ? p.to_rank : null;
      const parsed = from !== null && to !== null ? ([from, to] as [number, number]) : parseRanks(typeof p.ranks === 'string' ? p.ranks : null);
      return {
        ranks: typeof p.ranks === 'string' && p.ranks ? p.ranks : parsed ? ranksLabel(parsed[0], parsed[1]) : '',
        reward: p.reward as string,
        fromRank: parsed?.[0] ?? null,
        toRank: parsed?.[1] ?? null,
        campaignId: typeof p.campaign_id === 'string' ? p.campaign_id : null,
      };
    });
}

/** Rows of a ranking worked out from scores */
interface RankedRow {
  customerId: string;
  score: number;
  at: Date;
  rank: number;
}

export class DepartmentsScores extends DepartmentsCompanies {
  protected get timeZone(): string {
    return this.ctx.config.market.timeZone || 'America/Los_Angeles';
  }

  /** This prize week (Monday–Sunday, market time) */
  protected currentWeek(): WeekInfo {
    return weekOf(this.now(), this.timeZone);
  }

  protected prizeWeekOut(w: WeekInfo): PrizeWeek {
    return { startsOn: w.startsOn, endsOn: w.endsOn, endsAt: w.endsAt.toISOString(), endsLabel: w.endsLabel };
  }

  protected async maxScoreAgeMs(): Promise<number> {
    const minutes = Number(await this.ctx.settings.get('scoreMaxAgeMinutes'));
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * MINUTE;
  }

  /* ---------------------------------------------------------------- player IDs */

  /**
   * The customer's player ID, issued on first use. `name` is how rankings show them (worked out from customers when
   * not given) and is refreshed when it changed.
   */
  protected async ensurePlayer(customerId: string, o: { accountId?: string | null; name?: string; refresh?: boolean } = {}): Promise<PlayerRow> {
    const existing = await this.repo.playerByCustomer(customerId);
    if (existing && !o.refresh && o.name === undefined) return existing;
    const name = o.name ?? (await this.customerName(customerId, o.accountId));
    if (existing) {
      if (existing.name === name) return existing;
      return (await this.repo.updatePlayer(existing.id, { name, updated_at: this.now() })) ?? existing;
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const now = this.now();
      const row = await this.repo.insertPlayer({ id: newId(), code: newPlayerCode(), customer_id: customerId, name, created_at: now, updated_at: now });
      if (row) return row;
      // the customer got one meanwhile, or the code was taken: look again, then try another code
      const raced = await this.repo.playerByCustomer(customerId);
      if (raced) return raced;
    }
    throw new AppError('INTERNAL_ERROR', 'Could not issue a player ID; try again');
  }

  async getMyPlayer(customerId: string, accountId: string | null): Promise<PlayPlayer> {
    const p = await this.ensurePlayer(customerId, { accountId, refresh: true });
    return { playerId: p.code, name: p.name, gamesPlayed: await this.repo.countScores({ customerId }), createdAt: p.created_at.toISOString() };
  }

  /** Staff: customers by name or email with their player IDs (issued now to customers without one) */
  async findPlayers(q: string): Promise<PlayerLookup[]> {
    const search = q?.trim() ?? '';
    if (search.length < 2) throw invalid('q', 'Type at least 2 characters');
    const customers = this.ctx.tryUse('customers');
    if (!customers) return [];
    const found = await customers.searchCustomers({ search }, { limit: 20 });
    const out: PlayerLookup[] = [];
    for (const c of found.items) {
      const p = await this.ensurePlayer(c.id, { name: replyAuthorName(c.displayName) });
      out.push({ customerId: c.id, name: p.name, playerId: p.code });
    }
    return out;
  }

  /* ---------------------------------------------------------------- server keys */

  private keyOut(k: GameKeyRow): GameKey {
    return { id: k.id, hint: k.hint, status: k.status, createdAt: k.created_at.toISOString(), lastUsedAt: iso(k.last_used_at), revokedAt: iso(k.revoked_at) };
  }

  private async gameOrThrow(id: string): Promise<GameRow> {
    const g = await this.repo.getGame(id);
    if (!g) throw notFound('Game');
    return g;
  }

  async listGameKeys(gameId: string): Promise<GameKey[]> {
    await this.gameOrThrow(gameId);
    return (await this.repo.listKeys(gameId)).map((k) => this.keyOut(k));
  }

  /** A new key; the secret is in the answer only, the row keeps its hash */
  private async issueKey(g: GameRow, by: By): Promise<GameKeySecret> {
    const secret = newServerKey();
    const row: GameKeyRow = { id: newId(), game_id: g.id, key_hash: hashServerKey(secret), hint: keyHint(secret), status: 'active', created_by: actorKey(by.actor), created_at: this.now(), last_used_at: null, revoked_at: null, revoked_by: null };
    await this.repo.insertKey(row);
    return { key: this.keyOut(row), secret };
  }

  async createGameKey(gameId: string, by: By): Promise<GameKeySecret> {
    const g = await this.gameOrThrow(gameId);
    if ((await this.repo.countActiveKeys(g.id)) >= MAX_ACTIVE_KEYS) throw this.ctx.error('TOO_MANY_KEYS', `${g.title} already has ${MAX_ACTIVE_KEYS} active server keys; revoke or rotate one`);
    const out = await this.issueKey(g, by);
    await this.audit({ action: 'departments.play.key.create', actionLabel: 'Made a game server key', target: { type: 'game', id: g.id, label: g.title }, after: { keyId: out.key.id, hint: out.key.hint } }, by);
    return out;
  }

  private async activeKey(gameId: string, keyId: string): Promise<{ g: GameRow; k: GameKeyRow }> {
    const g = await this.gameOrThrow(gameId);
    const k = await this.repo.getKey(keyId);
    if (!k || k.game_id !== g.id) throw notFound('Key');
    if (k.status !== 'active') throw this.ctx.error('ILLEGAL_TRANSITION', 'This key was already revoked', { from: k.status, event: 'revoke' });
    return { g, k };
  }

  async revokeGameKey(gameId: string, keyId: string, by: By): Promise<GameKey> {
    const { g, k } = await this.activeKey(gameId, keyId);
    const after = (await this.repo.updateKey(k.id, { status: 'revoked', revoked_at: this.now(), revoked_by: actorKey(by.actor) }))!;
    await this.audit({ action: 'departments.play.key.revoke', actionLabel: 'Revoked a game server key', target: { type: 'game', id: g.id, label: g.title }, before: { keyId: k.id, hint: k.hint, status: 'active' }, after: { status: 'revoked' } }, by);
    return this.keyOut(after);
  }

  /** The old key stops working now; the new one is shown once */
  async rotateGameKey(gameId: string, keyId: string, by: By): Promise<GameKeySecret> {
    const { g, k } = await this.activeKey(gameId, keyId);
    await this.repo.updateKey(k.id, { status: 'revoked', revoked_at: this.now(), revoked_by: actorKey(by.actor) });
    const out = await this.issueKey(g, by);
    await this.audit({ action: 'departments.play.key.rotate', actionLabel: 'Rotated a game server key', target: { type: 'game', id: g.id, label: g.title }, before: { keyId: k.id, hint: k.hint }, after: { keyId: out.key.id, hint: out.key.hint } }, by);
    return out;
  }

  /**
   * The game an X-Game-Key header belongs to (the webhook verifier calls it): null for a missing, unknown or revoked
   * key. Marks when the key was last used (at most once a minute).
   */
  async gameOfKey(secret: string | undefined): Promise<string | null> {
    if (!secret || secret.length > 200) return null;
    const k = await this.repo.keyByHash(hashServerKey(secret.trim()));
    if (!k || k.status !== 'active') return null;
    const now = this.now();
    if (!k.last_used_at || now.getTime() - k.last_used_at.getTime() > MINUTE) await this.repo.updateKey(k.id, { last_used_at: now }).catch(() => undefined);
    return k.game_id;
  }

  /* ---------------------------------------------------------------- posting scores */

  private async receipt(row: { id: string; partner_score_id: string; score: number; played_at: Date; game_id: string; customer_id: string }, code: string, duplicate: boolean): Promise<ScoreReceipt> {
    const [all, week] = await Promise.all([this.repo.bests(row.game_id, { customerId: row.customer_id }), this.repo.bests(row.game_id, { week: this.currentWeek().startsOn })]);
    const me = rankBests(week).find((r) => r.customerId === row.customer_id);
    return { id: row.id, scoreId: row.partner_score_id, playerId: code, score: row.score, playedAt: row.played_at.toISOString(), duplicate, best: all[0]?.score ?? row.score, weekRank: me?.rank ?? null };
  }

  /** A partner's score for the game its key belongs to; the partner's scoreId makes it safe to repeat */
  async postGameScore(gameId: string, input: ScoreInput): Promise<ScoreReceipt> {
    const scoreId = String(input.scoreId ?? '').trim();
    if (!scoreId || scoreId.length > 100) throw invalid('scoreId', 'Send your own id of the score (1 to 100 characters)');
    if (!Number.isInteger(input.score) || input.score < 0 || input.score > MAX_SCORE) throw invalid('score', 'Send a whole number of 0 or more');
    const code = normalizePlayerCode(input.playerId);
    const player = code ? await this.repo.playerByCode(code) : undefined;
    const g = await this.repo.getGame(gameId);
    if (!g) throw notFound('Game');
    const existing = await this.repo.scoreByPartnerId(g.id, scoreId);
    if (existing) {
      if (!player || existing.player_id !== player.id || existing.score !== input.score) throw this.ctx.error('SCORE_ID_REUSED', 'This scoreId was already used for another player or score');
      return this.receipt(existing, player.code, true);
    }
    if (!player) throw this.ctx.error('UNKNOWN_PLAYER', 'No customer has this player ID', { playerId: input.playerId });
    if (g.status !== 'published') throw this.ctx.error('GAME_NOT_ACTIVE', `${g.title} is not taking scores`);
    const now = this.now();
    const playedAt = input.playedAt ? new Date(input.playedAt) : now;
    if (Number.isNaN(playedAt.getTime())) throw invalid('playedAt', 'Send an ISO 8601 time');
    if (playedAt.getTime() > now.getTime() + FUTURE_SLACK_MS || playedAt.getTime() < now.getTime() - (await this.maxScoreAgeMs())) {
      throw this.ctx.error('SCORE_TOO_OLD', 'Scores must be posted within the allowed time after the game ends', { playedAt: playedAt.toISOString() });
    }
    const day = dateInZone(playedAt, this.timeZone);
    const row = { id: newId(), game_id: g.id, partner_score_id: scoreId, player_id: player.id, customer_id: player.customer_id, score: input.score, played_at: playedAt, day, week: weekOf(playedAt, this.timeZone).startsOn, received_at: now };
    const saved = await this.repo.insertScore(row);
    if (!saved) {
      // the same scoreId arrived twice at once: answer as the repeat it is
      const first = await this.repo.scoreByPartnerId(g.id, scoreId);
      if (first && first.player_id === player.id && first.score === input.score) return this.receipt(first, player.code, true);
      throw this.ctx.error('SCORE_ID_REUSED', 'This scoreId was already used for another player or score');
    }
    return this.receipt(saved, player.code, false);
  }

  /* ---------------------------------------------------------------- rankings from scores */

  /** Each player's best in a period, ranked; and the ranks they had at the baseline (for change) */
  protected async rankedFor(g: GameRow, period: Period): Promise<{ ranked: RankedRow[]; before: Map<string, number> }> {
    const now = this.now();
    const today = dateInZone(now, this.timeZone);
    const window = period === 'today' ? { day: today } : period === 'week' ? { week: this.currentWeek().startsOn } : {};
    // places moved since the start of today (since an hour ago for today's table)
    const baselineAt = period === 'today' ? new Date(now.getTime() - HOUR) : zonedTimeToUtc(today, '00:00', this.timeZone);
    const [cur, base] = await Promise.all([this.repo.bests(g.id, window), this.repo.bests(g.id, { ...window, before: baselineAt })]);
    return { ranked: rankBests(cur), before: new Map(rankBests(base).map((r) => [r.customerId, r.rank])) };
  }

  /** Names of players by customer id */
  protected async playerNames(customerIds: string[]): Promise<Map<string, string>> {
    return new Map((await this.repo.playersByCustomers([...new Set(customerIds)])).map((p) => [p.customer_id, p.name]));
  }

  /** A table worked out from posted scores: top 100, or the players matching q with their real ranks */
  protected async scoreTable(g: GameRow, period: Period, customerId: string | null, q?: string): Promise<{ entries: RankingEntry[]; playerCount: number; updatedAt: string | null; you: RankingYou | null }> {
    const { ranked, before } = await this.rankedFor(g, period);
    const search = q?.trim().toLowerCase();
    const names = await this.playerNames(search ? ranked.map((r) => r.customerId) : [...ranked.slice(0, 100).map((r) => r.customerId), ...(customerId ? [customerId] : [])]);
    const nameOf = (id: string) => names.get(id) ?? 'Player';
    const rows = search ? ranked.filter((r) => nameOf(r.customerId).toLowerCase().includes(search)).slice(0, 100) : ranked.slice(0, 100);
    const entries = rows.map((r) => {
      const was = before.get(r.customerId);
      return { rank: r.rank, name: nameOf(r.customerId), score: r.score, change: was === undefined ? null : was - r.rank, mine: Boolean(customerId && r.customerId === customerId) };
    });
    let you: RankingYou | null = null;
    if (customerId) {
      const me = ranked.find((r) => r.customerId === customerId);
      const name = names.get(customerId) ?? (await this.repo.playerByCustomer(customerId))?.name ?? 'You';
      you = { rank: me?.rank ?? null, score: me?.score ?? null, name, pointsToTop100: pointsToTop(ranked, customerId) };
    }
    const latest = ranked.reduce<Date | null>((m, r) => (!m || r.at > m ? r.at : m), null);
    return { entries, playerCount: ranked.length, updatedAt: iso(latest), you };
  }

  /** The customer's numbers on a game page: best, this week's best and rank, games played, points to the top 100 */
  protected async playerStats(g: GameRow, customerId: string, accountId: string | null): Promise<PlayerStats> {
    const player = await this.ensurePlayer(customerId, { accountId });
    const [all, week, played] = await Promise.all([this.repo.bests(g.id, { customerId }), this.repo.bests(g.id, { week: this.currentWeek().startsOn }), this.repo.countScores({ gameId: g.id, customerId })]);
    const ranked = rankBests(week);
    const me = ranked.find((r) => r.customerId === customerId);
    return { playerId: player.code, best: all[0]?.score ?? null, weekBest: me?.score ?? null, weekRank: me?.rank ?? null, gamesPlayed: played, pointsToTop100: pointsToTop(ranked, customerId) };
  }

  /* ---------------------------------------------------------------- prize weeks */

  /**
   * The hourly job: settles every prize week (of the last few) that ended at least scoreMaxAgeMinutes ago, for each
   * game whose tiers name coupon campaigns. Winners whose code could not be issued are tried again next hour.
   */
  async awardPrizeWeeks(): Promise<{ weeks: number; issued: number; failed: number }> {
    const out = { weeks: 0, issued: 0, failed: 0 };
    const promotions = this.ctx.tryUse('promotions');
    if (!promotions) return out;
    const grace = await this.maxScoreAgeMs();
    const now = this.now();
    const current = this.currentWeek();
    for (const g of await this.repo.listGames()) {
      const tiers = tiersOf(g.prizes).filter((t) => t.campaignId && t.fromRank !== null && t.toRank !== null);
      if (!tiers.length || !(await this.repo.hasScores(g.id))) continue;
      for (let k = AWARD_LOOKBACK_WEEKS; k >= 1; k--) {
        const week = weekStarting(addCalendarDays(current.startsOn, -7 * k), this.timeZone);
        if (week.endsAt.getTime() + grace > now.getTime()) continue;
        if ((await this.repo.getPrizeWeek(g.id, week.startsOn))?.state === 'done') continue;
        const r = await this.awardWeek(g, tiers, week);
        out.weeks++;
        out.issued += r.issued;
        out.failed += r.failed;
      }
    }
    return out;
  }

  private async awardWeek(g: GameRow, tiers: PrizeTier[], week: WeekInfo): Promise<{ issued: number; failed: number }> {
    const promotions = this.ctx.tryUse('promotions');
    if (!promotions) return { issued: 0, failed: 0 };
    const ranked = rankBests(await this.repo.bests(g.id, { week: week.startsOn }));
    const winners = ranked.map((r) => ({ r, tier: tierFor(tiers, r.rank) })).filter((w): w is { r: RankedRow; tier: PrizeTier } => Boolean(w.tier));
    const names = await this.playerNames(winners.map((w) => w.r.customerId));
    let issued = 0;
    let failed = 0;
    for (const { r, tier } of winners) {
      const now = this.now();
      let award: PrizeAwardRow | undefined = await this.repo.awardOf(g.id, week.startsOn, r.customerId);
      if (award?.state === 'issued') continue;
      if (!award) {
        award = await this.repo.insertAward({ id: newId(), game_id: g.id, week: week.startsOn, customer_id: r.customerId, name: names.get(r.customerId) ?? 'Player', rank: r.rank, score: r.score, reward: tier.reward, campaign_id: tier.campaignId!, code: null, code_id: null, state: 'failed', error: 'Not issued yet', created_at: now, updated_at: now });
        award ??= await this.repo.awardOf(g.id, week.startsOn, r.customerId);
        if (!award || award.state === 'issued') continue;
      }
      try {
        const coupon = await promotions.issueCode(award.campaign_id, award.customer_id, `play:${g.id}:${week.startsOn}:${award.customer_id}`);
        await this.repo.updateAward(award.id, { state: 'issued', code: coupon.code, code_id: coupon.codeId, error: null, updated_at: this.now() });
        this.ctx.events.publish('departments.play.prize_awarded', { customerId: award.customer_id, gameId: g.id, gameSlug: g.slug, gameTitle: g.title, week: week.startsOn, rank: award.rank, reward: award.reward, code: coupon.code, codeEndsAt: coupon.endsAt ?? null }, { actor: SYSTEM_ACTOR });
        issued++;
      } catch (err) {
        const message = isAppError(err) ? `${err.code}: ${err.message}` : 'The coupon could not be issued';
        await this.repo.updateAward(award.id, { state: 'failed', error: message.slice(0, 300), updated_at: this.now() });
        this.ctx.log.warn({ err, gameId: g.id, week: week.startsOn, customerId: award.customer_id }, 'departments: prize coupon not issued');
        failed++;
      }
    }
    await this.repo.savePrizeWeek({ id: newId(), game_id: g.id, week: week.startsOn, state: failed ? 'awarding' : 'done', winners: winners.length, updated_at: this.now() });
    return { issued, failed };
  }

  private awardOut(a: PrizeAwardRow): PrizeAward {
    return { id: a.id, gameId: a.game_id, week: a.week, customerId: a.customer_id, name: a.name, rank: a.rank, score: a.score, reward: a.reward, campaignId: a.campaign_id, code: a.code, state: a.state, error: a.state === 'failed' ? a.error : null, at: a.updated_at.toISOString() };
  }

  async listPrizeAwards(gameId: string, q: { week?: string; state?: 'issued' | 'failed' }, page: PageRequest): Promise<Page<PrizeAward>> {
    await this.gameOrThrow(gameId);
    const res = await this.repo.pageAwards(gameId, q, page);
    return { ...res, items: res.items.map((a) => this.awardOut(a)) };
  }
}
