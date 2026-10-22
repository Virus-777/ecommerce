import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashServerKey, mondayOf, normalizePlayerCode, parseRanks, pointsToTop, rankBests, weekOf } from '../domain/play.js';
import { boot, newId, type Kit } from './helpers.js';

describe('play rules', () => {
  it('works out prize weeks Monday to Sunday in the market time zone', () => {
    const tz = 'America/Los_Angeles';
    // 07:30 UTC Monday is 00:30 Monday in Los Angeles: the new week
    expect(weekOf(new Date('2026-10-26T07:30:00Z'), tz)).toMatchObject({ startsOn: '2026-10-26', endsOn: '2026-11-01' });
    // 06:30 UTC Monday is 23:30 Sunday PDT: still the week before
    const w = weekOf(new Date('2026-10-26T06:30:00Z'), tz);
    expect(w).toMatchObject({ startsOn: '2026-10-19', endsOn: '2026-10-25', endsLabel: 'Ends Sun, Oct 25' });
    expect(w.endsAt.toISOString()).toBe('2026-10-26T07:00:00.000Z');
    expect(mondayOf('2026-10-25')).toBe('2026-10-19');
    expect(mondayOf('2026-10-19')).toBe('2026-10-19');
  });

  it('reads ranks, player IDs and ranks players', () => {
    expect(parseRanks('#1')).toEqual([1, 1]);
    expect(parseRanks('#4–10')).toEqual([4, 10]);
    expect(parseRanks('Ranks #2-3')).toEqual([2, 3]);
    expect(parseRanks('top')).toBeNull();
    expect(normalizePlayerCode('mk 7f3k 92qd')).toBe('MK-7F3K-92QD');
    expect(normalizePlayerCode('7F3K92QD')).toBe('MK-7F3K-92QD');
    expect(normalizePlayerCode('MK-7F3K')).toBeNull();
    expect(hashServerKey('a')).toHaveLength(64);
    const at = (m: number) => new Date(Date.UTC(2026, 9, 21, 12, m));
    const ranked = rankBests([
      { customerId: 'b', score: 10, at: at(5) },
      { customerId: 'a', score: 10, at: at(1) },
      { customerId: 'c', score: 30, at: at(9) },
    ]);
    expect(ranked.map((r) => [r.customerId, r.rank])).toEqual([
      ['c', 1],
      ['a', 2],
      ['b', 3],
    ]);
    const many = rankBests(Array.from({ length: 130 }, (_, i) => ({ customerId: `p${i}`, score: 10_000 - i * 10, at: at(0) })));
    // #100 has 9,010; #128 has 8,730: 281 points to pass #100
    expect(pointsToTop(many, 'p127')).toBe(281);
    expect(pointsToTop(many, 'p99')).toBeNull();
    expect(pointsToTop(many, 'nobody')).toBeNull();
  });
});

