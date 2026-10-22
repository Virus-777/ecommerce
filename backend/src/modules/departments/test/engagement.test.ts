import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, newId, type Kit } from './helpers.js';

let k: Kit;
const followed: any[] = [];
beforeAll(async () => {
  k = await boot();
  k.app.kernel.events.subscribe('test', 'departments.blog.followed_author_posted', (e) => void followed.push(e.payload));
});
afterAll(async () => {
  await k?.app.close();
});

const mina = newId();
const jonas = newId();

describe('blog saves, follows and reply likes', () => {
  let author: any;
  let post: any;

  beforeAll(async () => {
    k.names.set(mina, 'Mina Park').set(jonas, 'Jonas Reyes');
    author = (await k.admin('POST', '/blogs/authors', { name: 'Ada Writer' })).body;
    post = (await k.admin('POST', '/blogs/posts', { title: 'Soil microbes', body: '<p>Healthy soil holds billions of microbes.</p>', authorId: author.id, status: 'published' })).body;
  });

  it('saves and unsaves a post, and lists the saved posts that are still published', async () => {
    expect((await k.store('POST', `/blogs/posts/${post.id}/save`, { saved: true })).status).toBe(401);
    expect((await k.store('POST', `/blogs/posts/${post.id}/save`, { saved: true }, k.customer(mina))).body).toEqual({ saved: true });
    // twice is the same
    expect((await k.store('POST', `/blogs/posts/${post.id}/save`, { saved: true }, k.customer(mina))).status).toBe(200);
    expect((await k.store('GET', `/blogs/posts/${post.slug}`, undefined, k.customer(mina))).body).toMatchObject({ saved: true, authorPostCount: 1, authorLikeCount: 0 });
    expect((await k.store('GET', `/blogs/posts/${post.slug}`, undefined, k.customer(jonas))).body.saved).toBe(false);
    expect((await k.store('GET', `/blogs/posts/${post.slug}`)).body.saved).toBe(false);
    const saved = await k.store('GET', '/blogs/saved', undefined, k.customer(mina));
    expect(saved.body.items.map((p: any) => p.title)).toEqual(['Soil microbes']);

    const draft = (await k.admin('POST', '/blogs/posts', { title: 'Draft only', body: '<p>Not yet.</p>', authorId: author.id })).body;
    expect((await k.store('POST', `/blogs/posts/${draft.id}/save`, { saved: true }, k.customer(mina))).status).toBe(404);

    // unpublished later: left out of the list, and can still be unsaved
    await k.admin('PATCH', `/blogs/posts/${post.id}`, { title: post.title, body: post.body, authorId: author.id, status: 'unpublished' });
    expect((await k.store('GET', '/blogs/saved', undefined, k.customer(mina))).body.items).toEqual([]);
    expect((await k.store('POST', `/blogs/posts/${post.id}/save`, { saved: false }, k.customer(mina))).body).toEqual({ saved: false });
    await k.admin('PATCH', `/blogs/posts/${post.id}`, { title: post.title, body: post.body, authorId: author.id, status: 'published' });
  });

  it('follows an author, counts followers and tells them about a new post once', async () => {
    expect((await k.store('POST', `/blogs/authors/${author.id}/follow`, { following: true }, k.customer(mina))).body).toEqual({ following: true, followerCount: 1 });
    expect((await k.store('POST', `/blogs/authors/${author.id}/follow`, { following: true }, k.customer(jonas))).body).toEqual({ following: true, followerCount: 2 });
    expect((await k.store('POST', `/blogs/authors/${newId()}/follow`, { following: true }, k.customer(mina))).status).toBe(404);
    const profile = (await k.store('GET', `/blogs/authors/${author.slug}`, undefined, k.customer(mina))).body;
    expect(profile).toMatchObject({ followerCount: 2, following: true });
    expect((await k.store('GET', `/blogs/authors/${author.slug}`)).body).toMatchObject({ followerCount: 2, following: false });
    expect((await k.store('GET', '/blogs/following', undefined, k.customer(mina))).body.items.map((a: any) => a.name)).toEqual(['Ada Writer']);
    expect((await k.admin('GET', '/blogs/authors')).body.find((a: any) => a.id === author.id).followerCount).toBe(2);

    followed.length = 0;
    const draft = (await k.admin('POST', '/blogs/posts', { title: 'Cover crops', body: '<p>Roots all year.</p>', authorId: author.id })).body;
    expect(followed).toEqual([]);
    await k.admin('PATCH', `/blogs/posts/${draft.id}`, { title: 'Cover crops', body: '<p>Roots all year.</p>', authorId: author.id, status: 'published' });
    expect(followed.map((e) => e.customerId).sort()).toEqual([mina, jonas].sort());
    expect(followed[0]).toMatchObject({ postId: draft.id, postSlug: 'cover-crops', postTitle: 'Cover crops', authorId: author.id, authorName: 'Ada Writer' });
    // unpublishing and publishing again is no news
    await k.admin('PATCH', `/blogs/posts/${draft.id}`, { title: 'Cover crops', body: '<p>Roots all year.</p>', authorId: author.id, status: 'unpublished' });
    await k.admin('PATCH', `/blogs/posts/${draft.id}`, { title: 'Cover crops', body: '<p>Roots all year.</p>', authorId: author.id, status: 'published' });
    expect(followed).toHaveLength(2);

    expect((await k.store('POST', `/blogs/authors/${author.id}/follow`, { following: false }, k.customer(jonas))).body).toEqual({ following: false, followerCount: 1 });
  });

  it('likes a reply once per customer and shows the count and liked-by-me', async () => {
    const reply = (await k.store('POST', `/blogs/posts/${post.id}/replies`, { text: 'Switched to no-till.' }, k.customer(jonas))).body;
    expect(reply).toMatchObject({ likeCount: 0, liked: false });
    expect((await k.store('POST', `/blogs/replies/${reply.id}/like`, { liked: true }, k.customer(mina))).body).toEqual({ liked: true, likeCount: 1 });
    expect((await k.store('POST', `/blogs/replies/${reply.id}/like`, { liked: true }, k.customer(mina))).body).toEqual({ liked: true, likeCount: 1 });
    expect((await k.store('POST', `/blogs/replies/${reply.id}/like`, { liked: true }, k.customer(jonas))).body).toEqual({ liked: true, likeCount: 2 });
    const asMina = (await k.store('GET', `/blogs/posts/${post.id}/replies`, undefined, k.customer(mina))).body.items[0];
    expect(asMina).toMatchObject({ likeCount: 2, liked: true, mine: false });
    expect((await k.store('GET', `/blogs/posts/${post.id}/replies`)).body.items[0]).toMatchObject({ likeCount: 2, liked: false });
    expect((await k.store('POST', `/blogs/replies/${reply.id}/like`, { liked: false }, k.customer(mina))).body).toEqual({ liked: false, likeCount: 1 });
    expect((await k.admin('GET', `/blogs/replies?postId=${post.id}`)).body.items[0].likeCount).toBe(1);
    // a hidden reply can't be liked
    await k.admin('PATCH', `/blogs/replies/${reply.id}`, { status: 'hidden' });
    expect((await k.store('POST', `/blogs/replies/${reply.id}/like`, { liked: true }, k.customer(mina))).status).toBe(404);
  });
});

