/**
 * Play center: games staff describe (with prize tiers linked to promotions coupon campaigns), reviews, and the ranking
 * tables: worked out from the scores a game's partner posts (service/scores.ts), else the table staff keep per period
 * (today, week, all time). Games are not played inside the app (Game.playable is false).
 */
import { newId } from '../../../kernel/lib/ids.js';
import type { Page, PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { DeptReview, Game, GameAdmin, GameCard, GameInput, GamePrize, GamePrizeAdmin, PlayGames, RankingEntry, RankingInput, RankingTable, RatingSummary, ReviewInput } from '../../../spec/departments.js';
import { parseRanks, playersLabel, ranksLabel, type PrizeTier } from '../domain/play.js';
import { genresOf, LIMITS, PERIODS, rankRows, type Period } from '../domain/rules.js';
import type { GameRow } from '../ports.js';
import { actorKey, invalid, iso, mediaOf, notFound, optionalText, requireText, type By } from './base.js';
import { DepartmentsScores, tiersOf } from './scores.js';

const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const entriesOf = (v: unknown): RankingEntry[] => (Array.isArray(v) ? (v as RankingEntry[]).filter((e) => e && typeof e.name === 'string' && typeof e.score === 'number') : []);
const prizeOut = (t: PrizeTier): GamePrize => ({ ranks: t.ranks, reward: t.reward, fromRank: t.fromRank, toRank: t.toRank });

/** The extras a list of game cards shows: pictures, ratings and this week's players */
interface GameContext {
  refs: Map<string, common.MediaRef>;
  ratings: Map<string, RatingSummary>;
  players: Map<string, number>;
}

export class DepartmentsPlay extends DepartmentsScores {
  private gameCard(g: GameRow, x: GameContext): GameCard {
    const icon = mediaOf(g.icon);
    const cover = mediaOf(g.cover);
    const rating = x.ratings.get(g.id);
    return {
      id: g.id,
      slug: g.slug,
      title: g.title,
      genre: g.genre,
      icon: icon ? (x.refs.get(icon.id) ?? null) : null,
      cover: cover ? (x.refs.get(cover.id) ?? null) : null,
      // staff's label wins; a game with posted scores counts this week's players
      playersLabel: g.players_label ?? playersLabel(x.players.get(g.id) ?? 0),
      featured: g.featured,
      hasPrizes: tiersOf(g.prizes).length > 0,
      rating: rating?.average ?? null,
      ratingCount: rating?.count ?? 0,
    };
  }

  private async gameContext(games: GameRow[]): Promise<GameContext> {
    const ids = games.map((g) => g.id);
    const [refs, ratings, players] = await Promise.all([this.refsMap(games.flatMap((g) => [mediaOf(g.icon)?.id, mediaOf(g.cover)?.id])), this.ratingsOf('game', ids), this.repo.weekPlayerCounts(ids, this.currentWeek().startsOn)]);
    return { refs, ratings, players };
  }

  /** Tiers as staff see them: with the campaign's name and whether it can give codes now */
  private async prizesAdmin(tiers: PrizeTier[]): Promise<GamePrizeAdmin[]> {
    const promotions = this.ctx.tryUse('promotions');
    return Promise.all(
      tiers.map(async (t) => {
        let campaignName: string | null = null;
        let campaignActive = false;
        if (t.campaignId && promotions) {
          const [state, pub] = await Promise.all([this.soft('promotions.isCampaignActive', () => promotions.isCampaignActive(t.campaignId!), { active: false } as { active: boolean; reason?: string }), this.soft('promotions.getPublicCampaign', () => promotions.getPublicCampaign(t.campaignId!), null)]);
          campaignActive = state.active || state.reason === 'not_started';
          campaignName = pub?.name ?? null;
        }
        return { ranks: t.ranks, reward: t.reward, fromRank: t.fromRank, toRank: t.toRank, campaignId: t.campaignId, campaignName, campaignActive };
      }),
    );
  }

  private async gamesAdmin(rows: GameRow[]): Promise<GameAdmin[]> {
    const ids = rows.map((g) => g.id);
    const [x, updated, scores, keys] = await Promise.all([this.gameContext(rows), this.repo.rankingsUpdatedAt(ids), this.repo.scoreCounts(ids), this.repo.activeKeyCounts(ids)]);
    return Promise.all(
      rows.map(async (g) => {
        const card = this.gameCard(g, x);
        return {
          id: g.id,
          slug: g.slug,
          title: g.title,
          genre: g.genre,
          icon: card.icon ?? null,
          cover: card.cover ?? null,
          playersLabel: g.players_label,
          featured: g.featured,
          description: g.description,
          howToPlay: stringsOf(g.how_to_play),
          prizes: await this.prizesAdmin(tiersOf(g.prizes)),
          prizeNote: g.prize_note ?? null,
          status: g.status as GameAdmin['status'],
          position: g.position,
          rankingsUpdatedAt: iso(updated.get(g.id)),
          rating: card.rating ?? null,
          ratingCount: card.ratingCount,
          scoresLive: (scores.get(g.id) ?? 0) > 0,
          scoreCount: scores.get(g.id) ?? 0,
          activeKeyCount: keys.get(g.id) ?? 0,
          createdAt: g.created_at.toISOString(),
          updatedAt: g.updated_at.toISOString(),
        };
      }),
    );
  }

  async listGames(q: { genre?: string; q?: string }): Promise<PlayGames> {
    const all = await this.repo.listGames({ publishedOnly: true });
    const search = q.q?.trim().toLowerCase();
    const games = all.filter((g) => (!q.genre || g.genre.toLowerCase() === q.genre.toLowerCase()) && (!search || g.title.toLowerCase().includes(search) || g.genre.toLowerCase().includes(search)));
    const x = await this.gameContext(games);
    return { games: games.map((g) => this.gameCard(g, x)), genres: genresOf(all) };
  }

  private async publishedGame(slug: string): Promise<GameRow> {
    const g = await this.repo.gameBySlug(slug);
    if (!g || g.status !== 'published') throw notFound('Game');
    return g;
  }

  /** A game page; for a signed-in customer (customers-module id) also their review and numbers */
  async getGame(slug: string, customerId: string | null = null, accountId: string | null = customerId): Promise<Game> {
    const g = await this.publishedGame(slug);
    const [x, mine, you, scoresLive] = await Promise.all([this.gameContext([g]), this.myReviewOf('game', g.id, customerId), customerId ? this.playerStats(g, customerId, accountId) : Promise.resolve(null), this.repo.hasScores(g.id)]);
    const card = this.gameCard(g, x);
    return {
      ...card,
      ratingSummary: x.ratings.get(g.id) ?? { average: null, count: 0, stars: [0, 0, 0, 0, 0] },
      myReview: mine,
      description: g.description,
      howToPlay: stringsOf(g.how_to_play),
      prizes: tiersOf(g.prizes).map(prizeOut),
      prizeNote: g.prize_note ?? null,
      week: this.prizeWeekOut(this.currentWeek()),
      scoresLive,
      you,
      playable: false,
    };
  }

  async listGamesAdmin(): Promise<GameAdmin[]> {
    return this.gamesAdmin(await this.repo.listGames());
  }

  /** Prize tiers as stored: ranks worked out both ways, campaigns checked with promotions */
  private async tiersFrom(input: GameInput['prizes']): Promise<Record<string, unknown>[]> {
    const list = input ?? [];
    if (list.length > 10) throw invalid('prizes', 'Use at most 10 prizes');
    const promotions = this.ctx.tryUse('promotions');
    const out: Record<string, unknown>[] = [];
    const taken: [number, number][] = [];
    for (const [i, p] of list.entries()) {
      const reward = requireText(p.reward, `prizes[${i}].reward`, 60, 'Say what they win');
      let range: [number, number] | null = null;
      if (p.fromRank != null || p.toRank != null) {
        const from = p.fromRank ?? p.toRank!;
        const to = p.toRank ?? from;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > LIMITS.rankingRows) throw invalid(`prizes[${i}].fromRank`, `Use ranks from 1 to ${LIMITS.rankingRows}, the first no higher than the last`);
        range = [from, to];
      } else {
        range = parseRanks(p.ranks);
        if (!range && !p.ranks?.trim()) throw invalid(`prizes[${i}].ranks`, 'Say which ranks win, e.g. #1');
      }
      if (range && taken.some(([a, b]) => range![0] <= b && range![1] >= a)) throw invalid(`prizes[${i}].fromRank`, 'Prize tiers must not share ranks');
      if (range) taken.push(range);
      const ranks = p.ranks?.trim() ? requireText(p.ranks, `prizes[${i}].ranks`, 20) : ranksLabel(range![0], range![1]);
      let campaignId: string | null = null;
      if (p.campaignId) {
        if (!range) throw invalid(`prizes[${i}].fromRank`, 'Give the ranks as numbers to link a coupon campaign');
        if (!promotions) throw invalid(`prizes[${i}].campaignId`, 'Promotions is turned off');
        const state = await promotions.isCampaignActive(p.campaignId);
        if (state.reason === 'not_found') throw invalid(`prizes[${i}].campaignId`, 'Coupon campaign not found');
        campaignId = p.campaignId;
      }
      out.push({ ranks, reward, from_rank: range?.[0] ?? null, to_rank: range?.[1] ?? null, campaign_id: campaignId });
    }
    return out;
  }

  /** The checked parts of a game input */
  private async gameFields(input: GameInput) {
    const howToPlay = (input.howToPlay ?? []).map((s) => s.trim()).filter(Boolean);
    if (howToPlay.length > 10) throw invalid('howToPlay', 'Use at most 10 steps');
    howToPlay.forEach((s, i) => {
      if (s.length > 200) throw invalid(`howToPlay[${i}]`, 'Use at most 200 characters');
    });
    return {
      title: requireText(input.title, 'title', LIMITS.name, 'Name the game'),
      genre: requireText(input.genre, 'genre', 40, 'Give the genre, e.g. Puzzle'),
      icon: input.icon?.id ? { id: input.icon.id } : null,
      cover: input.cover?.id ? { id: input.cover.id } : null,
      players_label: optionalText(input.playersLabel, 'playersLabel', 60),
      description: optionalText(input.description, 'description', 3000),
      how_to_play: howToPlay,
      prizes: await this.tiersFrom(input.prizes),
      prize_note: optionalText(input.prizeNote, 'prizeNote', 200),
    };
  }

  private filesOfGame(f: { icon: { id: string } | null; cover: { id: string } | null }) {
    return [...(f.icon ? [{ id: f.icon.id, path: 'icon' }] : []), ...(f.cover ? [{ id: f.cover.id, path: 'cover' }] : [])];
  }

  async createGame(input: GameInput, by: By): Promise<GameAdmin> {
    const f = await this.gameFields(input);
    const id = newId();
    const now = this.now();
    const row: GameRow = { id, slug: await this.slugFor('games', input.slug, f.title), ...f, prizes: f.prizes as never, featured: input.featured ?? false, status: input.status ?? 'published', position: input.position ?? (await this.repo.nextGamePosition()), created_at: now, updated_at: now };
    await this.withMedia(id, f.title, [], this.filesOfGame(f), () => this.repo.insertGame(row));
    await this.audit({ action: 'departments.play.game.create', actionLabel: 'Added a game', target: { type: 'game', id, label: f.title }, after: row }, by);
    return (await this.gamesAdmin([row]))[0]!;
  }

  async updateGame(id: string, input: GameInput, by: By): Promise<GameAdmin> {
    const before = await this.repo.getGame(id);
    if (!before) throw notFound('Game');
    const f = await this.gameFields(input);
    const slug = input.slug !== undefined && input.slug !== null ? await this.slugFor('games', input.slug, f.title, id) : before.slug;
    const prev = [mediaOf(before.icon), mediaOf(before.cover)].filter((m): m is { id: string } => Boolean(m));
    const patch: Partial<GameRow> = { ...f, prizes: f.prizes as never, slug, featured: input.featured ?? before.featured, status: input.status ?? before.status, position: input.position ?? before.position, updated_at: this.now() };
    const after = await this.withMedia(id, f.title, prev, this.filesOfGame(f), async () => (await this.repo.updateGame(id, patch))!);
    await this.audit({ action: 'departments.play.game.update', actionLabel: after.status !== before.status ? (after.status === 'hidden' ? 'Hid a game' : 'Showed a game again') : 'Edited a game', target: { type: 'game', id, label: f.title }, before, after }, by);
    return (await this.gamesAdmin([after]))[0]!;
  }

  async deleteGame(id: string, by: By): Promise<void> {
    const g = await this.repo.getGame(id);
    if (!g) throw notFound('Game');
    await this.repo.transaction((tx) => tx.deleteGameCascade(id));
    await this.detachAll(id, [mediaOf(g.icon), mediaOf(g.cover)].filter((m): m is { id: string } => Boolean(m)));
    await this.audit({ action: 'departments.play.game.delete', actionLabel: 'Deleted a game', target: { type: 'game', id, label: g.title }, before: g }, by);
  }

  /* ---------------------------------------------------------------- reviews */

  async listGameReviews(slug: string, customerId: string | null, q: { stars?: number }, page: PageRequest): Promise<Page<DeptReview>> {
    const g = await this.publishedGame(slug);
    return this.pageReviewsOf('game', g.id, customerId, q.stars, page);
  }

  async reviewGame(slug: string, customerId: string, accountId: string | null, input: ReviewInput): Promise<DeptReview> {
    const g = await this.publishedGame(slug);
    return this.writeReview('game', g.id, customerId, accountId, input);
  }

  /* ---------------------------------------------------------------- rankings */

  /** A game's table: from posted scores when the game has any, else the one staff keep */
  private async table(g: GameRow, period: Period, o: { customerId?: string | null; q?: string } = {}): Promise<RankingTable> {
    const [x, live] = await Promise.all([this.gameContext([g]), this.repo.hasScores(g.id)]);
    const week = this.prizeWeekOut(this.currentWeek());
    const game = this.gameCard(g, x);
    if (live) {
      const t = await this.scoreTable(g, period, o.customerId ?? null, o.q);
      return { game, period, entries: t.entries, updatedAt: t.updatedAt, source: 'scores', playerCount: t.playerCount, week, you: t.you };
    }
    const row = await this.repo.getRanking(g.id, period);
    const all = entriesOf(row?.entries);
    const search = o.q?.trim().toLowerCase();
    const entries = search ? all.filter((e) => e.name.toLowerCase().includes(search)) : all;
    return { game, period, entries, updatedAt: iso(row?.updated_at), source: 'staff', playerCount: all.length, week, you: null };
  }

  /** The store's table: the named published game, else the first one; the week unless a period is given */
  async getRankings(q: { game?: string; period?: Period; q?: string }, customerId: string | null = null): Promise<RankingTable> {
    const g = q.game ? await this.repo.gameBySlug(q.game) : (await this.repo.listGames({ publishedOnly: true }))[0];
    if (!g || g.status !== 'published') throw notFound('Game');
    return this.table(g, q.period ?? 'week', { customerId, q: q.q });
  }

  async getRankingsAdmin(gameId: string, period: Period): Promise<RankingTable> {
    const g = await this.repo.getGame(gameId);
    if (!g) throw notFound('Game');
    return this.table(g, period);
  }

  async setRankings(gameId: string, period: Period, input: RankingInput, by: By): Promise<RankingTable> {
    const g = await this.repo.getGame(gameId);
    if (!g) throw notFound('Game');
    if (!PERIODS.includes(period)) throw invalid('period', 'Use today, week or all_time');
    const rows = input.entries ?? [];
    if (rows.length > LIMITS.rankingRows) throw invalid('entries', `Use at most ${LIMITS.rankingRows} rows`);
    const clean = rows.map((r, i) => {
      if (!Number.isInteger(r.score) || r.score < 0) throw invalid(`entries[${i}].score`, 'Use a whole number of 0 or more');
      if (r.change != null && !Number.isInteger(r.change)) throw invalid(`entries[${i}].change`, 'Use a whole number');
      return { name: requireText(r.name, `entries[${i}].name`, 40, 'Name the player'), score: r.score, change: r.change ?? null };
    });
    const before = await this.repo.getRanking(g.id, period);
    const entries = rankRows(clean);
    await this.repo.saveRanking({ id: before?.id ?? newId(), game_id: g.id, period, entries, updated_by: actorKey(by.actor), updated_at: this.now() });
    await this.audit({ action: 'departments.play.rankings.set', actionLabel: `Updated the ${period === 'all_time' ? 'all-time' : period === 'week' ? 'weekly' : "today's"} rankings`, target: { type: 'game', id: g.id, label: g.title }, before: { entries: entriesOf(before?.entries).length }, after: { entries: entries.length } }, by);
    return this.table(g, period);
  }
}
