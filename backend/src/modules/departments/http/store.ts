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
 * The signed-in customer's customers-module id (else the account id), as saves, follows, reply likes, reviews and
 * player IDs keep it: null for visitors on the reads open to them (those endpoints have own-customer scope)
 */
const customerIdOf = (scope: Scope): string | null => (scope.kind === 'customer' ? (scope.customerId ?? scope.accountId) : null);
const signedInCustomer = (scope: Scope): string => customerIdOf(scope) ?? customerOf(scope);
const accountOf = (scope: Scope): string | null => (scope.kind === 'customer' ? scope.accountId : null);

/**
 * Store API: /api/store/departments/…  (docs/api/modules/departments.md)
 * The app's department pages: reads are open to visitors; reacting, replying, reporting and inquiries need a customer.
 */
export const storeRoutes = (service: DepartmentsService) =>
  routes(endpoints, 'store', {
    /** GET /farm: Farm machines: types and picked machines */
    getFarm: async ({ query }) => service.getFarm(query),
    /** GET /farm/machines/{productId}: A picked machine with its attachments */
    getFarmMachine: async ({ params }) => service.getFarmMachine(params.productId),
    /** GET /phones: The Phone tab: published phones as cards, in staff order */
    getPhones: async () => service.getPhones(),
    /** GET /phones/{slug}: A phone page: Detail and Photos tabs */
    getPhone: async ({ params }) => service.getPhone(params.slug),
    /** GET /blogs/topics: Visible blog topics in order */
    listBlogTopics: async () => service.listBlogTopics(),
    /** GET /blogs/posts: Published posts, newest first */
    listBlogPosts: async ({ query, page }) => service.listBlogPosts(query, page),
    /** GET /blogs/posts/{slug}: A published post with its body and the previous and next posts */
    getBlogPost: async ({ params, principal, scope }) => service.getBlogPost(params.slug, viewerOf(principal), customerIdOf(scope)),
    /** POST /blogs/posts/{id}/save: Save or unsave a post (bookmark) */
    saveBlogPost: async ({ params, body, scope }) => service.saveBlogPost(params.id, signedInCustomer(scope), body.saved),
    /** GET /blogs/saved: My saved posts, last saved first */
    listSavedBlogPosts: async ({ scope, page }) => service.listSavedBlogPosts(signedInCustomer(scope), page),
    /** POST /blogs/posts/{id}/reaction: Like, dislike or clear the reaction */
    reactToBlogPost: async ({ params, body, scope }) => service.reactToBlogPost(params.id, customerOf(scope), body.reaction),
    /** GET /blogs/posts/{id}/replies: Visible replies, oldest first */
    listBlogReplies: async ({ params, page, principal, scope }) => service.listBlogReplies(params.id, viewerOf(principal), page, customerIdOf(scope)),
    /** POST /blogs/replies/{id}/like: Like a reply or take the like back */
    likeBlogReply: async ({ params, body, scope }) => service.likeBlogReply(params.id, signedInCustomer(scope), body.liked),
    /** POST /blogs/posts/{id}/replies: Write a reply */
    replyToBlogPost: async ({ params, body, scope }) => service.replyToBlogPost(params.id, customerOf(scope), body),
    /** DELETE /blogs/replies/{id}: Delete my reply */
    deleteMyBlogReply: async ({ params, scope }) => service.deleteMyBlogReply(params.id, customerOf(scope)),
    /** GET /blogs/authors/{slug}: An author's profile */
    getBlogAuthor: async ({ params, scope }) => service.getBlogAuthor(params.slug, customerIdOf(scope)),
    /** POST /blogs/authors/{id}/follow: Follow or unfollow an author */
    followBlogAuthor: async ({ params, body, scope }) => service.followBlogAuthor(params.id, signedInCustomer(scope), body.following),
    /** GET /blogs/following: Authors I follow, last followed first */
    listFollowedBlogAuthors: async ({ scope, page }) => service.listFollowedBlogAuthors(signedInCustomer(scope), page),
    /** GET /blogs/authors/{slug}/posts: An author's published posts, newest first */
    listBlogAuthorPosts: async ({ params, page }) => service.listBlogAuthorPosts(params.slug, page),
    /** POST /blogs/reports: Report a post, a reply or an author */
    reportBlogContent: async ({ body, scope }) => service.reportBlogContent(customerOf(scope), body),
    /** GET /industries: Visible industries in order */
    listIndustries: async () => service.listIndustries(),
    /** GET /companies: Published companies in staff order */
    listCompanies: async ({ query, page }) => service.listCompanies(query, page),
    /** GET /companies/{slug}: A company page */
    getCompany: async ({ params, scope }) => service.getCompany(params.slug, customerIdOf(scope)),
    /** GET /companies/{slug}/reviews: A company's visible reviews, newest first */
    listCompanyReviews: async ({ params, query, page, scope }) => service.listCompanyReviews(params.slug, customerIdOf(scope), query, page),
    /** POST /companies/{slug}/reviews: Rate a company, or change my review */
    reviewCompany: async ({ params, body, scope }) => service.reviewCompany(params.slug, signedInCustomer(scope), accountOf(scope), body),
    /** POST /companies/{id}/inquiries: Send an inquiry to a company (staff pass it on) */
    sendInquiry: async ({ params, body, scope }) => service.sendInquiry(params.id, customerOf(scope), body),
    /** GET /play/games: Published games in staff order, with their genres */
    listGames: async ({ query }) => service.listGames(query),
    /** GET /play/games/{slug}: A game's page */
    getGame: async ({ params, scope }) => service.getGame(params.slug, customerIdOf(scope), accountOf(scope)),
    /** GET /play/games/{slug}/reviews: A game's visible reviews, newest first */
    listGameReviews: async ({ params, query, page, scope }) => service.listGameReviews(params.slug, customerIdOf(scope), query, page),
    /** POST /play/games/{slug}/reviews: Rate a game, or change my review */
    reviewGame: async ({ params, body, scope }) => service.reviewGame(params.slug, signedInCustomer(scope), accountOf(scope), body),
    /** GET /play/player: My player ID for game partners */
    getMyPlayer: async ({ scope }) => service.getMyPlayer(signedInCustomer(scope), accountOf(scope)),
    /** GET /play/rankings: A game's ranking table for a period */
    getRankings: async ({ query, scope }) => service.getRankings(query, customerIdOf(scope)),
  });