describe('play center scores', () => {
  let k: Kit;
  let game: any;
  let quiet: any;
  const c1 = newId();
  const c2 = newId();
  const people = { mina: newId(), jonas: newId(), amara: newId(), tom: newId() };
  const codes: Record<string, string> = {};
  let secret = '';
  const awarded: any[] = [];

  beforeAll(async () => {
    k = await boot();
    // Wednesday noon in Los Angeles: the prize week runs Mon Oct 19 – Sun Oct 25
    k.clock.set('2026-10-21T19:00:00Z');
    k.names.set(people.mina, 'Mina Park').set(people.jonas, 'Jonas Reyes').set(people.amara, 'Amara Kone').set(people.tom, 'Tom Weber');
    k.campaigns.set(c1, { name: 'Block Drop #1', active: true }).set(c2, { name: 'Block Drop #2–3', active: true });
    k.app.kernel.events.subscribe('test', 'departments.play.prize_awarded', (e) => void awarded.push(e.payload));
  });
  afterAll(async () => {
    await k?.app.close();
  });

  it('links prize tiers to coupon campaigns', async () => {
    const bad = await k.admin('POST', '/play/games', { title: 'Block Drop', genre: 'Puzzle', prizes: [{ ranks: '#1', reward: '$20 coupon', campaignId: newId() }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues[0].path).toBe('prizes[0].campaignId');
    const overlap = await k.admin('POST', '/play/games', { title: 'Block Drop', genre: 'Puzzle', prizes: [{ ranks: '#1–3', reward: 'a' }, { fromRank: 2, toRank: 4, reward: 'b' }] });
    expect(overlap.status).toBe(400);
    const res = await k.admin('POST', '/play/games', {
      title: 'Block Drop',
      genre: 'Puzzle',
      prizeNote: 'Coupons land in Account › Coupons on Monday. Minimum order $30.',
      prizes: [
        { ranks: '#1', reward: '$20 coupon', campaignId: c1 },
        { fromRank: 2, toRank: 3, reward: '$10 coupon', campaignId: c2 },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    game = res.body;
    expect(game.prizes).toEqual([
      { ranks: '#1', reward: '$20 coupon', fromRank: 1, toRank: 1, campaignId: c1, campaignName: 'Block Drop #1', campaignActive: true },
      { ranks: '#2–3', reward: '$10 coupon', fromRank: 2, toRank: 3, campaignId: c2, campaignName: 'Block Drop #2–3', campaignActive: true },
    ]);
    expect(game).toMatchObject({ scoresLive: false, scoreCount: 0, activeKeyCount: 0 });
    quiet = (await k.admin('POST', '/play/games', { title: 'Word Rush', genre: 'Word', prizes: [{ ranks: '#1', reward: '$5 coupon' }] })).body;
    await k.admin('PUT', `/play/games/${quiet.id}/rankings/week`, { entries: [{ name: 'jtorres', score: 21305 }] });
  });

  it('makes server keys that are shown once and kept as hashes', async () => {
    expect((await k.admin('POST', `/play/games/${game.id}/keys`, undefined, k.staff(['departments.view', 'departments.play.manage']))).status).toBe(403);
    const made = await k.admin('POST', `/play/games/${game.id}/keys`);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    secret = made.body.secret;
    expect(secret).toMatch(/^mkg_/);
    expect(made.body.key).toMatchObject({ status: 'active', hint: `…${secret.slice(-4)}` });
    const second = (await k.admin('POST', `/play/games/${game.id}/keys`)).body;
    expect((await k.admin('POST', `/play/games/${game.id}/keys`)).body.error.code).toBe('TOO_MANY_KEYS');
    const listed = (await k.admin('GET', `/play/games/${game.id}/keys`)).body;
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect((await k.admin('POST', `/play/games/${game.id}/keys/${second.key.id}/revoke`)).body.status).toBe('revoked');
    expect((await k.admin('POST', `/play/games/${game.id}/keys/${second.key.id}/revoke`)).status).toBe(409);
    expect(k.audits.filter((e) => e.action.startsWith('departments.play.key.')).map((e) => e.action)).toEqual(['departments.play.key.create', 'departments.play.key.create', 'departments.play.key.revoke']);
  });

  it('gives each customer a stable player ID', async () => {
    expect((await k.store('GET', '/play/player')).status).toBe(401);
    for (const [who, id] of Object.entries(people)) {
      const p = (await k.store('GET', '/play/player', undefined, k.customer(id))).body;
      expect(p.playerId).toMatch(/^MK-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
      codes[who] = p.playerId;
    }
    expect((await k.store('GET', '/play/player', undefined, k.customer(people.mina))).body).toMatchObject({ playerId: codes.mina, name: 'Mina P.', gamesPlayed: 0 });
    expect(new Set(Object.values(codes)).size).toBe(4);
    const found = (await k.admin('GET', '/play/players?q=mina')).body;
    expect(found).toEqual([{ customerId: people.mina, name: 'Mina P.', playerId: codes.mina }]);
  });

  it('takes scores from the game server, once per scoreId', async () => {

    expect((await k.postScore(undefined, { scoreId: 's1', playerId: codes.mina, score: 10 })).status).toBe(401);
    expect((await k.postScore('mkg_wrong', { scoreId: 's1', playerId: codes.mina, score: 10 })).status).toBe(401);
    const first = await k.postScore(secret, { scoreId: 's1', playerId: codes.mina!.toLowerCase().replace(/-/g, ''), score: 4320, playedAt: '2026-10-21T18:30:00Z' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ scoreId: 's1', playerId: codes.mina, score: 4320, duplicate: false, best: 4320, weekRank: 1 });
    const again = await k.postScore(secret, { scoreId: 's1', playerId: codes.mina, score: 4320, playedAt: '2026-10-21T18:30:00Z' });
    expect(again.body).toMatchObject({ id: first.body.id, duplicate: true });
    expect((await k.postScore(secret, { scoreId: 's1', playerId: codes.jonas, score: 4320 })).body.error.code).toBe('SCORE_ID_REUSED');
    expect((await k.postScore(secret, { scoreId: 's2', playerId: 'MK-2222-2222', score: 5 })).body.error.code).toBe('UNKNOWN_PLAYER');
    expect((await k.postScore(secret, { scoreId: 's3', playerId: codes.mina, score: 5, playedAt: '2026-10-21T15:00:00Z' })).body.error.code).toBe('SCORE_TOO_OLD');
    expect((await k.postScore(secret, { scoreId: 's4', playerId: codes.mina, score: -1 })).status).toBe(400);

    await k.postScore(secret, { scoreId: 's5', playerId: codes.jonas, score: 21305 });
    await k.postScore(secret, { scoreId: 's6', playerId: codes.amara, score: 17620 });
    await k.postScore(secret, { scoreId: 's7', playerId: codes.tom, score: 18940 });
    await k.postScore(secret, { scoreId: 's8', playerId: codes.mina, score: 1200 });
    const receipt = (await k.postScore(secret, { scoreId: 's9', playerId: codes.tom, score: 100 })).body;
    expect(receipt).toMatchObject({ best: 18940, weekRank: 2 });

    // a hidden game takes no scores
    await k.admin('PATCH', `/play/games/${quiet.id}`, { title: 'Word Rush', genre: 'Word', status: 'hidden' });
    const quietKey = (await k.admin('POST', `/play/games/${quiet.id}/keys`)).body.secret;
    expect((await k.postScore(quietKey, { scoreId: 'q1', playerId: codes.mina, score: 5 })).body.error.code).toBe('GAME_NOT_ACTIVE');
    await k.admin('PATCH', `/play/games/${quiet.id}`, { title: 'Word Rush', genre: 'Word', status: 'published' });
  });

  it('works out rankings from the scores, with the customer\'s place', async () => {
    const week = (await k.store('GET', `/play/rankings?game=${game.slug}&period=week`, undefined, k.customer(people.mina))).body;
    expect(week).toMatchObject({ source: 'scores', playerCount: 4, week: { startsOn: '2026-10-19', endsOn: '2026-10-25', endsLabel: 'Ends Sun, Oct 25' } });
    expect(week.entries.map((e: any) => [e.rank, e.name, e.score, e.mine])).toEqual([
      [1, 'Jonas R.', 21305, false],
      [2, 'Tom W.', 18940, false],
      [3, 'Amara K.', 17620, false],
      [4, 'Mina P.', 4320, true],
    ]);
    expect(week.you).toEqual({ rank: 4, score: 4320, name: 'Mina P.', pointsToTop100: null });
    expect((await k.store('GET', `/play/rankings?game=${game.slug}&period=week`)).body.you).toBeNull();
    const search = (await k.store('GET', `/play/rankings?game=${game.slug}&period=all_time&q=amara`)).body;
    expect(search.entries.map((e: any) => [e.rank, e.name])).toEqual([[3, 'Amara K.']]);
    expect((await k.store('GET', `/play/rankings?game=${game.slug}&period=today`)).body.entries).toHaveLength(4);
    // a game without posted scores keeps the staff table
    const staff = (await k.store('GET', `/play/rankings?game=${quiet.slug}&period=week`, undefined, k.customer(people.mina))).body;
    expect(staff).toMatchObject({ source: 'staff', you: null, entries: [{ rank: 1, name: 'jtorres', score: 21305 }] });

    const page = (await k.store('GET', `/play/games/${game.slug}`, undefined, k.customer(people.mina))).body;
    expect(page).toMatchObject({ scoresLive: true, hasPrizes: true, playersLabel: '4 playing this week', prizeNote: 'Coupons land in Account › Coupons on Monday. Minimum order $30.', week: { endsLabel: 'Ends Sun, Oct 25' } });
    expect(page.prizes).toEqual([
      { ranks: '#1', reward: '$20 coupon', fromRank: 1, toRank: 1 },
      { ranks: '#2–3', reward: '$10 coupon', fromRank: 2, toRank: 3 },
    ]);
    expect(page.you).toEqual({ playerId: codes.mina, best: 4320, weekBest: 4320, weekRank: 4, gamesPlayed: 2, pointsToTop100: null });
    expect((await k.store('GET', `/play/games/${game.slug}`)).body.you).toBeNull();
    expect((await k.store('GET', '/play/games?q=block')).body.games.map((g: any) => g.title)).toEqual(['Block Drop']);
    expect((await k.store('GET', '/play/games?q=word')).body.games.map((g: any) => g.title)).toEqual(['Word Rush']);
    expect((await k.admin('GET', '/play/games')).body.find((g: any) => g.id === game.id)).toMatchObject({ scoresLive: true, scoreCount: 6, activeKeyCount: 1 });
  });

  it('rotates a key: the old one stops working at once', async () => {
    const key = (await k.admin('GET', `/play/games/${game.id}/keys`)).body.find((x: any) => x.status === 'active');
    const rotated = (await k.admin('POST', `/play/games/${game.id}/keys/${key.id}/rotate`)).body;
    expect((await k.postScore(secret, { scoreId: 'r1', playerId: codes.mina, score: 1 })).status).toBe(401);
    secret = rotated.secret;
    expect((await k.postScore(secret, { scoreId: 'r1', playerId: codes.mina, score: 1 })).status).toBe(200);
  });

  it('gives the week\'s winners their coupons once the week is settled', async () => {
    k.campaigns.get(c2)!.active = false;
    // Monday 00:30 market time: the week ended, but late scores may still come in (60 minutes)
    k.clock.set('2026-10-26T07:30:00Z');
    await k.app.kernel.jobs.runNow('departments.award-prize-weeks');
    expect(awarded).toEqual([]);
    // Monday 02:00: settled. #1 gets c1; #2 and #3 are on a paused campaign and wait
    k.clock.set('2026-10-26T09:00:00Z');
    await k.app.kernel.jobs.runNow('departments.award-prize-weeks');
    await k.app.kernel.events.drain();
    expect(awarded.map((e) => [e.customerId, e.rank, e.reward])).toEqual([[people.jonas, 1, '$20 coupon']]);
    expect(awarded[0]).toMatchObject({ gameId: game.id, gameSlug: game.slug, gameTitle: 'Block Drop', week: '2026-10-19', code: 'PLAY-1' });
    const failed = (await k.admin('GET', `/play/games/${game.id}/awards?state=failed`)).body.items;
    expect(failed.map((a: any) => a.rank).sort()).toEqual([2, 3]);
    expect(failed[0].error).toMatch(/CONFLICT/);

    // the next hour, with the campaign running again
    k.campaigns.get(c2)!.active = true;
    await k.app.kernel.jobs.runNow('departments.award-prize-weeks');
    await k.app.kernel.jobs.runNow('departments.award-prize-weeks');
    await k.app.kernel.events.drain();
    expect(awarded.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect([...k.issued.keys()].sort()).toEqual([`play:${game.id}:2026-10-19:${people.amara}`, `play:${game.id}:2026-10-19:${people.jonas}`, `play:${game.id}:2026-10-19:${people.tom}`].sort());
    const awards = (await k.admin('GET', `/play/games/${game.id}/awards?week=2026-10-19`)).body.items;
    expect(awards.map((a: any) => [a.rank, a.name, a.state, a.campaignId])).toEqual(
      expect.arrayContaining([
        [1, 'Jonas R.', 'issued', c1],
        [2, 'Tom W.', 'issued', c2],
        [3, 'Amara K.', 'issued', c2],
      ]),
    );

    // the new week starts empty; all time keeps everything
    const week = (await k.store('GET', `/play/rankings?game=${game.slug}&period=week`, undefined, k.customer(people.mina))).body;
    expect(week).toMatchObject({ playerCount: 0, entries: [], week: { startsOn: '2026-10-26', endsLabel: 'Ends Sun, Nov 1' }, you: { rank: null, score: null, name: 'Mina P.' } });
    expect((await k.store('GET', `/play/rankings?game=${game.slug}&period=all_time`)).body.playerCount).toBe(4);
  });
});