describe('company and game reviews', () => {
  let company: any;
  let game: any;

  beforeAll(async () => {
    k.names.set(mina, 'Mina Park').set(jonas, 'Jonas Reyes');
    company = (await k.admin('POST', '/companies', { name: 'Northfield Agritech', city: 'Fresno, CA', verified: true })).body;
    game = (await k.admin('POST', '/play/games', { title: 'Block Drop', genre: 'Puzzle' })).body;
  });

  it('keeps one editable review per customer and shows the rating on cards and the page', async () => {
    expect((await k.store('POST', `/companies/${company.slug}/reviews`, { stars: 5 })).status).toBe(401);
    expect((await k.store('POST', `/companies/${company.slug}/reviews`, { stars: 6 }, k.customer(mina))).status).toBe(400);
    const first = await k.store('POST', `/companies/${company.slug}/reviews`, { stars: 4, text: 'Good kits' }, k.customer(mina));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ name: 'Mina P.', stars: 4, text: 'Good kits', mine: true, hidden: false });
    const changed = (await k.store('POST', `/companies/${company.slug}/reviews`, { stars: 5, text: ' Great kits ' }, k.customer(mina))).body;
    expect(changed).toMatchObject({ id: first.body.id, stars: 5, text: 'Great kits' });
    await k.store('POST', `/companies/${company.slug}/reviews`, { stars: 4 }, k.customer(jonas));

    const page = (await k.store('GET', `/companies/${company.slug}`, undefined, k.customer(mina))).body;
    expect(page).toMatchObject({ rating: 4.5, ratingCount: 2, ratingSummary: { average: 4.5, count: 2, stars: [1, 1, 0, 0, 0] } });
    expect(page.myReview).toMatchObject({ stars: 5, mine: true });
    expect((await k.store('GET', `/companies/${company.slug}`)).body.myReview).toBeNull();
    const list = (await k.store('GET', '/companies?limit=1')).body;
    expect(list.total).toBeGreaterThanOrEqual(1);
    const card = (await k.store('GET', `/companies?q=Northfield`)).body.items[0];
    expect(card).toMatchObject({ rating: 4.5, ratingCount: 2 });
    const reviews = (await k.store('GET', `/companies/${company.slug}/reviews`, undefined, k.customer(jonas))).body.items;
    expect(reviews.map((r: any) => [r.name, r.stars, r.mine])).toEqual([
      ['Jonas R.', 4, true],
      ['Mina P.', 5, false],
    ]);
    expect((await k.store('GET', `/companies/${company.slug}/reviews?stars=5`)).body.items).toHaveLength(1);

    k.blocked.add(jonas);
    expect((await k.store('POST', `/companies/${company.slug}/reviews`, { stars: 1 }, k.customer(jonas))).status).toBe(403);
    k.blocked.delete(jonas);
  });

  it('rates games ("genre · ★ 4.6") and lets staff hide and show reviews', async () => {
    await k.store('POST', `/play/games/${game.slug}/reviews`, { stars: 5 }, k.customer(mina));
    const r = (await k.store('POST', `/play/games/${game.slug}/reviews`, { stars: 2, text: 'spam spam' }, k.customer(jonas))).body;
    const card = (await k.store('GET', '/play/games')).body.games.find((g: any) => g.slug === game.slug);
    expect(card).toMatchObject({ genre: 'Puzzle', rating: 3.5, ratingCount: 2 });

    const listed = (await k.admin('GET', '/reviews?target=game')).body.items;
    expect(listed.map((x: any) => x.target.name)).toEqual(['Block Drop', 'Block Drop']);
    expect((await k.admin('POST', `/reviews/${r.id}/moderate`, { hidden: true }, k.staff(['departments.view']))).status).toBe(403);
    const hidden = await k.admin('POST', `/reviews/${r.id}/moderate`, { hidden: true, reason: 'Spam' });
    expect(hidden.body).toMatchObject({ hidden: true, hiddenReason: 'Spam', target: { type: 'game', name: 'Block Drop' } });
    expect(k.audits.some((e) => e.action === 'departments.reviews.hide')).toBe(true);
    const g = (await k.store('GET', `/play/games/${game.slug}`, undefined, k.customer(jonas))).body;
    expect(g).toMatchObject({ rating: 5, ratingCount: 1 });
    expect(g.myReview).toMatchObject({ hidden: true });
    expect((await k.store('GET', `/play/games/${game.slug}/reviews`)).body.items).toHaveLength(1);
    // changing a hidden review keeps it hidden
    await k.store('POST', `/play/games/${game.slug}/reviews`, { stars: 3 }, k.customer(jonas));
    expect((await k.store('GET', `/play/games/${game.slug}/reviews`)).body.items).toHaveLength(1);
    expect((await k.admin('GET', '/reviews?hidden=true')).body.items.map((x: any) => x.id)).toEqual([r.id]);
    await k.admin('POST', `/reviews/${r.id}/moderate`, { hidden: false });
    expect((await k.store('GET', `/play/games/${game.slug}/reviews`)).body.items).toHaveLength(2);
    expect((await k.admin('GET', `/companies/${company.id}`)).body).toMatchObject({ ratingCount: 2, hiddenReviewCount: 0 });
  });
});

