import type { Principal } from '../../../kernel/auth/index.js';
import type { Scope } from '../../../kernel/auth/scope.js';
import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/departments.js';
import type { DepartmentsService } from '../service.js';

/**
 * The signed-in customer's key for reactions, replies, reports and inquiries: the account id, which reads open to
 * visitors also see on the principal (so myReaction and reply.mine match what the customer wrote)
 */
const customerOf = (scope: Scope): string => {
  if (scope.kind === 'customer') return scope.accountId;
  throw new AppError('UNAUTHORIZED', 'Sign in to continue');
};
/** The same key on a read open to visitors: null for visitors */
const viewerOf = (principal: Principal): string | null => (principal.kind === 'customer' && principal.accountId ? principal.accountId : null);

/**
 * Store API: /api/store/departments/…  (docs/api/modules/departments.md)
 * The app's department pages: reads are open to visitors; reacting, replying, reporting and inquiries need a customer.
 */
export const storeRoutes = (service: DepartmentsService) =>
  routes(endpoints, 'store', {
    /** GET /phones: The Phone tab: picked phones as product cards, in order */
    getPhones: async ({ query }) => service.getPhones(query),
    /** GET /blogs/topics: Visible blog topics in order */
    listBlogTopics: async () => service.listBlogTopics(),
    /** GET /blogs/posts: Published posts, newest first */
    listBlogPosts: async ({ query, page }) => service.listBlogPosts(query, page),
    /** GET /blogs/posts/{slug}: A published post with its body and the previous and next posts */
    getBlogPost: async ({ params, principal }) => service.getBlogPost(params.slug, viewerOf(principal)),
    /** POST /blogs/posts/{id}/reaction: Like, dislike or clear the reaction */
    reactToBlogPost: async ({ params, body, scope }) => service.reactToBlogPost(params.id, customerOf(scope), body.reaction),
    /** GET /blogs/posts/{id}/replies: Visible replies, oldest first */
    listBlogReplies: async ({ params, page, principal }) => service.listBlogReplies(params.id, viewerOf(principal), page),
    /** POST /blogs/posts/{id}/replies: Write a reply */
    replyToBlogPost: async ({ params, body, scope }) => service.replyToBlogPost(params.id, customerOf(scope), body),
    /** DELETE /blogs/replies/{id}: Delete my reply */
    deleteMyBlogReply: async ({ params, scope }) => service.deleteMyBlogReply(params.id, customerOf(scope)),
    /** GET /blogs/authors/{slug}: An author's profile */
    getBlogAuthor: async ({ params }) => service.getBlogAuthor(params.slug),
    /** GET /blogs/authors/{slug}/posts: An author's published posts, newest first */
    listBlogAuthorPosts: async ({ params, page }) => service.listBlogAuthorPosts(params.slug, page),
    /** POST /blogs/reports: Report a post, a reply or an author */
    reportBlogContent: async ({ body, scope }) => service.reportBlogContent(customerOf(scope), body),
    /** GET /industries: Visible industries in order */
    listIndustries: async () => service.listIndustries(),
    /** GET /companies: Published companies in staff order */
    listCompanies: async ({ query, page }) => service.listCompanies(query, page),
    /** GET /companies/{slug}: A company page */
    getCompany: async ({ params }) => service.getCompany(params.slug),
    /** POST /companies/{id}/inquiries: Send an inquiry to a company (staff pass it on) */
    sendInquiry: async ({ params, body, scope }) => service.sendInquiry(params.id, customerOf(scope), body),
    /** GET /play/games: Published games in staff order, with their genres */
    listGames: async ({ query }) => service.listGames(query),
    /** GET /play/games/{slug}: A game's page */
    getGame: async ({ params }) => service.getGame(params.slug),
    /** GET /play/rankings: A game's ranking table for a period */
    getRankings: async ({ query }) => service.getRankings(query),
  });
