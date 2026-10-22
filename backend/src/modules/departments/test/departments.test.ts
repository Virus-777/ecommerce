import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, newId, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const body = (words: number) => `<h2>Why it matters</h2><p>${Array.from({ length: words }, (_, i) => `word${i}`).join(' ')}</p><script>alert(1)</script><a href="javascript:x">bad</a>`;

describe('farm machines', () => {
  it('keeps machine types and picks with attachments, and shows the store what search still shows', async () => {
    const tractor = k.card({ title: 'Kubota L2502' });
    const loader = k.card({ title: 'Front loader LA344' });
    const tiller = k.card({ title: 'Rotary tiller, 5 ft' });
    k.cards.set(tractor.productId, tractor).set(loader.productId, loader).set(tiller.productId, tiller);
    const gone = newId();
    expect((await k.admin('PUT', '/farm', { types: [], machines: [] })).status).toBe(400);
    expect((await k.admin('PUT', '/farm', { types: [{ id: 'a', name: 'Tractors', slug: '' }, { id: 'b', name: 'tractors', slug: '' }], machines: [] })).body.error.details.issues[0].path).toBe('types[1].name');
    const set = await k.admin('PUT', '/farm', {
      types: [
        { id: 'new-1', name: 'Tractors', slug: '' },
        { id: 'new-2', name: 'Harvesters', slug: '' },
      ],
      machines: [
        { productId: gone, typeId: 'new-1', highlights: ['22 hp'] },
        { productId: tractor.productId, typeId: 'new-1', highlights: ['25 hp · 4WD', ' '], attachmentIds: [loader.productId, tiller.productId, gone] },
      ],
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const [tractors, harvesters] = set.body.types;
    expect(tractors).toMatchObject({ name: 'Tractors', slug: 'tractors' });
    expect(tractors.id).not.toBe('new-1');
    expect(set.body.machines[1]).toMatchObject({ productId: tractor.productId, typeId: tractors.id, highlights: ['25 hp · 4WD'] });

    const page = (await k.store('GET', '/farm')).body;
    expect(page.types.map((t: any) => t.name)).toEqual(['Tractors', 'Harvesters']);
    expect(page.machines.map((m: any) => [m.product.title, m.typeId])).toEqual([['Kubota L2502', tractors.id]]);
    const machine = (await k.store('GET', `/farm/machines/${tractor.productId}`)).body;
    expect(machine.attachments.map((a: any) => a.title)).toEqual(['Front loader LA344', 'Rotary tiller, 5 ft']);
    expect((await k.store('GET', `/farm/machines/${loader.productId}`)).status).toBe(404);

    // ids are kept on the next save; a machine must use one of the types
    const again = await k.admin('PUT', '/farm', { types: set.body.types, machines: [{ productId: tractor.productId, typeId: harvesters.id }] });
    expect(again.body.types.map((t: any) => t.id)).toEqual([tractors.id, harvesters.id]);
    expect((await k.admin('PUT', '/farm', { types: [tractors], machines: [{ productId: tractor.productId, typeId: harvesters.id }] })).body.error.details.issues[0].path).toBe('machines[0].typeId');
    expect((await k.admin('PUT', '/farm', { types: [tractors], machines: [] }, k.staff(['departments.view']))).status).toBe(403);
  });
});

describe('blogs', () => {
  let topic: any;
  let hiddenTopic: any;
  let author: any;
  let first: any;
  let second: any;

  it('adds topics and authors, with unique slugs', async () => {
    topic = (await k.admin('POST', '/blogs/topics', { name: 'Science' })).body;
    expect(topic).toMatchObject({ slug: 'science', name: 'Science', visible: true, position: 1, postCount: 0 });
    const dup = await k.admin('POST', '/blogs/topics', { name: 'Science' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SLUG_TAKEN');
    hiddenTopic = (await k.admin('POST', '/blogs/topics', { name: 'Drafts corner', visible: false })).body;
    author = (await k.admin('POST', '/blogs/authors', { name: 'Mina Park', email: 'mina@example.com', bio: 'Writes about space.' })).body;
    expect(author).toMatchObject({ slug: 'mina-park', postCount: 0, likeCount: 0, reportCount: 0 });
    expect((await k.admin('POST', '/blogs/authors', { name: 'Bad Mail', email: 'nope' })).status).toBe(400);
  });

  it('writes posts: the body is sanitized, publishing sets the publish time once', async () => {
    const cover = await k.uploadImage();
    const draft = await k.admin('POST', '/blogs/posts', { title: 'How rockets land', body: body(400), authorId: author.id, topicId: topic.id, cover });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    first = draft.body;
    expect(first).toMatchObject({ slug: 'how-rockets-land', status: 'draft', publishedAt: null, readMinutes: 2 });
    expect(first.body).not.toContain('<script');
    expect(first.body).not.toContain('javascript:');
    expect(first.cover.id).toBe(cover.id);
    // drafts are not in the store
    expect((await k.store('GET', '/blogs/posts/how-rockets-land')).status).toBe(404);
    const pub = await k.admin('PATCH', `/blogs/posts/${first.id}`, { title: first.title, body: first.body, authorId: author.id, topicId: topic.id, cover, status: 'published' });
    expect(pub.body.status).toBe('published');
    const publishedAt = pub.body.publishedAt;
    k.clock.advance(60_000);
    const again = await k.admin('PATCH', `/blogs/posts/${first.id}`, { title: 'How rockets land upright', body: first.body, authorId: author.id, topicId: topic.id, cover, status: 'published' });
    expect(again.body.publishedAt).toBe(publishedAt);
    k.clock.advance(60_000);
    second = (await k.admin('POST', '/blogs/posts', { title: 'Saving on groceries', body: body(50), authorId: author.id, status: 'published', featured: true })).body;
    k.clock.advance(60_000);
    await k.admin('POST', '/blogs/posts', { title: 'Hidden topic post', body: body(20), authorId: author.id, topicId: hiddenTopic.id, status: 'published' });
  });

  it('lists published posts newest first, leaving out hidden topics, with previous and next', async () => {
    const list = await k.store('GET', '/blogs/posts');
    expect(list.body.items.map((p: any) => p.title)).toEqual(['Saving on groceries', 'How rockets land upright']);
    expect(list.body.items[0]).toMatchObject({ featured: true, topic: null, author: { name: 'Mina Park' } });
    const byTopic = await k.store('GET', '/blogs/posts?topic=science');
    expect(byTopic.body.items.map((p: any) => p.title)).toEqual(['How rockets land upright']);
    expect((await k.store('GET', '/blogs/posts?topic=drafts-corner')).body.items).toEqual([]);
    const topics = await k.store('GET', '/blogs/topics');
    expect(topics.body.map((t: any) => [t.slug, t.postCount])).toEqual([['science', 1]]);
    const post = await k.store('GET', '/blogs/posts/how-rockets-land');
    expect(post.status).toBe(200);
    expect(post.body).toMatchObject({ previous: null, next: { title: 'Saving on groceries' }, myReaction: null });
    expect(post.body.body).toContain('<h2>Why it matters</h2>');
  });

  it('keeps like and dislike counts in step with each customer’s reaction', async () => {
    const ana = newId();
    const ben = newId();
    const react = (who: string, reaction: string) => k.store('POST', `/blogs/posts/${first.id}/reaction`, { reaction }, k.customer(who));
    expect((await react(ana, 'like')).body).toEqual({ likeCount: 1, dislikeCount: 0, myReaction: 'like' });
    expect((await react(ana, 'like')).body).toEqual({ likeCount: 1, dislikeCount: 0, myReaction: 'like' });
    expect((await react(ben, 'dislike')).body).toEqual({ likeCount: 1, dislikeCount: 1, myReaction: 'dislike' });
    expect((await react(ana, 'dislike')).body).toEqual({ likeCount: 0, dislikeCount: 2, myReaction: 'dislike' });
    expect((await react(ben, 'none')).body).toEqual({ likeCount: 0, dislikeCount: 1, myReaction: null });
    const seen = await k.store('GET', '/blogs/posts/how-rockets-land', undefined, k.customer(ana));
    expect(seen.body.myReaction).toBe('dislike');
    // visitors can't react
    expect((await k.store('POST', `/blogs/posts/${first.id}/reaction`, { reaction: 'like' })).status).toBe(401);
  });

  it('takes replies one level deep, signs them with the customer’s short name and counts the visible ones', async () => {
    const ana = newId();
    k.names.set(ana, 'Ana Lima Souza');
    const top = await k.store('POST', `/blogs/posts/${first.id}/replies`, { text: 'Great read!' }, k.customer(ana));
    expect(top.status).toBe(201);
    expect(top.body).toMatchObject({ authorName: 'Ana S.', parentId: null, mine: true });
    const answer = (await k.store('POST', `/blogs/posts/${first.id}/replies`, { text: 'Agreed', parentId: top.body.id }, k.customer(newId()))).body;
    expect(answer.authorName).toBe('Customer');
    const deeper = (await k.store('POST', `/blogs/posts/${first.id}/replies`, { text: 'Me too', parentId: answer.id }, k.customer(newId()))).body;
    expect(deeper.parentId).toBe(top.body.id);
    const list = await k.store('GET', `/blogs/posts/${first.id}/replies`, undefined, k.customer(ana));
    expect(list.body.items.map((r: any) => [r.text, r.mine])).toEqual([
      ['Great read!', true],
      ['Agreed', false],
      ['Me too', false],
    ]);
    expect((await k.admin('GET', `/blogs/posts/${first.id}`)).body.replyCount).toBe(3);
    // only the writer deletes a reply; its answers go with it
    expect((await k.store('DELETE', `/blogs/replies/${top.body.id}`, undefined, k.customer(newId()))).status).toBe(404);
    expect((await k.store('DELETE', `/blogs/replies/${top.body.id}`, undefined, k.customer(ana))).status).toBe(204);
    expect((await k.admin('GET', `/blogs/posts/${first.id}`)).body.replyCount).toBe(0);
  });

  it('closes replies when blogRepliesOpen is off', async () => {
    k.settingsValues['departments.blogRepliesOpen'] = false;
    const res = await k.store('POST', `/blogs/posts/${first.id}/replies`, { text: 'Hello' }, k.customer(newId()));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REPLIES_CLOSED');
    delete k.settingsValues['departments.blogRepliesOpen'];
  });

  it('takes one report per customer and target; upholding hides the reply or unpublishes the post', async () => {
    const reply = (await k.store('POST', `/blogs/posts/${first.id}/replies`, { text: 'Buy cheap pills here' }, k.customer(newId()))).body;
    const who = newId();
    const rep = await k.store('POST', '/blogs/reports', { targetType: 'reply', targetId: reply.id, reason: 'spam' }, k.customer(who));
    expect(rep.status).toBe(201);
    const twice = await k.store('POST', '/blogs/reports', { targetType: 'reply', targetId: reply.id, reason: 'spam' }, k.customer(who));
    expect(twice.body.error.code).toBe('ALREADY_REPORTED');
    expect((await k.admin('GET', '/blogs/replies?reported=true')).body.items.map((r: any) => [r.id, r.openReportCount])).toEqual([[reply.id, 1]]);
    const decided = await k.admin('PATCH', `/blogs/reports/${rep.body.id}`, { status: 'upheld' });
    expect(decided.body).toMatchObject({ status: 'upheld', targetLabel: 'Buy cheap pills here' });
    expect((await k.store('GET', `/blogs/posts/${first.id}/replies`)).body.items).toEqual([]);
    const late = await k.admin('PATCH', `/blogs/reports/${rep.body.id}`, { status: 'dismissed' });
    expect(late.body.error.code).toBe('ILLEGAL_TRANSITION');

    const postReport = (await k.store('POST', '/blogs/reports', { targetType: 'post', targetId: second.id, reason: 'misleading' }, k.customer(who))).body;
    await k.admin('PATCH', `/blogs/reports/${postReport.id}`, { status: 'upheld' });
    expect((await k.admin('GET', `/blogs/posts/${second.id}`)).body.status).toBe('unpublished');
    const profile = await k.store('GET', '/blogs/authors/mina-park');
    expect(profile.body).toMatchObject({ name: 'Mina Park', postCount: 2, reportCount: 1 });
    expect((await k.store('GET', '/blogs/authors/mina-park/posts')).body.items.map((p: any) => p.title)).toEqual(['How rockets land upright']);
  });

  it('refuses to delete a topic or author still in use, and deletes a post with what hangs on it', async () => {
    expect((await k.admin('DELETE', `/blogs/topics/${topic.id}`)).body.error.code).toBe('IN_USE');
    expect((await k.admin('DELETE', `/blogs/authors/${author.id}`)).body.error.code).toBe('IN_USE');
    expect((await k.admin('DELETE', `/blogs/posts/${first.id}`)).status).toBe(204);
    expect((await k.admin('GET', `/blogs/posts/${first.id}`)).status).toBe(404);
    expect((await k.admin('DELETE', `/blogs/topics/${topic.id}`)).status).toBe(204);
  });
});

describe('companies', () => {
  let industry: any;
  let company: any;

  it('adds industries and companies, and lists the published ones in staff order', async () => {
    industry = (await k.admin('POST', '/industries', { name: 'Manufacturing' })).body;
    const tech = (await k.admin('POST', '/industries', { name: 'Technology' })).body;
    const logo = await k.uploadImage();
    company = (
      await k.admin('POST', '/companies', {
        name: 'Northwind Tools',
        industryId: industry.id,
        city: 'Portland, OR',
        tagline: 'Hand tools since 1982',
        verified: true,
        logo,
        contacts: { phone: '503-555-0100', email: 'hello@northwind.example', website: 'https://northwind.example', address: '1200 NW Front Ave, Portland, OR' },
        location: { lat: 45.53, lng: -122.68 },
        founded: 1982,
      })
    ).body;
    expect(company).toMatchObject({ slug: 'northwind-tools', status: 'published', position: 1, openInquiryCount: 0, industry: { name: 'Manufacturing' } });
    await k.admin('POST', '/companies', { name: 'Bitwise Labs', industryId: tech.id, city: 'Beaverton, OR' });
    await k.admin('POST', '/companies', { name: 'Quiet Co', status: 'hidden' });
    expect((await k.admin('POST', '/companies', { name: 'Bad Site', contacts: { website: 'javascript:alert(1)' } })).status).toBe(400);
    const list = await k.store('GET', '/companies');
    expect(list.body.items.map((c: any) => c.name)).toEqual(['Northwind Tools', 'Bitwise Labs']);
    expect((await k.store('GET', '/companies?industry=technology')).body.items.map((c: any) => c.name)).toEqual(['Bitwise Labs']);
    expect((await k.store('GET', '/companies?q=beaverton')).body.items.map((c: any) => c.name)).toEqual(['Bitwise Labs']);
    expect((await k.store('GET', '/industries')).body.map((i: any) => [i.name, i.companyCount])).toEqual([
      ['Manufacturing', 1],
      ['Technology', 1],
    ]);
    const page = await k.store('GET', '/companies/northwind-tools');
    expect(page.body).toMatchObject({ verified: true, founded: 1982, location: { lat: 45.53, lng: -122.68 }, contacts: { phone: '503-555-0100' } });
    expect(page.body.logo.id).toBe(logo.id);
    expect((await k.store('GET', '/companies/quiet-co')).status).toBe(404);
  });

  it('takes inquiries from customers once per Idempotency-Key and lets staff handle them', async () => {
    const key = newId();
    const sam = k.customer(newId());
    const send = () => k.app.inject({ method: 'POST', url: `/api/store/departments/companies/${company.id}/inquiries`, headers: { ...sam, 'idempotency-key': key }, payload: { name: 'Sam Lee', email: 'sam@example.com', message: 'Do you ship to Seattle?' } });
    const a = await send();
    expect(a.statusCode).toBe(201);
    expect(a.json().message).toBe('Sent to Northwind Tools. They usually reply by email.');
    expect((await send()).json().id).toBe(a.json().id);
    const list = await k.admin('GET', '/inquiries?status=new');
    expect(list.body.items).toHaveLength(1);
    expect((await k.admin('GET', `/companies/${company.id}`)).body.openInquiryCount).toBe(1);
    const done = await k.admin('PATCH', `/inquiries/${a.json().id}`, { status: 'replied', staffNote: 'Forwarded to sales' });
    expect(done.body).toMatchObject({ status: 'replied', staffNote: 'Forwarded to sales', companyName: 'Northwind Tools' });
    expect((await k.store('POST', `/companies/${company.id}/inquiries`, { name: 'X', email: 'x@example.com', message: 'Hi' })).status).toBe(401);
  });

  it('refuses to delete an industry in use; deleting a company takes its inquiries', async () => {
    expect((await k.admin('DELETE', `/industries/${industry.id}`)).body.error.code).toBe('IN_USE');
    expect((await k.admin('DELETE', `/companies/${company.id}`)).status).toBe(204);
    expect((await k.admin('GET', '/inquiries')).body.items).toEqual([]);
    expect((await k.admin('DELETE', `/industries/${industry.id}`)).status).toBe(204);
  });
});

describe('play center', () => {
  let game: any;

  it('lists published games with their genres in first-seen order; games are not playable yet', async () => {
    game = (await k.admin('POST', '/play/games', { title: 'Block Drop', genre: 'Puzzle', featured: true, howToPlay: ['Drop blocks', 'Clear lines'], prizes: [{ ranks: '#1', reward: '$20 coupon' }] })).body;
    await k.admin('POST', '/play/games', { title: 'Word Rush', genre: 'Word' });
    await k.admin('POST', '/play/games', { title: 'Turbo Lap', genre: 'Racing', status: 'hidden' });
    await k.admin('POST', '/play/games', { title: 'Fruit Match', genre: 'Puzzle' });
    const list = await k.store('GET', '/play/games');
    expect(list.body.games.map((g: any) => g.title)).toEqual(['Block Drop', 'Word Rush', 'Fruit Match']);
    expect(list.body.genres).toEqual(['Puzzle', 'Word']);
    expect(list.body.games[0]).toMatchObject({ featured: true, hasPrizes: true });
    expect((await k.store('GET', '/play/games?genre=puzzle')).body.games.map((g: any) => g.title)).toEqual(['Block Drop', 'Fruit Match']);
    const detail = await k.store('GET', '/play/games/block-drop');
    expect(detail.body).toMatchObject({ playable: false, howToPlay: ['Drop blocks', 'Clear lines'], prizes: [{ ranks: '#1', reward: '$20 coupon' }] });
    expect((await k.store('GET', '/play/games/turbo-lap')).status).toBe(404);
  });

  it('ranks the table by score, best first, per game and period', async () => {
    const res = await k.admin('PUT', `/play/games/${game.id}/rankings/week`, { entries: [{ name: 'Lee', score: 900 }, { name: 'Kai', score: 1200, change: 2 }, { name: 'Ana', score: 900, change: -1 }] });
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([
      { rank: 1, name: 'Kai', score: 1200, change: 2 },
      { rank: 2, name: 'Lee', score: 900, change: null },
      { rank: 3, name: 'Ana', score: 900, change: -1 },
    ]);
    expect((await k.admin('PUT', `/play/games/${game.id}/rankings/week`, { entries: [{ name: 'X', score: -1 }] })).status).toBe(400);
    const store = await k.store('GET', '/play/rankings');
    expect(store.body).toMatchObject({ period: 'week', game: { slug: 'block-drop' } });
    expect(store.body.entries).toHaveLength(3);
    expect((await k.store('GET', '/play/rankings?game=block-drop&period=today')).body.entries).toEqual([]);
    expect((await k.admin('GET', '/play/games')).body.find((g: any) => g.id === game.id).rankingsUpdatedAt).toBeTruthy();
    expect((await k.admin('DELETE', `/play/games/${game.id}`)).status).toBe(204);
    expect((await k.admin('GET', `/play/games/${game.id}/rankings/week`)).status).toBe(404);
  });

  it('needs departments.play.manage to change games', async () => {
    expect((await k.admin('POST', '/play/games', { title: 'Nope', genre: 'Arcade' }, k.staff(['departments.view']))).status).toBe(403);
  });
});