describe('personal data export', () => {
  it('lists every kind of the customer\'s departments data under its own section, by both ids', async () => {
    const company = (await k.admin('GET', '/companies?q=Northfield')).body.items[0];
    await k.store('POST', `/companies/${company.id}/inquiries`, { name: 'Mina Park', email: 'mina@example.com', message: 'Do you ship to Oregon?' }, k.customer(mina));
    const post = (await k.store('GET', '/blogs/posts?q=Soil')).body.items[0];
    await k.store('POST', `/blogs/posts/${post.id}/reaction`, { reaction: 'like' }, k.customer(mina));
    await k.store('POST', `/blogs/posts/${post.id}/save`, { saved: true }, k.customer(mina));
    const reply = (await k.store('POST', `/blogs/posts/${post.id}/replies`, { text: 'Thanks for this.' }, k.customer(mina))).body;
    const other = (await k.store('POST', `/blogs/posts/${post.id}/replies`, { text: 'Agreed.' }, k.customer(jonas))).body;
    await k.store('POST', `/blogs/replies/${other.id}/like`, { liked: true }, k.customer(mina));
    await k.store('POST', '/blogs/reports', { targetType: 'reply', targetId: other.id, reason: 'spam' }, k.customer(mina));
    const game = (await k.admin('GET', '/play/games')).body.find((g: any) => g.slug === 'block-drop');
    const secret = (await k.admin('POST', `/play/games/${game.id}/keys`)).body.secret;
    const player = (await k.store('GET', '/play/player', undefined, k.customer(mina))).body;
    expect((await k.postScore(secret, { scoreId: 'export-1', playerId: player.playerId, score: 777 })).status).toBe(200);

    const api = k.app.kernel.boot.apis.get('departments') as unknown as { exportCustomerData(i: { customerId: string; accountId: string }): Promise<any[]> };
    const sections = await api.exportCustomerData({ customerId: mina, accountId: mina });
    const byKey = new Map(sections.map((s) => [s.key, s]));
    expect([...byKey.keys()].sort()).toEqual(['blog_followed_authors', 'blog_reactions', 'blog_replies', 'blog_reports', 'blog_reply_likes', 'blog_saved_posts', 'company_inquiries', 'department_reviews', 'play_player', 'play_scores'].sort());
    expect(sections.every((s) => s.module === 'departments')).toBe(true);
    expect(byKey.get('blog_replies')!.records).toEqual([expect.objectContaining({ post: 'Soil microbes', text: 'Thanks for this.', shownAs: 'Mina P.' })]);
    expect(byKey.get('blog_reports')!.records[0]).toMatchObject({ about: 'reply', reason: 'spam', status: 'open' });
    expect(byKey.get('company_inquiries')!.records[0]).toMatchObject({ company: 'Northfield Agritech', message: 'Do you ship to Oregon?' });
    expect(byKey.get('company_inquiries')!.records[0]).not.toHaveProperty('staffNote');
    expect(byKey.get('department_reviews')!.records.map((r: any) => [r.about, r.target, r.stars])).toEqual([
      ['company', 'Northfield Agritech', 5],
      ['game', 'Block Drop', 5],
    ]);
    expect(byKey.get('play_player')!.records).toEqual([expect.objectContaining({ playerId: player.playerId, shownAs: 'Mina P.' })]);
    expect(byKey.get('play_scores')!.records).toEqual([expect.objectContaining({ game: 'Block Drop', playerId: player.playerId, score: 777 })]);
    expect(reply.id).toBeTruthy();
    // a customer with nothing here gets no sections
    expect(await api.exportCustomerData({ customerId: newId(), accountId: newId() })).toEqual([]);
  });
});
