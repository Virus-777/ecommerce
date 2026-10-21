/**
 * Play center (list only at this phase): games staff describe, and the ranking tables they keep per game and period
 * (today, week, all time). Game.playable is false until playing and score submission come.
 */
import { newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { Game, GameAdmin, GameCard, GameInput, GamePrize, PlayGames, RankingEntry, RankingInput, RankingTable } from '../../../spec/departments.js';
import { genresOf, LIMITS, PERIODS, rankRows, type Period } from '../domain/rules.js';
import type { GameRow } from '../ports.js';
import { actorKey, invalid, iso, mediaOf, notFound, optionalText, requireText, type By } from './base.js';
import { DepartmentsCompanies } from './companies.js';

const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const prizesOf = (v: unknown): GamePrize[] => (Array.isArray(v) ? v.filter((p): p is GamePrize => Boolean(p) && typeof p.ranks === 'string' && typeof p.reward === 'string').map((p) => ({ ranks: p.ranks, reward: p.reward })) : []);
const entriesOf = (v: unknown): RankingEntry[] => (Array.isArray(v) ? (v as RankingEntry[]).filter((e) => e && typeof e.name === 'string' && typeof e.score === 'number') : []);

export class DepartmentsPlay extends DepartmentsCompanies {
  private gameCard(g: GameRow, refs: Map<string, common.MediaRef>): GameCard {
    const icon = mediaOf(g.icon);
    const cover = mediaOf(g.cover);
    return { id: g.id, slug: g.slug, title: g.title, genre: g.genre, icon: icon ? (refs.get(icon.id) ?? null) : null, cover: cover ? (refs.get(cover.id) ?? null) : null, playersLabel: g.players_label, featured: g.featured, hasPrizes: prizesOf(g.prizes).length > 0 };
  }

  private refsOfGames(games: GameRow[]) {
    return this.refsMap(games.flatMap((g) => [mediaOf(g.icon)?.id, mediaOf(g.cover)?.id]));
  }

  private async gamesAdmin(rows: GameRow[]): Promise<GameAdmin[]> {
    const [refs, updated] = await Promise.all([this.refsOfGames(rows), this.repo.rankingsUpdatedAt(rows.map((g) => g.id))]);
    return rows.map((g) => {
      const card = this.gameCard(g, refs);
      return { id: g.id, slug: g.slug, title: g.title, genre: g.genre, icon: card.icon ?? null, cover: card.cover ?? null, playersLabel: g.players_label, featured: g.featured, description: g.description, howToPlay: stringsOf(g.how_to_play), prizes: prizesOf(g.prizes), status: g.status as GameAdmin['status'], position: g.position, rankingsUpdatedAt: iso(updated.get(g.id)), createdAt: g.created_at.toISOString(), updatedAt: g.updated_at.toISOString() };
    });
  }

  async listGames(q: { genre?: string }): Promise<PlayGames> {
    const all = await this.repo.listGames({ publishedOnly: true });
    const games = q.genre ? all.filter((g) => g.genre.toLowerCase() === q.genre!.toLowerCase()) : all;
    const refs = await this.refsOfGames(games);
    return { games: games.map((g) => this.gameCard(g, refs)), genres: genresOf(all) };
  }

  async getGame(slug: string): Promise<Game> {
    const g = await this.repo.gameBySlug(slug);
    if (!g || g.status !== 'published') throw notFound('Game');
    const card = this.gameCard(g, await this.refsOfGames([g]));
    return { ...card, description: g.description, howToPlay: stringsOf(g.how_to_play), prizes: prizesOf(g.prizes), playable: false };
  }

  async listGamesAdmin(): Promise<GameAdmin[]> {
    return this.gamesAdmin(await this.repo.listGames());
  }

  /** The checked parts of a game input */
  private gameFields(input: GameInput) {
    const howToPlay = (input.howToPlay ?? []).map((s) => s.trim()).filter(Boolean);
    if (howToPlay.length > 10) throw invalid('howToPlay', 'Use at most 10 steps');
    howToPlay.forEach((s, i) => {
      if (s.length > 200) throw invalid(`howToPlay[${i}]`, 'Use at most 200 characters');
    });
    const prizes = (input.prizes ?? []).map((p, i) => ({ ranks: requireText(p.ranks, `prizes[${i}].ranks`, 20, 'Say which ranks win, e.g. #1'), reward: requireText(p.reward, `prizes[${i}].reward`, 60, 'Say what they win') }));
    if (prizes.length > 10) throw invalid('prizes', 'Use at most 10 prizes');
    return {
      title: requireText(input.title, 'title', LIMITS.name, 'Name the game'),
      genre: requireText(input.genre, 'genre', 40, 'Give the genre, e.g. Puzzle'),
      icon: input.icon?.id ? { id: input.icon.id } : null,
      cover: input.cover?.id ? { id: input.cover.id } : null,
      players_label: optionalText(input.playersLabel, 'playersLabel', 60),
      description: optionalText(input.description, 'description', 3000),
      how_to_play: howToPlay,
      prizes,
    };
  }

  private filesOfGame(f: { icon: { id: string } | null; cover: { id: string } | null }) {
    return [...(f.icon ? [{ id: f.icon.id, path: 'icon' }] : []), ...(f.cover ? [{ id: f.cover.id, path: 'cover' }] : [])];
  }

  async createGame(input: GameInput, by: By): Promise<GameAdmin> {
    const f = this.gameFields(input);
    const id = newId();
    const now = this.now();
    const row: GameRow = { id, slug: await this.slugFor('games', input.slug, f.title), ...f, featured: input.featured ?? false, status: input.status ?? 'published', position: input.position ?? (await this.repo.nextGamePosition()), created_at: now, updated_at: now };
    await this.withMedia(id, f.title, [], this.filesOfGame(f), () => this.repo.insertGame(row));
    await this.audit({ action: 'departments.play.game.create', actionLabel: 'Added a game', target: { type: 'game', id, label: f.title }, after: row }, by);
    return (await this.gamesAdmin([row]))[0]!;
  }

  async updateGame(id: string, input: GameInput, by: By): Promise<GameAdmin> {
    const before = await this.repo.getGame(id);
    if (!before) throw notFound('Game');
    const f = this.gameFields(input);
    const slug = input.slug !== undefined && input.slug !== null ? await this.slugFor('games', input.slug, f.title, id) : before.slug;
    const prev = [mediaOf(before.icon), mediaOf(before.cover)].filter((m): m is { id: string } => Boolean(m));
    const patch: Partial<GameRow> = { ...f, slug, featured: input.featured ?? before.featured, status: input.status ?? before.status, position: input.position ?? before.position, updated_at: this.now() };
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

  /* ---------------------------------------------------------------- rankings */

  private async table(g: GameRow, period: Period): Promise<RankingTable> {
    const [row, refs] = await Promise.all([this.repo.getRanking(g.id, period), this.refsOfGames([g])]);
    return { game: this.gameCard(g, refs), period, entries: entriesOf(row?.entries), updatedAt: iso(row?.updated_at) };
  }

  /** The store's table: the named published game, else the first one; the week unless a period is given */
  async getRankings(q: { game?: string; period?: Period }): Promise<RankingTable> {
    const g = q.game ? await this.repo.gameBySlug(q.game) : (await this.repo.listGames({ publishedOnly: true }))[0];
    if (!g || g.status !== 'published') throw notFound('Game');
    return this.table(g, q.period ?? 'week');
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
