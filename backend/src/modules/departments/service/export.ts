/**
 * The customer's part of the personal data export (customers.build-data-exports, FORMAT.md › Customer data export
 * hook). Reactions, replies, reports and inquiries are kept by account id, saves, follows, reply likes, reviews and
 * Play center rows by customers-module id; both ids are looked up everywhere, so a row written before the customer
 * record existed (the account id stood in for it) is included too. Staff notes and other people's details are left out.
 */
import type * as common from '../../../spec/common.js';
import { unique } from './base.js';
import { DepartmentsPlay } from './play.js';

const at = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export class DepartmentsExport extends DepartmentsPlay {
  async exportCustomerData(input: { customerId: string; accountId: string }): Promise<common.CustomerDataSection[]> {
    const ids = unique([input.customerId, input.accountId].filter((x): x is string => Boolean(x)));
    const d = await this.repo.customerData(ids);

    // what the rows point at, by name
    const postIds = unique([...d.reactions.map((r) => r.post_id), ...d.replies.map((r) => r.post_id), ...d.saves.map((s) => s.post_id), ...d.replyLikes.map((l) => l.post_id)]);
    const [posts, authors, companies, games] = await Promise.all([
      this.repo.postsByIds(postIds),
      this.repo.authorsByIds(unique(d.follows.map((f) => f.author_id))),
      this.repo.companiesByIds(unique([...d.inquiries.map((i) => i.company_id), ...d.reviews.filter((r) => r.target_type === 'company').map((r) => r.target_id)])),
      this.repo.listGames(),
    ]);
    const postTitle = new Map(posts.map((p) => [p.id, p.title]));
    const authorName = new Map(authors.map((a) => [a.id, a.name]));
    const companyName = new Map(companies.map((c) => [c.id, c.name]));
    const gameTitle = new Map(games.map((g) => [g.id, g.title]));
    const reportTargets = new Map<string, string>();
    for (const r of d.reports) {
      if (r.target_type === 'post') reportTargets.set(r.target_id, postTitle.get(r.target_id) ?? (await this.repo.getPost(r.target_id))?.title ?? 'Deleted post');
      else if (r.target_type === 'author') reportTargets.set(r.target_id, (await this.repo.getAuthor(r.target_id))?.name ?? 'Deleted author');
      else reportTargets.set(r.target_id, 'A reply');
    }
    const players = new Map(d.players.map((p) => [p.id, p.code]));

    const out: common.CustomerDataSection[] = [];
    const add = (key: string, title: string, records: unknown[]) => {
      if (records.length) out.push({ key, title, module: 'departments', records: records as never[] });
    };
    add('blog_reactions', 'Blog likes and dislikes', d.reactions.map((r) => ({ post: postTitle.get(r.post_id) ?? 'Deleted post', reaction: r.reaction, at: at(r.at) })));
    add('blog_replies', 'Blog replies', d.replies.map((r) => ({ post: postTitle.get(r.post_id) ?? 'Deleted post', text: r.text, shownAs: r.author_name, answersAnotherReply: Boolean(r.parent_id), hiddenByStaff: r.status === 'hidden', likes: r.like_count ?? 0, writtenAt: at(r.created_at) })));
    add('blog_reports', 'Blog reports', d.reports.map((r) => ({ about: r.target_type, target: reportTargets.get(r.target_id) ?? null, reason: r.reason, note: r.note, status: r.status, reportedAt: at(r.created_at), decidedAt: at(r.decided_at) })));
    add('blog_saved_posts', 'Saved blog posts', d.saves.map((s) => ({ post: postTitle.get(s.post_id) ?? 'Deleted post', savedAt: at(s.saved_at) })));
    add('blog_followed_authors', 'Followed blog authors', d.follows.map((f) => ({ author: authorName.get(f.author_id) ?? 'Deleted author', followedAt: at(f.followed_at) })));
    add('blog_reply_likes', 'Liked blog replies', d.replyLikes.map((l) => ({ post: postTitle.get(l.post_id) ?? 'Deleted post', likedAt: at(l.at) })));
    add('company_inquiries', 'Company inquiries', d.inquiries.map((i) => ({ company: companyName.get(i.company_id) ?? 'Deleted company', name: i.name, email: i.email, phone: i.phone, message: i.message, status: i.status, sentAt: at(i.created_at) })));
    add('department_reviews', 'Company and game reviews', d.reviews.map((r) => ({ about: r.target_type, target: (r.target_type === 'company' ? companyName.get(r.target_id) : gameTitle.get(r.target_id)) ?? 'Deleted', stars: r.stars, text: r.text, shownAs: r.name, hiddenByStaff: r.hidden, writtenAt: at(r.created_at), changedAt: at(r.updated_at) })));
    add('play_player', 'Play center player ID', d.players.map((p) => ({ playerId: p.code, shownAs: p.name, issuedAt: at(p.created_at) })));
    add('play_scores', 'Play center scores', d.scores.map((s) => ({ game: gameTitle.get(s.game_id) ?? 'Deleted game', playerId: players.get(s.player_id) ?? null, score: s.score, playedAt: at(s.played_at), receivedAt: at(s.received_at) })));
    add('play_prizes', 'Play center prizes', d.awards.map((a) => ({ game: gameTitle.get(a.game_id) ?? 'Deleted game', week: a.week, rank: a.rank, score: a.score, reward: a.reward, couponCode: a.code, state: a.state, at: at(a.updated_at) })));
    return out;
  }
}
