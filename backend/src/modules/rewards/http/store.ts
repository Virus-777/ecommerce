import type { Scope } from '../../../kernel/auth/scope.js';
import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/rewards.js';
import type { RewardsService } from '../service.js';

/** The signed-in customer's key: the customers-module id (as promotions keeps coupons), else the account id */
const customerOf = (scope: Scope): string => {
  if (scope.kind === 'customer') return scope.customerId ?? scope.accountId;
  throw new AppError('UNAUTHORIZED', 'Sign in to continue');
};

/**
 * Store API: /api/store/rewards/…  (docs/api/modules/rewards.md)
 * Every endpoint is the signed-in customer's own Daily rewards.
 */
export const storeRoutes = (service: RewardsService) =>
  routes(endpoints, 'store', {
    /** GET /summary: Points, streak, this week's check-ins, today's tasks and the rewards */
    getSummary: async ({ scope }) => service.getSummary(customerOf(scope)),
    /** POST /check-ins: Check in today */
    checkIn: async ({ scope, actor, requestId }) => service.checkIn(customerOf(scope), { actor, requestId }),
    /** POST /tasks/{key}/progress: Tell the server the customer did a task in the app (visit a store page, share a product) */
    reportTask: async ({ params, body, scope }) => service.reportTask(customerOf(scope), params.key, body),
    /** POST /tasks/{key}/claim: Claim a done task's points */
    claimTask: async ({ params, scope, actor, requestId }) => service.claimTask(customerOf(scope), params.key, { actor, requestId }),
    /** POST /rewards/{id}/redeem: Swap points for a coupon */
    redeemReward: async ({ params, scope, idempotencyKey, actor, requestId }) => service.redeemReward(customerOf(scope), params.id, idempotencyKey, { actor, requestId }),
    /** GET /history: My points history, newest first */
    listHistory: async ({ scope, page }) => service.listHistory(customerOf(scope), page),
    /** GET /redemptions: Coupons I got for points, newest first */
    listMyRedemptions: async ({ scope, page }) => service.listMyRedemptions(customerOf(scope), page),
  });
