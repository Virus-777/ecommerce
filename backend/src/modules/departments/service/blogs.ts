/**
 * Blogs: topics, staff author profiles and posts written in Admin › Departments › Blogs; customers like or dislike a
 * post, reply to it and report posts, replies or authors. Replies show at once and staff hide them when needed;
 * an upheld report hides the reply or unpublishes the post.
 */
import { newId } from '../../../kernel/lib/ids.js';
import { pageOf, type Page, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { BlogAuthor, BlogAuthorAdmin, BlogAuthorCard, BlogAuthorInput, BlogPost, BlogPostAdmin, BlogPostCard, BlogPostInput, BlogReactionResult, BlogReply, BlogReplyAdmin, BlogReportAdmin, BlogReportInput, BlogTopic, BlogTopicInput, BlogTopicRef } from '../../../spec/departments.js';
import { LIMITS, plainText, readMinutes, replyAuthorName, sanitizeHtml } from '../domain/rules.js';
import type { AuthorRow, PostRow, ReplyRow, ReportRow, TopicRow } from '../ports.js';
import { actorKey, invalid, iso, mediaOf, notFound, optionalText, requireText, unique, type By, type StoredMedia } from './base.js';
import { DepartmentsPhones } from './phones.js';

type Reaction = 'like' | 'dislike';
const asReaction = (v: string | null | undefined): Reaction | null => (v === 'like' || v === 'dislike' ? v : null);

export class DepartmentsBlogs extends DepartmentsPhones {
  /* ---------------------------------------------------------------- mapping */

  private topicRef(t: TopicRow | undefined): BlogTopicRef | null {
    return t ? { id: t.id, slug: t.slug, name: t.name } : null;
  }

  private authorCard(a: AuthorRow | undefined, refs: Map<string, common.MediaRef>): BlogAuthorCard {
    if (!a) return { id: '00000000-0000-4000-8000-000000000000', slug: 'unknown', name: 'Marketly', avatar: null };
    const avatar = mediaOf(a.avatar);
    return { id: a.id, slug: a.slug, name: a.name, avatar: avatar ? (refs.get(avatar.id) ?? null) : null };
  }

  /** Topics, authors and pictures of a list of posts, read once */
  private async postContext(posts: PostRow[]) {
    const [topics, authors] = await Promise.all([this.repo.topicsByIds(unique(posts.map((p) => p.topic_id).filter((x): x is string => Boolean(x)))), this.repo.authorsByIds(unique(posts.map((p) => p.author_id)))]);
    const refs = await this.refsMap([...posts.map((p) => mediaOf(p.cover)?.id), ...authors.map((a) => mediaOf(a.avatar)?.id)]);
    return { topics: new Map(topics.map((t) => [t.id, t])), authors: new Map(authors.map((a) => [a.id, a])), refs };
  }

  private cardOf(p: PostRow, c: Awaited<ReturnType<DepartmentsBlogs['postContext']>>): BlogPostCard {
    const cover = mediaOf(p.cover);
    return {
      id: p.id,
      slug: p.slug,
      title: p.title,
      summary: p.summary,
      cover: cover ? (c.refs.get(cover.id) ?? null) : null,
      topic: this.topicRef(p.topic_id ? c.topics.get(p.topic_id) : undefined),
      author: this.authorCard(c.authors.get(p.author_id), c.refs),
      publishedAt: (p.published_at ?? p.created_at).toISOString(),
      readMinutes: p.read_minutes,
      likeCount: p.like_count,
      dislikeCount: p.dislike_count,
      replyCount: p.reply_count,
      featured: p.featured,
    };
  }

  private async cards(posts: PostRow[]): Promise<BlogPostCard[]> {
    const c = await this.postContext(posts);
    return posts.map((p) => this.cardOf(p, c));
  }

  private async adminPost(p: PostRow): Promise<BlogPostAdmin> {
    const c = await this.postContext([p]);
    const reports = await this.repo.openReportCounts('post', [p.id]);
    const card = this.cardOf(p, c);
    return {
      id: p.id,
      slug: p.slug,
      title: p.title,
      summary: p.summary,
      cover: card.cover ?? null,
      body: p.body,
      topic: card.topic ?? null,
      author: card.author,
      status: p.status as BlogPostAdmin['status'],
      featured: p.featured,
      publishedAt: iso(p.published_at),
      readMinutes: p.read_minutes,
      likeCount: p.like_count,
      dislikeCount: p.dislike_count,
      replyCount: p.reply_count,
      openReportCount: reports.get(p.id) ?? 0,
      createdAt: p.created_at.toISOString(),
      updatedAt: p.updated_at.toISOString(),
    };
  }

  /** Topics customers don't see: their posts are left out of the store */
  private async hiddenTopicIds(): Promise<string[]> {
    return (await this.repo.listTopics()).filter((t) => !t.visible).map((t) => t.id);
  }

  /** A post customers can see: published, in no topic or a visible one */
  private async publishedPost(p: PostRow | undefined): Promise<PostRow> {
    if (!p || p.status !== 'published') throw notFound('Post');
    if (p.topic_id && (await this.hiddenTopicIds()).includes(p.topic_id)) throw notFound('Post');
    return p;
  }

  /* ---------------------------------------------------------------- topics */

  private async topicsOut(rows: TopicRow[]): Promise<BlogTopic[]> {
    const counts = await this.repo.postCounts('topic_id');
    return rows.map((t) => ({ id: t.id, slug: t.slug, name: t.name, position: t.position, visible: t.visible, postCount: counts.get(t.id) ?? 0 }));
  }

  async listBlogTopics(): Promise<BlogTopic[]> {
    return this.topicsOut(await this.repo.listTopics({ visibleOnly: true }));
  }

  async listBlogTopicsAdmin(): Promise<BlogTopic[]> {
    return this.topicsOut(await this.repo.listTopics());
  }

  async createBlogTopic(input: BlogTopicInput, by: By): Promise<BlogTopic> {
    const name = requireText(input.name, 'name', LIMITS.name, 'Name the topic');
    const row: TopicRow = { id: newId(), slug: await this.slugFor('topics', input.slug, name), name, position: input.position ?? (await this.repo.countTopics()) + 1, visible: input.visible ?? true };
    await this.repo.insertTopic(row);
    await this.audit({ action: 'departments.blogs.topic.create', actionLabel: 'Added a blog topic', target: { type: 'blog_topic', id: row.id, label: name }, after: row }, by);
    return (await this.topicsOut([row]))[0]!;
  }

  async updateBlogTopic(id: string, input: BlogTopicInput, by: By): Promise<BlogTopic> {
    const before = await this.repo.getTopic(id);
    if (!before) throw notFound('Topic');
    const name = requireText(input.name, 'name', LIMITS.name, 'Name the topic');
    const patch: Partial<TopicRow> = { name, slug: input.slug !== undefined && input.slug !== null ? await this.slugFor('topics', input.slug, name, id) : before.slug, ...(input.position != null ? { position: input.position } : {}), ...(input.visible != null ? { visible: input.visible } : {}) };
    const after = (await this.repo.updateTopic(id, patch))!;
    await this.audit({ action: 'departments.blogs.topic.update', actionLabel: 'Edited a blog topic', target: { type: 'blog_topic', id, label: name }, before, after }, by);
    return (await this.topicsOut([after]))[0]!;
  }

  async deleteBlogTopic(id: string, by: By): Promise<void> {
    const t = await this.repo.getTopic(id);
    if (!t) throw notFound('Topic');
    if (await this.repo.countPosts({ topicId: id })) throw this.ctx.error('IN_USE', 'Posts still use this topic; move or delete them first');
    await this.repo.deleteTopic(id);
    await this.audit({ action: 'departments.blogs.topic.delete', actionLabel: 'Deleted a blog topic', target: { type: 'blog_topic', id, label: t.name }, before: t }, by);
  }

  /* ---------------------------------------------------------------- authors */

  private async authorsAdmin(rows: AuthorRow[]): Promise<BlogAuthorAdmin[]> {
    const [counts, likes, refs] = await Promise.all([this.repo.postCounts('author_id', { all: true }), this.repo.likesByAuthor(), this.refsMap(rows.map((a) => mediaOf(a.avatar)?.id))]);
    const reports = await Promise.all(rows.map(async (a) => this.repo.countUpheldAbout(a.id, await this.repo.postIdsOfAuthor(a.id))));
    return rows.map((a, i) => {
      const avatar = mediaOf(a.avatar);
      return { id: a.id, slug: a.slug, name: a.name, avatar: avatar ? (refs.get(avatar.id) ?? null) : null, email: a.email, bio: a.bio, postCount: counts.get(a.id) ?? 0, likeCount: likes.get(a.id) ?? 0, reportCount: reports[i]!, createdAt: a.created_at.toISOString(), updatedAt: a.updated_at.toISOString() };
    });
  }

  async listBlogAuthorsAdmin(): Promise<BlogAuthorAdmin[]> {
    return this.authorsAdmin(await this.repo.listAuthors());
  }

  private authorFields(input: BlogAuthorInput) {
    const name = requireText(input.name, 'name', LIMITS.name, 'Name the author');
    const email = optionalText(input.email, 'email', 200);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('email', 'Use an email address like name@example.com');
    return { name, email, bio: optionalText(input.bio, 'bio', 1000), avatar: input.avatar?.id ? { id: input.avatar.id } : null };
  }

  async createBlogAuthor(input: BlogAuthorInput, by: By): Promise<BlogAuthorAdmin> {
    const f = this.authorFields(input);
    const id = newId();
    const now = this.now();
    const row: AuthorRow = { id, slug: await this.slugFor('authors', input.slug, f.name), name: f.name, email: f.email, bio: f.bio, avatar: f.avatar, created_at: now, updated_at: now };
    await this.withMedia(id, f.name, [], f.avatar ? [{ id: f.avatar.id, path: 'avatar' }] : [], () => this.repo.insertAuthor(row));
    await this.audit({ action: 'departments.blogs.author.create', actionLabel: 'Added a blog author', target: { type: 'blog_author', id, label: f.name }, after: row }, by);
    return (await this.authorsAdmin([row]))[0]!;
  }

  async updateBlogAuthor(id: string, input: BlogAuthorInput, by: By): Promise<BlogAuthorAdmin> {
    const before = await this.repo.getAuthor(id);
    if (!before) throw notFound('Author');
    const f = this.authorFields(input);
    const slug = input.slug !== undefined && input.slug !== null ? await this.slugFor('authors', input.slug, f.name, id) : before.slug;
    const prev = mediaOf(before.avatar);
    const after = await this.withMedia(id, f.name, prev ? [prev] : [], f.avatar ? [{ id: f.avatar.id, path: 'avatar' }] : [], async () => (await this.repo.updateAuthor(id, { ...f, slug, updated_at: this.now() }))!);
    await this.audit({ action: 'departments.blogs.author.update', actionLabel: 'Edited a blog author', target: { type: 'blog_author', id, label: f.name }, before, after }, by);
    return (await this.authorsAdmin([after]))[0]!;
  }

  async deleteBlogAuthor(id: string, by: By): Promise<void> {
    const a = await this.repo.getAuthor(id);
    if (!a) throw notFound('Author');
    if (await this.repo.countPosts({ authorId: id })) throw this.ctx.error('IN_USE', 'This author still has posts; move or delete them first');
    await this.repo.deleteAuthor(id);
    const avatar = mediaOf(a.avatar);
    if (avatar) await this.detachAll(id, [avatar]);
    await this.audit({ action: 'departments.blogs.author.delete', actionLabel: 'Deleted a blog author', target: { type: 'blog_author', id, label: a.name }, before: a }, by);
  }

  async getBlogAuthor(slug: string): Promise<BlogAuthor> {
    const a = await this.repo.authorBySlug(slug);
    if (!a) throw notFound('Author');
    const [counts, likes, refs, postIds] = await Promise.all([this.repo.postCounts('author_id'), this.repo.likesByAuthor(), this.refsMap([mediaOf(a.avatar)?.id]), this.repo.postIdsOfAuthor(a.id)]);
    const avatar = mediaOf(a.avatar);
    return { id: a.id, slug: a.slug, name: a.name, avatar: avatar ? (refs.get(avatar.id) ?? null) : null, email: a.email, bio: a.bio, postCount: counts.get(a.id) ?? 0, likeCount: likes.get(a.id) ?? 0, reportCount: await this.repo.countUpheldAbout(a.id, postIds), joinedAt: a.created_at.toISOString() };
  }

  async listBlogAuthorPosts(slug: string, page: PageRequest): Promise<Page<BlogPostCard>> {
    const a = await this.repo.authorBySlug(slug);
    if (!a) return pageOf([], page);
    const res = await this.repo.pagePublished({ authorId: a.id, hiddenTopicIds: await this.hiddenTopicIds() }, page);
    return { ...res, items: await this.cards(res.items) };
  }

  /* ---------------------------------------------------------------- posts (store) */

  async listBlogPosts(q: { topic?: string; q?: string }, page: PageRequest): Promise<Page<BlogPostCard>> {
    let topicId: string | undefined;
    if (q.topic) {
      const t = await this.repo.topicBySlug(q.topic);
      if (!t || !t.visible) return pageOf([], page);
      topicId = t.id;
    }
    const res = await this.repo.pagePublished({ topicId, hiddenTopicIds: topicId ? undefined : await this.hiddenTopicIds(), q: q.q }, page);
    return { ...res, items: await this.cards(res.items) };
  }

  async getBlogPost(slug: string, customerId: string | null): Promise<BlogPost> {
    const p = await this.publishedPost(await this.repo.postBySlug(slug));
    const hidden = await this.hiddenTopicIds();
    const [previous, next, mine] = await Promise.all([this.repo.neighbour(p, 'previous', hidden), this.repo.neighbour(p, 'next', hidden), customerId ? this.repo.getReaction(p.id, customerId) : Promise.resolve(undefined)]);
    const list = [p, ...(previous ? [previous] : []), ...(next ? [next] : [])];
    const c = await this.postContext(list);
    return {
      ...this.cardOf(p, c),
      body: sanitizeHtml(p.body),
      myReaction: asReaction(mine?.reaction),
      previous: previous ? this.cardOf(previous, c) : null,
      next: next ? this.cardOf(next, c) : null,
    };
  }

  async reactToBlogPost(postId: string, customerId: string, reaction: Reaction | 'none'): Promise<BlogReactionResult> {
    await this.publishedPost(await this.repo.getPost(postId));
    const out = await this.repo.transaction(async (tx) => {
      const post = (await tx.getPost(postId, { forUpdate: true }))!;
      const existing = await tx.getReaction(postId, customerId);
      const was = asReaction(existing?.reaction);
      const now = reaction === 'none' ? null : reaction;
      if (was === now) return { likeCount: post.like_count, dislikeCount: post.dislike_count, myReaction: now };
      if (existing && now) await tx.updateReaction(existing.id, { reaction: now, at: this.now() });
      else if (existing) await tx.deleteReaction(existing.id);
      else if (now) await tx.insertReaction({ id: newId(), post_id: postId, customer_id: customerId, reaction: now, at: this.now() });
      const likes = post.like_count + (now === 'like' ? 1 : 0) - (was === 'like' ? 1 : 0);
      const dislikes = post.dislike_count + (now === 'dislike' ? 1 : 0) - (was === 'dislike' ? 1 : 0);
      await tx.updatePost(postId, { like_count: Math.max(0, likes), dislike_count: Math.max(0, dislikes) });
      return { likeCount: Math.max(0, likes), dislikeCount: Math.max(0, dislikes), myReaction: now };
    });
    return out;
  }

  /* ---------------------------------------------------------------- replies */

  private replyOut(r: ReplyRow, customerId: string | null): BlogReply {
    return { id: r.id, postId: r.post_id, parentId: r.parent_id, authorName: r.author_name, text: r.text, createdAt: r.created_at.toISOString(), mine: Boolean(customerId && r.customer_id === customerId) };
  }

  async listBlogReplies(postId: string, customerId: string | null, page: PageRequest): Promise<Page<BlogReply>> {
    const p = await this.repo.getPost(postId);
    if (!p || p.status !== 'published') return pageOf([], page);
    const res = await this.repo.pageVisibleReplies(postId, page);
    return { ...res, items: res.items.map((r) => this.replyOut(r, customerId)) };
  }

  /** The signed name of a reply: the customer's first name and last initial (customers), else Customer */
  private async replyName(accountId: string): Promise<string> {
    const customers = this.ctx.tryUse('customers');
    const c = await this.soft('customers.getCustomerByUserId', customers && (() => customers.getCustomerByUserId(accountId)), null);
    return replyAuthorName(c?.displayName);
  }

  private async recountReplies(postId: string) {
    await this.repo.updatePost(postId, { reply_count: await this.repo.countVisibleReplies(postId) });
  }

  async replyToBlogPost(postId: string, customerId: string, body: { text: string; parentId?: string | null }): Promise<BlogReply> {
    const post = await this.publishedPost(await this.repo.getPost(postId));
    if (!(await this.ctx.settings.get('blogRepliesOpen'))) throw this.ctx.error('REPLIES_CLOSED', 'Replies are closed for now');
    const text = requireText(body.text, 'text', LIMITS.replyText, 'Write your reply');
    let parentId: string | null = null;
    if (body.parentId) {
      const parent = await this.repo.getReply(body.parentId);
      if (!parent || parent.post_id !== post.id || parent.status !== 'visible') throw invalid('parentId', 'That reply is no longer there');
      // one level: answering an answer joins its thread
      parentId = parent.parent_id ?? parent.id;
    }
    const row: ReplyRow = { id: newId(), post_id: post.id, parent_id: parentId, customer_id: customerId, author_name: await this.replyName(customerId), text, status: 'visible', created_at: this.now() };
    await this.repo.insertReply(row);
    await this.recountReplies(post.id);
    return this.replyOut(row, customerId);
  }

  async deleteMyBlogReply(id: string, customerId: string): Promise<void> {
    const r = await this.repo.getReply(id);
    if (!r || r.customer_id !== customerId) throw notFound('Reply');
    await this.repo.deleteReplyCascade(id);
    await this.recountReplies(r.post_id);
  }

  private async repliesAdmin(rows: ReplyRow[]): Promise<BlogReplyAdmin[]> {
    const [posts, reports] = await Promise.all([this.repo.postsByIds(unique(rows.map((r) => r.post_id))), this.repo.openReportCounts('reply', rows.map((r) => r.id))]);
    const titles = new Map(posts.map((p) => [p.id, p.title]));
    return rows.map((r) => ({ id: r.id, postId: r.post_id, postTitle: titles.get(r.post_id) ?? 'Deleted post', parentId: r.parent_id, customerId: r.customer_id, authorName: r.author_name, text: r.text, status: r.status as BlogReplyAdmin['status'], openReportCount: reports.get(r.id) ?? 0, createdAt: r.created_at.toISOString() }));
  }

  async listBlogRepliesAdmin(q: { status?: 'visible' | 'hidden'; postId?: string; reported?: boolean }, page: PageRequest): Promise<Page<BlogReplyAdmin>> {
    const ids = q.reported ? await this.repo.reportedReplyIds() : undefined;
    const res = await this.repo.pageAdminReplies({ status: q.status, postId: q.postId, ids }, page);
    return { ...res, items: await this.repliesAdmin(res.items) };
  }

  async moderateBlogReply(id: string, status: 'visible' | 'hidden', by: By): Promise<BlogReplyAdmin> {
    const before = await this.repo.getReply(id);
    if (!before) throw notFound('Reply');
    const after = (await this.repo.updateReply(id, { status }))!;
    await this.recountReplies(before.post_id);
    await this.audit({ action: status === 'hidden' ? 'departments.blogs.reply.hide' : 'departments.blogs.reply.show', actionLabel: status === 'hidden' ? 'Hid a blog reply' : 'Showed a blog reply again', target: { type: 'blog_reply', id, label: before.text.slice(0, 60) }, before: { status: before.status }, after: { status } }, by);
    return (await this.repliesAdmin([after]))[0]!;
  }

  /* ---------------------------------------------------------------- reports */

  async reportBlogContent(customerId: string, input: BlogReportInput): Promise<{ id: string }> {
    const exists =
      input.targetType === 'post'
        ? (await this.repo.getPost(input.targetId))?.status === 'published'
        : input.targetType === 'reply'
          ? (await this.repo.getReply(input.targetId))?.status === 'visible'
          : Boolean(await this.repo.getAuthor(input.targetId));
    if (!exists) throw notFound(input.targetType === 'post' ? 'Post' : input.targetType === 'reply' ? 'Reply' : 'Author');
    const row: ReportRow = { id: newId(), target_type: input.targetType, target_id: input.targetId, reporter_id: customerId, reason: input.reason, note: optionalText(input.note, 'note', LIMITS.reportNote), status: 'open', created_at: this.now(), decided_at: null, decided_by: null };
    const saved = await this.repo.insertReport(row);
    if (!saved) throw this.ctx.error('ALREADY_REPORTED', 'You already reported this');
    return { id: saved.id };
  }

  private async reportsAdmin(rows: ReportRow[]): Promise<BlogReportAdmin[]> {
    const ids = (type: string) => rows.filter((r) => r.target_type === type).map((r) => r.target_id);
    const [posts, replies, authors] = await Promise.all([this.repo.postsByIds(ids('post')), this.repo.repliesByIds(ids('reply')), this.repo.authorsByIds(ids('author'))]);
    const labels = new Map<string, string>([...posts.map((p) => [p.id, p.title] as const), ...replies.map((r) => [r.id, r.text.length > 60 ? `${r.text.slice(0, 57)}…` : r.text] as const), ...authors.map((a) => [a.id, a.name] as const)]);
    return rows.map((r) => ({ id: r.id, targetType: r.target_type as BlogReportAdmin['targetType'], targetId: r.target_id, targetLabel: labels.get(r.target_id) ?? 'Deleted', reason: r.reason as BlogReportAdmin['reason'], note: r.note, status: r.status as BlogReportAdmin['status'], reporterId: r.reporter_id, createdAt: r.created_at.toISOString(), decidedAt: iso(r.decided_at) }));
  }

  async listBlogReports(q: { status?: 'open' | 'upheld' | 'dismissed' }, page: PageRequest): Promise<Page<BlogReportAdmin>> {
    const res = await this.repo.pageReports({ status: q.status }, page);
    return { ...res, items: await this.reportsAdmin(res.items) };
  }

  /** open → upheld or dismissed; upholding hides the reply or unpublishes the post */
  async decideBlogReport(id: string, status: 'upheld' | 'dismissed', by: By): Promise<BlogReportAdmin> {
    const r = await this.repo.getReport(id);
    if (!r) throw notFound('Report');
    if (r.status !== 'open') throw this.ctx.error('ILLEGAL_TRANSITION', 'This report was already decided', { from: r.status, event: status });
    const after = (await this.repo.updateReport(id, { status, decided_at: this.now(), decided_by: actorKey(by.actor) }))!;
    if (status === 'upheld' && r.target_type === 'reply') {
      const reply = await this.repo.getReply(r.target_id);
      if (reply && reply.status !== 'hidden') {
        await this.repo.updateReply(reply.id, { status: 'hidden' });
        await this.recountReplies(reply.post_id);
      }
    }
    if (status === 'upheld' && r.target_type === 'post') {
      const post = await this.repo.getPost(r.target_id);
      if (post?.status === 'published') await this.repo.updatePost(post.id, { status: 'unpublished', updated_at: this.now() });
    }
    const [out] = await this.reportsAdmin([after]);
    await this.audit({ action: status === 'upheld' ? 'departments.blogs.report.uphold' : 'departments.blogs.report.dismiss', actionLabel: status === 'upheld' ? 'Upheld a blog report' : 'Dismissed a blog report', target: { type: `blog_${r.target_type}`, id: r.target_id, label: out!.targetLabel }, before: { status: 'open' }, after: { status } }, by);
    return out!;
  }

  /* ---------------------------------------------------------------- posts (admin) */

  async listBlogPostsAdmin(q: { status?: 'draft' | 'published' | 'unpublished'; topicId?: string; authorId?: string; q?: string }, page: PageRequest): Promise<Page<BlogPostAdmin>> {
    const res = await this.repo.pageAdminPosts(q, page);
    return { ...res, items: await Promise.all(res.items.map((p) => this.adminPost(p))) };
  }

  async getBlogPostAdmin(id: string): Promise<BlogPostAdmin> {
    const p = await this.repo.getPost(id);
    if (!p) throw notFound('Post');
    return this.adminPost(p);
  }

  /** The checked parts of a post input (slug and publish time are worked out by the caller) */
  private async postFields(input: BlogPostInput) {
    const title = requireText(input.title, 'title', LIMITS.postTitle, 'Give the post a title');
    const body = sanitizeHtml(input.body);
    if (!plainText(body)) throw invalid('body', 'Write the post');
    if (input.topicId && !(await this.repo.getTopic(input.topicId))) throw invalid('topicId', 'Topic not found');
    if (!input.authorId || !(await this.repo.getAuthor(input.authorId))) throw invalid('authorId', 'Pick the author');
    return { title, body, summary: optionalText(input.summary, 'summary', LIMITS.postSummary), topic_id: input.topicId ?? null, author_id: input.authorId, cover: input.cover?.id ? { id: input.cover.id } : null, read_minutes: readMinutes(body) };
  }

  async createBlogPost(input: BlogPostInput, by: By): Promise<BlogPostAdmin> {
    const f = await this.postFields(input);
    const id = newId();
    const now = this.now();
    const status = input.status ?? 'draft';
    const row: PostRow = { id, slug: await this.slugFor('posts', input.slug, f.title), ...f, status, featured: input.featured ?? false, published_at: status === 'published' ? now : null, like_count: 0, dislike_count: 0, reply_count: 0, created_at: now, updated_at: now };
    await this.withMedia(id, f.title, [], f.cover ? [{ id: f.cover.id, path: 'cover' }] : [], () => this.repo.insertPost(row));
    await this.audit({ action: 'departments.blogs.post.create', actionLabel: status === 'published' ? 'Published a blog post' : 'Wrote a blog post', target: { type: 'blog_post', id, label: f.title }, after: { ...row, body: undefined } }, by);
    return this.adminPost(row);
  }

  async updateBlogPost(id: string, input: BlogPostInput, by: By): Promise<BlogPostAdmin> {
    const before = await this.repo.getPost(id);
    if (!before) throw notFound('Post');
    const f = await this.postFields(input);
    const slug = input.slug !== undefined && input.slug !== null ? await this.slugFor('posts', input.slug, f.title, id) : before.slug;
    const status = input.status ?? (before.status as BlogPostAdmin['status']);
    const now = this.now();
    const prev = mediaOf(before.cover);
    const patch: Partial<PostRow> = { ...f, slug, status, featured: input.featured ?? before.featured, published_at: status === 'published' && !before.published_at ? now : before.published_at, updated_at: now };
    const after = await this.withMedia(id, f.title, prev ? [prev] : ([] as StoredMedia[]), f.cover ? [{ id: f.cover.id, path: 'cover' }] : [], async () => (await this.repo.updatePost(id, patch))!);
    const label = status !== before.status ? (status === 'published' ? 'Published a blog post' : status === 'unpublished' ? 'Unpublished a blog post' : 'Moved a blog post back to draft') : 'Edited a blog post';
    await this.audit({ action: 'departments.blogs.post.update', actionLabel: label, target: { type: 'blog_post', id, label: f.title }, before: { ...before, body: undefined }, after: { ...after, body: undefined } }, by);
    return this.adminPost(after);
  }

  async deleteBlogPost(id: string, by: By): Promise<void> {
    const p = await this.repo.getPost(id);
    if (!p) throw notFound('Post');
    await this.repo.transaction((tx) => tx.deletePostCascade(id));
    const cover = mediaOf(p.cover);
    if (cover) await this.detachAll(id, [cover]);
    await this.audit({ action: 'departments.blogs.post.delete', actionLabel: 'Deleted a blog post', target: { type: 'blog_post', id, label: p.title }, before: { ...p, body: undefined } }, by);
  }
}
