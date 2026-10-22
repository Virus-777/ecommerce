import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/rewards.js';
import type { RewardsService } from '../service.js';

/**
 * Admin API: /api/admin/rewards/…  (docs/api/modules/rewards.md)
 * Admin › Departments › Daily rewards: the schedule, tasks, rewards, redemptions and customers' points.
 */
export const adminRoutes = (service: RewardsService) =>
  routes(endpoints, 'admin', {
    /** GET /program: The check-in schedule */
    getProgram: async () => service.getProgram(),
    /** PUT /program: Change the check-in schedule or turn Daily rewards off */
    setProgram: async ({ body, actor, requestId }) => service.setProgram(body, { actor, requestId }),
    /** GET /tasks: Daily tasks in order */
    listTasksAdmin: async () => service.listTasksAdmin(),
    /** POST /tasks: Add a daily task */
    createTask: async ({ body, actor, requestId }) => service.createTask(body, { actor, requestId }),
    /** PATCH /tasks/{key}: Change, reorder, hide or show a daily task */
    updateTask: async ({ params, body, actor, requestId }) => service.updateTask(params.key, body, { actor, requestId }),
    /** DELETE /tasks/{key}: Delete a daily task */
    deleteTask: async ({ params, actor, requestId }) => service.deleteTask(params.key, { actor, requestId }),
    /** GET /rewards: The reward catalogue in order */
    listRewardsAdmin: async () => service.listRewardsAdmin(),
    /** POST /rewards: Add a coupon to the catalogue */
    createReward: async ({ body, actor, requestId }) => service.createReward(body, { actor, requestId }),
    /** PATCH /rewards/{id}: Change, reorder, hide or show a reward */
    updateReward: async ({ params, body, actor, requestId }) => service.updateReward(params.id, body, { actor, requestId }),
    /** DELETE /rewards/{id}: Delete a reward nobody redeemed */
    deleteReward: async ({ params, actor, requestId }) => service.deleteReward(params.id, { actor, requestId }),
    /** GET /redemptions: Redemptions, newest first */
    listRedemptionsAdmin: async ({ query, page }) => service.listRedemptionsAdmin(query, page),
    /** GET /customers/{customerId}: A customer's points, streak and latest history */
    getCustomerPoints: async ({ params }) => service.getCustomerPoints(params.customerId),
    /** GET /customers: Customers with points, highest balance first */
    searchCustomerPoints: async ({ query, page }) => service.searchCustomerPoints(query, page),
    /** POST /adjustments: Add or remove a customer's points */
    adjustPoints: async ({ body, actor, requestId }) => service.adjustPoints(body, { actor, requestId }),
  });
