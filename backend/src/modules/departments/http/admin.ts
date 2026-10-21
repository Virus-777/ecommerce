import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/departments.js';
import type { DepartmentsService } from '../service.js';

/**
 * Admin API: /api/admin/departments/…  (docs/api/modules/departments.md)
 * Admin › Departments: the Phone tab picks, Blogs, Companies and the Play center. Writes are audited.
 */
export const adminRoutes = (service: DepartmentsService) =>
  routes(endpoints, 'admin', {
    /** GET /phones: The Phone tab picks */
    getPhonesAdmin: async () => service.getPhonesAdmin(),
    /** PUT /phones: Replace the Phone tab picks */
    setPhones: async ({ body, actor, requestId }) => service.setPhones(body, { actor, requestId }),
    /** GET /blogs/topics: Every blog topic */
    listBlogTopicsAdmin: async () => service.listBlogTopicsAdmin(),
    /** POST /blogs/topics: Add a topic */
    createBlogTopic: async ({ body, actor, requestId }) => service.createBlogTopic(body, { actor, requestId }),
    /** PATCH /blogs/topics/{id}: Rename, reorder, hide or show a topic */
    updateBlogTopic: async ({ params, body, actor, requestId }) => service.updateBlogTopic(params.id, body, { actor, requestId }),
    /** DELETE /blogs/topics/{id}: Delete a topic without posts */
    deleteBlogTopic: async ({ params, actor, requestId }) => service.deleteBlogTopic(params.id, { actor, requestId }),
    /** GET /blogs/authors: Every author profile */
    listBlogAuthorsAdmin: async () => service.listBlogAuthorsAdmin(),
    /** POST /blogs/authors: Add an author profile */
    createBlogAuthor: async ({ body, actor, requestId }) => service.createBlogAuthor(body, { actor, requestId }),
    /** PATCH /blogs/authors/{id}: Edit an author profile */
    updateBlogAuthor: async ({ params, body, actor, requestId }) => service.updateBlogAuthor(params.id, body, { actor, requestId }),
    /** DELETE /blogs/authors/{id}: Delete an author without posts */
    deleteBlogAuthor: async ({ params, actor, requestId }) => service.deleteBlogAuthor(params.id, { actor, requestId }),
    /** GET /blogs/posts: Posts, newest change first */
    listBlogPostsAdmin: async ({ query, page }) => service.listBlogPostsAdmin(query, page),
    /** POST /blogs/posts: Write a post */
    createBlogPost: async ({ body, actor, requestId }) => service.createBlogPost(body, { actor, requestId }),
    /** GET /blogs/posts/{id}: A post for editing */
    getBlogPostAdmin: async ({ params }) => service.getBlogPostAdmin(params.id),
    /** PATCH /blogs/posts/{id}: Edit, publish or unpublish a post */
    updateBlogPost: async ({ params, body, actor, requestId }) => service.updateBlogPost(params.id, body, { actor, requestId }),
    /** DELETE /blogs/posts/{id}: Delete a post with its reactions, replies and reports */
    deleteBlogPost: async ({ params, actor, requestId }) => service.deleteBlogPost(params.id, { actor, requestId }),
    /** GET /blogs/replies: Replies, newest first */
    listBlogRepliesAdmin: async ({ query, page }) => service.listBlogRepliesAdmin(query, page),
    /** PATCH /blogs/replies/{id}: Hide or show a reply */
    moderateBlogReply: async ({ params, body, actor, requestId }) => service.moderateBlogReply(params.id, body.status, { actor, requestId }),
    /** GET /blogs/reports: Reports, newest first */
    listBlogReports: async ({ query, page }) => service.listBlogReports(query, page),
    /** PATCH /blogs/reports/{id}: Uphold or dismiss a report */
    decideBlogReport: async ({ params, body, actor, requestId }) => service.decideBlogReport(params.id, body.status, { actor, requestId }),
    /** GET /industries: Every industry */
    listIndustriesAdmin: async () => service.listIndustriesAdmin(),
    /** POST /industries: Add an industry */
    createIndustry: async ({ body, actor, requestId }) => service.createIndustry(body, { actor, requestId }),
    /** PATCH /industries/{id}: Rename, reorder, hide or show an industry */
    updateIndustry: async ({ params, body, actor, requestId }) => service.updateIndustry(params.id, body, { actor, requestId }),
    /** DELETE /industries/{id}: Delete an industry without companies */
    deleteIndustry: async ({ params, actor, requestId }) => service.deleteIndustry(params.id, { actor, requestId }),
    /** GET /companies: Companies in staff order */
    listCompaniesAdmin: async ({ query, page }) => service.listCompaniesAdmin(query, page),
    /** POST /companies: Add a company */
    createCompany: async ({ body, actor, requestId }) => service.createCompany(body, { actor, requestId }),
    /** GET /companies/{id}: A company for editing */
    getCompanyAdmin: async ({ params }) => service.getCompanyAdmin(params.id),
    /** PATCH /companies/{id}: Edit, hide or show a company */
    updateCompany: async ({ params, body, actor, requestId }) => service.updateCompany(params.id, body, { actor, requestId }),
    /** DELETE /companies/{id}: Delete a company with its inquiries */
    deleteCompany: async ({ params, actor, requestId }) => service.deleteCompany(params.id, { actor, requestId }),
    /** GET /inquiries: Inquiries, newest first */
    listInquiries: async ({ query, page }) => service.listInquiries(query, page),
    /** PATCH /inquiries/{id}: Mark an inquiry replied or closed, or note what was done */
    updateInquiry: async ({ params, body, actor, requestId }) => service.updateInquiry(params.id, body, { actor, requestId }),
    /** GET /play/games: Games in staff order */
    listGamesAdmin: async () => service.listGamesAdmin(),
    /** POST /play/games: Add a game */
    createGame: async ({ body, actor, requestId }) => service.createGame(body, { actor, requestId }),
    /** PATCH /play/games/{id}: Edit, hide or show a game */
    updateGame: async ({ params, body, actor, requestId }) => service.updateGame(params.id, body, { actor, requestId }),
    /** DELETE /play/games/{id}: Delete a game with its ranking tables */
    deleteGame: async ({ params, actor, requestId }) => service.deleteGame(params.id, { actor, requestId }),
    /** GET /play/games/{id}/rankings/{period}: A game's ranking table for a period */
    getRankingsAdmin: async ({ params }) => service.getRankingsAdmin(params.id, params.period),
    /** PUT /play/games/{id}/rankings/{period}: Replace a game's ranking table for a period */
    setRankings: async ({ params, body, actor, requestId }) => service.setRankings(params.id, params.period, body, { actor, requestId }),
  });
